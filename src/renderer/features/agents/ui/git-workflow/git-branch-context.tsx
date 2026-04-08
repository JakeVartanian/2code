import { GitBranch } from "lucide-react"
import { cn } from "../../../../lib/utils"
import type { WorkflowMode } from "./use-git-workflow"

interface GitBranchContextProps {
  mode: WorkflowMode
  branch: string | null
  baseBranch: string | null
  worktreePath: string | null
  behindCount: number
}

export function GitBranchContext({
  mode,
  branch,
  baseBranch,
  worktreePath,
  behindCount,
}: GitBranchContextProps) {
  const displayBranch = branch || "unknown"

  return (
    <div className="px-3 pt-2.5 pb-1.5">
      <div className="flex items-center gap-1.5 flex-wrap">
        <GitBranch className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
        <span className={cn("font-mono text-sm font-medium", behindCount > 0 ? "text-amber-400" : "text-foreground")}>
          {displayBranch}
        </span>

        {mode === "worktree" && baseBranch && (
          <>
            <span className="text-muted-foreground/50 text-xs">→</span>
            <span className="font-mono text-sm text-muted-foreground">{baseBranch}</span>
            <span className="ml-1 text-[10px] font-medium px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-400 border border-blue-500/20">
              isolated
            </span>
          </>
        )}

        {mode === "direct" && (
          <span className="ml-1 text-[10px] font-medium px-1.5 py-0.5 rounded bg-muted text-muted-foreground border border-border/60">
            direct
          </span>
        )}
      </div>

      {worktreePath && (
        <p className="mt-0.5 text-[10px] text-muted-foreground/40 font-mono truncate pl-5">
          {worktreePath}
        </p>
      )}
    </div>
  )
}
