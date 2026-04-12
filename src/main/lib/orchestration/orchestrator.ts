/**
 * Orchestrator Engine — Core execution loop for multi-task agent orchestration.
 *
 * 1. Loads memory context
 * 2. Parses decomposition response into TaskGraph
 * 3. Creates run + tasks in DB
 * 4. Executes loop: find ready tasks, dispatch workers (up to 3 parallel),
 *    checkpoint after each, handle approval gates, check cost threshold
 * 5. Synthesizes results on completion
 */

import { readMemoryMdCached, readTopicFile } from "../memory"
import {
  createRunInDb,
  loadCheckpoint,
  saveCheckpoint,
  updateRunStatus,
  updateTaskStatus,
} from "./checkpoint"
import { parseDecompositionResponse } from "./task-decomposer"
import { runWorker } from "./worker-dispatch"
import type {
  ApprovalSensitivity,
  CheckpointData,
  MemoryContext,
  OrchestrationEvent,
  OrchestrationParams,
  TaskNode,
  WorkerResult,
} from "./types"

// ============ In-Memory State ============

const activeRuns = new Map<string, AbortController>()
const pendingApprovals = new Map<string, {
  resolve: (approved: boolean) => void
  taskId: string
}>()

// Max concurrent workers per run
const MAX_PARALLEL_WORKERS = 3
// Max orchestration depth (orchestrator → workers, no sub-workers)
const MAX_ORCHESTRATION_DEPTH = 2
// Auto-pause timeout: 30 minutes without user interaction
const ORCHESTRATION_TIMEOUT_MS = 30 * 60 * 1000

// Track nesting depth to prevent recursive orchestration
let currentOrchestrationDepth = 0

// ============ Public API ============

export function hasActiveOrchestrationRuns(): boolean {
  return activeRuns.size > 0
}

export async function abortAllOrchestrationRuns(): Promise<void> {
  for (const [runId, controller] of activeRuns) {
    console.log(`[orchestration] Aborting run ${runId}`)
    controller.abort()
  }
  activeRuns.clear()

  // Reject all pending approvals
  for (const [, approval] of pendingApprovals) {
    approval.resolve(false)
  }
  pendingApprovals.clear()
}

export function pauseRun(runId: string): void {
  const controller = activeRuns.get(runId)
  if (controller) {
    controller.abort()
    activeRuns.delete(runId)
    updateRunStatus(runId, "paused")
  }
}

export function stopRun(runId: string): void {
  const controller = activeRuns.get(runId)
  if (controller) {
    controller.abort()
    activeRuns.delete(runId)
    updateRunStatus(runId, "failed")
  }
}

export function approveTask(taskId: string, approved: boolean): void {
  const pending = pendingApprovals.get(taskId)
  if (pending) {
    pending.resolve(approved)
    pendingApprovals.delete(taskId)
  }
}

// ============ Main Entry Point ============

export async function runOrchestration(params: OrchestrationParams): Promise<void> {
  const { chatId, subChatId, goal, cwd, projectPath, decompositionResponse, sensitivity, costLimitUsd, emit } = params

  // Enforce max orchestration depth
  if (currentOrchestrationDepth >= MAX_ORCHESTRATION_DEPTH) {
    emit({ type: "error", runId: "", message: `Max orchestration depth (${MAX_ORCHESTRATION_DEPTH}) exceeded` })
    return
  }

  const abortController = new AbortController()
  let runId = ""
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null

  // Set up auto-pause timeout (30 min)
  const resetTimeout = () => {
    if (timeoutHandle) clearTimeout(timeoutHandle)
    timeoutHandle = setTimeout(() => {
      if (runId && activeRuns.has(runId)) {
        console.log(`[orchestration] Run ${runId} timed out after ${ORCHESTRATION_TIMEOUT_MS / 60000} minutes`)
        abortController.abort()
        activeRuns.delete(runId)
        updateRunStatus(runId, "paused")
        emit({ type: "run-paused", runId })
      }
    }, ORCHESTRATION_TIMEOUT_MS)
  }

  currentOrchestrationDepth++

  try {
    resetTimeout()

    // 1. Load memory context
    const memoryContext = loadMemoryContext(projectPath)

    // 2. Parse decomposition into TaskGraph
    const taskGraph = parseDecompositionResponse(decompositionResponse)

    // 3. Create run in DB
    const { runId: id } = createRunInDb({
      chatId,
      subChatId,
      goal,
      taskGraph,
      memoryContext,
    })
    runId = id
    activeRuns.set(runId, abortController)

    emit({ type: "run-started", runId, goal })
    emit({ type: "planning-complete", runId, taskCount: taskGraph.tasks.length })

    // 4. Update run status to executing
    updateRunStatus(runId, "executing")

    // 5. Load or initialize checkpoint
    let checkpoint = loadCheckpoint(runId) || {
      completedTaskIds: [],
      taskResults: {},
      accumulatedCostUsd: 0,
      lastCheckpointAt: Date.now(),
    }

    // Build memory content string for workers
    const memoryContent = buildMemoryContentString(memoryContext)

    // 6. Execute loop
    const tasks = taskGraph.tasks
    const taskMap = new Map(tasks.map((t) => [t.id, t]))

    while (true) {
      if (abortController.signal.aborted) {
        emit({ type: "run-paused", runId })
        return
      }

      // Check cost threshold
      if (checkpoint.accumulatedCostUsd >= costLimitUsd) {
        emit({ type: "cost-threshold", runId, currentCostUsd: checkpoint.accumulatedCostUsd, limitUsd: costLimitUsd })
        updateRunStatus(runId, "paused")
        emit({ type: "run-paused", runId })
        return
      }

      // Find ready tasks (all deps completed, not already done)
      const readyTasks = tasks.filter((t) => {
        if (checkpoint.completedTaskIds.includes(t.id)) return false
        if (t.status === "running" || t.status === "completed" || t.status === "failed" || t.status === "skipped") return false
        return t.dependsOn.every((d) => checkpoint.completedTaskIds.includes(d))
      })

      if (readyTasks.length === 0) {
        // Check if all tasks are done
        const allDone = tasks.every(
          (t) => checkpoint.completedTaskIds.includes(t.id) || t.status === "skipped" || t.status === "failed",
        )
        if (allDone) break

        // Some tasks are still in progress (parallel workers) — shouldn't happen here
        // but guard against infinite loop
        break
      }

      // Dispatch workers in parallel (up to MAX_PARALLEL_WORKERS)
      const batch = readyTasks.slice(0, MAX_PARALLEL_WORKERS)
      const workerPromises = batch.map((task) =>
        executeTask(task, {
          runId,
          cwd,
          memoryContent,
          checkpoint,
          sensitivity,
          abortController,
          emit,
          taskMap,
        }),
      )

      const results = await Promise.allSettled(workerPromises)

      // Process results and update checkpoint
      for (let i = 0; i < results.length; i++) {
        const task = batch[i]!
        const result = results[i]!

        if (result.status === "fulfilled" && result.value) {
          task.status = "completed"
          task.result = result.value
          checkpoint.completedTaskIds.push(task.id)
          checkpoint.taskResults[task.id] = result.value
          updateTaskStatus(task.id, "completed", { result: result.value })
          emit({ type: "task-completed", runId, taskId: task.id, result: result.value })
        } else if (result.status === "rejected") {
          const errorMsg = result.reason instanceof Error ? result.reason.message : String(result.reason)
          task.status = "failed"
          task.error = errorMsg
          updateTaskStatus(task.id, "failed", { error: errorMsg })
          emit({ type: "task-failed", runId, taskId: task.id, error: errorMsg })
        } else {
          // fulfilled but null (skipped due to approval rejection)
          task.status = "skipped"
          checkpoint.completedTaskIds.push(task.id)
          updateTaskStatus(task.id, "skipped")
        }

        // Unblock dependent tasks
        for (const t of tasks) {
          if (t.status === "blocked" && t.dependsOn.every((d) => checkpoint.completedTaskIds.includes(d))) {
            t.status = "pending"
          }
        }
      }

      // Save checkpoint and reset timeout
      checkpoint.lastCheckpointAt = Date.now()
      saveCheckpoint(runId, checkpoint)
      emit({ type: "checkpoint-saved", runId, completedCount: checkpoint.completedTaskIds.length })
      resetTimeout() // Reset timeout on each checkpoint (activity indicator)
    }

    // 7. Complete
    updateRunStatus(runId, "completed")
    const summary = synthesizeResults(checkpoint.taskResults)
    emit({ type: "run-completed", runId, summary })
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    if (runId) {
      updateRunStatus(runId, "failed")
      emit({ type: "run-failed", runId, error: errorMsg })
    } else {
      emit({ type: "error", runId: "", message: errorMsg })
    }
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle)
    currentOrchestrationDepth--
    if (runId) {
      activeRuns.delete(runId)
    }
  }
}

export async function resumeRun(
  runId: string,
  params: Omit<OrchestrationParams, "decompositionResponse">,
): Promise<void> {
  const checkpoint = loadCheckpoint(runId)
  if (!checkpoint) {
    params.emit({ type: "error", runId, message: "No checkpoint found for run" })
    return
  }

  updateRunStatus(runId, "executing")
  params.emit({ type: "run-resumed", runId })

  // Re-dispatch is handled by the main loop picking up from checkpoint
  // For a full resume, the caller should reconstruct and call runOrchestration
  // with the stored decomposition response. This is a simplified resume.
}

// ============ Internal Helpers ============

interface ExecuteTaskContext {
  runId: string
  cwd: string
  memoryContent: string
  checkpoint: CheckpointData
  sensitivity: ApprovalSensitivity
  abortController: AbortController
  emit: (event: OrchestrationEvent) => void
  taskMap: Map<string, TaskNode>
}

async function executeTask(
  task: TaskNode,
  ctx: ExecuteTaskContext,
): Promise<WorkerResult | null> {
  const { runId, cwd, memoryContent, checkpoint, sensitivity, abortController, emit } = ctx

  // Approval gate for strict mode
  if (sensitivity === "strict" && task.workerType === "implementer") {
    const approved = await requestApproval(runId, task, emit)
    if (!approved) return null
  }

  // Approval gate for normal mode on reviewers
  if (sensitivity === "normal" && task.workerType === "implementer") {
    // Normal mode: auto-approve implementers but require approval for risky ops
    // For now, auto-approve
  }

  task.status = "running"
  updateTaskStatus(task.id, "running")
  emit({ type: "task-started", runId, taskId: task.id, description: task.description, workerType: task.workerType })

  const result = await runWorker({
    task,
    cwd,
    memoryContent,
    priorResults: checkpoint.taskResults,
    abortSignal: abortController.signal,
  })

  return result
}

async function requestApproval(
  runId: string,
  task: TaskNode,
  emit: (event: OrchestrationEvent) => void,
): Promise<boolean> {
  emit({ type: "approval-needed", runId, taskId: task.id, description: task.description })

  return new Promise<boolean>((resolve) => {
    pendingApprovals.set(task.id, { resolve, taskId: task.id })
  })
}

function loadMemoryContext(projectPath: string): MemoryContext {
  const memoryMd = readMemoryMdCached(projectPath)

  // Load all topic files
  const topicFiles: Record<string, string> = {}
  const { readdirSync, existsSync } = require("fs")
  const { join } = require("path")
  const topicsDir = join(projectPath, ".2code", "memory", "topics")

  if (existsSync(topicsDir)) {
    const files = readdirSync(topicsDir) as string[]
    for (const filename of files) {
      if (filename.endsWith(".md")) {
        const content = readTopicFile(projectPath, filename)
        if (content) topicFiles[filename] = content
      }
    }
  }

  return { memoryMd, topicFiles }
}

function buildMemoryContentString(ctx: MemoryContext): string {
  const parts: string[] = []
  if (ctx.memoryMd) parts.push(ctx.memoryMd)

  for (const [filename, content] of Object.entries(ctx.topicFiles)) {
    if (content) {
      parts.push(`\n## ${filename}\n${content}`)
    }
  }

  return parts.join("\n")
}

function synthesizeResults(taskResults: Record<string, WorkerResult>): string {
  const summaries = Object.entries(taskResults).map(
    ([id, r]) => `- ${id}: ${r.summary}`,
  )
  return summaries.join("\n") || "All tasks completed."
}
