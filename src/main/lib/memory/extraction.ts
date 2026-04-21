/**
 * Memory extraction module — auto-extracts project learnings from
 * completed Claude sessions using a lightweight Haiku call.
 */

import { getDatabase } from "../db"
import { projectMemories } from "../db/schema"
import { eq, and } from "drizzle-orm"
import { createId } from "../db/utils"
import { callClaude } from "../claude/api"

/** Valid memory categories */
export const MEMORY_CATEGORIES = [
  "architecture",
  "convention",
  "deployment",
  "debugging",
  "preference",
  "gotcha",
] as const
export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number]

interface ExtractedMemory {
  category: MemoryCategory
  title: string
  content: string
  linkedFiles?: string[]
}

/**
 * Extraction prompt sent to Haiku to pull learnings from a conversation.
 */
const EXTRACTION_SYSTEM_PROMPT = `You are a project memory extractor. Analyze the conversation and extract actionable, project-specific knowledge that a coding assistant MUST know for future sessions.

Output a JSON array of memory objects. Each object must have:
- "category": one of "architecture", "convention", "deployment", "debugging", "preference", "gotcha"
- "title": short directive (max 80 chars) — phrase as a rule, not a description
- "content": 1-3 sentences explaining WHAT to do/avoid and WHY. Include the specific file path(s) where this applies.
- "linkedFiles": array of file paths this applies to (REQUIRED when files are mentioned)

Each memory must be a DIRECTIVE — something the assistant should DO or AVOID:
  ✅ Good: "NEVER pass OAuth tokens via env var — use .credentials.json (src/main/lib/trpc/routers/claude.ts)"
  ✅ Good: "After modifying schema, run bun run db:generate before bun run dev"
  ✅ Good: "ChatDataSync must NOT clear streaming status on unmount — causes race condition"
  ❌ Bad: "The auth flow uses PKCE" (describes, doesn't direct)
  ❌ Bad: "The project uses React" (obvious, not actionable)

Rules:
- Only extract NOVEL, PROJECT-SPECIFIC knowledge — not general programming facts
- Skip anything obvious or already in CLAUDE.md
- Focus on gotchas, non-obvious constraints, multi-step workflows, and file coupling
- Include file paths in linkedFiles whenever a memory relates to specific files
- Extract 0-5 memories maximum (0 if nothing noteworthy)

Respond with ONLY a valid JSON array, no other text.`

/**
 * Extract text content from a message, handling both flat `content` (string)
 * and the 2Code parts-based format `{ parts: [{ type: "text", text }] }`.
 */
function extractMessageText(m: Record<string, unknown>): string {
  // Flat content string (standard Anthropic format)
  if (typeof m.content === "string") return m.content

  // Parts-based format (2Code internal message format)
  if (Array.isArray(m.parts)) {
    return (m.parts as Array<Record<string, unknown>>)
      .filter((p) => p?.type === "text" && typeof p.text === "string")
      .map((p) => p.text as string)
      .join("\n")
  }

  return ""
}

/**
 * Parse conversation messages into a text summary for extraction.
 * Handles both flat `content` and 2Code's `parts`-based message format.
 */
function summarizeMessages(messages: unknown[]): string {
  const MAX_CHARS = 8000 // ~2000 tokens for extraction prompt
  const HEAD_BUDGET = 2000 // First 2K chars: the question/context
  const TAIL_BUDGET = MAX_CHARS - HEAD_BUDGET // Last 6K chars: the resolution/discoveries

  // Extract all text messages (skip tool call outputs which are bulk)
  const textMessages: { role: string; text: string }[] = []
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue
    const m = msg as Record<string, unknown>
    const role = m.role as string | undefined
    if (!role || (role !== "user" && role !== "assistant")) continue

    const text = extractMessageText(m)
    if (!text) continue

    // Truncate individual messages to keep signal density high
    const truncated = text.length > 1500 ? text.slice(0, 1500) + "..." : text
    textMessages.push({ role, text: truncated })
  }

  if (textMessages.length === 0) return ""

  // Build from both ends: first messages (context) + last messages (discoveries)
  const headLines: string[] = []
  let headChars = 0
  for (const msg of textMessages) {
    const line = `[${msg.role}]: ${msg.text}`
    if (headChars + line.length > HEAD_BUDGET) break
    headLines.push(line)
    headChars += line.length
  }

  const tailLines: string[] = []
  let tailChars = 0
  // Walk backwards from the end, skip messages already in head
  for (let i = textMessages.length - 1; i >= headLines.length; i--) {
    const msg = textMessages[i]
    const line = `[${msg.role}]: ${msg.text}`
    if (tailChars + line.length > TAIL_BUDGET) break
    tailLines.unshift(line) // Maintain chronological order
    tailChars += line.length
  }

  if (tailLines.length > 0 && headLines.length < textMessages.length) {
    return headLines.join("\n\n") + "\n\n--- (earlier messages omitted) ---\n\n" + tailLines.join("\n\n")
  }
  return headLines.join("\n\n")
}

/**
 * Check if a new memory is a duplicate of an existing one (fuzzy title match).
 */
function isDuplicate(existing: { title: string; content: string }[], candidate: ExtractedMemory): boolean {
  const candidateTitle = candidate.title.toLowerCase().trim()
  const candidateContent = candidate.content.toLowerCase().trim()

  for (const mem of existing) {
    const existTitle = mem.title.toLowerCase().trim()
    const existContent = mem.content.toLowerCase().trim()

    // Exact title match
    if (existTitle === candidateTitle) return true

    // Substring title match (one contains the other)
    if (existTitle.includes(candidateTitle) || candidateTitle.includes(existTitle)) return true

    // Content similarity — if >70% of words overlap
    const candidateWords = new Set(candidateContent.split(/\s+/).filter(w => w.length > 3))
    const existWords = new Set(existContent.split(/\s+/).filter(w => w.length > 3))
    if (candidateWords.size > 0 && existWords.size > 0) {
      let overlap = 0
      for (const w of candidateWords) {
        if (existWords.has(w)) overlap++
      }
      const similarity = overlap / Math.max(candidateWords.size, existWords.size)
      if (similarity > 0.7) return true
    }
  }
  return false
}

/**
 * Extract project memories from a completed session's messages.
 * Calls Haiku for cheap extraction (~$0.001), deduplicates against existing,
 * and inserts new memories with source="auto".
 *
 * This is designed to be fire-and-forget — errors are logged but don't propagate.
 */
export async function extractMemoriesAsync(
  projectId: string,
  subChatId: string,
  messages: unknown[],
  _anthropicApiKey?: string,
): Promise<void> {
  try {
    // Need at least 2 messages (one user + one assistant exchange)
    if (messages.length < 2) {
      console.log(`[memory:extract] Skipping — only ${messages.length} messages (need >= 2)`)
      return
    }

    const conversationText = summarizeMessages(messages)
    if (conversationText.length < 100) {
      console.log(`[memory:extract] Skipping — conversation text too short (${conversationText.length} chars)`)
      return
    }

    console.log(`[memory:extract] Starting extraction for project ${projectId}, subChat ${subChatId} (${messages.length} messages, ${conversationText.length} chars)`)

    const { text } = await callClaude({
      system: EXTRACTION_SYSTEM_PROMPT,
      userMessage: `Extract project memories from this conversation:\n\n${conversationText}`,
      maxTokens: 1024,
      timeoutMs: 60_000,
    })

    if (!text) {
      console.log("[memory:extract] callClaude returned empty text")
      return
    }

    console.log(`[memory:extract] Got response (${text.length} chars)`)

    // Parse JSON response — handle markdown code fences wrapping JSON
    let jsonText = text.trim()
    if (jsonText.startsWith("```")) {
      jsonText = jsonText.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "")
    }

    let extracted: ExtractedMemory[]
    try {
      extracted = JSON.parse(jsonText)
      if (!Array.isArray(extracted)) {
        console.log("[memory:extract] Response is not a JSON array:", jsonText.slice(0, 200))
        return
      }
    } catch (parseErr) {
      console.log("[memory:extract] Failed to parse extraction response:", jsonText.slice(0, 200))
      return
    }

    // Validate and filter
    extracted = extracted.filter(m =>
      m &&
      typeof m.category === "string" &&
      MEMORY_CATEGORIES.includes(m.category as MemoryCategory) &&
      typeof m.title === "string" && m.title.length > 0 &&
      typeof m.content === "string" && m.content.length > 0
    ).slice(0, 5) // Max 5

    if (extracted.length === 0) {
      console.log("[memory:extract] No valid memories in extraction result")
      return
    }

    console.log(`[memory:extract] Parsed ${extracted.length} candidate memories`)

    // Deduplicate against existing memories
    const db = getDatabase()
    const existing = db
      .select({ title: projectMemories.title, content: projectMemories.content })
      .from(projectMemories)
      .where(eq(projectMemories.projectId, projectId))
      .all()

    const novel = extracted.filter(m => !isDuplicate(existing, m))
    if (novel.length === 0) {
      console.log(`[memory:extract] All ${extracted.length} memories are duplicates of existing ${existing.length}`)
      return
    }

    // Insert new memories
    for (const m of novel) {
      db.insert(projectMemories)
        .values({
          id: createId(),
          projectId,
          category: m.category,
          title: m.title.slice(0, 200),
          content: m.content,
          source: "auto",
          sourceSubChatId: subChatId,
          relevanceScore: 50,
          linkedFiles: m.linkedFiles ? JSON.stringify(m.linkedFiles) : null,
        })
        .run()
    }

    console.log(`[memory:extract] Extracted ${novel.length} new memories for project ${projectId}`)
  } catch (error) {
    console.error("[memory:extract] Extraction failed:", error instanceof Error ? error.message : error)
    // Non-critical — don't propagate
  }
}
