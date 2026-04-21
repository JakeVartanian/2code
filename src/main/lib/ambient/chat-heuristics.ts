/**
 * Chat-specific heuristics (Tier 0) — pattern detection on chat activity
 * that doesn't require AI calls.
 *
 * These complement the file-content regex heuristics in heuristics.ts.
 * While those scan file diffs for code patterns, these detect behavioral
 * patterns in how the user is working: error loops, missing tests, etc.
 */

import { eq, and } from "drizzle-orm"
import { getDatabase } from "../db"
import { projectMemories } from "../db/schema"
import type { ChatActivityEvent } from "./types"
import type { HeuristicResult } from "./types"

// ─── Session-scoped trackers ──────────────────────────────────────────────

/** Track tool errors per file per session to detect loops */
const errorTracker = new Map<string, Map<string, number>>() // subChatId → (filePath → count)

/** Track files edited per session to detect missing tests */
const editTracker = new Map<string, Set<string>>() // subChatId → Set<filePath>

const TEST_FILE_PATTERNS = [
  /\.test\.[jt]sx?$/,
  /\.spec\.[jt]sx?$/,
  /__tests__\//,
  /\.test\./,
  /\.spec\./,
  /test_/,
  /_test\./,
]

function isTestFile(path: string): boolean {
  return TEST_FILE_PATTERNS.some(p => p.test(path))
}

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Run chat-specific heuristics on a single chat event.
 * Returns suggestions (if any) to surface immediately.
 */
export function runChatHeuristics(event: ChatActivityEvent): HeuristicResult[] {
  const results: HeuristicResult[] = []

  if (event.activityType === "tool-error") {
    const errorResults = checkErrorLoop(event)
    results.push(...errorResults)
  }

  if (event.activityType === "tool-call" && event.filePaths?.length) {
    const editResults = checkMissingTests(event)
    results.push(...editResults)

    const memoryResults = checkMemoryConflicts(event)
    results.push(...memoryResults)
  }

  return results
}

/**
 * Clean up trackers when a session completes.
 */
export function clearSessionTrackers(subChatId: string): void {
  errorTracker.delete(subChatId)
  editTracker.delete(subChatId)
}

// ─── Heuristic implementations ──────────────────────────────────────────

/**
 * Error loop detection: same tool errors 3+ times on the same file
 * in a single session → suggest a different approach.
 */
function checkErrorLoop(event: ChatActivityEvent): HeuristicResult[] {
  if (!event.filePaths?.length) return []

  let sessionErrors = errorTracker.get(event.subChatId)
  if (!sessionErrors) {
    sessionErrors = new Map()
    errorTracker.set(event.subChatId, sessionErrors)
  }

  const results: HeuristicResult[] = []

  for (const filePath of event.filePaths) {
    const count = (sessionErrors.get(filePath) ?? 0) + 1
    sessionErrors.set(filePath, count)

    // Trigger on exactly 3 (don't re-trigger on 4, 5, etc.)
    if (count === 3) {
      const fileName = filePath.split("/").pop() ?? filePath
      results.push({
        category: "bug",
        severity: "warning",
        title: `Repeated failures on ${fileName}`,
        description: `The same tool has errored ${count} times on ${fileName} in this session. Consider trying a different approach or examining the file manually.`,
        confidence: 72,
        triggerFiles: [filePath],
        triggerEvent: "tool-error",
      })
    }
  }

  return results
}

/**
 * Missing test detection: 5+ non-test files edited in a session
 * with zero test files touched.
 */
function checkMissingTests(event: ChatActivityEvent): HeuristicResult[] {
  if (!event.filePaths?.length) return []

  // Only track edit-like tools
  const editTools = ["Edit", "Write", "file_edit", "file_write"]
  if (event.toolName && !editTools.includes(event.toolName)) return []

  let sessionEdits = editTracker.get(event.subChatId)
  if (!sessionEdits) {
    sessionEdits = new Set()
    editTracker.set(event.subChatId, sessionEdits)
  }

  for (const filePath of event.filePaths) {
    sessionEdits.add(filePath)
  }

  // Check threshold: 5+ files, none are tests
  const allFiles = [...sessionEdits]
  const hasTestFile = allFiles.some(f => isTestFile(f))
  const nonTestCount = allFiles.filter(f => !isTestFile(f)).length

  // Only trigger once per session (at exactly 5 non-test files)
  if (nonTestCount === 5 && !hasTestFile) {
    return [{
      category: "test-gap",
      severity: "info",
      title: "Multiple files edited without tests",
      description: `${nonTestCount} files have been modified in this session without any test files being touched. Consider adding or updating tests.`,
      confidence: 55,
      triggerFiles: allFiles.slice(0, 5),
      triggerEvent: "file-change",
    }]
  }

  return []
}

/**
 * Memory conflict detection: check if files being edited have linked
 * "gotcha" or "debugging" memories that the user should be aware of.
 */
// Cache gotcha/debugging memories to avoid full table scan on every tool-call event
let memoriesCache: { projectId: string; data: any[]; expiry: number } | null = null
const MEMORY_CACHE_TTL = 60_000 // 60s

function getGotchaMemories(projectId: string) {
  if (memoriesCache && memoriesCache.projectId === projectId && Date.now() < memoriesCache.expiry) {
    return memoriesCache.data
  }
  const db = getDatabase()
  const data = db.select()
    .from(projectMemories)
    .where(and(
      eq(projectMemories.projectId, projectId),
      eq(projectMemories.isArchived, false),
    ))
    .all()
    .filter(m => (m.category === "gotcha" || m.category === "debugging") && m.linkedFiles)
  memoriesCache = { projectId, data, expiry: Date.now() + MEMORY_CACHE_TTL }
  return data
}

function checkMemoryConflicts(event: ChatActivityEvent): HeuristicResult[] {
  if (!event.filePaths?.length || !event.projectId) return []

  const results: HeuristicResult[] = []

  try {
    const relevantMemories = getGotchaMemories(event.projectId)

    for (const memory of relevantMemories) {
      let linkedFiles: string[] = []
      try { linkedFiles = JSON.parse(memory.linkedFiles!) } catch { continue }
      if (!linkedFiles.length) continue

      // Check if any event file paths overlap with memory's linked files
      const overlap = event.filePaths!.some(eventFile =>
        linkedFiles.some(memFile =>
          eventFile.endsWith(memFile) || memFile.endsWith(eventFile) ||
          eventFile.includes(memFile) || memFile.includes(eventFile),
        ),
      )

      if (overlap) {
        results.push({
          category: "bug",
          severity: "warning",
          title: `Remember: ${memory.title}`,
          description: memory.content.slice(0, 300),
          confidence: 65,
          triggerFiles: event.filePaths!,
          triggerEvent: "memory-conflict",
        })
      }
    }
  } catch {
    // Non-critical — don't fail the pipeline
  }

  return results
}
