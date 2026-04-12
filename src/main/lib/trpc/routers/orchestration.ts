/**
 * Orchestration tRPC Router
 *
 * Exposes orchestration lifecycle (start, pause, resume, stop, approve)
 * plus status queries and a progress subscription.
 */

import { observable } from "@trpc/server/observable"
import { z } from "zod"
import { publicProcedure, router } from "../index"
import {
  getRunWithTasks,
  getRunsForChat,
} from "../../orchestration/checkpoint"
import { getRecoverableRuns } from "../../orchestration/recovery"
import {
  runOrchestration,
  pauseRun,
  stopRun,
  approveTask,
  resumeRun,
} from "../../orchestration/orchestrator"
import { buildSuperpowersDecompositionResponse } from "../../orchestration/superpowers-workflow"
import { buildDecompositionFromExtracted } from "../../orchestration/auto-continuation"
import type { OrchestrationEvent } from "../../orchestration/types"

// ============ In-Memory Pub/Sub ============

type ProgressCallback = (event: OrchestrationEvent) => void
const subscribers = new Map<string, Set<ProgressCallback>>()

function subscribe(runId: string, cb: ProgressCallback): () => void {
  let set = subscribers.get(runId)
  if (!set) {
    set = new Set()
    subscribers.set(runId, set)
  }
  set.add(cb)
  return () => {
    set!.delete(cb)
    if (set!.size === 0) subscribers.delete(runId)
  }
}

function publish(event: OrchestrationEvent): void {
  const runId = event.runId
  const set = subscribers.get(runId)
  if (set) {
    for (const cb of set) {
      try { cb(event) } catch {}
    }
  }
}

// ============ Router ============

export const orchestrationRouter = router({
  /** Start a new orchestration run (fire-and-forget) */
  start: publicProcedure
    .input(
      z.object({
        chatId: z.string(),
        subChatId: z.string(),
        goal: z.string(),
        cwd: z.string(),
        projectPath: z.string(),
        decompositionResponse: z.string(),
        sensitivity: z.enum(["strict", "normal", "autonomous"]).default("normal"),
        costLimitUsd: z.number().default(5),
      }),
    )
    .mutation(({ input }) => {
      // Fire-and-forget — the progress subscription tracks events
      const runPromise = runOrchestration({
        ...input,
        emit: publish,
      })

      // Log errors but don't block
      runPromise.catch((err) => {
        console.error("[orchestration] Run failed:", err)
      })

      return { started: true }
    }),

  /** Extract tasks from a Claude response and start an orchestration run */
  extractAndStart: publicProcedure
    .input(
      z.object({
        chatId: z.string(),
        subChatId: z.string(),
        responseText: z.string(),
        cwd: z.string(),
        projectPath: z.string(),
        sensitivity: z.enum(["strict", "normal", "autonomous"]).default("normal"),
        costLimitUsd: z.number().default(5),
        parallel: z.boolean().default(false),
      }),
    )
    .mutation(({ input }) => {
      const decompositionResponse = buildDecompositionFromExtracted(
        input.responseText,
        { parallel: input.parallel },
      )

      if (!decompositionResponse) {
        return { started: false, reason: "No actionable tasks found in response" }
      }

      const goal = `Auto-continuation: extracted tasks from assistant response`

      const runPromise = runOrchestration({
        chatId: input.chatId,
        subChatId: input.subChatId,
        goal,
        cwd: input.cwd,
        projectPath: input.projectPath,
        decompositionResponse,
        sensitivity: input.sensitivity,
        costLimitUsd: input.costLimitUsd,
        emit: publish,
      })

      runPromise.catch((err) => {
        console.error("[orchestration] Auto-continuation run failed:", err)
      })

      return { started: true }
    }),

  /** Start a Superpowers workflow (brainstorm → plan → execute → review → post-review) */
  startSuperpowers: publicProcedure
    .input(
      z.object({
        chatId: z.string(),
        subChatId: z.string(),
        goal: z.string(),
        cwd: z.string(),
        projectPath: z.string(),
        sensitivity: z.enum(["strict", "normal", "autonomous"]).default("normal"),
        costLimitUsd: z.number().default(5),
      }),
    )
    .mutation(({ input }) => {
      const decompositionResponse = buildSuperpowersDecompositionResponse(input.goal)

      const runPromise = runOrchestration({
        ...input,
        decompositionResponse,
        emit: publish,
      })

      runPromise.catch((err) => {
        console.error("[orchestration] Superpowers run failed:", err)
      })

      return { started: true }
    }),

  /** Pause a running orchestration */
  pause: publicProcedure
    .input(z.object({ runId: z.string() }))
    .mutation(({ input }) => {
      pauseRun(input.runId)
      publish({ type: "run-paused", runId: input.runId })
      return { paused: true }
    }),

  /** Resume a paused orchestration */
  resume: publicProcedure
    .input(
      z.object({
        runId: z.string(),
        chatId: z.string(),
        subChatId: z.string(),
        goal: z.string(),
        cwd: z.string(),
        projectPath: z.string(),
        sensitivity: z.enum(["strict", "normal", "autonomous"]).default("normal"),
        costLimitUsd: z.number().default(5),
      }),
    )
    .mutation(({ input }) => {
      resumeRun(input.runId, {
        ...input,
        decompositionResponse: "", // not used for resume
        emit: publish,
      })
      return { resumed: true }
    }),

  /** Stop a running orchestration */
  stop: publicProcedure
    .input(z.object({ runId: z.string() }))
    .mutation(({ input }) => {
      stopRun(input.runId)
      return { stopped: true }
    }),

  /** Approve or reject a pending task */
  approveTask: publicProcedure
    .input(z.object({ taskId: z.string(), approved: z.boolean() }))
    .mutation(({ input }) => {
      approveTask(input.taskId, input.approved)
      return { approved: input.approved }
    }),

  /** Get run status with all tasks */
  getStatus: publicProcedure
    .input(z.object({ runId: z.string() }))
    .query(({ input }) => {
      const data = getRunWithTasks(input.runId)
      if (!data) return null

      return {
        run: {
          ...data.run,
          taskGraph: data.run.taskGraph ? JSON.parse(data.run.taskGraph) : null,
          memoryContext: data.run.memoryContext ? JSON.parse(data.run.memoryContext) : null,
          checkpoint: data.run.checkpoint ? JSON.parse(data.run.checkpoint) : null,
        },
        tasks: data.tasks.map((t) => ({
          ...t,
          dependsOn: t.dependsOn ? JSON.parse(t.dependsOn) : [],
          memoryFiles: t.memoryFiles ? JSON.parse(t.memoryFiles) : [],
          result: t.result ? JSON.parse(t.result) : null,
        })),
      }
    }),

  /** List all runs for a chat */
  listRuns: publicProcedure
    .input(z.object({ chatId: z.string() }))
    .query(({ input }) => {
      return getRunsForChat(input.chatId).map((run) => ({
        id: run.id,
        goal: run.goal,
        status: run.status,
        totalCostUsd: run.totalCostUsd,
        createdAt: run.createdAt,
        completedAt: run.completedAt,
      }))
    }),

  /** Get recoverable runs (incomplete from previous session) */
  getRecoverableRuns: publicProcedure.query(() => {
    return getRecoverableRuns()
  }),

  /** Subscribe to progress events for a run */
  onProgress: publicProcedure
    .input(z.object({ runId: z.string() }))
    .subscription(({ input }) => {
      return observable<OrchestrationEvent>((emit) => {
        const unsubscribe = subscribe(input.runId, (event) => {
          emit.next(event)
        })
        return unsubscribe
      })
    }),
})
