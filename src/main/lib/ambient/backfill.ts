/**
 * Brain backfill — "Build Brain" for existing projects.
 * Analyzes git history, past sub-chats, config files, and CLAUDE.md
 * to bootstrap the memory system with project knowledge.
 *
 * Idempotent: safe to run multiple times (dedup prevents duplicates).
 * Cost: ~$0.05 (one Sonnet call for synthesis)
 * Time: ~30 seconds
 */

import { existsSync, readFileSync } from "fs"
import { join } from "path"
import { execSync } from "child_process"
import { eq, and } from "drizzle-orm"
import { getDatabase } from "../db"
import { projectMemories } from "../db/schema"
import { createId } from "../db/utils"
import type { AmbientProvider } from "./provider"
import { runOnboardingScan } from "./onboarding"

export interface BackfillResult {
  memoriesCreated: number
  memoriesUpdated: number
  sources: string[]
  durationMs: number
}

/**
 * Full brain build — analyzes everything available to bootstrap project knowledge.
 * For existing projects that already have chat history, git commits, etc.
 */
export async function buildBrain(
  projectId: string,
  projectPath: string,
  provider: AmbientProvider,
): Promise<BackfillResult> {
  const start = Date.now()
  const sources: string[] = []
  let created = 0
  let updated = 0

  const db = getDatabase()

  // Source 1: Import CLAUDE.md if it exists (free, local)
  const claudeMdCreated = importClaudeMd(projectId, projectPath)
  if (claudeMdCreated > 0) {
    created += claudeMdCreated
    sources.push("CLAUDE.md")
  }

  // Source 2: Analyze git history for temporal coupling (free, local)
  const gitCreated = analyzeGitCoupling(projectId, projectPath)
  if (gitCreated > 0) {
    created += gitCreated
    sources.push("git-coupling")
  }

  // Source 3: Run the onboarding scan (one Sonnet call, ~$0.05)
  const onboardingResult = await runOnboardingScan(
    projectId,
    projectPath,
    provider,
    (memory) => {
      const wasCreated = writeMemoryDeduped(projectId, memory)
      if (wasCreated) created++
      else updated++
    },
  )
  sources.push(...onboardingResult.sources)

  return {
    memoriesCreated: created,
    memoriesUpdated: updated,
    sources: [...new Set(sources)],
    durationMs: Date.now() - start,
  }
}

/**
 * Incremental brain refresh — only looks at activity since last refresh.
 * Lighter than full build, meant to be run periodically.
 */
export async function refreshBrain(
  projectId: string,
  projectPath: string,
  provider: AmbientProvider,
): Promise<BackfillResult> {
  // For now, refresh delegates to full build (dedup ensures no duplicates)
  // In the future, this should scope to recent commits/chats only
  return buildBrain(projectId, projectPath, provider)
}

/**
 * Get brain status for a project.
 */
export function getBrainStatus(projectId: string): {
  memoryCount: number
  autoMemoryCount: number
  lastBuilt: Date | null
  categories: Record<string, number>
} {
  const db = getDatabase()

  const memories = db.select()
    .from(projectMemories)
    .where(and(
      eq(projectMemories.projectId, projectId),
      eq(projectMemories.isArchived, false),
    ))
    .all()

  const autoMemories = memories.filter(m => m.source === "auto")

  // Count by category
  const categories: Record<string, number> = {}
  for (const m of memories) {
    categories[m.category] = (categories[m.category] ?? 0) + 1
  }

  // Last auto-created memory timestamp
  const lastAuto = autoMemories
    .map(m => m.createdAt)
    .filter(Boolean)
    .sort((a, b) => (b?.getTime() ?? 0) - (a?.getTime() ?? 0))[0]

  return {
    memoryCount: memories.length,
    autoMemoryCount: autoMemories.length,
    lastBuilt: lastAuto ?? null,
    categories,
  }
}

// ============ INTERNAL FUNCTIONS ============

/**
 * Import CLAUDE.md sections as memories.
 */
function importClaudeMd(projectId: string, projectPath: string): number {
  const claudeMdPath = join(projectPath, "CLAUDE.md")
  if (!existsSync(claudeMdPath)) return 0

  let content: string
  try {
    content = readFileSync(claudeMdPath, "utf-8")
  } catch {
    return 0
  }

  // Split by ## headings
  const sections = content.split(/^## /m).slice(1) // Skip content before first ##
  let created = 0

  for (const section of sections.slice(0, 15)) { // Max 15 sections
    const lines = section.split("\n")
    const title = lines[0]?.trim()
    if (!title) continue

    const body = lines.slice(1).join("\n").trim()
    if (body.length < 20) continue // Skip trivially short sections

    // Auto-detect category
    const category = detectCategory(title, body)

    const wasCreated = writeMemoryDeduped(projectId, {
      category,
      title: `[CLAUDE.md] ${title}`.slice(0, 100),
      content: body.slice(0, 1000),
      linkedFiles: ["CLAUDE.md"],
    })

    if (wasCreated) created++
  }

  return created
}

/**
 * Analyze git history for temporal coupling (files that change together).
 */
function analyzeGitCoupling(projectId: string, projectPath: string): number {
  let gitLog: string
  try {
    gitLog = execSync(
      'git log --name-only --pretty=format:"---" -100',
      { cwd: projectPath, encoding: "utf-8", timeout: 10000 }
    )
  } catch {
    return 0
  }

  // Parse commits into file groups
  const commits = gitLog.split("---").filter(Boolean)
  const pairCounts = new Map<string, number>()

  for (const commit of commits) {
    const files = commit.trim().split("\n").filter(f => f.trim() && !f.includes("node_modules"))
    if (files.length < 2 || files.length > 20) continue // Skip trivial and merge commits

    // Count co-occurrence pairs
    for (let i = 0; i < files.length; i++) {
      for (let j = i + 1; j < files.length; j++) {
        const pair = [files[i].trim(), files[j].trim()].sort().join(" <-> ")
        pairCounts.set(pair, (pairCounts.get(pair) ?? 0) + 1)
      }
    }
  }

  // Find strongly coupled pairs (co-occurred 5+ times)
  const strongPairs = [...pairCounts.entries()]
    .filter(([, count]) => count >= 5)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5) // Top 5 couplings

  let created = 0
  for (const [pair, count] of strongPairs) {
    const [fileA, fileB] = pair.split(" <-> ")
    const wasCreated = writeMemoryDeduped(projectId, {
      category: "architecture",
      title: `Coupled files: ${shortName(fileA)} + ${shortName(fileB)}`,
      content: `ALWAYS: When modifying ${fileA}, check if ${fileB} also needs changes.\nThese files changed together in ${count} of the last 100 commits, indicating tight coupling.\nApplies to: ${fileA}, ${fileB}`,
      linkedFiles: [fileA, fileB],
    })
    if (wasCreated) created++
  }

  return created
}

function shortName(filePath: string): string {
  const parts = filePath.split("/")
  return parts[parts.length - 1] ?? filePath
}

function detectCategory(title: string, body: string): string {
  const text = (title + " " + body).toLowerCase()
  if (/architect|structur|schema|database|api|route|component|module/.test(text)) return "architecture"
  if (/deploy|build|ci|cd|release|docker|server|production/.test(text)) return "deployment"
  if (/debug|fix|bug|error|crash|issue|problem/.test(text)) return "debugging"
  if (/convention|style|naming|pattern|format|lint/.test(text)) return "convention"
  if (/gotcha|caveat|warning|careful|watch out|pitfall/.test(text)) return "gotcha"
  if (/prefer|always|never|use|avoid|default/.test(text)) return "preference"
  return "architecture" // Default
}

/**
 * Write a memory, deduplicating by title.
 * Returns true if a new memory was created, false if skipped (duplicate).
 */
function writeMemoryDeduped(
  projectId: string,
  memory: { category: string; title: string; content: string; linkedFiles: string[] },
): boolean {
  const db = getDatabase()

  // Check for existing memory with same title
  const existing = db.select({ id: projectMemories.id })
    .from(projectMemories)
    .where(and(
      eq(projectMemories.projectId, projectId),
      eq(projectMemories.title, memory.title),
    ))
    .get()

  if (existing) return false

  db.insert(projectMemories)
    .values({
      id: createId(),
      projectId,
      category: memory.category,
      title: memory.title,
      content: memory.content,
      source: "auto",
      linkedFiles: JSON.stringify(memory.linkedFiles),
      relevanceScore: 60, // Moderate confidence (will be refined by ambient observations)
    })
    .run()

  return true
}
