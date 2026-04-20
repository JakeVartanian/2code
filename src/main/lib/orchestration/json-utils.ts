/**
 * Shared JSON utilities for orchestration modules.
 */

/**
 * Extract the outermost JSON object from a string using balanced brace matching.
 * Handles nested objects and strings correctly, unlike a greedy regex.
 */
export function extractJsonObject(text: string): string | null {
  const start = text.indexOf("{")
  if (start === -1) return null

  let depth = 0
  let inString = false
  let escapeNext = false

  for (let i = start; i < text.length; i++) {
    const ch = text[i]

    if (escapeNext) {
      escapeNext = false
      continue
    }

    if (ch === "\\") {
      escapeNext = true
      continue
    }

    if (ch === '"') {
      inString = !inString
      continue
    }

    if (inString) continue

    if (ch === "{") depth++
    else if (ch === "}") {
      depth--
      if (depth === 0) {
        return text.slice(start, i + 1)
      }
    }
  }

  return null
}
