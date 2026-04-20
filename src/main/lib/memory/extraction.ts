/**
 * Memory extraction module — auto-extracts project learnings from
 * completed Claude sessions using a lightweight Haiku call.
 */

import { getDatabase } from "../db"
import { projectMemories } from "../db/schema"
import { eq, and } from "drizzle-orm"
import { createId } from "../db/utils"
import { getClaudeCodeTokenFresh } from "../trpc/routers/claude"

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
const EXTRACTION_SYSTEM_PROMPT = `You are a project memory extractor. Analyze the conversation and extract important project-specific facts, patterns, conventions, and gotchas that would be useful for future development sessions on this project.

Output a JSON array of memory objects. Each object must have:
- "category": one of "architecture", "convention", "deployment", "debugging", "preference", "gotcha"
- "title": short 1-line summary (max 80 chars)
- "content": detailed explanation (1-3 sentences, markdown OK)
- "linkedFiles": optional array of file paths mentioned

Rules:
- Only extract NOVEL, PROJECT-SPECIFIC knowledge — not general programming facts
- Skip anything that would already be in CLAUDE.md or is obvious
- Focus on discoveries, surprises, or important patterns found during this session
- Extract 0-5 memories maximum (0 if nothing noteworthy was learned)
- Be concise — each memory should be a standalone useful fact

Respond with ONLY a valid JSON array, no other text.`

/**
 * Parse conversation messages into a text summary for extraction.
 */
function summarizeMessages(messages: unknown[]): string {
  const lines: string[] = []
  let charCount = 0
  const MAX_CHARS = 8000 // ~2000 tokens for extraction prompt

  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue
    const m = msg as Record<string, unknown>
    const role = m.role as string | undefined
    const content = m.content as string | undefined

    if (!role || !content) continue
    if (role !== "user" && role !== "assistant") continue

    // Truncate individual messages
    const truncated = content.length > 1000 ? content.slice(0, 1000) + "..." : content
    const line = `[${role}]: ${truncated}`

    if (charCount + line.length > MAX_CHARS) break
    lines.push(line)
    charCount += line.length
  }

  return lines.join("\n\n")
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
    if (messages.length < 4) return // Need at least a few exchanges

    const conversationText = summarizeMessages(messages)
    if (conversationText.length < 200) return // Too short to extract from

    // Use OAuth token (same as all other orchestration API calls)
    const token = await getClaudeCodeTokenFresh()
    if (!token) {
      console.log("[memory:extract] No auth token available for extraction, skipping")
      return
    }

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1024,
        system: EXTRACTION_SYSTEM_PROMPT,
        messages: [
          { role: "user", content: `Extract project memories from this conversation:\n\n${conversationText}` },
        ],
      }),
    })

    if (!response.ok) {
      console.log(`[memory:extract] Haiku API error: ${response.status}`)
      return
    }

    const result = await response.json()
    const text = result.content?.[0]?.text
    if (!text) return

    // Parse JSON response
    let extracted: ExtractedMemory[]
    try {
      extracted = JSON.parse(text)
      if (!Array.isArray(extracted)) return
    } catch {
      console.log("[memory:extract] Failed to parse extraction response")
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

    if (extracted.length === 0) return

    // Deduplicate against existing memories
    const db = getDatabase()
    const existing = db
      .select({ title: projectMemories.title, content: projectMemories.content })
      .from(projectMemories)
      .where(eq(projectMemories.projectId, projectId))
      .all()

    const novel = extracted.filter(m => !isDuplicate(existing, m))
    if (novel.length === 0) return

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
    console.error("[memory:extract] Extraction failed:", error)
    // Non-critical — don't propagate
  }
}
