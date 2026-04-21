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

  // Use setImmediate to yield to I/O between events (queueMicrotask blocks I/O)
  setImmediate(() => {
    try {
      const agent = ambientAgentRegistry.get(event.projectId)
      if (!agent) return // No agent running — silently drop

      agent.ingestChatEvent(event)

      // Log for debugging (single line, no spam)
      if (event.activityType === "session-complete" || event.activityType === "tool-error") {
        console.log(
          `[GAAD] ${event.activityType} → pipeline (project=${event.projectId.slice(0, 8)}, sub=${event.subChatId.slice(0, 8)})`,
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

  // Split files into read vs modified (the distinction tells a story)
  const filesRead = new Set<string>()
  const filesModified = new Set<string>()
  for (const e of events) {
    if (e.filePaths) {
      const isEdit = e.toolName === "Edit" || e.toolName === "Write" || e.toolName === "file_edit" || e.toolName === "file_write"
      for (const f of e.filePaths) {
        if (isEdit) filesModified.add(f)
        else filesRead.add(f)
      }
    }
  }

  // Get session metadata from the most recent event (session-complete has it)
  const lastEvent = events[events.length - 1]
  const meta = lastEvent?.sessionMeta

  const parts: string[] = []
  parts.push(`Session: ${prompts.length} user messages, ${toolCalls.length} tool calls, ${errors.length} errors.`)

  if (meta?.durationSeconds) {
    parts.push(`Duration: ${Math.round(meta.durationSeconds / 60)}min. Model: ${meta.model ?? "unknown"}.`)
  }

  if (filesModified.size > 0) {
    parts.push(`Files MODIFIED (${filesModified.size}): ${[...filesModified].slice(0, 15).join(", ")}`)
  }
  if (filesRead.size > 0) {
    parts.push(`Files READ (${filesRead.size}): ${[...filesRead].slice(0, 10).join(", ")}`)
  }

  // Tool call sequence (shows the working pattern)
  if (toolCalls.length > 0) {
    const sequence = toolCalls.slice(0, 30).map(e => e.toolName ?? "?").join(" → ")
    parts.push(`Tool sequence: ${sequence}`)
  }

  // All user prompts (not just 3 — the full conversation arc matters)
  if (prompts.length > 0) {
    parts.push("\nUser messages:")
    for (const p of prompts.slice(0, 10)) {
      parts.push(`- ${p.summary.slice(0, 300)}`)
    }
  }

  // Errors with context
  if (errors.length > 0) {
    parts.push("\nErrors encountered:")
    for (const e of errors.slice(0, 5)) {
      parts.push(`- [${e.toolName ?? "unknown"}] ${e.summary.slice(0, 200)}`)
    }
  }

  // Last assistant response excerpt (what Claude concluded)
  if (meta?.lastAssistantExcerpt) {
    parts.push(`\nClaude's last response (excerpt): ${meta.lastAssistantExcerpt}`)
  }

  return parts.join("\n")
}
