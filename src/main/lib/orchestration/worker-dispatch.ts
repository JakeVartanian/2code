/**
 * Worker Dispatch — Spawns isolated Claude SDK sessions for each task.
 *
 * Each worker type has tool restrictions and a tailored system prompt.
 * Uses the same dynamic import + env build pattern as claude.ts.
 */

import { app } from "electron"
import * as fs from "fs/promises"
import * as path from "path"
import { buildClaudeEnv, getBundledClaudeBinaryPath } from "../claude/env"
import { loadSkillMemoryContext, extractSkillMemoryWrites } from "../memory/skill-context"
import { addEntry } from "../memory/vault"
import { createId } from "../db/utils"
import type { MemoryEntry } from "../memory/types"
import type { TaskNode, WorkerResult, WorkerType } from "./types"

// ============ Tool Restrictions ============

export const WORKER_TOOL_RESTRICTIONS: Record<WorkerType, string[]> = {
  researcher: ["Read", "Glob", "Grep", "Bash", "WebSearch", "WebFetch"],
  implementer: [], // empty = all tools allowed
  reviewer: ["Read", "Glob", "Grep", "Bash"],
  planner: ["Read", "Glob", "Grep", "Bash"],
}

// ============ System Prompts ============

export function buildWorkerSystemPrompt(
  task: TaskNode,
  memoryContent: string,
  priorResults: Record<string, WorkerResult>,
): string {
  const parts: string[] = []

  // Worker-specific instructions
  switch (task.workerType) {
    case "researcher":
      parts.push(
        "You are a research agent. Your job is to investigate the codebase and gather information.",
        "Do NOT make any code changes. Only read, search, and analyze.",
        "Return your findings in a structured JSON block at the end.",
      )
      break
    case "implementer":
      parts.push(
        "You are an implementation agent. Your job is to write code changes.",
        "Make targeted, focused changes. Do not over-engineer.",
        "Return a summary of changes in a structured JSON block at the end.",
      )
      break
    case "reviewer":
      parts.push(
        "You are a code review agent. Your job is to review recent changes for correctness.",
        "Do NOT make changes. Only read and analyze.",
        "Return your review findings in a structured JSON block at the end.",
      )
      break
    case "planner":
      parts.push(
        "You are a planning agent. Your job is to analyze and create implementation plans.",
        "Do NOT make code changes. Only read, search, and plan.",
        "Return your plan in a structured JSON block at the end.",
      )
      break
  }

  // Memory context
  if (memoryContent) {
    parts.push("", "<project-memory>", memoryContent, "</project-memory>")
  }

  // Prior task results
  const priorIds = Object.keys(priorResults)
  if (priorIds.length > 0) {
    parts.push("", "## Prior Task Results")
    for (const id of priorIds) {
      const r = priorResults[id]!
      parts.push(`### ${id}`)
      parts.push(`Summary: ${r.summary}`)
      if (r.filesChanged?.length) parts.push(`Files changed: ${r.filesChanged.join(", ")}`)
      if (r.findings?.length) parts.push(`Findings: ${r.findings.join("; ")}`)
      if (r.issues?.length) parts.push(`Issues: ${r.issues.join("; ")}`)
    }
  }

  // Task description
  parts.push(
    "",
    "## Your Task",
    task.description,
    "",
    "## Output Format",
    "When done, output a JSON block with your results:",
    "```json",
    "{",
    '  "summary": "Brief summary of what you did/found",',
    '  "filesChanged": ["list of files you modified (if any)"],',
    '  "findings": ["key findings or observations"],',
    '  "issues": ["any problems or concerns found"]',
    "}",
    "```",
  )

  return parts.join("\n")
}

// ============ Result Parsing ============

export function parseWorkerResult(outputText: string, _workerType: WorkerType): WorkerResult {
  // Try to extract JSON from the output
  const fenceMatch = outputText.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/)
  if (fenceMatch) {
    try {
      const parsed = JSON.parse(fenceMatch[1]!)
      return {
        summary: typeof parsed.summary === "string" ? parsed.summary : "Task completed",
        filesChanged: Array.isArray(parsed.filesChanged) ? parsed.filesChanged : undefined,
        findings: Array.isArray(parsed.findings) ? parsed.findings : undefined,
        issues: Array.isArray(parsed.issues) ? parsed.issues : undefined,
      }
    } catch {
      // Fall through to fallback
    }
  }

  // Fallback: use the full output as the summary (truncated)
  return {
    summary: outputText.slice(0, 500) || "Task completed (no structured output)",
  }
}

// ============ Tool Restriction Callback ============

export function buildWorkerCanUseTool(workerType: WorkerType): ((name: string) => boolean) | undefined {
  const allowed = WORKER_TOOL_RESTRICTIONS[workerType]
  if (allowed.length === 0) return undefined // no restrictions
  return (name: string) => allowed.includes(name)
}

// ============ Worker Execution ============

// Dynamic import cache (same pattern as claude.ts)
let cachedClaudeQuery: typeof import("@anthropic-ai/claude-agent-sdk").query | null = null
const getClaudeQuery = async () => {
  if (cachedClaudeQuery) return cachedClaudeQuery
  const sdk = await import("@anthropic-ai/claude-agent-sdk")
  cachedClaudeQuery = sdk.query
  return cachedClaudeQuery
}

export interface RunWorkerParams {
  task: TaskNode
  cwd: string
  memoryContent: string
  priorResults: Record<string, WorkerResult>
  abortSignal: AbortSignal
  credentialsDir?: string
  customEnv?: Record<string, string>
  /** Project path for skill memory reads/writes */
  projectPath?: string
  /** Topic files to read (from skill's memory_reads) */
  skillMemoryReads?: string[]
  /** Topic files the skill may write to (from skill's memory_writes) */
  skillMemoryWrites?: string[]
}

export async function runWorker(params: RunWorkerParams): Promise<WorkerResult> {
  const { task, cwd, memoryContent, priorResults, abortSignal, credentialsDir, customEnv, projectPath, skillMemoryReads, skillMemoryWrites } = params

  const query = await getClaudeQuery()

  // Inject skill memory context if available
  let enrichedMemoryContent = memoryContent
  if (projectPath && skillMemoryReads && skillMemoryReads.length > 0) {
    const skillContext = loadSkillMemoryContext(projectPath, skillMemoryReads)
    if (skillContext) {
      enrichedMemoryContent = enrichedMemoryContent
        ? `${enrichedMemoryContent}\n\n${skillContext}`
        : skillContext
    }
  }

  const systemPrompt = buildWorkerSystemPrompt(task, enrichedMemoryContent, priorResults)
  const canUseTool = buildWorkerCanUseTool(task.workerType)

  // Build isolated config dir for this worker
  const configDir = path.join(
    app.getPath("userData"),
    "orchestration-sessions",
    task.id,
  )
  await fs.mkdir(configDir, { recursive: true })

  // Copy credentials if provided
  if (credentialsDir) {
    const credPath = path.join(credentialsDir, ".credentials.json")
    try {
      const credContent = await fs.readFile(credPath, "utf-8")
      await fs.writeFile(path.join(configDir, ".credentials.json"), credContent)
    } catch {
      // Credentials may not exist — SDK will use env-based auth
    }
  }

  const env = buildClaudeEnv({ customEnv })

  // Collect text output from the worker
  let outputText = ""

  const result = await query({
    prompt: task.description,
    systemPrompt,
    options: {
      cwd,
      maxTurns: 30,
      allowedTools: canUseTool ? WORKER_TOOL_RESTRICTIONS[task.workerType] : undefined,
    },
    executable: getBundledClaudeBinaryPath(),
    abortController: { signal: abortSignal } as AbortController,
    env: {
      ...env,
      CLAUDE_CONFIG_DIR: configDir,
    },
  })

  // Extract text from messages
  for (const msg of result.messages) {
    if (msg.role === "assistant") {
      if (typeof msg.content === "string") {
        outputText += msg.content
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === "text") {
            outputText += block.text
          }
        }
      }
    }
  }

  // Clean up config dir
  try {
    await fs.rm(configDir, { recursive: true, force: true })
  } catch {
    // Non-critical
  }

  const workerResult = parseWorkerResult(outputText, task.workerType)

  // Capture skill memory writes if configured
  if (projectPath && skillMemoryWrites && skillMemoryWrites.length > 0) {
    try {
      const memoryWrites = extractSkillMemoryWrites(outputText, skillMemoryWrites)
      for (const { filename, entries } of memoryWrites) {
        for (const partial of entries) {
          if (partial.body && partial.meta) {
            const entry: MemoryEntry = {
              body: partial.body,
              meta: {
                ...partial.meta,
                id: partial.meta.id || createId(),
              },
            }
            addEntry(projectPath, entry)
          }
        }
      }
    } catch (err) {
      console.warn("[worker-dispatch] Failed to capture memory writes:", err)
    }
  }

  return workerResult
}
