/**
 * Ambient analysis pipeline — coordinates the three-tier funnel.
 * Tier 0: Local heuristics (free, instant)
 * Tier 1: Haiku triage (cheap, batched)
 * Tier 2: Sonnet analysis (expensive, gated)
 */

import { exec } from "child_process"
import { promisify } from "util"

const execAsync = promisify(exec)
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
import { runChatHeuristics, clearSessionTrackers } from "./chat-heuristics"
import { buildSessionSummary, drainSessionEvents } from "./chat-bridge"
import type {
  AmbientConfig,
  AmbientEvent,
  ChatActivityEvent,
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
    if (this.chatBatchTimer) clearTimeout(this.chatBatchTimer)
    this.recentSuggestions.clear()
    this.chatEventBatch = []
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
    } else if (event.kind === "chat") {
      await this.processChatEvent(event.event)
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

    // Apply feedback weights to confidence (gradient between suppressed and boosted, clamped to 0-100)
    const weighted = unsuppressed.map(c => ({
      ...c,
      confidence: Math.min(100, Math.round(c.confidence * this.feedback.getCategoryWeight(c.category))),
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
        triggerEvent: "branch-switch",
      })
      return
    }

    if (event.type !== "commit") return

    // Only triage commits if we have a provider and budget allows
    if (!this.provider || this.budget.getDegradationTier() !== "normal") return

    // Get last commit info (async to avoid blocking main process)
    let commitInfo: string
    try {
      const { stdout } = await execAsync("git log -1 --stat --format=%B", {
        cwd: this.projectPath,
        timeout: 5000,
      })
      commitInfo = stdout.trim()
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
      triggerEvent: "commit",
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

  // ─── Chat event processing ─────────────────────────────────────────

  /** Batched non-urgent chat events waiting for Tier 1 triage */
  private chatEventBatch: ChatActivityEvent[] = []
  private chatBatchTimer: ReturnType<typeof setTimeout> | null = null
  private readonly CHAT_BATCH_WINDOW = 30_000 // 30s

  /**
   * Process a chat activity event from the chat bridge.
   * Runs chat-specific heuristics (free, instant) and batches
   * non-urgent events for Tier 1 triage.
   */
  private async processChatEvent(event: ChatActivityEvent): Promise<void> {
    // Session complete → post-session synthesis + cleanup
    if (event.activityType === "session-complete" || event.activityType === "session-error") {
      clearSessionTrackers(event.subChatId)

      // Post-session synthesis: use accumulated session data + memories
      if (event.activityType === "session-complete" && this.provider) {
        await this.runPostSessionSynthesis(event).catch(err => {
          console.warn("[Ambient] Post-session synthesis failed:", err.message)
        })
      }
      return
    }

    // Run chat-specific heuristics (Tier 0 — free, instant)
    const chatResults = runChatHeuristics(event)
    for (const result of chatResults) {
      // Deduplicate and persist
      if (!this.isRecentDuplicate(result)) {
        this.persistSuggestion(result)
      }
    }

    // Batch non-error events for periodic Tier 1 triage
    if (event.activityType !== "tool-error") {
      this.chatEventBatch.push(event)

      // Start batch timer if not already running
      if (!this.chatBatchTimer) {
        this.chatBatchTimer = setTimeout(() => {
          this.flushChatBatch().catch(err => {
            console.warn("[Ambient] Chat batch triage failed:", err.message)
          })
        }, this.CHAT_BATCH_WINDOW)
      }
    }
  }

  /**
   * Flush accumulated chat events through Tier 1 Haiku triage.
   */
  private async flushChatBatch(): Promise<void> {
    this.chatBatchTimer = null
    const batch = this.chatEventBatch
    this.chatEventBatch = []

    if (batch.length === 0 || !this.provider) return
    if (this.budget.getDegradationTier() !== "normal") return

    // Build a summary of the batch for triage
    const files = new Set<string>()
    const tools = new Set<string>()
    for (const e of batch) {
      if (e.filePaths) for (const f of e.filePaths) files.add(f)
      if (e.toolName) tools.add(e.toolName)
    }

    if (files.size === 0) return // Nothing concrete to analyze

    // Create a synthetic candidate for triage
    const candidate: HeuristicResult = {
      category: "bug",
      severity: "info",
      title: `Active work review: ${files.size} files, ${tools.size} tools`,
      description: `Recent activity involved ${[...files].slice(0, 5).join(", ")}${files.size > 5 ? ` (+${files.size - 5} more)` : ""} using ${[...tools].join(", ")}.`,
      confidence: 40,
      triggerFiles: [...files].slice(0, 10),
      triggerEvent: "chat-batch" as any,
    }

    // Triage with memory context
    let projectContext = ""
    try {
      const memoryResult = await getMemoriesForInjection(this.projectId, null, 1200)
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

  /**
   * Post-session synthesis: after a session completes, review what happened
   * in light of project memories and suggest follow-up actions.
   */
  private async runPostSessionSynthesis(event: ChatActivityEvent): Promise<void> {
    if (!this.provider) return
    if (this.budget.getDegradationTier() !== "normal") return

    const sessionSummary = buildSessionSummary(event.subChatId)
    if (!sessionSummary || sessionSummary.length < 50) return // Too short

    // Drain the session buffer
    drainSessionEvents(event.subChatId)

    // Get project memories for context
    let memoryContext = ""
    try {
      const memoryResult = await getMemoriesForInjection(this.projectId, null, 1500)
      memoryContext = memoryResult.markdown
    } catch { /* non-critical */ }

    const system = `You are a project-aware development assistant. Review the completed session activity and project knowledge below. Identify any follow-up tasks, risks, or patterns worth flagging.

Respond with a JSON array of suggestions (0-3 items max). Each item:
{"title": "short title", "description": "1-2 sentence explanation", "category": "bug"|"security"|"performance"|"test-gap"|"dead-code", "confidence": 50-90, "files": ["path1", "path2"]}

If nothing notable, respond with an empty array: []`

    const user = `## Session Activity
${sessionSummary}

## Project Knowledge
${memoryContext || "(no project memories yet)"}`

    try {
      const { text } = await this.provider.callHaiku(system, user)
      if (!text) return

      // Parse suggestions
      const jsonMatch = text.match(/\[[\s\S]*\]/)
      if (!jsonMatch) return

      const suggestions = JSON.parse(jsonMatch[0]) as Array<{
        title: string
        description: string
        category: string
        confidence: number
        files?: string[]
      }>

      if (!Array.isArray(suggestions)) return

      for (const s of suggestions.slice(0, 3)) {
        if (!s.title || !s.description) continue
        const result: HeuristicResult = {
          category: (s.category as any) ?? "bug",
          severity: s.confidence >= 70 ? "warning" : "info",
          title: s.title,
          description: s.description,
          confidence: Math.min(90, Math.max(30, s.confidence ?? 50)),
          triggerFiles: s.files ?? [],
          triggerEvent: "session-synthesis" as any,
        }
        if (!this.isRecentDuplicate(result)) {
          this.persistSuggestion(result, undefined, "haiku")
        }
      }
    } catch (err) {
      console.warn("[Ambient] Synthesis parse error:", err)
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

    // Generate ID upfront so we can include it in the event
    const { createId } = require("../db/utils")
    const suggestionId = createId()

    // Insert suggestion
    db.insert(ambientSuggestions)
      .values({
        id: suggestionId,
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
          suggestionId,
          suggestion: {
            id: suggestionId,
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
