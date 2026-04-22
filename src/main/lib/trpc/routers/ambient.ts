/**
 * Ambient Background Agent tRPC router — queries, mutations, and subscription
 * for managing the ambient agent, its suggestions, and budget.
 */

import { z } from "zod"
import { router, publicProcedure } from "../index"
import { getDatabase } from "../../db"
import { ambientSuggestions, ambientBudget, ambientFeedback, subChats, projects } from "../../db/schema"
import { eq, and, desc, sql } from "drizzle-orm"
import { observable } from "@trpc/server/observable"
import { EventEmitter } from "events"
import { ambientAgentRegistry } from "../../ambient"
import { createAmbientProvider } from "../../ambient/provider"
import { buildBrain, refreshBrain, getBrainStatus } from "../../ambient/backfill"
import { trimMemories } from "../../ambient/memory-cycling"
import { createId } from "../../db/utils"

// Event emitter for real-time suggestion notifications
export const ambientEvents = new EventEmitter()
ambientEvents.setMaxListeners(50)

const suggestionCategoryEnum = z.enum([
  "bug", "security", "performance", "test-gap", "dead-code", "dependency",
])

const suggestionStatusEnum = z.enum([
  "pending", "dismissed", "approved", "snoozed", "expired",
])

export const ambientRouter = router({
  // ============ QUERIES ============

  /**
   * List suggestions for a project with optional status filter.
   */
  listSuggestions: publicProcedure
    .input(z.object({
      projectId: z.string(),
      status: suggestionStatusEnum.optional().default("pending"),
      limit: z.number().optional().default(50),
    }))
    .query(({ input }) => {
      const db = getDatabase()
      const now = new Date()

      let results = db.select()
        .from(ambientSuggestions)
        .where(eq(ambientSuggestions.projectId, input.projectId))
        .orderBy(desc(ambientSuggestions.createdAt))
        .limit(input.limit)
        .all()

      // Filter by status (handle snoozed expiry at query time)
      if (input.status === "pending") {
        results = results.filter(r => {
          if (r.status === "pending") return true
          // Un-snooze if snoozedUntil has passed
          if (r.status === "snoozed" && r.snoozedUntil && r.snoozedUntil < now) return true
          return false
        })
      } else {
        results = results.filter(r => r.status === input.status)
      }

      return results.map(r => ({
        ...r,
        triggerFiles: r.triggerFiles ? JSON.parse(r.triggerFiles) : [],
      }))
    }),

  /**
   * Get budget status for today.
   */
  getBudgetStatus: publicProcedure
    .input(z.object({ projectId: z.string() }))
    .query(({ input }) => {
      const agent = ambientAgentRegistry.get(input.projectId)
      if (agent) {
        return agent.getStatus().budget
      }
      // Fallback: read from DB directly
      const db = getDatabase()
      const today = new Date().toISOString().slice(0, 10)
      const row = db.select()
        .from(ambientBudget)
        .where(and(
          eq(ambientBudget.projectId, input.projectId),
          eq(ambientBudget.date, today),
        ))
        .get()

      return {
        date: today,
        haikuCalls: row?.haikuCalls ?? 0,
        sonnetCalls: row?.sonnetCalls ?? 0,
        totalCostCents: row?.totalCostCents ?? 0,
        dailyLimitCents: 500,
        percentUsed: row ? Math.round((row.totalCostCents / 50) * 100) : 0,
        isExhausted: row ? row.totalCostCents >= 50 : false,
        tier: "normal" as const,
      }
    }),

  /**
   * Get ambient agent status.
   */
  getStatus: publicProcedure
    .input(z.object({ projectId: z.string() }))
    .query(({ input }) => {
      const agent = ambientAgentRegistry.get(input.projectId)
      if (!agent) {
        return {
          agentStatus: "stopped" as const,
          budget: null,
          pendingSuggestions: 0,
          lastEventAt: null,
          lastAnalysisAt: null,
          activity: {
            sessionsAnalyzedToday: 0,
            changesReviewedToday: 0,
            suggestionsToday: 0,
            lastInsightAt: null,
          },
        }
      }
      return agent.getStatus()
    }),

  /**
   * Get ambient config for a project.
   */
  getConfig: publicProcedure
    .input(z.object({ projectId: z.string() }))
    .query(({ input }) => {
      const agent = ambientAgentRegistry.get(input.projectId)
      if (agent) return agent.getConfig()
      // Return defaults
      return {
        enabled: true,
        sensitivity: "medium" as const,
        budget: { dailyLimitCents: 500, haikuRateLimit: 60, sonnetRateLimit: 20 },
        enabledCategories: ["bug", "security", "performance", "test-gap"] as const,
        ignorePatterns: [] as string[],
        autoMemoryWrite: true,
        triageThreshold: 0.7,
      }
    }),

  /**
   * Get category feedback weights.
   */
  getFeedbackWeights: publicProcedure
    .input(z.object({ projectId: z.string() }))
    .query(({ input }) => {
      const db = getDatabase()
      const rows = db.select()
        .from(ambientFeedback)
        .where(eq(ambientFeedback.projectId, input.projectId))
        .all()

      return rows.map(r => ({
        category: r.category,
        weight: r.weight / 100, // Convert from integer × 100 to float
        isSuppressed: r.isSuppressed,
        totalDismissals: r.totalDismissals,
        totalApprovals: r.totalApprovals,
      }))
    }),

  // ============ MUTATIONS ============

  /**
   * Toggle ambient agent on/off for a project.
   */
  toggle: publicProcedure
    .input(z.object({
      projectId: z.string(),
      projectPath: z.string(),
      enabled: z.boolean(),
    }))
    .mutation(async ({ input }) => {
      if (input.enabled) {
        try {
          const agent = await ambientAgentRegistry.getOrCreate(input.projectId, input.projectPath)
          // Initialize the AI provider in background — don't block the UI
          // The agent is already running (file watcher + git monitor active)
          // Provider enables Tier 1/2 analysis; Tier 0 works without it
          import("./claude").then(({ getClaudeCodeTokenFresh }) => {
            agent.initProvider(
              () => getClaudeCodeTokenFresh(),
              null, // TODO: pass OpenRouter key if configured
            ).catch((err) => {
              console.warn("[GAAD] Provider init failed (Tier 0 only):", err.message)
            })
          }).catch((err) => {
            console.error("[GAAD] Failed to import claude module:", err.message)
          })
        } catch (err) {
          console.error("[GAAD] Failed to start agent:", err)
          // Clean up any partial state
          await ambientAgentRegistry.stop(input.projectId).catch(() => {})
          return { enabled: false, error: err instanceof Error ? err.message : "Failed to start ambient agent" }
        }
      } else {
        try {
          await ambientAgentRegistry.stop(input.projectId)
        } catch (err) {
          console.error("[Ambient] Failed to stop agent:", err)
        }
      }
      // Persist enabled state to DB so it survives restarts
      const db = getDatabase()
      db.update(projects)
        .set({ ambientEnabled: input.enabled })
        .where(eq(projects.id, input.projectId))
        .run()

      return { enabled: input.enabled }
    }),

  /**
   * Ensure the ambient agent is running for a project (auto-start on load).
   * Called by the renderer on mount — only starts if ambientEnabled is true in DB.
   */
  ensureRunning: publicProcedure
    .input(z.object({
      projectId: z.string(),
      projectPath: z.string(),
    }))
    .mutation(async ({ input }) => {
      const db = getDatabase()
      const project = db.select({ ambientEnabled: projects.ambientEnabled })
        .from(projects)
        .where(eq(projects.id, input.projectId))
        .get()

      // Default to enabled for projects that existed before the column was added
      if (project && project.ambientEnabled === false) {
        return { status: "disabled" as const }
      }

      // Check if already running
      const existing = ambientAgentRegistry.get(input.projectId)
      if (existing) return { status: "running" as const }

      try {
        const agent = await ambientAgentRegistry.getOrCreate(input.projectId, input.projectPath)
        // Init provider in background (same as toggle)
        import("./claude").then(({ getClaudeCodeTokenFresh }) => {
          agent.initProvider(
            () => getClaudeCodeTokenFresh(),
            null,
          ).catch(err => console.warn("[GAAD] Provider init failed:", err.message))
        }).catch((err) => {
          console.error("[GAAD] Failed to import claude module for provider init:", err?.message ?? err)
        })
        return { status: "running" as const }
      } catch (err) {
        console.error("[Ambient] Auto-start failed:", err)
        return { status: "error" as const }
      }
    }),

  /**
   * Dismiss a suggestion. Records feedback for learning.
   */
  dismiss: publicProcedure
    .input(z.object({
      suggestionId: z.string(),
      reason: z.enum(["not-relevant", "already-handled", "wrong", "suppress-type"]).optional(),
    }))
    .mutation(({ input }) => {
      const db = getDatabase()
      const now = new Date()

      // Update suggestion status
      const suggestion = db.select()
        .from(ambientSuggestions)
        .where(eq(ambientSuggestions.id, input.suggestionId))
        .get()

      if (!suggestion) return { success: false }

      db.update(ambientSuggestions)
        .set({
          status: "dismissed",
          dismissedAt: now,
          dismissReason: input.reason ?? "not-relevant",
        })
        .where(eq(ambientSuggestions.id, input.suggestionId))
        .run()

      // Delegate feedback tracking to the pipeline's FeedbackTracker (keeps cache in sync)
      const agent = ambientAgentRegistry.get(suggestion.projectId)
      if (agent) {
        // Calculate time-to-dismiss from firstViewedAt
        const timeToDismiss = suggestion.firstViewedAt
          ? now.getTime() - new Date(suggestion.firstViewedAt).getTime()
          : undefined
        agent.getPipeline().feedback.recordDismissal(
          suggestion.category as any,
          timeToDismiss,
        )
      } else {
        // No active agent — do raw DB update as fallback
        const { FeedbackTracker } = require("../../ambient/feedback")
        const tracker = new FeedbackTracker(suggestion.projectId)
        tracker.recordDismissal(suggestion.category as any)
      }

      // Emit event for real-time UI update
      ambientEvents.emit(`project:${suggestion.projectId}`, {
        type: "suggestion-dismissed",
        suggestionId: input.suggestionId,
      })

      return { success: true }
    }),

  /**
   * Approve a suggestion — creates a sub-chat with pre-filled prompt.
   */
  approve: publicProcedure
    .input(z.object({
      suggestionId: z.string(),
      chatId: z.string(),
      mode: z.enum(["plan", "agent"]).optional().default("agent"),
    }))
    .mutation(({ input }) => {
      const db = getDatabase()
      const now = new Date()

      const suggestion = db.select()
        .from(ambientSuggestions)
        .where(eq(ambientSuggestions.id, input.suggestionId))
        .get()

      if (!suggestion) return { success: false, subChatId: null }

      // Create a new sub-chat with the suggested prompt
      const subChatId = createId()
      const promptText = suggestion.suggestedPrompt || suggestion.description || suggestion.title
      const initialMessages = JSON.stringify([{
        id: `msg-${Date.now()}`,
        role: "user",
        parts: [{ type: "text", text: promptText }],
      }])

      // Truncate title for tab name (keep it readable)
      const tabName = suggestion.title.length > 60
        ? suggestion.title.slice(0, 57) + "..."
        : suggestion.title

      db.insert(subChats)
        .values({
          id: subChatId,
          name: tabName,
          chatId: input.chatId,
          mode: input.mode,
          messages: initialMessages,
        })
        .run()

      // Update suggestion status
      db.update(ambientSuggestions)
        .set({
          status: "approved",
          approvedAt: now,
          resolvedSubChatId: subChatId,
        })
        .where(eq(ambientSuggestions.id, input.suggestionId))
        .run()

      // Delegate feedback boost to FeedbackTracker (keeps cache in sync)
      const approveAgent = ambientAgentRegistry.get(suggestion.projectId)
      if (approveAgent) {
        approveAgent.getPipeline().feedback.recordApproval(suggestion.category as any)
      } else {
        const { FeedbackTracker } = require("../../ambient/feedback")
        const tracker = new FeedbackTracker(suggestion.projectId)
        tracker.recordApproval(suggestion.category as any)
      }

      // Emit event
      ambientEvents.emit(`project:${suggestion.projectId}`, {
        type: "suggestion-approved",
        suggestionId: input.suggestionId,
        subChatId,
      })

      return { success: true, subChatId }
    }),

  /**
   * Snooze a suggestion for N hours.
   */
  snooze: publicProcedure
    .input(z.object({
      suggestionId: z.string(),
      hours: z.number().default(24),
    }))
    .mutation(({ input }) => {
      const db = getDatabase()
      const snoozedUntil = new Date(Date.now() + input.hours * 60 * 60 * 1000)

      db.update(ambientSuggestions)
        .set({
          status: "snoozed",
          snoozedUntil,
        })
        .where(eq(ambientSuggestions.id, input.suggestionId))
        .run()

      return { success: true, snoozedUntil }
    }),

  /**
   * Mark a suggestion as viewed (for time-to-dismiss tracking).
   */
  markViewed: publicProcedure
    .input(z.object({ suggestionId: z.string() }))
    .mutation(({ input }) => {
      const db = getDatabase()
      db.update(ambientSuggestions)
        .set({ firstViewedAt: new Date() })
        .where(and(
          eq(ambientSuggestions.id, input.suggestionId),
          sql`${ambientSuggestions.firstViewedAt} IS NULL`,
        ))
        .run()
      return { success: true }
    }),

  /**
   * Reset a category's feedback weight back to 1.0.
   */
  resetCategoryWeight: publicProcedure
    .input(z.object({
      projectId: z.string(),
      category: suggestionCategoryEnum,
    }))
    .mutation(({ input }) => {
      const db = getDatabase()
      db.update(ambientFeedback)
        .set({
          weight: 100,
          isSuppressed: false,
          updatedAt: new Date(),
        })
        .where(and(
          eq(ambientFeedback.projectId, input.projectId),
          eq(ambientFeedback.category, input.category),
        ))
        .run()
      return { success: true }
    }),

  // ============ MEMORY CYCLING ============

  /**
   * Trim low-value memories to reduce injection weight.
   * Archives lowest-scored memories until injection budget is healthy.
   */
  trimMemories: publicProcedure
    .input(z.object({ projectId: z.string() }))
    .mutation(({ input }) => {
      const result = trimMemories(input.projectId)
      return result
    }),

  // ============ ORCHESTRATION BRIDGE ============

  /**
   * Draft an orchestration plan from a complex ambient suggestion.
   * Calls the orchestrator's decomposeGoal with the suggestion context + ambient memories.
   */
  draftOrchestrationPlan: publicProcedure
    .input(z.object({
      suggestionId: z.string(),
      projectPath: z.string(),
    }))
    .mutation(async ({ input }) => {
      const db = getDatabase()

      const suggestion = db.select()
        .from(ambientSuggestions)
        .where(eq(ambientSuggestions.id, input.suggestionId))
        .get()

      if (!suggestion) return { success: false, error: "Suggestion not found" }

      // Build goal from suggestion context
      let triggerFiles: string[] = []
      try { triggerFiles = suggestion.triggerFiles ? JSON.parse(suggestion.triggerFiles) : [] } catch { /* malformed */ }

      const goal = [
        suggestion.description,
        "",
        `Affected files: ${triggerFiles.join(", ")}`,
        "",
        suggestion.suggestedPrompt ?? "Please investigate and fix this issue.",
      ].join("\n")

      // Call orchestrator decompose (with memory context)
      try {
        const { getMemoriesForInjection } = require("../../memory/injection")
        const memoryResult = await getMemoriesForInjection(suggestion.projectId, goal, 1500)

        const { decomposeGoal } = require("../../orchestration/decompose")
        const plan = await decomposeGoal({
          userGoal: goal,
          projectPath: input.projectPath,
          projectMemories: memoryResult.markdown || "",
        })

        // Store the plan on the suggestion
        db.update(ambientSuggestions)
          .set({
            draftOrchestrationPlan: JSON.stringify(plan),
          })
          .where(eq(ambientSuggestions.id, input.suggestionId))
          .run()

        return {
          success: true,
          plan,
          taskCount: plan.tasks?.length ?? 0,
        }
      } catch (err: any) {
        return { success: false, error: err.message ?? "Failed to decompose" }
      }
    }),

  // ============ BRAIN BUILD ============

  /**
   * Build project brain — full analysis of git history, configs, CLAUDE.md.
   * Idempotent (dedup prevents duplicates).
   */
  buildBrain: publicProcedure
    .input(z.object({
      projectId: z.string(),
      projectPath: z.string(),
    }))
    .mutation(async ({ input }) => {
      // Lazy import to avoid circular dependency at module init time
      const { getClaudeCodeTokenFresh } = await import("./claude")
      const provider = await createAmbientProvider(
        () => getClaudeCodeTokenFresh(),
        null, // TODO: pass OpenRouter key if configured
      )

      if (!provider) {
        return { success: false, error: "No AI provider available", memoriesCreated: 0 }
      }

      const result = await buildBrain(input.projectId, input.projectPath, provider)

      return {
        success: true,
        memoriesCreated: result.memoriesCreated,
        memoriesUpdated: result.memoriesUpdated,
        sources: result.sources,
        failedPasses: result.failedPasses ?? [],
        durationMs: result.durationMs,
      }
    }),

  /**
   * Refresh brain — incremental update since last build.
   */
  refreshBrain: publicProcedure
    .input(z.object({
      projectId: z.string(),
      projectPath: z.string(),
    }))
    .mutation(async ({ input }) => {
      const { getClaudeCodeTokenFresh } = await import("./claude")
      const provider = await createAmbientProvider(
        () => getClaudeCodeTokenFresh(),
        null,
      )

      if (!provider) {
        return { success: false, error: "No AI provider available", memoriesCreated: 0 }
      }

      const result = await refreshBrain(input.projectId, input.projectPath, provider)

      return {
        success: true,
        memoriesCreated: result.memoriesCreated,
        memoriesUpdated: result.memoriesUpdated,
        sources: result.sources,
        failedPasses: result.failedPasses ?? [],
        durationMs: result.durationMs,
      }
    }),

  /**
   * Get brain status — memory count, categories, last built time.
   */
  getBrainStatus: publicProcedure
    .input(z.object({ projectId: z.string() }))
    .query(({ input }) => {
      return getBrainStatus(input.projectId)
    }),

  // ============ SYSTEM MAP ============

  /**
   * Get the synthesized system architecture map for a project.
   * Returns null if no map has been generated yet.
   */
  getSystemMap: publicProcedure
    .input(z.object({ projectId: z.string() }))
    .query(({ input }) => {
      const db = getDatabase()
      const project = db
        .select({ systemMap: projects.systemMap, systemMapBuiltAt: projects.systemMapBuiltAt })
        .from(projects)
        .where(eq(projects.id, input.projectId))
        .get()

      if (!project?.systemMap) return null

      try {
        return {
          zones: JSON.parse(project.systemMap),
          builtAt: project.systemMapBuiltAt,
        }
      } catch {
        return null
      }
    }),

  /**
   * Regenerate the system map without a full brain rebuild.
   * Uses existing architecture memories.
   */
  regenerateSystemMap: publicProcedure
    .input(z.object({
      projectId: z.string(),
      projectPath: z.string(),
    }))
    .mutation(async ({ input }) => {
      const { getClaudeCodeTokenFresh } = await import("./claude")
      const { synthesizeSystemMap } = await import("../../ambient/system-map-synthesis")

      const provider = await createAmbientProvider(
        () => getClaudeCodeTokenFresh(),
        null,
      )

      if (!provider) {
        return { success: false, error: "No AI provider available", zones: [] }
      }

      const zones = await synthesizeSystemMap(input.projectId, input.projectPath, provider)
      return { success: true, zones }
    }),

  // ============ SYSTEM MAP AUDIT ============

  /**
   * Audit all system map zones — uses the zone audit engine with project-level lock.
   */
  auditSystemMap: publicProcedure
    .input(z.object({
      projectId: z.string(),
      projectPath: z.string(),
    }))
    .mutation(async ({ input }) => {
      const { getClaudeCodeTokenFresh } = await import("./claude")
      const { auditAllZonesWithLock } = await import("../../ambient/zone-audit-engine")

      const provider = await createAmbientProvider(
        () => getClaudeCodeTokenFresh(),
        null,
      )

      if (!provider) {
        return { success: false, error: "No AI provider available", runId: "", zonesAudited: 0, totalFindings: 0, suggestionsCreated: 0, overallScore: 0, durationMs: 0 }
      }

      try {
        const result = await auditAllZonesWithLock(
          input.projectId,
          input.projectPath,
          provider,
          (progress, runId) => {
            ambientEvents.emit(`project:${input.projectId}`, {
              type: "audit-progress",
              runId,
              progress,
            })
          },
        )
        return { success: true, ...result }
      } catch (err: any) {
        return { success: false, error: err.message, runId: "", zonesAudited: 0, totalFindings: 0, suggestionsCreated: 0, overallScore: 0, durationMs: 0 }
      }
    }),

  /**
   * Audit a single zone — two-phase: auto-generate profile if needed, then execute.
   */
  auditZone: publicProcedure
    .input(z.object({
      projectId: z.string(),
      projectPath: z.string(),
      zoneId: z.string(),
    }))
    .mutation(async ({ input }) => {
      const { getClaudeCodeTokenFresh } = await import("./claude")
      const { auditZone } = await import("../../ambient/zone-audit-engine")

      const provider = await createAmbientProvider(
        () => getClaudeCodeTokenFresh(),
        null,
      )

      if (!provider) {
        return { success: false, error: "No AI provider available" }
      }

      try {
        const result = await auditZone(input.projectId, input.projectPath, input.zoneId, provider)
        return { success: true, ...result }
      } catch (err: any) {
        return { success: false, error: err.message }
      }
    }),

  /**
   * Cancel an in-progress audit run.
   */
  cancelAuditRun: publicProcedure
    .input(z.object({ runId: z.string() }))
    .mutation(({ input }) => {
      const { cancelAuditRun } = require("../../ambient/zone-audit-engine")
      return { cancelled: cancelAuditRun(input.runId) }
    }),

  /**
   * List audit runs for a project with optional zone filter. Cursor-based pagination.
   */
  listAuditRuns: publicProcedure
    .input(z.object({
      projectId: z.string(),
      zoneId: z.string().optional(),
      limit: z.number().optional().default(20),
      cursor: z.string().optional(), // runId for cursor-based pagination
    }))
    .query(({ input }) => {
      const db = getDatabase()
      const { auditRuns: ar, auditRunZones: arz, auditFindings: af } = require("../../db/schema")

      let runs = db.select()
        .from(ar)
        .where(eq(ar.projectId, input.projectId))
        .orderBy(desc(ar.createdAt))
        .limit(input.limit + 1)
        .all()

      // Cursor-based pagination
      if (input.cursor) {
        const cursorIdx = runs.findIndex((r: any) => r.id === input.cursor)
        if (cursorIdx >= 0) runs = runs.slice(cursorIdx + 1)
      }

      const hasMore = runs.length > input.limit
      if (hasMore) runs = runs.slice(0, input.limit)

      // Enrich with zone data
      const enriched = runs.map((run: any) => {
        const zones = db.select().from(arz).where(eq(arz.runId, run.id)).all()

        // Filter by zoneId if specified
        if (input.zoneId && !zones.some((z: any) => z.zoneId === input.zoneId)) return null

        return {
          ...run,
          partialErrors: run.partialErrors ? JSON.parse(run.partialErrors) : [],
          zones: zones.map((z: any) => ({ zoneId: z.zoneId, zoneName: z.zoneName, zoneScore: z.zoneScore })),
        }
      }).filter(Boolean)

      return { runs: enriched, hasMore, nextCursor: hasMore ? runs[runs.length - 1]?.id : undefined }
    }),

  /**
   * Get a single audit run with all its findings.
   */
  getAuditRun: publicProcedure
    .input(z.object({ runId: z.string() }))
    .query(({ input }) => {
      const db = getDatabase()
      const { auditRuns: ar, auditRunZones: arz, auditFindings: af } = require("../../db/schema")

      const run = db.select().from(ar).where(eq(ar.id, input.runId)).get()
      if (!run) return null

      const zones = db.select().from(arz).where(eq(arz.runId, input.runId)).all()
      const findings = db.select().from(af).where(eq(af.runId, input.runId)).orderBy(desc(af.createdAt)).all()

      return {
        ...run,
        partialErrors: run.partialErrors ? JSON.parse(run.partialErrors) : [],
        zones: zones.map((z: any) => ({ zoneId: z.zoneId, zoneName: z.zoneName, zoneScore: z.zoneScore })),
        findings: findings.map((f: any) => ({
          ...f,
          affectedFiles: f.affectedFiles ? JSON.parse(f.affectedFiles) : [],
        })),
      }
    }),

  /**
   * List audit findings with server-side filtering and pagination.
   */
  listAuditFindings: publicProcedure
    .input(z.object({
      projectId: z.string(),
      zoneId: z.string().optional(),
      category: z.string().optional(),
      severity: z.string().optional(),
      status: z.string().optional().default("open"),
      limit: z.number().optional().default(50),
      cursor: z.string().optional(),
    }))
    .query(({ input }) => {
      const db = getDatabase()
      const { auditFindings: af } = require("../../db/schema")

      const conditions = [eq(af.projectId, input.projectId)]
      if (input.status) conditions.push(eq(af.status, input.status))
      if (input.zoneId) conditions.push(eq(af.zoneId, input.zoneId))
      if (input.category) conditions.push(eq(af.category, input.category))
      if (input.severity) conditions.push(eq(af.severity, input.severity))

      let results = db.select()
        .from(af)
        .where(and(...conditions))
        .orderBy(desc(af.createdAt))
        .limit(input.limit + 1)
        .all()

      if (input.cursor) {
        const idx = results.findIndex((r: any) => r.id === input.cursor)
        if (idx >= 0) results = results.slice(idx + 1)
      }

      const hasMore = results.length > input.limit
      if (hasMore) results = results.slice(0, input.limit)

      return {
        findings: results.map((f: any) => ({
          ...f,
          affectedFiles: f.affectedFiles ? JSON.parse(f.affectedFiles) : [],
        })),
        hasMore,
        nextCursor: hasMore ? results[results.length - 1]?.id : undefined,
      }
    }),

  /**
   * Resolve an audit finding — creates sub-chat with fix prompt, marks resolved.
   */
  resolveAuditFinding: publicProcedure
    .input(z.object({
      findingId: z.string(),
      chatId: z.string(),
    }))
    .mutation(({ input }) => {
      const db = getDatabase()
      const { auditFindings: af } = require("../../db/schema")

      const finding = db.select().from(af).where(eq(af.id, input.findingId)).get()
      if (!finding) return { success: false, subChatId: null }

      // Create sub-chat with suggestedPrompt pre-filled (AI SDK message format)
      const subChatId = createId()
      const findingPrompt = finding.suggestedPrompt || `Fix: ${finding.title}\n\n${finding.description}`
      const findingTabName = finding.title.length > 60
        ? finding.title.slice(0, 57) + "..."
        : finding.title
      db.insert(subChats).values({
        id: subChatId,
        name: findingTabName,
        chatId: input.chatId,
        mode: "agent",
        messages: JSON.stringify([{
          id: `msg-${Date.now()}`,
          role: "user",
          parts: [{ type: "text", text: findingPrompt }],
        }]),
      }).run()

      // Mark finding resolved
      db.update(af).set({
        status: "resolved",
        resolvedSubChatId: subChatId,
        resolvedAt: new Date(),
      }).where(eq(af.id, input.findingId)).run()

      // Also mark the linked ambientSuggestion as approved
      if (finding.suggestionId) {
        db.update(ambientSuggestions).set({
          status: "approved",
          approvedAt: new Date(),
          resolvedSubChatId: subChatId,
        }).where(eq(ambientSuggestions.id, finding.suggestionId)).run()
      }

      // Emit event
      ambientEvents.emit(`project:${finding.projectId}`, {
        type: "finding-resolved",
        findingId: input.findingId,
        subChatId,
      })

      return { success: true, subChatId }
    }),

  /**
   * Dismiss an audit finding with reason.
   */
  dismissAuditFinding: publicProcedure
    .input(z.object({
      findingId: z.string(),
      reason: z.enum(["not-relevant", "already-handled", "wrong"]),
    }))
    .mutation(({ input }) => {
      const db = getDatabase()
      const { auditFindings: af } = require("../../db/schema")

      const finding = db.select().from(af).where(eq(af.id, input.findingId)).get()
      if (!finding) return { success: false }

      db.update(af).set({
        status: "dismissed",
        dismissReason: input.reason,
      }).where(eq(af.id, input.findingId)).run()

      // Also dismiss linked suggestion
      if (finding.suggestionId) {
        db.update(ambientSuggestions).set({
          status: "dismissed",
          dismissReason: input.reason,
          dismissedAt: new Date(),
        }).where(eq(ambientSuggestions.id, finding.suggestionId)).run()
      }

      return { success: true }
    }),

  // ============ AUDIT PROFILES ============

  listAuditProfiles: publicProcedure
    .input(z.object({ projectId: z.string() }))
    .query(({ input }) => {
      const db = getDatabase()
      const { auditProfiles: ap } = require("../../db/schema")

      return db.select().from(ap)
        .where(eq(ap.projectId, input.projectId))
        .orderBy(desc(ap.updatedAt))
        .all()
        .map((p: any) => ({
          ...p,
          zoneIds: p.zoneIds ? JSON.parse(p.zoneIds) : null,
          zoneNames: p.zoneNames ? JSON.parse(p.zoneNames) : null,
          categories: p.categories ? JSON.parse(p.categories) : [],
          isAutoGenerated: !!p.isAutoGenerated,
        }))
    }),

  createAuditProfile: publicProcedure
    .input(z.object({
      projectId: z.string(),
      name: z.string(),
      description: z.string().optional().default(""),
      zoneIds: z.array(z.string()).nullable().optional(),
      zoneNames: z.array(z.string()).nullable().optional(),
      categories: z.array(z.string()),
      severityThreshold: z.enum(["info", "warning", "error"]).optional().default("info"),
      customPromptAppend: z.string().optional().default(""),
      schedule: z.enum(["manual", "on-commit", "daily"]).optional().default("manual"),
    }))
    .mutation(({ input }) => {
      const db = getDatabase()
      const { auditProfiles: ap } = require("../../db/schema")
      const id = createId()

      db.insert(ap).values({
        id,
        projectId: input.projectId,
        name: input.name,
        description: input.description,
        zoneIds: input.zoneIds ? JSON.stringify(input.zoneIds) : null,
        zoneNames: input.zoneNames ? JSON.stringify(input.zoneNames) : null,
        categories: JSON.stringify(input.categories),
        severityThreshold: input.severityThreshold,
        customPromptAppend: input.customPromptAppend,
        schedule: input.schedule,
      }).run()

      return { id }
    }),

  updateAuditProfile: publicProcedure
    .input(z.object({
      profileId: z.string(),
      name: z.string().optional(),
      description: z.string().optional(),
      zoneIds: z.array(z.string()).nullable().optional(),
      zoneNames: z.array(z.string()).nullable().optional(),
      categories: z.array(z.string()).optional(),
      severityThreshold: z.enum(["info", "warning", "error"]).optional(),
      customPromptAppend: z.string().optional(),
      schedule: z.enum(["manual", "on-commit", "daily"]).optional(),
    }))
    .mutation(({ input }) => {
      const db = getDatabase()
      const { auditProfiles: ap } = require("../../db/schema")
      const { profileId, ...updates } = input

      const setValues: Record<string, any> = { updatedAt: new Date() }
      if (updates.name !== undefined) setValues.name = updates.name
      if (updates.description !== undefined) setValues.description = updates.description
      if (updates.zoneIds !== undefined) setValues.zoneIds = updates.zoneIds ? JSON.stringify(updates.zoneIds) : null
      if (updates.zoneNames !== undefined) setValues.zoneNames = updates.zoneNames ? JSON.stringify(updates.zoneNames) : null
      if (updates.categories !== undefined) setValues.categories = JSON.stringify(updates.categories)
      if (updates.severityThreshold !== undefined) setValues.severityThreshold = updates.severityThreshold
      if (updates.customPromptAppend !== undefined) setValues.customPromptAppend = updates.customPromptAppend
      if (updates.schedule !== undefined) setValues.schedule = updates.schedule

      db.update(ap).set(setValues).where(eq(ap.id, profileId)).run()
      return { success: true }
    }),

  deleteAuditProfile: publicProcedure
    .input(z.object({ profileId: z.string() }))
    .mutation(({ input }) => {
      const db = getDatabase()
      const { auditProfiles: ap } = require("../../db/schema")
      db.delete(ap).where(eq(ap.id, input.profileId)).run()
      return { success: true }
    }),

  // ============ AUDIT TRENDS ============

  getAuditTrends: publicProcedure
    .input(z.object({
      projectId: z.string(),
      zoneId: z.string().optional(),
      limit: z.number().optional().default(10),
    }))
    .query(({ input }) => {
      const db = getDatabase()
      const { auditRunZones: arz, auditRuns: ar } = require("../../db/schema")

      // Get all zones that have been audited
      let zoneRows: any[]
      if (input.zoneId) {
        zoneRows = db.select()
          .from(arz)
          .innerJoin(ar, eq(arz.runId, ar.id))
          .where(and(eq(ar.projectId, input.projectId), eq(arz.zoneId, input.zoneId)))
          .orderBy(desc(ar.createdAt))
          .limit(input.limit)
          .all()
      } else {
        zoneRows = db.select()
          .from(arz)
          .innerJoin(ar, eq(arz.runId, ar.id))
          .where(eq(ar.projectId, input.projectId))
          .orderBy(desc(ar.createdAt))
          .all()
      }

      // Group by zoneId, take last N scores
      const zoneMap = new Map<string, { zoneName: string; scores: number[] }>()
      for (const row of zoneRows) {
        const z = row.audit_run_zones
        if (!zoneMap.has(z.zoneId)) {
          zoneMap.set(z.zoneId, { zoneName: z.zoneName, scores: [] })
        }
        const entry = zoneMap.get(z.zoneId)!
        if (entry.scores.length < input.limit) {
          entry.scores.push(z.zoneScore)
        }
      }

      // Build trends
      const trends = Array.from(zoneMap.entries()).map(([zoneId, data]) => {
        const scores = data.scores.reverse() // oldest first
        const currentScore = scores.length > 0 ? scores[scores.length - 1] : 0
        const prevScore = scores.length > 1 ? scores[scores.length - 2] : currentScore
        const trend = currentScore > prevScore + 5 ? "up" as const
          : currentScore < prevScore - 5 ? "down" as const
          : "stable" as const

        return { zoneId, zoneName: data.zoneName, currentScore, scores, trend }
      })

      // Overall project score
      const overallScore = trends.length > 0
        ? Math.round(trends.reduce((sum, t) => sum + t.currentScore, 0) / trends.length)
        : 0

      return { trends, overallScore }
    }),

  // ============ SUBSCRIPTIONS ============

  /**
   * Real-time subscription for ambient events (new suggestions, dismissals, budget warnings).
   */
  onUpdate: publicProcedure
    .input(z.object({ projectId: z.string() }))
    .subscription(({ input }) => {
      return observable<{
        type: string
        suggestionId?: string
        subChatId?: string
        runId?: string
        progress?: Array<{
          zoneId: string
          zoneName: string
          status: "pending" | "profiling" | "auditing" | "done" | "error"
          findings: number
          errorMessage?: string
        }>
        suggestion?: {
          id: string
          category: string
          severity: string
          title: string
          confidence: number
        }
      }>((emit) => {
        const handler = (data: any) => {
          emit.next(data)
        }

        ambientEvents.on(`project:${input.projectId}`, handler)

        return () => {
          ambientEvents.off(`project:${input.projectId}`, handler)
        }
      })
    }),
})
