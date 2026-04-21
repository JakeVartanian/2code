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
import { eq, and } from "drizzle-orm"
import { getDatabase } from "../db"
import { ambientSuggestions } from "../db/schema"
import type {
  AmbientConfig,
  AmbientEvent,
  AmbientAgentStatus,
  AmbientStatus,
  ChatActivityEvent,
  FileBatch,
  GitEvent,
} from "./types"

export class AmbientAgent {
  private gitMonitor: AmbientGitMonitor | null = null
  private pipeline: AnalysisPipeline
  private budget: BudgetTracker
  private config: AmbientConfig
  private projectId: string
  private projectPath: string
  private status: AmbientAgentStatus = "stopped"
  private lastEventAt: number | null = null
  private lastAnalysisAt: number | null = null
  private schedulerTimers: ReturnType<typeof setInterval>[] = []
  private ambientProvider: AmbientProvider | null = null

  constructor(projectId: string, projectPath: string) {
    this.projectId = projectId
    this.projectPath = projectPath
    this.config = loadAmbientConfig(projectPath)
    this.budget = new BudgetTracker(projectId, this.config.budget)
    this.pipeline = new AnalysisPipeline(projectId, projectPath, this.config, this.budget)
  }

  /**
   * Set up the AI provider for Tier 1/2 analysis.
   * Call this after start() with the appropriate credentials.
   */
  async initProvider(
    getAnthropicToken: () => Promise<string | null>,
    openRouterKey: string | null,
    openRouterFreeOnly: boolean = false,
  ): Promise<void> {
    const provider = await createAmbientProvider(getAnthropicToken, openRouterKey, openRouterFreeOnly)
    this.ambientProvider = provider
    this.pipeline.setProvider(provider)
    if (provider) {
      console.log(`[GAAD] Provider initialized: ${provider.type}`)
    } else {
      console.log("[GAAD] No AI provider available — running Tier 0 only")
    }
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

    // Weekly synthesis (guarded by provider availability)
    this.schedulerTimers.push(
      setInterval(() => {
        if (!this.ambientProvider) return
        runWeeklySynthesis(this.projectId, this.projectPath, this.ambientProvider)
          .catch(e => console.warn("[GAAD] Synthesis error:", e))
      }, 7 * 24 * 60 * 60 * 1000), // 7 days
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

  getStatus(): AmbientStatus {
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
      this.pause()
      return
    }

    // Forward to pipeline
    this.pipeline.processEvent(event).then(() => {
      this.lastAnalysisAt = Date.now()
    }).catch((err) => {
      console.error("[GAAD] Pipeline error:", err)
    })
  }
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
