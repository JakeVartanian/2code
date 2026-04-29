/**
 * Memory injection module — token-budgeted selection of project memories
 * for injection into Claude session system prompts.
 */

import { getDatabase, getSqlite } from "../db"
import { projectMemories } from "../db/schema"
import { eq, and, sql } from "drizzle-orm"
import type { ProjectMemory } from "../db/schema"
import { searchMemories } from "./fts"
import { classifySessionType, SESSION_CATEGORY_MAP, type SessionType } from "./session-classifier"

/** Rough token estimate: ~4 chars per token for English text */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/** Category keywords for context hint matching */
const CATEGORY_KEYWORDS: Record<string, string[]> = {
  architecture: ["architecture", "structure", "schema", "database", "db", "api", "route", "endpoint", "component", "module"],
  convention: ["convention", "style", "naming", "pattern", "format", "lint", "rule"],
  deployment: ["deploy", "build", "ci", "cd", "release", "docker", "server", "host", "production"],
  debugging: ["debug", "fix", "bug", "error", "crash", "issue", "problem", "fail", "broken"],
  preference: ["prefer", "always", "never", "use", "avoid", "default", "config", "setting"],
  gotcha: ["gotcha", "caveat", "warning", "careful", "watch out", "important", "pitfall", "trap"],
  brand: ["brand", "voice", "tone", "messaging", "copy", "tagline", "positioning", "pitch", "narrative", "story", "brand kit", "color palette", "design system", "logo"],
  strategy: ["strategy", "vision", "roadmap", "priority", "goal", "decision", "audience", "market", "ship", "launch"],
  design: ["design", "ux", "ui", "pattern", "experience", "interface", "layout", "animation", "feel", "visual", "pencil", "sketch", "mockup", "wireframe", "canvas", ".pen", "prototype"],
}

/**
 * Extract file paths mentioned in text (for matching against linkedFiles).
 */
function extractFilePaths(text: string): string[] {
  // Match common file path patterns: src/foo/bar.ts, ./config.json, etc.
  const pathPattern = /(?:^|\s|["'`(])([.\w/-]+\.(?:ts|tsx|js|jsx|json|css|html|md|py|go|rs|sql|yml|yaml|toml|sh))\b/gi
  const matches = text.matchAll(pathPattern)
  return [...new Set([...matches].map(m => m[1]))]
}

/**
 * Score a memory based on relevance, recency, frequency, context hint, session type, and FTS match.
 */
function scoreMemory(
  memory: ProjectMemory,
  contextHint: string | null,
  sessionType?: SessionType,
  ftsMatchIds?: Set<string>,
): number {
  let score = memory.relevanceScore ?? 50

  // Boost: +10 if accessed in last 7 days
  if (memory.lastAccessedAt) {
    const daysSinceAccess = (Date.now() - memory.lastAccessedAt.getTime()) / (1000 * 60 * 60 * 24)
    if (daysSinceAccess <= 7) {
      score += 10
    }
  }

  // Boost: +5 per access count (capped at +25)
  score += Math.min((memory.accessCount ?? 0) * 5, 25)

  // Confidence tiers from validation count
  const vc = memory.validationCount ?? 0
  if (vc >= 5) score += 15       // Battle-tested, confirmed across many sessions
  else if (vc >= 3) score += 10  // Well-confirmed
  else if (vc >= 1) score += 5   // Confirmed at least once

  // LinkedFiles matching: +30 if user's mentioned files match memory's linked files
  // This is the highest-signal relevance indicator — files the user is working on
  if (contextHint && memory.linkedFiles) {
    try {
      const linked: string[] = JSON.parse(memory.linkedFiles)
      if (linked.length > 0) {
        const mentionedFiles = extractFilePaths(contextHint)
        const hasFileMatch = mentionedFiles.some(mentioned =>
          linked.some(linkedFile =>
            mentioned.endsWith(linkedFile) || linkedFile.endsWith(mentioned) ||
            mentioned.includes(linkedFile) || linkedFile.includes(mentioned)
          )
        )
        if (hasFileMatch) {
          score += 30 // Strongest boost — direct file relevance
        }
      }
    } catch { /* malformed linkedFiles JSON */ }
  }

  // Context hint matching (if provided)
  if (contextHint) {
    const hintLower = contextHint.toLowerCase()

    // Category keyword match: +15
    const categoryKeywords = CATEGORY_KEYWORDS[memory.category] ?? []
    if (categoryKeywords.some(kw => hintLower.includes(kw))) {
      score += 15
    }

    // Title/content keyword match: +10
    const titleLower = memory.title.toLowerCase()
    const contentLower = memory.content.toLowerCase()
    const hintWords = hintLower.split(/\s+/).filter(w => w.length > 3)
    const matchCount = hintWords.filter(word =>
      titleLower.includes(word) || contentLower.includes(word)
    ).length
    if (matchCount > 0) {
      score += Math.min(matchCount * 5, 20)
    }
  }

  // Session-type category match: +20
  if (sessionType && sessionType !== "general") {
    const relevantCategories = SESSION_CATEGORY_MAP[sessionType] ?? []
    if (relevantCategories.includes(memory.category)) {
      score += 20
    }
  }

  // FTS5 semantic match: +25 (strongest signal for contextual relevance)
  if (ftsMatchIds && ftsMatchIds.has(memory.id)) {
    score += 25
  }

  // Identity documents always inject first — the project's foundation
  if (memory.source === "identity" || memory.source === "identity-manual") {
    score += 50
  }

  // Narrative memories always inject — the project's evolving story
  if (memory.source === "narrative") {
    score += 40
  }

  return score
}

/**
 * Format a memory entry for injection. Knowledge docs (consolidated) get richer headers.
 */
function formatMemoryEntry(memory: ProjectMemory): string {
  if (memory.source === "identity" || memory.source === "identity-manual") {
    return `# Project Overview\n${memory.content}`
  }
  if (memory.source === "narrative") {
    return `# Development Narrative\n${memory.content}`
  }
  if (memory.source === "consolidated") {
    return `# ${memory.title}\n${memory.content}`
  }
  return `## [${memory.category}] ${memory.title}\n${memory.content}`
}

export interface InjectionResult {
  markdown: string
  memoriesUsed: number
  tokensUsed: number
  memoryIds: string[]
}

/**
 * Get formatted project memories for injection into a Claude session's system prompt.
 * Uses token-budgeted greedy packing sorted by computed relevance score.
 *
 * @param projectId - The project to fetch memories for
 * @param contextHint - First user message text for boosting relevant memories
 * @param maxTokens - Token budget for the memory section (default 2000)
 */
export async function getMemoriesForInjection(
  projectId: string,
  contextHint: string | null = null,
  maxTokens: number = 2000,
): Promise<InjectionResult> {
  const db = getDatabase()

  // Fetch active, non-stale memories for this project
  // Exclude absorbed/dead states as defense-in-depth (isArchived should cover it, but belt + suspenders)
  const memories = db
    .select()
    .from(projectMemories)
    .where(
      and(
        eq(projectMemories.projectId, projectId),
        eq(projectMemories.isArchived, false),
        eq(projectMemories.isStale, false),
        eq(projectMemories.state, "active"),
      )
    )
    .all()

  if (memories.length === 0) {
    return { markdown: "", memoriesUsed: 0, tokensUsed: 0, memoryIds: [] }
  }

  // Classify session type and run FTS search for contextual boosting
  const sessionType = contextHint ? classifySessionType(contextHint) : undefined
  let ftsMatchIds: Set<string> | undefined
  if (contextHint) {
    const rawSqlite = getSqlite()
    if (rawSqlite) {
      const ftsResults = searchMemories(rawSqlite, projectId, contextHint, 10)
      if (ftsResults.length > 0) {
        ftsMatchIds = new Set(ftsResults.map(r => r.memoryId))
      }
    }
  }

  // Score and sort
  const scored = memories.map(m => ({
    memory: m,
    score: scoreMemory(m, contextHint, sessionType, ftsMatchIds),
  }))
  scored.sort((a, b) => b.score - a.score)

  // Greedy pack into token budget
  const header = "# Project Memory\nThese are verified facts about this project. Use them to inform your work.\n\n"
  let tokensUsed = estimateTokens(header)
  const selected: typeof scored = []

  for (const item of scored) {
    const entry = formatMemoryEntry(item.memory)
    const entryTokens = estimateTokens(entry)
    if (tokensUsed + entryTokens > maxTokens) continue
    tokensUsed += entryTokens
    selected.push(item)
  }

  if (selected.length === 0) {
    return { markdown: "", memoriesUsed: 0, tokensUsed: 0, memoryIds: [] }
  }

  // Format markdown
  const memoryIds = selected.map(s => s.memory.id)
  const lines = selected.map(s => formatMemoryEntry(s.memory))
  const markdown = header + lines.join("\n\n")

  // Increment access counts (fire-and-forget)
  try {
    const now = new Date()
    for (const id of memoryIds) {
      db.update(projectMemories)
        .set({
          accessCount: sql`${projectMemories.accessCount} + 1`,
          lastAccessedAt: now,
        })
        .where(eq(projectMemories.id, id))
        .run()
    }
  } catch {
    // Non-critical — don't fail the session
  }

  return {
    markdown,
    memoriesUsed: selected.length,
    tokensUsed,
    memoryIds,
  }
}
