/**
 * Result aggregation — generates a summary of the completed orchestration run
 * using a lightweight Claude call.
 */

import { callClaude } from "../claude/api"
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
  const userPrompt = buildAggregationUserPrompt(input)

  try {
    const { text } = await callClaude({
      system: AGGREGATION_SYSTEM_PROMPT,
      userMessage: userPrompt,
      maxTokens: 1024,
      timeoutMs: 30_000,
    })
    return text || generateFallbackSummary(input)
  } catch (error) {
    console.error("[aggregation] Failed:", error)
    return generateFallbackSummary(input)
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
