/**
 * Memory injection module — token-budgeted selection of project memories
 * for injection into Claude session system prompts.
 */

import { getDatabase } from "../db"
import { projectMemories } from "../db/schema"
import { eq, and, sql } from "drizzle-orm"
import type { ProjectMemory } from "../db/schema"

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
}

/**
 * Score a memory based on relevance, recency, frequency, and context hint matching.
 */
function scoreMemory(memory: ProjectMemory, contextHint: string | null): number {
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

  // Exclude stale memories entirely
  if (memory.isStale) {
    return -Infinity
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

  return score
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

  // Fetch all non-archived memories for this project
  const memories = db
    .select()
    .from(projectMemories)
    .where(
      and(
        eq(projectMemories.projectId, projectId),
        eq(projectMemories.isArchived, false),
      )
    )
    .all()

  if (memories.length === 0) {
    return { markdown: "", memoriesUsed: 0, tokensUsed: 0, memoryIds: [] }
  }

  // Score and sort
  const scored = memories.map(m => ({
    memory: m,
    score: scoreMemory(m, contextHint),
  }))
  scored.sort((a, b) => b.score - a.score)

  // Greedy pack into token budget
  const header = "# Project Memory\nThese are verified facts about this project. Use them to inform your work.\n\n"
  let tokensUsed = estimateTokens(header)
  const selected: typeof scored = []

  for (const item of scored) {
    const entry = `## [${item.memory.category}] ${item.memory.title}\n${item.memory.content}\n\n`
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
  const lines = selected.map(s =>
    `## [${s.memory.category}] ${s.memory.title}\n${s.memory.content}`
  )
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
