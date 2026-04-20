/**
 * Weekly synthesis — periodic Haiku call to reflect on the week's activity
 * and update high-level project understanding.
 *
 * Cost: ~$0.01/week (one Haiku call with ~3000 token context)
 * Runs once per week (or on-demand).
 */

import { eq, and, desc } from "drizzle-orm"
import { execSync } from "child_process"
import { getDatabase } from "../db"
import { projectMemories } from "../db/schema"
import { createId } from "../db/utils"
import type { AmbientProvider } from "./provider"
import { evolveMemory } from "./memory-evolution"

const SYNTHESIS_SYSTEM_PROMPT = `You are analyzing a week's development activity on a software project. Review the recent git activity and current memory state, then recommend updates.

Output a JSON array of actions:
[
  {
    "action": "create" | "update" | "archive",
    "category": "architecture|convention|deployment|debugging|preference|gotcha",
    "title": "...",
    "content": "ALWAYS/NEVER/Applies-to format for create/update, reason for archive",
    "reason": "Why this action is needed"
  }
]

Guidelines:
- ONLY recommend actions that reflect REAL changes observed in the git activity
- "create" = new pattern/knowledge not in existing memories
- "update" = existing memory needs revision based on new evidence
- "archive" = existing memory is outdated or contradicted by recent changes
- Keep create/update content in ALWAYS/NEVER/Applies-to directive format
- Max 5 actions per synthesis (focus on the most impactful)`

/**
 * Run weekly synthesis — reviews recent activity and evolves memories.
 */
export async function runWeeklySynthesis(
  projectId: string,
  projectPath: string,
  provider: AmbientProvider,
): Promise<{ actionsApplied: number }> {
  // Gather context
  const gitSummary = getWeekGitSummary(projectPath)
  const existingMemories = getExistingMemorySummary(projectId)

  if (!gitSummary) {
    return { actionsApplied: 0 } // No git activity this week
  }

  const userPrompt = buildSynthesisPrompt(gitSummary, existingMemories)

  try {
    const result = await provider.callHaiku(SYNTHESIS_SYSTEM_PROMPT, userPrompt)
    const actions = parseSynthesisActions(result.text)

    let applied = 0
    for (const action of actions) {
      if (applySynthesisAction(projectId, action)) {
        applied++
      }
    }

    return { actionsApplied: applied }
  } catch (err) {
    console.error("[Ambient] Weekly synthesis failed:", err)
    return { actionsApplied: 0 }
  }
}

function getWeekGitSummary(projectPath: string): string | null {
  try {
    // Get commits from last 7 days
    const log = execSync(
      'git log --since="7 days ago" --oneline --stat --no-decorate',
      { cwd: projectPath, encoding: "utf-8", timeout: 10000 }
    ).trim()

    if (!log) return null

    // Truncate if too long
    return log.length > 3000 ? log.slice(0, 3000) + "\n[...truncated]" : log
  } catch {
    return null
  }
}

function getExistingMemorySummary(projectId: string): string {
  const db = getDatabase()
  const memories = db.select()
    .from(projectMemories)
    .where(and(
      eq(projectMemories.projectId, projectId),
      eq(projectMemories.isArchived, false),
    ))
    .orderBy(desc(projectMemories.relevanceScore))
    .all()

  if (memories.length === 0) return "No existing memories."

  return memories
    .slice(0, 20) // Top 20 by relevance
    .map(m => `[${m.category}] ${m.title} (score: ${m.relevanceScore}${m.isStale ? ", STALE" : ""})`)
    .join("\n")
}

function buildSynthesisPrompt(gitSummary: string, existingMemories: string): string {
  let prompt = "# Weekly Activity Synthesis\n\n"
  prompt += "## Git Activity (Last 7 Days)\n```\n" + gitSummary + "\n```\n\n"
  prompt += "## Current Memories\n" + existingMemories + "\n\n"
  prompt += "Based on this week's activity, what memories should be created, updated, or archived?"

  // Cap total size
  if (prompt.length > 8000) {
    prompt = prompt.slice(0, 8000) + "\n[...truncated]"
  }

  return prompt
}

interface SynthesisAction {
  action: "create" | "update" | "archive"
  category: string
  title: string
  content: string
  reason: string
}

function parseSynthesisActions(text: string): SynthesisAction[] {
  try {
    const jsonMatch = text.match(/\[[\s\S]*\]/)
    if (!jsonMatch) return []

    const parsed = JSON.parse(jsonMatch[0])
    if (!Array.isArray(parsed)) return []

    const validActions = new Set(["create", "update", "archive"])
    const validCategories = new Set(["architecture", "convention", "deployment", "debugging", "preference", "gotcha"])

    return parsed
      .filter((a: any) =>
        validActions.has(a.action) &&
        validCategories.has(a.category) &&
        a.title &&
        a.content
      )
      .slice(0, 5) // Max 5 actions
      .map((a: any) => ({
        action: a.action,
        category: a.category,
        title: String(a.title).slice(0, 100),
        content: String(a.content).slice(0, 1000),
        reason: String(a.reason ?? "").slice(0, 200),
      }))
  } catch {
    console.warn("[Ambient] Failed to parse synthesis actions")
    return []
  }
}

function applySynthesisAction(projectId: string, action: SynthesisAction): boolean {
  const db = getDatabase()

  switch (action.action) {
    case "create": {
      const result = evolveMemory(projectId, {
        title: action.title,
        content: action.content,
        category: action.category,
        linkedFiles: [],
        confidence: 65, // Synthesis-derived = moderate confidence
      })
      return result === "created"
    }

    case "update": {
      // Find memory by title
      const existing = db.select()
        .from(projectMemories)
        .where(and(
          eq(projectMemories.projectId, projectId),
          eq(projectMemories.title, action.title),
          eq(projectMemories.isArchived, false),
        ))
        .get()

      if (!existing) return false

      db.update(projectMemories)
        .set({
          content: action.content,
          updatedAt: new Date(),
          isStale: false,
        })
        .where(eq(projectMemories.id, existing.id))
        .run()
      return true
    }

    case "archive": {
      // Find and archive
      const toArchive = db.select()
        .from(projectMemories)
        .where(and(
          eq(projectMemories.projectId, projectId),
          eq(projectMemories.title, action.title),
          eq(projectMemories.isArchived, false),
        ))
        .get()

      if (!toArchive) return false

      db.update(projectMemories)
        .set({
          isArchived: true,
          updatedAt: new Date(),
        })
        .where(eq(projectMemories.id, toArchive.id))
        .run()
      return true
    }

    default:
      return false
  }
}
