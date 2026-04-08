import { AlertTriangle, GitMerge } from "lucide-react"
import { Button } from "../../../../components/ui/button"

interface GitDivergenceWarningProps {
  baseBranch: string
  behindCount: number
  onRebase: () => void
  isRebasing: boolean
}

export function GitDivergenceWarning({
  baseBranch,
  behindCount,
  onRebase,
  isRebasing,
}: GitDivergenceWarningProps) {
  if (behindCount <= 0) return null

  return (
    <div className="mx-3 mb-2 flex items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2">
      <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0 text-amber-400" />
      <p className="flex-1 text-xs text-amber-300/90">
        <span className="font-medium">{baseBranch}</span> has{" "}
        {behindCount} new commit{behindCount !== 1 ? "s" : ""} — rebase recommended before merging
      </p>
      <Button
        variant="ghost"
        size="sm"
        onClick={onRebase}
        disabled={isRebasing}
        className="h-6 px-2 text-[10px] font-medium text-amber-400 hover:text-amber-300 hover:bg-amber-500/15 flex-shrink-0 gap-1"
      >
        <GitMerge className="h-3 w-3" />
        Rebase
      </Button>
    </div>
  )
}
