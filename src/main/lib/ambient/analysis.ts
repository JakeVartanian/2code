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

const ANALYSIS_SYSTEM_PROMPT = `You are GAAD — a senior architect who connects dots across files that others miss.

WHAT TO FIND (priority order):
1. CROSS-FILE IMPACT: If a changed export is consumed by files not in the diff, flag potential breakage with both file paths.
2. STATE INCONSISTENCY: A mutation in one file that another file's logic assumes won't happen. Trace the data flow.
3. MISSING ERROR PROPAGATION: A new error/null return path that callers don't handle.
4. RACE CONDITIONS: Concurrent access patterns that the change introduces or exposes.
5. CONCRETE BUGS: Null derefs, off-by-one, wrong comparator — with exact evidence from the code.

You have import/consumer context. Use it to find connections the developer can't easily see.

QUALITY FILTER — before outputting, check:
1. "Am I adding insight beyond what git diff shows?" → If no, skip.
2. "Is this actually broken, or does it just LOOK wrong from limited context?" → If unsure, skip.
3. "Does project memory already document this?" → If yes, only flag if the code CONTRADICTS it.

NEVER FLAG: Linter issues, style, unused vars, generic advice, hypotheticals without evidence.

Title: State the finding as a fact. Max 55 chars. No backticks.
Description: 1-2 sentences. What's wrong and why it matters.
suggestedPrompt: CONCRETE FIX as a direct instruction: "In file X, function Y, change Z to W because..."
- NEVER say "check", "verify", "investigate", "look into", "confirm", "if X then Y"
- If you can't state the exact fix, output confidence:0

Output ONLY valid JSON:
{
  "title": "...",
  "description": "...",
  "category": "bug|security|performance|test-gap|dead-code|dependency|blind-spot|risk|next-step",
  "severity": "info|warning|error",
  "confidence": 75,
  "suggestedPrompt": "..."
}

If the finding isn't genuinely valuable, output: {"title":"","description":"","confidence":0}`

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
  const fileContents = readAffectedFiles(candidate.triggerFiles, projectPath, 5000)

  const userPrompt = buildAnalysisPrompt(candidate, fileContents, projectContext)

  try {
    const result = await provider.callSonnet(ANALYSIS_SYSTEM_PROMPT, userPrompt)

    // Record spend
    budget.recordSpend("sonnet", result.inputTokens, result.outputTokens)

    // Parse response
    const analysis = parseAnalysisResponse(result.text, candidate)
    if (!analysis) return null

    const fullResult: AnalysisResult = {
      ...analysis,
      triggerFiles: candidate.triggerFiles,
      tokensUsed: { input: result.inputTokens, output: result.outputTokens },
    }

    // Verify suggestion references real code before returning
    const verification = verifySuggestion(fullResult, projectPath)
    if (!verification.valid) {
      console.log(`[GAAD] Verification rejected "${fullResult.title}": ${verification.reason} (${verification.identifiersFound}/${verification.identifiersChecked} found)`)
      return null
    }

    return fullResult
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
  "bug", "security", "performance", "test-gap", "dead-code", "dependency", "blind-spot", "risk", "next-step", "design",
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

// ── Post-analysis verification ──

export interface VerificationResult {
  valid: boolean
  reason?: string
  identifiersChecked: number
  identifiersFound: number
}

/**
 * Re-reads affected files from disk and checks that identifiers
 * mentioned in the suggestion actually exist in the current code.
 * Zero LLM cost — pure filesystem verification.
 */
export function verifySuggestion(
  result: { triggerFiles: string[]; title: string; suggestedPrompt?: string },
  projectPath: string,
): VerificationResult {
  const { triggerFiles, title, suggestedPrompt } = result

  // Extract identifiers from title + suggested prompt
  const textToCheck = `${title} ${suggestedPrompt ?? ""}`
  const identifiers = extractCodeIdentifiers(textToCheck)

  // If no identifiers extracted (purely descriptive language), skip verification
  if (identifiers.length === 0) {
    return { valid: true, reason: "no identifiers to verify", identifiersChecked: 0, identifiersFound: 0 }
  }

  // Read current file contents from disk
  let combinedContent = ""
  let filesExist = 0

  for (const file of triggerFiles) {
    const fullPath = join(projectPath, file)
    if (!existsSync(fullPath)) continue
    filesExist++

    try {
      const stat = statSync(fullPath)
      if (stat.size > 200_000) continue // skip very large files
      combinedContent += " " + readFileSync(fullPath, "utf-8")
    } catch { continue }
  }

  // If all trigger files were deleted, reject
  if (triggerFiles.length > 0 && filesExist === 0) {
    return { valid: false, reason: "all trigger files deleted", identifiersChecked: identifiers.length, identifiersFound: 0 }
  }

  // Check how many identifiers exist in the current files
  let found = 0
  for (const id of identifiers) {
    if (combinedContent.includes(id)) found++
  }

  const ratio = found / identifiers.length

  // Require at least 25% of identifiers to be present (lowered — AI often
  // references callers/consumers not in the trigger files but still valid)
  if (ratio < 0.25) {
    return {
      valid: false,
      reason: `only ${found}/${identifiers.length} identifiers found in current code`,
      identifiersChecked: identifiers.length,
      identifiersFound: found,
    }
  }

  return { valid: true, identifiersChecked: identifiers.length, identifiersFound: found }
}

/**
 * Extract code identifiers from suggestion text.
 * Looks for function names, variable names, class names — things that
 * should exist in the actual codebase if the suggestion is valid.
 */
function extractCodeIdentifiers(text: string): string[] {
  const identifiers: string[] = []

  const COMMON_WORDS = new Set([
    "this", "that", "with", "from", "have", "been", "will", "they",
    "when", "what", "which", "their", "about", "would", "could", "should",
    "always", "never", "must", "file", "files", "code", "uses", "using",
    "pattern", "project", "function", "class", "module", "component",
    "system", "apply", "applies", "change", "changes", "here", "there",
    "check", "look", "find", "make", "ensure", "verify", "confirm",
    "before", "after", "return", "returns", "handle", "handles",
    "title", "description", "error", "warning", "issue", "problem",
    "implementation", "investigate", "affected", "address", "include",
    "includes", "update", "create", "delete", "remove", "modify",
  ])

  // Extract identifiers (camelCase, PascalCase, snake_case, 4+ chars)
  const identifierPattern = /\b([a-zA-Z_][a-zA-Z0-9_]{3,50})\b/g
  const matches = text.match(identifierPattern) ?? []

  for (const match of matches) {
    const lower = match.toLowerCase()
    if (COMMON_WORDS.has(lower)) continue

    // Keep if it looks like a code identifier
    if (match.includes("_") || /[a-z][A-Z]/.test(match) || /^[A-Z][a-z]/.test(match) || match.length >= 8) {
      identifiers.push(match)
    }
  }

  // Extract backtick-quoted strings (often function/file names in prompts)
  const backtickPattern = /`([^`]{2,50})`/g
  let btMatch: RegExpExecArray | null
  while ((btMatch = backtickPattern.exec(text)) !== null) {
    const val = btMatch[1].trim()
    // Skip if it's a file path (those are checked via triggerFiles)
    if (!val.includes("/") && !val.includes("\\")) {
      identifiers.push(val)
    }
  }

  return [...new Set(identifiers)].slice(0, 15)
}
