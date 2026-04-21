/**
 * PlanNodes — Displays recent plans as compact cards with
 * file name, modification time, and a status pulse for recently modified plans.
 */

import { memo, useMemo } from "react"
import { FileText } from "lucide-react"
import { cn } from "../../../../lib/utils"

interface Plan {
  path: string
  name: string
  modifiedAt: string
}

interface PlanNodesProps {
  plans: Plan[]
}

function extractFileName(path: string): string {
  const segments = path.split("/")
  return segments[segments.length - 1] || path
}

function formatRelativeTime(dateStr: string): string {
  const now = Date.now()
  const then = new Date(dateStr).getTime()
  const diffMs = now - then

  if (diffMs < 0) return "just now"

  const minutes = Math.floor(diffMs / 60_000)
  if (minutes < 1) return "just now"
  if (minutes < 60) return `${minutes}m ago`

  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`

  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`

  return new Date(dateStr).toLocaleDateString()
}

function isRecentlyModified(dateStr: string): boolean {
  const diffMs = Date.now() - new Date(dateStr).getTime()
  // Consider "recent" if modified within the last 10 minutes
  return diffMs < 10 * 60_000
}

const PlanCard = memo(function PlanCard({ plan }: { plan: Plan }) {
  const fileName = useMemo(() => extractFileName(plan.path), [plan.path])
  const relativeTime = formatRelativeTime(plan.modifiedAt)
  const recent = isRecentlyModified(plan.modifiedAt)

  return (
    <div className="flex items-center gap-3 px-3 py-2.5 rounded-lg border border-zinc-800 bg-zinc-900/30 hover:bg-zinc-800/40 transition-colors duration-200">
      <FileText className="w-4 h-4 text-cyan-400/60 shrink-0" />
      <div className="flex-1 min-w-0">
        <p className="text-sm text-zinc-200 truncate font-medium">{fileName}</p>
        {plan.name !== fileName && (
          <p className="text-[11px] text-zinc-500 truncate">{plan.name}</p>
        )}
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <span className="text-[11px] text-zinc-500">{relativeTime}</span>
        <span
          className={cn(
            "w-2 h-2 rounded-full",
            recent
              ? "bg-green-400 animate-pulse"
              : "bg-zinc-700",
          )}
        />
      </div>
    </div>
  )
})

export const PlanNodes = memo(function PlanNodes({ plans }: PlanNodesProps) {
  if (plans.length === 0) {
    return (
      <p className="text-xs text-zinc-600 italic pt-3">No plans found.</p>
    )
  }

  return (
    <div className="space-y-2 pt-3">
      {plans.map((plan) => (
        <PlanCard key={plan.path} plan={plan} />
      ))}
    </div>
  )
})
