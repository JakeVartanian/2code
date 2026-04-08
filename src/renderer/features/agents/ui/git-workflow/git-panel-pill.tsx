import { GitBranch, ChevronDown } from "lucide-react"
import { cn } from "../../../../lib/utils"
import type { WorkflowStage, WorkflowMode } from "./use-git-workflow"

const STAGE_ORDER: WorkflowStage[] = [
  "LOCAL_CHANGES",
  "COMMITTED",
  "PUSHED",
  "PR_OPEN",
  "MERGED",
]

interface GitPanelPillProps {
  mode: WorkflowMode
  stage: WorkflowStage | null
  branch: string | null
  baseBranch: string | null
  aheadCount: number
  changedCount: number
  onExpand: () => void
}

export function GitPanelPill({
  mode,
  stage,
  branch,
  baseBranch,
  aheadCount,
  changedCount,
  onExpand,
}: GitPanelPillProps) {
  const displayBranch = branch || "unknown"

  return (
    <button
      onClick={onExpand}
      className="flex items-center gap-2 w-full px-3 py-1.5 text-xs hover:bg-muted/40 transition-colors text-muted-foreground border-b border-border/40 group"
    >
      <GitBranch className="h-3 w-3 flex-shrink-0 text-muted-foreground/70" />

      {/* Branch display */}
      <span className="font-mono text-foreground/80 truncate max-w-[140px]">{displayBranch}</span>

      {mode === "worktree" && baseBranch && (
        <>
          <span className="text-muted-foreground/40">→</span>
          <span className="font-mono truncate max-w-[100px]">{baseBranch}</span>
          {/* Stage dots */}
          <div className="flex items-center gap-0.5 ml-1">
            {STAGE_ORDER.map((s) => {
              const idx = stage ? STAGE_ORDER.indexOf(stage) : -1
              const sIdx = STAGE_ORDER.indexOf(s)
              const isDone = idx > sIdx
              const isCurrent = s === stage
              return (
                <div
                  key={s}
                  className={cn(
                    "h-1.5 w-1.5 rounded-full transition-colors",
                    isDone && "bg-green-500/80",
                    isCurrent && "bg-blue-400",
                    !isDone && !isCurrent && "bg-muted-foreground/25",
                  )}
                />
              )
            })}
          </div>
        </>
      )}

      {mode === "direct" && (
        <span className="text-muted-foreground/50 text-[10px] font-medium">direct</span>
      )}

      {/* Counts */}
      <div className="flex items-center gap-2 ml-auto">
        {aheadCount > 0 && (
          <span className="text-[10px] text-amber-400/80">↑{aheadCount}</span>
        )}
        {changedCount > 0 && (
          <span className="text-[10px] text-muted-foreground/60">Δ{changedCount}</span>
        )}
        <ChevronDown className="h-3 w-3 text-muted-foreground/40 group-hover:text-muted-foreground transition-colors" />
      </div>
    </button>
  )
}
