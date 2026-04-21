/**
 * DirectoryCard — the core visual unit of the coverage heatmap.
 * Each card represents one directory with coverage %, confidence,
 * severity badges, and overlay indicators.
 */

import { memo } from "react"
import { motion, useReducedMotion } from "motion/react"
import {
  Folder,
  FolderOpen,
  FileCode2,
  Activity,
  AlertTriangle,
  Info,
  ChevronRight,
} from "lucide-react"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../../../../../components/ui/tooltip"
import { cn } from "../../../../../lib/utils"
import type { DirectoryEntry, Severity } from "./use-coverage-data"

// ─── Types ───────────────────────────────────────────────────────────────────

type CardState = "untouched" | "partial" | "covered" | "attention" | "analyzing"

interface DirectoryCardProps {
  dir: DirectoryEntry
  staggerDelay?: number
  isExpanded: boolean
  onExpand: () => void
  activeOverlays: Set<string>
}

// ─── State derivation ────────────────────────────────────────────────────────

function getCardState(dir: DirectoryEntry): CardState {
  if (dir.isAnalyzing) return "analyzing"
  if (dir.severity === "error" || dir.severity === "warning") return "attention"
  if (dir.coveragePct >= 70) return "covered"
  if (dir.coveragePct > 0) return "partial"
  return "untouched"
}

function getCoverageTextColor(pct: number): string {
  if (pct === 0) return "text-zinc-600"
  if (pct < 50) return "text-amber-500"
  if (pct < 70) return "text-amber-400"
  if (pct < 90) return "text-cyan-400"
  return "text-cyan-300"
}

function getBarFillClass(pct: number, state: CardState): string {
  if (pct === 0) return ""
  if (state === "attention") return "bg-red-500/70"
  if (pct < 50) return "bg-amber-500/60"
  if (pct < 70) return "bg-amber-400/80"
  if (pct < 90) return "bg-cyan-500/80"
  return "bg-gradient-to-r from-cyan-500 to-cyan-300"
}

function getFolderColor(state: CardState, severity: Severity): string {
  if (state === "analyzing") return "text-cyan-300"
  if (state === "attention") return severity === "error" ? "text-red-400/80" : "text-amber-400/80"
  if (state === "covered") return "text-cyan-400/80"
  if (state === "partial") return "text-amber-500/70"
  return "text-zinc-600"
}

// ─── Relative time helper ────────────────────────────────────────────────────

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return "just now"
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  return `${days}d ago`
}

// ─── Severity Badge ──────────────────────────────────────────────────────────

function SeverityBadge({ severity, count }: { severity: Severity; count: number }) {
  if (severity === "none") return null

  const isError = severity === "error"
  const Icon = severity === "info" ? Info : AlertTriangle

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-px rounded-md",
        isError
          ? "bg-red-500/12 text-red-400 border border-red-500/20"
          : severity === "warning"
            ? "bg-amber-500/12 text-amber-400 border border-amber-500/20"
            : "bg-blue-400/10 text-blue-400 border border-blue-400/20",
      )}
    >
      <Icon className="w-2.5 h-2.5" />
      {count}
    </span>
  )
}

// ─── Tooltip Content ─────────────────────────────────────────────────────────

function HoverTooltipContent({ dir }: { dir: DirectoryEntry }) {
  return (
    <div className="space-y-2">
      <div className="space-y-0.5">
        <p className="text-[10px] font-medium text-zinc-300">Coverage breakdown</p>
        <p className="text-[10px] text-zinc-500">
          {dir.analyzedFileCount} of {dir.fileCount} files analyzed
        </p>
      </div>

      <div className="h-px bg-zinc-800" />

      <div className="flex items-center justify-between gap-3">
        <span className="text-[10px] text-zinc-500">Confidence</span>
        <div className="flex items-center gap-1.5">
          <div className="h-1 w-16 rounded-full bg-zinc-800 overflow-hidden">
            <div
              className="h-full rounded-full bg-blue-400/60"
              style={{ width: `${dir.confidence}%` }}
            />
          </div>
          <span className="text-[10px] text-zinc-500 font-mono">{dir.confidence}</span>
        </div>
      </div>

      {dir.issueCount > 0 && (
        <div className="flex items-center gap-1.5 text-[10px] text-amber-400">
          <AlertTriangle className="w-3 h-3" />
          {dir.issueCount} issue{dir.issueCount !== 1 ? "s" : ""} found
        </div>
      )}

      {dir.planIds.length > 0 && (
        <div className="flex items-center gap-1.5 text-[10px] text-purple-400">
          <FileCode2 className="w-3 h-3" />
          {dir.planIds.length} plan{dir.planIds.length !== 1 ? "s" : ""} touched this
        </div>
      )}

      {dir.lastAnalyzedAt && (
        <p className="text-[10px] text-zinc-600">
          Analyzed {relativeTime(dir.lastAnalyzedAt)}
        </p>
      )}
    </div>
  )
}

// ─── Main Component ──────────────────────────────────────────────────────────

export const DirectoryCard = memo(function DirectoryCard({
  dir,
  staggerDelay = 0,
  isExpanded,
  onExpand,
  activeOverlays,
}: DirectoryCardProps) {
  const prefersReducedMotion = useReducedMotion()
  const state = getCardState(dir)
  const FolderIcon = state === "covered" || state === "analyzing" ? FolderOpen : Folder

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <motion.div
          initial={prefersReducedMotion ? {} : { opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.25, ease: "easeOut", delay: staggerDelay }}
          className="relative"
        >
          {/* Analyzing pulse glow */}
          {dir.isAnalyzing && !prefersReducedMotion && (
            <motion.div
              className="absolute inset-0 rounded-xl pointer-events-none"
              animate={{
                boxShadow: [
                  "0 0 0px rgba(6,182,212,0)",
                  "0 0 16px rgba(6,182,212,0.12)",
                  "0 0 0px rgba(6,182,212,0)",
                ],
              }}
              transition={{ duration: 2.5, repeat: Infinity, ease: "easeInOut" }}
            />
          )}

          <button
            onClick={onExpand}
            aria-expanded={isExpanded}
            aria-label={`${dir.name}, ${dir.coveragePct}% coverage. ${dir.children.length} subdirectories. ${isExpanded ? "Collapse" : "Expand"} directory`}
            className={cn(
              "relative w-full text-left rounded-xl border overflow-hidden",
              "transition-all duration-200 ease-out",
              "focus-visible:outline-none focus-visible:ring-2",
              "focus-visible:ring-cyan-400/60 focus-visible:ring-offset-2",
              "focus-visible:ring-offset-zinc-900",

              // Untouched
              state === "untouched" && [
                "bg-zinc-900/40 border-zinc-800",
                "hover:border-zinc-700 hover:bg-zinc-900/70",
                "hover:shadow-[0_2px_8px_rgba(0,0,0,0.3)]",
              ],
              // Partial
              state === "partial" && [
                "bg-zinc-900/50 border-zinc-700/60",
                "hover:border-amber-500/25 hover:bg-zinc-900/70",
                "hover:shadow-[0_2px_12px_rgba(245,158,11,0.06)]",
              ],
              // Well-covered (90%+)
              state === "covered" && dir.coveragePct >= 90 && [
                "bg-zinc-900/50 border-cyan-500/25",
                "shadow-[0_0_16px_rgba(6,182,212,0.08)]",
                "hover:border-cyan-500/40 hover:bg-zinc-900/70",
                "hover:shadow-[0_0_24px_rgba(6,182,212,0.13)]",
              ],
              // Well-covered (70-89%)
              state === "covered" && dir.coveragePct < 90 && [
                "bg-zinc-900/50 border-cyan-500/20",
                "shadow-[0_0_12px_rgba(6,182,212,0.05)]",
                "hover:border-cyan-500/35 hover:bg-zinc-900/70",
                "hover:shadow-[0_0_20px_rgba(6,182,212,0.10)]",
              ],
              // Attention — error
              state === "attention" && dir.severity === "error" && [
                "bg-zinc-900/50 border-red-500/25",
                "hover:border-red-500/40",
                "hover:shadow-[0_2px_12px_rgba(239,68,68,0.10)]",
              ],
              // Attention — warning
              state === "attention" && dir.severity !== "error" && [
                "bg-zinc-900/50 border-amber-500/20",
                "hover:border-amber-500/35",
                "hover:shadow-[0_2px_12px_rgba(245,158,11,0.08)]",
              ],
              // Analyzing
              state === "analyzing" && [
                "bg-zinc-900/50 border-cyan-500/30",
                "shadow-[0_0_16px_rgba(6,182,212,0.10)]",
              ],
              // Expanded
              isExpanded && [
                "border-cyan-400/40",
                "shadow-[0_0_24px_rgba(6,182,212,0.12)]",
                "ring-1 ring-cyan-400/20 ring-inset",
              ],
            )}
          >
            {/* Analyzing shimmer sweep */}
            {dir.isAnalyzing && !prefersReducedMotion && (
              <motion.div
                className="absolute inset-0 rounded-xl overflow-hidden pointer-events-none"
                animate={{ x: ["-100%", "200%"] }}
                transition={{
                  duration: 1.8,
                  repeat: Infinity,
                  ease: "linear",
                  repeatDelay: 1.2,
                }}
              >
                <div className="w-1/3 h-full bg-gradient-to-r from-transparent via-cyan-400/5 to-transparent" />
              </motion.div>
            )}

            <div className="p-3.5 space-y-2.5">
              {/* Header: icon + name + coverage % */}
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-start gap-2 min-w-0">
                  <FolderIcon
                    className={cn("w-4 h-4 mt-0.5 shrink-0", getFolderColor(state, dir.severity))}
                  />
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-[11px] font-semibold text-zinc-100 truncate leading-tight">
                        {dir.name}
                      </span>
                      {dir.severity !== "none" && (
                        <SeverityBadge severity={dir.severity} count={dir.issueCount} />
                      )}
                    </div>
                    <span className="text-[10px] text-zinc-500 truncate block leading-tight mt-0.5">
                      {dir.path}
                    </span>
                  </div>
                </div>

                {/* Hero coverage number */}
                <span
                  aria-label={`${dir.coveragePct} percent coverage`}
                  className={cn(
                    "text-sm font-semibold font-mono shrink-0 leading-tight",
                    getCoverageTextColor(dir.coveragePct),
                  )}
                >
                  {dir.coveragePct}%
                </span>
              </div>

              {/* Coverage bar */}
              <div className="h-1.5 rounded-full bg-zinc-800/80 overflow-hidden relative">
                {dir.isAnalyzing ? (
                  <motion.div
                    className="absolute inset-y-0 left-0 w-full bg-gradient-to-r from-cyan-500/30 via-cyan-300/50 to-cyan-500/30"
                    animate={{ x: ["-60%", "100%"] }}
                    transition={{ duration: 1.5, repeat: Infinity, ease: "easeInOut" }}
                  />
                ) : (
                  <motion.div
                    className={cn("h-full rounded-full", getBarFillClass(dir.coveragePct, state))}
                    initial={prefersReducedMotion ? { width: `${dir.coveragePct}%` } : { width: 0 }}
                    animate={{ width: `${dir.coveragePct}%` }}
                    transition={{
                      duration: 0.6,
                      ease: [0.25, 0.46, 0.45, 0.94],
                      delay: staggerDelay + 0.1,
                    }}
                  />
                )}
              </div>

              {/* Meta row */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <span className="flex items-center gap-1 text-[10px] text-zinc-500">
                    <FileCode2 className="w-3 h-3" />
                    <span>{dir.fileCount}</span>
                  </span>
                  <span className="flex items-center gap-1 text-[10px] text-zinc-500">
                    <Activity className="w-3 h-3" />
                    <span>{dir.confidence}</span>
                  </span>
                  {dir.lastAnalyzedAt && (
                    <span className="text-[10px] text-zinc-600">
                      {relativeTime(dir.lastAnalyzedAt)}
                    </span>
                  )}
                </div>

                {/* Overlay indicator dots */}
                <div className="flex items-center gap-1">
                  {activeOverlays.has("plans") && dir.planIds.length > 0 && (
                    <span
                      className="w-1.5 h-1.5 rounded-full bg-purple-400/70"
                      title={`${dir.planIds.length} plan${dir.planIds.length !== 1 ? "s" : ""}`}
                    />
                  )}
                  {activeOverlays.has("memories") && dir.memoryIds.length > 0 && (
                    <span
                      className="w-1.5 h-1.5 rounded-full bg-blue-400/70"
                      title={`${dir.memoryIds.length} memor${dir.memoryIds.length !== 1 ? "ies" : "y"}`}
                    />
                  )}
                </div>
              </div>

              {/* Child directory indicator */}
              {dir.children.length > 0 && !isExpanded && (
                <div className="flex items-center gap-1.5 pt-0.5 border-t border-zinc-800/50">
                  <ChevronRight className="w-3 h-3 text-zinc-700 shrink-0" />
                  <span className="text-[10px] text-zinc-600">
                    {dir.children.length} subdirector{dir.children.length === 1 ? "y" : "ies"}
                  </span>
                </div>
              )}
            </div>
          </button>
        </motion.div>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={6} className="max-w-[220px] p-3 space-y-2">
        <HoverTooltipContent dir={dir} />
      </TooltipContent>
    </Tooltip>
  )
})
