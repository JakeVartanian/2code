/**
 * Ambient feedback tracker — learns from user dismissals/approvals.
 * Manages category weights with decay (0.85 per dismissal) and boost (1.1 per approval).
 * Tracks suppression when weight drops below 0.3 (stored as 30 in integer format).
 */

import { eq, and } from "drizzle-orm"
import { getDatabase } from "../db"
import { ambientFeedback } from "../db/schema"
import type { SuggestionCategory, CategoryWeight, HeuristicResult } from "./types"

const SUPPRESS_THRESHOLD = 30 // weight × 100; 30 = 0.30
const MAX_WEIGHT = 150 // 1.50
const DISMISS_DECAY = 0.85
const APPROVE_BOOST = 1.1

// Time-to-dismiss penalty multipliers
const REFLEX_PENALTY = 1.5 // <1s
const STANDARD_PENALTY = 1.0 // 1-5s
const CONSIDERED_PENALTY = 0.5 // 5-15s
const THOROUGH_PENALTY = 0.3 // >15s

export class FeedbackTracker {
  private projectId: string
  // In-memory cache to avoid DB reads on every filter
  private weightCache: Map<string, number> = new Map()
  private suppressedCache: Set<string> = new Set()
  private cacheLoaded = false

  constructor(projectId: string) {
    this.projectId = projectId
  }

  /**
   * Load weights from DB into cache. Called once on start, then kept in sync.
   */
  loadWeights(): void {
    const db = getDatabase()
    const rows = db.select()
      .from(ambientFeedback)
      .where(eq(ambientFeedback.projectId, this.projectId))
      .all()

    this.weightCache.clear()
    this.suppressedCache.clear()

    for (const row of rows) {
      this.weightCache.set(row.category, row.weight)
      if (row.isSuppressed) {
        this.suppressedCache.add(row.category)
      }
    }
    this.cacheLoaded = true
  }

  /**
   * Filter candidates by suppression status. Returns only non-suppressed categories.
   */
  filterBySuppression(candidates: HeuristicResult[]): HeuristicResult[] {
    if (!this.cacheLoaded) this.loadWeights()
    return candidates.filter(c => !this.suppressedCache.has(c.category))
  }

  /**
   * Get the weight for a category (0.0-1.5). Returns 1.0 if no feedback exists.
   */
  getCategoryWeight(category: SuggestionCategory): number {
    if (!this.cacheLoaded) this.loadWeights()
    const weight = this.weightCache.get(category)
    return weight !== undefined ? weight / 100 : 1.0
  }

  /**
   * Record a dismissal. Decays category weight, adjusting by time-to-dismiss.
   */
  recordDismissal(category: SuggestionCategory, timeToDismissMs?: number): void {
    const penaltyMultiplier = this.getPenaltyMultiplier(timeToDismissMs)
    const decayFactor = Math.pow(DISMISS_DECAY, penaltyMultiplier)

    const db = getDatabase()
    const existing = db.select()
      .from(ambientFeedback)
      .where(and(
        eq(ambientFeedback.projectId, this.projectId),
        eq(ambientFeedback.category, category),
      ))
      .get()

    if (existing) {
      const newWeight = Math.max(0, Math.round(existing.weight * decayFactor))
      const isSuppressed = newWeight < SUPPRESS_THRESHOLD

      db.update(ambientFeedback)
        .set({
          weight: newWeight,
          isSuppressed,
          totalDismissals: existing.totalDismissals + 1,
          updatedAt: new Date(),
        })
        .where(eq(ambientFeedback.id, existing.id))
        .run()

      // Update cache
      this.weightCache.set(category, newWeight)
      if (isSuppressed) this.suppressedCache.add(category)
      else this.suppressedCache.delete(category)
    } else {
      const newWeight = Math.round(100 * decayFactor) // Start from 1.0 (100) and decay
      db.insert(ambientFeedback)
        .values({
          projectId: this.projectId,
          category,
          weight: newWeight,
          isSuppressed: newWeight < SUPPRESS_THRESHOLD,
          totalDismissals: 1,
          totalApprovals: 0,
        })
        .run()

      this.weightCache.set(category, newWeight)
    }
  }

  /**
   * Record an approval. Boosts category weight.
   */
  recordApproval(category: SuggestionCategory): void {
    const db = getDatabase()
    const existing = db.select()
      .from(ambientFeedback)
      .where(and(
        eq(ambientFeedback.projectId, this.projectId),
        eq(ambientFeedback.category, category),
      ))
      .get()

    if (existing) {
      const newWeight = Math.min(MAX_WEIGHT, Math.round(existing.weight * APPROVE_BOOST))
      db.update(ambientFeedback)
        .set({
          weight: newWeight,
          isSuppressed: false, // Approval always un-suppresses
          totalApprovals: existing.totalApprovals + 1,
          updatedAt: new Date(),
        })
        .where(eq(ambientFeedback.id, existing.id))
        .run()

      this.weightCache.set(category, newWeight)
      this.suppressedCache.delete(category)
    } else {
      const newWeight = Math.min(MAX_WEIGHT, Math.round(100 * APPROVE_BOOST))
      db.insert(ambientFeedback)
        .values({
          projectId: this.projectId,
          category,
          weight: newWeight,
          totalDismissals: 0,
          totalApprovals: 1,
        })
        .run()

      this.weightCache.set(category, newWeight)
    }
  }

  /**
   * Get all category weights for display.
   */
  getAllWeights(): CategoryWeight[] {
    if (!this.cacheLoaded) this.loadWeights()

    const db = getDatabase()
    const rows = db.select()
      .from(ambientFeedback)
      .where(eq(ambientFeedback.projectId, this.projectId))
      .all()

    return rows.map(r => ({
      category: r.category as SuggestionCategory,
      weight: r.weight / 100,
      isSuppressed: r.isSuppressed ?? false,
      totalDismissals: r.totalDismissals,
      totalApprovals: r.totalApprovals,
    }))
  }

  private getPenaltyMultiplier(timeToDismissMs?: number): number {
    if (timeToDismissMs === undefined) return STANDARD_PENALTY
    if (timeToDismissMs < 1000) return REFLEX_PENALTY
    if (timeToDismissMs < 5000) return STANDARD_PENALTY
    if (timeToDismissMs < 15000) return CONSIDERED_PENALTY
    return THOROUGH_PENALTY
  }
}
