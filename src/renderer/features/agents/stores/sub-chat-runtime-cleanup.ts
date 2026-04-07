import { getWindowId } from "../../../contexts/WindowContext"
import { clearMessageStateCacheByMessageIds } from "../main/assistant-message-item"
import { clearTextPartStoreByMessageIds } from "../main/isolated-text-part"
import { clearToolStateCachesByToolCallIds } from "../ui/agent-tool-utils"
import { clearSubChatCaches } from "./message-store"
import { clearSubChatAtomCaches, clearChatAtomCaches } from "../atoms"

export function clearSubChatRuntimeCaches(subChatId: string) {
  const { messageIds, toolCallIds } = clearSubChatCaches(subChatId)
  clearMessageStateCacheByMessageIds(subChatId, messageIds)
  clearTextPartStoreByMessageIds(subChatId, messageIds)
  clearToolStateCachesByToolCallIds(toolCallIds)
  clearSubChatAtomCaches(subChatId)
}

/**
 * Clean up all runtime caches for an entire chat (all sub-chats + chat-level atoms).
 * Call this when a chat is archived or deleted.
 */
export function clearChatRuntimeCaches(chatId: string, subChatIds: string[]) {
  for (const subChatId of subChatIds) {
    clearSubChatRuntimeCaches(subChatId)
  }
  clearChatAtomCaches(chatId)
}

/**
 * Prune orphaned localStorage keys from the sub-chat store.
 * Removes `agent-{type}-sub-chats-{chatId}` entries for chats that no longer exist in the DB.
 * Call once after the chat list has loaded.
 */
export function pruneOrphanedLocalStorageKeys(validChatIds: Set<string>) {
  if (typeof window === "undefined") return

  const windowId = getWindowId()
  // Pattern: "{windowId}:agent-{type}-sub-chats-{chatId}"
  const prefix = `${windowId}:agent-`
  const subChatsSuffix = "-sub-chats-"
  const keysToRemove: string[] = []

  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (!key || !key.startsWith(prefix)) continue

    const afterPrefix = key.slice(prefix.length)
    const subChatsIdx = afterPrefix.indexOf(subChatsSuffix)
    if (subChatsIdx === -1) continue

    const chatId = afterPrefix.slice(subChatsIdx + subChatsSuffix.length)
    if (chatId && !validChatIds.has(chatId)) {
      keysToRemove.push(key)
    }
  }

  // Also check legacy keys without window prefix
  const legacyPrefix = "agent-"
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (!key || !key.startsWith(legacyPrefix)) continue
    // Skip window-prefixed keys (already handled above)
    if (key.includes(":")) continue

    const afterPrefix = key.slice(legacyPrefix.length)
    const subChatsIdx = afterPrefix.indexOf(subChatsSuffix)
    if (subChatsIdx === -1) continue

    const chatId = afterPrefix.slice(subChatsIdx + subChatsSuffix.length)
    if (chatId && !validChatIds.has(chatId)) {
      keysToRemove.push(key)
    }
  }

  for (const key of keysToRemove) {
    localStorage.removeItem(key)
  }

  if (keysToRemove.length > 0) {
    console.log(`[Cleanup] Pruned ${keysToRemove.length} orphaned localStorage keys`)
  }
}
