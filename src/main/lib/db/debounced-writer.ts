/**
 * Debounced database writer for sub-chat messages.
 *
 * Problem: Serializing 100KB+ JSON message arrays with JSON.stringify and
 * writing synchronously to SQLite on every message completion blocks the
 * main Electron thread for 10-200ms. Two concurrent sessions competing
 * for the single SQLite connection (busy_timeout up to 5s) makes it worse.
 *
 * Solution: Queue writes per subChatId and flush after a debounce period
 * (100ms of inactivity) or immediately when a session ends. Only the
 * latest pending write per subChatId is kept -- intermediate states are
 * discarded since only the final message array matters.
 */

import { eq } from "drizzle-orm"
import { getDatabase } from "./index"
import { subChats, chats } from "./schema"

const DEBOUNCE_MS = 100

interface PendingWrite {
  subChatId: string
  /** Full data to set on the subChats row */
  data: {
    messages?: string // Already JSON.stringified
    sessionId?: string | null
    streamId?: string | null
    updatedAt?: Date
  }
  /** Optional: also bump parent chat's updatedAt */
  chatId?: string
  timer: ReturnType<typeof setTimeout> | null
}

const pendingWrites = new Map<string, PendingWrite>()
// Track retry timeouts so they can be cancelled during shutdown
const activeRetryTimeouts = new Set<ReturnType<typeof setTimeout>>()

/**
 * Execute a single pending write against the database with retry logic.
 * Runs the subChat update and optional chat timestamp update
 * inside a single synchronous block (better-sqlite3 is sync).
 *
 * Retries up to 3 times on SQLITE_BUSY errors with exponential backoff
 * to handle lock contention from concurrent sessions.
 */
function executePendingWrite(pending: PendingWrite, retryCount = 0): void {
  const MAX_RETRIES = 3
  const RETRY_DELAY_MS = 100 * Math.pow(2, retryCount) // 100ms, 200ms, 400ms

  try {
    const db = getDatabase()
    db.update(subChats)
      .set(pending.data)
      .where(eq(subChats.id, pending.subChatId))
      .run()

    if (pending.chatId) {
      db.update(chats)
        .set({ updatedAt: new Date() })
        .where(eq(chats.id, pending.chatId))
        .run()
    }
  } catch (error: any) {
    // Retry on database lock errors if we haven't exceeded max retries
    const isDatabaseBusy = error?.code === "SQLITE_BUSY" || error?.message?.includes("database is locked")
    if (isDatabaseBusy && retryCount < MAX_RETRIES) {
      console.warn(
        `[debounced-writer] Database locked for subChat ${pending.subChatId}, retry ${retryCount + 1}/${MAX_RETRIES} after ${RETRY_DELAY_MS}ms`,
      )
      const retryTimeout = setTimeout(() => {
        activeRetryTimeouts.delete(retryTimeout)
        executePendingWrite(pending, retryCount + 1)
      }, RETRY_DELAY_MS)
      activeRetryTimeouts.add(retryTimeout)
      return
    }

    console.error(
      `[debounced-writer] Failed to write subChat ${pending.subChatId} after ${retryCount} retries:`,
      error,
    )
  }
}

/**
 * Schedule a debounced write for a subChat's messages.
 *
 * If a write is already pending for this subChatId, the timer is reset
 * and the data is replaced with the latest values. Only the most recent
 * state is ever written to the database.
 *
 * @param subChatId - The sub-chat to update
 * @param data - Fields to set on the subChats row
 * @param chatId - Optional parent chat ID to bump updatedAt
 */
export function scheduleDebouncedWrite(
  subChatId: string,
  data: PendingWrite["data"],
  chatId?: string,
): void {
  const existing = pendingWrites.get(subChatId)

  // Clear any existing timer
  if (existing?.timer) {
    clearTimeout(existing.timer)
  }

  const pending: PendingWrite = {
    subChatId,
    data,
    chatId,
    timer: null,
  }

  // Schedule the write after debounce period.
  // Guard: if flushPendingWrite() was called before this fires, the key will
  // be absent from the map. Skip to prevent writing stale data on top of
  // a newer explicit flush.
  pending.timer = setTimeout(() => {
    if (!pendingWrites.has(subChatId)) return
    pendingWrites.delete(subChatId)
    executePendingWrite(pending)
  }, DEBOUNCE_MS)

  pendingWrites.set(subChatId, pending)
}

/**
 * Immediately flush any pending write for a specific subChatId.
 * Call this when a session ends to ensure all data is persisted.
 *
 * @param subChatId - The sub-chat to flush
 * @param overrideData - Optional: replace the pending data entirely before flushing
 * @param chatId - Optional: override the chatId for the flush
 */
export function flushPendingWrite(
  subChatId: string,
  overrideData?: PendingWrite["data"],
  chatId?: string,
): void {
  const existing = pendingWrites.get(subChatId)

  if (existing) {
    // Cancel the debounce timer
    if (existing.timer) {
      clearTimeout(existing.timer)
    }
    pendingWrites.delete(subChatId)

    // Use override data if provided, otherwise flush what was pending
    if (overrideData) {
      executePendingWrite({
        subChatId,
        data: overrideData,
        chatId: chatId ?? existing.chatId,
        timer: null,
      })
    } else {
      executePendingWrite(existing)
    }
  } else if (overrideData) {
    // No pending write, but caller wants an immediate write
    executePendingWrite({
      subChatId,
      data: overrideData,
      chatId,
      timer: null,
    })
  }
}

/**
 * Flush all pending writes immediately.
 * Call this at app shutdown to ensure no data is lost.
 *
 * Cancels all retry timeouts and performs synchronous writes
 * without retry logic to ensure completion before database close.
 */
export function flushAllPendingWrites(): void {
  // Cancel all retry timeouts first
  for (const timeout of activeRetryTimeouts) {
    clearTimeout(timeout)
  }
  activeRetryTimeouts.clear()

  // Flush all pending writes synchronously without retry
  const db = getDatabase()
  for (const [subChatId, pending] of pendingWrites) {
    if (pending.timer) {
      clearTimeout(pending.timer)
    }
    pendingWrites.delete(subChatId)

    try {
      db.update(subChats)
        .set(pending.data)
        .where(eq(subChats.id, pending.subChatId))
        .run()

      if (pending.chatId) {
        db.update(chats)
          .set({ updatedAt: new Date() })
          .where(eq(chats.id, pending.chatId))
          .run()
      }
    } catch (error) {
      console.error(`[debounced-writer] Failed to flush subChat ${pending.subChatId} during shutdown:`, error)
    }
  }
}

/**
 * Check if there is a pending write for a subChatId.
 * Useful for tests and debugging.
 */
export function hasPendingWrite(subChatId: string): boolean {
  return pendingWrites.has(subChatId)
}
