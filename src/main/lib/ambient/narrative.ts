/**
 * Development Narrative — a living, evolving story of how the software was built.
 *
 * Unlike atomic memories (static facts), the narrative is a single document per project
 * that gets periodically updated from git history. It tracks major arcs, inflection
 * points, architectural decisions, and the trajectory of the codebase over time.
 *
 * Triggers:
 *   - Every COMMIT_THRESHOLD commits (default 10)
 *   - Every 24 hours if any commits occurred
 *   - On "Build Brain" invocation
 *
 * The narrative is stored as a special memory with source="narrative" and gets
 * injected into sessions with high priority so Claude always knows the project's story.
 */

import { eq, and } from "drizzle-orm"
import { getDatabase } from "../db"
import { projectMemories } from "../db/schema"
import { createId } from "../db/utils"
import { callClaude } from "../claude/api"
import { exec } from "child_process"
import { promisify } from "util"

const execAsync = promisify(exec)

// ============ CONFIG ============

const COMMIT_THRESHOLD = 10
const TIME_THRESHOLD_MS = 24 * 60 * 60 * 1000 // 24 hours

// ============ STATE ============

interface NarrativeState {
  lastCommitHash: string | null
  lastUpdatedAt: number
  commitsSinceUpdate: number
}

/** In-memory state per project. Survives across sessions within a single app run. */
const narrativeStates = new Map<string, NarrativeState>()

function getState(projectId: string): NarrativeState {
  if (!narrativeStates.has(projectId)) {
    // Hydrate from DB on first access so we don't re-process commits after restart
    let lastHash: string | null = null
    let lastUpdated = 0
    try {
      const db = getDatabase()
      const existing = db.select({
        linkedFiles: projectMemories.linkedFiles,
        updatedAt: projectMemories.updatedAt,
      })
        .from(projectMemories)
        .where(and(
          eq(projectMemories.projectId, projectId),
          eq(projectMemories.source, "narrative"),
          eq(projectMemories.isArchived, false),
        ))
        .get()
      if (existing?.linkedFiles) {
        // We store lastCommitHash in linkedFiles for persistence
        try {
          const parsed = JSON.parse(existing.linkedFiles)
          if (typeof parsed === "string") lastHash = parsed
          else if (Array.isArray(parsed) && parsed[0]) lastHash = parsed[0]
        } catch { /* ignore parse errors */ }
      }
      if (existing?.updatedAt) {
        lastUpdated = new Date(existing.updatedAt).getTime()
      }
    } catch { /* DB not ready yet, use defaults */ }

    narrativeStates.set(projectId, {
      lastCommitHash: lastHash,
      lastUpdatedAt: lastUpdated,
      commitsSinceUpdate: 0,
    })
  }
  return narrativeStates.get(projectId)!
}

// ============ NARRATIVE PROMPT ============

const NARRATIVE_SYSTEM = `You maintain a living development narrative for a software project. You receive the CURRENT narrative (what you wrote last time) and NEW commits since then.

Update the narrative to incorporate what's new. The narrative should:
- Read like a concise technical story — arcs and phases, not a bullet list
- Track major development arcs: "the auth overhaul", "the ambient agent build", "the performance sprint", etc.
- Note inflection points: architectural decisions, pivots, major bugs squashed, paradigm shifts
- Capture the WHY behind changes when visible from commit messages ("ripped out X because Y")
- Be cumulative — evolve the existing narrative, don't replace it wholesale
- Trim older detail to make room for recent work when approaching the word limit
- Use past tense for completed work, present tense for in-progress arcs
- Stay under 600 words

Write the narrative as a single flowing document. No JSON. No headers. Just a clear, evolving story of how this software came to be what it is.`

// ============ CORE ============

/**
 * Record a commit event. Increments the counter and triggers narrative update
 * when the threshold is reached.
 */
export function recordCommit(projectId: string, projectPath: string): void {
  const state = getState(projectId)
  state.commitsSinceUpdate++

  const timeSinceUpdate = Date.now() - state.lastUpdatedAt
  const shouldUpdate =
    state.commitsSinceUpdate >= COMMIT_THRESHOLD ||
    (state.commitsSinceUpdate > 0 && timeSinceUpdate >= TIME_THRESHOLD_MS)

  if (shouldUpdate) {
    // Fire-and-forget — non-critical background work
    updateNarrative(projectId, projectPath).catch(err => {
      console.warn("[Narrative] Update failed:", err instanceof Error ? err.message : err)
    })
  }
}

/**
 * Update the project's development narrative from recent git history.
 * Called periodically (commit threshold / time threshold) or on brain build.
 */
export async function updateNarrative(
  projectId: string,
  projectPath: string,
): Promise<void> {
  const state = getState(projectId)
  const db = getDatabase()

  // 1. Read git log since last update
  const sinceArg = state.lastCommitHash
    ? `${state.lastCommitHash.replace(/[^a-f0-9]/gi, "")}..HEAD`
    : "-30" // First run: last 30 commits

  let gitLog: string
  let latestHash: string | null = null
  try {
    const { stdout: logOutput } = await execAsync(
      `git log ${sinceArg} --format="%h %s (%an, %ar)" --stat=80 --`,
      { cwd: projectPath, timeout: 10_000 },
    )
    gitLog = logOutput.trim()
    if (!gitLog) {
      console.log("[Narrative] No new commits since last update")
      return
    }

    // Get the latest commit hash for state tracking
    const { stdout: hashOutput } = await execAsync(
      "git rev-parse --short HEAD",
      { cwd: projectPath, timeout: 5_000 },
    )
    latestHash = hashOutput.trim()
  } catch (err) {
    console.warn("[Narrative] Failed to read git log:", err instanceof Error ? err.message : err)
    return
  }

  // 2. Read current narrative (if exists)
  const existing = db.select({ id: projectMemories.id, content: projectMemories.content })
    .from(projectMemories)
    .where(and(
      eq(projectMemories.projectId, projectId),
      eq(projectMemories.source, "narrative"),
      eq(projectMemories.isArchived, false),
    ))
    .get()

  const currentNarrative = existing?.content || "(no existing narrative — this is the first synthesis)"

  // 3. Synthesize the updated narrative
  const userMessage = `## Current Narrative\n${currentNarrative}\n\n## New Commits (${state.commitsSinceUpdate} since last update)\n\`\`\`\n${gitLog.slice(0, 6000)}\n\`\`\``

  const { text } = await callClaude({
    system: NARRATIVE_SYSTEM,
    userMessage,
    maxTokens: 1500,
    timeoutMs: 60_000,
  })

  if (!text || text.length < 50) {
    console.log("[Narrative] Synthesis returned empty/short response")
    return
  }

  // 4. Upsert the narrative memory (persist lastCommitHash in linkedFiles for restart recovery)
  const hashJson = latestHash ? JSON.stringify(latestHash) : null
  if (existing) {
    db.update(projectMemories)
      .set({
        content: text.trim(),
        relevanceScore: 85, // High priority — always inject
        linkedFiles: hashJson,
        validatedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(projectMemories.id, existing.id))
      .run()
  } else {
    db.insert(projectMemories)
      .values({
        id: createId(),
        projectId,
        category: "strategy", // Narratives are strategic context
        title: "Development Narrative",
        content: text.trim(),
        source: "narrative",
        relevanceScore: 85,
        linkedFiles: hashJson,
        state: "active",
      })
      .run()
  }

  // 5. Update state
  state.lastCommitHash = latestHash
  state.lastUpdatedAt = Date.now()
  state.commitsSinceUpdate = 0

  console.log(`[Narrative] Updated development narrative for project ${projectId} (${text.length} chars)`)
}

/**
 * Check if a narrative exists for a project. Used by brain build to decide
 * whether to run narrative synthesis as Phase 0.
 */
export function hasNarrative(projectId: string): boolean {
  const db = getDatabase()
  return !!db.select({ id: projectMemories.id })
    .from(projectMemories)
    .where(and(
      eq(projectMemories.projectId, projectId),
      eq(projectMemories.source, "narrative"),
      eq(projectMemories.isArchived, false),
    ))
    .get()
}
