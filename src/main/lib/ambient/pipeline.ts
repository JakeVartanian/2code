/**
 * Ambient analysis pipeline — coordinates the three-tier funnel.
 * Tier 0: Local heuristics (free, instant)
 * Tier 1: Haiku triage (cheap, batched)
 * Tier 2: Sonnet analysis (expensive, gated)
 */

import { exec } from "child_process"
import { promisify } from "util"
import { readFileSync, existsSync } from "fs"
import { join } from "path"

const execAsync = promisify(exec)
import { eq, and, sql } from "drizzle-orm"
import { getDatabase } from "../db"
import { ambientSuggestions, projectMemories, auditFindings, projects, maintenanceActions } from "../db/schema"
import { createId } from "../db/utils"
import type { SystemZone } from "../../../shared/system-map-types"
import { runHeuristics, checkDocDrift } from "./heuristics"
import { getHeuristicThreshold } from "./config"
import { triageWithHaiku } from "./triage"
import { analyzeWithSonnet, verifySuggestion } from "./analysis"
import { FeedbackTracker } from "./feedback"
import { BudgetTracker } from "./budget"
import { checkStaleness } from "./staleness"
import { DependencyIndex } from "./dependency-index"
import { SessionPatternTracker } from "./session-patterns"
import { getMemoriesForInjection } from "../memory/injection"
import { checkReactivation, recordSessionFeedback } from "./memory-cycling"
import { checkMapFreshness } from "./map-freshness"
import type { AmbientProvider } from "./provider"
import { runChatHeuristics, clearSessionTrackers } from "./chat-heuristics"
import { buildSessionSummary, drainSessionEvents, getSessionEvents } from "./chat-bridge"
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

const RECENT_CACHE_TTL = 45 * 60 * 1000 // 45 min — keeps suggestions fresh without over-deduping
const RECENT_CACHE_SWEEP_INTERVAL = 60 * 60 * 1000 // Sweep every hour
const SUGGESTION_EXPIRY_HOURS = 48 // Expire pending suggestions after 48h
const MAX_PENDING_SUGGESTIONS = 12 // Let GAAD queue more — better context means higher quality suggestions

export class AnalysisPipeline {
  private projectId: string
  private projectPath: string
  private config: AmbientConfig
  private budget: BudgetTracker
  feedback: FeedbackTracker // Public so tRPC router can delegate to it
  private provider: AmbientProvider | null = null
  private onSuggestion: ((suggestion: PipelineSuggestion) => void) | null = null
  // Per-instance dedup cache (scoped to this project)
  private recentSuggestions: Map<string, { expiry: number, fileHash: string }> = new Map()
  private sweepTimer: ReturnType<typeof setInterval> | null = null
  // Processing lock to prevent concurrent triage calls
  private isProcessing = false
  private pendingBatch: FileBatch | null = null
  // Abort controller for graceful dispose — signals all in-flight async work
  private disposeController = new AbortController()
  // Synthesis concurrency guard — only one synthesis at a time
  private synthesisBusy = false
  // Debounce for direct file analysis — prevents rapid-save spam (G4 guardrail)
  private lastDirectAnalysisAt = 0
  private readonly DIRECT_ANALYSIS_COOLDOWN = 8_000 // 8s between direct analysis calls
  // Memory context cache — avoids redundant getMemoriesForInjection calls during rapid file saves (O1)
  private _memoryContextCache: { markdown: string, fetchedAt: number } | null = null
  private readonly MEMORY_CACHE_TTL = 120_000 // 2 minutes
  // Dependency index for cross-file context
  private depIndex: DependencyIndex
  // Session pattern tracker for cross-session churn detection
  private sessionPatterns: SessionPatternTracker

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
    this.depIndex = new DependencyIndex(projectPath)
    this.sessionPatterns = new SessionPatternTracker()
    // Periodic sweep of expired dedup entries (instead of thousands of setTimeouts)
    this.sweepTimer = setInterval(() => this.sweepRecentCache(), RECENT_CACHE_SWEEP_INTERVAL)
  }

  dispose(): void {
    this.disposeController.abort() // Signal all in-flight async work to bail
    if (this.sweepTimer) clearInterval(this.sweepTimer)
    if (this.chatBatchTimer) clearTimeout(this.chatBatchTimer)
    this.recentSuggestions.clear()
    this.chatEventBatch = []
    this.promptCounter.clear()
    this._memoryContextCache = null
    // Finalize today's GAAD run so it shows as completed in the dashboard
    if (this._gaadRunId) {
      try { this.finalizeGaadRun(this._gaadRunId) } catch { /* best-effort */ }
    }
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

    // --- MAP FRESHNESS: detect zone drift from changed files (free) ---
    try {
      const db = getDatabase()
      const project = db.select({ systemMap: projects.systemMap })
        .from(projects)
        .where(eq(projects.id, this.projectId))
        .get()
      if (project?.systemMap) {
        const zones = JSON.parse(project.systemMap) as import("../../../shared/system-map-types").SystemZone[]
        const freshnessResults = checkMapFreshness(this.projectId, this.projectPath, changedPaths, zones)
        for (const result of freshnessResults) {
          this.createMaintenanceAction("refresh-system-map", result.title, result.description, result.details)
        }
      }
    } catch { /* non-critical */ }

    // --- AUTO-RESOLVE: check if changed files fixed open audit findings (free) ---
    try {
      this.resolveFixedFindings(changedPaths)
    } catch { /* non-critical */ }

    // --- DOC DRIFT: check if CLAUDE.md/README reference stale paths (free) ---
    try {
      const driftResults = checkDocDrift(changedPaths, this.projectPath)
      for (const drift of driftResults) {
        this.createMaintenanceAction(
          "refresh-docs",
          `${drift.file} references may be outdated`,
          `${drift.staleReferences.length} file path${drift.staleReferences.length > 1 ? "s" : ""} no longer exist: ${drift.staleReferences.slice(0, 3).join(", ")}`,
          { file: drift.file, staleReferences: drift.staleReferences },
        )
      }
    } catch { /* non-critical */ }

    // --- DEPENDENCY INDEX: re-index changed files (free, incremental) ---
    try {
      this.depIndex.reindexFiles(changedPaths)
    } catch { /* non-critical */ }

    // --- INVALIDATE pending suggestions whose trigger files changed ---
    this.invalidateStalePendingSuggestions(changedPaths)

    // --- EXPIRE old pending suggestions (periodic, free) ---
    this.expireOldSuggestions()

    // --- TIER 0: Local heuristics (free) ---
    const threshold = getHeuristicThreshold(this.config.sensitivity)
    const candidates = runHeuristics(batch, threshold)

    if (candidates.length === 0) {
      // No heuristic matches — try direct AI analysis of the changes
      await this.analyzeFileChangesDirectly(batch)
      return
    }

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

    // --- TIER 1: Haiku triage ---
    const budgetTier = this.budget.getDegradationTier()
    if (this.provider && (budgetTier === "normal" || budgetTier === "conserving")) {
      // Inject project memory + zone context for smarter triage (cached, lightweight 800-token budget)
      const projectContext = await this.getCachedMemoryContext(800)
      const zoneCtx = this.getZoneContext(changedPaths)
      const fullTriageContext = [projectContext, zoneCtx].filter(Boolean).join("\n\n")
      const triageResult = await triageWithHaiku(
        novel,
        this.provider,
        this.budget,
        fullTriageContext,
        this.config.triageThreshold,
      )

      // --- TIER 2: Sonnet analysis for high-urgency items (normal budget only) ---
      for (const item of triageResult.items) {
        const candidate = novel[item.index]
        if (!candidate) continue

        const shouldEscalateToSonnet = this.provider.info.supportsSonnet && budgetTier === "normal" && (
          item.urgency === "high" ||
          (item.urgency === "medium" && this.budget.getStatus().percentUsed < 25)
        )
        if (shouldEscalateToSonnet) {
          // High urgency (or medium with budget headroom) → Sonnet deep analysis
          const analysis = await analyzeWithSonnet(
            candidate,
            this.provider,
            this.budget,
            this.projectPath,
            fullTriageContext,
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

            // Analysis findings are suggestions (bugs, issues, observations) — NOT memories.
            // Memories are distilled by the extraction system from completed sessions.
            // Writing analysis titles directly to memory produced low-quality entries like
            // "Deck text appears unreadably small" — bug reports, not reusable principles.
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
      // Only persist high-confidence items (>= 75)
      const highConfidence = novel.filter(c => c.confidence >= 75)
      for (const result of highConfidence) {
        this.persistSuggestion(result)
      }
    }
  }

  /**
   * Direct AI analysis of file changes — bypasses the heuristic gate.
   * When no heuristic rules match (which is most of the time), this sends
   * the actual git diff to Haiku for intelligent assessment.
   */
  private async analyzeFileChangesDirectly(batch: FileBatch): Promise<void> {
    if (!this.provider) {
      console.log("[GAAD] Direct analysis skipped: no AI provider — check provider initialization")
      return
    }
    if (this.budget.getDegradationTier() !== "normal") {
      console.log(`[GAAD] Direct analysis skipped: budget tier is "${this.budget.getDegradationTier()}"`)
      return
    }
    if (this.disposeController.signal.aborted) return

    // Debounce: skip if last direct analysis was < 30s ago (prevents rapid-save spam)
    const now = Date.now()
    if (now - this.lastDirectAnalysisAt < this.DIRECT_ANALYSIS_COOLDOWN) return
    this.lastDirectAnalysisAt = now

    const filePaths = batch.files.map(f => f.path)
    if (filePaths.length === 0) return

    // Budget check before calling
    if (!this.budget.canSpend("haiku", 800, 400)) return

    // Get per-file diffs for better context (up to 6 files, 2000 chars each)
    let diffContent = ""
    try {
      for (const f of filePaths.slice(0, 6)) {
        const { stdout } = await execAsync(
          `git diff --no-color -U3 -- "${f}"`,
          { cwd: this.projectPath, timeout: 3000, maxBuffer: 20_000 },
        )
        if (stdout) diffContent += stdout.slice(0, 2000) + "\n"
      }
    } catch { /* non-critical */ }
    // Fallback to global diff if per-file failed
    if (!diffContent) {
      try {
        const { stdout } = await execAsync(
          "git diff --no-color -U2",
          { cwd: this.projectPath, timeout: 5000, maxBuffer: 50_000 },
        )
        diffContent = stdout.slice(0, 6000)
      } catch { /* non-critical */ }
    }

    // For new/untracked files, list them (AI can flag suspicious additions)
    const newFiles = batch.files.filter(f => f.type === "add")
    if (newFiles.length > 0) {
      diffContent += "\n\nNew untracked files:\n" + newFiles.map(f => `- ${f.path}`).join("\n")
    }

    if (!diffContent || diffContent.length < 30) return

    // Inject project memory context (cached to avoid redundant fetches)
    const projectContext = await this.getCachedMemoryContext(800)

    // Inject zone context for architectural framing (free)
    const zoneContext = this.getZoneContext(filePaths)

    // Inject dependency context for cross-file awareness (free)
    const depContext = this.depIndex.buildContext(filePaths, diffContent)

    const system = `You are GAAD — a code reviewer who spots non-obvious connections across files.

WHAT TO FIND (priority order):
1. CROSS-FILE IMPACT: A changed export/interface that consumers still depend on. Name both files.
2. STATE GAPS: A mutation in file A that file B assumes won't happen. Trace the data flow.
3. MISSING PROPAGATION: An error/null return that callers don't handle.
4. ARCHITECTURAL COUPLING: Two zones that should change together but only one did.
5. CONCRETE BUGS: Null derefs, off-by-one, wrong comparator — with exact line evidence.

You have import/consumer context and zone architecture below — use them.

QUALITY BAR:
- Every finding must cite specific code (function name, variable, file path).
- Only reference code VISIBLE in the diff or dependency context. Don't guess beyond truncation.
- If the project memory documents a known limitation, don't resurface it.
- No linting. No style. No generic advice ("add tests", "consider logging").
- Title: factual statement, under 55 chars, no backticks.
- Description: 1-2 sentences. What's wrong and why it matters.
- suggestedPrompt: The CONCRETE FIX as a direct instruction: "In file X, function Y, change Z to W because..." NEVER say "check", "verify", "investigate", or "if X then Y". If you can't state the fix, return [].

Respond with JSON array (0-2 items, usually 0). Return [] if nothing is genuinely broken or risky.
{"title":"...","description":"...","category":"bug|security|risk|blind-spot|performance|next-step","confidence":65-95,"files":["path"],"suggestedPrompt":"exact fix instruction"}`

    const user = `${projectContext ? `Project context:\n${projectContext}\n\n` : ""}${zoneContext ? `Architecture:\n${zoneContext}\n\n` : ""}${depContext ? `Dependencies:\n${depContext}\n\n` : ""}Changed files: ${filePaths.join(", ")}\n\nDiff:\n${diffContent}`

    try {
      const result = await this.provider.callHaiku(system, user)
      this.budget.recordSpend("haiku", result.inputTokens, result.outputTokens)

      if (!result.text || this.disposeController.signal.aborted) return

      const jsonMatch = result.text.match(/\[[\s\S]*\]/)
      if (!jsonMatch) return

      const suggestions = JSON.parse(jsonMatch[0]) as Array<{
        title: string
        description: string
        category: string
        confidence: number
        files?: string[]
        suggestedPrompt?: string
      }>

      if (!Array.isArray(suggestions)) return

      for (const s of suggestions.slice(0, 2)) {
        if (!s.title || !s.description || (s.confidence ?? 0) < 55) continue

        const hResult: HeuristicResult = {
          category: (s.category as SuggestionCategory) ?? "blind-spot",
          severity: (s.confidence ?? 70) >= 80 ? "warning" : "info",
          title: s.title,
          description: s.description,
          confidence: Math.min(95, Math.max(60, s.confidence ?? 70)),
          triggerFiles: s.files ?? filePaths.slice(0, 5),
          triggerEvent: "file-change",
        }

        if (!this.isRecentDuplicate(hResult)) {
          // Verify the suggestion references real code before persisting
          const verification = verifySuggestion(
            { triggerFiles: hResult.triggerFiles, title: hResult.title, suggestedPrompt: s.suggestedPrompt ?? "" },
            this.projectPath,
          )
          if (!verification.valid) {
            console.log(`[GAAD] Direct analysis rejected "${hResult.title}": ${verification.reason}`)
            continue
          }
          this.persistSuggestion(hResult, s.suggestedPrompt, "haiku")
        }
      }
    } catch (err) {
      console.warn("[GAAD] Direct file analysis failed:", err)
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

    // Track commit for narrative system (fire-and-forget, non-critical)
    try {
      const { recordCommit } = require("./narrative")
      recordCommit(this.projectId, this.projectPath)
    } catch { /* narrative module not critical */ }

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

    const statLines = commitInfo.split("\n").filter(l => l.match(/\|/))

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

    // Load memory context for better triage (cached)
    const projectContext = await this.getCachedMemoryContext(800)

    const triageResult = await triageWithHaiku(
      [candidate],
      this.provider,
      this.budget,
      projectContext,
      this.config.triageThreshold,
    )

    for (const item of triageResult.items) {
      // Commit candidates need high relevance AND Sonnet analysis to produce
      // useful suggestions. Raw commit info ("3 files changed") isn't actionable.
      if (item.relevance >= 0.65 && this.provider?.info.supportsSonnet) {
        const analysis = await analyzeWithSonnet(
          { ...candidate, category: item.category, confidence: Math.round(item.relevance * 100) },
          this.provider,
          this.budget,
          this.projectPath,
          projectContext,
        )
        if (analysis && analysis.confidence >= 50) {
          this.persistSuggestion({
            ...candidate,
            title: analysis.title,
            description: analysis.description,
            category: analysis.category as SuggestionCategory,
            severity: analysis.severity,
            confidence: analysis.confidence,
          }, analysis.suggestedPrompt, "sonnet")
        }
      }
    }
  }

  // ─── Chat event processing ─────────────────────────────────────────

  /** Batched non-urgent chat events waiting for Tier 1 triage */
  private chatEventBatch: ChatActivityEvent[] = []
  private chatBatchTimer: ReturnType<typeof setTimeout> | null = null
  private readonly CHAT_BATCH_WINDOW = 60_000 // 60s

  /** Rolling prompt counter per sub-chat for continuous synthesis */
  private promptCounter = new Map<string, number>() // subChatId → count since last synthesis
  private readonly SYNTHESIS_PROMPT_INTERVAL = 3 // Synthesize every N user prompts — balanced between responsiveness and token spend
  private lastSynthesisAt = 0
  private readonly SYNTHESIS_COOLDOWN = 45_000 // 45s between syntheses — responsive but not spammy

  /**
   * Process a chat activity event from the chat bridge.
   * Runs chat-specific heuristics (free, instant), batches events
   * for Tier 1 triage, and triggers rolling synthesis every few prompts.
   */
  private async processChatEvent(event: ChatActivityEvent): Promise<void> {
    // Session complete → always cleanup, then optionally synthesize
    if (event.activityType === "session-complete" || event.activityType === "session-error") {
      clearSessionTrackers(event.subChatId)
      this.promptCounter.delete(event.subChatId)

      // Run final synthesis on session-complete for any remaining context
      if (event.activityType === "session-complete" && this.provider) {
        await this.runPostSessionSynthesis(event).catch(err => {
          console.warn("[GAAD] Synthesis failed:", err.message)
        })
      }

      // Post-session maintenance sweep — ties all free checks together
      if (event.activityType === "session-complete" && event.sessionMeta) {
        await this.runPostSessionMaintenance(event.sessionMeta).catch(err => {
          console.warn("[GAAD] Post-session maintenance failed:", err.message)
        })
      }

      // Always drain session events (prevents Map leak even if synthesis was skipped)
      drainSessionEvents(event.subChatId)
      return
    }

    // Track user prompts for rolling synthesis trigger
    if (event.activityType === "user-prompt") {
      const count = (this.promptCounter.get(event.subChatId) ?? 0) + 1
      this.promptCounter.set(event.subChatId, count)

      // Trigger synthesis every N prompts (with cooldown to prevent spam)
      if (count >= this.SYNTHESIS_PROMPT_INTERVAL && this.provider) {
        const now = Date.now()
        if (now - this.lastSynthesisAt >= this.SYNTHESIS_COOLDOWN) {
          this.promptCounter.set(event.subChatId, 0) // Reset counter
          this.lastSynthesisAt = now
          // Fire-and-forget — don't block the chat event processing
          this.runPostSessionSynthesis(event).catch(err => {
            console.warn("[GAAD] Rolling synthesis failed:", err.message)
          })
        }
      }
    }

    // Run chat-specific heuristics (Tier 0 — free, instant)
    const chatResults = runChatHeuristics(event)
    for (const result of chatResults) {
      // Skip memory-conflict reminders — these are internal context, not actionable suggestions
      if (result.triggerEvent === "memory-conflict") continue
      // Require minimum confidence of 65 for chat heuristics (lets memory conflicts and error loops through)
      if (result.confidence < 65) continue
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
            console.warn("[GAAD] Chat batch triage failed:", err.message)
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
      triggerEvent: "chat-batch",
    }

    // Triage with memory context (cached)
    const projectContext = await this.getCachedMemoryContext(1200)

    const triageResult = await triageWithHaiku(
      [candidate],
      this.provider,
      this.budget,
      projectContext,
      this.config.triageThreshold,
    )

    for (const item of triageResult.items) {
      // Chat-batch candidates need HIGH triage relevance (≥0.75) because they're
      // synthetic — the raw description is just file paths with no insight.
      // If Haiku thinks it's genuinely interesting, promote to Sonnet for real analysis.
      if (item.relevance >= 0.75 && this.provider?.info.supportsSonnet) {
        const analysis = await analyzeWithSonnet(
          { ...candidate, category: item.category, confidence: Math.round(item.relevance * 100) },
          this.provider,
          this.budget,
          this.projectPath,
          projectContext,
        )
        if (analysis && analysis.confidence >= 50) {
          this.persistSuggestion({
            ...candidate,
            title: analysis.title,
            description: analysis.description,
            category: analysis.category as SuggestionCategory,
            severity: analysis.severity,
            confidence: analysis.confidence,
          }, analysis.suggestedPrompt, "sonnet")
        }
      }
      // Otherwise: skip — raw file-path suggestions are useless noise
    }
  }

  /**
   * Post-session synthesis: after a session completes, review what happened
   * in light of project memories and suggest follow-up actions.
   */
  private async runPostSessionSynthesis(event: ChatActivityEvent): Promise<void> {
    if (!this.provider) return
    if (this.budget.getDegradationTier() !== "normal") return
    if (this.synthesisBusy) return // One synthesis at a time
    if (this.disposeController.signal.aborted) return

    this.synthesisBusy = true
    try {
      await this._runPostSessionSynthesisInner(event)
    } finally {
      this.synthesisBusy = false
    }
  }

  private async _runPostSessionSynthesisInner(event: ChatActivityEvent): Promise<void> {
    if (!this.provider) { console.log("[GAAD] Synthesis skipped: no provider"); return }
    if (this.disposeController.signal.aborted) return

    const sessionSummary = buildSessionSummary(event.subChatId)
    if (!sessionSummary || sessionSummary.length < 50) {
      console.log(`[GAAD] Synthesis skipped: summary too short (${sessionSummary?.length ?? 0} chars)`)
      return
    }

    // Get project memories relevant to what they're working on right now
    // Use full 5000-token budget for session-complete (final analysis), reduced 2500 for rolling synthesis
    const memoryTokenBudget = event.activityType === "session-complete" ? 5000 : 2500
    let memoryContext = ""
    try {
      // Pass session summary as context hint so memory scoring boosts relevant memories
      const memoryResult = await getMemoriesForInjection(this.projectId, sessionSummary, memoryTokenBudget)
      memoryContext = memoryResult.markdown
    } catch { /* non-critical */ }

    // Determine session type for dynamic prompt adaptation
    // For session-complete events: use sessionMeta (has full stats)
    // For rolling synthesis (user-prompt events): use accumulated events from chat bridge
    const meta = event.sessionMeta
    let hasErrors: boolean
    let hasModifications: boolean
    let isExploring: boolean
    let isBroadChange: boolean
    let isQuick: boolean

    if (event.activityType === "session-complete" && meta) {
      // Session-complete path: rich metadata available
      hasErrors = (meta.errorCount ?? 0) > 0
      hasModifications = (meta.filesModified?.length ?? 0) > 0
      isExploring = (meta.filesRead?.length ?? 0) > (meta.filesModified?.length ?? 0) * 2
      isBroadChange = (meta.filesModified?.length ?? 0) >= 5
      isQuick = (meta.toolCallCount ?? 0) < 3
    } else {
      // Rolling synthesis path: derive from accumulated events
      const accumulated = getSessionEvents(event.subChatId)
      const toolCalls = accumulated.filter(e => e.activityType === "tool-call")
      const errors = accumulated.filter(e => e.activityType === "tool-error")
      const editTools = ["Edit", "Write", "file_edit", "file_write"]
      const edits = toolCalls.filter(e => e.toolName && editTools.includes(e.toolName))
      const reads = toolCalls.filter(e => e.toolName && !editTools.includes(e.toolName))

      hasErrors = errors.length > 0
      hasModifications = edits.length > 0
      isExploring = reads.length > edits.length * 2
      isBroadChange = edits.length >= 5
      isQuick = toolCalls.length < 3

      // For rolling synthesis: allow pure discussion (no tool calls) — conversations
      // about architecture, planning, and strategy are where the best connections happen
    }

    // Detect discussion-heavy sessions (strategic planning, brainstorming)
    // Must have substantial back-and-forth (≥3 prompts) and low tool usage ratio
    const promptCount = event.activityType === "session-complete" && meta
      ? (meta.promptCount ?? 0)
      : getSessionEvents(event.subChatId).filter(e => e.activityType === "user-prompt").length
    const toolCount = event.activityType === "session-complete" && meta
      ? (meta.toolCallCount ?? 0)
      : getSessionEvents(event.subChatId).filter(e => e.activityType === "tool-call").length
    const isDiscussion = promptCount >= 3 && toolCount <= promptCount

    // Detect audit/review sessions — heavy reading, minimal writing, lots of tool calls
    const readCount = event.activityType === "session-complete" && meta
      ? (meta.filesRead?.length ?? 0)
      : getSessionEvents(event.subChatId).filter(e => e.activityType === "tool-call" && e.toolName && !["Edit", "Write", "file_edit", "file_write"].includes(e.toolName)).length
    const isAuditing = readCount >= 8 && !hasModifications

    // Skip only truly empty sessions — 0 tool calls AND no modifications AND not a discussion
    if (isQuick && !hasErrors && !isDiscussion && !hasModifications) {
      console.log("[GAAD] Synthesis skipped: trivial session (< 3 tool calls, no modifications, no errors)")
      return
    }

    // For session-complete: require meaningful activity
    if (event.activityType === "session-complete" && !hasErrors && !hasModifications && !isExploring && !isDiscussion) {
      console.log("[GAAD] Synthesis skipped: no meaningful activity in session")
      return
    }

    // Build dynamic emphasis based on session type
    let dynamicEmphasis = ""
    if (isAuditing) dynamicEmphasis = `\nThis session was an AUDIT/REVIEW — the developer was systematically reviewing code.
Don't resurface what they already found. Instead:
- CROSS-ZONE PATTERNS: What theme connects multiple findings? Name the systemic issue.
- PRIORITY ORDERING: What should be fixed first and why? Consider blast radius.
- CONCRETE NEXT ACTION: One specific thing to do next, with the file and function to start in.
Keep it to 1 suggestion — the developer already has a list of findings.`
    else if (isDiscussion) dynamicEmphasis = `\nThis session was a STRATEGIC DISCUSSION — focus on the ONE most important decision or insight.
Surface the single highest-value takeaway as a "next-step" suggestion: a brand decision, strategic direction, or design principle that should be remembered. Don't catalog everything — pick the most impactful one.`
    else if (hasErrors) dynamicEmphasis = "\nThis session had errors — what went wrong and how to prevent it next time?"
    else if (isBroadChange) dynamicEmphasis = "\nBroad changes across many files — what should be tested, and are there integration risks?"
    else if (isExploring) dynamicEmphasis = "\nMostly reading/exploring — what was learned, and what's the next concrete step?"

    // Get zone context for files touched in this session
    const sessionFiles = event.activityType === "session-complete" && meta
      ? [...(meta.filesModified ?? []), ...(meta.filesRead ?? [])].slice(0, 20)
      : getSessionEvents(event.subChatId)
          .flatMap(e => e.filePaths ?? [])
          .filter((v, i, a) => a.indexOf(v) === i)
          .slice(0, 20)
    const zoneContext = this.getZoneContext(sessionFiles)

    // Cap suggestions per synthesis: audit/discussion get fewer (they're broad, not deep)
    const maxSuggestions = isAuditing ? 1 : isDiscussion ? 2 : 3

    const system = `You are GAAD — a senior technical advisor who connects dots across a coding session. You surface insights that require seeing the full picture — connections the developer can't easily see while heads-down in code.

WHAT TO FIND (priority order):
1. CROSS-FILE CONNECTIONS: Two parts of the codebase coupled in a non-obvious way, where the session touched one. Name both files and the coupling mechanism.
2. MISSING PROPAGATION: A change in this session that needs to be reflected elsewhere (a new field not consumed, an error not handled by callers, a schema change without migration).
3. MOMENTUM: A natural next step that directly builds on what they just finished, with specific files and functions to modify. Not generic advice — a concrete action.
4. ARCHITECTURAL COUPLING: Two zones that should have changed together but only one did. Use the architecture context below.
5. CONCRETE BUGS: A real bug traceable through the session's code changes.

QUALITY FILTER:
- Ground every claim in a specific code path you can name (file, function, variable).
- Don't restate what the project memory already documents — only flag if the code CONTRADICTS it.
- Don't guess about runtime behavior you can't verify from the session data.
${dynamicEmphasis}

FORMAT:
- title: Factual statement, under 55 chars, no backticks.
- description: 1-2 sentences. The specific finding and its concrete consequence.
- suggestedPrompt: CONCRETE FIX as a direct instruction: "In file X, function Y, change Z to W because..." NEVER say "check", "verify", "investigate", or "if X then Y". If you can't state the fix, return [].

Respond with JSON array (0-${maxSuggestions} items, usually 0-1):
{"title": "...", "description": "...", "category": "blind-spot|risk|bug|test-gap|next-step", "confidence": 70-95, "files": ["path"], "suggestedPrompt": "..."}`

    // Get churn context for cross-session patterns
    const churnContext = this.sessionPatterns.buildChurnContext(this.projectId)

    const user = `## What They're Doing Right Now
${sessionSummary}

## What You Know About This Project (your institutional memory)
${memoryContext || "(no project memories yet — you're still building context)"}
${zoneContext ? `\n## Architecture Context\n${zoneContext}` : ""}${churnContext ? `\n## Cross-Session Patterns\n${churnContext}` : ""}
Look for connections between what's happening above and what you know. If there's a useful link, surface it. If not, return [].`

    // Weighted escalation: Sonnet for substantive sessions, Haiku for quick ones
    const score = (meta?.toolCallCount ?? 0)
                + (meta?.errorCount ?? 0) * 3
                + (meta?.filesModified?.length ?? 0) * 2
    // Force Sonnet for broad changes (5+ files) — these are where the real insights live
    const useSonnet = (score >= 6 || isBroadChange) && this.provider.info.supportsSonnet

    try {
      const modelLabel = useSonnet ? "sonnet" : "haiku"
      console.log(`[GAAD] Post-session synthesis (${modelLabel}, score=${score})`)

      const { text } = useSonnet
        ? await this.provider.callSonnet(system, user)
        : await this.provider.callHaiku(system, user)

      if (!text || this.disposeController.signal.aborted) return

      console.log(`[GAAD] Synthesis raw response (${text.length} chars): ${text.slice(0, 200)}...`)

      const jsonMatch = text.match(/\[[\s\S]*\]/)
      if (!jsonMatch) {
        console.log("[GAAD] Synthesis produced no JSON array")
        return
      }

      const suggestions = JSON.parse(jsonMatch[0]) as Array<{
        title: string
        description: string
        category: string
        confidence: number
        whyNonObvious?: string
        evidence?: string
        files?: string[]
        suggestedPrompt?: string
      }>

      if (!Array.isArray(suggestions)) return

      console.log(`[GAAD] Synthesis produced ${suggestions.length} suggestion(s)${suggestions.length > 0 ? ": " + suggestions.map(s => `"${s.title}"`).join(", ") : ""}`)

      if (suggestions.length === 0) return

      // --- Post-filter: reject narration, generic filler, hypotheticals, and linter-style noise ---
      const NARRATION_OPENERS = /^(the session |successfully |completed )/i
      const GENERIC_FILLER = /the developer might not (realize|notice)|this could be important|it's worth noting|worth mentioning|good practice|best practice|you may want to|might want to consider|could potentially|may cause issues|should be aware/i
      const HYPOTHETICAL_FILLER = /if (this|the|a) .{5,40} (then|,) .{5,40} (could|might) .{5,40} (break|fail|crash)/i
      const MEMORY_RESTATING = /the memory (explicitly )?(states|says|mentions|notes|indicates)|according to (the |project )?memory|as (noted|documented|mentioned) in memory/i
      const LINTER_NOISE = /console\.log|type assertion|as any|commented.out|unused (import|variable)|missing semicolon/i

      const userMessages = sessionSummary
        .split("\n")
        .filter(l => l.startsWith("- "))
        .map(l => l.slice(2).toLowerCase().replace(/[^a-z0-9\s]/g, ""))

      const filtered = suggestions.filter(s => {
        // Reject narration openers
        if (NARRATION_OPENERS.test(s.title)) {
          console.log(`[GAAD] Filtered narration-pattern: "${s.title}"`)
          return false
        }

        // Reject linter-level noise — GAAD is not a linter
        if (LINTER_NOISE.test(s.title) || LINTER_NOISE.test(s.description)) {
          console.log(`[GAAD] Filtered linter noise: "${s.title}"`)
          return false
        }

        // Reject generic filler in description
        if (GENERIC_FILLER.test(s.description)) {
          console.log(`[GAAD] Filtered generic filler: "${s.title}"`)
          return false
        }

        // Reject hypothetical "if X then Y could happen" without evidence
        if (HYPOTHETICAL_FILLER.test(s.description)) {
          console.log(`[GAAD] Filtered hypothetical: "${s.title}"`)
          return false
        }

        // Reject restating project memory as a finding
        if (MEMORY_RESTATING.test(s.description)) {
          console.log(`[GAAD] Filtered memory-restate: "${s.title}"`)
          return false
        }

        return true
      })

      console.log(`[GAAD] After filtering: ${filtered.length} of ${suggestions.length} survived`)

      for (const s of filtered.slice(0, maxSuggestions)) {
        if (!s.title || !s.description) continue

        const result: HeuristicResult = {
          category: (s.category as any) ?? "blind-spot",
          severity: s.confidence >= 75 ? "warning" : "info",
          title: s.title,
          description: s.description,
          confidence: Math.min(95, Math.max(55, s.confidence ?? 50)), // Floor at 55 — synthesis is already quality-gated by the prompt
          triggerFiles: s.files ?? [],
          triggerEvent: "session-synthesis",
        }

        if (!this.isRecentDuplicate(result)) {
          // Skip verification for synthesis — it works from session summaries,
          // not raw file reads, so identifier matching produces false negatives.
          // The synthesis prompt already enforces quality (cite specific code paths).
          this.persistSuggestion(result, s.suggestedPrompt, modelLabel)
        }
      }
    } catch (err) {
      console.warn("[GAAD] Synthesis parse error:", err)
    }
  }

  private persistSuggestion(
    result: HeuristicResult,
    suggestedPrompt?: string,
    model?: string,
  ): void {
    const db = getDatabase()
    const key = this.suggestionKey(result)

    // Mark as recent with file hash for content-aware dedup
    this.recentSuggestions.set(key, {
      expiry: Date.now() + RECENT_CACHE_TTL,
      fileHash: this.computeFileHash(result.triggerFiles),
    })

    // Enforce hard cap: expire oldest pending suggestions to make room
    const pendingRows = db.select({ id: ambientSuggestions.id })
      .from(ambientSuggestions)
      .where(and(
        eq(ambientSuggestions.projectId, this.projectId),
        eq(ambientSuggestions.status, "pending"),
      ))
      .orderBy(ambientSuggestions.createdAt) // ASC — oldest first
      .all()

    if (pendingRows.length >= MAX_PENDING_SUGGESTIONS) {
      // Expire enough to make room for the new one (keep MAX - 1, new one will be #MAX)
      const toExpire = pendingRows.slice(0, pendingRows.length - (MAX_PENDING_SUGGESTIONS - 1))
      for (const row of toExpire) {
        db.update(ambientSuggestions)
          .set({ status: "expired" })
          .where(eq(ambientSuggestions.id, row.id))
          .run()
        // Emit so frontend removes it immediately
        try {
          const events = getAmbientEvents()
          events?.emit(`project:${this.projectId}`, {
            type: "suggestion-expired",
            suggestionId: row.id,
          })
        } catch { /* non-critical */ }
      }
    }

    // Generate ID upfront so we can include it in the event

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

    // Bridge into audit system: match trigger files to system map zones
    // and create auditFindings so the audit dashboard shows GAAD's work
    this.bridgeToAuditSystem(db, suggestionId, result, suggestedPrompt)

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

  /**
   * Bridge a GAAD suggestion into the audit system.
   * Matches the suggestion's triggerFiles against system map zones
   * and creates auditFindings so the audit dashboard reflects GAAD's work.
   */
  // Map GAAD-specific categories to audit-compatible ones
  private static readonly CATEGORY_NORMALIZE: Record<string, string> = {
    "blind-spot": "bug",
    "risk": "security",
    "design": "dependency",
  }
  // Categories that shouldn't become audit findings (not actionable issues)
  private static readonly SKIP_CATEGORIES = new Set(["next-step", "memory"])

  private bridgeToAuditSystem(
    db: ReturnType<typeof getDatabase>,
    suggestionId: string,
    result: HeuristicResult,
    suggestedPrompt?: string,
  ): void {
    try {
      // Skip non-issue categories — these are suggestions, not findings
      if (AnalysisPipeline.SKIP_CATEGORIES.has(result.category)) return

      // Normalize category for audit system compatibility
      const category = AnalysisPipeline.CATEGORY_NORMALIZE[result.category] || result.category

      // Load system map zones (cached per pipeline instance)
      const zones = this.getSystemMapZones(db)
      if (zones.length === 0) return

      // Find which zones this suggestion's files overlap with
      const triggerFiles = result.triggerFiles
      if (triggerFiles.length === 0) return

      for (const zone of zones) {
        const matches = triggerFiles.some(tf =>
          zone.linkedFiles.some(zf => {
            const ntf = tf.replace(/^\.\//, "").replace(/^\//, "")
            const nzf = zf.replace(/^\.\//, "").replace(/^\//, "")
            return ntf === nzf || ntf.startsWith(nzf + "/") || nzf.startsWith(ntf + "/")
          }),
        )

        if (matches) {
          db.insert(auditFindings).values({
            id: createId(),
            runId: this.getOrCreateGaadAuditRun(db),
            projectId: this.projectId,
            suggestionId,
            zoneId: zone.id,
            zoneName: zone.name,
            category,
            severity: result.severity,
            title: result.title,
            description: result.description,
            confidence: result.confidence,
            affectedFiles: JSON.stringify(triggerFiles),
            suggestedPrompt: suggestedPrompt ?? this.buildSuggestedPrompt(result),
          }).run()
        }
      }
    } catch { /* non-critical — don't break suggestion pipeline */ }
  }

  /**
   * Build compact zone context for changed files — free architectural framing.
   * Returns a string like:
   *   Files in zone "Backend API" (tRPC → Frontend, Drizzle → Database).
   *   Adjacent: "Auth" zone (shares: src/lib/auth.ts).
   */
  getZoneContext(changedFiles: string[]): string {
    const db = getDatabase()
    const zones = this.getSystemMapZones(db)
    if (zones.length === 0 || changedFiles.length === 0) return ""

    const lines: string[] = []
    const matchedZoneIds = new Set<string>()

    // Find which zones the changed files belong to
    for (const zone of zones) {
      const matches = changedFiles.some(cf =>
        zone.linkedFiles.some(zf => {
          const ncf = cf.replace(/^\.\//, "").replace(/^\//, "")
          const nzf = zf.replace(/^\.\//, "").replace(/^\//, "")
          return ncf === nzf || ncf.startsWith(nzf + "/") || nzf.startsWith(ncf + "/")
        }),
      )
      if (matches) {
        matchedZoneIds.add(zone.id)
        const connections = zone.connections
          .map(c => {
            const target = zones.find(z => z.id === c.targetZoneId)
            return target ? `${c.protocol} → ${target.name}` : null
          })
          .filter(Boolean)
          .join(", ")
        lines.push(`Files in zone "${zone.name}"${connections ? ` (${connections})` : ""}.`)
      }
    }

    // Find adjacent zones (connected to matched zones but not matched themselves)
    for (const zone of zones) {
      if (matchedZoneIds.has(zone.id)) continue
      const isAdjacent = zone.connections.some(c => matchedZoneIds.has(c.targetZoneId))
        || zones.some(z => matchedZoneIds.has(z.id) && z.connections.some(c => c.targetZoneId === zone.id))
      if (isAdjacent) {
        // Find shared files between this zone and changed files
        const shared = zone.linkedFiles.filter(zf =>
          changedFiles.some(cf => {
            const ncf = cf.replace(/^\.\//, "").replace(/^\//, "")
            const nzf = zf.replace(/^\.\//, "").replace(/^\//, "")
            return ncf === nzf || ncf.startsWith(nzf + "/") || nzf.startsWith(ncf + "/")
          }),
        )
        const sharedStr = shared.length > 0 ? ` (shares: ${shared.slice(0, 2).join(", ")})` : ""
        lines.push(`Adjacent: "${zone.name}" zone${sharedStr}.`)
      }
    }

    // Cap at ~500 tokens worth of context
    return lines.slice(0, 6).join("\n")
  }

  // Cache for system map zones (refreshed every 5 minutes)
  private _cachedZones: SystemZone[] | null = null
  private _zonesCacheTime = 0

  private getSystemMapZones(db: ReturnType<typeof getDatabase>): SystemZone[] {
    const now = Date.now()
    if (this._cachedZones && now - this._zonesCacheTime < 5 * 60 * 1000) {
      return this._cachedZones
    }

    try {
      const project = db.select({ systemMap: projects.systemMap })
        .from(projects)
        .where(eq(projects.id, this.projectId))
        .get()

      if (project?.systemMap) {
        this._cachedZones = JSON.parse(project.systemMap)
        this._zonesCacheTime = now
        return this._cachedZones!
      }
    } catch { /* skip */ }

    this._cachedZones = []
    this._zonesCacheTime = now
    return []
  }

  // GAAD gets one "ambient" audit run per day to group its findings
  private _gaadRunId: string | null = null
  private _gaadRunDate: string | null = null

  private getOrCreateGaadAuditRun(db: ReturnType<typeof getDatabase>): string {
    const today = new Date().toISOString().slice(0, 10)

    if (this._gaadRunId && this._gaadRunDate === today) {
      return this._gaadRunId
    }

    // Import here to avoid circular dependency at module init
    const { auditRuns: ar } = require("../db/schema")

    // Finalize any stale ambient runs from previous days
    const staleRuns = db.select({ id: ar.id })
      .from(ar)
      .where(and(
        eq(ar.projectId, this.projectId),
        eq(ar.trigger, "ambient"),
        eq(ar.status, "running"),
      ))
      .all()

    for (const stale of staleRuns) {
      // Only finalize if it's not from today
      this.finalizeGaadRun(stale.id)
    }

    // Check if there's already a GAAD run for today
    const existing = db.select({ id: ar.id })
      .from(ar)
      .where(and(
        eq(ar.projectId, this.projectId),
        eq(ar.trigger, "ambient"),
        eq(ar.initiatedBy, "ambient"),
      ))
      .all()
      .find((r: any) => {
        const d = r.startedAt ?? r.createdAt
        return d && new Date(typeof d === "number" ? d : d).toISOString().slice(0, 10) === today
      })

    if (existing) {
      this._gaadRunId = existing.id
      this._gaadRunDate = today
      return existing.id
    }

    // Create a new daily GAAD run
    const runId = createId()
    db.insert(ar).values({
      id: runId,
      projectId: this.projectId,
      trigger: "ambient",
      status: "running",
      initiatedBy: "ambient",
      startedAt: new Date(),
    }).run()

    this._gaadRunId = runId
    this._gaadRunDate = today
    return runId
  }

  /**
   * Finalize a GAAD audit run — compute aggregate counts from its findings
   * and mark it completed. Idempotent (skips if already completed).
   */
  private finalizeGaadRun(runId: string): void {
    try {
      const db = getDatabase()
      const { auditRuns: ar, auditFindings: af } = require("../db/schema")

      // Check if already finalized
      const run = db.select({ status: ar.status }).from(ar).where(eq(ar.id, runId)).get()
      if (!run || run.status === "completed" || run.status === "failed") return

      // Count findings by severity
      const counts = db.select({
        severity: af.severity,
        count: sql<number>`count(*)`,
      })
        .from(af)
        .where(eq(af.runId, runId))
        .groupBy(af.severity)
        .all()

      let totalFindings = 0, errorCount = 0, warningCount = 0, infoCount = 0
      for (const row of counts) {
        totalFindings += row.count
        if (row.severity === "error") errorCount = row.count
        else if (row.severity === "warning") warningCount = row.count
        else if (row.severity === "info") infoCount = row.count
      }

      // Compute overall score (100 = clean, 0 = many issues)
      const overallScore = Math.max(0, 100 - (errorCount * 15 + warningCount * 5 + infoCount * 1))

      db.update(ar).set({
        status: "completed",
        completedAt: new Date(),
        totalFindings,
        errorCount,
        warningCount,
        infoCount,
        overallScore,
      }).where(eq(ar.id, runId)).run()

      console.log(`[GAAD] Finalized audit run ${runId}: ${totalFindings} findings, score ${overallScore}`)
    } catch (err) {
      console.warn("[GAAD] Failed to finalize run:", err)
    }
  }

  /**
   * Expire pending suggestions whose trigger files have been modified.
   * If the developer changed the files GAAD flagged, the suggestion may be stale.
   * Also clears dedup cache entries so re-analysis can happen.
   */
  private invalidateStalePendingSuggestions(changedPaths: string[]): void {
    if (changedPaths.length === 0) return

    try {
      const db = getDatabase()
      const pending = db.select({
        id: ambientSuggestions.id,
        triggerFiles: ambientSuggestions.triggerFiles,
        title: ambientSuggestions.title,
      })
        .from(ambientSuggestions)
        .where(and(
          eq(ambientSuggestions.projectId, this.projectId),
          eq(ambientSuggestions.status, "pending"),
        ))
        .all()

      const changedSet = new Set(changedPaths)

      for (const row of pending) {
        const files: string[] = JSON.parse(row.triggerFiles ?? "[]")
        if (!files.some(f => changedSet.has(f))) continue

        // Expire this suggestion — its trigger files were modified
        db.update(ambientSuggestions)
          .set({ status: "expired" })
          .where(eq(ambientSuggestions.id, row.id))
          .run()

        // Clear dedup cache so the area can be re-analyzed
        for (const [key] of this.recentSuggestions) {
          // Key format is "normalized title:basenames" — check if any basename matches
          const basenames = changedPaths.map(p => p.split("/").pop()).filter(Boolean)
          if (basenames.some(b => key.includes(b!))) {
            this.recentSuggestions.delete(key)
          }
        }

        // Emit so frontend removes it
        try {
          const events = getAmbientEvents()
          events?.emit(`project:${this.projectId}`, {
            type: "suggestion-expired",
            suggestionId: row.id,
          })
        } catch { /* non-critical */ }

        console.log(`[GAAD] Expired stale suggestion "${row.title}" (trigger files changed)`)
      }
    } catch { /* non-critical */ }
  }

  private isRecentDuplicate(result: HeuristicResult): boolean {
    const key = this.suggestionKey(result)
    const entry = this.recentSuggestions.get(key)
    if (!entry) return false
    if (Date.now() > entry.expiry) {
      this.recentSuggestions.delete(key)
      return false
    }
    // If the trigger files changed since the suggestion was cached, allow re-analysis
    const currentHash = this.computeFileHash(result.triggerFiles)
    if (currentHash !== entry.fileHash) {
      this.recentSuggestions.delete(key)
      return false
    }
    return true
  }

  private sweepRecentCache(): void {
    const now = Date.now()
    for (const [key, entry] of this.recentSuggestions) {
      if (now > entry.expiry) this.recentSuggestions.delete(key)
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
   * Simple hash of trigger file contents for change detection.
   * Reads first 1000 chars of each file, returns a numeric hash string.
   */
  private computeFileHash(triggerFiles: string[]): string {
    let combined = ""
    for (const file of triggerFiles.slice(0, 5)) {
      const fullPath = join(this.projectPath, file)
      try {
        if (!existsSync(fullPath)) continue
        combined += readFileSync(fullPath, "utf-8").slice(0, 1000)
      } catch { continue }
    }
    // djb2 hash
    let hash = 5381
    for (let i = 0; i < combined.length; i++) {
      hash = ((hash << 5) + hash + combined.charCodeAt(i)) | 0
    }
    return String(hash)
  }

  private suggestionKey(result: HeuristicResult): string {
    // Normalize aggressively so near-identical suggestions produce the same key
    // e.g. "AI budget guard fails OPEN — fix before ship" and
    //      "AI budget guard fails OPEN — do not treat as hard kill-switch"
    // should dedup to the same key
    const normalizedTitle = result.title
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, "")
      .split(/\s+/)
      .slice(0, 6) // First 6 words are enough to identify the topic
      .join(" ")
    const normalizedFiles = result.triggerFiles
      .map(f => f.split("/").pop() ?? f) // Just basenames
      .sort()
      .join(",")
    return `${normalizedTitle}:${normalizedFiles}`
  }

  /**
   * Create a maintenance action with dedup (G5) and daily cap (G6).
   * Returns true if the action was created, false if deduped or capped.
   */
  createMaintenanceAction(type: string, title: string, description: string, details?: Record<string, unknown>): boolean {
    try {
      const db = getDatabase()

      // G5: Exact title dedup — don't create if same type+title is already pending
      const exactDupe = db.select({ id: maintenanceActions.id })
        .from(maintenanceActions)
        .where(and(
          eq(maintenanceActions.projectId, this.projectId),
          eq(maintenanceActions.type, type),
          eq(maintenanceActions.title, title),
          eq(maintenanceActions.status, "pending"),
        ))
        .get()
      if (exactDupe) return false

      // G6: Max 3 pending maintenance actions per type (not global — prevents map refresh / doc drift from starving memory suggestions)
      const pendingCount = db.select({ id: maintenanceActions.id })
        .from(maintenanceActions)
        .where(and(
          eq(maintenanceActions.projectId, this.projectId),
          eq(maintenanceActions.type, type),
          eq(maintenanceActions.status, "pending"),
        ))
        .all().length
      if (pendingCount >= 3) return false

      const actionId = createId()
      db.insert(maintenanceActions).values({
        id: actionId,
        projectId: this.projectId,
        type,
        title,
        description,
        details: details ? JSON.stringify(details) : null,
      }).run()

      // Emit event so frontend picks it up
      try {
        const events = getAmbientEvents()
        events?.emit(`project:${this.projectId}`, {
          type: "maintenance-action-requested",
          actionId,
          action: { id: actionId, type, title },
        })
      } catch { /* non-critical */ }

      console.log(`[GAAD] Maintenance action created: "${title}" (${type})`)
      return true
    } catch (err) {
      console.warn("[GAAD] Failed to create maintenance action:", err)
      return false
    }
  }

  private buildSuggestedPrompt(result: HeuristicResult): string {
    const files = result.triggerFiles.join(", ")
    return `${result.description}\n\nAffected files: ${files}\n\nFix this issue.`
  }

  /**
   * Cached memory context fetch — avoids redundant getMemoriesForInjection calls
   * within a 2-minute window during rapid file saves. (O1 optimization)
   */
  private async getCachedMemoryContext(tokenBudget: number): Promise<string> {
    const now = Date.now()
    if (this._memoryContextCache && now - this._memoryContextCache.fetchedAt < this.MEMORY_CACHE_TTL) {
      return this._memoryContextCache.markdown
    }
    try {
      const result = await getMemoriesForInjection(this.projectId, null, tokenBudget)
      // Append open audit findings so GAAD doesn't re-flag known issues
      let combined = result.markdown
      try {
        const { getAuditFindingsForDedup } = require("../audit/injection")
        const dedupBlock = getAuditFindingsForDedup(this.projectId, 400)
        if (dedupBlock) combined += "\n\n" + dedupBlock
      } catch { /* non-critical */ }
      this._memoryContextCache = { markdown: combined, fetchedAt: now }
      return combined
    } catch {
      return ""
    }
  }

  /**
   * Post-session maintenance sweep — runs all free checks after a session completes.
   * Only runs at normal/conserving budget tiers. Skips at tier0-only/paused.
   */
  private async runPostSessionMaintenance(
    sessionMeta: NonNullable<ChatActivityEvent["sessionMeta"]>,
  ): Promise<void> {
    const budgetTier = this.budget.getDegradationTier()
    if (budgetTier === "tier0-only" || budgetTier === "paused") return

    const filesModified = sessionMeta.filesModified ?? []
    const filesRead = sessionMeta.filesRead ?? []
    const touchedFiles = [...filesRead, ...filesModified]

    // 0. Record session files for cross-session churn detection (free)
    try {
      this.sessionPatterns.recordSessionFiles(this.projectId, filesModified)
    } catch { /* non-critical */ }

    // 1. Memory reactivation — cold memories matching touched files (free)
    try {
      const reactivated = checkReactivation(this.projectId, touchedFiles, [])
      if (reactivated > 0) {
        console.log(`[GAAD] Post-session: reactivated ${reactivated} cold memories`)
      }
    } catch (err: any) {
      console.warn("[GAAD] Memory reactivation failed:", err.message)
    }

    // 2. Memory feedback — track which injected memories were useful (free)
    try {
      const injectionResult = await getMemoriesForInjection(this.projectId, null, 2000)
      if (injectionResult.memoryIds.length > 0) {
        recordSessionFeedback({
          projectId: this.projectId,
          injectedMemoryIds: injectionResult.memoryIds,
          filesRead,
          filesModified,
          conversationKeywords: [],
        })
      }
    } catch (err: any) {
      console.warn("[GAAD] Memory feedback recording failed:", err.message)
    }

    // 3. Auto-resolve findings — check if modified files fixed open findings (free)
    if (filesModified.length > 0) {
      try {
        this.resolveFixedFindings(filesModified)
      } catch { /* non-critical */ }
    }

    // 4. Map freshness — check modified files against zones (free)
    if (filesModified.length > 0) {
      try {
        const db = getDatabase()
        const project = db.select({ systemMap: projects.systemMap })
          .from(projects)
          .where(eq(projects.id, this.projectId))
          .get()
        if (project?.systemMap) {
          const zones = JSON.parse(project.systemMap) as import("../../../shared/system-map-types").SystemZone[]
          const freshnessResults = checkMapFreshness(this.projectId, this.projectPath, filesModified, zones)
          for (const result of freshnessResults) {
            this.createMaintenanceAction("refresh-system-map", result.title, result.description, result.details)
          }
        }
      } catch { /* non-critical */ }
    }

    // 5. Doc drift — check if modified docs reference stale paths (free)
    const docFiles = filesModified.filter(f =>
      /^(CLAUDE\.md|README\.md|readme\.md)$/i.test(f.split("/").pop() ?? ""),
    )
    if (docFiles.length > 0) {
      try {
        const driftResults = checkDocDrift(docFiles, this.projectPath)
        for (const drift of driftResults) {
          this.createMaintenanceAction(
            "refresh-docs",
            `${drift.file} references may be outdated`,
            `${drift.staleReferences.length} path(s) no longer exist: ${drift.staleReferences.slice(0, 3).join(", ")}`,
            { file: drift.file, staleReferences: drift.staleReferences },
          )
        }
      } catch { /* non-critical */ }
    }

    // 6. Memory consolidation + stale refinement (fire-and-forget, Haiku calls)
    try {
      const { runConsolidationPass, refineStaleMemories } = await import("../memory/consolidation")
      const consolidated = await runConsolidationPass(this.projectId)
      if (consolidated > 0) {
        console.log(`[GAAD] Post-session: consolidated ${consolidated} memory groups into knowledge docs`)
      }
      const refined = await refineStaleMemories(this.projectId, this.projectPath)
      if (refined > 0) {
        console.log(`[GAAD] Post-session: refined ${refined} stale memories`)
      }
    } catch (err: any) {
      console.warn("[GAAD] Memory consolidation/refinement failed:", err.message)
    }
  }

  /**
   * Auto-resolve audit findings whose affected files were changed.
   * Checks if the identifiers from the finding are still present in the file.
   * Free — filesystem only, no API calls.
   */
  resolveFixedFindings(changedPaths: string[]): number {
    try {
      const db = getDatabase()
      const changedSet = new Set(changedPaths)
      let resolved = 0

      // Get open findings for this project
      const openFindings = db.select()
        .from(auditFindings)
        .where(and(
          eq(auditFindings.projectId, this.projectId),
          eq(auditFindings.status, "open"),
        ))
        .all()

      for (const finding of openFindings) {
        const affectedFiles: string[] = finding.affectedFiles
          ? JSON.parse(finding.affectedFiles)
          : []

        // Only check findings whose affected files were changed
        if (!affectedFiles.some(f => changedSet.has(f))) continue

        // Check if the finding's key identifiers are still present
        let stillPresent = false
        for (const file of affectedFiles) {
          const fullPath = join(this.projectPath, file)
          if (!existsSync(fullPath)) continue
          try {
            const content = readFileSync(fullPath, "utf-8")
            // Extract key terms from the finding title (3+ char words)
            const terms = finding.title.match(/\b[a-zA-Z_][a-zA-Z0-9_]{2,}\b/g) ?? []
            // If most terms are still in the file, finding likely still valid
            const matchCount = terms.filter(t => content.includes(t)).length
            if (matchCount >= Math.ceil(terms.length * 0.6)) {
              stillPresent = true
              break
            }
          } catch { continue }
        }

        if (!stillPresent) {
          db.update(auditFindings)
            .set({ status: "resolved", resolvedAt: new Date() })
            .where(eq(auditFindings.id, finding.id))
            .run()

          // Emit event
          try {
            const events = getAmbientEvents()
            events?.emit(`project:${this.projectId}`, {
              type: "finding-resolved",
              findingId: finding.id,
            })
          } catch { /* non-critical */ }

          resolved++
        }
      }

      if (resolved > 0) {
        console.log(`[GAAD] Auto-resolved ${resolved} audit finding(s)`)
      }
      return resolved
    } catch (err) {
      console.warn("[GAAD] Auto-resolve findings failed:", err)
      return 0
    }
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
