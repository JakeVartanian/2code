import type { Chat } from "@ai-sdk/react"
import { useStreamingStatusStore } from "./streaming-status-store"

/**
 * Simple module-level storage for Chat objects.
 * Lives outside React lifecycle so chats persist across component mount/unmount.
 *
 * Includes LRU-style tracking via lastAccessedAt timestamps.
 * The evictStale() method can be called periodically to remove idle Chat instances
 * that haven't been accessed recently and are not actively streaming.
 */

const chats = new Map<string, Chat<any>>()
const streamIds = new Map<string, string | null>()
const parentChatIds = new Map<string, string>() // subChatId → parentChatId (stored at creation time)
const manuallyAborted = new Map<string, boolean>() // Track if chat was manually stopped
const lastAccessedAt = new Map<string, number>() // subChatId → timestamp of last get/set

// Default max age for idle Chat instances (5 minutes)
const DEFAULT_MAX_AGE_MS = 5 * 60 * 1000

export const agentChatStore = {
  get: (id: string) => {
    const chat = chats.get(id)
    if (chat) {
      lastAccessedAt.set(id, Date.now())
    }
    return chat
  },

  keys: () => Array.from(chats.keys()),

  size: () => chats.size,

  set: (id: string, chat: Chat<any>, parentChatId: string) => {
    chats.set(id, chat)
    parentChatIds.set(id, parentChatId)
    lastAccessedAt.set(id, Date.now())
  },

  has: (id: string) => chats.has(id),

  delete: (id: string, force = false) => {
    // Safety: refuse to delete actively streaming chats unless forced.
    // Callers already check isStreaming() but this guards against races
    // where status changes between the check and the delete.
    if (!force && useStreamingStatusStore.getState().isStreaming(id)) {
      console.warn(`[agentChatStore] Refused to delete streaming chat ${id.slice(-8)}`)
      return
    }
    const chat = chats.get(id) as any
    chat?.transport?.cleanup?.()
    chats.delete(id)
    streamIds.delete(id)
    parentChatIds.delete(id)
    manuallyAborted.delete(id)
    lastAccessedAt.delete(id)
    // Clear streaming status — ChatDataSync intentionally does NOT clear on unmount
    // to prevent the workspace-switch race condition. This is the correct place to clean up.
    useStreamingStatusStore.getState().clearStatus(id)
  },

  // Get the ORIGINAL parentChatId that was set when the Chat was created
  getParentChatId: (subChatId: string) => parentChatIds.get(subChatId),

  getStreamId: (id: string) => streamIds.get(id),
  setStreamId: (id: string, streamId: string | null) => {
    streamIds.set(id, streamId)
  },

  // Track manual abort to prevent completion sound
  setManuallyAborted: (id: string, aborted: boolean) => {
    manuallyAborted.set(id, aborted)
  },
  wasManuallyAborted: (id: string) => manuallyAborted.get(id) ?? false,
  clearManuallyAborted: (id: string) => {
    manuallyAborted.delete(id)
  },

  /**
   * Evict Chat instances that have not been accessed within maxAgeMs
   * and are not actively streaming. Returns the IDs of evicted chats.
   *
   * @param isStreaming - callback to check if a subChat is currently streaming
   * @param keepIds - set of IDs that must NOT be evicted (e.g. active tab, split panes)
   * @param maxAgeMs - max idle time before eviction (default: 5 minutes)
   */
  evictStale: (
    isStreaming: (subChatId: string) => boolean,
    keepIds: Set<string>,
    maxAgeMs: number = DEFAULT_MAX_AGE_MS,
  ): string[] => {
    const now = Date.now()
    const evicted: string[] = []

    for (const id of Array.from(chats.keys())) {
      if (keepIds.has(id)) continue
      if (isStreaming(id)) continue

      const lastAccess = lastAccessedAt.get(id) ?? 0
      if (now - lastAccess > maxAgeMs) {
        const chat = chats.get(id) as any
        chat?.transport?.cleanup?.()
        chats.delete(id)
        streamIds.delete(id)
        parentChatIds.delete(id)
        manuallyAborted.delete(id)
        lastAccessedAt.delete(id)
        evicted.push(id)
      }
    }

    return evicted
  },

  clear: () => {
    for (const chat of chats.values()) {
      ;(chat as any)?.transport?.cleanup?.()
    }
    chats.clear()
    streamIds.clear()
    parentChatIds.clear()
    manuallyAborted.clear()
    lastAccessedAt.clear()
  },
}
