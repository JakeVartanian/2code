/**
 * Orchestration tRPC router — manages multi-agent task decomposition,
 * worker tab spawning, dependency management, and result aggregation.
 */

import { z } from "zod"
import { router, publicProcedure } from "../index"
import { getDatabase } from "../../db"
import {
  orchestrationRuns,
  orchestrationTasks,
  subChats,
  chats,
  projects,
} from "../../db/schema"
import { eq, and, desc, inArray } from "drizzle-orm"
import { createId } from "../../db/utils"
import { observable } from "@trpc/server/observable"
import { EventEmitter } from "events"
import { decomposeGoal } from "../../orchestration/decompose"
import { abortClaudeSession } from "./claude"
import { checkStuckWorkers as checkStuck, diagnoseStuckWorker } from "../../orchestration/supervisor"
import { runQualityGate as runGate, loadOrchestratorConfig, runAfterTaskGates, runAfterAllGates, detectDefaultGates } from "../../orchestration/quality-gates"
import { aggregateResults } from "../../orchestration/aggregation"
import { getMemoriesForInjection } from "../../memory/injection"

// Global event bus for orchestration updates
const orchestrationEvents = new EventEmitter()
orchestrationEvents.setMaxListeners(50)

const taskStatusEnum = z.enum([
  "pending",
  "blocked",
  "queued",
  "running",
  "validating",
  "completed",
  "failed",
  "skipped",
  "stuck",
])

const runStatusEnum = z.enum([
  "planning",
  "running",
  "paused",
  "validating",
  "completed",
  "failed",
  "cancelled",
])

const autonomyEnum = z.enum(["auto", "review", "supervised", "plan-only"])

/**
 * Classify a bash command by risk level for scope control.
 */
export function classifyBashCommand(command: string): "critical" | "high" | "medium" | "low" {
  const cmd = command.trim().toLowerCase()

  // CRITICAL — shell expansion bypass attempts (ANSI-C quoting, hex/octal escapes)
  // These can encode dangerous commands to evade regex classification
  if (/\$'[^']*\\x[0-9a-f]/i.test(cmd)) return "critical"  // $'\x72\x6d' = rm
  if (/\$'[^']*\\[0-7]{1,3}/.test(cmd)) return "critical"   // $'\162\155' = rm
  if (/\$'[^']*\\u[0-9a-f]/i.test(cmd)) return "critical"   // $'\u0072' unicode escape
  if (/\$\{[^}]*#/.test(cmd)) return "critical"              // ${var#pattern} parameter expansion tricks
  if (/\$\(\(.*\)\)/.test(cmd)) return "critical"            // $(( )) arithmetic expansion

  // CRITICAL — always blocked
  if (/git\s+push\s+.*--force/.test(cmd)) return "critical"
  if (/rm\s+-rf\s+\//.test(cmd)) return "critical"     // rm -rf / or rm -rf /anything
  if (/rm\s+-rf\s+~/.test(cmd)) return "critical"
  if (/rm\s+-rf\s+\*/.test(cmd)) return "critical"      // rm -rf *
  if (/drop\s+table/i.test(cmd)) return "critical"
  if (/drop\s+database/i.test(cmd)) return "critical"
  if (/sudo\s+rm/.test(cmd)) return "critical"
  if (/doas\s+rm/.test(cmd)) return "critical"           // doas (sudo alternative)
  if (/curl.*\|\s*(ba)?sh/.test(cmd)) return "critical"  // curl | bash/sh
  if (/wget.*\|\s*(ba)?sh/.test(cmd)) return "critical"  // wget | bash/sh
  if (/\|\s*(ba)?sh\s*$/.test(cmd)) return "critical"    // anything piped to sh/bash
  if (/mkfs\b/.test(cmd)) return "critical"              // format filesystem
  if (/dd\s+if=/.test(cmd)) return "critical"            // raw disk write
  if (/>\s*\/etc\//.test(cmd)) return "critical"         // overwrite system files
  if (/eval\s/.test(cmd)) return "critical"              // eval arbitrary code
  if (/\$\(.*rm\s/.test(cmd)) return "critical"          // command substitution with rm
  if (/`.*rm\s/.test(cmd)) return "critical"             // backtick substitution with rm
  if (/\b(bash|sh|zsh)\s+-c\s/.test(cmd)) return "critical"  // shell -c wrapper bypass
  if (/\benv\s+.*rm\b/.test(cmd)) return "critical"     // env wrapper bypass
  if (/\bxargs\s+.*rm\b/.test(cmd)) return "critical"   // xargs rm bypass
  if (/\bfind\b.*-delete\b/.test(cmd)) return "critical" // find -delete
  if (/\bperl\s+-e/.test(cmd)) return "critical"         // perl arbitrary exec
  if (/\bruby\s+-e/.test(cmd)) return "critical"         // ruby arbitrary exec
  if (/base64.*\|\s*(ba)?sh/.test(cmd)) return "critical" // encoded payload execution

  // HIGH — blocked by default, opt-in
  if (/rm\s+-rf/.test(cmd)) return "high"
  if (/rm\s+-r\s/.test(cmd)) return "high"               // recursive delete without force
  if (/git\s+reset\s+--hard/.test(cmd)) return "high"
  if (/git\s+clean\s+-f/.test(cmd)) return "high"
  if (/npm\s+uninstall/.test(cmd)) return "high"
  if (/bun\s+remove/.test(cmd)) return "high"
  if (/git\s+stash\s+drop/.test(cmd)) return "high"
  if (/git\s+branch\s+-[dD]/.test(cmd)) return "high"   // delete branches
  if (/chmod\s+777\s+\//.test(cmd)) return "high"        // dangerous root permissions
  if (/python[23]?\s+-c/.test(cmd)) return "high"        // arbitrary python exec
  if (/node\s+-e/.test(cmd)) return "high"               // arbitrary node exec

  // MEDIUM — logged, proceeds unless stricter config
  if (/npm\s+install/.test(cmd)) return "medium"
  if (/bun\s+(add|install)/.test(cmd)) return "medium"
  if (/yarn\s+add/.test(cmd)) return "medium"
  if (/pip\s+install/.test(cmd)) return "medium"

  return "low"
}

export const orchestrationRouter = router({
  /**
   * Get a full orchestration run with all its tasks.
   */
  getRun: publicProcedure
    .input(z.object({ runId: z.string() }))
    .query(({ input }) => {
      const db = getDatabase()
      const run = db
        .select()
        .from(orchestrationRuns)
        .where(eq(orchestrationRuns.id, input.runId))
        .get()

      if (!run) return null

      const tasks = db
        .select()
        .from(orchestrationTasks)
        .where(eq(orchestrationTasks.runId, input.runId))
        .orderBy(orchestrationTasks.sortOrder)
        .all()

      return { ...run, tasks }
    }),

  /**
   * Get active (non-terminal) runs for a workspace.
   */
  getActiveRuns: publicProcedure
    .input(z.object({ chatId: z.string() }))
    .query(({ input }) => {
      const db = getDatabase()
      return db
        .select()
        .from(orchestrationRuns)
        .where(
          and(
            eq(orchestrationRuns.chatId, input.chatId),
            inArray(orchestrationRuns.status, ["planning", "running", "paused", "validating"]),
          )
        )
        .orderBy(desc(orchestrationRuns.updatedAt))
        .all()
    }),

  /**
   * Get run history for a workspace (all runs, paginated).
   */
  getRunHistory: publicProcedure
    .input(
      z.object({
        chatId: z.string(),
        limit: z.number().optional().default(20),
        offset: z.number().optional().default(0),
      })
    )
    .query(({ input }) => {
      const db = getDatabase()
      return db
        .select()
        .from(orchestrationRuns)
        .where(eq(orchestrationRuns.chatId, input.chatId))
        .orderBy(desc(orchestrationRuns.updatedAt))
        .limit(input.limit)
        .offset(input.offset)
        .all()
    }),

  /**
   * Start a new orchestration run from a decomposed plan.
   */
  startRun: publicProcedure
    .input(
      z.object({
        chatId: z.string(),
        controllerSubChatId: z.string(),
        userGoal: z.string(),
        decomposedPlan: z.string(), // JSON
        preOrchestrationCommit: z.string().optional(),
        initialStatus: z.enum(["planning", "running"]).optional().default("running"),
        tasks: z.array(
          z.object({
            name: z.string(),
            description: z.string(),
            mode: z.enum(["plan", "agent"]).optional().default("agent"),
            sortOrder: z.number().optional().default(0),
            dependsOn: z.array(z.string()).optional(), // Task names for dependency resolution
            autonomy: autonomyEnum.optional().default("auto"),
            allowedPaths: z.array(z.string()).optional(),
            systemPromptAppend: z.string().optional(),
          })
        ),
      })
    )
    .mutation(({ input }) => {
      const db = getDatabase()

      // Validate: no duplicate task names (dependencies use names for resolution)
      const taskNames = input.tasks.map(t => t.name)
      const uniqueNames = new Set(taskNames)
      if (uniqueNames.size !== taskNames.length) {
        const dupes = taskNames.filter((name, i) => taskNames.indexOf(name) !== i)
        throw new Error(`Duplicate task names not allowed: ${[...new Set(dupes)].join(", ")}`)
      }

      // Validate: no circular dependencies (topological sort)
      const nameSet = new Set(taskNames)
      const adjList = new Map<string, string[]>()
      for (const task of input.tasks) {
        adjList.set(task.name, (task.dependsOn ?? []).filter(d => nameSet.has(d)))
      }
      // DFS cycle detection
      const WHITE = 0, GRAY = 1, BLACK = 2
      const color = new Map<string, number>()
      for (const name of taskNames) color.set(name, WHITE)
      function hasCycleDFS(node: string): boolean {
        color.set(node, GRAY)
        for (const dep of adjList.get(node) ?? []) {
          if (color.get(dep) === GRAY) return true // back edge = cycle
          if (color.get(dep) === WHITE && hasCycleDFS(dep)) return true
        }
        color.set(node, BLACK)
        return false
      }
      for (const name of taskNames) {
        if (color.get(name) === WHITE && hasCycleDFS(name)) {
          throw new Error("Circular dependency detected in task graph. Remove or reorder dependencies to break the cycle.")
        }
      }

      const runId = createId()
      const now = new Date()

      // Wrap entire run+task creation in a transaction (including active run guard)
      // to prevent concurrent startRun calls from creating duplicate active runs
      let run: any
      let taskCount = 0

      db.transaction((tx) => {
        // Guard: prevent multiple active runs for the same workspace (inside tx for atomicity)
        const existingActive = tx
          .select()
          .from(orchestrationRuns)
          .where(
            and(
              eq(orchestrationRuns.chatId, input.chatId),
              inArray(orchestrationRuns.status, ["planning", "running", "paused", "validating"]),
            )
          )
          .all()

        if (existingActive.length > 0) {
          throw new Error(`Workspace already has an active orchestration run (${existingActive[0]!.id}). Cancel or complete it first.`)
        }

        // Create the run
        run = tx
          .insert(orchestrationRuns)
          .values({
            id: runId,
            chatId: input.chatId,
            controllerSubChatId: input.controllerSubChatId,
            userGoal: input.userGoal,
            decomposedPlan: input.decomposedPlan,
            status: input.initialStatus,
            preOrchestrationCommit: input.preOrchestrationCommit,
            startedAt: now,
            updatedAt: now,
          })
          .returning()
          .get()

        // Create tasks — first pass: insert all tasks
        const taskIdMap = new Map<string, string>() // taskName -> taskId
        const insertedTasks: Array<{ id: string; dependsOnNames?: string[] }> = []

        for (const task of input.tasks) {
          const taskId = createId()
          taskIdMap.set(task.name, taskId)

          tx.insert(orchestrationTasks)
            .values({
              id: taskId,
              runId,
              name: task.name,
              description: task.description,
              mode: task.mode,
              sortOrder: task.sortOrder,
              autonomy: task.autonomy,
              allowedPaths: task.allowedPaths ? JSON.stringify(task.allowedPaths) : null,
              systemPromptAppend: task.systemPromptAppend,
              status: "pending",
            })
            .run()
          insertedTasks.push({ id: taskId, dependsOnNames: task.dependsOn })
        }

        // Second pass: resolve dependency names to IDs and set blocked status
        for (const task of insertedTasks) {
          if (task.dependsOnNames && task.dependsOnNames.length > 0) {
            const depIds = task.dependsOnNames
              .map(name => taskIdMap.get(name))
              .filter(Boolean) as string[]

            if (depIds.length > 0) {
              tx.update(orchestrationTasks)
                .set({
                  dependsOn: JSON.stringify(depIds),
                  status: "blocked",
                })
                .where(eq(orchestrationTasks.id, task.id))
                .run()
            }
          }
        }

        taskCount = insertedTasks.length
      })

      orchestrationEvents.emit(`run:${runId}`, { type: "run-started", runId })

      return { run, taskCount }
    }),

  /**
   * Spawn a worker tab for a task (creates sub_chat, links to task).
   */
  spawnTask: publicProcedure
    .input(
      z.object({
        taskId: z.string(),
        runId: z.string(),
        chatId: z.string(),
      })
    )
    .mutation(({ input }) => {
      const db = getDatabase()
      const task = db
        .select()
        .from(orchestrationTasks)
        .where(eq(orchestrationTasks.id, input.taskId))
        .get()

      if (!task) throw new Error("Task not found")

      // Wrap sub-chat creation + task linking in a transaction
      // to prevent orphaned sub-chats if the task update fails
      const subChatId = createId()

      db.transaction((tx) => {
        tx.insert(subChats)
          .values({
            id: subChatId,
            name: task.name,
            chatId: input.chatId,
            mode: task.mode || "agent",
            messages: "[]",
          })
          .run()

        tx.update(orchestrationTasks)
          .set({
            subChatId,
            status: "queued",
          })
          .where(eq(orchestrationTasks.id, input.taskId))
          .run()
      })

      orchestrationEvents.emit(`run:${input.runId}`, {
        type: "task-spawned",
        taskId: input.taskId,
        subChatId,
      })

      return { subChatId, task }
    }),

  /**
   * Mark a task as completed and unblock dependents.
   */
  completeTask: publicProcedure
    .input(
      z.object({
        taskId: z.string(),
        runId: z.string(),
        resultSummary: z.string().optional(),
        finalStatus: z.enum(["completed", "skipped", "failed"]).optional().default("completed"),
      })
    )
    .mutation(({ input }) => {
      const db = getDatabase()
      const finalStatus = input.finalStatus ?? "completed"

      // Run the complete + unblock/cascade + terminal check in a single transaction
      // to prevent race conditions from concurrent task completions
      let unblocked = 0
      let cascadeFailed = 0
      let runTerminalStatus: string | null = null

      db.transaction((tx) => {
        // Mark task with final status
        tx.update(orchestrationTasks)
          .set({
            status: finalStatus,
            resultSummary: input.resultSummary,
            completedAt: new Date(),
          })
          .where(eq(orchestrationTasks.id, input.taskId))
          .run()

        // Check for dependent tasks to unblock OR cascade failure
        const allTasks = tx
          .select()
          .from(orchestrationTasks)
          .where(eq(orchestrationTasks.runId, input.runId))
          .all()

        // Both "completed" and "skipped" tasks fulfil dependencies
        const fulfilledIds = new Set(
          allTasks
            .filter(t => t.status === "completed" || t.status === "skipped")
            .map(t => t.id)
        )
        if (finalStatus === "completed" || finalStatus === "skipped") {
          fulfilledIds.add(input.taskId)
        }

        // Track failed task IDs for cascade
        const failedIds = new Set(
          allTasks
            .filter(t => t.status === "failed")
            .map(t => t.id)
        )
        if (finalStatus === "failed") {
          failedIds.add(input.taskId)
        }

        // Parse dependsOn for all blocked tasks once
        const blockedTaskDeps = new Map<string, string[]>()
        for (const task of allTasks) {
          if (task.status !== "blocked" || !task.dependsOn) continue
          try {
            blockedTaskDeps.set(task.id, JSON.parse(task.dependsOn))
          } catch {
            console.warn(`[completeTask] Corrupted dependsOn JSON for task ${task.id}`)
            blockedTaskDeps.set(task.id, [])
          }
        }

        // Fixed-point loop: cascade failures through multi-level dependency chains
        // Each iteration may discover new cascade-failed tasks that unblock further cascades
        let changed = true
        while (changed) {
          changed = false
          for (const [taskId, deps] of blockedTaskDeps) {
            if (failedIds.has(taskId)) continue // Already cascade-failed

            const hasFailedDep = deps.some(dep => failedIds.has(dep))
            if (hasFailedDep) {
              const failedDepNames = deps
                .filter(dep => failedIds.has(dep))
                .map(dep => allTasks.find(t => t.id === dep)?.name ?? dep)

              tx.update(orchestrationTasks)
                .set({
                  status: "failed",
                  resultSummary: `Cascade failure: dependency "${failedDepNames.join('", "')}" failed`,
                  completedAt: new Date(),
                })
                .where(eq(orchestrationTasks.id, taskId))
                .run()
              failedIds.add(taskId)
              cascadeFailed++
              changed = true // May unblock further cascades in next iteration
            }
          }
        }

        // Now unblock tasks whose dependencies are all fulfilled
        for (const [taskId, deps] of blockedTaskDeps) {
          if (failedIds.has(taskId)) continue // Already cascade-failed
          const allDepsFulfilled = deps.length === 0 || deps.every(dep => fulfilledIds.has(dep))
          if (allDepsFulfilled) {
            tx.update(orchestrationTasks)
              .set({ status: "pending" })
              .where(eq(orchestrationTasks.id, taskId))
              .run()
            unblocked++
          }
        }

        // Check if ALL tasks are terminal → determine run status
        const remaining = allTasks.filter(
          t => t.id !== input.taskId && !["completed", "failed", "skipped"].includes(t.status)
        )
        // Subtract cascaded tasks from remaining (they were just marked failed in this tx)
        const remainingAfterCascade = remaining.filter(t => !failedIds.has(t.id))
        if (remainingAfterCascade.length === 0) {
          const hasAnyCompleted = allTasks.some(
            t => t.id === input.taskId
              ? finalStatus === "completed"
              : t.status === "completed",
          )
          runTerminalStatus = hasAnyCompleted ? "completed" : "failed"

          tx.update(orchestrationRuns)
            .set({
              status: runTerminalStatus,
              completedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(orchestrationRuns.id, input.runId))
            .run()
        }
      })

      orchestrationEvents.emit(`run:${input.runId}`, {
        type: "task-completed",
        taskId: input.taskId,
        status: finalStatus,
        unblocked,
        cascadeFailed,
      })

      return { unblocked, runTerminalStatus, cascadeFailed }
    }),

  /**
   * Update the status of an orchestration run.
   */
  updateRunStatus: publicProcedure
    .input(
      z.object({
        runId: z.string(),
        status: runStatusEnum,
        summary: z.string().optional(),
        errorMessage: z.string().optional(),
      })
    )
    .mutation(({ input }) => {
      const db = getDatabase()

      // Guard: refuse to overwrite terminal run statuses
      const TERMINAL_RUN_STATUSES = ["completed", "failed", "cancelled"]
      const current = db
        .select({ status: orchestrationRuns.status })
        .from(orchestrationRuns)
        .where(eq(orchestrationRuns.id, input.runId))
        .get()

      if (current && TERMINAL_RUN_STATUSES.includes(current.status)) {
        return current // Already terminal — silently ignore
      }

      const setData: Record<string, unknown> = {
        status: input.status,
        updatedAt: new Date(),
      }
      if (input.summary !== undefined) setData.summary = input.summary
      if (input.errorMessage !== undefined) setData.errorMessage = input.errorMessage
      if (TERMINAL_RUN_STATUSES.includes(input.status)) {
        setData.completedAt = new Date()
      }

      const run = db
        .update(orchestrationRuns)
        .set(setData)
        .where(eq(orchestrationRuns.id, input.runId))
        .returning()
        .get()

      orchestrationEvents.emit(`run:${input.runId}`, {
        type: "run-status-changed",
        status: input.status,
      })

      return run
    }),

  /**
   * Abort all running workers in a run (for pause/cancel).
   * Kills Claude subprocesses and marks tasks as failed.
   */
  abortRunWorkers: publicProcedure
    .input(z.object({
      runId: z.string(),
      reason: z.enum(["paused", "cancelled"]),
    }))
    .mutation(({ input }) => {
      const db = getDatabase()
      const tasks = db
        .select()
        .from(orchestrationTasks)
        .where(eq(orchestrationTasks.runId, input.runId))
        .all()

      let aborted = 0
      for (const task of tasks) {
        if (!["running", "queued"].includes(task.status) || !task.subChatId) continue

        // Abort the Claude subprocess
        abortClaudeSession(task.subChatId)

        // Mark task as failed with reason
        const reason = input.reason === "cancelled"
          ? "Aborted: run was cancelled by user"
          : "Paused: run was paused by user"

        db.update(orchestrationTasks)
          .set({
            status: input.reason === "cancelled" ? "failed" : "stuck",
            resultSummary: reason,
            completedAt: input.reason === "cancelled" ? new Date() : null,
          })
          .where(eq(orchestrationTasks.id, task.id))
          .run()

        aborted++
      }

      return { aborted }
    }),

  /**
   * Update task status.
   */
  updateTaskStatus: publicProcedure
    .input(
      z.object({
        taskId: z.string(),
        runId: z.string(),
        status: taskStatusEnum,
        resultSummary: z.string().optional(),
      })
    )
    .mutation(({ input }) => {
      const db = getDatabase()

      db.transaction(() => {
        // Guard: refuse to overwrite terminal statuses to prevent race conditions
        // (e.g., stuck check firing after task already completed)
        const TERMINAL_STATUSES = ["completed", "failed", "skipped"]
        const current = db
          .select({ status: orchestrationTasks.status })
          .from(orchestrationTasks)
          .where(eq(orchestrationTasks.id, input.taskId))
          .get()

        if (current && TERMINAL_STATUSES.includes(current.status)) {
          // Already terminal — silently ignore the update
          return
        }

        const setData: Record<string, unknown> = { status: input.status }
        if (input.resultSummary !== undefined) setData.resultSummary = input.resultSummary
        if (input.status === "running") setData.startedAt = new Date()
        if (TERMINAL_STATUSES.includes(input.status)) {
          setData.completedAt = new Date()
        }

        db.update(orchestrationTasks)
          .set(setData)
          .where(eq(orchestrationTasks.id, input.taskId))
          .run()
      })

      orchestrationEvents.emit(`run:${input.runId}`, {
        type: "task-status-changed",
        taskId: input.taskId,
        status: input.status,
      })
    }),

  /**
   * Update autonomy level for a specific task.
   */
  updateTaskAutonomy: publicProcedure
    .input(
      z.object({
        taskId: z.string(),
        autonomy: autonomyEnum,
      })
    )
    .mutation(({ input }) => {
      const db = getDatabase()
      return db
        .update(orchestrationTasks)
        .set({ autonomy: input.autonomy })
        .where(eq(orchestrationTasks.id, input.taskId))
        .returning()
        .get()
    }),

  /**
   * Request cross-validation of a task's output by spawning a validator.
   */
  requestValidation: publicProcedure
    .input(
      z.object({
        taskId: z.string(),
        runId: z.string(),
      })
    )
    .mutation(({ input }) => {
      const db = getDatabase()

      db.update(orchestrationTasks)
        .set({ status: "validating" })
        .where(eq(orchestrationTasks.id, input.taskId))
        .run()

      orchestrationEvents.emit(`run:${input.runId}`, {
        type: "task-validation-requested",
        taskId: input.taskId,
      })

      return { validating: true }
    }),

  /**
   * Orchestrate Existing Tabs — synthesize outstanding work across open tabs
   * into a coordinated orchestration run. Reads conversation history from
   * each open sub-chat and creates a run that wraps up their outstanding work.
   */
  orchestrateExistingTabs: publicProcedure
    .input(
      z.object({
        chatId: z.string(),
        controllerSubChatId: z.string(),
        subChatIds: z.array(z.string()), // IDs of tabs to orchestrate
      })
    )
    .mutation(({ input }) => {
      const db = getDatabase()

      // Fetch conversation summaries from each tab
      const tabSummaries: Array<{
        subChatId: string
        name: string
        mode: string
        messageCount: number
        lastMessages: string
      }> = []

      for (const scId of input.subChatIds) {
        const sc = db
          .select()
          .from(subChats)
          .where(eq(subChats.id, scId))
          .get()
        if (!sc) continue

        let messages: unknown[] = []
        try {
          messages = JSON.parse(sc.messages || "[]")
        } catch { /* ignore */ }

        // Get last few messages as context
        const recentMessages = messages.slice(-6)
        const lastMessagesText = recentMessages
          .map((m: any) => {
            if (!m?.role || !m?.content) return ""
            const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content)
            return `[${m.role}]: ${content.slice(0, 300)}`
          })
          .filter(Boolean)
          .join("\n")

        tabSummaries.push({
          subChatId: scId,
          name: sc.name || "Untitled Tab",
          mode: sc.mode || "agent",
          messageCount: messages.length,
          lastMessages: lastMessagesText,
        })
      }

      if (tabSummaries.length === 0) {
        throw new Error("No valid tabs found to orchestrate")
      }

      // Create the orchestration run with existing tabs as tasks
      const runId = createId()
      const now = new Date()

      const userGoal = `Orchestrate and wrap up outstanding work across ${tabSummaries.length} existing tabs`
      const decomposedPlan = JSON.stringify({
        type: "existing-tabs",
        tabs: tabSummaries.map(t => ({
          subChatId: t.subChatId,
          name: t.name,
          messageCount: t.messageCount,
        })),
      })

      // Wrap run + task creation in a transaction to prevent partial state
      const tasks: Array<typeof orchestrationTasks.$inferSelect> = []

      db.transaction((tx) => {
        tx.insert(orchestrationRuns)
          .values({
            id: runId,
            chatId: input.chatId,
            controllerSubChatId: input.controllerSubChatId,
            userGoal,
            decomposedPlan,
            status: "running",
            startedAt: now,
            updatedAt: now,
          })
          .run()

        // Create a task for each existing tab (linked to existing sub-chats)
        for (let i = 0; i < tabSummaries.length; i++) {
          const tab = tabSummaries[i]!
          const taskId = createId()

          const task = tx
            .insert(orchestrationTasks)
            .values({
              id: taskId,
              runId,
              name: tab.name,
              description: `Continue and wrap up work in existing tab "${tab.name}" (${tab.messageCount} messages). Recent context:\n${tab.lastMessages}`,
              mode: tab.mode as "plan" | "agent",
              subChatId: tab.subChatId, // Link to existing tab
              status: "running", // Already has conversation
              sortOrder: i,
              autonomy: "review", // Default to review for existing work
              startedAt: now,
            })
            .returning()
            .get()
          tasks.push(task)
        }
      })

      orchestrationEvents.emit(`run:${runId}`, {
        type: "run-started",
        runId,
        existingTabs: true,
      })

      return {
        runId,
        taskCount: tasks.length,
        tabSummaries: tabSummaries.map(t => ({
          name: t.name,
          messageCount: t.messageCount,
        })),
      }
    }),

  /**
   * Decompose a user goal into parallel tasks using Claude.
   */
  decompose: publicProcedure
    .input(
      z.object({
        chatId: z.string(),
        userGoal: z.string(),
      })
    )
    .mutation(async ({ input }) => {
      const db = getDatabase()

      // Get project path from chat
      const chat = db
        .select()
        .from(chats)
        .where(eq(chats.id, input.chatId))
        .get()

      if (!chat) throw new Error("Chat not found")

      let projectPath = ""
      if (chat.projectId) {
        const project = db
          .select()
          .from(projects)
          .where(eq(projects.id, chat.projectId))
          .get()
        projectPath = project?.path ?? ""
      }

      // Use worktree path if available
      const workDir = chat.worktreePath || projectPath
      if (!workDir) throw new Error("No project path available")

      // Get project memories for context
      let projectMemoriesText = ""
      if (chat.projectId) {
        try {
          const injection = await getMemoriesForInjection(chat.projectId, null)
          projectMemoriesText = injection.markdown
        } catch {
          // Non-fatal: proceed without memories
        }
      }

      const plan = await decomposeGoal({
        userGoal: input.userGoal,
        projectPath: workDir,
        projectMemories: projectMemoriesText,
      })

      return plan
    }),

  /**
   * Check for stuck workers in a run.
   */
  checkStuckWorkers: publicProcedure
    .input(z.object({ runId: z.string() }))
    .query(({ input }) => {
      const db = getDatabase()
      const run = db.select().from(orchestrationRuns).where(eq(orchestrationRuns.id, input.runId)).get()
      if (!run) return []

      const chat = db.select().from(chats).where(eq(chats.id, run.chatId)).get()
      let workDir = ""
      if (chat?.worktreePath) {
        workDir = chat.worktreePath
      } else if (chat?.projectId) {
        const project = db.select().from(projects).where(eq(projects.id, chat.projectId)).get()
        workDir = project?.path ?? ""
      }

      const config = workDir ? loadOrchestratorConfig(workDir) : { workerTimeout: 900 }
      return checkStuck(input.runId, config.workerTimeout)
    }),

  /**
   * Get the orchestrator config for a workspace.
   */
  getConfig: publicProcedure
    .input(z.object({ chatId: z.string() }))
    .query(({ input }) => {
      const db = getDatabase()
      const chat = db.select().from(chats).where(eq(chats.id, input.chatId)).get()
      if (!chat) return { concurrency: 4, workerTimeout: 900 }

      let workDir = ""
      if (chat.worktreePath) {
        workDir = chat.worktreePath
      } else if (chat.projectId) {
        const project = db.select().from(projects).where(eq(projects.id, chat.projectId)).get()
        workDir = project?.path ?? ""
      }

      if (!workDir) return { concurrency: 4, workerTimeout: 900 }

      const config = loadOrchestratorConfig(workDir)
      return { concurrency: config.concurrency, workerTimeout: config.workerTimeout }
    }),

  /**
   * Diagnose a stuck worker and get intervention recommendation.
   */
  diagnoseWorker: publicProcedure
    .input(
      z.object({
        taskId: z.string(),
        runId: z.string(),
        stuckReason: z.string(),
      })
    )
    .mutation(async ({ input }) => {
      const db = getDatabase()
      const task = db
        .select()
        .from(orchestrationTasks)
        .where(eq(orchestrationTasks.id, input.taskId))
        .get()

      if (!task || !task.subChatId) throw new Error("Task or sub-chat not found")

      const result = await diagnoseStuckWorker(
        task.description,
        task.subChatId,
        input.stuckReason,
      )

      return result
    }),

  /**
   * Run a quality gate command in the project directory.
   */
  runQualityGate: publicProcedure
    .input(
      z.object({
        runId: z.string(),
        command: z.string().optional(),
        type: z.enum(["afterTask", "afterAll"]).optional().default("afterTask"),
      })
    )
    .mutation(async ({ input }) => {
      const db = getDatabase()
      const run = db
        .select()
        .from(orchestrationRuns)
        .where(eq(orchestrationRuns.id, input.runId))
        .get()

      if (!run) throw new Error("Run not found")

      const chat = db
        .select()
        .from(chats)
        .where(eq(chats.id, run.chatId))
        .get()

      if (!chat) throw new Error("Chat not found")

      let projectPath = ""
      if (chat.projectId) {
        const project = db
          .select()
          .from(projects)
          .where(eq(projects.id, chat.projectId))
          .get()
        projectPath = project?.path ?? ""
      }

      const workDir = chat.worktreePath || projectPath
      if (!workDir) throw new Error("No project path available")

      const config = loadOrchestratorConfig(workDir)

      if (input.command) {
        // Validate command before execution — block critical/high risk
        const risk = classifyBashCommand(input.command)
        if (risk === "critical" || risk === "high") {
          return {
            results: [{
              command: input.command,
              passed: false,
              output: `Command blocked: classified as "${risk}" risk. Only low/medium risk commands are allowed as quality gates.`,
              durationMs: 0,
            }],
          }
        }
        return { results: [await runGate(input.command, workDir, config.qualityGates.timeout)] }
      }

      // Also validate configured gates from .2code/orchestrator.json
      const gatesToRun = input.type === "afterAll"
        ? [...new Set([...detectDefaultGates(workDir), ...config.qualityGates.afterAllTasks])]
        : (config.qualityGates.afterEachTask.length > 0 ? config.qualityGates.afterEachTask : detectDefaultGates(workDir))

      for (const gate of gatesToRun) {
        const gateRisk = classifyBashCommand(gate)
        if (gateRisk === "critical" || gateRisk === "high") {
          return {
            results: [{
              command: gate,
              passed: false,
              output: `Configured gate blocked: "${gate}" classified as "${gateRisk}" risk. Remove it from .2code/orchestrator.json.`,
              durationMs: 0,
            }],
          }
        }
      }

      // Run configured gates
      const results = input.type === "afterAll"
        ? await runAfterAllGates(workDir, config)
        : await runAfterTaskGates(workDir, config)

      return { results }
    }),

  /**
   * Aggregate results of a completed run into a summary.
   */
  aggregateRun: publicProcedure
    .input(z.object({ runId: z.string() }))
    .mutation(async ({ input }) => {
      const db = getDatabase()
      const run = db
        .select()
        .from(orchestrationRuns)
        .where(eq(orchestrationRuns.id, input.runId))
        .get()

      if (!run) throw new Error("Run not found")

      const tasks = db
        .select()
        .from(orchestrationTasks)
        .where(eq(orchestrationTasks.runId, input.runId))
        .orderBy(orchestrationTasks.sortOrder)
        .all()

      const summary = await aggregateResults({
        userGoal: run.userGoal,
        taskResults: tasks.map((t) => ({
          name: t.name,
          status: t.status,
          resultSummary: t.resultSummary,
        })),
      })

      // Store the summary
      db.update(orchestrationRuns)
        .set({ summary, updatedAt: new Date() })
        .where(eq(orchestrationRuns.id, input.runId))
        .run()

      orchestrationEvents.emit(`run:${input.runId}`, {
        type: "run-summary-ready",
        summary,
      })

      return { summary }
    }),

  /**
   * Subscription for live orchestration run updates.
   */
  onRunUpdate: publicProcedure
    .input(z.object({ runId: z.string() }))
    .subscription(({ input }) => {
      return observable<{
        type: string
        taskId?: string
        status?: string
        subChatId?: string
        unblocked?: number
        cascadeFailed?: number
        summary?: string
        runId?: string
        existingTabs?: boolean
      }>((emit) => {
        const handler = (data: any) => {
          emit.next(data)
        }

        orchestrationEvents.on(`run:${input.runId}`, handler)

        return () => {
          orchestrationEvents.off(`run:${input.runId}`, handler)
        }
      })
    }),
})
