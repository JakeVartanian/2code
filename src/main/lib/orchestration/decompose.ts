/**
 * Decomposition engine — calls Claude to break a user goal into
 * parallel tasks with file ownership and dependency management.
 */

import { exec } from "node:child_process"
import { readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { getClaudeCodeTokenFresh } from "../trpc/routers/claude"
import {
  DECOMPOSITION_SYSTEM_PROMPT,
  buildDecompositionUserPrompt,
} from "./prompts"
import { extractJsonObject } from "./json-utils"

export interface DecomposeInput {
  userGoal: string
  projectPath: string
  projectMemories: string
}

export interface DecomposedTask {
  name: string
  description: string
  allowedPaths: string[]
  readOnlyPaths: string[]
  dependsOn: string[]
  acceptanceCriteria: string[]
  estimatedComplexity: "low" | "medium" | "high"
  mode: "agent" | "plan"
}

export interface DecomposedPlan {
  reasoning: string
  tasks: DecomposedTask[]
  fileConflicts: Array<{
    file: string
    tasks: string[]
    resolution: "serialize" | "integration-task"
  }>
}

/**
 * Run a shell command asynchronously with timeout.
 */
function execAsync(
  command: string,
  cwd: string,
  timeoutMs: number = 5000,
): Promise<string> {
  return new Promise((resolve) => {
    const child = exec(command, { cwd, timeout: timeoutMs, encoding: "utf-8" }, (error, stdout) => {
      if (error) {
        resolve("")
      } else {
        resolve(stdout?.trim() ?? "")
      }
    })

    // Safety kill
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs + 1000)
    child.on("exit", () => clearTimeout(timer))
  })
}

const TREE_IGNORE = new Set(["node_modules", ".git", "dist", ".next", "build", ".DS_Store"])

/**
 * Get a shallow file tree listing for the project (top 2 levels).
 * Uses Node.js fs APIs for cross-platform compatibility.
 */
function getFileTree(projectPath: string): string {
  const entries: string[] = ["."]
  try {
    const topLevel = readdirSync(projectPath)
    for (const name of topLevel) {
      if (TREE_IGNORE.has(name)) continue
      const fullPath = join(projectPath, name)
      entries.push(`./${name}`)
      try {
        if (statSync(fullPath).isDirectory()) {
          const children = readdirSync(fullPath)
          for (const child of children) {
            if (TREE_IGNORE.has(child)) continue
            entries.push(`./${name}/${child}`)
          }
        }
      } catch { /* permission error, skip */ }
      if (entries.length >= 200) break
    }
  } catch {
    return "(file tree unavailable)"
  }
  return entries.join("\n") || "(file tree unavailable)"
}

/**
 * Get recent git log for the project.
 */
async function getGitLog(projectPath: string): Promise<string> {
  const result = await execAsync(
    'git log --oneline -20 2>/dev/null || echo "(no git history)"',
    projectPath,
  )
  return result || "(git log unavailable)"
}

/**
 * Decompose a user goal into parallel tasks using Claude.
 */
export async function decomposeGoal(
  input: DecomposeInput,
): Promise<DecomposedPlan> {
  const token = await getClaudeCodeTokenFresh()
  if (!token) {
    throw new Error("Not authenticated with Claude. Please connect your account in Settings.")
  }

  const fileTree = getFileTree(input.projectPath)
  const recentGitLog = await getGitLog(input.projectPath)

  const userPrompt = buildDecompositionUserPrompt({
    userGoal: input.userGoal,
    fileTree,
    recentGitLog,
    projectMemories: input.projectMemories,
  })

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 90_000) // 90s timeout

  let response: Response
  try {
    response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5-20250929",
        max_tokens: 4096,
        system: DECOMPOSITION_SYSTEM_PROMPT,
        messages: [{ role: "user", content: userPrompt }],
      }),
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timeout)
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => "")
    // Truncate error body to prevent leaking sensitive API response data
    const safeError = errorText.slice(0, 200).replace(/sk-ant-[^\s"]+/g, "[REDACTED]")
    throw new Error(`Claude API error ${response.status}: ${safeError}`)
  }

  const result = (await response.json()) as {
    content?: Array<{ type: string; text?: string }>
  }
  const text = result.content?.[0]?.text ?? ""

  // Parse the JSON response using balanced brace extraction
  let plan: DecomposedPlan
  try {
    const jsonStr = extractJsonObject(text)
    if (!jsonStr) {
      throw new Error("No JSON object found in response")
    }
    plan = JSON.parse(jsonStr)
  } catch (parseError) {
    console.error("[decompose] Failed to parse plan JSON:", text.slice(0, 500))
    throw new Error(
      `Failed to parse decomposition plan: ${parseError instanceof Error ? parseError.message : "unknown error"}`,
    )
  }

  // Validate the plan structure
  if (!plan.tasks || !Array.isArray(plan.tasks) || plan.tasks.length === 0) {
    throw new Error("Decomposition produced no tasks")
  }

  if (plan.tasks.length > 8) {
    // Truncate to max 8 tasks
    plan.tasks = plan.tasks.slice(0, 8)
  }

  // Ensure all tasks have required fields with defaults
  plan.tasks = plan.tasks.map((task, i) => ({
    name: task.name || `Task ${i + 1}`,
    description: task.description || "",
    allowedPaths: task.allowedPaths || [],
    readOnlyPaths: task.readOnlyPaths || [],
    dependsOn: task.dependsOn || [],
    acceptanceCriteria: task.acceptanceCriteria || [],
    estimatedComplexity: task.estimatedComplexity || "medium",
    mode: task.mode || "agent",
  }))

  plan.reasoning = plan.reasoning || ""
  plan.fileConflicts = plan.fileConflicts || []

  // Auto-serialize file conflicts by adding dependency edges
  for (const conflict of plan.fileConflicts) {
    if (conflict.resolution === "serialize" && conflict.tasks.length >= 2) {
      // Add dependency: second task depends on first
      const laterTask = plan.tasks.find((t) => t.name === conflict.tasks[1])
      if (laterTask && !laterTask.dependsOn.includes(conflict.tasks[0]!)) {
        laterTask.dependsOn.push(conflict.tasks[0]!)
      }
    }
  }

  return plan
}
