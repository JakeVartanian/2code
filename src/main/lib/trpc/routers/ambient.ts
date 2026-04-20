/**
 * Ambient Background Agent tRPC router — queries, mutations, and subscription
 * for managing the ambient agent, its suggestions, and budget.
 */

import { z } from "zod"
import { router, publicProcedure } from "../index"
import { getDatabase } from "../../db"
import { ambientSuggestions, ambientBudget, ambientFeedback, subChats } from "../../db/schema"
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
        dailyLimitCents: 50,
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
        budget: { dailyLimitCents: 50, haikuRateLimit: 20, sonnetRateLimit: 5 },
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
        await ambientAgentRegistry.getOrCreate(input.projectId, input.projectPath)
      } else {
        await ambientAgentRegistry.stop(input.projectId)
      }
      return { enabled: input.enabled }
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
      const initialMessages = suggestion.suggestedPrompt
        ? JSON.stringify([{
            role: "user",
            content: suggestion.suggestedPrompt,
          }])
        : "[]"

      db.insert(subChats)
        .values({
          id: subChatId,
          name: suggestion.title,
          chatId: input.chatId,
          mode: "agent",
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
      // Get or create provider
      const { getClaudeCodeTokenFresh } = require("./claude")
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
      const { getClaudeCodeTokenFresh } = require("./claude")
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
