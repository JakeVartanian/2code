/**
 * Ambient analysis pipeline — coordinates the three-tier funnel.
 * Tier 0: Local heuristics (free, instant)
 * Tier 1: Haiku triage (cheap, batched)
 * Tier 2: Sonnet analysis (expensive, gated)
 */

import { execSync } from "child_process"
import { eq, and, sql } from "drizzle-orm"
import { getDatabase } from "../db"
import { ambientSuggestions } from "../db/schema"
import { runHeuristics } from "./heuristics"
import { getHeuristicThreshold } from "./config"
import { triageWithHaiku } from "./triage"
import { analyzeWithSonnet } from "./analysis"
import { FeedbackTracker } from "./feedback"
import { BudgetTracker } from "./budget"
import { checkStaleness } from "./staleness"
import { getMemoriesForInjection } from "../memory/injection"
import type { AmbientProvider } from "./provider"
import type {
  AmbientConfig,
  AmbientEvent,
  FileBatch,
  HeuristicResult,
  SuggestionCategory,
} from "./types"

// Lazy import to avoid circular dependency
let ambientEvents: import("events").EventEmitter | null = null
function getAmbientEvents() {
  if (!ambientEvents) {
    ambientEvents = require("../trpc/routers/ambient").ambientEvents
  }
  return ambientEvents
}

const RECENT_CACHE_TTL = 24 * 60 * 60 * 1000 // 24 hours
const RECENT_CACHE_SWEEP_INTERVAL = 60 * 60 * 1000 // Sweep every hour
const COLD_START_DURATION = 15 * 60 * 1000 // 15 minutes observation mode
const SUGGESTION_EXPIRY_HOURS = 48 // Expire pending suggestions after 48h

export class AnalysisPipeline {
  private projectId: string
  private projectPath: string
  private config: AmbientConfig
  private budget: BudgetTracker
  feedback: FeedbackTracker // Public so tRPC router can delegate to it
  private provider: AmbientProvider | null = null
  private onSuggestion: ((suggestion: PipelineSuggestion) => void) | null = null
  // Per-instance dedup cache (scoped to this project)
  private recentSuggestions: Map<string, number> = new Map() // key → expiry timestamp
  private sweepTimer: ReturnType<typeof setInterval> | null = null
  // Processing lock to prevent concurrent triage calls
  private isProcessing = false
  private pendingBatch: FileBatch | null = null
  // Cold start: timestamp when pipeline was created
  private createdAt = Date.now()

  constructor(
    projectId: string,
    projectPath: string,
    config: AmbientConfig,
    budget: BudgetTracker,
  ) {
    this.projectId = projectId
    this.projectPath = projectPath
    this.config = config
    this.budget = budget
    this.feedback = new FeedbackTracker(projectId)
    this.feedback.loadWeights()
    // Periodic sweep of expired dedup entries (instead of thousands of setTimeouts)
    this.sweepTimer = setInterval(() => this.sweepRecentCache(), RECENT_CACHE_SWEEP_INTERVAL)
  }

  dispose(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer)
    this.recentSuggestions.clear()
  }

  /**
   * Set the AI provider for Tier 1/2 calls. Can be null (Tier 0 only).
   */
  setProvider(provider: AmbientProvider | null): void {
    this.provider = provider
  }

  updateConfig(config: AmbientConfig): void {
    this.config = config
  }

  /**
   * Set callback for when a suggestion is ready to be persisted/emitted.
   */
  setSuggestionHandler(handler: (suggestion: PipelineSuggestion) => void): void {
    this.onSuggestion = handler
  }

  /**
   * Process an ambient event through the tiered funnel.
   * Uses a lock to prevent concurrent triage calls (avoids double-budget-spend).
   */
  async processEvent(event: AmbientEvent): Promise<void> {
    if (event.kind === "file-batch") {
      if (this.isProcessing) {
        // Queue the latest batch; only keep one pending (latest wins)
        this.pendingBatch = event.batch
        return
      }
      this.isProcessing = true
      try {
        await this.processFileBatch(event.batch)
        // Process any queued batch that arrived while we were busy
        while (this.pendingBatch) {
          const next = this.pendingBatch
          this.pendingBatch = null
          await this.processFileBatch(next)
        }
      } finally {
        this.isProcessing = false
      }
    } else if (event.kind === "git") {
      await this.processGitEvent(event.event)
    }
  }

  private async processFileBatch(batch: FileBatch): Promise<void> {
    // --- STALENESS CHECK: invalidate memories for changed files (free) ---
    const changedPaths = batch.files.map(f => f.path)
    try {
      checkStaleness(this.projectId, this.projectPath, changedPaths)
    } catch { /* non-critical */ }

    // --- EXPIRE old pending suggestions (periodic, free) ---
    this.expireOldSuggestions()

    // --- COLD START: only surface high-confidence findings in first 4 hours ---
    const isColdStart = (Date.now() - this.createdAt) < COLD_START_DURATION

    // --- TIER 0: Local heuristics (free) ---
    const threshold = getHeuristicThreshold(this.config.sensitivity)
    const candidates = runHeuristics(batch, threshold)

    if (candidates.length === 0) return

    // Filter by enabled categories
    const filtered = candidates.filter(c =>
      this.config.enabledCategories.includes(c.category)
    )

    if (filtered.length === 0) return

    // Filter by category feedback weights (suppressed categories excluded)
    const unsuppressed = this.feedback.filterBySuppression(filtered)

    if (unsuppressed.length === 0) return

    // Apply feedback weights to confidence (gradient between suppressed and boosted)
    const weighted = unsuppressed.map(c => ({
      ...c,
      confidence: Math.round(c.confidence * this.feedback.getCategoryWeight(c.category)),
    }))

    // Deduplicate against recent suggestions
    const novel = weighted.filter(c => !this.isRecentDuplicate(c))

    if (novel.length === 0) return

    // --- COLD START MODE: first 4 hours, only surface very high-confidence items ---
    if (isColdStart) {
      const veryHighConfidence = novel.filter(c => c.confidence >= 70)
      for (const result of veryHighConfidence) {
        this.persistSuggestion(result)
      }
      return // Skip API triage during cold start
    }

    // --- TIER 1: Haiku triage ---
    if (this.provider && this.budget.getDegradationTier() === "normal") {
      // Inject project memory context for smarter triage (lightweight 800-token budget)
      let projectContext = ""
      try {
        const memoryResult = await getMemoriesForInjection(this.projectId, null, 800)
        projectContext = memoryResult.markdown
      } catch { /* non-critical — triage without context */ }
      const triageResult = await triageWithHaiku(
        novel,
        this.provider,
        this.budget,
        projectContext,
        this.config.triageThreshold,
      )

      // --- TIER 2: Sonnet analysis for high-urgency items ---
      for (const item of triageResult.items) {
        const candidate = novel[item.index]
        if (!candidate) continue

        if (item.urgency === "high" && this.provider.info.supportsSonnet) {
          // High urgency → Sonnet deep analysis for richer suggestion
          const analysis = await analyzeWithSonnet(
            candidate,
            this.provider,
            this.budget,
            this.projectPath,
            projectContext,
          )

          if (analysis) {
            this.persistSuggestion({
              ...candidate,
              title: analysis.title,
              description: analysis.description,
              category: analysis.category,
              severity: analysis.severity,
              confidence: analysis.confidence,
            }, analysis.suggestedPrompt, "sonnet")

            // Write to memory if high confidence + config allows
            if (analysis.confidence >= 80 && this.config.autoMemoryWrite) {
              this.writeToMemory(analysis)
            }
          } else {
            // Sonnet failed (budget, error, low confidence) → fallback to heuristic data
            this.persistSuggestion({
              ...candidate,
              category: item.category,
              confidence: Math.round(item.relevance * 100),
            })
          }
        } else {
          // Medium/low urgency → persist with Haiku's assessment directly
          this.persistSuggestion({
            ...candidate,
            category: item.category,
            confidence: Math.round(item.relevance * 100),
          })
        }
      }
    } else {
      // No provider or budget conserving → use heuristic confidence directly
      // Only persist high-confidence items (>= 60)
      const highConfidence = novel.filter(c => c.confidence >= 60)
      for (const result of highConfidence) {
        this.persistSuggestion(result)
      }
    }
  }

  /**
   * Process git events — commits get triaged, merge conflicts surface immediately.
   */
  private async processGitEvent(event: import("./types").GitEvent): Promise<void> {
    if (event.type === "merge-conflict") {
      // Merge conflicts are always high-confidence, surface immediately
      this.persistSuggestion({
        category: "bug",
        severity: "error",
        title: "Merge conflict detected",
        description: `A merge conflict was detected. Resolve conflicts before continuing work.`,
        confidence: 90,
        triggerFiles: [],
        triggerEvent: "git",
      })
      return
    }

    if (event.type !== "commit") return

    // Only triage commits if we have a provider and budget allows
    if (!this.provider || this.budget.getDegradationTier() !== "normal") return

    // Get last commit info
    let commitInfo: string
    try {
      commitInfo = execSync("git log -1 --stat --format=%B", {
        cwd: this.projectPath,
        timeout: 5000,
        encoding: "utf-8",
      }).trim()
    } catch { return }

    // Skip trivial commits (< 3 files changed)
    const statLines = commitInfo.split("\n").filter(l => l.match(/\|/))
    if (statLines.length < 3) return

    // Create a synthetic candidate and triage it
    const candidate: HeuristicResult = {
      category: "bug",
      severity: "warning",
      title: `Commit review: ${commitInfo.split("\n")[0]?.slice(0, 60) ?? "recent commit"}`,
      description: commitInfo.slice(0, 500),
      confidence: 50,
      triggerFiles: statLines.map(l => l.split("|")[0]?.trim()).filter(Boolean),
      triggerEvent: "git",
    }

    // Load memory context for better triage
    let projectContext = ""
    try {
      const memoryResult = await getMemoriesForInjection(this.projectId, null, 800)
      projectContext = memoryResult.markdown
    } catch { /* non-critical */ }

    const triageResult = await triageWithHaiku(
      [candidate],
      this.provider,
      this.budget,
      projectContext,
      this.config.triageThreshold,
    )

    for (const item of triageResult.items) {
      if (item.relevance >= 0.5) {
        this.persistSuggestion({
          ...candidate,
          category: item.category,
          confidence: Math.round(item.relevance * 100),
        }, undefined, "haiku")
      }
    }
  }

  private persistSuggestion(
    result: HeuristicResult,
    suggestedPrompt?: string,
    model?: string,
  ): void {
    const db = getDatabase()
    const key = this.suggestionKey(result)

    // Mark as recent (expiry timestamp instead of setTimeout)
    this.recentSuggestions.set(key, Date.now() + RECENT_CACHE_TTL)

    // Check max pending suggestions (cap at 10 per project)
    const pendingCount = db.select({ id: ambientSuggestions.id })
      .from(ambientSuggestions)
      .where(and(
        eq(ambientSuggestions.projectId, this.projectId),
        eq(ambientSuggestions.status, "pending"),
      ))
      .all().length

    if (pendingCount >= 10) return // Don't flood

    // Insert suggestion
    db.insert(ambientSuggestions)
      .values({
        projectId: this.projectId,
        category: result.category,
        severity: result.severity,
        title: result.title,
        description: result.description,
        triggerEvent: result.triggerEvent,
        triggerFiles: JSON.stringify(result.triggerFiles),
        analysisModel: model ?? "heuristic",
        confidence: result.confidence,
        suggestedPrompt: suggestedPrompt ?? this.buildSuggestedPrompt(result),
      })
      .run()

    // Emit via tRPC subscription for real-time UI updates
    try {
      const events = getAmbientEvents()
      if (events) {
        events.emit(`project:${this.projectId}`, {
          type: "new-suggestion",
          suggestion: {
            category: result.category,
            severity: result.severity,
            title: result.title,
            confidence: result.confidence,
          },
        })
      }
    } catch { /* non-critical */ }

    // Notify local listeners
    if (this.onSuggestion) {
      this.onSuggestion({
        category: result.category,
        severity: result.severity,
        title: result.title,
        description: result.description,
        confidence: result.confidence,
        triggerFiles: result.triggerFiles,
      })
    }
  }

  private isRecentDuplicate(result: HeuristicResult): boolean {
    const key = this.suggestionKey(result)
    const expiry = this.recentSuggestions.get(key)
    if (!expiry) return false
    if (Date.now() > expiry) {
      this.recentSuggestions.delete(key)
      return false
    }
    return true
  }

  private sweepRecentCache(): void {
    const now = Date.now()
    for (const [key, expiry] of this.recentSuggestions) {
      if (now > expiry) this.recentSuggestions.delete(key)
    }
  }

  /**
   * Expire pending suggestions older than 48 hours.
   * Runs periodically during pipeline processing (not on a timer).
   */
  private lastExpirySweep = 0
  private expireOldSuggestions(): void {
    const now = Date.now()
    // Only sweep once per hour
    if (now - this.lastExpirySweep < 60 * 60 * 1000) return
    this.lastExpirySweep = now

    try {
      const db = getDatabase()
      const expiryThreshold = new Date(now - SUGGESTION_EXPIRY_HOURS * 60 * 60 * 1000)

      // Mark old pending suggestions as expired
      db.update(ambientSuggestions)
        .set({ status: "expired" })
        .where(and(
          eq(ambientSuggestions.projectId, this.projectId),
          eq(ambientSuggestions.status, "pending"),
          sql`${ambientSuggestions.createdAt} < ${expiryThreshold.getTime()}`,
        ))
        .run()
    } catch { /* non-critical */ }
  }

  /**
   * Write high-confidence analysis results to the project memory system.
   * Maps ambient categories to memory categories.
   */
  private writeToMemory(analysis: import("./types").AnalysisResult): void {
    try {
      const db = getDatabase()
      const { projectMemories } = require("../db/schema")
      const { createId } = require("../db/utils")

      // Map ambient category → memory category
      const memoryCategory =
        analysis.category === "bug" || analysis.category === "security" ? "gotcha"
        : analysis.category === "performance" ? "debugging"
        : "convention"

      // Check for duplicate by title similarity
      const existing = db.select()
        .from(projectMemories)
        .where(and(
          eq(projectMemories.projectId, this.projectId),
          eq(projectMemories.title, analysis.title),
        ))
        .get()

      if (existing) return // Already have this memory

      db.insert(projectMemories)
        .values({
          id: createId(),
          projectId: this.projectId,
          category: memoryCategory,
          title: analysis.title,
          content: analysis.description,
          source: "auto",
          linkedFiles: JSON.stringify(analysis.triggerFiles),
          relevanceScore: analysis.confidence,
        })
        .run()

      console.log(`[Ambient] Memory written: ${analysis.title}`)
    } catch (err) {
      // Non-critical — don't fail the pipeline
      console.warn("[Ambient] Failed to write memory:", err)
    }
  }

  private suggestionKey(result: HeuristicResult): string {
    return `${result.title}:${result.triggerFiles.sort().join(",")}`
  }

  private buildSuggestedPrompt(result: HeuristicResult): string {
    const files = result.triggerFiles.join(", ")
    return `${result.description}\n\nAffected files: ${files}\n\nPlease investigate and fix this issue.`
  }
}

export interface PipelineSuggestion {
  category: SuggestionCategory
  severity: "info" | "warning" | "error"
  title: string
  description: string
  confidence: number
  triggerFiles: string[]
}
