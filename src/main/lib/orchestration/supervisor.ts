/**
 * Reactive supervisor — detects stuck workers and determines interventions.
 * Runs in the main process with access to message history in DB.
 */

import { getDatabase } from "../db"
import { orchestrationTasks, subChats } from "../db/schema"
import { eq } from "drizzle-orm"
import { getClaudeCodeTokenFresh } from "../trpc/routers/claude"
import {
  SUPERVISOR_DIAGNOSIS_SYSTEM_PROMPT,
  buildDiagnosisUserPrompt,
} from "./prompts"
import { extractJsonObject } from "./json-utils"

export interface StuckWorker {
  taskId: string
  taskName: string
  subChatId: string
  reason: string
  severity: "warning" | "stuck"
}

export interface DiagnosisResult {
  diagnosis: string
  intervention: "retry_with_hint" | "re_scope" | "skip" | "escalate"
  hint?: string
  reason: string
}

/**
 * Check all running tasks in a run for stuck signals.
 * @param workerTimeoutSeconds — max seconds a worker can run before being flagged (default 900 = 15min)
 */
export function checkStuckWorkers(runId: string, workerTimeoutSeconds: number = 900): StuckWorker[] {
  const db = getDatabase()
  const stuck: StuckWorker[] = []

  const tasks = db
    .select()
    .from(orchestrationTasks)
    .where(eq(orchestrationTasks.runId, runId))
    .all()

  const runningTasks = tasks.filter(
    (t) => t.status === "running" && t.subChatId,
  )

  for (const task of runningTasks) {
    // Check absolute worker timeout first
    if (task.startedAt) {
      const elapsed = Date.now() - new Date(task.startedAt).getTime()
      if (elapsed > workerTimeoutSeconds * 1000) {
        stuck.push({
          taskId: task.id,
          taskName: task.name,
          subChatId: task.subChatId!,
          reason: `Worker timeout exceeded: running for ${Math.round(elapsed / 60000)} minutes (limit: ${Math.round(workerTimeoutSeconds / 60)} min)`,
          severity: "stuck",
        })
        continue // Skip message-level checks, this is definitively stuck
      }
    }
    const sc = db
      .select()
      .from(subChats)
      .where(eq(subChats.id, task.subChatId!))
      .get()

    if (!sc) continue

    let messages: Array<Record<string, unknown>> = []
    try {
      messages = JSON.parse(sc.messages || "[]")
    } catch {
      continue
    }

    if (messages.length === 0) continue

    const reason = detectStuckSignal(messages, task.startedAt)
    if (reason) {
      stuck.push({
        taskId: task.id,
        taskName: task.name,
        subChatId: task.subChatId!,
        reason,
        severity: "stuck",
      })
    }
  }

  return stuck
}

/**
 * Detect if a worker is stuck based on its message history.
 */
function detectStuckSignal(
  messages: Array<Record<string, unknown>>,
  taskStartedAt: Date | string | null,
): string | null {
  const now = Date.now()

  // Check idle timeout: no messages for 3 minutes
  const lastMsg = messages[messages.length - 1]
  if (lastMsg) {
    const lastMsgTime = getMessageTimestamp(lastMsg)
    if (lastMsgTime && now - lastMsgTime > 3 * 60 * 1000) {
      return `Idle for ${Math.round((now - lastMsgTime) / 60000)} minutes — no new messages`
    }
  }

  // Check for error loops: 5+ consecutive tool call errors in recent messages
  const recentMessages = messages.slice(-15)
  let consecutiveErrors = 0
  for (const msg of recentMessages) {
    if (isToolCallError(msg)) {
      consecutiveErrors++
    } else {
      consecutiveErrors = 0
    }
  }
  if (consecutiveErrors >= 5) {
    return `Error loop detected: ${consecutiveErrors} consecutive tool call errors`
  }

  // Check for repetition: same tool called 6+ times with similar input
  const toolCalls = recentMessages.filter(isToolCall)
  if (toolCalls.length >= 6) {
    const toolNames = toolCalls.map(getToolName).filter(Boolean)
    const mostCommon = getMostCommonItem(toolNames)
    if (mostCommon && toolNames.filter((n) => n === mostCommon).length >= 6) {
      return `Repetition loop: tool "${mostCommon}" called ${toolNames.filter((n) => n === mostCommon).length} times`
    }
  }

  // Check message bloat: 8+ assistant messages without any file writes
  const assistantMsgs = recentMessages.filter(
    (m) => m.role === "assistant",
  )
  if (assistantMsgs.length >= 8) {
    const hasFileWrite = recentMessages.some(
      (m) => isToolCall(m) && isFileWriteTool(m),
    )
    if (!hasFileWrite) {
      return `Message bloat: ${assistantMsgs.length} messages without file modifications`
    }
  }

  return null
}

/**
 * Call Claude to diagnose a stuck worker and recommend intervention.
 */
export async function diagnoseStuckWorker(
  taskDescription: string,
  subChatId: string,
  stuckReason: string,
): Promise<DiagnosisResult> {
  const db = getDatabase()
  const sc = db
    .select()
    .from(subChats)
    .where(eq(subChats.id, subChatId))
    .get()

  let lastMessages = "(no messages available)"
  if (sc) {
    try {
      const messages = JSON.parse(sc.messages || "[]") as Array<
        Record<string, unknown>
      >
      const recent = messages.slice(-5)
      lastMessages = recent
        .map((m) => {
          const role = m.role as string
          const content =
            typeof m.content === "string"
              ? m.content
              : JSON.stringify(m.content)
          return `[${role}]: ${(content || "").slice(0, 500)}`
        })
        .join("\n\n")
    } catch {
      /* ignore */
    }
  }

  const token = await getClaudeCodeTokenFresh()
  if (!token) {
    return {
      diagnosis: "Cannot diagnose — not authenticated",
      intervention: "escalate",
      reason: "Authentication required for diagnosis",
    }
  }

  const userPrompt = buildDiagnosisUserPrompt({
    taskDescription,
    lastMessages,
    stuckReason,
  })

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 30_000) // 30s timeout

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 512,
        system: SUPERVISOR_DIAGNOSIS_SYSTEM_PROMPT,
        messages: [{ role: "user", content: userPrompt }],
      }),
      signal: controller.signal,
    })

    if (!response.ok) {
      const errorText = await response.text().catch(() => "")
      const safeError = errorText.slice(0, 200).replace(/sk-ant-[^\s"]+/g, "[REDACTED]")
      throw new Error(`Supervisor API error ${response.status}: ${safeError}`)
    }

    const result = (await response.json()) as {
      content?: Array<{ type: string; text?: string }>
    }
    const text = result.content?.[0]?.text ?? ""

    const jsonStr = extractJsonObject(text)
    if (!jsonStr) {
      return {
        diagnosis: "Failed to parse diagnosis",
        intervention: "escalate",
        reason: "Diagnosis response was not valid JSON",
      }
    }

    const diagnosis = JSON.parse(jsonStr) as DiagnosisResult
    return {
      diagnosis: diagnosis.diagnosis || "Unknown issue",
      intervention: diagnosis.intervention || "escalate",
      hint: diagnosis.hint,
      reason: diagnosis.reason || "No reason provided",
    }
  } catch (error) {
    console.error("[supervisor] Diagnosis failed:", error)
    return {
      diagnosis:
        error instanceof Error ? error.message : "Diagnosis call failed",
      intervention: "escalate",
      reason: "API call failed",
    }
  } finally {
    clearTimeout(timeout)
  }
}

// ============================================================================
// Message analysis helpers
// ============================================================================

function getMessageTimestamp(msg: Record<string, unknown>): number | null {
  if (typeof msg.createdAt === "number") return msg.createdAt
  if (typeof msg.createdAt === "string") return new Date(msg.createdAt).getTime()
  return null
}

function isToolCall(msg: Record<string, unknown>): boolean {
  if (msg.role !== "assistant") return false
  const content = msg.content
  if (Array.isArray(content)) {
    return content.some(
      (c: Record<string, unknown>) => c.type === "tool-call" || c.type === "tool_use",
    )
  }
  return false
}

function isToolCallError(msg: Record<string, unknown>): boolean {
  if (msg.role !== "tool") return false
  const content =
    typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content)
  return /error|failed|exception|ENOENT|EPERM/i.test(content || "")
}

function getToolName(msg: Record<string, unknown>): string | null {
  if (!Array.isArray(msg.content)) return null
  const toolCall = (msg.content as Array<Record<string, unknown>>).find(
    (c) => c.type === "tool-call" || c.type === "tool_use",
  )
  return (toolCall?.toolName as string) || (toolCall?.name as string) || null
}

function isFileWriteTool(msg: Record<string, unknown>): boolean {
  const name = getToolName(msg)
  return (
    name === "Write" ||
    name === "Edit" ||
    name === "write_file" ||
    name === "edit_file"
  )
}

function getMostCommonItem(items: (string | null)[]): string | null {
  const counts = new Map<string, number>()
  for (const item of items) {
    if (!item) continue
    counts.set(item, (counts.get(item) || 0) + 1)
  }
  let maxCount = 0
  let maxItem: string | null = null
  for (const [item, count] of counts) {
    if (count > maxCount) {
      maxCount = count
      maxItem = item
    }
  }
  return maxItem
}
