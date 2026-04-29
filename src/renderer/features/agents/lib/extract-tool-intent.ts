/**
 * Extracts a one-line "why" annotation for a tool call from the preceding
 * assistant text. This gives tool calls human-readable context like
 * "Searching for token validation logic" instead of just "Grep: src/".
 *
 * Uses heuristics only — no AI calls. Returns undefined if no clear intent
 * can be extracted (we'd rather show nothing than a bad annotation).
 */

// Cache to avoid re-computation on scroll
const intentCache = new Map<string, string | undefined>()

/**
 * Extract intent annotation for a tool call from the message parts array.
 *
 * @param parts - The full message parts array
 * @param toolPartIndex - Index of the tool part we want intent for
 * @returns A short intent string, or undefined if none found
 */
export function extractToolIntent(
  parts: any[],
  toolPartIndex: number,
): string | undefined {
  // Build cache key from tool part identity
  const toolPart = parts[toolPartIndex]
  const cacheKey = toolPart?.toolCallId
  if (!cacheKey) return undefined
  if (intentCache.has(cacheKey)) return intentCache.get(cacheKey)

  const result = extractIntentFromParts(parts, toolPartIndex)
  intentCache.set(cacheKey, result)
  return result
}

function extractIntentFromParts(
  parts: any[],
  toolPartIndex: number,
): string | undefined {
  // Walk backward to find the nearest preceding text part
  let textContent: string | undefined
  for (let i = toolPartIndex - 1; i >= 0; i--) {
    const part = parts[i]
    if (part.type === "text" && part.text?.trim()) {
      textContent = part.text.trim()
      break
    }
    // Stop if we hit another tool (the text before that belongs to IT)
    if (part.type?.startsWith("tool-")) break
  }

  if (!textContent) return undefined

  // Extract the last meaningful sentence from the text
  return extractLastIntentSentence(textContent)
}

/**
 * Extract the last sentence that sounds like an intent/action description.
 * Claude typically writes something like:
 *   "I'll search for where the auth token is validated."
 *   "Let me check the configuration file."
 *   "Now I need to update the test to reflect these changes."
 */
function extractLastIntentSentence(text: string): string | undefined {
  // Split into sentences (handle ., :, and newlines as delimiters)
  const sentences = text
    .split(/[.!]\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 5 && s.length < 200)

  if (sentences.length === 0) return undefined

  // Take the last sentence — Claude typically states intent right before the tool call
  const candidate = sentences[sentences.length - 1]

  // Clean up: remove trailing punctuation, leading filler
  let cleaned = candidate
    .replace(/[.:!]$/, "")
    .replace(/^(Now,?\s+|So,?\s+|Next,?\s+|First,?\s+|Then,?\s+|Finally,?\s+)/i, "")
    .replace(/^(I'll\s+|I will\s+|I need to\s+|I should\s+|Let me\s+|Let's\s+)/i, "")
    .trim()

  if (!cleaned || cleaned.length < 5) return undefined

  // Capitalize first letter
  cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1)

  // Truncate if too long
  if (cleaned.length > 80) {
    cleaned = cleaned.slice(0, 77) + "..."
  }

  return cleaned
}

/**
 * Clear the intent cache (call on message changes to prevent stale data)
 */
export function clearIntentCache() {
  intentCache.clear()
}
