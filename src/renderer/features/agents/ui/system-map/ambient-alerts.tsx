/**
 * AmbientAlerts — Compact alert cards for pending ambient suggestions.
 * Severity is indicated by a left border color (high=red, medium=amber, low=blue).
 */

import { memo } from "react"
import { cn } from "../../../../lib/utils"

interface Suggestion {
  id: string
  title: string
  category: string
  severity: string
  triggerFiles: string[]
}

interface AmbientAlertsProps {
  suggestions: Suggestion[]
}

const SEVERITY_BORDER: Record<string, string> = {
  high: "border-l-red-400",
  medium: "border-l-amber-400",
  low: "border-l-blue-400",
}

const SEVERITY_DOT: Record<string, string> = {
  high: "bg-red-400",
  medium: "bg-amber-400",
  low: "bg-blue-400",
}

function truncateFileList(files: string[], max: number = 3): string {
  if (files.length === 0) return ""
  const shown = files.slice(0, max).map((f) => {
    const segments = f.split("/")
    return segments[segments.length - 1] || f
  })
  const remaining = files.length - max
  return remaining > 0
    ? `${shown.join(", ")} +${remaining} more`
    : shown.join(", ")
}

const AlertCard = memo(function AlertCard({
  suggestion,
}: {
  suggestion: Suggestion
}) {
  const borderClass =
    SEVERITY_BORDER[suggestion.severity] ?? "border-l-zinc-600"
  const dotClass = SEVERITY_DOT[suggestion.severity] ?? "bg-zinc-500"

  return (
    <div
      className={cn(
        "rounded-lg border border-zinc-800 border-l-2 bg-zinc-900/30 px-3 py-2.5 space-y-1.5",
        borderClass,
      )}
    >
      <div className="flex items-center gap-2">
        <span className={cn("w-1.5 h-1.5 rounded-full shrink-0", dotClass)} />
        <span className="text-sm text-zinc-200 font-medium truncate flex-1">
          {suggestion.title}
        </span>
        <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400 capitalize shrink-0">
          {suggestion.category}
        </span>
      </div>
      {suggestion.triggerFiles.length > 0 && (
        <p className="text-[11px] text-zinc-500 truncate pl-3.5">
          {truncateFileList(suggestion.triggerFiles)}
        </p>
      )}
    </div>
  )
})

export const AmbientAlerts = memo(function AmbientAlerts({
  suggestions,
}: AmbientAlertsProps) {
  if (suggestions.length === 0) {
    return (
      <p className="text-xs text-zinc-600 italic pt-3">
        No pending suggestions.
      </p>
    )
  }

  return (
    <div className="space-y-2 pt-3">
      {suggestions.map((s) => (
        <AlertCard key={s.id} suggestion={s} />
      ))}
    </div>
  )
})
