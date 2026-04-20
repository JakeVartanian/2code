/**
 * Ambient Tier 1 — Haiku triage.
 * Batches heuristic candidates into a single Haiku call for relevance scoring.
 * Items scoring above threshold proceed to Tier 2 (Sonnet analysis).
 */

import type { AmbientProvider } from "./provider"
import { BudgetTracker } from "./budget"
import type { HeuristicResult, TriageItem, TriageResult, SuggestionCategory } from "./types"

const VALID_CATEGORIES: Set<string> = new Set([
  "bug", "security", "performance", "test-gap", "dead-code", "dependency",
])

const TRIAGE_SYSTEM_PROMPT = `You are a code change triage system for a developer's local project. Given file changes and observations, rate each finding for actionability.

For each item, output a JSON array with objects containing:
- "index": the item number (0-based)
- "relevance": 0.0-1.0 (should a developer see this?)
- "category": the most accurate category (bug|security|performance|test-gap|dead-code|dependency)
- "urgency": low|medium|high
- "summary": <10 words if relevance > 0.5, empty string otherwise

Output ONLY the JSON array, no other text. Example:
[{"index":0,"relevance":0.8,"category":"bug","urgency":"high","summary":"Null deref when config missing"}]

Be selective. Most code changes are fine. Only flag genuinely concerning patterns. A relevance of 0.7+ means "a developer should look at this." Below 0.5 means "normal code, ignore."`

/**
 * Run Haiku triage on a batch of heuristic candidates.
 * Returns items that scored above the threshold.
 */
export async function triageWithHaiku(
  candidates: HeuristicResult[],
  provider: AmbientProvider,
  budget: BudgetTracker,
  projectContext: string,
  threshold: number,
): Promise<TriageResult> {
  if (candidates.length === 0) {
    return { items: [], tokensUsed: { input: 0, output: 0 } }
  }

  // Check budget before calling
  const estimatedInput = 400 + candidates.length * 150 // ~150 tokens per candidate
  const estimatedOutput = candidates.length * 50
  if (!budget.canSpend("haiku", estimatedInput, estimatedOutput)) {
    return { items: [], tokensUsed: { input: 0, output: 0 } }
  }

  // Build user prompt with candidates
  const userPrompt = buildTriagePrompt(candidates, projectContext)

  try {
    const result = await provider.callHaiku(TRIAGE_SYSTEM_PROMPT, userPrompt)

    // Record actual spend
    budget.recordSpend("haiku", result.inputTokens, result.outputTokens)

    // Parse response
    const items = parseTriageResponse(result.text, threshold)

    return {
      items,
      tokensUsed: { input: result.inputTokens, output: result.outputTokens },
    }
  } catch (err) {
    console.error("[Ambient] Haiku triage failed:", err)
    return { items: [], tokensUsed: { input: 0, output: 0 } }
  }
}

function buildTriagePrompt(candidates: HeuristicResult[], projectContext: string): string {
  let prompt = ""

  if (projectContext) {
    prompt += `Project context: ${projectContext}\n\n`
  }

  prompt += "File changes to triage:\n\n"

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i]
    prompt += `[${i}] ${c.severity.toUpperCase()}: ${c.title}\n`
    prompt += `    Files: ${c.triggerFiles.join(", ")}\n`
    prompt += `    Detail: ${c.description}\n\n`
  }

  return prompt
}

function parseTriageResponse(text: string, threshold: number): TriageItem[] {
  try {
    // Extract JSON array from response
    const jsonMatch = text.match(/\[[\s\S]*\]/)
    if (!jsonMatch) return []

    const parsed = JSON.parse(jsonMatch[0]) as Array<{
      index?: number
      relevance?: number
      category?: string
      urgency?: string
      summary?: string
    }>

    if (!Array.isArray(parsed)) return []

    return parsed
      .filter((item) => {
        if (typeof item.index !== "number" || item.index < 0) return false
        if (typeof item.relevance !== "number") return false
        return item.relevance >= threshold
      })
      .map((item) => ({
        index: item.index!,
        relevance: item.relevance!,
        category: (VALID_CATEGORIES.has(item.category ?? "") ? item.category : "bug") as SuggestionCategory,
        urgency: (["low", "medium", "high"].includes(item.urgency ?? "") ? item.urgency : "medium") as TriageItem["urgency"],
        summary: item.summary ?? "",
      }))
  } catch {
    console.warn("[Ambient] Failed to parse triage response")
    return []
  }
}
