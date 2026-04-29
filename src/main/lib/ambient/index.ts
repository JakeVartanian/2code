/**
 * Ambient Background Agent — main entry point and lifecycle management.
 * One agent per active project, managed via the ambientAgentRegistry.
 */

import { AmbientGitMonitor } from "./git-monitor"
import { AnalysisPipeline } from "./pipeline"
import { BudgetTracker } from "./budget"
import { createAmbientProvider, type AmbientProvider } from "./provider"
import { loadAmbientConfig, isQuietHours } from "./config"
import { applyScoreDecay, trimMemories } from "./memory-cycling"
import { runWeeklySynthesis } from "./synthesis"
import { eq, and, lte } from "drizzle-orm"
import { getDatabase } from "../db"
import { ambientSuggestions, projects, auditProfiles, maintenanceActions } from "../db/schema"
import { createId } from "../db/utils"
import type {
  AmbientConfig,
  AmbientEvent,
  AmbientAgentStatus,
  AmbientStatus,
  ChatActivityEvent,
  FileBatch,
  GitEvent,
} from "./types"

/** Timestamp of when this module was loaded — used to detect stale agent instances after app restart */
export const PROCESS_START_TIME = Date.now()

export class AmbientAgent {
  private gitMonitor: AmbientGitMonitor | null = null
  private pipeline: AnalysisPipeline
  readonly budget: BudgetTracker
  private config: AmbientConfig
  private projectId: string
  private projectPath: string
  private status: AmbientAgentStatus = "stopped"
  private lastEventAt: number | null = null
  private lastAnalysisAt: number | null = null
  private schedulerTimers: ReturnType<typeof setInterval>[] = []
  private ambientProvider: AmbientProvider | null = null
  // Activity counters — reset daily, used for micro-status display
  private activityDate: string = new Date().toISOString().slice(0, 10)
  private sessionsAnalyzedToday = 0
  private changesReviewedToday = 0
  private suggestionsToday = 0
  private lastInsightAt: number | null = null
  /** When this agent instance was created — compared against PROCESS_START_TIME to detect staleness */
  readonly createdAt: number = Date.now()

  constructor(projectId: string, projectPath: string) {
    this.projectId = projectId
    this.projectPath = projectPath
    this.config = loadAmbientConfig(projectPath)
    this.budget = new BudgetTracker(projectId, this.config.budget)
    this.pipeline = new AnalysisPipeline(projectId, projectPath, this.config, this.budget)
    // Track suggestion events for micro-status
    this.pipeline.setSuggestionHandler(() => this.trackActivity("suggestion"))
  }

  /**
   * Set up the AI provider for Tier 1/2 analysis.
   * Call this after start() with the appropriate credentials.
   * Retries up to 3 times with backoff if token isn't ready yet.
   */
  async initProvider(
    getAnthropicToken: () => Promise<string | null>,
    openRouterKey: string | null,
    openRouterFreeOnly: boolean = false,
  ): Promise<void> {
    const maxRetries = 3
    const delays = [0, 5_000, 15_000] // immediate, 5s, 15s

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      if (attempt > 0) {
        console.log(`[GAAD] Provider init retry ${attempt}/${maxRetries - 1} in ${delays[attempt] / 1000}s...`)
        await new Promise(r => setTimeout(r, delays[attempt]))
      }
      if (this.status === "stopped") return // Agent was stopped during retry wait

      const provider = await createAmbientProvider(getAnthropicToken, openRouterKey, openRouterFreeOnly)
      if (provider) {
        this.ambientProvider = provider
        this.pipeline.setProvider(provider)
        console.log(`[GAAD] Provider initialized: ${provider.type}${attempt > 0 ? ` (attempt ${attempt + 1})` : ""}`)
        return
      }
    }

    console.warn("[GAAD] No AI provider after retries — running Tier 0 only (heuristics). User must connect Claude account in Settings.")
  }

  async start(): Promise<void> {
    if (this.status === "running") return
    if (!this.config.enabled) {
      this.status = "stopped"
      return
    }

    // Mark as running immediately so the UI updates
    this.status = "running"

    // Initialize git monitor only — NO chokidar file watcher.
    // Chokidar's initial file tree scan freezes the Electron main process on large
    // projects. Instead, the git monitor watches .git/index (2 file descriptors total).
    // When .git/index changes (file saved, staged, committed), the git monitor fires
    // events that the pipeline processes. This is much lighter than watching every file.
    try {
      this.gitMonitor = new AmbientGitMonitor(this.projectPath)
      this.gitMonitor.on("git-event", (event: GitEvent) => {
        this.lastEventAt = Date.now()
        this.handleEvent({ kind: "git", event })
      })
      // File-batch events from periodic git diff poll (replaces chokidar)
      this.gitMonitor.on("file-batch", (batch: FileBatch) => {
        batch.projectId = this.projectId
        this.lastEventAt = Date.now()
        this.handleEvent({ kind: "file-batch", batch })
      })

      this.gitMonitor.start().catch((err) => {
        console.warn("[GAAD] Git monitor init failed:", err.message)
        this.gitMonitor?.dispose()
        this.gitMonitor = null
      })
    } catch (err) {
      console.warn("[GAAD] Git monitor creation failed:", err)
      this.gitMonitor = null
    }

    // --- Lifecycle scheduler ---
    // Run score decay immediately (catch-up for missed days), then every 24h
    try { applyScoreDecay(this.projectId) } catch (e) { console.warn("[GAAD] Initial decay error:", e) }

    this.schedulerTimers.push(
      setInterval(() => {
        try { applyScoreDecay(this.projectId) } catch (e) { console.warn("[GAAD] Decay error:", e) }
      }, 24 * 60 * 60 * 1000), // 24h
    )

    // Trim low-value memories every 6h
    this.schedulerTimers.push(
      setInterval(() => {
        try { trimMemories(this.projectId) } catch (e) { console.warn("[GAAD] Trim error:", e) }
      }, 6 * 60 * 60 * 1000), // 6h
    )

    // Weekly synthesis — check elapsed time since last run on startup
    const SYNTHESIS_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000 // 7 days
    const runSynthesisIfDue = async () => {
      if (!this.ambientProvider) return
      try {
        const db = getDatabase()
        const project = db.select({ lastSynthesisAt: projects.lastSynthesisAt })
          .from(projects)
          .where(eq(projects.id, this.projectId))
          .get()
        const lastRun = project?.lastSynthesisAt?.getTime() ?? 0
        if (Date.now() - lastRun >= SYNTHESIS_INTERVAL_MS) {
          await runWeeklySynthesis(this.projectId, this.projectPath, this.ambientProvider)
          db.update(projects)
            .set({ lastSynthesisAt: new Date() })
            .where(eq(projects.id, this.projectId))
            .run()
        }
      } catch (e) {
        console.warn("[GAAD] Synthesis error:", e)
      }
    }
    // Check on startup and every 6 hours
    runSynthesisIfDue()
    this.schedulerTimers.push(
      setInterval(() => runSynthesisIfDue(), 6 * 60 * 60 * 1000),
    )

    // Scheduled audit honoring — check every hour for due audit profiles
    const checkScheduledAudits = () => {
      try {
        const db = getDatabase()
        const now = new Date()
        const dueProfiles = db.select()
          .from(auditProfiles)
          .where(and(
            eq(auditProfiles.projectId, this.projectId),
            eq(auditProfiles.schedule, "daily"),
            lte(auditProfiles.nextScheduledAt, now),
          ))
          .all()

        for (const profile of dueProfiles) {
          const zoneNames = profile.zoneNames ? JSON.parse(profile.zoneNames) : []
          const label = zoneNames.length > 0 ? zoneNames.join(", ") : "all zones"

          // Dedup: don't create if same type already pending
          const existing = db.select({ id: maintenanceActions.id })
            .from(maintenanceActions)
            .where(and(
              eq(maintenanceActions.projectId, this.projectId),
              eq(maintenanceActions.type, "run-zone-audit"),
              eq(maintenanceActions.status, "pending"),
            ))
            .get()
          if (existing) continue

          const actionId = createId()
          db.insert(maintenanceActions)
            .values({
              id: actionId,
              projectId: this.projectId,
              type: "run-zone-audit",
              title: `Scheduled audit due for ${label}`,
              description: `Audit profile "${profile.name}" is overdue. Approve to run.`,
              details: JSON.stringify({
                profileId: profile.id,
                zoneIds: profile.zoneIds ? JSON.parse(profile.zoneIds) : null,
              }),
            })
            .run()
        }
      } catch (e) {
        console.warn("[GAAD] Scheduled audit check error:", e)
      }
    }
    checkScheduledAudits()
    this.schedulerTimers.push(
      setInterval(() => checkScheduledAudits(), 60 * 60 * 1000), // 1 hour
    )

    console.log(`[GAAD] Started for project ${this.projectId}`)
  }

  stop(): void {
    if (this.status === "stopped") return

    this.gitMonitor?.dispose()
    this.gitMonitor = null
    this.pipeline.dispose()

    // Clear scheduled timers
    for (const timer of this.schedulerTimers) clearInterval(timer)
    this.schedulerTimers = []

    this.status = "stopped"
    console.log(`[GAAD] Stopped for project ${this.projectId}`)
  }

  pause(): void {
    this.status = "paused"
  }

  resume(): void {
    if (this.status === "paused") {
      this.status = "running"
    }
  }

  /** Reset daily counters if date has rolled over */
  private ensureDailyCounters(): void {
    const today = new Date().toISOString().slice(0, 10)
    if (this.activityDate !== today) {
      this.activityDate = today
      this.sessionsAnalyzedToday = 0
      this.changesReviewedToday = 0
      this.suggestionsToday = 0
    }
  }

  /** Track activity — called from handleEvent */
  trackActivity(kind: "session" | "change" | "suggestion"): void {
    this.ensureDailyCounters()
    if (kind === "session") this.sessionsAnalyzedToday++
    else if (kind === "change") this.changesReviewedToday++
    else if (kind === "suggestion") {
      this.suggestionsToday++
      this.lastInsightAt = Date.now()
    }
  }

  getStatus(): AmbientStatus {
    this.ensureDailyCounters()
    return {
      agentStatus: this.status,
      budget: this.budget.getStatus(),
      pendingSuggestions: (() => {
        try {
          const db = getDatabase()
          return db.select({ id: ambientSuggestions.id })
            .from(ambientSuggestions)
            .where(and(
              eq(ambientSuggestions.projectId, this.projectId),
              eq(ambientSuggestions.status, "pending"),
            ))
            .all().length
        } catch { return 0 }
      })(),
      lastEventAt: this.lastEventAt,
      lastAnalysisAt: this.lastAnalysisAt,
      activity: {
        sessionsAnalyzedToday: this.sessionsAnalyzedToday,
        changesReviewedToday: this.changesReviewedToday,
        suggestionsToday: this.suggestionsToday,
        lastInsightAt: this.lastInsightAt,
      },
    }
  }

  getConfig(): AmbientConfig {
    return this.config
  }

  updateConfig(partial: Partial<AmbientConfig>): void {
    this.config = { ...this.config, ...partial }
    if (partial.budget) {
      this.budget.updateConfig({ ...this.config.budget, ...partial.budget })
    }
    this.pipeline.updateConfig(this.config)
    // If disabled via config, stop
    if (partial.enabled === false) {
      this.stop()
    }
  }

  /**
   * Get the pipeline instance (for setting suggestion handlers externally).
   */
  getPipeline(): AnalysisPipeline {
    return this.pipeline
  }

  /**
   * Ingest a chat activity event from the chat bridge.
   * Called non-blocking via queueMicrotask from the streaming path.
   */
  ingestChatEvent(event: ChatActivityEvent): void {
    if (this.status !== "running") return
    if (isQuietHours(this.config)) return

    this.lastEventAt = Date.now()
    this.handleEvent({ kind: "chat", event })
  }

  private handleEvent(event: AmbientEvent): void {
    // Don't process if paused, quiet hours, or budget exhausted
    if (this.status !== "running") return
    if (isQuietHours(this.config)) return

    const budgetTier = this.budget.getDegradationTier()
    if (budgetTier === "paused") {
      console.log("[GAAD] Budget paused — skipping event")
      this.pause()
      return
    }

    // Log provider status periodically (every 50th event) to catch "no provider" situations
    if (event.kind === "file-batch" || event.kind === "chat") {
      this.eventCount = (this.eventCount ?? 0) + 1
      if (this.eventCount % 50 === 1) {
        const budgetStatus = this.budget.getStatus()
        console.log(`[GAAD] Status check — provider: ${this.ambientProvider ? this.ambientProvider.type : "NONE"}, budget: ${budgetStatus.percentUsed}% (${budgetTier}), events processed: ${this.eventCount}`)
      }
    }

    // Track activity for micro-status
    if (event.kind === "file-batch") this.trackActivity("change")
    if (event.kind === "chat" && (event.event.activityType === "session-complete")) this.trackActivity("session")

    // Forward to pipeline
    this.pipeline.processEvent(event).then(() => {
      this.lastAnalysisAt = Date.now()
    }).catch((err) => {
      console.error("[GAAD] Pipeline error:", err)
    })
  }

  private eventCount = 0
}

// ============ REGISTRY ============

class AmbientAgentRegistry {
  private agents: Map<string, AmbientAgent> = new Map()
  private starting: Map<string, Promise<AmbientAgent>> = new Map() // Prevents double-create race

  async getOrCreate(projectId: string, projectPath: string): Promise<AmbientAgent> {
    const existing = this.agents.get(projectId)
    if (existing) return existing

    // Check if already starting (prevents race on concurrent calls)
    const pending = this.starting.get(projectId)
    if (pending) return pending

    const promise = (async () => {
      try {
        const agent = new AmbientAgent(projectId, projectPath)
        this.agents.set(projectId, agent)
        await agent.start() // Non-blocking now — sets status immediately, watchers init in background
        return agent
      } catch (error) {
        // Remove broken agent from registry so next call retries
        this.agents.delete(projectId)
        throw error
      } finally {
        this.starting.delete(projectId)
      }
    })()

    this.starting.set(projectId, promise)
    return promise
  }

  get(projectId: string): AmbientAgent | undefined {
    return this.agents.get(projectId)
  }

  async stop(projectId: string): Promise<void> {
    const agent = this.agents.get(projectId)
    if (agent) {
      agent.stop()
      this.agents.delete(projectId)
    }
  }

  async stopAll(): Promise<void> {
    for (const agent of this.agents.values()) {
      agent.stop()
    }
    this.agents.clear()
  }

  getAll(): Map<string, AmbientAgent> {
    return this.agents
  }
}

export const ambientAgentRegistry = new AmbientAgentRegistry()
