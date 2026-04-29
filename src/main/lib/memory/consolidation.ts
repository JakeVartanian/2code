/**
 * Knowledge document consolidation — merges related individual memories into
 * coherent knowledge documents. Inspired by Hermes "skill documents".
 *
 * When 3+ memories cluster around the same topic (detected via FTS5 similarity),
 * they're consolidated into a single rich document that replaces the originals.
 * Source memories are marked as "absorbed" (terminal state).
 */

import { eq, and, sql } from "drizzle-orm"
import { getDatabase, getSqlite } from "../db"
import { projectMemories } from "../db/schema"
import { createId } from "../db/utils"
import { searchMemories } from "./fts"
import { callClaude } from "../claude/api"
import type { MemoryCategory } from "./extraction"

// ============ TYPES ============

export interface ConsolidationGroup {
  topic: string
  memoryIds: string[]
  category: MemoryCategory
  memories: Array<{ id: string; title: string; content: string; relevanceScore: number | null }>
}

// ============ CONSOLIDATION DETECTION ============

/**
 * Identify groups of related memories that should be consolidated.
 * Uses FTS5 to find similarity clusters within the same category.
 */
export function identifyConsolidationCandidates(projectId: string): ConsolidationGroup[] {
  const db = getDatabase()
  const rawSqlite = getSqlite()
  if (!rawSqlite) return []

  // Get all active, non-consolidated memories
  const active = db.select()
    .from(projectMemories)
    .where(and(
      eq(projectMemories.projectId, projectId),
      eq(projectMemories.state, "active"),
      eq(projectMemories.isArchived, false),
    ))
    .all()
    .filter(m => m.source !== "consolidated") // Don't re-consolidate knowledge docs

  if (active.length < 12) return [] // Need enough memories to form meaningful clusters

  // Build similarity graph via FTS5
  const groups: ConsolidationGroup[] = []
  const consumed = new Set<string>()

  for (const memory of active) {
    if (consumed.has(memory.id)) continue

    // Search for similar memories
    const similar = searchMemories(rawSqlite, projectId, `${memory.title} ${memory.content.slice(0, 200)}`, 8)
      .filter(s => s.memoryId !== memory.id && !consumed.has(s.memoryId) && s.rank < -3)

    if (similar.length < 2) continue // Need at least 3 total (self + 2 similar)

    // Filter to same category (consolidation within category is more coherent)
    const sameCategory = similar.filter(s => {
      const m = active.find(a => a.id === s.memoryId)
      return m && m.category === memory.category
    })

    if (sameCategory.length < 2) continue

    const groupMemoryIds = [memory.id, ...sameCategory.slice(0, 5).map(s => s.memoryId)]
    const groupMemories = groupMemoryIds
      .map(id => active.find(a => a.id === id))
      .filter((m): m is NonNullable<typeof m> => m != null)
      .map(m => ({ id: m.id, title: m.title, content: m.content, relevanceScore: m.relevanceScore }))

    // Mark as consumed
    for (const id of groupMemoryIds) consumed.add(id)

    groups.push({
      topic: memory.title.slice(0, 80),
      memoryIds: groupMemoryIds,
      category: memory.category as MemoryCategory,
      memories: groupMemories,
    })
  }

  return groups
}

// ============ CONSOLIDATION ENGINE ============

const CONSOLIDATION_PROMPT = `Merge these related project memories into a single, coherent knowledge document.

Rules:
- Write it as a concise reference guide — NOT a bulleted list of facts
- Focus on principles and patterns that would help someone working in this area 6 months from now
- Drop implementation-specific details (specific variable names, one-time fixes) unless they represent recurring patterns
- Use markdown headers for subtopics if there are distinct sub-areas
- Preserve the WHY behind decisions, not just the WHAT
- Under 400 words
- Output ONLY the knowledge document content, no JSON wrapper`

/**
 * Consolidate a group of related memories into a single knowledge document.
 * Source memories are marked as "absorbed" (terminal state).
 */
export async function consolidateGroup(
  projectId: string,
  group: ConsolidationGroup,
): Promise<boolean> {
  const db = getDatabase()

  // Build context for the consolidation call
  const memoriesText = group.memories
    .map((m, i) => `Memory ${i + 1}: "${m.title}"\n${m.content}`)
    .join("\n\n---\n\n")

  const userMessage = `Topic area: ${group.topic}\nCategory: ${group.category}\n\nMemories to consolidate:\n\n${memoriesText}`

  try {
    const { text } = await callClaude({
      system: CONSOLIDATION_PROMPT,
      userMessage,
      maxTokens: 1024,
      timeoutMs: 60_000,
    })

    if (!text || text.length < 50) {
      console.log(`[Consolidation] Empty or too short response for group: ${group.topic}`)
      return false
    }

    // Calculate new score: average of sources + 10 consolidation bonus
    const avgScore = group.memories.reduce((sum, m) => sum + (m.relevanceScore ?? 50), 0) / group.memories.length
    const consolidatedScore = Math.min(100, Math.round(avgScore) + 10)

    // Collect all linked files from source memories
    const allLinkedFiles = new Set<string>()
    for (const memId of group.memoryIds) {
      const mem = db.select({ linkedFiles: projectMemories.linkedFiles })
        .from(projectMemories)
        .where(eq(projectMemories.id, memId))
        .get()
      if (mem?.linkedFiles) {
        try {
          const files: string[] = JSON.parse(mem.linkedFiles)
          files.forEach(f => allLinkedFiles.add(f))
        } catch { /* ignore */ }
      }
    }

    // Atomic: insert knowledge doc + mark sources as absorbed in one transaction
    const knowledgeDocId = createId()
    db.transaction(() => {
      db.insert(projectMemories)
        .values({
          id: knowledgeDocId,
          projectId,
          category: group.category,
          title: `Knowledge: ${group.topic}`,
          content: text.trim(),
          source: "consolidated",
          relevanceScore: consolidatedScore,
          consolidatedFrom: JSON.stringify(group.memoryIds),
          validationCount: group.memories.length, // Each source counts as a validation
          linkedFiles: allLinkedFiles.size > 0 ? JSON.stringify([...allLinkedFiles].slice(0, 15)) : null,
        })
        .run()

      for (const memId of group.memoryIds) {
        db.update(projectMemories)
          .set({
            state: "absorbed",
            isArchived: true,
            archivedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(projectMemories.id, memId))
          .run()
      }
    })

    console.log(`[Consolidation] Created knowledge doc "${group.topic}" from ${group.memoryIds.length} sources (score: ${consolidatedScore})`)

    // Flag map for refresh if architecture-related category was consolidated
    if (["architecture", "deployment", "convention", "design"].includes(group.category)) {
      try {
        const { flagMapForRefresh } = require("../ambient/map-freshness")
        flagMapForRefresh(projectId, `Knowledge consolidated: ${group.topic}`)
      } catch { /* non-critical */ }
    }

    return true
  } catch (err) {
    console.error(`[Consolidation] Failed for group "${group.topic}":`, err instanceof Error ? err.message : err)
    return false
  }
}

// ============ ENTRY POINT ============

/** Minimum time between consolidation runs (12 hours) */
const CONSOLIDATION_COOLDOWN_MS = 12 * 60 * 60 * 1000
const lastConsolidationAt = new Map<string, number>()

/**
 * Run a consolidation pass for a project. Up to 5 groups per pass.
 * Gated: requires 12+ active memories and 12h cooldown.
 */
export async function runConsolidationPass(projectId: string): Promise<number> {
  // Cooldown check
  const lastRun = lastConsolidationAt.get(projectId) ?? 0
  if (Date.now() - lastRun < CONSOLIDATION_COOLDOWN_MS) {
    return 0
  }

  const groups = identifyConsolidationCandidates(projectId)
  if (groups.length === 0) return 0

  lastConsolidationAt.set(projectId, Date.now())

  let consolidated = 0
  for (const group of groups.slice(0, 5)) {
    const success = await consolidateGroup(projectId, group)
    if (success) consolidated++
  }

  if (consolidated > 0) {
    console.log(`[Consolidation] Pass complete: ${consolidated}/${groups.length} groups consolidated for project ${projectId}`)
  }

  return consolidated
}

// ============ STALE MEMORY REFINEMENT ============

/**
 * Refine stale memories that were previously validated (validationCount >= 2).
 * Reads current file state and asks Haiku whether the memory is still valid.
 * Max 3 refinements per pass.
 */
export async function refineStaleMemories(
  projectId: string,
  _projectPath: string,
): Promise<number> {
  const db = getDatabase()

  const staleMemories = db.select()
    .from(projectMemories)
    .where(and(
      eq(projectMemories.projectId, projectId),
      eq(projectMemories.isStale, true),
      eq(projectMemories.state, "active"),
    ))
    .all()
    .filter(m => (m.validationCount ?? 0) >= 2) // Only refine previously-validated memories
    .slice(0, 3)

  if (staleMemories.length === 0) return 0

  let refined = 0
  for (const memory of staleMemories) {
    try {
      const { text } = await callClaude({
        system: `You are reviewing a project memory that was previously valid but may be stale.
If the memory is still relevant and useful, return "VALID" followed by an optionally updated version of the content.
If the memory is completely obsolete, return "OBSOLETE" on the first line.
Be concise.`,
        userMessage: `Memory title: ${memory.title}\nMemory content: ${memory.content}\nCategory: ${memory.category}\n\nIs this memory still valid and useful as a general principle for this project?`,
        maxTokens: 512,
        timeoutMs: 30_000,
      })

      if (!text) continue

      if (text.trim().startsWith("OBSOLETE")) {
        // Archive as dead — prevents reactivation of known-obsolete memories
        db.update(projectMemories)
          .set({
            state: "dead",
            isArchived: true,
            archivedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(projectMemories.id, memory.id))
          .run()
        console.log(`[Refinement] Archived obsolete memory: ${memory.title}`)
      } else if (text.trim().startsWith("VALID")) {
        // Extract updated content (everything after "VALID\n")
        const updatedContent = text.replace(/^VALID\s*/i, "").trim()
        db.update(projectMemories)
          .set({
            content: updatedContent.length > Math.max(50, memory.content.length * 0.3) ? updatedContent : memory.content,
            isStale: false,
            validatedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(projectMemories.id, memory.id))
          .run()
        console.log(`[Refinement] Refreshed stale memory: ${memory.title}`)
      }
      refined++
    } catch (err) {
      console.error(`[Refinement] Failed for "${memory.title}":`, err instanceof Error ? err.message : err)
    }
  }

  return refined
}
