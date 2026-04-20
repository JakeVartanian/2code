/**
 * Enhanced memory injection — uses ambient intelligence to predict which
 * memories a session will need based on file coupling and project brain state.
 *
 * Wraps the existing `getMemoriesForInjection()` with:
 * 1. File path extraction from the user's prompt
 * 2. Coupled file expansion (from git temporal coupling data)
 * 3. File-linked memory pre-loading
 * 4. Brain summary block (architecture, active initiative, hotspots)
 * 5. Increased token budget when brain is rich
 */

import { eq, and } from "drizzle-orm"
import { getDatabase } from "../db"
import { projectMemories } from "../db/schema"
import { getMemoriesForInjection, type InjectionResult } from "../memory/injection"

/**
 * Enhanced injection that uses ambient knowledge for predictive context loading.
 * Falls back to standard injection if no ambient data is available.
 */
export async function getEnhancedMemoryInjection(
  projectId: string,
  userPrompt: string,
  baseTokenBudget: number = 2000,
): Promise<InjectionResult> {
  const db = getDatabase()

  // Get all memories to check brain richness
  const allMemories = db.select()
    .from(projectMemories)
    .where(and(
      eq(projectMemories.projectId, projectId),
      eq(projectMemories.isArchived, false),
    ))
    .all()

  // If brain is rich (10+ memories), increase token budget
  const tokenBudget = allMemories.length >= 10 ? Math.min(baseTokenBudget + 1000, 4000) : baseTokenBudget

  // Step 1: Extract file paths mentioned in the user's prompt
  const mentionedFiles = extractFilePaths(userPrompt)

  // Step 2: Expand with coupled files (from architecture memories)
  const coupledFiles = getCoupledFiles(allMemories, mentionedFiles)
  const allRelevantFiles = [...new Set([...mentionedFiles, ...coupledFiles])]

  // Step 3: Build enhanced context hint from prompt + relevant files
  const enhancedHint = allRelevantFiles.length > 0
    ? `${userPrompt}\n\nRelevant files: ${allRelevantFiles.join(", ")}`
    : userPrompt

  // Step 4: Get standard injection with enhanced hint (clamp budget to prevent negative)
  const baseInjection = await getMemoriesForInjection(projectId, enhancedHint, Math.max(tokenBudget - 300, 500))

  // Step 5: Prepend brain summary if available
  const brainSummary = buildBrainSummary(allMemories)
  if (brainSummary && baseInjection.markdown) {
    const combined = brainSummary + "\n\n" + baseInjection.markdown
    return {
      markdown: combined,
      memoriesUsed: baseInjection.memoriesUsed,
      tokensUsed: baseInjection.tokensUsed + estimateTokens(brainSummary),
      memoryIds: baseInjection.memoryIds,
    }
  }

  return baseInjection
}

/**
 * Extract file paths from a user's message.
 * Requires either a `/` separator or a known code file extension to avoid
 * matching method calls like `React.memo` or `console.log`.
 */
const CODE_EXTENSIONS = new Set(["ts", "tsx", "js", "jsx", "py", "go", "rs", "css", "scss", "json", "yaml", "yml", "toml", "md", "sql", "html", "vue", "svelte"])

function extractFilePaths(text: string): string[] {
  const paths: string[] = []

  // Match patterns like src/foo/bar.ts, ./components/Button.tsx, etc.
  const pathPattern = /(?:^|\s|['"`])([a-zA-Z0-9_./-]+\.[a-zA-Z]{1,5})(?:\s|['"`]|$|:|\))/gm
  let match: RegExpExecArray | null
  while ((match = pathPattern.exec(text)) !== null) {
    const path = match[1]
    // Filter out URLs and common non-file patterns
    if (path.includes("://")) continue
    if (path.startsWith("http")) continue
    if (path.includes("..")) continue
    if (/^\d+\.\d+\.\d+/.test(path)) continue // Version numbers

    // Must contain a `/` (real file path) OR have a known code extension
    const ext = path.split(".").pop()?.toLowerCase()
    if (!path.includes("/") && (!ext || !CODE_EXTENSIONS.has(ext))) continue

    paths.push(path)
  }

  return [...new Set(paths)]
}

/**
 * Find files that are coupled to the mentioned files (from architecture memories).
 * Uses "Coupled files:" memories created by the backfill git coupling analysis.
 */
function getCoupledFiles(
  memories: Array<{ title: string; content: string; linkedFiles: string | null }>,
  mentionedFiles: string[],
): string[] {
  if (mentionedFiles.length === 0) return []

  const coupled: string[] = []

  // Look for coupling memories
  const couplingMemories = memories.filter(m =>
    m.title.startsWith("Coupled files:") && m.linkedFiles
  )

  for (const memory of couplingMemories) {
    let linkedFiles: string[]
    try {
      linkedFiles = JSON.parse(memory.linkedFiles!)
    } catch { continue } // Skip malformed JSON

    // If any mentioned file matches a linked file (path-segment-aware)
    for (const mentioned of mentionedFiles) {
      if (linkedFiles.some(f => pathMatches(f, mentioned))) {
        coupled.push(...linkedFiles.filter(f => !mentionedFiles.some(m => pathMatches(f, m))))
      }
    }
  }

  return [...new Set(coupled)].slice(0, 5) // Max 5 coupled files
}

/**
 * Build a compact brain summary block (~200 tokens) with architecture overview.
 */
function buildBrainSummary(
  memories: Array<{ category: string; title: string; isStale: boolean | null }>,
): string | null {
  if (memories.length < 5) return null // Not enough knowledge yet

  const architecture = memories.filter(m => m.category === "architecture" && !m.isStale)
  const conventions = memories.filter(m => m.category === "convention" && !m.isStale)
  const gotchas = memories.filter(m => m.category === "gotcha" && !m.isStale)

  if (architecture.length === 0 && conventions.length === 0) return null

  let summary = "# Project Brain Summary\n"

  if (architecture.length > 0) {
    summary += "## Architecture\n"
    summary += architecture.slice(0, 3).map(m => `- ${m.title}`).join("\n") + "\n"
  }

  if (conventions.length > 0) {
    summary += "## Conventions\n"
    summary += conventions.slice(0, 3).map(m => `- ${m.title}`).join("\n") + "\n"
  }

  if (gotchas.length > 0) {
    summary += "## Gotchas\n"
    summary += gotchas.slice(0, 2).map(m => `- ${m.title}`).join("\n") + "\n"
  }

  return summary
}

/**
 * Path-segment-aware comparison. Returns true if paths refer to the same file.
 * Handles cases like "auth.ts" matching "src/main/auth.ts" (suffix match on `/` boundary).
 */
function pathMatches(fullPath: string, mentioned: string): boolean {
  if (fullPath === mentioned) return true
  // Suffix match on path segment boundary
  if (fullPath.endsWith("/" + mentioned)) return true
  if (mentioned.endsWith("/" + fullPath)) return true
  return false
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}
