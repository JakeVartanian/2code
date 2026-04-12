/**
 * Agent Orchestration Types
 *
 * Defines all types for goal decomposition, task DAG execution,
 * worker dispatch, checkpointing, and progress events.
 */

// ============ Status Enums ============

export type RunStatus =
  | "planning"
  | "executing"
  | "reviewing"
  | "completed"
  | "failed"
  | "paused"

export type TaskStatus =
  | "pending"
  | "blocked"
  | "running"
  | "completed"
  | "failed"
  | "skipped"

export type WorkerType = "researcher" | "implementer" | "reviewer" | "planner"

export type ApprovalSensitivity = "strict" | "normal" | "autonomous"

// ============ Task Graph ============

export interface TaskNode {
  id: string
  workerType: WorkerType
  description: string
  dependsOn: string[]
  memoryFiles: string[]
  status: TaskStatus
  result?: WorkerResult
  error?: string
  startedAt?: number
  completedAt?: number
}

export interface TaskGraph {
  tasks: TaskNode[]
}

// ============ Worker ============

export interface WorkerResult {
  summary: string
  filesChanged?: string[]
  issues?: string[]
  findings?: string[]
}

// ============ Checkpoint ============

export interface CheckpointData {
  completedTaskIds: string[]
  taskResults: Record<string, WorkerResult>
  accumulatedCostUsd: number
  lastCheckpointAt: number
}

// ============ Memory ============

export interface MemoryContext {
  memoryMd: string
  topicFiles: Record<string, string>
}

// ============ Progress Events ============

export type OrchestrationEvent =
  | { type: "run-started"; runId: string; goal: string }
  | { type: "planning-complete"; runId: string; taskCount: number }
  | { type: "task-started"; runId: string; taskId: string; description: string; workerType: WorkerType }
  | { type: "task-completed"; runId: string; taskId: string; result: WorkerResult }
  | { type: "task-failed"; runId: string; taskId: string; error: string }
  | { type: "checkpoint-saved"; runId: string; completedCount: number }
  | { type: "approval-needed"; runId: string; taskId: string; description: string }
  | { type: "cost-threshold"; runId: string; currentCostUsd: number; limitUsd: number }
  | { type: "run-completed"; runId: string; summary: string }
  | { type: "run-failed"; runId: string; error: string }
  | { type: "run-paused"; runId: string }
  | { type: "run-resumed"; runId: string }
  | { type: "error"; runId: string; message: string }

// ============ Orchestration Params ============

export interface OrchestrationParams {
  chatId: string
  subChatId: string
  goal: string
  cwd: string
  projectPath: string
  decompositionResponse: string
  sensitivity: ApprovalSensitivity
  costLimitUsd: number
  emit: (event: OrchestrationEvent) => void
}
