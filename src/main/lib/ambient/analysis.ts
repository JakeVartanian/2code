/**
 * Ambient Tier 2 — Sonnet deep analysis.
 * Called for items that pass Haiku triage with high relevance.
 * Produces actionable suggestions with full descriptions and suggested prompts.
 */

import { readFileSync, existsSync, statSync } from "fs"
import { join } from "path"
import type { AmbientProvider } from "./provider"
import { BudgetTracker } from "./budget"
import type { AnalysisResult, HeuristicResult, SuggestionCategory } from "./types"

const ANALYSIS_SYSTEM_PROMPT = `You are GAAD — a developer's strategic partner. You've been asked to deeply analyze a finding. Your job: determine if this is genuinely worth the developer's attention, and if so, provide an insight they wouldn't have reached on their own.

Think beyond code correctness. Consider:
- What does this mean for the PRODUCT? Could this bug reach users? Could this pattern become a feature?
- What does this mean for the ARCHITECTURE? Is this a one-off fix or a sign of a deeper design issue?
- What does this ENABLE? Sometimes a code change opens doors the developer hasn't noticed yet.
- What's the RISK? Not just "will it crash" but "will it slow down the team, confuse users, or create tech debt?"

Given a code observation, provide:
1. A punchy title that makes them curious (max 60 chars) — NOT a linter message
2. A markdown description: what you found, why it matters beyond just the code, what the real-world consequence is (2-4 sentences, write like you're briefing a CTO who also codes)
3. The correct category: bug|security|performance|test-gap|dead-code|dependency|blind-spot|risk|next-step
4. Severity: "info" (interesting to know), "warning" (should address soon), "error" (fix now)
5. Confidence 0-100 (how certain this is genuinely worth acting on?)
6. A specific prompt to address it — include file names, function names, the exact change or investigation

Output ONLY valid JSON:
{
  "title": "...",
  "description": "...",
  "category": "...",
  "severity": "info|warning|error",
  "confidence": 75,
  "suggestedPrompt": "..."
}

You are NOT a linter. Never flag: console.log, type assertions, style preferences, missing comments, unused imports. Focus on: product implications, architectural evolution, hidden dependencies, integration risks, strategic opportunities, and connections between code changes and user impact.`

/**
 * Run Sonnet deep analysis on a triaged finding.
 * Reads the affected file(s) for full context.
 */
export async function analyzeWithSonnet(
  candidate: HeuristicResult,
  provider: AmbientProvider,
  budget: BudgetTracker,
  projectPath: string,
  projectContext: string,
): Promise<AnalysisResult | null> {
  if (!provider.info.supportsSonnet) return null

  // Estimate tokens: system (~300) + file content (~1500) + context (~200) + output (~500)
  const estimatedInput = 2000
  const estimatedOutput = 500
  if (!budget.canSpend("sonnet", estimatedInput, estimatedOutput)) {
    return null
  }

  // Read affected file contents (truncated to keep within budget)
  const fileContents = readAffectedFiles(candidate.triggerFiles, projectPath, 3000)

  const userPrompt = buildAnalysisPrompt(candidate, fileContents, projectContext)

  try {
    const result = await provider.callSonnet(ANALYSIS_SYSTEM_PROMPT, userPrompt)

    // Record spend
    budget.recordSpend("sonnet", result.inputTokens, result.outputTokens)

    // Parse response
    const analysis = parseAnalysisResponse(result.text, candidate)
    if (!analysis) return null

    return {
      ...analysis,
      triggerFiles: candidate.triggerFiles,
      tokensUsed: { input: result.inputTokens, output: result.outputTokens },
    }
  } catch (err) {
    console.error("[Ambient] Sonnet analysis failed:", err)
    return null
  }
}

function readAffectedFiles(files: string[], projectPath: string, maxChars: number): string {
  const sections: string[] = []
  let totalChars = 0

  for (const file of files) {
    if (totalChars >= maxChars) break

    const fullPath = join(projectPath, file)
    if (!existsSync(fullPath)) continue

    try {
      // Skip files larger than 100KB to avoid loading huge files into memory
      const stat = statSync(fullPath)
      if (stat.size > 100_000) continue

      let content = readFileSync(fullPath, "utf-8")
      const remaining = maxChars - totalChars
      if (content.length > remaining) {
        content = content.slice(0, remaining) + "\n[...truncated]"
      }
      sections.push(`--- ${file} ---\n${content}`)
      totalChars += content.length
    } catch {
      continue
    }
  }

  return sections.join("\n\n")
}

function buildAnalysisPrompt(
  candidate: HeuristicResult,
  fileContents: string,
  projectContext: string,
): string {
  let prompt = ""

  if (projectContext) {
    prompt += `Project context:\n${projectContext}\n\n`
  }

  prompt += `Finding to analyze:\n`
  prompt += `Category: ${candidate.category}\n`
  prompt += `Severity: ${candidate.severity}\n`
  prompt += `Title: ${candidate.title}\n`
  prompt += `Description: ${candidate.description}\n`
  prompt += `Files: ${candidate.triggerFiles.join(", ")}\n\n`
  prompt += `File contents:\n${fileContents}\n`

  return prompt
}

const VALID_CATEGORIES: Set<string> = new Set([
  "bug", "security", "performance", "test-gap", "dead-code", "dependency", "blind-spot", "risk", "next-step",
])

function parseAnalysisResponse(
  text: string,
  fallback: HeuristicResult,
): Omit<AnalysisResult, "triggerFiles" | "tokensUsed"> | null {
  try {
    // Extract JSON from response
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (!jsonMatch) return null

    const parsed = JSON.parse(jsonMatch[0]) as {
      title?: string
      description?: string
      category?: string
      severity?: string
      confidence?: number
      suggestedPrompt?: string
    }

    // Validate required fields
    if (!parsed.title || !parsed.description) return null

    const confidence = typeof parsed.confidence === "number"
      ? Math.max(0, Math.min(100, Math.round(parsed.confidence)))
      : fallback.confidence

    // Low confidence = Sonnet doesn't think this is real, skip it
    // Lowered from 65 → 50: let Sonnet speak, filter harder in post-processing
    if (confidence < 50) return null

    return {
      title: parsed.title.slice(0, 100),
      description: parsed.description,
      category: (VALID_CATEGORIES.has(parsed.category ?? "") ? parsed.category : fallback.category) as SuggestionCategory,
      severity: (["info", "warning", "error"].includes(parsed.severity ?? "") ? parsed.severity : fallback.severity) as AnalysisResult["severity"],
      confidence,
      suggestedPrompt: parsed.suggestedPrompt ?? `Fix the issue: ${parsed.title}\n\nFiles: ${fallback.triggerFiles.join(", ")}`,
    }
  } catch {
    console.warn("[Ambient] Failed to parse Sonnet analysis response")
    return null
  }
}
