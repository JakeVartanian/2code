/**
 * Task Decomposer — Parses Claude's decomposition response into a validated TaskGraph.
 *
 * Also provides the prompt template for asking Claude to decompose a goal.
 */

import { createId } from "../db/utils"
import type { MemoryContext, TaskGraph, TaskNode, WorkerType } from "./types"

const VALID_WORKER_TYPES: WorkerType[] = ["researcher", "implementer", "reviewer", "planner"]

/**
 * Build the prompt that asks Claude to decompose a goal into a task graph.
 * The caller sends this as a plan-mode message; Claude returns JSON.
 */
export function buildDecompositionPrompt(
  goal: string,
  memoryContext: MemoryContext,
): string {
  const memorySection = memoryContext.memoryMd
    ? `\n<project-memory>\n${memoryContext.memoryMd}\n</project-memory>\n`
    : ""

  return `You are a planning agent. Decompose the following goal into a task graph.

${memorySection}
## Goal
${goal}

## Instructions
Return a JSON object with this exact shape:
\`\`\`json
{
  "tasks": [
    {
      "id": "task-1",
      "workerType": "researcher" | "implementer" | "reviewer" | "planner",
      "description": "What this task should accomplish",
      "dependsOn": [],
      "memoryFiles": []
    }
  ]
}
\`\`\`

Rules:
- Use descriptive IDs like "task-1", "task-2", etc.
- workerType must be one of: researcher, implementer, reviewer, planner
- dependsOn lists task IDs that must complete before this task can start
- memoryFiles lists topic filenames from the memory vault relevant to this task
- Keep the graph as flat as possible — minimize unnecessary dependencies
- Reviewer tasks should depend on the implementer tasks they review
- Return ONLY the JSON block, no other text`
}

/**
 * Extract and parse the JSON task graph from Claude's decomposition response.
 * Handles markdown code fences and raw JSON.
 */
export function parseDecompositionResponse(response: string): TaskGraph {
  // Try to extract JSON from code fences first
  const fenceMatch = response.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/)
  const jsonStr = fenceMatch ? fenceMatch[1]! : response.trim()

  let raw: unknown
  try {
    raw = JSON.parse(jsonStr)
  } catch (e) {
    throw new Error(`Failed to parse decomposition response as JSON: ${(e as Error).message}`)
  }

  if (!raw || typeof raw !== "object" || !("tasks" in raw) || !Array.isArray((raw as any).tasks)) {
    throw new Error("Decomposition response must contain a 'tasks' array")
  }

  const rawTasks = (raw as { tasks: unknown[] }).tasks
  if (rawTasks.length === 0) {
    throw new Error("Decomposition returned zero tasks")
  }

  const tasks: TaskNode[] = rawTasks.map((t: any, i: number) => {
    const id = typeof t.id === "string" && t.id ? t.id : `task-${i + 1}`
    const workerType: WorkerType = VALID_WORKER_TYPES.includes(t.workerType)
      ? t.workerType
      : "implementer"

    const dependsOn = Array.isArray(t.dependsOn)
      ? t.dependsOn.filter((d: unknown) => typeof d === "string")
      : []

    const memoryFiles = Array.isArray(t.memoryFiles)
      ? t.memoryFiles.filter((f: unknown) => typeof f === "string")
      : []

    return {
      id,
      workerType,
      description: typeof t.description === "string" ? t.description : `Task ${i + 1}`,
      dependsOn,
      memoryFiles,
      status: "pending" as const,
    }
  })

  // Assign unique IDs if there are duplicates
  const seenIds = new Set<string>()
  for (const task of tasks) {
    if (seenIds.has(task.id)) {
      task.id = `${task.id}-${createId()}`
    }
    seenIds.add(task.id)
  }

  // Validate DAG — check for circular dependencies
  validateDag(tasks)

  // Set initial statuses: blocked if has dependencies, pending otherwise
  const taskIds = new Set(tasks.map((t) => t.id))
  for (const task of tasks) {
    // Filter out references to non-existent tasks
    task.dependsOn = task.dependsOn.filter((d) => taskIds.has(d))
    task.status = task.dependsOn.length > 0 ? "blocked" : "pending"
  }

  return { tasks }
}

/**
 * Validate that the task graph is a DAG (no circular dependencies).
 * Throws if a cycle is detected.
 */
function validateDag(tasks: TaskNode[]): void {
  const taskMap = new Map(tasks.map((t) => [t.id, t]))
  const visited = new Set<string>()
  const inStack = new Set<string>()

  function visit(id: string): void {
    if (inStack.has(id)) {
      throw new Error(`Circular dependency detected involving task "${id}"`)
    }
    if (visited.has(id)) return

    inStack.add(id)
    const task = taskMap.get(id)
    if (task) {
      for (const dep of task.dependsOn) {
        if (taskMap.has(dep)) {
          visit(dep)
        }
      }
    }
    inStack.delete(id)
    visited.add(id)
  }

  for (const task of tasks) {
    visit(task.id)
  }
}
