import { useState } from "react"
import { ChevronUp } from "lucide-react"
import { cn } from "../../../../lib/utils"
import { useGitWorkflow } from "./use-git-workflow"
import { GitPanelPill } from "./git-panel-pill"
import { GitBranchContext } from "./git-branch-context"
import { GitWorkflowStepper } from "./git-workflow-stepper"
import { GitDivergenceWarning } from "./git-divergence-warning"
import { GitChangedFiles } from "./git-changed-files"
import { GitLocalCommits } from "./git-local-commits"
import { GitPrCard } from "./git-pr-card"
import { GitActionArea } from "./git-action-area"

interface GitWorkflowPanelProps {
  chatId: string
  worktreePath: string | null
  branch: string | null
  baseBranch: string | null
  prNumber: number | null
  prUrl: string | null
}

export function GitWorkflowPanel({
  chatId,
  worktreePath,
  branch,
  baseBranch,
  prNumber,
  prUrl,
}: GitWorkflowPanelProps) {
  const [isExpanded, setIsExpanded] = useState(false)

  const {
    state,
    stage,
    mode,
    isMutating,
    handleCommit,
    handlePush,
    handleOpenPR,
    handleRebase,
  } = useGitWorkflow({
    chatId,
    worktreePath,
    branch,
    baseBranch,
    prNumber,
    prUrl,
  })

  // Don't render if we have no git context at all
  if (!worktreePath && !branch) return null

  // Collapsed pill
  if (!isExpanded) {
    return (
      <GitPanelPill
        mode={mode}
        stage={stage}
        branch={branch}
        baseBranch={baseBranch}
        aheadCount={state.aheadCount}
        changedCount={state.uncommittedFiles.length}
        onExpand={() => setIsExpanded(true)}
      />
    )
  }

  // Expanded panel
  return (
    <div className={cn("border-b border-border/40 bg-background/50")}>
      {/* Header with collapse button */}
      <div className="flex items-start justify-between">
        <GitBranchContext
          mode={mode}
          branch={branch}
          baseBranch={baseBranch}
          worktreePath={worktreePath}
          behindCount={state.behindCount}
        />
        <button
          onClick={() => setIsExpanded(false)}
          className="p-2 mt-1 mr-1 text-muted-foreground/40 hover:text-muted-foreground transition-colors"
          aria-label="Collapse git panel"
        >
          <ChevronUp className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Divergence warning — shown before stepper when behind */}
      {state.behindCount > 0 && baseBranch && (
        <GitDivergenceWarning
          baseBranch={baseBranch}
          behindCount={state.behindCount}
          onRebase={handleRebase}
          isRebasing={isMutating}
        />
      )}

      {/* 5-stage stepper — worktree mode only */}
      {mode === "worktree" && stage && (
        <GitWorkflowStepper stage={stage} />
      )}

      {/* Stage-specific content */}
      {(stage === "LOCAL_CHANGES" || mode === "direct") && (
        <GitChangedFiles files={state.uncommittedFiles} />
      )}
      {stage === "COMMITTED" && (
        <GitLocalCommits
          commits={state.unpushedCommits}
          targetRemote={`origin/${branch || "branch"}`}
        />
      )}
      {(stage === "PR_OPEN" || stage === "MERGED") && prNumber && prUrl && branch && baseBranch && (
        <GitPrCard
          prNumber={prNumber}
          prUrl={prUrl}
          prState={(state.prState as "open" | "draft" | "merged" | "closed") || "open"}
          reviewDecision={state.prReviewDecision}
          mergeable={state.prMergeable}
          branch={branch}
          baseBranch={baseBranch}
        />
      )}

      {/* Action area — always visible */}
      <GitActionArea
        chatId={chatId}
        mode={mode}
        stage={stage}
        state={state}
        branch={branch}
        baseBranch={baseBranch}
        isMutating={isMutating}
        onCommit={handleCommit}
        onPush={handlePush}
        onOpenPR={handleOpenPR}
      />
    </div>
  )
}
