/**
 * CoverageHeatmap — hero section showing codebase directory coverage
 * as a responsive grid of DirectoryCards with summary bar, overlay
 * toggles, sort controls, and grid/list view modes.
 */

import { memo, useState, useMemo, useCallback } from "react"
import { motion, AnimatePresence } from "motion/react"
import {
  FolderOpen,
  FolderSearch,
  ScanSearch,
  SearchCode,
  FileText,
  Brain,
  ArrowUpDown,
  LayoutGrid,
  List,
  Play,
  ChevronRight,
  X,
  ChevronDown,
  FileCode2,
} from "lucide-react"
import { cn } from "../../../../../lib/utils"
import { DirectoryCard } from "./directory-card"
import { useCoverageData, type DirectoryEntry, type CoverageStats } from "./use-coverage-data"

// ─── Types ───────────────────────────────────────────────────────────────────

type SortMode = "issues-first" | "coverage-asc" | "coverage-desc" | "name" | "recent"
type OverlayKey = "audit" | "plans" | "memories"
type ViewMode = "grid" | "list"

interface CoverageHeatmapProps {
  projectId: string | null
  projectPath: string | null
  chatId: string
}

// ─── Sort logic ──────────────────────────────────────────────────────────────

const SORT_LABELS: Record<SortMode, string> = {
  "issues-first": "Issues first",
  "coverage-asc": "Coverage \u2191",
  "coverage-desc": "Coverage \u2193",
  name: "Name A\u2013Z",
  recent: "Recently analyzed",
}

function sortEntries(entries: DirectoryEntry[], mode: SortMode): DirectoryEntry[] {
  const sorted = [...entries]
  switch (mode) {
    case "issues-first":
      sorted.sort((a, b) => {
        const sevOrder = { error: 3, warning: 2, info: 1, none: 0 } as const
        const diff = (sevOrder[b.severity] || 0) - (sevOrder[a.severity] || 0)
        if (diff !== 0) return diff
        return b.issueCount - a.issueCount
      })
      break
    case "coverage-asc":
      sorted.sort((a, b) => a.coveragePct - b.coveragePct)
      break
    case "coverage-desc":
      sorted.sort((a, b) => b.coveragePct - a.coveragePct)
      break
    case "name":
      sorted.sort((a, b) => a.name.localeCompare(b.name))
      break
    case "recent":
      sorted.sort((a, b) => {
        const ta = a.lastAnalyzedAt ? new Date(a.lastAnalyzedAt).getTime() : 0
        const tb = b.lastAnalyzedAt ? new Date(b.lastAnalyzedAt).getTime() : 0
        return tb - ta
      })
      break
  }
  return sorted
}

// ─── Overlay Pill ────────────────────────────────────────────────────────────

function OverlayPill({
  label,
  icon,
  color,
  active,
  onToggle,
}: {
  label: string
  icon: React.ReactNode
  color: "cyan" | "purple" | "blue"
  active: boolean
  onToggle: () => void
}) {
  const colorMap = {
    cyan: "text-cyan-400 bg-cyan-400/10 border-cyan-400/20",
    purple: "text-purple-400 bg-purple-400/10 border-purple-400/20",
    blue: "text-blue-400 bg-blue-400/10 border-blue-400/20",
  }

  return (
    <button
      onClick={onToggle}
      aria-pressed={active}
      aria-label={`Toggle ${label} overlay`}
      className={cn(
        "flex items-center gap-1 px-2.5 py-1 rounded-md text-[10px] font-medium",
        "cursor-pointer select-none transition-all duration-150",
        active
          ? cn(colorMap[color], "border")
          : "text-zinc-500 hover:text-zinc-400 hover:bg-zinc-700/40 border border-transparent",
      )}
    >
      {icon}
      {label}
    </button>
  )
}

// ─── Sort Select ─────────────────────────────────────────────────────────────

function SortSelect({
  value,
  onChange,
}: {
  value: SortMode
  onChange: (mode: SortMode) => void
}) {
  const [open, setOpen] = useState(false)

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 h-7 px-2.5 rounded-md
          bg-zinc-800/60 border border-zinc-700/40 text-[10px] text-zinc-400
          hover:text-zinc-300 hover:border-zinc-600/60 transition-all duration-150"
      >
        <ArrowUpDown className="w-3 h-3" />
        {SORT_LABELS[value]}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full mt-1 z-50 min-w-[140px] rounded-lg
            bg-zinc-900 border border-zinc-700/60 shadow-xl py-1">
            {(Object.keys(SORT_LABELS) as SortMode[]).map((mode) => (
              <button
                key={mode}
                onClick={() => { onChange(mode); setOpen(false) }}
                className={cn(
                  "w-full text-left px-3 py-1.5 text-[10px] transition-colors duration-100",
                  mode === value
                    ? "text-cyan-400 bg-cyan-400/5"
                    : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/60",
                )}
              >
                {SORT_LABELS[mode]}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

// ─── View Toggle ─────────────────────────────────────────────────────────────

function ViewToggle({
  mode,
  onChange,
}: {
  mode: ViewMode
  onChange: (mode: ViewMode) => void
}) {
  return (
    <div className="flex items-center gap-0.5 p-1 rounded-md bg-zinc-800/60 border border-zinc-700/40">
      <button
        onClick={() => onChange("grid")}
        aria-label="Grid view"
        className={cn(
          "p-1.5 rounded transition-all duration-150",
          mode === "grid" ? "bg-zinc-700 text-zinc-200" : "text-zinc-500 hover:text-zinc-400",
        )}
      >
        <LayoutGrid className="w-3.5 h-3.5" />
      </button>
      <button
        onClick={() => onChange("list")}
        aria-label="List view"
        className={cn(
          "p-1.5 rounded transition-all duration-150",
          mode === "list" ? "bg-zinc-700 text-zinc-200" : "text-zinc-500 hover:text-zinc-400",
        )}
      >
        <List className="w-3.5 h-3.5" />
      </button>
    </div>
  )
}

// ─── Coverage Summary Bar ────────────────────────────────────────────────────

function CoverageSummaryBar({ stats }: { stats: CoverageStats }) {
  return (
    <div className="flex items-center gap-4 py-2.5">
      {/* Segmented bar */}
      <div className="flex-1 h-1.5 rounded-full bg-zinc-800/80 overflow-hidden flex gap-px">
        <motion.div
          className="h-full bg-cyan-500/80 rounded-l-full"
          initial={{ width: 0 }}
          animate={{ width: `${stats.coveredPct}%` }}
          transition={{ duration: 0.7, ease: [0.25, 0.46, 0.45, 0.94] }}
        />
        <motion.div
          className="h-full bg-amber-500/50"
          initial={{ width: 0 }}
          animate={{ width: `${stats.partialPct}%` }}
          transition={{ duration: 0.7, ease: [0.25, 0.46, 0.45, 0.94], delay: 0.05 }}
        />
      </div>

      {/* Stat chips */}
      <div className="flex items-center gap-3 shrink-0">
        <span className="text-[10px] font-mono">
          <span className="font-semibold text-cyan-400">{stats.coveredPct}%</span>
          <span className="text-zinc-500 ml-1">covered</span>
        </span>
        <span className="text-zinc-800">&middot;</span>
        <span className="text-[10px] font-mono">
          <span className="font-semibold text-amber-400">{stats.issueCount}</span>
          <span className="text-zinc-500 ml-1">issues</span>
        </span>
        <span className="text-zinc-800">&middot;</span>
        <span className="text-[10px] font-mono">
          <span className="font-semibold text-purple-400">{stats.planCount}</span>
          <span className="text-zinc-500 ml-1">plans</span>
        </span>
        <span className="text-zinc-800">&middot;</span>
        <span className="text-[10px] font-mono">
          <span className="font-semibold text-zinc-400">{stats.totalDirs}</span>
          <span className="text-zinc-500 ml-1">dirs</span>
        </span>
      </div>
    </div>
  )
}

// ─── Empty States ────────────────────────────────────────────────────────────

function EmptyState({ variant, projectId, projectPath, dirCount }: {
  variant: "no-dirs" | "no-audits" | "fresh"
  projectId?: string | null
  projectPath?: string | null
  dirCount?: number
}) {
  const configs = {
    "no-dirs": {
      icon: FolderSearch,
      heading: "No project selected",
      body: "Select a project to see codebase coverage.",
    },
    "no-audits": {
      icon: ScanSearch,
      heading: "Directories found, awaiting analysis",
      body: "Run an ambient audit or send a message to start generating coverage data.",
    },
    fresh: {
      icon: FolderOpen,
      heading: "Scanning project...",
      body: projectPath
        ? `Looking for directories in ${projectPath.split("/").pop() || projectPath}`
        : "Coverage data will appear here once 2Code analyzes your project.",
    },
  }

  const config = configs[variant]
  const Icon = config.icon

  return (
    <div className="flex flex-col items-center justify-center gap-3 py-16 px-8">
      <div className="w-12 h-12 rounded-2xl border border-zinc-800 bg-zinc-900/50 flex items-center justify-center">
        <Icon className="w-6 h-6 text-zinc-600" />
      </div>
      <div className="text-center space-y-1">
        <p className="text-sm font-medium text-zinc-400">{config.heading}</p>
        <p className="text-xs text-zinc-600 max-w-[260px] leading-relaxed">
          {config.body}
        </p>
      </div>
    </div>
  )
}

// ─── Expanded Directory Panel ────────────────────────────────────────────────

function ExpandedDirectoryPanel({
  dir,
  onClose,
  activeOverlays,
}: {
  dir: DirectoryEntry
  onClose: () => void
  activeOverlays: Set<string>
}) {
  const [childExpanded, setChildExpanded] = useState<string | null>(null)
  const pathSegments = dir.path.split("/")

  return (
    <div className="rounded-xl border border-zinc-700/60 bg-zinc-900/70 backdrop-blur-sm overflow-hidden mt-1">
      {/* Panel header with breadcrumb */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800/60">
        <nav className="flex items-center gap-1" aria-label="Directory breadcrumb">
          {pathSegments.map((seg, i) => (
            <span key={i} className="flex items-center gap-1">
              {i > 0 && <ChevronRight className="w-3 h-3 text-zinc-700" />}
              <span
                className={cn(
                  "text-[10px] transition-colors duration-150",
                  i === pathSegments.length - 1
                    ? "text-zinc-200 font-medium"
                    : "text-zinc-500",
                )}
              >
                {seg}
              </span>
            </span>
          ))}
        </nav>

        <button
          onClick={onClose}
          aria-label="Close expanded panel"
          className="p-1 rounded-md text-zinc-500 hover:text-zinc-300
                     hover:bg-zinc-800/60 transition-colors duration-150"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Child directory grid */}
      {dir.children.length > 0 ? (
        <div className="p-3">
          <div className="grid gap-2 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {dir.children.map((child, i) => (
              <DirectoryCard
                key={child.path}
                dir={child}
                staggerDelay={i * 0.03}
                isExpanded={childExpanded === child.path}
                onExpand={() =>
                  setChildExpanded(childExpanded === child.path ? null : child.path)
                }
                activeOverlays={activeOverlays}
              />
            ))}
          </div>

          {/* Nested expanded panel */}
          <AnimatePresence>
            {childExpanded && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.22, ease: [0.25, 0.46, 0.45, 0.94] }}
                className="overflow-hidden"
              >
                {dir.children
                  .filter((c) => c.path === childExpanded)
                  .map((c) => (
                    <ExpandedDirectoryPanel
                      key={c.path}
                      dir={c}
                      onClose={() => setChildExpanded(null)}
                      activeOverlays={activeOverlays}
                    />
                  ))}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      ) : (
        <div className="px-4 py-6 text-center">
          <p className="text-[10px] text-zinc-600">No subdirectories</p>
        </div>
      )}

      {/* File count summary */}
      {dir.fileCount > 0 && (
        <div className="px-4 py-2.5 border-t border-zinc-800/60 flex items-center gap-1.5 text-[10px] text-zinc-500">
          <FileCode2 className="w-3 h-3" />
          {dir.fileCount} files &middot; {dir.analyzedFileCount} analyzed
        </div>
      )}
    </div>
  )
}

// ─── List View Row ───────────────────────────────────────────────────────────

function DirectoryListRow({
  dir,
  isExpanded,
  onExpand,
  activeOverlays,
}: {
  dir: DirectoryEntry
  isExpanded: boolean
  onExpand: () => void
  activeOverlays: Set<string>
}) {
  const coverageTextColor =
    dir.coveragePct === 0 ? "text-zinc-600"
      : dir.coveragePct < 50 ? "text-amber-500"
        : dir.coveragePct < 70 ? "text-amber-400"
          : dir.coveragePct < 90 ? "text-cyan-400"
            : "text-cyan-300"

  const barFill =
    dir.coveragePct === 0 ? ""
      : dir.coveragePct < 50 ? "bg-amber-500/60"
        : dir.coveragePct < 70 ? "bg-amber-400/80"
          : "bg-cyan-500/80"

  const folderColor =
    dir.coveragePct === 0 ? "text-zinc-600"
      : dir.coveragePct < 70 ? "text-amber-500/70"
        : "text-cyan-400/80"

  return (
    <div>
      <button
        onClick={onExpand}
        aria-expanded={isExpanded}
        className={cn(
          "w-full flex items-center gap-3 px-4 py-2.5 text-left",
          "cursor-pointer transition-colors duration-150",
          "hover:bg-zinc-800/30",
          dir.severity === "error" && "border-l-2 border-l-red-500/50",
          dir.severity === "warning" && "border-l-2 border-l-amber-500/40",
          dir.severity === "info" && "border-l-2 border-l-blue-400/30",
          dir.severity === "none" && "border-l-2 border-l-transparent",
          isExpanded && "bg-zinc-800/20",
        )}
      >
        <ChevronRight
          className={cn(
            "w-3.5 h-3.5 text-zinc-700 shrink-0 transition-transform duration-150",
            isExpanded && "rotate-90",
          )}
        />
        <FolderOpen className={cn("w-3.5 h-3.5 shrink-0", folderColor)} />
        <span className="flex-1 text-[11px] text-zinc-300 truncate font-mono">
          {dir.path}
        </span>

        {/* Inline coverage bar */}
        <div className="w-24 h-1 rounded-full bg-zinc-800 overflow-hidden shrink-0">
          <div
            className={cn("h-full rounded-full", barFill)}
            style={{ width: `${dir.coveragePct}%` }}
          />
        </div>

        <span className={cn("text-[11px] font-mono font-semibold w-10 text-right shrink-0", coverageTextColor)}>
          {dir.coveragePct}%
        </span>

        <span className="text-[10px] text-zinc-600 w-12 text-right shrink-0 font-mono">
          {dir.fileCount}f
        </span>

        <div className="flex items-center gap-1 w-4 shrink-0">
          {activeOverlays.has("plans") && dir.planIds.length > 0 && (
            <span className="w-1.5 h-1.5 rounded-full bg-purple-400/70" />
          )}
          {activeOverlays.has("memories") && dir.memoryIds.length > 0 && (
            <span className="w-1.5 h-1.5 rounded-full bg-blue-400/70" />
          )}
        </div>
      </button>

      {/* Expanded children */}
      <AnimatePresence>
        {isExpanded && dir.children.length > 0 && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: [0.25, 0.46, 0.45, 0.94] }}
            className="overflow-hidden bg-zinc-900/30 border-l-2 border-l-zinc-800 ml-6"
          >
            {dir.children.map((child) => (
              <DirectoryListRowExpandable
                key={child.path}
                dir={child}
                activeOverlays={activeOverlays}
              />
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function DirectoryListRowExpandable({
  dir,
  activeOverlays,
}: {
  dir: DirectoryEntry
  activeOverlays: Set<string>
}) {
  const [expanded, setExpanded] = useState(false)
  return (
    <DirectoryListRow
      dir={dir}
      isExpanded={expanded}
      onExpand={() => setExpanded(!expanded)}
      activeOverlays={activeOverlays}
    />
  )
}

// ─── Main Component ──────────────────────────────────────────────────────────

// Stable overlay key string for memo comparisons
const ALL_OVERLAYS = "audit,plans,memories"

export const CoverageHeatmap = memo(function CoverageHeatmap({
  projectId,
  projectPath,
  chatId,
}: CoverageHeatmapProps) {
  const { entries, stats, isLoading } = useCoverageData(projectId, projectPath, chatId)

  const [sortMode, setSortMode] = useState<SortMode>("issues-first")
  const [viewMode, setViewMode] = useState<ViewMode>("grid")
  const [expandedPath, setExpandedPath] = useState<string | null>(null)
  const [overlayKey, setOverlayKey] = useState(ALL_OVERLAYS)

  // Derive Set from stable string key (avoids re-creating Set on every render)
  const activeOverlays = useMemo(
    () => new Set(overlayKey.split(",").filter(Boolean)),
    [overlayKey],
  )

  const toggleOverlay = useCallback((key: string) => {
    setOverlayKey((prev) => {
      const parts = new Set(prev.split(",").filter(Boolean))
      if (parts.has(key)) parts.delete(key)
      else parts.add(key)
      return [...parts].join(",")
    })
  }, [])

  const sortedEntries = useMemo(
    () => sortEntries(entries, sortMode),
    [entries, sortMode],
  )

  // Determine empty state variant
  // Show grid even with 0% coverage — gray cards are informative
  const emptyVariant = !projectId || !projectPath
    ? "no-dirs" as const
    : isLoading && entries.length === 0
      ? null // still loading, show skeleton
      : entries.length === 0 && !isLoading
        ? "fresh" as const
        : null // has entries — always show the grid, even at 0% coverage

  // Search all entries (including nested) for expanded path
  const expandedEntry = useMemo(() => {
    if (!expandedPath) return null
    function findDir(dirs: DirectoryEntry[]): DirectoryEntry | null {
      for (const d of dirs) {
        if (d.path === expandedPath) return d
        const found = findDir(d.children)
        if (found) return found
      }
      return null
    }
    return findDir(entries)
  }, [expandedPath, entries])

  // Show a max number initially, with "show more"
  const [showAll, setShowAll] = useState(false)
  const MAX_INITIAL = 20
  const displayEntries = showAll ? sortedEntries : sortedEntries.slice(0, MAX_INITIAL)
  const hasMore = sortedEntries.length > MAX_INITIAL
  const displayListEntries = showAll ? sortedEntries : sortedEntries.slice(0, MAX_INITIAL)

  return (
    <section
      aria-label="Codebase Coverage"
      className="rounded-lg border border-zinc-800 bg-zinc-900/50 overflow-hidden"
    >
      {/* Header */}
      <div className="px-4 py-3 border-b border-zinc-800/60">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          {/* Left */}
          <div className="flex items-center gap-3">
            <FolderOpen className="w-4 h-4 text-cyan-400 shrink-0" />
            <span className="text-sm font-semibold text-zinc-100">Codebase Coverage</span>
            {stats.totalDirs > 0 && (
              <span className="text-[10px] font-mono font-medium px-2 py-0.5 rounded-full
                bg-cyan-400/10 text-cyan-400 border border-cyan-400/20">
                {stats.coveredPct}% covered
              </span>
            )}
          </div>

          {/* Right: controls */}
          <div className="flex items-center gap-2">
            {/* Overlay toggles */}
            <div className="flex items-center gap-1 p-1 rounded-lg bg-zinc-800/60 border border-zinc-700/40">
              <OverlayPill
                label="Audit"
                icon={<SearchCode className="w-3 h-3" />}
                color="cyan"
                active={activeOverlays.has("audit")}
                onToggle={() => toggleOverlay("audit")}
              />
              <OverlayPill
                label="Plans"
                icon={<FileText className="w-3 h-3" />}
                color="purple"
                active={activeOverlays.has("plans")}
                onToggle={() => toggleOverlay("plans")}
              />
              <OverlayPill
                label="Memory"
                icon={<Brain className="w-3 h-3" />}
                color="blue"
                active={activeOverlays.has("memories")}
                onToggle={() => toggleOverlay("memories")}
              />
            </div>

            <SortSelect value={sortMode} onChange={setSortMode} />
            <ViewToggle mode={viewMode} onChange={setViewMode} />
          </div>
        </div>
      </div>

      {/* Summary bar */}
      {stats.totalDirs > 0 && (
        <div className="px-4 border-b border-zinc-800/40 bg-zinc-900/30">
          <CoverageSummaryBar stats={stats} />
        </div>
      )}

      {/* Content */}
      <div className="p-4">
        {isLoading && entries.length === 0 ? (
          // Loading skeleton
          <div className="grid gap-2.5 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <div
                key={i}
                className="h-[120px] rounded-xl bg-zinc-900/40 border border-zinc-800 animate-pulse"
              />
            ))}
          </div>
        ) : emptyVariant ? (
          <EmptyState
            variant={emptyVariant}
            projectId={projectId}
            projectPath={projectPath}
            dirCount={entries.length}
          />
        ) : viewMode === "grid" ? (
          <>
            <div className="grid gap-2.5 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {displayEntries.map((dir, i) => (
                <DirectoryCard
                  key={dir.path}
                  dir={dir}
                  staggerDelay={Math.min(i * 0.04, 0.5)}
                  isExpanded={expandedPath === dir.path}
                  onExpand={() =>
                    setExpandedPath(expandedPath === dir.path ? null : dir.path)
                  }
                  activeOverlays={activeOverlays as Set<string>}
                />
              ))}
            </div>

            {/* Expanded panel — full width below grid */}
            <AnimatePresence>
              {expandedEntry && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.22, ease: [0.25, 0.46, 0.45, 0.94] }}
                  className="overflow-hidden mt-2.5"
                >
                  <ExpandedDirectoryPanel
                    dir={expandedEntry}
                    onClose={() => setExpandedPath(null)}
                    activeOverlays={activeOverlays as Set<string>}
                  />
                </motion.div>
              )}
            </AnimatePresence>

            {/* Show more */}
            {hasMore && !showAll && (
              <button
                onClick={() => setShowAll(true)}
                className="mt-3 w-full text-center text-xs text-zinc-500
                  hover:text-zinc-400 transition-colors duration-150 py-2"
              >
                Show all {sortedEntries.length} directories
              </button>
            )}
          </>
        ) : (
          /* List view */
          <div className="divide-y divide-zinc-800/60 -mx-4 rounded-lg overflow-hidden">
            {displayListEntries.map((dir) => (
              <DirectoryListRow
                key={dir.path}
                dir={dir}
                isExpanded={expandedPath === dir.path}
                onExpand={() =>
                  setExpandedPath(expandedPath === dir.path ? null : dir.path)
                }
                activeOverlays={activeOverlays as Set<string>}
              />
            ))}
            {hasMore && !showAll && (
              <button
                onClick={() => setShowAll(true)}
                className="w-full text-center text-xs text-zinc-500
                  hover:text-zinc-400 transition-colors duration-150 py-3"
              >
                Show all {sortedEntries.length} directories
              </button>
            )}
          </div>
        )}
      </div>
    </section>
  )
})
