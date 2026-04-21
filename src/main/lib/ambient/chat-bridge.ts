/**
 * Chat bridge — forwards lightweight chat activity events from Claude
 * streaming sessions to the ambient agent pipeline.
 *
 * This is the critical connector between "what the user is doing in chats"
 * and "what the ambient agent analyzes." Without it, the ambient agent
 * only sees git diffs and has zero awareness of active development work.
 *
 * All calls are non-blocking (queueMicrotask) to ensure zero latency
 * impact on the chat streaming path.
 */

import { ambientAgentRegistry } from "./index"
import type { ChatActivityEvent } from "./types"

// Per-session event accumulator for post-session synthesis
const sessionEvents = new Map<string, ChatActivityEvent[]>()

/**
 * Emit a chat activity event to the ambient agent for the given project.
 * If no agent is running for the project, silently drops the event.
 * Always non-blocking — uses queueMicrotask to defer processing.
 */
export function emitChatEvent(event: ChatActivityEvent): void {
  // Accumulate events per session for post-session synthesis
  if (event.activityType !== "session-complete" && event.activityType !== "session-error") {
    const existing = sessionEvents.get(event.subChatId) ?? []
    existing.push(event)
    // Cap at 100 events per session to bound memory
    if (existing.length <= 100) {
      sessionEvents.set(event.subChatId, existing)
    }
  }

  queueMicrotask(() => {
    try {
      const agent = ambientAgentRegistry.get(event.projectId)
      if (!agent) return // No agent running — silently drop

      agent.ingestChatEvent(event)

      // Log for debugging (single line, no spam)
      if (event.activityType === "session-complete" || event.activityType === "tool-error") {
        console.log(
          `[ChatBridge] ${event.activityType} → ambient (project=${event.projectId.slice(0, 8)}, sub=${event.subChatId.slice(0, 8)})`,
        )
      }
    } catch {
      // Never let bridge errors propagate to the chat stream
    }
  })
}

/**
 * Get accumulated events for a session (for post-session synthesis).
 * Returns the events and clears the buffer.
 */
export function drainSessionEvents(subChatId: string): ChatActivityEvent[] {
  const events = sessionEvents.get(subChatId) ?? []
  sessionEvents.delete(subChatId)
  return events
}

/**
 * Get a summary of accumulated session activity for synthesis prompts.
 */
export function buildSessionSummary(subChatId: string): string {
  const events = sessionEvents.get(subChatId) ?? []
  if (events.length === 0) return ""

  const prompts = events.filter(e => e.activityType === "user-prompt")
  const toolCalls = events.filter(e => e.activityType === "tool-call")
  const errors = events.filter(e => e.activityType === "tool-error")

  // Collect unique files touched
  const files = new Set<string>()
  for (const e of events) {
    if (e.filePaths) {
      for (const f of e.filePaths) files.add(f)
    }
  }

  // Collect unique tools used
  const tools = new Set<string>()
  for (const e of toolCalls) {
    if (e.toolName) tools.add(e.toolName)
  }

  const parts: string[] = []
  parts.push(`Session had ${prompts.length} user messages, ${toolCalls.length} tool calls, ${errors.length} errors.`)

  if (files.size > 0) {
    parts.push(`Files touched: ${[...files].slice(0, 20).join(", ")}${files.size > 20 ? ` (+${files.size - 20} more)` : ""}`)
  }

  if (tools.size > 0) {
    parts.push(`Tools used: ${[...tools].join(", ")}`)
  }

  // Include user prompt themes (first 3 prompts, truncated)
  if (prompts.length > 0) {
    parts.push("User topics:")
    for (const p of prompts.slice(0, 3)) {
      parts.push(`- ${p.summary.slice(0, 150)}`)
    }
  }

  // Include errors
  if (errors.length > 0) {
    parts.push("Errors encountered:")
    for (const e of errors.slice(0, 5)) {
      parts.push(`- [${e.toolName ?? "unknown"}] ${e.summary.slice(0, 200)}`)
    }
  }

  return parts.join("\n")
}
