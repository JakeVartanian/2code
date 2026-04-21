/**
 * AuditTrends — sparkline trend visualization per zone.
 * Uses minimal inline SVG paths, no charting library.
 */

import { memo } from "react"
import { TrendingUp, TrendingDown, Minus } from "lucide-react"
import { cn } from "../../../../../lib/utils"
import { trpc } from "../../../../../lib/trpc"

interface AuditTrendsProps {
  projectId: string
}

function scoreColor(score: number): string {
  if (score >= 80) return "text-green-400"
  if (score >= 60) return "text-cyan-400"
  if (score >= 40) return "text-amber-400"
  return "text-red-400"
}

function scoreBg(score: number): string {
  if (score >= 80) return "bg-green-500/15"
  if (score >= 60) return "bg-cyan-500/15"
  if (score >= 40) return "bg-amber-500/15"
  return "bg-red-500/15"
}

/**
 * Renders a tiny sparkline SVG from an array of scores (0-100).
 */
function Sparkline({ scores, className }: { scores: number[]; className?: string }) {
  if (scores.length < 2) return null

  const width = 60
  const height = 16
  const padding = 1

  const min = Math.min(...scores)
  const max = Math.max(...scores)
  const range = max - min || 1

  const points = scores.map((s, i) => {
    const x = padding + (i / (scores.length - 1)) * (width - 2 * padding)
    const y = padding + (1 - (s - min) / range) * (height - 2 * padding)
    return `${x},${y}`
  })

  const lastScore = scores[scores.length - 1]
  const strokeColor = lastScore >= 80 ? "#22c55e"
    : lastScore >= 60 ? "#06b6d4"
    : lastScore >= 40 ? "#f59e0b"
    : "#ef4444"

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={className}
    >
      <polyline
        points={points.join(" ")}
        fill="none"
        stroke={strokeColor}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity="0.7"
      />
    </svg>
  )
}

export const AuditTrends = memo(function AuditTrends({ projectId }: AuditTrendsProps) {
  const trendsQuery = trpc.ambient.getAuditTrends.useQuery(
    { projectId, limit: 10 },
    { refetchInterval: 30_000, placeholderData: (prev) => prev },
  )

  const trends = trendsQuery.data?.trends ?? []
  const overallScore = trendsQuery.data?.overallScore ?? 0

  if (trends.length === 0) {
    return (
      <div className="py-6 text-center">
        <p className="text-xs text-zinc-600">Run at least two audits to see trends.</p>
      </div>
    )
  }

  return (
    <div className="pt-3 space-y-3">
      {/* Overall project health */}
      <div className="flex items-center gap-3 px-3 py-2 rounded-lg bg-zinc-800/30">
        <span className={cn("text-2xl font-mono font-bold", scoreColor(overallScore))}>
          {overallScore}
        </span>
        <div>
          <p className="text-[10px] font-medium text-zinc-300">Project Health</p>
          <p className="text-[9px] text-zinc-600">Average across {trends.length} zone{trends.length !== 1 ? "s" : ""}</p>
        </div>
      </div>

      {/* Per-zone trends */}
      <div className="space-y-1">
        {trends.map((t) => (
          <div
            key={t.zoneId}
            className="flex items-center gap-3 px-3 py-2 rounded-md hover:bg-zinc-800/20 transition-colors"
          >
            {/* Zone name */}
            <span className="text-[10px] text-zinc-400 w-28 truncate shrink-0">
              {t.zoneName}
            </span>

            {/* Score */}
            <span className={cn(
              "text-[10px] font-mono font-semibold w-8 text-right shrink-0",
              scoreColor(t.currentScore),
            )}>
              {t.currentScore}
            </span>

            {/* Sparkline */}
            <Sparkline scores={t.scores} className="shrink-0" />

            {/* Trend arrow */}
            {t.trend === "up" ? (
              <TrendingUp className="w-3 h-3 text-green-400 shrink-0" />
            ) : t.trend === "down" ? (
              <TrendingDown className="w-3 h-3 text-red-400 shrink-0" />
            ) : (
              <Minus className="w-3 h-3 text-zinc-600 shrink-0" />
            )}
          </div>
        ))}
      </div>
    </div>
  )
})
