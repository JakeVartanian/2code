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

  let name: string

  try {
    // 1. Generate name from LLM via tRPC
    console.log("[auto-rename] Calling generateName...")
    const result = await generateName(userMessage)
    name = result.name
    console.log("[auto-rename] Generated name:", name)

    if (!name || name === "New Chat") {
      console.log("[auto-rename] Skipping - generic name")
      return // Don't rename if we got a generic name
    }
  } catch (error) {
    // Name generation failed entirely — use truncated message as fallback
    console.error("[auto-rename] generateName threw, using fallback:", error)
    const trimmed = userMessage.trim()
    name = trimmed.length <= 25 ? trimmed : trimmed.substring(0, 25) + "..."
    if (!name) return
  }

  // 2. Optimistically update the UI immediately so user sees the name
  // even before the DB write succeeds
  updateSubChatName(subChatId, name)
  if (isFirstSubChat) {
    const currentName = getCurrentChatName?.()
    const wasManuallyRenamed = currentName != null
      && currentName !== originalChatName
      && currentName !== "New Chat"
      && currentName !== ""
    if (!wasManuallyRenamed) {
      updateChatName(parentChatId, name)
    }
  }

  // 3. Persist to DB with retries — sub-chat may not exist in DB yet
  // since creation and auto-rename are concurrent
  const delays = [500, 1500, 3000, 5000, 5000]

  for (let attempt = 0; attempt < delays.length; attempt++) {
    await sleep(delays[attempt])

    try {
      // Rename sub-chat in DB
      await renameSubChat({ id: subChatId, name })

      // Also rename parent chat if this is the first sub-chat,
      // BUT only if the user hasn't manually renamed it since auto-rename was triggered
      if (isFirstSubChat) {
        const currentName = getCurrentChatName?.()
        const wasManuallyRenamed = currentName != null
          && currentName !== originalChatName
          && currentName !== "New Chat"
          && currentName !== ""
          && currentName !== name // Don't skip if it's our optimistic update
        if (!wasManuallyRenamed) {
          try {
            await renameChat({ id: parentChatId, name })
          } catch (chatErr) {
            console.warn("[auto-rename] Failed to rename parent chat:", chatErr)
          }
        } else {
          console.log("[auto-rename] Skipping parent chat rename — user manually renamed to:", currentName)
        }
      }

      console.log(`[auto-rename] Successfully persisted name "${name}" on attempt ${attempt + 1}`)
      return // Success!
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (attempt === delays.length - 1) {
        console.error(`[auto-rename] Failed to persist name after ${delays.length} attempts. Last error: ${msg}`)
      } else {
        console.log(`[auto-rename] Attempt ${attempt + 1} failed (${msg}), retrying...`)
      }
    }
  }
}
