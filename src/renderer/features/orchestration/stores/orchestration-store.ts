import { create } from "zustand"
import type { OrchestrationEvent, WorkerResult } from "../../../../main/lib/orchestration/types"

export interface OrchestrationTaskState {
  id: string
  description: string
  workerType: string
  status: string
  result?: WorkerResult
  error?: string
}

export interface OrchestrationRunState {
  runId: string
  goal: string
  status: string
  tasks: OrchestrationTaskState[]
  completedCount: number
  totalCount: number
  costUsd: number
  events: OrchestrationEvent[]
}

interface PendingApproval {
  taskId: string
  description: string
  runId: string
}

interface OrchestrationStore {
  /** Active runs keyed by runId */
  runs: Record<string, OrchestrationRunState>
  /** Pending approval queue */
  approvalQueue: PendingApproval[]
  /** Process an incoming orchestration event */
  handleEvent: (event: OrchestrationEvent) => void
  /** Add a pending approval */
  addApproval: (approval: PendingApproval) => void
  /** Remove a pending approval */
  removeApproval: (taskId: string) => void
  /** Clear all state for a run */
  clearRun: (runId: string) => void
}

export const useOrchestrationStore = create<OrchestrationStore>((set) => ({
  runs: {},
  approvalQueue: [],

  handleEvent: (event) =>
    set((state) => {
      const runs = { ...state.runs }
      const runId = event.runId

      switch (event.type) {
        case "run-started": {
          runs[runId] = {
            runId,
            goal: event.goal,
            status: "planning",
            tasks: [],
            completedCount: 0,
            totalCount: 0,
            costUsd: 0,
            events: [event],
          }
          break
        }
        case "planning-complete": {
          const run = runs[runId]
          if (run) {
            runs[runId] = {
              ...run,
              status: "executing",
              totalCount: event.taskCount,
              events: [...run.events, event],
            }
          }
          break
        }
        case "task-started": {
          const run = runs[runId]
          if (run) {
            const existingIdx = run.tasks.findIndex((t) => t.id === event.taskId)
            const task: OrchestrationTaskState = {
              id: event.taskId,
              description: event.description,
              workerType: event.workerType,
              status: "running",
            }
            const tasks = [...run.tasks]
            if (existingIdx >= 0) {
              tasks[existingIdx] = task
            } else {
              tasks.push(task)
            }
            runs[runId] = { ...run, tasks, events: [...run.events, event] }
          }
          break
        }
        case "task-completed": {
          const run = runs[runId]
          if (run) {
            const tasks = run.tasks.map((t) =>
              t.id === event.taskId
                ? { ...t, status: "completed", result: event.result }
                : t,
            )
            runs[runId] = {
              ...run,
              tasks,
              completedCount: run.completedCount + 1,
              events: [...run.events, event],
            }
          }
          break
        }
        case "task-failed": {
          const run = runs[runId]
          if (run) {
            const tasks = run.tasks.map((t) =>
              t.id === event.taskId
                ? { ...t, status: "failed", error: event.error }
                : t,
            )
            runs[runId] = { ...run, tasks, events: [...run.events, event] }
          }
          break
        }
        case "checkpoint-saved": {
          const run = runs[runId]
          if (run) {
            runs[runId] = {
              ...run,
              completedCount: event.completedCount,
              events: [...run.events, event],
            }
          }
          break
        }
        case "approval-needed": {
          const run = runs[runId]
          if (run) {
            runs[runId] = { ...run, events: [...run.events, event] }
          }
          return {
            runs,
            approvalQueue: [
              ...state.approvalQueue,
              {
                taskId: event.taskId,
                description: event.description,
                runId,
              },
            ],
          }
        }
        case "cost-threshold": {
          const run = runs[runId]
          if (run) {
            runs[runId] = {
              ...run,
              costUsd: event.currentCostUsd,
              status: "paused",
              events: [...run.events, event],
            }
          }
          break
        }
        case "run-completed": {
          const run = runs[runId]
          if (run) {
            runs[runId] = {
              ...run,
              status: "completed",
              events: [...run.events, event],
            }
          }
          break
        }
        case "run-failed": {
          const run = runs[runId]
          if (run) {
            runs[runId] = {
              ...run,
              status: "failed",
              events: [...run.events, event],
            }
          }
          break
        }
        case "run-paused": {
          const run = runs[runId]
          if (run) {
            runs[runId] = {
              ...run,
              status: "paused",
              events: [...run.events, event],
            }
          }
          break
        }
        case "run-resumed": {
          const run = runs[runId]
          if (run) {
            runs[runId] = {
              ...run,
              status: "executing",
              events: [...run.events, event],
            }
          }
          break
        }
        case "error": {
          const run = runs[runId]
          if (run) {
            runs[runId] = { ...run, events: [...run.events, event] }
          }
          break
        }
      }

      return { runs }
    }),

  addApproval: (approval) =>
    set((state) => ({
      approvalQueue: [...state.approvalQueue, approval],
    })),

  removeApproval: (taskId) =>
    set((state) => ({
      approvalQueue: state.approvalQueue.filter((a) => a.taskId !== taskId),
    })),

  clearRun: (runId) =>
    set((state) => {
      const { [runId]: _, ...rest } = state.runs
      return {
        runs: rest,
        approvalQueue: state.approvalQueue.filter((a) => a.runId !== runId),
      }
    }),
}))
