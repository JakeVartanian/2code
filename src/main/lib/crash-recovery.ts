/**
 * Crash Recovery System
 *
 * Detects unexpected app termination and enables session restoration on restart.
 * Tracks clean shutdown state and identifies crashed sessions for recovery.
 */

import { app } from "electron"
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "fs"
import { join } from "path"
import { eq, sql } from "drizzle-orm"
import { getDatabase, subChats } from "./db"

const CRASH_STATE_FILE = "crash-state.json"

interface CrashState {
  cleanShutdown: boolean
  lastActiveSubChatIds: string[] // SubChats that were streaming when app last ran
  timestamp: number
  version: string
}

/**
 * Get the path to the crash state file in userData
 */
function getCrashStateFilePath(): string {
  return join(app.getPath("userData"), CRASH_STATE_FILE)
}

/**
 * Read the crash state from disk
 */
function readCrashState(): CrashState | null {
  const filePath = getCrashStateFilePath()
  if (!existsSync(filePath)) {
    return null
  }

  try {
    const data = readFileSync(filePath, "utf-8")
    return JSON.parse(data) as CrashState
  } catch (error) {
    console.error("[CrashRecovery] Failed to read crash state:", error)
    return null
  }
}

/**
 * Write the crash state to disk
 */
function writeCrashState(state: CrashState): void {
  const filePath = getCrashStateFilePath()
  try {
    writeFileSync(filePath, JSON.stringify(state, null, 2), "utf-8")
  } catch (error) {
    console.error("[CrashRecovery] Failed to write crash state:", error)
  }
}

/**
 * Delete the crash state file
 */
function deleteCrashState(): void {
  const filePath = getCrashStateFilePath()
  try {
    if (existsSync(filePath)) {
      unlinkSync(filePath)
    }
  } catch (error) {
    console.error("[CrashRecovery] Failed to delete crash state:", error)
  }
}

/**
 * Get all sub-chats that have active streamIds (are currently streaming)
 */
export function getActiveStreamingSubChats(): string[] {
  try {
    const db = getDatabase()
    const activeSubChats = db
      .select({ id: subChats.id })
      .from(subChats)
      .where(sql`${subChats.streamId} IS NOT NULL`)
      .all()

    return activeSubChats.map((sc) => sc.id)
  } catch (error) {
    console.error("[CrashRecovery] Failed to get active streaming sub-chats:", error)
    return []
  }
}

/**
 * Initialize crash recovery on app startup.
 * Returns true if the previous session crashed and needs recovery.
 */
export function initCrashRecovery(): {
  didCrash: boolean
  crashedSubChatIds: string[]
} {
  const previousState = readCrashState()

  // If no previous state or clean shutdown, no recovery needed
  if (!previousState || previousState.cleanShutdown) {
    console.log("[CrashRecovery] Previous session shut down cleanly")

    // Mark this session as running (unclean until shutdown completes)
    writeCrashState({
      cleanShutdown: false,
      lastActiveSubChatIds: [],
      timestamp: Date.now(),
      version: app.getVersion(),
    })

    return { didCrash: false, crashedSubChatIds: [] }
  }

  // Previous session did NOT shut down cleanly - this is a crash
  const timeSinceCrash = Date.now() - previousState.timestamp
  console.log(
    `[CrashRecovery] ⚠️  CRASH DETECTED - app terminated unexpectedly ${Math.round(timeSinceCrash / 1000)}s ago`,
  )
  console.log(
    `[CrashRecovery] Found ${previousState.lastActiveSubChatIds.length} sub-chats that may need recovery`,
  )

  // Clear any stale streamIds from database (they're invalid after crash)
  try {
    const db = getDatabase()
    db.update(subChats).set({ streamId: null }).run()
    console.log("[CrashRecovery] Cleared stale streamIds from database")
  } catch (error) {
    console.error("[CrashRecovery] Failed to clear stale streamIds:", error)
  }

  // Mark this session as running
  writeCrashState({
    cleanShutdown: false,
    lastActiveSubChatIds: [],
    timestamp: Date.now(),
    version: app.getVersion(),
  })

  return {
    didCrash: true,
    crashedSubChatIds: previousState.lastActiveSubChatIds,
  }
}

/**
 * Update the list of active streaming sub-chats.
 * Should be called periodically (e.g., every 5 seconds) while the app is running.
 */
export function updateActiveSubChats(): void {
  const activeSubChatIds = getActiveStreamingSubChats()
  const previousState = readCrashState()

  if (!previousState) {
    return
  }

  // Only update if the list has changed (avoid unnecessary disk writes)
  const hasChanged =
    JSON.stringify(activeSubChatIds.sort()) !==
    JSON.stringify(previousState.lastActiveSubChatIds.sort())

  if (hasChanged) {
    writeCrashState({
      ...previousState,
      lastActiveSubChatIds: activeSubChatIds,
      timestamp: Date.now(),
    })
  }
}

/**
 * Mark the app shutdown as clean.
 * Must be called during the shutdown sequence (before quit completes).
 */
export function markCleanShutdown(): void {
  console.log("[CrashRecovery] Marking clean shutdown")
  writeCrashState({
    cleanShutdown: true,
    lastActiveSubChatIds: [],
    timestamp: Date.now(),
    version: app.getVersion(),
  })
}

/**
 * Start periodic tracking of active sessions (every 5 seconds)
 */
export function startCrashRecoveryTracking(): NodeJS.Timeout {
  const interval = setInterval(() => {
    updateActiveSubChats()
  }, 5000) // Update every 5 seconds

  return interval
}

/**
 * Stop periodic tracking
 */
export function stopCrashRecoveryTracking(interval: NodeJS.Timeout): void {
  clearInterval(interval)
}
