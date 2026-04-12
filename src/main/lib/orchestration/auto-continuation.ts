/**
 * Auto-Continuation Bridge
 *
 * Integrates auto-continuation as a primitive within the orchestrator.
 * The task extractor from a Claude response becomes one input to the
 * orchestrator's task graph (rather than a standalone queue system).
 *
 * This module extracts actionable tasks from assistant messages and
 * converts them into an orchestration-compatible task graph.
 */

import { createId } from "../db/utils"
import type { TaskGraph, TaskNode, WorkerType } from "./types"

/**
 * Extract tasks from a Claude assistant response.
 * Looks for TODO items, action items, numbered steps, and task-like patterns.
 */
export function extractTasksFromResponse(responseText: string): ExtractedTask[] {
  const tasks: ExtractedTask[] = []

  // Pattern 1: Markdown task items (- [ ] or * [ ])
  const taskItemRegex = /^[\s]*[-*]\s*\[[ x]?\]\s*(.+)$/gm
  let match: RegExpExecArray | null
  while ((match = taskItemRegex.exec(responseText)) !== null) {
    tasks.push({
      description: match[1]!.trim(),
      type: "todo",
    })
  }

  // Pattern 2: Numbered steps with action verbs
  const numberedStepRegex = /^\s*\d+\.\s*((?:Create|Modify|Update|Add|Remove|Fix|Implement|Refactor|Test|Write|Delete|Configure|Set up|Install|Move|Rename|Extract)\s.+)$/gim
  while ((match = numberedStepRegex.exec(responseText)) !== null) {
    const desc = match[1]!.trim()
    // Avoid duplicates from task items
    if (!tasks.some((t) => t.description === desc)) {
      tasks.push({
        description: desc,
        type: "step",
      })
    }
  }

  // Pattern 3: "TODO:" or "ACTION:" markers
  const markerRegex = /(?:TODO|ACTION|NEXT|FIXME):\s*(.+)$/gim
  while ((match = markerRegex.exec(responseText)) !== null) {
    const desc = match[1]!.trim()
    if (!tasks.some((t) => t.description === desc)) {
      tasks.push({
        description: desc,
        type: "marker",
      })
    }
  }

  return tasks
}

interface ExtractedTask {
  description: string
  type: "todo" | "step" | "marker"
}

/**
 * Infer the worker type from a task description.
 */
function inferWorkerType(description: string): WorkerType {
  const lower = description.toLowerCase()

  if (
    lower.includes("research") ||
    lower.includes("investigate") ||
    lower.includes("analyze") ||
    lower.includes("find") ||
    lower.includes("search") ||
    lower.includes("check") ||
    lower.includes("review")
  ) {
    return "researcher"
  }

  if (
    lower.includes("plan") ||
    lower.includes("design") ||
    lower.includes("architect") ||
    lower.includes("spec")
  ) {
    return "planner"
  }

  if (
    lower.includes("test") ||
    lower.includes("verify") ||
    lower.includes("validate") ||
    lower.includes("audit")
  ) {
    return "reviewer"
  }

  // Default to implementer for action-oriented tasks
  return "implementer"
}

/**
 * Convert extracted tasks into an orchestration-compatible TaskGraph.
 * Tasks are sequenced linearly (each depends on the previous) since
 * they typically come from a step-by-step plan.
 */
export function buildTaskGraphFromExtracted(
  extracted: ExtractedTask[],
  options?: { parallel?: boolean },
): TaskGraph {
  if (extracted.length === 0) return { tasks: [] }

  const tasks: TaskNode[] = []
  let previousId: string | null = null

  for (const item of extracted) {
    const id = createId()
    const workerType = inferWorkerType(item.description)

    tasks.push({
      id,
      workerType,
      description: item.description,
      dependsOn: options?.parallel ? [] : previousId ? [previousId] : [],
      memoryFiles: ["MEMORY.md"],
      status: previousId && !options?.parallel ? "blocked" : "pending",
    })

    previousId = id
  }

  return { tasks }
}

/**
 * Build a decomposition response string from extracted tasks,
 * compatible with the orchestration start endpoint.
 */
export function buildDecompositionFromExtracted(
  responseText: string,
  options?: { parallel?: boolean },
): string | null {
  const extracted = extractTasksFromResponse(responseText)
  if (extracted.length === 0) return null

  const graph = buildTaskGraphFromExtracted(extracted, options)
  return JSON.stringify(graph, null, 2)
}
