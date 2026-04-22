/**
 * File Descriptor Pressure Monitor
 *
 * macOS GUI apps inherit a 256 FD soft limit from launchd. Electron + Claude
 * subprocesses + SQLite + git watchers + MCP servers easily exceed this when
 * running multiple sessions concurrently.
 *
 * This module:
 * 1. Monitors the current FD count via /dev/fd (zero-allocation, instant)
 * 2. Defines pressure levels that trigger automatic load-shedding
 * 3. Attempts to raise the soft limit to 10240 via a native addon (if available)
 * 4. Provides APIs for other modules to check pressure before opening new FDs
 */

import { readdirSync, existsSync } from "node:fs"
import { execSync } from "node:child_process"
import { join } from "node:path"

// --- Pressure levels ---
// These are tuned for the macOS default 256 FD soft limit.
// If the native raiser succeeds (10240), pressure stays at "normal" forever.

export type FdPressureLevel = "normal" | "warning" | "critical"

interface PressureThresholds {
  warning: number  // fraction of limit (0.0–1.0)
  critical: number
}

const THRESHOLDS: PressureThresholds = {
  warning: 0.60,   // 60% of limit → start shedding non-critical watchers
  critical: 0.80,  // 80% of limit → refuse new sessions, close all optional FDs
}

// --- State ---

let fdSoftLimit = 256 // Updated at init from actual system value
let lastFdCount = 0
let lastPressure: FdPressureLevel = "normal"
let monitorInterval: ReturnType<typeof setInterval> | null = null
const pressureCallbacks: Set<(level: FdPressureLevel, fdCount: number, limit: number) => void> = new Set()

// --- Public API ---

// Cache getFdCount results for 2 seconds to avoid repeated readdirSync on /dev/fd
let fdCountCacheTime = 0
const FD_COUNT_CACHE_TTL = 2000

/**
 * Get the current number of open file descriptors for this process.
 * Uses /dev/fd on macOS/Linux (instant, no subprocess).
 * Results are cached for 2s to reduce syscall overhead when called in hot paths.
 */
export function getFdCount(): number {
  const now = Date.now()
  if (now - fdCountCacheTime < FD_COUNT_CACHE_TTL) return lastFdCount
  try {
    // /dev/fd is a virtual directory listing this process's open FDs
    const entries = readdirSync("/dev/fd")
    // Subtract 3 for the dirfd opened by readdirSync itself + stdin/stdout/stderr noise
    lastFdCount = Math.max(0, entries.length - 1)
    fdCountCacheTime = now
    return lastFdCount
  } catch {
    return lastFdCount // Return last known value on error
  }
}

/**
 * Get the current FD soft limit for this process.
 */
export function getFdLimit(): number {
  return fdSoftLimit
}

/**
 * Get the current pressure level based on FD usage.
 */
export function getFdPressure(): FdPressureLevel {
  const count = getFdCount()
  const ratio = count / fdSoftLimit

  if (ratio >= THRESHOLDS.critical) return "critical"
  if (ratio >= THRESHOLDS.warning) return "warning"
  return "normal"
}

/**
 * Get detailed FD status for debugging/display.
 */
export function getFdStatus(): {
  count: number
  limit: number
  pressure: FdPressureLevel
  ratio: number
  headroom: number
} {
  const count = getFdCount()
  const pressure = getFdPressure()
  return {
    count,
    limit: fdSoftLimit,
    pressure,
    ratio: Math.round((count / fdSoftLimit) * 100) / 100,
    headroom: fdSoftLimit - count,
  }
}

/**
 * Register a callback that fires when pressure level changes.
 * Callback receives (newLevel, currentFdCount, fdLimit).
 */
export function onFdPressureChange(
  callback: (level: FdPressureLevel, fdCount: number, limit: number) => void,
): () => void {
  pressureCallbacks.add(callback)
  return () => pressureCallbacks.delete(callback)
}

/**
 * Check if we have enough headroom to open N more file descriptors.
 * Use this before creating watchers, subprocesses, etc.
 */
export function hasFdHeadroom(needed: number = 4): boolean {
  const count = getFdCount()
  return count + needed < fdSoftLimit * THRESHOLDS.critical
}

/**
 * Get the effective max concurrent sessions based on current FD pressure.
 * Returns a reduced limit when FDs are scarce.
 */
export function getEffectiveMaxSessions(baseMax: number): number {
  const pressure = getFdPressure()
  switch (pressure) {
    case "normal": return baseMax
    case "warning": return Math.max(1, Math.floor(baseMax * 0.6))
    case "critical": return 1
  }
}

// --- Initialization ---

/**
 * Detect the actual FD soft limit for this process.
 */
function detectFdLimit(): number {
  try {
    if (process.platform === "darwin" || process.platform === "linux") {
      const output = execSync("ulimit -Sn", {
        shell: "/bin/sh",
        timeout: 2000,
        encoding: "utf-8",
      }).trim()
      // "unlimited" means the hard limit is effectively infinite — pressure monitoring
      // isn't needed but we still report a sane ceiling for getEffectiveMaxSessions()
      if (output === "unlimited") return 65536
      const parsed = parseInt(output, 10)
      if (!isNaN(parsed) && parsed > 0) return parsed
    }
  } catch { /* fall through */ }
  // Default: macOS GUI app limit
  return 256
}

/**
 * Attempt to raise the FD soft limit using a native addon.
 * Returns the new limit, or the current limit if raising failed.
 */
export function tryRaiseFdLimit(): number {
  if (process.platform !== "darwin" && process.platform !== "linux") return fdSoftLimit

  // Resolve addon path: dev vs production
  // Lazy-import electron so this module can be used in tests
  let addonPath: string
  try {
    const { app } = require("electron")
    const isDev = !app.isPackaged
    addonPath = isDev
      ? join(app.getAppPath(), "resources", "native", "raise-fd-limit.node")
      : join(process.resourcesPath, "native", "raise-fd-limit.node")
  } catch {
    // Not in Electron (e.g., tests) — skip native addon
    return fdSoftLimit
  }

  // Strategy 1: Try loading our prebuilt native addon
  try {
    if (existsSync(addonPath)) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const addon = require(addonPath)
      if (typeof addon.raise === "function") {
        const newLimit = addon.raise(10240)
        if (newLimit >= 10240) {
          console.log(`[fd-pressure] Native addon raised FD limit to ${newLimit}`)
          fdSoftLimit = newLimit
          return newLimit
        }
      }
    }
  } catch (err) {
    console.warn(`[fd-pressure] Native addon failed to load from ${addonPath}:`, err)
  }

  // Strategy 2: Try via child process re-exec trick (less reliable)
  // On macOS, `launchctl limit maxfiles` shows the system limit but can't change per-process.
  // We can't raise our own process's soft limit from a child process.
  // Log the limitation so developers know to run `ulimit -n 4096` in dev.
  if (fdSoftLimit <= 256) {
    console.warn(
      `[fd-pressure] FD soft limit is ${fdSoftLimit} (macOS GUI app default). ` +
      `Native addon not available. For dev: run \`ulimit -n 4096\` before \`bun run dev\`. ` +
      `FD pressure monitoring is active — will degrade gracefully.`
    )
  }

  return fdSoftLimit
}

/**
 * Start the FD pressure monitor. Call once at app startup.
 */
export function startFdMonitor(intervalMs: number = 5000): void {
  if (monitorInterval) return // Already running

  // Detect actual limit
  fdSoftLimit = detectFdLimit()
  console.log(`[fd-pressure] Detected FD soft limit: ${fdSoftLimit}`)

  // Try to raise it
  tryRaiseFdLimit()

  // Initial check
  const initialCount = getFdCount()
  console.log(`[fd-pressure] Initial FD count: ${initialCount}/${fdSoftLimit}`)

  // Periodic monitoring
  monitorInterval = setInterval(() => {
    const newPressure = getFdPressure()
    const count = getFdCount()

    // Only notify on level changes
    if (newPressure !== lastPressure) {
      console.log(
        `[fd-pressure] Pressure changed: ${lastPressure} → ${newPressure} (${count}/${fdSoftLimit} FDs)`
      )
      lastPressure = newPressure

      for (const callback of pressureCallbacks) {
        try {
          callback(newPressure, count, fdSoftLimit)
        } catch (err) {
          console.error("[fd-pressure] Callback error:", err)
        }
      }
    }
  }, intervalMs)

  // Don't prevent process exit
  monitorInterval.unref()
}

/**
 * Stop the FD pressure monitor. Call at app shutdown.
 */
export function stopFdMonitor(): void {
  if (monitorInterval) {
    clearInterval(monitorInterval)
    monitorInterval = null
  }
  pressureCallbacks.clear()
}
