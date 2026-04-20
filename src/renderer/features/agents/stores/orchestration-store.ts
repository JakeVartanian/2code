/**
 * Orchestration Zustand store — manages live orchestration state
 * for the orchestrator view (pipeline, tasks, run status).
 */

import { create } from "zustand"
import { subscribeWithSelector } from "zustand/middleware"

export type TaskStatus =
  | "pending"
  | "blocked"
  | "queued"
  | "running"
  | "validating"
  | "completed"
  | "failed"
  | "skipped"
  | "stuck"

export type RunStatus =
  | "planning"
  | "running"
  | "paused"
  | "validating"
  | "completed"
  | "failed"
  | "cancelled"

export type Autonomy = "auto" | "review" | "supervised" | "plan-only"

export interface OrchestrationTask {
  id: string
  runId: string
  name: string
  description: string
  mode: "plan" | "agent"
  subChatId: string | null
  status: TaskStatus
  sortOrder: number
  dependsOn: string[] // task IDs
  autonomy: Autonomy
  allowedPaths: string[] | null
  resultSummary: string | null
  startedAt: Date | null
  completedAt: Date | null
}

export interface OrchestrationRun {
  id: string
  chatId: string
  controllerSubChatId: string | null
  userGoal: string
  decomposedPlan: string // JSON
  status: RunStatus
  summary: string | null
  preOrchestrationCommit: string | null
  tasks: OrchestrationTask[]
  startedAt: Date | null
  completedAt: Date | null
}

interface OrchestrationStore {
  // Active runs per workspace (chatId -> run)
  runs: Map<string, OrchestrationRun>

  // Set or replace a run
  setRun: (chatId: string, run: OrchestrationRun) => void

  // Update a run's status
  updateRunStatus: (chatId: string, status: RunStatus, summary?: string) => void

  // Update a task's status within a run
  updateTaskStatus: (chatId: string, taskId: string, status: TaskStatus, resultSummary?: string) => void

  // Update a task's autonomy
  updateTaskAutonomy: (chatId: string, taskId: string, autonomy: Autonomy) => void

  // Link a sub-chat to a task
  linkTaskSubChat: (chatId: string, taskId: string, subChatId: string) => void

  // Remove a run (cleanup)
  removeRun: (chatId: string) => void

  // Get the active run for a workspace
  getRunForChat: (chatId: string) => OrchestrationRun | undefined

  // Get task by ID across all runs
  getTask: (chatId: string, taskId: string) => OrchestrationTask | undefined

  // Get tasks by status for a workspace
  getTasksByStatus: (chatId: string, status: TaskStatus) => OrchestrationTask[]

  // Get count of running workers
  getRunningWorkerCount: (chatId: string) => number

  // Get next tasks eligible to run (no unmet deps, status=pending)
  getNextRunnableTasks: (chatId: string) => OrchestrationTask[]
}

export const useOrchestrationStore = create<OrchestrationStore>()(
  subscribeWithSelector((set, get) => ({
  runs: new Map(),

  setRun: (chatId, run) => {
    set((state) => {
      const next = new Map(state.runs)
      next.set(chatId, run)
      return { runs: next }
    })
  },

  updateRunStatus: (chatId, status, summary) => {
    set((state) => {
      const next = new Map(state.runs)
      const run = next.get(chatId)
      if (!run) return state
      next.set(chatId, {
        ...run,
        status,
        summary: summary ?? run.summary,
        completedAt: ["completed", "failed", "cancelled"].includes(status)
          ? new Date()
          : run.completedAt,
      })
      return { runs: next }
    })
  },

  updateTaskStatus: (chatId, taskId, status, resultSummary) => {
    set((state) => {
      const next = new Map(state.runs)
      const run = next.get(chatId)
      if (!run) return state
      next.set(chatId, {
        ...run,
        tasks: run.tasks.map((t) =>
          t.id === taskId
            ? {
                ...t,
                status,
                resultSummary: resultSummary ?? t.resultSummary,
                startedAt: status === "running" ? new Date() : t.startedAt,
                completedAt: ["completed", "failed", "skipped"].includes(status)
                  ? new Date()
                  : t.completedAt,
              }
            : t,
        ),
      })
      return { runs: next }
    })
  },

  updateTaskAutonomy: (chatId, taskId, autonomy) => {
    set((state) => {
      const next = new Map(state.runs)
      const run = next.get(chatId)
      if (!run) return state
      next.set(chatId, {
        ...run,
        tasks: run.tasks.map((t) =>
          t.id === taskId ? { ...t, autonomy } : t,
        ),
      })
      return { runs: next }
    })
  },

  linkTaskSubChat: (chatId, taskId, subChatId) => {
    set((state) => {
      const next = new Map(state.runs)
      const run = next.get(chatId)
      if (!run) return state
      next.set(chatId, {
        ...run,
        tasks: run.tasks.map((t) =>
          t.id === taskId ? { ...t, subChatId } : t,
        ),
      })
      return { runs: next }
    })
  },

  removeRun: (chatId) => {
    set((state) => {
      const next = new Map(state.runs)
      next.delete(chatId)
      return { runs: next }
    })
  },

  getRunForChat: (chatId) => {
    return get().runs.get(chatId)
  },

  getTask: (chatId, taskId) => {
    const run = get().runs.get(chatId)
    return run?.tasks.find((t) => t.id === taskId)
  },

  getTasksByStatus: (chatId, status) => {
    const run = get().runs.get(chatId)
    return run?.tasks.filter((t) => t.status === status) ?? []
  },

  getRunningWorkerCount: (chatId) => {
    const run = get().runs.get(chatId)
    return run?.tasks.filter((t) => t.status === "running").length ?? 0
  },

  getNextRunnableTasks: (chatId) => {
    const run = get().runs.get(chatId)
    if (!run) return []

    // Both "completed" and "skipped" tasks fulfil dependencies
    const fulfilledIds = new Set(
      run.tasks
        .filter((t) => t.status === "completed" || t.status === "skipped")
        .map((t) => t.id),
    )

    return run.tasks.filter((t) => {
      if (t.status !== "pending") return false
      // Check all dependencies are fulfilled (completed or skipped)
      return t.dependsOn.every((depId) => fulfilledIds.has(depId))
    })
  },
})))
