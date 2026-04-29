/**
 * Ambient Background Agent tRPC router — queries, mutations, and subscription
 * for managing the ambient agent, its suggestions, and budget.
 */

import { z } from "zod"
import { router, publicProcedure } from "../index"
import { getDatabase } from "../../db"
import { ambientSuggestions, ambientBudget, ambientFeedback, maintenanceActions, subChats, projects } from "../../db/schema"
import { eq, and, desc, sql, inArray } from "drizzle-orm"
import { observable } from "@trpc/server/observable"
import { EventEmitter } from "events"
import { ambientAgentRegistry, PROCESS_START_TIME } from "../../ambient"
import { createAmbientProvider } from "../../ambient/provider"
import { buildBrain, refreshBrain, getBrainStatus } from "../../ambient/backfill"
import { trimMemories } from "../../ambient/memory-cycling"
import { getCategoryHealthReport } from "../../memory/category-balance"
import { getIdentity, refreshIdentity, saveIdentityManual } from "../../ambient/project-identity"
import { createId } from "../../db/utils"

// Event emitter for real-time suggestion notifications
export const ambientEvents = new EventEmitter()
ambientEvents.setMaxListeners(50)

// Rate limiter for Ask GAAD: Map<projectId, timestamp[]>
const askGAADRateLimit = new Map<string, number[]>()

const ASK_GAAD_SYSTEM_PROMPT = `You are GAAD — the developer's institutional memory and senior advisor for this project. You have access to everything the team has learned, decided, and built.

INTENT CLASSIFICATION:
If the user is asking you to plan, break down, decompose, design an approach for, or orchestrate a multi-step project or task — respond with EXACTLY the line "[PLAN_REQUEST]" on the first line, followed by a clean, actionable version of their goal on the next line. Do NOT answer the question in this case — just output the classification and goal.

Otherwise, answer their question normally using the rules below.

ANSWER RULES:
- Answer using ONLY what you know from the project memories and recent activity below. If you don't have enough information, say so — never hallucinate or guess.
- Direct, concise, confident
- Cite specific memories/decisions when relevant
- Connect dots between different memories when the question spans topics
- If the question is about brand/design/strategy, match the team's established voice and framing

Format: Plain text, 1-3 paragraphs max. No JSON. No markdown headers. Just talk.`

const suggestionCategoryEnum = z.enum([
  "bug", "security", "performance", "test-gap", "dead-code", "dependency",
])

const suggestionStatusEnum = z.enum([
  "pending", "dismissed", "approved", "snoozed", "expired",
])

/**
 * Initialize provider with background recovery. If the initial 3-attempt init fails
 * (e.g., auth not ready yet), schedule a retry in 60s and 5min. Without a provider,
 * GAAD runs Tier 0 only (heuristics) and produces zero AI analysis.
 */
function initProviderWithRecovery(agent: ReturnType<typeof ambientAgentRegistry.get> & {}) {
  const RECOVERY_DELAYS = [0, 60_000, 300_000] // immediate (3 internal retries), then 60s, 5min

  async function attempt(delayIndex: number) {
    try {
      const { getClaudeCodeTokenFresh } = await import("./claude")
      await agent.initProvider(
        () => getClaudeCodeTokenFresh(),
        null,
      )
      // Success — provider is set
    } catch (err: any) {
      const nextDelay = RECOVERY_DELAYS[delayIndex + 1]
      if (nextDelay !== undefined) {
        console.warn(`[GAAD] Provider init failed, recovery retry in ${nextDelay / 1000}s:`, err.message)
        setTimeout(() => {
          // Check agent is still running before retrying
          if (agent.getStatus().agentStatus === "running") {
            attempt(delayIndex + 1).catch(() => {})
          }
        }, nextDelay)
      } else {
        console.error("[GAAD] Provider init failed after all recovery attempts. Tier 0 only until restart.")
      }
    }
  }

  attempt(0).catch(() => {})
}

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
   * Get memory category coverage health report.
   */
  memoryCoverage: publicProcedure
    .input(z.object({ projectId: z.string() }))
    .query(({ input }) => {
      return getCategoryHealthReport(input.projectId)
    }),

  // ─── Project Identity ───────────────────────────────────────────────

  /**
   * Get the project identity/overview document.
   */
  getProjectIdentity: publicProcedure
    .input(z.object({ projectId: z.string() }))
    .query(({ input }) => {
      const identity = getIdentity(input.projectId)
      if (!identity) return null
      return {
        content: identity.content,
        source: identity.source,
        updatedAt: identity.updatedAt?.toISOString() ?? null,
      }
    }),

  /**
   * Save user's manual edits to the project overview.
   */
  updateProjectIdentity: publicProcedure
    .input(z.object({
      projectId: z.string(),
      content: z.string().min(10),
    }))
    .mutation(({ input }) => {
      saveIdentityManual(input.projectId, input.content)
      return { success: true }
    }),

  /**
   * Re-generate the project overview from current project state.
   */
  refreshProjectIdentity: publicProcedure
    .input(z.object({
      projectId: z.string(),
      projectPath: z.string(),
    }))
    .mutation(async ({ input }) => {
      const success = await refreshIdentity(input.projectId, input.projectPath, true)
      if (!success) return { success: false, error: "Failed to synthesize identity" }
      const identity = getIdentity(input.projectId)
      return {
        success: true,
        content: identity?.content ?? null,
      }
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
          initProviderWithRecovery(agent)
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

      // Check if already running — but recreate if agent is stale (from before app restart)
      const existing = ambientAgentRegistry.get(input.projectId)
      if (existing) {
        if (existing.createdAt >= PROCESS_START_TIME) {
          return { status: "running" as const }
        }
        // Stale agent from before restart — recreate with fresh code
        console.log(`[Ambient] Recycling stale agent for ${input.projectId} (created ${new Date(existing.createdAt).toISOString()}, process started ${new Date(PROCESS_START_TIME).toISOString()})`)
        await ambientAgentRegistry.stop(input.projectId).catch(() => {})
      }

      try {
        const agent = await ambientAgentRegistry.getOrCreate(input.projectId, input.projectPath)
        // Init provider in background with recovery
        initProviderWithRecovery(agent)
        return { status: "running" as const }
      } catch (err) {
        console.error("[Ambient] Auto-start failed:", err)
        return { status: "error" as const }
      }
    }),

  /**
   * Force-restart the ambient agent for a project.
   * Destroys the old instance and creates a fresh one with current code.
   * Use after code changes in dev, or when GAAD seems stuck.
   */
  restart: publicProcedure
    .input(z.object({
      projectId: z.string(),
      projectPath: z.string(),
    }))
    .mutation(async ({ input }) => {
      // Stop and remove old agent (don't let stop errors block restart)
      try {
        await ambientAgentRegistry.stop(input.projectId)
      } catch (err) {
        console.warn("[Ambient] Stop during restart failed (continuing):", err)
      }
      console.log(`[Ambient] Force-restarting agent for project ${input.projectId}`)

      try {
        const agent = await ambientAgentRegistry.getOrCreate(input.projectId, input.projectPath)
        initProviderWithRecovery(agent)
        return { status: "restarted" as const }
      } catch (err) {
        console.error("[Ambient] Restart failed:", err)
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

      // Short tab name: category prefix + truncated title (~30 chars)
      const categoryPrefix = suggestion.category === "bug" ? "Fix: "
        : suggestion.category === "security" ? "Sec: "
        : suggestion.category === "performance" ? "Perf: "
        : suggestion.category === "test-gap" ? "Test: "
        : suggestion.category === "dead-code" ? "Clean: "
        : suggestion.category === "dependency" ? "Dep: "
        : suggestion.category === "blind-spot" ? "Check: "
        : suggestion.category === "next-step" ? "Next: "
        : suggestion.category === "risk" ? "Risk: "
        : ""
      const cleanedTitle = suggestion.title
        .replace(/^(Remember|Note|Warning|Important):\s*/i, "")
        .replace(/\s*[-—–]\s*.+$/, "")
      const maxBody = 30 - categoryPrefix.length
      const tabName = cleanedTitle.length <= maxBody
        ? categoryPrefix + cleanedTitle
        : categoryPrefix + cleanedTitle.slice(0, maxBody - 1).trimEnd() + "…"

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
        // Pass budget tracker so audit spend is tracked against daily limits
        const agent = ambientAgentRegistry.get(input.projectId)
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
          agent?.budget,
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
        const agent = ambientAgentRegistry.get(input.projectId)
        const result = await auditZone(input.projectId, input.projectPath, input.zoneId, provider, agent?.budget)
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

      // Finalize stale ambient runs from previous days so they show as completed
      const today = new Date().toISOString().slice(0, 10)
      const staleAmbientRuns = db.select({ id: ar.id, startedAt: ar.startedAt, createdAt: ar.createdAt })
        .from(ar)
        .where(and(eq(ar.projectId, input.projectId), eq(ar.trigger, "ambient"), eq(ar.status, "running")))
        .all()
      for (const stale of staleAmbientRuns) {
        const d = stale.startedAt ?? stale.createdAt
        const runDate = d ? new Date(typeof d === "number" ? d : d).toISOString().slice(0, 10) : null
        if (runDate && runDate < today) {
          // Finalize: count findings and mark completed
          const counts = db.select({ severity: af.severity, count: sql<number>`count(*)` })
            .from(af).where(eq(af.runId, stale.id)).groupBy(af.severity).all()
          let total = 0, errors = 0, warnings = 0, infos = 0
          for (const c of counts) {
            total += c.count
            if (c.severity === "error") errors = c.count
            else if (c.severity === "warning") warnings = c.count
            else if (c.severity === "info") infos = c.count
          }
          db.update(ar).set({
            status: "completed", completedAt: new Date(),
            totalFindings: total, errorCount: errors, warningCount: warnings, infoCount: infos,
            overallScore: Math.max(0, 100 - (errors * 15 + warnings * 5 + infos * 1)),
          }).where(eq(ar.id, stale.id)).run()
        }
      }

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

      // Batch-fetch all zones for these runs in a single query (avoids N+1)
      const runIds = runs.map((r: any) => r.id)
      const allZones = runIds.length > 0
        ? db.select().from(arz).where(inArray(arz.runId, runIds)).all()
        : []
      const zonesByRunId = new Map<string, any[]>()
      for (const z of allZones) {
        let arr = zonesByRunId.get(z.runId)
        if (!arr) { arr = []; zonesByRunId.set(z.runId, arr) }
        arr.push({ zoneId: z.zoneId, zoneName: z.zoneName, zoneScore: z.zoneScore })
      }

      // Enrich with zone data
      const enriched = runs.map((run: any) => {
        const zones = zonesByRunId.get(run.id) ?? []

        // Filter by zoneId if specified
        if (input.zoneId && !zones.some((z: any) => z.zoneId === input.zoneId)) return null

        return {
          ...run,
          partialErrors: run.partialErrors ? JSON.parse(run.partialErrors) : [],
          zones,
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
   * Per-zone summary of open audit findings — single query, no file matching.
   * Used by zone cards to show issue counts from the canonical auditFindings table.
   */
  getZoneFindingSummary: publicProcedure
    .input(z.object({ projectId: z.string() }))
    .query(({ input }) => {
      const db = getDatabase()
      const { auditFindings: af } = require("../../db/schema")

      // Aggregate open findings by zone
      const rows = db.select({
        zoneId: af.zoneId,
        zoneName: af.zoneName,
        severity: af.severity,
        count: sql<number>`count(*)`,
        avgConfidence: sql<number>`avg(${af.confidence})`,
        lastCreatedAt: sql<string>`max(${af.createdAt})`,
      })
        .from(af)
        .where(and(eq(af.projectId, input.projectId), eq(af.status, "open")))
        .groupBy(af.zoneId, af.severity)
        .all()

      // Collapse severity groups into per-zone summary
      const zones: Record<string, {
        issueCount: number
        maxSeverity: string
        avgConfidence: number
        lastAuditedAt: string | null
      }> = {}

      const severityOrder: Record<string, number> = { error: 3, warning: 2, info: 1, none: 0 }

      for (const row of rows) {
        if (!zones[row.zoneId]) {
          zones[row.zoneId] = { issueCount: 0, maxSeverity: "none", avgConfidence: 0, lastAuditedAt: null }
        }
        const z = zones[row.zoneId]
        z.issueCount += row.count
        if ((severityOrder[row.severity] ?? 0) > (severityOrder[z.maxSeverity] ?? 0)) {
          z.maxSeverity = row.severity
        }
        // Weighted average confidence
        const prevTotal = z.avgConfidence * (z.issueCount - row.count)
        z.avgConfidence = Math.round((prevTotal + row.avgConfidence * row.count) / z.issueCount)
        // Latest timestamp
        const ts = row.lastCreatedAt ? String(row.lastCreatedAt) : null
        if (ts && (!z.lastAuditedAt || ts > z.lastAuditedAt)) {
          z.lastAuditedAt = ts
        }
      }

      return zones
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
        actionId?: string
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
        // Batch rapid-fire events into 50ms windows to reduce IPC overhead
        let pending: any[] = []
        let timer: ReturnType<typeof setTimeout> | null = null

        const flush = () => {
          timer = null
          const batch = pending
          pending = []
          for (const item of batch) emit.next(item)
        }

        const handler = (data: any) => {
          pending.push(data)
          if (!timer) timer = setTimeout(flush, 50)
        }

        ambientEvents.on(`project:${input.projectId}`, handler)

        return () => {
          ambientEvents.off(`project:${input.projectId}`, handler)
          if (timer) { clearTimeout(timer); flush() }
        }
      })
    }),

  // ============ MAINTENANCE ACTIONS ============

  /**
   * List pending maintenance actions for a project.
   */
  listMaintenanceActions: publicProcedure
    .input(z.object({ projectId: z.string() }))
    .query(({ input }) => {
      const db = getDatabase()
      return db.select()
        .from(maintenanceActions)
        .where(and(
          eq(maintenanceActions.projectId, input.projectId),
          eq(maintenanceActions.status, "pending"),
        ))
        .orderBy(desc(maintenanceActions.createdAt))
        .limit(5) // G6: max 5 pending per project
        .all()
    }),

  /**
   * Approve a maintenance action — executes the action.
   */
  approveMaintenanceAction: publicProcedure
    .input(z.object({
      actionId: z.string(),
      projectId: z.string(),
      projectPath: z.string(),
    }))
    .mutation(async ({ input }) => {
      const db = getDatabase()
      const action = db.select()
        .from(maintenanceActions)
        .where(eq(maintenanceActions.id, input.actionId))
        .get()

      if (!action || action.status !== "pending") {
        return { success: false, error: "Action not found or already processed" }
      }

      // Mark as approved
      db.update(maintenanceActions)
        .set({ status: "approved" })
        .where(eq(maintenanceActions.id, input.actionId))
        .run()

      try {
        // Execute based on type
        if (action.type === "refresh-system-map") {
          // Trigger system map regeneration
          const agent = ambientAgentRegistry.get(input.projectId)
          if (agent) {
            const { synthesizeSystemMap } = await import("../../ambient/system-map-synthesis")
            const { getClaudeCodeTokenFresh } = await import("./claude")
            const provider = await createAmbientProvider(() => getClaudeCodeTokenFresh(), null)
            if (provider) {
              await synthesizeSystemMap(input.projectId, input.projectPath, provider)
            }
          }
        } else if (action.type === "update-memory") {
          // Memory was already written with source="suggested" — promote to active
          const details = action.details ? JSON.parse(action.details) : {}
          if (details.memoryId) {
            const { projectMemories } = await import("../../db/schema")
            db.update(projectMemories)
              .set({ source: "auto", relevanceScore: 50 })
              .where(eq(projectMemories.id, details.memoryId))
              .run()
          }
        } else if (action.type === "run-zone-audit") {
          const details = action.details ? JSON.parse(action.details) : {}
          if (details.zoneId) {
            const { auditZone } = await import("../../ambient/zone-audit-engine")
            const { getClaudeCodeTokenFresh } = await import("./claude")
            const provider = await createAmbientProvider(() => getClaudeCodeTokenFresh(), null)
            if (provider) {
              const agent = ambientAgentRegistry.get(input.projectId)
              await auditZone(input.projectId, input.projectPath, details.zoneId, provider, agent?.budget)
            }
          }
        } else if (action.type === "enrich-memory") {
          // Merge new content into existing memory, boost score, increment validationCount
          const details = action.details ? JSON.parse(action.details) : {}
          if (details.existingMemoryId && details.newContent) {
            const { enrichMemory } = await import("../../ambient/memory-evolution")
            await enrichMemory(details.existingMemoryId, details.newContent)
          }
        } else if (action.type === "archive-stale-memory") {
          const details = action.details ? JSON.parse(action.details) : {}
          if (details.memoryId) {
            const { projectMemories } = await import("../../db/schema")
            db.update(projectMemories)
              .set({ isArchived: true, state: "dead" })
              .where(eq(projectMemories.id, details.memoryId))
              .run()
          }
        }

        // Mark completed
        db.update(maintenanceActions)
          .set({ status: "completed", completedAt: new Date() })
          .where(eq(maintenanceActions.id, input.actionId))
          .run()

        // Emit event so frontend can update
        ambientEvents.emit(`project:${input.projectId}`, {
          type: "maintenance-action-completed",
          actionId: input.actionId,
        })

        return { success: true }
      } catch (err: any) {
        db.update(maintenanceActions)
          .set({ status: "failed" })
          .where(eq(maintenanceActions.id, input.actionId))
          .run()
        return { success: false, error: err.message }
      }
    }),

  /**
   * Deny a maintenance action — dismiss without executing.
   */
  denyMaintenanceAction: publicProcedure
    .input(z.object({
      actionId: z.string(),
      projectId: z.string(),
    }))
    .mutation(({ input }) => {
      const db = getDatabase()
      db.update(maintenanceActions)
        .set({ status: "denied" })
        .where(eq(maintenanceActions.id, input.actionId))
        .run()

      ambientEvents.emit(`project:${input.projectId}`, {
        type: "maintenance-action-denied",
        actionId: input.actionId,
      })

      return { success: true }
    }),

  // ============ ASK GAAD ============

  /**
   * Ask GAAD a question — queries memory bank + recent suggestions and returns
   * a grounded answer. Uses Sonnet for quality since this is user-initiated.
   */
  askGAAD: publicProcedure
    .input(z.object({
      projectId: z.string(),
      question: z.string().min(1).max(2000),
    }))
    .mutation(async ({ input }) => {
      console.log(`[askGAAD] Question received for project ${input.projectId}: "${input.question.slice(0, 100)}"`)

      // Rate limiting: max 10 calls per hour per project
      const now = Date.now()
      const projectCalls = askGAADRateLimit.get(input.projectId) ?? []
      const recentCalls = projectCalls.filter(t => now - t < 3600_000)
      if (recentCalls.length >= 10) {
        console.log("[askGAAD] Rate limited")
        return { answer: "Rate limit reached — GAAD can answer up to 10 questions per hour. Try again later." }
      }
      recentCalls.push(now)
      askGAADRateLimit.set(input.projectId, recentCalls)

      try {
        // 1. Load project memories with full budget (user-initiated, not background)
        const { getMemoriesForInjection } = await import("../../memory/injection")
        console.log("[askGAAD] Loading memories...")
        const memoryResult = await getMemoriesForInjection(input.projectId, input.question, 8000)
        console.log(`[askGAAD] Loaded ${memoryResult.memoriesUsed} memories (${memoryResult.tokensUsed} tokens)`)

        // 2. Load open audit findings (canonical source of project health)
        const { getAuditFindingsForInjection } = await import("../../audit/injection")
        const auditResult = getAuditFindingsForInjection(input.projectId, null, 1000)
        console.log(`[askGAAD] Loaded ${auditResult.findingsUsed} audit findings (${auditResult.tokensUsed} tokens)`)

        // 3. Build the user prompt with context
        const auditContext = auditResult.markdown ? `\n\n${auditResult.markdown}` : ""

        const userPrompt = `${memoryResult.markdown}${auditContext}\n\n## Question\n${input.question}`

        // 4. Call Claude with advisor prompt
        console.log("[askGAAD] Calling Claude (sonnet)...")
        const { callClaude } = await import("../../claude/api")
        const result = await callClaude({
          system: ASK_GAAD_SYSTEM_PROMPT,
          userMessage: userPrompt,
          maxTokens: 2048,
          timeoutMs: 60_000,
          model: "sonnet",
        })

        console.log(`[askGAAD] Got response (${result.text.length} chars, ${result.inputTokens}in/${result.outputTokens}out)`)
        return { answer: result.text }
      } catch (err: any) {
        const msg = err?.message ?? String(err)
        console.error("[askGAAD] Failed:", msg, err?.stack)

        // Give the user a useful error instead of a generic message
        if (msg.includes("token") || msg.includes("auth") || msg.includes("credential") || msg.includes("401")) {
          return { answer: "GAAD couldn't process your question — not connected to Claude. Check Settings → Claude Code." }
        }
        if (msg.includes("timeout") || msg.includes("ETIMEDOUT")) {
          return { answer: "GAAD's request timed out. Try a shorter question or try again." }
        }
        return { answer: `GAAD hit an error: ${msg.slice(0, 200)}` }
      }
    }),
})
