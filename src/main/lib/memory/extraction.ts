/**
 * Memory extraction module — auto-extracts project learnings from
 * completed Claude sessions using a lightweight Haiku call.
 */

import { getDatabase, getSqlite } from "../db"
import { projectMemories, maintenanceActions } from "../db/schema"
import { eq, and } from "drizzle-orm"
import { createId } from "../db/utils"
import { callClaude } from "../claude/api"
import { findSimilarMemories } from "./fts"

/** Valid memory categories */
export const MEMORY_CATEGORIES = [
  "architecture",
  "convention",
  "deployment",
  "debugging",
  "preference",
  "gotcha",
  "brand",
  "strategy",
  "design",
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
const EXTRACTION_SYSTEM_PROMPT = `You are a project knowledge extractor. Analyze the conversation and extract REUSABLE PRINCIPLES that build institutional memory — both technical AND strategic.

Output a JSON array of memory objects. Each must have:
- "category": one of "architecture", "convention", "deployment", "debugging", "preference", "gotcha", "brand", "strategy", "design"
- "title": short directive (max 80 chars) — phrase as a principle or rule
- "content": 1-3 sentences explaining the principle and WHY it matters
- "linkedFiles": array of file paths this applies to (when relevant)

WHAT TO EXTRACT — always express as REUSABLE PRINCIPLES, never as one-off implementation details:

GOOD memories (reusable principles that help someone 6 months from now):
  ✅ "Credential tokens must be passed via config files, not environment variables — the API rejects env-based auth"
  ✅ "Components managing streaming state must never clear status on unmount — causes race conditions during view switches"
  ✅ "Brand voice: direct, technical, no fluff — like a senior engineer talking to peers"
  ✅ "Desktop-only until 1.0 — web version is explicitly deferred"
  ✅ "Never show the same content in both list view and detail panel simultaneously"

BAD memories (NEVER extract these — they fail the quality bar):
  ❌ "Deck text appears unreadably small and gray on mobile" (a bug report, not a principle)
  ❌ "Use maha-designer for .pen deck design passes" (a tool instruction, not institutional knowledge)
  ❌ "Changed outcome_date = now() to fix the trigger" (what was done, not what was learned)
  ❌ "Renamed 19 files in the auth module" (a commit message, not knowledge)
  ❌ "Fixed the bug in handleSubmit" (a description of work done)
  ❌ "The button should be blue" (a one-time UI decision, not a design principle)
  ❌ "Run bun install after pulling" (generic workflow — everyone knows this)

THE QUALITY TEST — ask ALL THREE before extracting:
1. "Is this a REUSABLE PRINCIPLE or just a one-time observation?" → If one-time, skip.
2. "Would someone who wasn't in this conversation benefit from knowing this 6 months from now?" → If no, skip.
3. "Is this already obvious from reading the code or README?" → If yes, skip.

Rules:
- Extract 0-3 memories maximum (ZERO is perfectly fine — most conversations don't contain novel principles)
- GENERALIZE: turn specific incidents into reusable principles
- Capture the WHY behind decisions, not just the WHAT
- Skip descriptions of work done — that belongs in git, not memory
- Skip tool usage instructions — those belong in docs, not memory
- Skip bug reports and UI observations — those are suggestions, not principles
- Brand/strategy/design memories don't need linkedFiles

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
  const MIDDLE_BUDGET = 1500 // Mid-conversation inflection points
  const TAIL_BUDGET = MAX_CHARS - HEAD_BUDGET - MIDDLE_BUDGET // Last 4.5K: resolution/discoveries

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

  // Head: first messages (context/question)
  const headLines: string[] = []
  let headChars = 0
  for (const msg of textMessages) {
    const line = `[${msg.role}]: ${msg.text}`
    if (headChars + line.length > HEAD_BUDGET) break
    headLines.push(line)
    headChars += line.length
  }

  // Tail: last messages (resolution/discoveries) — walk backwards
  const tailLines: string[] = []
  let tailChars = 0
  const tailStartIdx = headLines.length // Don't overlap with head
  for (let i = textMessages.length - 1; i >= tailStartIdx; i--) {
    const msg = textMessages[i]
    const line = `[${msg.role}]: ${msg.text}`
    if (tailChars + line.length > TAIL_BUDGET) break
    tailLines.unshift(line)
    tailChars += line.length
  }

  // Middle: sample from the center of the conversation — captures inflection points,
  // pivots, and decisions that happen mid-session (often the most insightful part)
  const middleLines: string[] = []
  const middleStart = headLines.length
  const middleEnd = textMessages.length - tailLines.length
  if (middleEnd - middleStart >= 3) {
    let middleChars = 0
    const midpoint = Math.floor((middleStart + middleEnd) / 2)
    // Sample around the midpoint: 1 before, midpoint, 1 after
    const sampleIndices = [
      Math.max(middleStart, midpoint - 1),
      midpoint,
      Math.min(middleEnd - 1, midpoint + 1),
    ]
    const seen = new Set<number>()
    for (const idx of sampleIndices) {
      if (seen.has(idx) || idx < middleStart || idx >= middleEnd) continue
      seen.add(idx)
      const msg = textMessages[idx]
      const line = `[${msg.role}]: ${msg.text}`
      if (middleChars + line.length > MIDDLE_BUDGET) break
      middleLines.push(line)
      middleChars += line.length
    }
  }

  // Assemble: head + middle + tail with clear separators
  const parts = [headLines.join("\n\n")]
  if (middleLines.length > 0) {
    parts.push("--- (mid-conversation) ---\n\n" + middleLines.join("\n\n"))
  }
  if (tailLines.length > 0 && headLines.length < textMessages.length) {
    parts.push("--- (final messages) ---\n\n" + tailLines.join("\n\n"))
  }
  return parts.join("\n\n")
}

/**
 * Check if a new memory is a duplicate of an existing one.
 * Uses FTS5 for semantic similarity detection with fallback to word overlap.
 */
function isDuplicate(
  existing: { title: string; content: string }[],
  candidate: ExtractedMemory,
  projectId: string,
): boolean {
  const candidateTitle = candidate.title.toLowerCase().trim()

  // Fast path: exact title match
  for (const mem of existing) {
    const existTitle = mem.title.toLowerCase().trim()
    if (existTitle === candidateTitle) return true
    if (existTitle.includes(candidateTitle) || candidateTitle.includes(existTitle)) return true
  }

  // FTS5 path: semantic similarity via full-text search
  const rawSqlite = getSqlite()
  if (rawSqlite) {
    const similar = findSimilarMemories(rawSqlite, projectId, candidate.title, candidate.content, 3)
    // Strong FTS match (rank < -5 means highly relevant in BM25)
    if (similar.some(s => s.rank < -5)) return true
  }

  // Fallback: word overlap check (for cases where FTS5 isn't available)
  const candidateContent = candidate.content.toLowerCase().trim()
  for (const mem of existing) {
    const existContent = mem.content.toLowerCase().trim()
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
    // Need at least 5 messages to extract meaningful project knowledge
    if (messages.length < 5) {
      console.log(`[memory:extract] Skipping — only ${messages.length} messages (need >= 5)`)
      return
    }

    // Require either tool calls OR a substantive discussion (≥5 user messages with >400 chars each).
    // Pure Q&A rarely produces knowledge, but strategy/brand/design discussions do — even without tool calls.
    const hasToolCall = messages.some(m => {
      if (!m || typeof m !== "object") return false
      const msg = m as Record<string, unknown>
      if (msg.role !== "assistant") return false
      if (Array.isArray(msg.content)) {
        return (msg.content as Array<Record<string, unknown>>).some(b => b?.type === "tool_use")
      }
      if (Array.isArray(msg.parts)) {
        return (msg.parts as Array<Record<string, unknown>>).some(p => p?.type === "tool_call" || p?.type === "tool_use")
      }
      return false
    })

    if (!hasToolCall) {
      // Check for substantive discussion
      let substantiveUserMessages = 0
      let allUserText = ""
      for (const m of messages) {
        if (!m || typeof m !== "object") continue
        const msg = m as Record<string, unknown>
        if (msg.role !== "user") continue
        const text = extractMessageText(msg)
        allUserText += " " + text
        if (text.length > 400) substantiveUserMessages++
      }

      // Path 1: Standard threshold — ≥5 user messages with >400 chars each
      if (substantiveUserMessages >= 5) {
        console.log(`[memory:extract] No tool calls but ${substantiveUserMessages} substantive user messages — proceeding`)
      } else {
        // Path 2: Lower threshold for brand/strategy/design discussions
        // These conversations are shorter but richer in extractable knowledge
        const lowerText = allUserText.toLowerCase()
        // Strong signals = unambiguously brand/strategy/design conversations
        const strongKeywords = [
          "brand", "voice", "tone", "audience", "positioning", "roadmap", "market",
          "strategy", "vision", "mission", "target user", "competitor",
          "identity", "messaging", "tagline", "pitch",
        ]
        // Weak signals = common in code conversations too, only count alongside strong ones
        const weakKeywords = [
          "design", "ui", "ux", "layout", "animation", "wireframe", "mockup",
          "philosophy", "principle", "approach",
        ]
        const strongHits = strongKeywords.filter(kw => lowerText.includes(kw)).length
        const weakHits = weakKeywords.filter(kw => lowerText.includes(kw)).length
        const keywordHits = strongHits + weakHits

        // Count shorter but meaningful messages (>200 chars) for non-technical discussions
        let shortSubstantive = 0
        for (const m of messages) {
          if (!m || typeof m !== "object") continue
          const msg = m as Record<string, unknown>
          if (msg.role !== "user") continue
          const text = extractMessageText(msg)
          if (text.length > 200) shortSubstantive++
        }

        // Require at least 1 strong keyword + 3 total hits to avoid false positives on routine code convos
        if (strongHits >= 1 && keywordHits >= 3 && shortSubstantive >= 3) {
          console.log(`[memory:extract] No tool calls but brand/strategy/design discussion detected (${keywordHits} keywords, ${shortSubstantive} messages) — proceeding`)
        } else {
          console.log(`[memory:extract] Skipping — no tool calls, ${substantiveUserMessages} substantive messages, ${keywordHits} brand/strategy keywords`)
          return
        }
      }
    }

    const conversationText = summarizeMessages(messages)
    if (conversationText.length < 100) {
      console.log(`[memory:extract] Skipping — conversation text too short (${conversationText.length} chars)`)
      return
    }

    console.log(`[memory:extract] Starting extraction for project ${projectId}, subChat ${subChatId} (${messages.length} messages, ${conversationText.length} chars)`)

    // Build category-aware prompt: bias toward underrepresented categories
    let systemPrompt = EXTRACTION_SYSTEM_PROMPT
    const dist = getCategoryDistribution(projectId)
    const totalMemories = Object.values(dist).reduce((a, b) => a + b, 0)
    if (totalMemories >= 5) {
      const sparseCategories = MEMORY_CATEGORIES.filter(c => dist[c] < 2)
      if (sparseCategories.length > 0) {
        systemPrompt += `\n\nPRIORITY: This project's knowledge base is sparse on: ${sparseCategories.join(", ")}. Pay special attention to any insights in these areas.`
      }
    }

    const { text } = await callClaude({
      system: systemPrompt,
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
    ).slice(0, 3) // Max 3 — fewer but higher quality

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

    const novel = extracted.filter(m => !isDuplicate(existing, m, projectId))
    if (novel.length === 0) {
      console.log(`[memory:extract] All ${extracted.length} memories are duplicates of existing ${existing.length}`)
      return
    }

    // Check for overlap with active memories — create "enrich-memory" actions instead of new memories
    const rawSqlite = getSqlite()
    const trulyNovel: ExtractedMemory[] = []

    for (const m of novel) {
      if (rawSqlite) {
        const similar = findSimilarMemories(rawSqlite, projectId, m.title, m.content, 3)
        // Moderate overlap (rank between -3 and -5) = enrich existing, not create new
        const enrichMatch = similar.find(s => s.rank < -3 && s.rank >= -5)
        if (enrichMatch) {
          const existingMem = db.select({ id: projectMemories.id, title: projectMemories.title })
            .from(projectMemories)
            .where(eq(projectMemories.id, enrichMatch.memoryId))
            .get()
          if (existingMem) {
            // Create "enrich-memory" maintenance action (per-type cap)
            const pendingEnrich = db.select({ id: maintenanceActions.id })
              .from(maintenanceActions)
              .where(and(
                eq(maintenanceActions.projectId, projectId),
                eq(maintenanceActions.type, "enrich-memory"),
                eq(maintenanceActions.status, "pending"),
              ))
              .all().length
            if (pendingEnrich < 3) {
              const actionId = createId()
              db.insert(maintenanceActions)
                .values({
                  id: actionId,
                  projectId,
                  type: "enrich-memory",
                  title: `Strengthen: ${existingMem.title.slice(0, 100)}`,
                  description: m.content,
                  details: JSON.stringify({ existingMemoryId: existingMem.id, newContent: m.content, category: m.category }),
                })
                .run()
              console.log(`[memory:extract] Created enrich-memory action for "${existingMem.title}"`)
            }
            continue
          }
        }
      }
      trulyNovel.push(m)
    }

    if (trulyNovel.length === 0 && novel.length > 0) {
      console.log(`[memory:extract] All ${novel.length} novel memories matched for enrichment`)
      return
    }

    // Insert truly novel memories as "suggested" — not injected until user approves
    for (const m of trulyNovel) {
      const memoryId = createId()
      db.insert(projectMemories)
        .values({
          id: memoryId,
          projectId,
          category: m.category,
          title: m.title.slice(0, 200),
          content: m.content,
          source: "suggested",
          sourceSubChatId: subChatId,
          relevanceScore: 0, // Not injected until approved
          linkedFiles: m.linkedFiles ? JSON.stringify(m.linkedFiles) : null,
        })
        .run()

      // Create maintenance action for user approval (per-type cap)
      const pendingMemoryActions = db.select({ id: maintenanceActions.id })
        .from(maintenanceActions)
        .where(and(
          eq(maintenanceActions.projectId, projectId),
          eq(maintenanceActions.type, "update-memory"),
          eq(maintenanceActions.status, "pending"),
        ))
        .all()
      if (pendingMemoryActions.length < 3) {
        const actionId = createId()
        db.insert(maintenanceActions)
          .values({
            id: actionId,
            projectId,
            type: "update-memory",
            title: m.title.slice(0, 120),
            description: m.content,
            details: JSON.stringify({ memoryId, category: m.category }),
          })
          .run()

        // Emit event for real-time UI update
        try {
          const { ambientEvents } = require("../trpc/routers/ambient")
          ambientEvents?.emit(`project:${projectId}`, {
            type: "maintenance-action-requested",
            actionId,
            action: { id: actionId, type: "update-memory", title: m.title },
          })
        } catch { /* non-critical */ }
      }
    }

    console.log(`[memory:extract] Extracted ${novel.length} suggested memories for project ${projectId}`)
  } catch (error) {
    console.error("[memory:extract] Extraction failed:", error instanceof Error ? error.message : error)
    // Non-critical — don't propagate
  }
}

/**
 * Get count of active memories per category for a project.
 * Used for category-aware extraction (bias toward underrepresented categories).
 */
export function getCategoryDistribution(projectId: string): Record<MemoryCategory, number> {
  const db = getDatabase()
  const dist: Record<string, number> = {}
  for (const cat of MEMORY_CATEGORIES) {
    dist[cat] = 0
  }

  const memories = db.select({ category: projectMemories.category })
    .from(projectMemories)
    .where(and(
      eq(projectMemories.projectId, projectId),
      eq(projectMemories.isArchived, false),
      eq(projectMemories.state, "active"),
    ))
    .all()

  for (const m of memories) {
    if (m.category in dist) {
      dist[m.category]++
    }
  }

  return dist as Record<MemoryCategory, number>
}
