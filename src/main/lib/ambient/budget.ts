/**
 * Ambient agent budget tracker — enforces daily spend limits with atomic increments.
 * Persists to the ambientBudget table, resets daily at midnight local time.
 */

import { eq, and, sql } from "drizzle-orm"
import { getDatabase } from "../db"
import { ambientBudget } from "../db/schema"
import type { BudgetConfig, BudgetStatus } from "./types"

// Pricing (per million tokens) as of 2026-04
const HAIKU_INPUT_COST_PER_M = 25 // $0.25 per 1M → 0.025 cents per 1K
const HAIKU_OUTPUT_COST_PER_M = 125 // $1.25 per 1M
const SONNET_INPUT_COST_PER_M = 300 // $3.00 per 1M
const SONNET_OUTPUT_COST_PER_M = 1500 // $15.00 per 1M

function costInCents(inputTokens: number, outputTokens: number, tier: "haiku" | "sonnet"): number {
  if (tier === "haiku") {
    return Math.ceil(
      (inputTokens * HAIKU_INPUT_COST_PER_M + outputTokens * HAIKU_OUTPUT_COST_PER_M) / 1_000_000
    )
  }
  return Math.ceil(
    (inputTokens * SONNET_INPUT_COST_PER_M + outputTokens * SONNET_OUTPUT_COST_PER_M) / 1_000_000
  )
}

function getTodayDate(): string {
  return new Date().toISOString().slice(0, 10) // "YYYY-MM-DD"
}

export class BudgetTracker {
  private projectId: string
  private config: BudgetConfig
  // In-memory rate limit tracking (per-hour, resets on the hour)
  private hourlyHaikuCalls = 0
  private hourlySonnetCalls = 0
  private currentHour = new Date().getHours()

  constructor(projectId: string, config: BudgetConfig) {
    this.projectId = projectId
    this.config = config
  }

  updateConfig(config: BudgetConfig): void {
    this.config = config
  }

  /**
   * Check if a spend of the estimated amount is allowed.
   * Does NOT record the spend — call recordSpend() after the API call succeeds.
   */
  canSpend(tier: "haiku" | "sonnet", estimatedInputTokens: number, estimatedOutputTokens: number): boolean {
    // Check hourly rate limit
    this.resetHourIfNeeded()
    if (tier === "haiku" && this.hourlyHaikuCalls >= this.config.haikuRateLimit) return false
    if (tier === "sonnet" && this.hourlySonnetCalls >= this.config.sonnetRateLimit) return false

    // Check daily budget
    const status = this.getStatusSync()
    if (!status) return true // No record yet = fresh day, allow

    const estimatedCost = costInCents(estimatedInputTokens, estimatedOutputTokens, tier)
    return (status.totalCostCents + estimatedCost) <= this.config.dailyLimitCents
  }

  /**
   * Record a completed spend. Uses atomic increment to avoid TOCTOU races.
   * Returns false if the budget was exceeded (spend still recorded to stay accurate).
   */
  recordSpend(tier: "haiku" | "sonnet", inputTokens: number, outputTokens: number): boolean {
    const db = getDatabase()
    const today = getTodayDate()
    const cost = costInCents(inputTokens, outputTokens, tier)

    // Ensure row exists for today
    this.ensureTodayRow(today)

    // Atomic increment
    if (tier === "haiku") {
      db.update(ambientBudget)
        .set({
          haikuInputTokens: sql`${ambientBudget.haikuInputTokens} + ${inputTokens}`,
          haikuOutputTokens: sql`${ambientBudget.haikuOutputTokens} + ${outputTokens}`,
          haikuCalls: sql`${ambientBudget.haikuCalls} + 1`,
          totalCostCents: sql`${ambientBudget.totalCostCents} + ${cost}`,
          updatedAt: new Date(),
        })
        .where(and(
          eq(ambientBudget.projectId, this.projectId),
          eq(ambientBudget.date, today),
        ))
        .run()
      this.hourlyHaikuCalls++
    } else {
      db.update(ambientBudget)
        .set({
          sonnetInputTokens: sql`${ambientBudget.sonnetInputTokens} + ${inputTokens}`,
          sonnetOutputTokens: sql`${ambientBudget.sonnetOutputTokens} + ${outputTokens}`,
          sonnetCalls: sql`${ambientBudget.sonnetCalls} + 1`,
          totalCostCents: sql`${ambientBudget.totalCostCents} + ${cost}`,
          updatedAt: new Date(),
        })
        .where(and(
          eq(ambientBudget.projectId, this.projectId),
          eq(ambientBudget.date, today),
        ))
        .run()
      this.hourlySonnetCalls++
    }

    // Check if now over budget
    const status = this.getStatusSync()
    return status ? status.totalCostCents <= this.config.dailyLimitCents : true
  }

  /**
   * Get current budget status for display and decision-making.
   */
  getStatus(): BudgetStatus {
    const status = this.getStatusSync()
    if (!status) {
      return {
        date: getTodayDate(),
        haikuCalls: 0,
        sonnetCalls: 0,
        totalCostCents: 0,
        dailyLimitCents: this.config.dailyLimitCents,
        percentUsed: 0,
        isExhausted: false,
        tier: "normal",
      }
    }
    return status
  }

  /**
   * Determine the degradation tier based on budget remaining.
   */
  getDegradationTier(): BudgetStatus["tier"] {
    const status = this.getStatus()
    const pct = status.percentUsed
    if (pct >= 95) return "paused"
    if (pct >= 75) return "tier0-only"
    if (pct >= 50) return "conserving"
    return "normal"
  }

  private getStatusSync(): BudgetStatus | null {
    const db = getDatabase()
    const today = getTodayDate()

    const row = db.select()
      .from(ambientBudget)
      .where(and(
        eq(ambientBudget.projectId, this.projectId),
        eq(ambientBudget.date, today),
      ))
      .get()

    if (!row) return null

    const percentUsed = this.config.dailyLimitCents > 0
      ? Math.round((row.totalCostCents / this.config.dailyLimitCents) * 100)
      : 0

    return {
      date: today,
      haikuCalls: row.haikuCalls,
      sonnetCalls: row.sonnetCalls,
      totalCostCents: row.totalCostCents,
      dailyLimitCents: this.config.dailyLimitCents,
      percentUsed,
      isExhausted: row.totalCostCents >= this.config.dailyLimitCents,
      tier: this.computeTier(percentUsed),
    }
  }

  private computeTier(percentUsed: number): BudgetStatus["tier"] {
    if (percentUsed >= 95) return "paused"
    if (percentUsed >= 75) return "tier0-only"
    if (percentUsed >= 50) return "conserving"
    return "normal"
  }

  private ensureTodayRow(today: string): void {
    const db = getDatabase()
    const existing = db.select({ id: ambientBudget.id })
      .from(ambientBudget)
      .where(and(
        eq(ambientBudget.projectId, this.projectId),
        eq(ambientBudget.date, today),
      ))
      .get()

    if (!existing) {
      db.insert(ambientBudget)
        .values({
          projectId: this.projectId,
          date: today,
        })
        .run()
    }
  }

  private resetHourIfNeeded(): void {
    const hour = new Date().getHours()
    if (hour !== this.currentHour) {
      this.currentHour = hour
      this.hourlyHaikuCalls = 0
      this.hourlySonnetCalls = 0
    }
  }
}
