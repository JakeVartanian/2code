import { GitPullRequest, ExternalLink } from "lucide-react"
import { cn } from "../../../../lib/utils"

type PrState = "open" | "draft" | "merged" | "closed"

const STATE_COLORS: Record<PrState, string> = {
  open: "text-green-400",
  draft: "text-muted-foreground",
  merged: "text-purple-400",
  closed: "text-red-400",
}

const STATE_LABELS: Record<PrState, string> = {
  open: "Open",
  draft: "Draft",
  merged: "Merged",
  closed: "Closed",
}

interface GitPrCardProps {
  prNumber: number
  prUrl: string
  prState: PrState
  reviewDecision: string | null
  mergeable: string | null
  branch: string
  baseBranch: string
}

export function GitPrCard({
  prNumber,
  prUrl,
  prState,
  reviewDecision,
  mergeable,
  branch,
  baseBranch,
}: GitPrCardProps) {
  const hasMergeConflicts = mergeable === "CONFLICTING"
  const isApproved = reviewDecision === "APPROVED"
  const changesRequested = reviewDecision === "CHANGES_REQUESTED"

  return (
    <div className="mx-3 mb-2 rounded-md border border-border/40 bg-muted/20 overflow-hidden">
      <div className="px-3 py-2">
        {/* Header row */}
        <div className="flex items-center gap-2 mb-1.5">
          <GitPullRequest className={cn("h-3.5 w-3.5 flex-shrink-0", STATE_COLORS[prState])} />
          <button
            onClick={() => window.desktopApi.openExternal(prUrl)}
            className="text-xs font-medium text-foreground/80 hover:text-foreground hover:underline flex items-center gap-1"
          >
            PR #{prNumber}
            <ExternalLink className="h-2.5 w-2.5 text-muted-foreground/50" />
          </button>
          <span className={cn("text-[10px] font-medium ml-auto", STATE_COLORS[prState])}>
            {STATE_LABELS[prState]}
          </span>
        </div>

        {/* Branch arrow */}
        <p className="text-[10px] font-mono text-muted-foreground/50 mb-2">
          {branch} → {baseBranch}
        </p>

        {/* Status indicators */}
        <div className="flex flex-col gap-1">
          {hasMergeConflicts && (
            <div className="flex items-center gap-1.5 text-[10px] text-red-400">
              <div className="h-1.5 w-1.5 rounded-full bg-red-400 flex-shrink-0" />
              Merge conflicts — sync with {baseBranch} to resolve
            </div>
          )}
          {isApproved && !hasMergeConflicts && (
            <div className="flex items-center gap-1.5 text-[10px] text-green-400">
              <div className="h-1.5 w-1.5 rounded-full bg-green-400 flex-shrink-0" />
              Approved — ready to merge
            </div>
          )}
          {changesRequested && (
            <div className="flex items-center gap-1.5 text-[10px] text-amber-400">
              <div className="h-1.5 w-1.5 rounded-full bg-amber-400 flex-shrink-0" />
              Changes requested
            </div>
          )}
          {!reviewDecision && !hasMergeConflicts && prState === "open" && (
            <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground/50">
              <div className="h-1.5 w-1.5 rounded-full bg-muted-foreground/25 flex-shrink-0" />
              Awaiting review
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
