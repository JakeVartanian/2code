/**
 * Result aggregation — generates a summary of the completed orchestration run
 * using a lightweight Claude call.
 */

import { getClaudeCodeTokenFresh } from "../trpc/routers/claude"
import {
  AGGREGATION_SYSTEM_PROMPT,
  buildAggregationUserPrompt,
} from "./prompts"

export interface AggregationInput {
  userGoal: string
  taskResults: Array<{
    name: string
    status: string
    resultSummary: string | null
    filesModified?: string[]
  }>
  qualityGateResults?: string
}

/**
 * Generate an aggregated summary of the orchestration run.
 */
export async function aggregateResults(
  input: AggregationInput,
): Promise<string> {
  const token = await getClaudeCodeTokenFresh()
  if (!token) {
    // Fallback: generate a simple summary without Claude
    return generateFallbackSummary(input)
  }

  const userPrompt = buildAggregationUserPrompt(input)

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
        max_tokens: 1024,
        system: AGGREGATION_SYSTEM_PROMPT,
        messages: [{ role: "user", content: userPrompt }],
      }),
      signal: controller.signal,
    })

    if (!response.ok) {
      console.error(`[aggregation] API error ${response.status}`)
      return generateFallbackSummary(input)
    }

    const result = (await response.json()) as {
      content?: Array<{ type: string; text?: string }>
    }
    return result.content?.[0]?.text ?? generateFallbackSummary(input)
  } catch (error) {
    console.error("[aggregation] Failed:", error)
    return generateFallbackSummary(input)
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * Generate a simple summary without Claude (fallback).
 */
function generateFallbackSummary(input: AggregationInput): string {
  const completed = input.taskResults.filter((t) => t.status === "completed")
  const failed = input.taskResults.filter((t) => t.status === "failed")
  const skipped = input.taskResults.filter((t) => t.status === "skipped")

  const lines: string[] = []
  lines.push(`**Goal:** ${input.userGoal}`)
  lines.push("")
  lines.push(
    `**Result:** ${completed.length}/${input.taskResults.length} tasks completed` +
      (failed.length > 0 ? `, ${failed.length} failed` : "") +
      (skipped.length > 0 ? `, ${skipped.length} skipped` : ""),
  )

  if (completed.length > 0) {
    lines.push("")
    lines.push("**Completed tasks:**")
    for (const t of completed) {
      lines.push(`- ${t.name}: ${t.resultSummary || "Done"}`)
    }
  }

  if (failed.length > 0) {
    lines.push("")
    lines.push("**Failed tasks:**")
    for (const t of failed) {
      lines.push(`- ${t.name}: ${t.resultSummary || "Failed"}`)
    }
  }

  if (input.qualityGateResults) {
    lines.push("")
    lines.push(`**Quality gates:** ${input.qualityGateResults}`)
  }

  return lines.join("\n")
}
