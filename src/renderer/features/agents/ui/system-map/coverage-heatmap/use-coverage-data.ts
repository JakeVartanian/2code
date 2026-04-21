/**
 * useCoverageData — aggregates file tree, ambient suggestions, memories,
 * and orchestration state into a per-directory coverage model.
 */

import { useMemo } from "react"
import { trpc } from "@/lib/trpc"
import { useOrchestrationStore } from "../../../stores/orchestration-store"

// ─── Types ───────────────────────────────────────────────────────────────────

export type Severity = "none" | "info" | "warning" | "error"

export interface DirectoryEntry {
  path: string               // relative, e.g. "src/renderer/features"
  name: string               // e.g. "features"
  parentPath: string | null
  children: DirectoryEntry[]
  fileCount: number
  analyzedFileCount: number
  coveragePct: number        // 0-100
  confidence: number         // 0-100
  severity: Severity
  issueCount: number
  planIds: string[]
  memoryIds: string[]
  lastAnalyzedAt: string | null
  isAnalyzing: boolean
}

export interface CoverageStats {
  totalDirs: number
  totalFiles: number
  analyzedFiles: number
  coveredPct: number         // 0-100, overall
  partialPct: number         // 0-100, dirs with some but <70% coverage
  issueCount: number
  planCount: number
}

export interface CoverageData {
  entries: DirectoryEntry[]
  stats: CoverageStats
  isLoading: boolean
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Safely parse a JSON-stringified array */
function parseStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value as string[]
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value)
      if (Array.isArray(parsed)) return parsed
    } catch { /* not valid JSON */ }
  }
  return []
}

/**
 * Normalize a file path for matching: strip leading "./" or "/",
 * and resolve trailing slashes.
 */
function normalizePath(p: string): string {
  let n = p.replace(/\\/g, "/")
  if (n.startsWith("./")) n = n.slice(2)
  if (n.startsWith("/")) n = n.slice(1)
  if (n.endsWith("/")) n = n.slice(0, -1)
  return n
}

/** Get the parent directory path, or null for root-level entries */
function parentDir(path: string): string | null {
  const idx = path.lastIndexOf("/")
  return idx > 0 ? path.slice(0, idx) : null
}

/** Check if a file path falls under a directory path */
function isUnderDir(filePath: string, dirPath: string): boolean {
  return filePath === dirPath || filePath.startsWith(dirPath + "/")
}

/** Highest severity wins */
function maxSeverity(a: Severity, b: Severity): Severity {
  const order: Record<Severity, number> = { none: 0, info: 1, warning: 2, error: 3 }
  return order[a] >= order[b] ? a : b
}

// ─── Build directory tree from flat file list ────────────────────────────────

interface RawEntry {
  path: string
  type: "file" | "folder"
}

/** Sentinel path for root-level files */
const ROOT_DIR = "."

function buildDirectoryTree(
  entries: RawEntry[],
): { tree: DirectoryEntry[]; filesByDir: Map<string, string[]>; totalFileCount: number } {
  const dirs = new Map<string, DirectoryEntry>()
  const filesByDir = new Map<string, string[]>()
  let totalFileCount = 0

  // First pass: create all directory nodes
  for (const e of entries) {
    const norm = normalizePath(e.path)
    if (e.type === "folder") {
      if (!dirs.has(norm)) {
        dirs.set(norm, {
          path: norm,
          name: norm.split("/").pop() || norm,
          parentPath: parentDir(norm),
          children: [],
          fileCount: 0,
          analyzedFileCount: 0,
          coveragePct: 0,
          confidence: 0,
          severity: "none",
          issueCount: 0,
          planIds: [],
          memoryIds: [],
          lastAnalyzedAt: null,
          isAnalyzing: false,
        })
      }
    }
  }

  // Second pass: count files per directory (including root-level files)
  for (const e of entries) {
    if (e.type !== "file") continue
    totalFileCount++
    const norm = normalizePath(e.path)
    const dirPath = parentDir(norm) || ROOT_DIR
    const list = filesByDir.get(dirPath) || []
    list.push(norm)
    filesByDir.set(dirPath, list)
  }

  // Create a virtual root directory for root-level files if any exist
  const rootFiles = filesByDir.get(ROOT_DIR)
  if (rootFiles && rootFiles.length > 0 && !dirs.has(ROOT_DIR)) {
    dirs.set(ROOT_DIR, {
      path: ROOT_DIR,
      name: "(root files)",
      parentPath: null,
      children: [],
      fileCount: rootFiles.length,
      analyzedFileCount: 0,
      coveragePct: 0,
      confidence: 0,
      severity: "none",
      issueCount: 0,
      planIds: [],
      memoryIds: [],
      lastAnalyzedAt: null,
      isAnalyzing: false,
    })
  }

  // Set direct file counts for non-root dirs
  for (const [dirPath, files] of filesByDir) {
    if (dirPath === ROOT_DIR) continue
    const dir = dirs.get(dirPath)
    if (dir) dir.fileCount = files.length
  }

  // Wire up parent-child relationships
  for (const dir of dirs.values()) {
    if (dir.parentPath && dirs.has(dir.parentPath)) {
      dirs.get(dir.parentPath)!.children.push(dir)
    }
  }

  // Bubble up file counts from children
  function addNestedFileCounts(d: DirectoryEntry): number {
    let total = d.fileCount
    for (const child of d.children) {
      total += addNestedFileCounts(child)
    }
    d.fileCount = total
    return total
  }

  // Collect top-level entries (no parent or parent not in dirs)
  const topLevel: DirectoryEntry[] = []
  for (const dir of dirs.values()) {
    if (!dir.parentPath || !dirs.has(dir.parentPath)) {
      topLevel.push(dir)
    }
  }

  for (const tl of topLevel) {
    addNestedFileCounts(tl)
  }

  return { tree: topLevel, filesByDir, totalFileCount }
}

// ─── Apply overlays ─────────────────────────────────────────────────────────

interface SuggestionData {
  id: string
  triggerFiles: string[]
  confidence: number
  severity: string
  createdAt: unknown
}

interface MemoryData {
  id: string
  linkedFiles: unknown
}

interface TaskData {
  id: string
  allowedPaths: string[] | null
}

function applyOverlays(
  tree: DirectoryEntry[],
  filesByDir: Map<string, string[]>,
  suggestions: SuggestionData[],
  memories: MemoryData[],
  tasks: TaskData[],
): void {
  // Build lookup: file path → which suggestions reference it
  const fileSuggestions = new Map<string, SuggestionData[]>()
  for (const s of suggestions) {
    const files = Array.isArray(s.triggerFiles) ? s.triggerFiles : []
    for (const f of files) {
      const norm = normalizePath(f)
      const list = fileSuggestions.get(norm) || []
      list.push(s)
      fileSuggestions.set(norm, list)
    }
  }

  // Build lookup: file path → which memories reference it
  const fileMemories = new Map<string, string[]>()
  for (const m of memories) {
    const linked = parseStringArray(m.linkedFiles)
    for (const f of linked) {
      const norm = normalizePath(f)
      const list = fileMemories.get(norm) || []
      list.push(m.id)
      fileMemories.set(norm, list)
    }
  }

  function applyToDir(dir: DirectoryEntry): void {
    const dirFiles = new Set<string>()

    // Collect all files under this directory (recursively)
    function collectFiles(d: DirectoryEntry) {
      const files = filesByDir.get(d.path) || []
      for (const f of files) dirFiles.add(f)
      for (const child of d.children) collectFiles(child)
    }
    collectFiles(dir)

    // Suggestions overlay
    let analyzedCount = 0
    let totalConfidence = 0
    let confidenceCount = 0
    let latestAnalysis: string | null = null

    for (const filePath of dirFiles) {
      const sgs = fileSuggestions.get(filePath)
      if (sgs && sgs.length > 0) {
        analyzedCount++
        for (const s of sgs) {
          dir.issueCount++
          dir.severity = maxSeverity(dir.severity, s.severity as Severity)
          totalConfidence += s.confidence
          confidenceCount++
          const ts = s.createdAt instanceof Date
            ? s.createdAt.toISOString()
            : typeof s.createdAt === "string" ? s.createdAt : null
          if (ts && (!latestAnalysis || ts > latestAnalysis)) {
            latestAnalysis = ts
          }
        }
      }
    }

    dir.analyzedFileCount = analyzedCount
    dir.coveragePct = dir.fileCount > 0
      ? Math.round((analyzedCount / dir.fileCount) * 100)
      : 0
    dir.confidence = confidenceCount > 0
      ? Math.round(totalConfidence / confidenceCount)
      : 0
    dir.lastAnalyzedAt = latestAnalysis

    // Memory overlay
    const memIds = new Set<string>()
    for (const filePath of dirFiles) {
      const mems = fileMemories.get(filePath)
      if (mems) for (const id of mems) memIds.add(id)
    }
    dir.memoryIds = [...memIds]

    // Plan overlay — match allowedPaths against directory
    const matchingPlanIds: string[] = []
    for (const task of tasks) {
      if (!task.allowedPaths) continue
      for (const pattern of task.allowedPaths) {
        const normPattern = normalizePath(pattern)
        if (
          isUnderDir(normPattern, dir.path) ||
          isUnderDir(dir.path, normPattern) ||
          (normPattern.includes("*") && isUnderDir(dir.path, normPattern.split("*")[0].replace(/\/$/, "")))
        ) {
          matchingPlanIds.push(task.id)
          break
        }
      }
    }
    dir.planIds = matchingPlanIds

    // Recurse into children
    for (const child of dir.children) {
      applyToDir(child)
    }
  }

  for (const dir of tree) {
    applyToDir(dir)
  }
}

// ─── Hook ────────────────────────────────────────────────────────────────────

export function useCoverageData(
  projectId: string | null,
  projectPath: string | null,
  chatId: string,
): CoverageData {
  const hasProject = !!projectId && !!projectPath

  // 1. File tree — fetch all entries (files + folders) to build tree with counts
  const filesQuery = trpc.files.search.useQuery(
    { projectPath: projectPath!, query: "", limit: 5000 },
    {
      enabled: hasProject,
      refetchInterval: 30_000,
      placeholderData: (prev) => prev,
    },
  )

  // 2. Ambient suggestions (pending) for coverage analysis
  const suggestionsQuery = trpc.ambient.listSuggestions.useQuery(
    { projectId: projectId!, status: "pending", limit: 500 },
    {
      enabled: !!projectId,
      refetchInterval: 15_000,
      placeholderData: (prev) => prev,
    },
  )

  // 3. Memories with linked files
  const memoriesQuery = trpc.memory.list.useQuery(
    { projectId: projectId!, includeArchived: false, includeStale: true },
    {
      enabled: !!projectId,
      refetchInterval: 15_000,
      placeholderData: (prev) => prev,
    },
  )

  // 4. Orchestration — active run from Zustand store (has tasks with allowedPaths)
  const orchestrationRun = useOrchestrationStore((s) => s.getRunForChat(chatId))

  // Build the directory tree and apply overlays
  const result = useMemo<{ entries: DirectoryEntry[]; stats: CoverageStats }>(() => {
    if (!filesQuery.data || filesQuery.data.length === 0) {
      return {
        entries: [],
        stats: {
          totalDirs: 0, totalFiles: 0, analyzedFiles: 0,
          coveredPct: 0, partialPct: 0, issueCount: 0, planCount: 0,
        },
      }
    }

    // Build tree from flat file list
    const rawEntries: RawEntry[] = filesQuery.data.map((f) => ({
      path: f.path,
      type: f.type,
    }))
    const { tree, filesByDir, totalFileCount } = buildDirectoryTree(rawEntries)

    // Prepare overlay data
    const suggestions: SuggestionData[] = (suggestionsQuery.data || []).map((s) => ({
      id: s.id,
      triggerFiles: Array.isArray(s.triggerFiles) ? s.triggerFiles : [],
      confidence: (s as any).confidence ?? 50,
      severity: s.severity,
      createdAt: s.createdAt,
    }))

    const memories: MemoryData[] = (memoriesQuery.data || []).map((m) => ({
      id: m.id,
      linkedFiles: m.linkedFiles,
    }))

    const tasks: TaskData[] = orchestrationRun?.tasks || []

    // Apply overlays to tree
    applyOverlays(tree, filesByDir, suggestions, memories, tasks)

    // Compute aggregate stats — only count top-level entries to avoid double-counting
    // (parent fileCount already includes all nested children)
    let totalDirs = 0
    let totalAnalyzedFiles = 0
    let totalIssueCount = 0
    let partialDirs = 0
    const planIdSet = new Set<string>()

    function countDirs(entries: DirectoryEntry[]) {
      for (const d of entries) {
        totalDirs++
        if (d.coveragePct > 0 && d.coveragePct < 70) partialDirs++
        for (const pid of d.planIds) planIdSet.add(pid)
        // Only count issues/analyzed at leaf level or use top-level rolled-up values
        countDirs(d.children)
      }
    }
    countDirs(tree)

    // Use totalFileCount from the build step (counts each file exactly once)
    // For analyzed files, sum only top-level entries (their analyzedFileCount
    // already includes nested files via collectFiles in applyOverlays)
    for (const d of tree) {
      totalAnalyzedFiles += d.analyzedFileCount
      totalIssueCount += d.issueCount
    }

    const coveredPct = totalFileCount > 0
      ? Math.round((totalAnalyzedFiles / totalFileCount) * 100)
      : 0
    const partialPct = totalDirs > 0
      ? Math.round((partialDirs / totalDirs) * 100)
      : 0

    return {
      entries: tree,
      stats: {
        totalDirs,
        totalFiles: totalFileCount,
        analyzedFiles: totalAnalyzedFiles,
        coveredPct,
        partialPct,
        issueCount: totalIssueCount,
        planCount: planIdSet.size,
      },
    }
  }, [filesQuery.data, suggestionsQuery.data, memoriesQuery.data, orchestrationRun, projectPath])

  const isLoading =
    filesQuery.isLoading ||
    suggestionsQuery.isLoading ||
    memoriesQuery.isLoading

  return {
    ...result,
    isLoading,
  }
}
