/**
 * Memory evolution — progressive refinement, confidence building, and convention crystallization.
 * Makes the memory system grow smarter over time by:
 * 1. Updating existing memories when new observations confirm them (confidence boost)
 * 2. Crystallizing repeated patterns into convention memories after 5+ instances
 * 3. De-duplicating new observations against existing knowledge
 */

import { eq, and, sql } from "drizzle-orm"
import { getDatabase, getSqlite } from "../db"
import { projectMemories } from "../db/schema"
import { createId } from "../db/utils"
import { findSimilarMemories as ftsFindSimilar } from "../memory/fts"

export type EvolutionResult = "created" | "updated" | "skipped"

interface ObservedPattern {
  title: string
  content: string
  category: string
  linkedFiles: string[]
  confidence: number
}

/**
 * Evolve a memory — either update an existing one or create a new one.
 * Prevents duplicates and strengthens confirmed observations.
 */
export function evolveMemory(
  projectId: string,
  observation: ObservedPattern,
): EvolutionResult {
  const db = getDatabase()

  // Find related existing memories
  const existing = db.select()
    .from(projectMemories)
    .where(and(
      eq(projectMemories.projectId, projectId),
      eq(projectMemories.isArchived, false),
    ))
    .all()

  // Use transaction to prevent race conditions (read-check-write atomicity)
  return db.transaction((tx) => {
    // Check for exact title match (strongest dedup)
    const exactMatch = existing.find(m => m.title === observation.title)
    if (exactMatch) {
      // Boost confidence on re-observation
      const newScore = Math.min(100, (exactMatch.relevanceScore ?? 50) + 5)
      tx.update(projectMemories)
        .set({
          relevanceScore: newScore,
          isStale: false, // Re-confirmed = not stale
          updatedAt: new Date(),
        })
        .where(eq(projectMemories.id, exactMatch.id))
        .run()
      return "updated" as EvolutionResult
    }

    // Check for high content overlap (fuzzy dedup via FTS5 + fallback)
    const similar = findSimilarMemory(existing, observation, projectId)
    if (similar) {
      // Update existing memory with new context if it adds information
      const mergedContent = mergeContent(similar.content, observation.content)
      const newScore = Math.min(100, (similar.relevanceScore ?? 50) + 5)

      // Merge linked files
      const existingFiles: string[] = similar.linkedFiles ? JSON.parse(similar.linkedFiles) : []
      const mergedFiles = [...new Set([...existingFiles, ...observation.linkedFiles])].slice(0, 10)

      tx.update(projectMemories)
        .set({
          content: mergedContent,
          relevanceScore: newScore,
          linkedFiles: JSON.stringify(mergedFiles),
          isStale: false,
          updatedAt: new Date(),
        })
        .where(eq(projectMemories.id, similar.id))
        .run()
      return "updated" as EvolutionResult
    }

    // Genuinely new observation — create memory
    tx.insert(projectMemories)
      .values({
        id: createId(),
        projectId,
        category: observation.category,
        title: observation.title,
        content: observation.content,
        source: "auto",
        linkedFiles: JSON.stringify(observation.linkedFiles),
        relevanceScore: observation.confidence,
      })
      .run()
    return "created" as EvolutionResult
  })
}

/**
 * Track a pattern occurrence. After 5+ observations of the same pattern
 * across different files, crystallize it into a convention memory.
 * Entries are evicted after 24 hours to prevent unbounded growth.
 */
const patternCounts = new Map<string, { count: number; files: Set<string>; lastContent: string; lastSeen: number }>()
const PATTERN_TTL = 24 * 60 * 60 * 1000 // 24 hours
const PATTERN_MAX_ENTRIES = 200

export function trackPattern(
  projectId: string,
  patternKey: string,
  description: string,
  filePath: string,
): void {
  // Periodic eviction of stale entries
  evictStalePatterns()

  const key = `${projectId}:${patternKey}`
  const existing = patternCounts.get(key)

  if (existing) {
    existing.count++
    existing.files.add(filePath)
    existing.lastContent = description
    existing.lastSeen = Date.now()

    // Crystallize after 5 unique files show the same pattern
    if (existing.files.size >= 5) {
      crystallizeConvention(projectId, patternKey, description, [...existing.files])
      patternCounts.delete(key) // Reset after crystallization
    }
  } else {
    patternCounts.set(key, {
      count: 1,
      files: new Set([filePath]),
      lastContent: description,
      lastSeen: Date.now(),
    })
  }
}

function evictStalePatterns(): void {
  if (patternCounts.size <= PATTERN_MAX_ENTRIES) return
  const now = Date.now()
  for (const [key, entry] of patternCounts) {
    if (now - entry.lastSeen > PATTERN_TTL) {
      patternCounts.delete(key)
    }
  }
  // If still over limit, remove oldest entries
  if (patternCounts.size > PATTERN_MAX_ENTRIES) {
    const sorted = [...patternCounts.entries()].sort((a, b) => a[1].lastSeen - b[1].lastSeen)
    for (let i = 0; i < sorted.length - PATTERN_MAX_ENTRIES; i++) {
      patternCounts.delete(sorted[i][0])
    }
  }
}

/**
 * Boost a memory's relevance score (called when user approves a suggestion
 * or when the ambient agent confirms an existing observation).
 */
export function boostMemoryConfidence(memoryId: string, boost: number = 5): void {
  const db = getDatabase()
  db.update(projectMemories)
    .set({
      relevanceScore: sql`MIN(100, ${projectMemories.relevanceScore} + ${boost})`,
      updatedAt: new Date(),
    })
    .where(eq(projectMemories.id, memoryId))
    .run()
}

/**
 * Enrich an existing memory with new content from an overlapping extraction.
 * Merges the new observation into the existing memory, boosts score, increments validationCount.
 */
export async function enrichMemory(
  memoryId: string,
  newContent: string,
): Promise<void> {
  const db = getDatabase()

  const memory = db.select()
    .from(projectMemories)
    .where(eq(projectMemories.id, memoryId))
    .get()

  if (!memory) return

  // Intelligent merge: if new content is substantially different, append as update
  const merged = mergeContent(memory.content, newContent)

  db.update(projectMemories)
    .set({
      content: merged,
      relevanceScore: sql`MIN(100, ${projectMemories.relevanceScore} + 5)`,
      validationCount: sql`${projectMemories.validationCount} + 1`,
      validatedAt: new Date(),
      isStale: false,
      updatedAt: new Date(),
    })
    .where(eq(projectMemories.id, memoryId))
    .run()

  console.log(`[Memory] Enriched memory "${memory.title}" (validation #${(memory.validationCount ?? 0) + 1})`)

  // Flag map for refresh if architecture-related category was enriched
  if (["architecture", "deployment", "convention", "design"].includes(memory.category)) {
    try {
      const { flagMapForRefresh } = require("./map-freshness")
      flagMapForRefresh(memory.projectId, `Memory enriched: ${memory.title}`)
    } catch { /* non-critical */ }
  }
}

// ============ INTERNAL HELPERS ============

function findSimilarMemory(
  memories: Array<{ id: string; title: string; content: string; relevanceScore: number | null; linkedFiles: string | null }>,
  observation: ObservedPattern,
  projectId?: string,
): (typeof memories)[number] | null {
  // FTS5 path: fast semantic similarity via full-text search
  const rawSqlite = getSqlite()
  if (rawSqlite && projectId) {
    const ftsMatches = ftsFindSimilar(rawSqlite, projectId, observation.title, observation.content, 3)
    if (ftsMatches.length > 0 && ftsMatches[0].rank < -5) {
      const match = memories.find(m => m.id === ftsMatches[0].memoryId)
      if (match) return match
    }
  }

  // Fallback: word overlap
  const obsWords = new Set(observation.content.toLowerCase().split(/\s+/).filter(w => w.length > 3))
  for (const memory of memories) {
    const memWords = new Set(memory.content.toLowerCase().split(/\s+/).filter(w => w.length > 3))
    let overlap = 0
    for (const word of obsWords) {
      if (memWords.has(word)) overlap++
    }
    const overlapRatio = obsWords.size > 0 ? overlap / obsWords.size : 0
    if (overlapRatio > 0.7) return memory
  }

  return null
}

function mergeContent(existing: string, newContent: string): string {
  const MAX_CONTENT_LENGTH = 2000 // Cap total content to prevent unbounded growth across enrichment cycles

  // If new content is substantially longer, it's likely more detailed — prefer it
  if (newContent.length > existing.length * 1.5) return newContent.slice(0, MAX_CONTENT_LENGTH)

  // If existing is substantially longer, keep it
  if (existing.length > newContent.length * 1.5) return existing.slice(0, MAX_CONTENT_LENGTH)

  // Similar length — check if new content adds genuinely different info
  const existingWords = new Set(existing.toLowerCase().split(/\s+/).filter(w => w.length > 3))
  const newWords = newContent.toLowerCase().split(/\s+/).filter(w => w.length > 3)
  const novelWords = newWords.filter(w => !existingWords.has(w))
  const noveltyRatio = newWords.length > 0 ? novelWords.length / newWords.length : 0

  // If >30% of words are novel, append as an update (but cap total length)
  if (noveltyRatio > 0.3) {
    const merged = `${existing}\n\n**Update:** ${newContent}`
    if (merged.length > MAX_CONTENT_LENGTH) {
      // Too long — keep existing and trim new content to fit
      const budget = MAX_CONTENT_LENGTH - existing.length - 15 // 15 for "\n\n**Update:** "
      if (budget > 50) {
        return `${existing}\n\n**Update:** ${newContent.slice(0, budget)}...`
      }
      return existing // No room to append meaningfully
    }
    return merged
  }

  // Mostly the same info — keep existing (already validated)
  return existing
}

function crystallizeConvention(
  projectId: string,
  patternKey: string,
  description: string,
  files: string[],
): void {
  const db = getDatabase()

  // Check if already crystallized
  const title = `Convention: ${patternKey}`
  const existing = db.select({ id: projectMemories.id })
    .from(projectMemories)
    .where(and(
      eq(projectMemories.projectId, projectId),
      eq(projectMemories.title, title),
    ))
    .get()

  if (existing) return // Already exists

  const fileList = files.slice(0, 5).join(", ")
  const content = `ALWAYS: ${description}\nObserved in ${files.length} files: ${fileList}\nApplies to: similar files in this project`

  db.insert(projectMemories)
    .values({
      id: createId(),
      projectId,
      category: "convention",
      title: title.slice(0, 100),
      content,
      source: "auto",
      linkedFiles: JSON.stringify(files.slice(0, 10)),
      relevanceScore: 75, // High confidence — confirmed across 5+ files
    })
    .run()

  console.log(`[Ambient] Convention crystallized: ${patternKey}`)
}
