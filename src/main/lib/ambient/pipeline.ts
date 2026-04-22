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
import { ambientSuggestions, projectMemories, auditFindings, projects } from "../db/schema"
import { createId } from "../db/utils"
import type { SystemZone } from "../../../shared/system-map-types"
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

const RECENT_CACHE_TTL = 24 * 60 * 60 * 1000 // 24 hours
const RECENT_CACHE_SWEEP_INTERVAL = 60 * 60 * 1000 // Sweep every hour
const SUGGESTION_EXPIRY_HOURS = 48 // Expire pending suggestions after 48h
const MAX_PENDING_SUGGESTIONS = 8 // Raised from 3 — if GAAD has good things to say, let it say them

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
  // Abort controller for graceful dispose — signals all in-flight async work
  private disposeController = new AbortController()
  // Synthesis concurrency guard — only one synthesis at a time
  private synthesisBusy = false

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
    this.disposeController.abort() // Signal all in-flight async work to bail
    if (this.sweepTimer) clearInterval(this.sweepTimer)
    if (this.chatBatchTimer) clearTimeout(this.chatBatchTimer)
    this.recentSuggestions.clear()
    this.chatEventBatch = []
    this.promptCounter.clear()
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
    if (!this.provider || this.budget.getDegradationTier() !== "normal") return
    if (this.disposeController.signal.aborted) return

    const filePaths = batch.files.map(f => f.path)
    if (filePaths.length === 0) return

    // Budget check before calling
    if (!this.budget.canSpend("haiku", 800, 400)) return

    // Get actual diff content for changed files
    let diffContent = ""
    try {
      const { stdout } = await execAsync(
        "git diff --no-color -U2",
        { cwd: this.projectPath, timeout: 5000, maxBuffer: 50_000 },
      )
      diffContent = stdout.slice(0, 4000)
    } catch { /* non-critical */ }

    // For new/untracked files, list them (AI can flag suspicious additions)
    const newFiles = batch.files.filter(f => f.type === "add")
    if (newFiles.length > 0) {
      diffContent += "\n\nNew untracked files:\n" + newFiles.map(f => `- ${f.path}`).join("\n")
    }

    if (!diffContent || diffContent.length < 30) return

    // Inject project memory context
    let projectContext = ""
    try {
      const memoryResult = await getMemoriesForInjection(this.projectId, null, 800)
      projectContext = memoryResult.markdown
    } catch { /* non-critical */ }

    const system = `You are GAAD, a developer's ambient coding assistant. You silently review code changes and only speak when you spot something genuinely valuable — a real bug, a risk they haven't considered, a blind spot, or a meaningful architectural concern.

You are NOT a linter. Do NOT flag: console.log, style issues, missing types, unused variables, missing comments, or anything a linter handles. Focus on things that would make a senior developer stop and think.

Respond with a JSON array (0-2 items, usually 0-1). Each:
{"title":"concise finding","description":"2-3 sentences: what you found and why it matters","category":"bug"|"security"|"risk"|"blind-spot"|"performance"|"next-step","confidence":60-95,"files":["affected/file/paths"],"suggestedPrompt":"specific instructions for Claude to fix this"}

Return [] if nothing is genuinely noteworthy. Most changes are fine — only flag real concerns.`

    const user = `${projectContext ? `Project context:\n${projectContext}\n\n` : ""}Changed files: ${filePaths.join(", ")}\n\nDiff:\n${diffContent}`

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
        if (!s.title || !s.description || (s.confidence ?? 0) < 60) continue

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
  private readonly SYNTHESIS_PROMPT_INTERVAL = 2 // Synthesize every N user prompts — synthesis is where the intelligence lives
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
      // Require minimum confidence of 75 for chat heuristics (same bar as no-provider fallback)
      if (result.confidence < 75) continue
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
    let memoryContext = ""
    try {
      // Pass session summary as context hint so memory scoring boosts relevant memories
      const memoryResult = await getMemoriesForInjection(this.projectId, sessionSummary, 5000)
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
    const promptCount = event.activityType === "session-complete" && meta
      ? (meta.promptCount ?? 0)
      : getSessionEvents(event.subChatId).filter(e => e.activityType === "user-prompt").length
    const toolCount = event.activityType === "session-complete" && meta
      ? (meta.toolCallCount ?? 0)
      : getSessionEvents(event.subChatId).filter(e => e.activityType === "tool-call").length
    const isDiscussion = promptCount >= 1 && toolCount <= promptCount * 2

    // Skip trivial sessions — less than 2 tool calls isn't worth analyzing
    if (isQuick && !hasErrors && !isDiscussion) {
      console.log("[GAAD] Synthesis skipped: trivial session (< 3 tool calls, no errors)")
      return
    }

    // For session-complete: require meaningful activity
    if (event.activityType === "session-complete" && !hasErrors && !hasModifications && !isExploring && !isDiscussion) {
      console.log("[GAAD] Synthesis skipped: no meaningful activity in session")
      return
    }

    // Build dynamic emphasis based on session type
    let dynamicEmphasis = ""
    if (isDiscussion) dynamicEmphasis = "\nThis session was a STRATEGIC DISCUSSION — the developer is thinking at a high level. Do NOT focus on low-level code details. Instead, connect their ideas to concrete codebase actions: what existing code needs to change to support their vision? What technical decisions are implied by their plan that they may not have thought through? What infrastructure gaps exist between where the code is now and where they want it to go?"
    else if (hasErrors) dynamicEmphasis = "\nThis session had errors — what went wrong and how to prevent it next time?"
    else if (isBroadChange) dynamicEmphasis = "\nBroad changes across many files — what should be tested, and are there integration risks?"
    else if (isExploring) dynamicEmphasis = "\nMostly reading/exploring — what was learned, and what's the next concrete step?"

    const maxSuggestions = 3

    const system = `You are GAAD — a developer's strategic partner who knows the full history of this codebase, the product vision, and the broader landscape. You've watched every session, every decision, every pivot. You think like a CTO who also codes.

YOUR JOB: Look at what the developer is doing RIGHT NOW and surface the most valuable insight you can — whether that's a technical connection, a product idea, a strategic opportunity, or a risk they haven't considered. You're the colleague who sees the bigger picture.

WHAT MAKES A GREAT SUGGESTION (in order of value):
1. **Strategic insight**: "You just built X — this positions you to do Y, which competitors don't have yet. Here's the technical path."
2. **Product opportunity**: "The infrastructure you're building could support [feature that users would love]. The hard part is already done in [file]."
3. **Architecture evolution**: "This is the 3rd time this pattern appears — it's becoming a core abstraction. Consider promoting it to a shared module before it diverges."
4. **Hidden connection**: "You're changing zone A, but zone B depends on the same interface. Also, this change enables [capability] you discussed 2 sessions ago."
5. **Risk from history**: "Last time this pattern was changed, it caused Z. The current approach avoids that but introduces a new constraint on [thing]."
6. **Go-to-market insight**: "This feature is demo-ready. Three things to polish for a launch: [specifics]."
7. **Developer experience**: "Your onboarding flow / CLI / API surface could be smoother — here's what a new user would hit first."

WHAT TO AVOID:
- Don't restate what they just did or narrate the session
- Don't give generic advice ("add tests", "consider error handling", "document this")
- Don't flag linter-level stuff (console.log, types, style)
- Don't suggest things they already explicitly decided against
- Don't be vague — every suggestion must name specific files, functions, or concrete next actions
${dynamicEmphasis}

USE THE PROJECT KNOWLEDGE SECTION ACTIVELY. Cross-reference current work with what you know about the project's history, goals, and architecture. The best insights connect code-level work to product-level outcomes.

Respond with a JSON array (0-${maxSuggestions} items). Each item:
{"title": "short, specific, intriguing — make them want to read more", "description": "2-3 sentences. What you noticed, why it matters for the product (not just the code), and a concrete action.", "category": "blind-spot"|"risk"|"bug"|"test-gap"|"next-step", "confidence": 60-95, "files": ["affected/file/paths"], "suggestedPrompt": "Specific instructions for Claude to act on this. File names, function names, the exact change or investigation."}

Think bigger than code. Think about the product, the users, the market, the developer experience. If you see something that could be a feature, a competitive advantage, or a growth opportunity — say it. But always ground it in the actual codebase.`

    const user = `## What They're Doing Right Now
${sessionSummary}

## What You Know About This Project (your institutional memory)
${memoryContext || "(no project memories yet — you're still building context)"}

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

      // --- Post-filter: reject narration, generic filler, and linter-style noise ---
      const NARRATION_OPENERS = /^(you |the session |consider |remember |successfully |completed |make sure |don't forget |the changes |the code |the developer |you should |you might |it would be |it('|')s worth |note that |be sure to )/i
      const GENERIC_FILLER = /the developer might not (realize|notice)|this could be important|it's worth noting|worth mentioning|good practice|best practice|you may want to|might want to consider/i
      const LINTER_NOISE = /console\.log|type assertion|as any|commented.out|dead code|unused (import|variable|function)|missing semicolon/i

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
          confidence: Math.min(95, Math.max(70, s.confidence ?? 50)), // Floor at 70 — fewer suggestions, each earns trust
          triggerFiles: s.files ?? [],
          triggerEvent: "session-synthesis",
        }

        if (!this.isRecentDuplicate(result)) {
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

    // Mark as recent (expiry timestamp instead of setTimeout)
    this.recentSuggestions.set(key, Date.now() + RECENT_CACHE_TTL)

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
  private bridgeToAuditSystem(
    db: ReturnType<typeof getDatabase>,
    suggestionId: string,
    result: HeuristicResult,
    suggestedPrompt?: string,
  ): void {
    try {
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
            category: result.category,
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
      status: "running", // perpetually running — gets finalized at midnight or app close
      initiatedBy: "ambient",
      startedAt: new Date(),
    }).run()

    this._gaadRunId = runId
    this._gaadRunDate = today
    return runId
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

      console.log(`[GAAD] Memory written: ${analysis.title}`)
    } catch (err) {
      // Non-critical — don't fail the pipeline
      console.warn("[GAAD] Failed to write memory:", err)
    }
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
