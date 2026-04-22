// Helper to sleep for a given duration
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

interface AutoRenameParams {
  subChatId: string
  parentChatId: string
  userMessage: string
  isFirstSubChat: boolean
  /** The name of the parent chat at the time auto-rename was triggered */
  originalChatName: string | null
  generateName: (userMessage: string) => Promise<{ name: string }>
  renameSubChat: (input: { id: string; name: string }) => Promise<void>
  renameChat: (input: { id: string; name: string }) => Promise<void>
  updateSubChatName: (subChatId: string, name: string) => void
  updateChatName: (chatId: string, name: string) => void
  /** Returns the current chat name from the store/cache (to detect manual renames) */
  getCurrentChatName?: () => string | null
}

/**
 * Auto-rename a sub-chat (and optionally parent chat) based on the user's first message.
 * Generates a name via LLM, then retries renaming until the chat exists in DB.
 * Fire-and-forget - doesn't block chat streaming.
 */
export async function autoRenameAgentChat({
  subChatId,
  parentChatId,
  userMessage,
  isFirstSubChat,
  originalChatName,
  generateName,
  renameSubChat,
  renameChat,
  updateSubChatName,
  updateChatName,
  getCurrentChatName,
}: AutoRenameParams) {
  console.log("[auto-rename] Called with:", { subChatId, parentChatId, userMessage: userMessage.slice(0, 50), isFirstSubChat })

  try {
    // 1. Generate name from LLM via tRPC
    console.log("[auto-rename] Calling generateName...")
    const { name } = await generateName(userMessage)
    console.log("[auto-rename] Generated name:", name)

    if (!name || name === "New Chat") {
      console.log("[auto-rename] Skipping - generic name")
      return // Don't rename if we got a generic name
    }

    // 2. Retry loop with delays [0, 3000, 5000, 5000]ms
    const delays = [0, 3_000, 5_000, 5_000]

    for (let attempt = 0; attempt < delays.length; attempt++) {
      if (attempt > 0) {
        await sleep(delays[attempt])
      }

      try {
        // Rename sub-chat
        await renameSubChat({ id: subChatId, name })
        updateSubChatName(subChatId, name)

        // Also rename parent chat if this is the first sub-chat,
        // BUT only if the user hasn't manually renamed it since auto-rename was triggered
        if (isFirstSubChat) {
          const currentName = getCurrentChatName?.()
          const wasManuallyRenamed = currentName != null
            && currentName !== originalChatName
            && currentName !== "New Chat"
            && currentName !== ""
          if (!wasManuallyRenamed) {
            await renameChat({ id: parentChatId, name })
            updateChatName(parentChatId, name)
          } else {
            console.log("[auto-rename] Skipping parent chat rename — user manually renamed to:", currentName)
          }
        }

        return // Success!
      } catch {
        // NOT_FOUND or other error - retry
        if (attempt === delays.length - 1) {
          console.error(
            `[auto-rename] Failed to rename after ${delays.length} attempts`,
          )
        }
      }
    }
  } catch (error) {
    console.error("[auto-rename] Auto-rename failed:", error)
  }
}
