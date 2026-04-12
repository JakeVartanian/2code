/**
 * Auto-accretion pipeline
 *
 * Runs after a Claude session completes. Calls Haiku to extract
 * durable knowledge from the session transcript, then writes
 * entries to the memory vault.
 */

import { addEntry, writeSessionLog, hasVault, initVault } from "./vault"
import { maybeConsolidate } from "./consolidation"
import { ACCRETION_SYSTEM_PROMPT, buildAccretionUserPrompt } from "./accretion-prompt"
import { createId } from "../db/utils"
import type { MemoryEntry, MemoryCategory, MemoryConfidence } from "./types"

/** Message shape from subchat messages JSON */
interface SessionMessage {
  role: string
  parts?: Array<{ type: string; text?: string }>
  content?: string
}

/** Extracted entry from the LLM response */
interface ExtractedEntry {
  category: MemoryCategory
  confidence: MemoryConfidence
  tags: string[]
  title: string
  body: string
}

/**
 * Extract the last N messages from a session as a condensed transcript.
 * Limits total length to avoid sending too much to Haiku.
 */
function buildTranscript(messages: SessionMessage[], maxChars = 12000): string {
  const lines: string[] = []
  let totalChars = 0

  // Walk from the end (most recent) backwards
  for (let i = messages.length - 1; i >= 0 && totalChars < maxChars; i--) {
    const msg = messages[i]
    let text = ""
    if (msg.parts) {
      text = msg.parts
        .filter((p) => p.type === "text" && p.text)
        .map((p) => p.text!)
        .join("\n")
    } else if (msg.content) {
      text = msg.content
    }
    if (!text.trim()) continue

    // Truncate individual messages if very long
    if (text.length > 2000) {
      text = text.slice(0, 2000) + "\n...(truncated)"
    }

    lines.unshift(`[${msg.role}]: ${text}`)
    totalChars += text.length
  }

  return lines.join("\n\n")
}

/**
 * Call Haiku to extract memories from session transcript.
 * Uses raw fetch to the Anthropic API to avoid SDK dependency.
 */
async function callExtractionModel(transcript: string): Promise<ExtractedEntry[]> {
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY
    if (!apiKey) {
      console.log("[Memory/Accretion] No ANTHROPIC_API_KEY — skipping extraction")
      return []
    }

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 2000,
        system: ACCRETION_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: buildAccretionUserPrompt(transcript),
          },
        ],
      }),
    })

    if (!response.ok) {
      console.warn(`[Memory/Accretion] API returned ${response.status}`)
      return []
    }

    const data = await response.json() as {
      content: Array<{ type: string; text?: string }>
    }

    const text = data.content
      .filter((b) => b.type === "text" && b.text)
      .map((b) => b.text!)
      .join("")

    const parsed = JSON.parse(text)
    if (!Array.isArray(parsed)) return []
    return parsed as ExtractedEntry[]
  } catch (e) {
    console.warn("[Memory/Accretion] Extraction call failed:", e)
    return []
  }
}

/**
 * Run the full accretion pipeline for a completed session.
 * This is fire-and-forget — errors are logged but never thrown.
 *
 * @param projectPath - Project root directory (not worktree)
 * @param messages - Session messages from the sub-chat
 * @param chatId - Chat ID for source tracking
 * @param sessionSlug - Short slug for the session log filename
 */
export async function runAccretion(
  projectPath: string,
  messages: SessionMessage[],
  chatId: string,
  sessionSlug: string,
): Promise<void> {
  try {
    // Skip very short sessions
    if (messages.length < 4) return

    // Ensure vault exists
    if (!hasVault(projectPath)) initVault(projectPath)

    // Build transcript
    const transcript = buildTranscript(messages)
    if (transcript.length < 100) return

    // Extract memories
    const extracted = await callExtractionModel(transcript)

    // Write entries to vault
    let addedCount = 0
    for (const item of extracted) {
      const entry: MemoryEntry = {
        meta: {
          id: createId(),
          created: new Date().toISOString(),
          category: item.category,
          confidence: item.confidence,
          source: chatId,
          tags: item.tags || [],
          status: "active",
          lastReferenced: new Date().toISOString(),
        },
        body: `## ${item.title}\n\n${item.body}`,
      }

      const result = addEntry(projectPath, entry)
      if (result) addedCount++
    }

    // Write session log
    const logLines = [
      `# Session: ${sessionSlug}`,
      "",
      `**Date:** ${new Date().toISOString()}`,
      `**Messages:** ${messages.length}`,
      `**Memories extracted:** ${addedCount}`,
      "",
      "## Transcript Summary",
      "",
      transcript.slice(0, 3000),
    ]
    writeSessionLog(projectPath, sessionSlug, logLines.join("\n"))

    if (addedCount > 0) {
      console.log(`[Memory/Accretion] Added ${addedCount} entries for ${sessionSlug}`)
    }

    // Check if consolidation is due (every 10 sessions)
    maybeConsolidate(projectPath)
  } catch (e) {
    console.warn("[Memory/Accretion] Pipeline error (non-fatal):", e)
  }
}
