/**
 * Crash Dump Logger
 *
 * Captures uncaught exceptions and rejections to a persistent crash log file.
 * Written synchronously to ensure data isn't lost on immediate crash.
 * Survives app crashes and can be analyzed on next startup.
 */

import { writeFileSync, appendFileSync, existsSync, readdirSync, unlinkSync, readFileSync } from "fs"
import { join, dirname } from "path"
import { app } from "electron"
import log from "electron-log"

// Keep only the last 5 crash dumps to avoid bloat
const MAX_CRASH_DUMPS = 5

/**
 * Get the directory for crash dumps
 */
function getCrashDumpDir(): string {
  try {
    const logFile = log.transports.file.getFile()
    if (logFile?.path) {
      return dirname(logFile.path)
    }
  } catch {}
  return join(app.getPath("userData"), "logs")
}

/**
 * Get a timestamped filename for crash dumps
 */
function getCrashDumpPath(): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
  return join(getCrashDumpDir(), `crash-${timestamp}.log`)
}

/**
 * Clean up old crash dumps, keeping only the most recent ones
 */
function cleanupOldCrashDumps(): void {
  try {
    const crashDumpDir = getCrashDumpDir()
    if (!existsSync(crashDumpDir)) return

    const files = readdirSync(crashDumpDir)
      .filter((f) => f.startsWith("crash-") && f.endsWith(".log"))
      .sort()
      .reverse()

    // Delete older crashes beyond the limit
    for (let i = MAX_CRASH_DUMPS; i < files.length; i++) {
      try {
        unlinkSync(join(crashDumpDir, files[i]))
      } catch {}
    }
  } catch (error) {
    console.error("[CrashDump] Failed to cleanup old dumps:", error)
  }
}

/**
 * Write a crash entry to the dump file synchronously
 */
function writeCrashDump(type: "exception" | "rejection", error: any, context?: string): void {
  try {
    const dumpPath = getCrashDumpPath()
    const timestamp = new Date().toISOString()
    const version = app.getVersion()

    // Format the error
    const errorMessage = error instanceof Error ? error.message : String(error)
    const errorStack = error instanceof Error ? error.stack : ""

    // Build the log entry
    const entry = [
      `[${timestamp}] ${type.toUpperCase()}`,
      `Version: ${version}`,
      `Context: ${context || "unknown"}`,
      `Error: ${errorMessage}`,
      `Stack:`,
      errorStack,
      "---",
    ].join("\n")

    // Write synchronously to ensure it persists
    if (existsSync(dumpPath)) {
      appendFileSync(dumpPath, "\n" + entry + "\n", "utf-8")
    } else {
      writeFileSync(dumpPath, entry + "\n", "utf-8")
    }

    console.log(`[CrashDump] Crash logged to ${dumpPath}`)
  } catch (error) {
    console.error("[CrashDump] Failed to write crash dump:", error)
  }
}

/**
 * Initialize crash dump handlers
 * Must be called early in app startup, before any user code runs
 */
export function initCrashDump(): void {
  // Handle uncaught exceptions
  process.on("uncaughtException", (error) => {
    console.error("[CrashDump] Uncaught exception:", error)
    writeCrashDump("exception", error, "process.uncaughtException")

    // Also sync electron-log to disk
    try {
      log.transports.file.getFile()?.sync?.()
    } catch {}
  })

  // Handle unhandled promise rejections
  process.on("unhandledRejection", (reason, promise) => {
    console.error("[CrashDump] Unhandled rejection:", reason)
    writeCrashDump("rejection", reason, `promise: ${promise}`)

    // Also sync electron-log to disk
    try {
      log.transports.file.getFile()?.sync?.()
    } catch {}
  })

  // Cleanup old crash dumps on startup
  cleanupOldCrashDumps()

  console.log("[CrashDump] Crash dump handler initialized")
}

/**
 * Get all recent crash dumps for analysis
 */
export function getCrashDumps(): string[] {
  try {
    const crashDumpDir = getCrashDumpDir()
    if (!existsSync(crashDumpDir)) return []

    return readdirSync(crashDumpDir)
      .filter((f) => f.startsWith("crash-") && f.endsWith(".log"))
      .map((f) => join(crashDumpDir, f))
      .sort()
      .reverse()
  } catch (error) {
    console.error("[CrashDump] Failed to list crash dumps:", error)
    return []
  }
}

/**
 * Read the most recent crash dump
 */
export function getLatestCrashDump(): string | null {
  const dumps = getCrashDumps()
  if (dumps.length === 0) return null

  try {
    return readFileSync(dumps[0], "utf-8")
  } catch (error) {
    console.error("[CrashDump] Failed to read crash dump:", error)
    return null
  }
}
