/**
 * Orchestration Checkpoint — DB persistence for runs and tasks.
 *
 * Provides CRUD helpers for orchestration_runs and orchestration_tasks tables,
 * plus checkpoint save/load for crash recovery and pause-resume.
 */

import { eq, inArray } from "drizzle-orm"
import { getDatabase, orchestrationRuns, orchestrationTasks } from "../db"
import { createId } from "../db/utils"
import type {
  CheckpointData,
  MemoryContext,
  RunStatus,
  TaskGraph,
  TaskStatus,
  WorkerResult,
} from "./types"

// ============ Run CRUD ============

export function createRunInDb(params: {
  chatId: string
  subChatId?: string
  goal: string
  taskGraph: TaskGraph
  memoryContext: MemoryContext
}): { runId: string; taskIds: string[] } {
  const db = getDatabase()
  const runId = createId()

  db.insert(orchestrationRuns)
    .values({
      id: runId,
      chatId: params.chatId,
      subChatId: params.subChatId,
      goal: params.goal,
      status: "planning",
      taskGraph: JSON.stringify(params.taskGraph),
      memoryContext: JSON.stringify(params.memoryContext),
      checkpoint: JSON.stringify({
        completedTaskIds: [],
        taskResults: {},
        accumulatedCostUsd: 0,
        lastCheckpointAt: Date.now(),
      } satisfies CheckpointData),
    })
    .run()

  const taskIds: string[] = []
  for (const task of params.taskGraph.tasks) {
    const taskId = task.id || createId()
    taskIds.push(taskId)

    db.insert(orchestrationTasks)
      .values({
        id: taskId,
        runId,
        workerType: task.workerType,
        description: task.description,
        status: task.status,
        dependsOn: JSON.stringify(task.dependsOn),
        memoryFiles: JSON.stringify(task.memoryFiles),
      })
      .run()
  }

  return { runId, taskIds }
}

// ============ Checkpoint ============

export function saveCheckpoint(runId: string, data: CheckpointData): void {
  const db = getDatabase()
  db.update(orchestrationRuns)
    .set({
      checkpoint: JSON.stringify(data),
      totalCostUsd: Math.round(data.accumulatedCostUsd * 100_000), // convert to millicents
      updatedAt: new Date(),
    })
    .where(eq(orchestrationRuns.id, runId))
    .run()
}

export function loadCheckpoint(runId: string): CheckpointData | null {
  const db = getDatabase()
  const run = db
    .select({ checkpoint: orchestrationRuns.checkpoint })
    .from(orchestrationRuns)
    .where(eq(orchestrationRuns.id, runId))
    .get()

  if (!run?.checkpoint) return null
  try {
    return JSON.parse(run.checkpoint) as CheckpointData
  } catch {
    return null
  }
}

// ============ Status Updates ============

export function updateRunStatus(runId: string, status: RunStatus): void {
  const db = getDatabase()
  const isTerminal = status === "completed" || status === "failed"
  db.update(orchestrationRuns)
    .set({
      status,
      updatedAt: new Date(),
      ...(isTerminal ? { completedAt: new Date() } : {}),
    })
    .where(eq(orchestrationRuns.id, runId))
    .run()
}

export function updateTaskStatus(
  taskId: string,
  status: TaskStatus,
  extra?: { result?: WorkerResult; error?: string },
): void {
  const db = getDatabase()
  const isStarting = status === "running"
  const isTerminal = status === "completed" || status === "failed" || status === "skipped"

  db.update(orchestrationTasks)
    .set({
      status,
      ...(isStarting ? { startedAt: new Date() } : {}),
      ...(isTerminal ? { completedAt: new Date() } : {}),
      ...(extra?.result ? { result: JSON.stringify(extra.result) } : {}),
      ...(extra?.error ? { error: extra.error } : {}),
    })
    .where(eq(orchestrationTasks.id, taskId))
    .run()
}

// ============ Queries ============

export function getRunWithTasks(runId: string) {
  const db = getDatabase()
  const run = db
    .select()
    .from(orchestrationRuns)
    .where(eq(orchestrationRuns.id, runId))
    .get()

  if (!run) return null

  const tasks = db
    .select()
    .from(orchestrationTasks)
    .where(eq(orchestrationTasks.runId, runId))
    .all()

  return { run, tasks }
}

export function getRunsForChat(chatId: string) {
  const db = getDatabase()
  return db
    .select()
    .from(orchestrationRuns)
    .where(eq(orchestrationRuns.chatId, chatId))
    .all()
}

export function getIncompleteRuns() {
  const db = getDatabase()
  return db
    .select()
    .from(orchestrationRuns)
    .where(
      inArray(orchestrationRuns.status, ["planning", "executing", "reviewing"]),
    )
    .all()
}
