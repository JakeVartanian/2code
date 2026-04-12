/**
 * Superpowers Workflow — Predefined orchestration template.
 *
 * Maps the full Superpowers workflow to a task DAG:
 *   brainstorm → plan → execute → review → post-review
 *
 * Each step maps to a worker type with appropriate memory context.
 */

import type { TaskGraph, TaskNode, WorkerType } from "./types"
import { createId } from "../db/utils"

interface SuperpowersWorkflowParams {
  goal: string
}

/**
 * Build a TaskGraph for the full Superpowers workflow.
 * Steps: brainstorm → plan → execute → review → post-review
 */
export function buildSuperpowersTaskGraph(params: SuperpowersWorkflowParams): TaskGraph {
  const { goal } = params

  const brainstormId = createId()
  const planId = createId()
  const executeId = createId()
  const reviewId = createId()
  const postReviewId = createId()

  const tasks: TaskNode[] = [
    {
      id: brainstormId,
      workerType: "researcher",
      description: `Brainstorm approaches for: ${goal}\n\nExplore the codebase, identify relevant patterns, consider multiple implementation strategies, and document trade-offs. Focus on understanding the problem space fully before committing to a solution.`,
      dependsOn: [],
      memoryFiles: ["MEMORY.md", "architecture-decisions.md"],
      status: "pending",
    },
    {
      id: planId,
      workerType: "planner",
      description: `Create a detailed implementation plan for: ${goal}\n\nBased on the brainstorming findings, create a step-by-step plan with:\n- Files to modify/create\n- Key design decisions\n- Potential risks and mitigations\n- Testing strategy`,
      dependsOn: [brainstormId],
      memoryFiles: ["MEMORY.md", "conventions.md"],
      status: "blocked",
    },
    {
      id: executeId,
      workerType: "implementer",
      description: `Implement the plan for: ${goal}\n\nFollow the plan from the previous step. Make focused, minimal changes. Write clean code following project conventions.`,
      dependsOn: [planId],
      memoryFiles: ["MEMORY.md", "conventions.md", "operational-knowledge.md"],
      status: "blocked",
    },
    {
      id: reviewId,
      workerType: "reviewer",
      description: `Review the implementation of: ${goal}\n\nCheck for:\n- Correctness and completeness\n- Code quality and style consistency\n- Potential bugs or edge cases\n- Security concerns\n- Performance implications`,
      dependsOn: [executeId],
      memoryFiles: ["MEMORY.md"],
      status: "blocked",
    },
    {
      id: postReviewId,
      workerType: "implementer",
      description: `Address review findings for: ${goal}\n\nFix any issues identified in the review. Make only the changes needed to resolve review feedback.`,
      dependsOn: [reviewId],
      memoryFiles: ["MEMORY.md"],
      status: "blocked",
    },
  ]

  return { tasks }
}

/**
 * Build decomposition response string from a Superpowers task graph.
 * This format matches what parseDecompositionResponse expects.
 */
export function buildSuperpowersDecompositionResponse(goal: string): string {
  const graph = buildSuperpowersTaskGraph({ goal })
  return JSON.stringify(graph, null, 2)
}

/** Superpowers worker type mapping for each step */
export const SUPERPOWERS_STEPS: { name: string; workerType: WorkerType; memoryReads: string[] }[] = [
  { name: "brainstorm", workerType: "researcher", memoryReads: ["MEMORY.md", "architecture-decisions.md"] },
  { name: "plan", workerType: "planner", memoryReads: ["MEMORY.md", "conventions.md"] },
  { name: "execute", workerType: "implementer", memoryReads: ["MEMORY.md", "conventions.md", "operational-knowledge.md"] },
  { name: "review", workerType: "reviewer", memoryReads: ["MEMORY.md"] },
  { name: "post-review", workerType: "implementer", memoryReads: ["MEMORY.md"] },
]
