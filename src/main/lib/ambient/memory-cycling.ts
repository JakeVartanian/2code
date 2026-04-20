/**
 * Memory cycling — manages the active/cold/dead lifecycle of project memories.
 * Handles trim (when injection budget overflows), feedback (post-session utility tracking),
 * score decay, and re-activation (cold memories becoming relevant again).
 *
 * All operations are local (no API calls). Cost: zero.
 */

import { eq, and, sql, desc, isNull } from "drizzle-orm"
import { getDatabase } from "../db"
import { projectMemories } from "../db/schema"

// ============ CONSTANTS ============

const MAX_ACTIVE_MEMORIES = 40
const TRIM_BUDGET_OVERFLOW_RATIO = 1.3 // Trigger trim when candidates exceed budget by 30%
const TRIM_TARGET_RATIO = 0.85 // Trim down to 85% of budget
const TRIM_COOLDOWN_DAYS = 7
const DECAY_RATE_PER_DAY = 0.5
const DECAY_FLOOR = 10
const NOISE_INJECTION_THRESHOLD = 20 // After 20 injections with < 10% utility
const NOISE_UTILITY_RATIO = 0.1
const PROBATION_SESSION_LIMIT = 3
const AUTO_DEAD_DAYS = 90
const AVG_TOKENS_PER_MEMORY = 80

// ============ TRIM LOGIC ============

export interface TrimResult {
  trimmed: number
  activeRemaining: number
}

/**
 * Trim low-value memories when injection budget is overloaded.
 * Archives the lowest-scored memories until active set is within budget.
 */
export function trimMemories(projectId: string, tokenBudget: number = 3000): TrimResult {
  const db = getDatabase()
  const now = new Date()

  // Get all active memories
  const active = db.select()
    .from(projectMemories)
    .where(and(
      eq(projectMemories.projectId, projectId),
      eq(projectMemories.state, "active"),
      eq(projectMemories.isArchived, false),
    ))
    .orderBy(desc(projectMemories.relevanceScore))
    .all()

  // Check if trim is needed
  const estimatedTokens = active.length * AVG_TOKENS_PER_MEMORY
  if (estimatedTokens <= tokenBudget * TRIM_BUDGET_OVERFLOW_RATIO && active.length <= MAX_ACTIVE_MEMORIES) {
    return { trimmed: 0, activeRemaining: active.length }
  }

  // Calculate how many to trim
  const targetTokens = tokenBudget * TRIM_TARGET_RATIO
  const targetCount = Math.min(MAX_ACTIVE_MEMORIES, Math.floor(targetTokens / AVG_TOKENS_PER_MEMORY))
  const toTrimCount = Math.max(0, active.length - targetCount)

  if (toTrimCount === 0) return { trimmed: 0, activeRemaining: active.length }

  // Don't trim more than 30% in one cycle
  const maxTrim = Math.floor(active.length * 0.3)
  const actualTrim = Math.min(toTrimCount, maxTrim)

  // Sort ascending by score to find the lowest-value ones
  const candidates = [...active]
    .sort((a, b) => (a.relevanceScore ?? 0) - (b.relevanceScore ?? 0))
    .filter(m => {
      // Skip memories with trim cooldown
      if (m.trimCooldownUntil && m.trimCooldownUntil > now) return false
      // Skip memories accessed in last 14 days
      if (m.lastAccessedAt) {
        const daysSince = (now.getTime() - m.lastAccessedAt.getTime()) / (1000 * 60 * 60 * 24)
        if (daysSince < 14) return false
      }
      return true
    })
    .slice(0, actualTrim)

  // Archive them (move to cold)
  for (const memory of candidates) {
    db.update(projectMemories)
      .set({
        state: "cold",
        isArchived: true,
        archivedAt: now,
        updatedAt: now,
      })
      .where(eq(projectMemories.id, memory.id))
      .run()
  }

  return { trimmed: candidates.length, activeRemaining: active.length - candidates.length }
}

// ============ POST-SESSION FEEDBACK ============

export interface SessionFeedback {
  projectId: string
  injectedMemoryIds: string[]
  filesRead: string[]
  filesModified: string[]
  conversationKeywords: string[]
}

/**
 * Post-session feedback — tracks which injected memories were actually useful.
 * Call after each Claude session completes.
 */
export function recordSessionFeedback(feedback: SessionFeedback): void {
  const db = getDatabase()
  const now = new Date()
  const touchedFiles = new Set([...feedback.filesRead, ...feedback.filesModified])
  const modifiedFiles = new Set(feedback.filesModified)
  const keywords = new Set(feedback.conversationKeywords.map(k => k.toLowerCase()))

  for (const memoryId of feedback.injectedMemoryIds) {
    const memory = db.select()
      .from(projectMemories)
      .where(eq(projectMemories.id, memoryId))
      .get()

    if (!memory) continue

    const linkedFiles: string[] = memory.linkedFiles ? JSON.parse(memory.linkedFiles) : []
    const memoryKeywords = extractSimpleKeywords(memory.content + " " + memory.title)

    // Check for utility signals
    const fileHit = linkedFiles.some(f => touchedFiles.has(f))
    const modifyHit = linkedFiles.some(f => modifiedFiles.has(f))
    const keywordHit = memoryKeywords.some(k => keywords.has(k.toLowerCase()))

    // Increment injection count
    const newInjectionCount = (memory.injectionCount ?? 0) + 1

    if (modifyHit) {
      // Strong signal: memory directly relevant to work done
      db.update(projectMemories)
        .set({
          injectionCount: newInjectionCount,
          utilityCount: (memory.utilityCount ?? 0) + 1,
          lastUtilityAt: now,
          lastAccessedAt: now,
          relevanceScore: Math.min(100, (memory.relevanceScore ?? 50) + 3),
          isProbationary: false, // Confirmed useful
          updatedAt: now,
        })
        .where(eq(projectMemories.id, memoryId))
        .run()
    } else if (fileHit || keywordHit) {
      // Weak signal: tangentially relevant
      db.update(projectMemories)
        .set({
          injectionCount: newInjectionCount,
          utilityCount: sql`${projectMemories.utilityCount} + 0`, // Don't increment, just track injection
          lastAccessedAt: now,
          relevanceScore: Math.min(100, (memory.relevanceScore ?? 50) + 1),
          updatedAt: now,
        })
        .where(eq(projectMemories.id, memoryId))
        .run()
    } else {
      // No signal: injected but not useful this time
      db.update(projectMemories)
        .set({
          injectionCount: newInjectionCount,
          updatedAt: now,
        })
        .where(eq(projectMemories.id, memoryId))
        .run()

      // Check for noise pattern
      if (newInjectionCount >= NOISE_INJECTION_THRESHOLD) {
        const utilityRatio = (memory.utilityCount ?? 0) / newInjectionCount
        if (utilityRatio < NOISE_UTILITY_RATIO) {
          // Auto-archive: injected many times but never useful
          db.update(projectMemories)
            .set({
              state: "cold",
              isArchived: true,
              archivedAt: now,
              updatedAt: now,
            })
            .where(eq(projectMemories.id, memoryId))
            .run()
        }
      }
    }
  }
}

// ============ SCORE DECAY ============

/**
 * Apply daily score decay to memories that are being injected but never utilized.
 * Call once per day (or on app launch).
 */
export function applyScoreDecay(projectId: string): number {
  const db = getDatabase()
  const now = new Date()
  let decayed = 0

  const active = db.select()
    .from(projectMemories)
    .where(and(
      eq(projectMemories.projectId, projectId),
      eq(projectMemories.state, "active"),
    ))
    .all()

  for (const memory of active) {
    // Only decay if memory has been injected but not utilized recently
    if ((memory.injectionCount ?? 0) === 0) continue // Never injected, skip
    if (memory.lastUtilityAt) {
      const daysSinceUtility = (now.getTime() - memory.lastUtilityAt.getTime()) / (1000 * 60 * 60 * 24)
      if (daysSinceUtility < 7) continue // Used recently, skip
    }

    const currentScore = memory.relevanceScore ?? 50
    if (currentScore <= DECAY_FLOOR) continue // Already at floor

    const newScore = Math.max(DECAY_FLOOR, currentScore - DECAY_RATE_PER_DAY)

    // If score drops below 25, auto-archive to cold
    if (newScore < 25) {
      db.update(projectMemories)
        .set({
          relevanceScore: newScore,
          state: "cold",
          isArchived: true,
          archivedAt: now,
          updatedAt: now,
        })
        .where(eq(projectMemories.id, memory.id))
        .run()
    } else {
      db.update(projectMemories)
        .set({ relevanceScore: newScore, updatedAt: now })
        .where(eq(projectMemories.id, memory.id))
        .run()
    }
    decayed++
  }

  return decayed
}

// ============ RE-ACTIVATION ============

/**
 * Check cold memories for re-activation triggers.
 * Call before injection scoring (on session start).
 */
export function checkReactivation(
  projectId: string,
  activeFilePaths: string[],
  promptKeywords: string[],
): number {
  const db = getDatabase()
  const now = new Date()
  let reactivated = 0

  const cold = db.select()
    .from(projectMemories)
    .where(and(
      eq(projectMemories.projectId, projectId),
      eq(projectMemories.state, "cold"),
    ))
    .all()

  const activeFiles = new Set(activeFilePaths)
  const keywords = new Set(promptKeywords.map(k => k.toLowerCase()))

  for (const memory of cold) {
    const linkedFiles: string[] = memory.linkedFiles ? JSON.parse(memory.linkedFiles) : []
    const memoryKeywords = extractSimpleKeywords(memory.content + " " + memory.title)

    let trigger: string | null = null
    let scoreBonus = 0

    // Check file activity trigger
    if (linkedFiles.some(f => activeFiles.has(f))) {
      trigger = "file-activity"
      scoreBonus = 20
    }

    // Check keyword match trigger (2+ keywords needed)
    if (!trigger) {
      const matchCount = memoryKeywords.filter(k => keywords.has(k.toLowerCase())).length
      if (matchCount >= 2) {
        trigger = "keyword-match"
        scoreBonus = 15
      }
    }

    // Check time-based review (30+ days archived, original score was decent)
    if (!trigger && memory.archivedAt) {
      const daysArchived = (now.getTime() - memory.archivedAt.getTime()) / (1000 * 60 * 60 * 24)
      if (daysArchived >= 30 && (memory.relevanceScore ?? 0) >= 40) {
        trigger = "time-review"
        scoreBonus = 5
      }
    }

    if (trigger) {
      const isProbationary = trigger === "time-review"
      const cooldownUntil = new Date(now.getTime() + TRIM_COOLDOWN_DAYS * 24 * 60 * 60 * 1000)

      db.update(projectMemories)
        .set({
          state: "active",
          isArchived: false,
          reactivatedAt: now,
          trimCooldownUntil: cooldownUntil,
          isProbationary,
          relevanceScore: Math.min(100, (memory.relevanceScore ?? DECAY_FLOOR) + scoreBonus),
          updatedAt: now,
        })
        .where(eq(projectMemories.id, memory.id))
        .run()

      reactivated++
    }
  }

  return reactivated
}

// ============ HELPERS ============

function extractSimpleKeywords(text: string): string[] {
  // Extract identifiers (camelCase, PascalCase, snake_case, 4+ chars)
  const matches = text.match(/\b[a-zA-Z_][a-zA-Z0-9_]{3,30}\b/g) ?? []

  const STOP_WORDS = new Set([
    "this", "that", "with", "from", "have", "been", "will", "they",
    "when", "what", "which", "their", "about", "would", "could", "should",
    "always", "never", "must", "file", "files", "code", "uses", "using",
    "project", "function", "class", "module", "pattern", "applies",
  ])

  return [...new Set(
    matches.filter(m => !STOP_WORDS.has(m.toLowerCase()))
  )].slice(0, 15)
}
