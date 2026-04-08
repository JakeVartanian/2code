import { useState } from "react"
import { Button } from "../../../../components/ui/button"
import { Textarea } from "../../../../components/ui/textarea"
import { cn } from "../../../../lib/utils"
import type { WorkflowStage, WorkflowMode, WorkflowState } from "./use-git-workflow"
import { GitMergeConfirmDialog } from "./git-merge-confirm-dialog"
import { IconSpinner } from "../../../../components/ui/icons"

interface GitActionAreaProps {
  chatId: string
  mode: WorkflowMode
  stage: WorkflowStage | null
  state: WorkflowState
  branch: string | null
  baseBranch: string | null
  isMutating: boolean
  onCommit: (message: string) => void
  onPush: () => void
  onOpenPR: () => void
}

export function GitActionArea({
  chatId,
  mode,
  stage,
  state,
  branch,
  baseBranch,
  isMutating,
  onCommit,
  onPush,
  onOpenPR,
}: GitActionAreaProps) {
  const [commitMessage, setCommitMessage] = useState("")
  const [mergeDialogOpen, setMergeDialogOpen] = useState(false)

  // ── Direct mode: simple commit + push ──────────────────────────────────────
  if (mode === "direct") {
    const hasChanges = state.uncommittedFiles.length > 0
    const hasUnpushed = state.aheadCount > 0

    return (
      <div className="px-3 pb-3 space-y-2">
        {hasChanges && (
          <div className="space-y-1.5">
            <Textarea
              value={commitMessage}
              onChange={(e) => setCommitMessage(e.target.value)}
              placeholder="Commit message…"
              rows={2}
              className="text-xs resize-none bg-muted/20 border-border/40 focus:border-border"
            />
            <Button
              size="sm"
              disabled={!commitMessage.trim() || isMutating}
              onClick={() => {
                onCommit(commitMessage)
                setCommitMessage("")
              }}
              className="w-full h-7 text-xs gap-1.5"
            >
              {isMutating && <IconSpinner className="h-3 w-3 animate-spin" />}
              Commit {state.uncommittedFiles.length} file{state.uncommittedFiles.length !== 1 ? "s" : ""} to {branch || "branch"}
            </Button>
          </div>
        )}
        {!hasChanges && hasUnpushed && (
          <PushButton
            label={`Push ${state.aheadCount} commit${state.aheadCount !== 1 ? "s" : ""} to origin/${branch || "branch"}`}
            onClick={onPush}
            disabled={isMutating}
          />
        )}
        {!hasChanges && !hasUnpushed && (
          <p className="text-[10px] text-muted-foreground/40 text-center py-1">
            Branch is up to date
          </p>
        )}
      </div>
    )
  }

  // ── Worktree mode: stage-specific actions ──────────────────────────────────
  if (stage === "LOCAL_CHANGES") {
    return (
      <div className="px-3 pb-3 space-y-1.5">
        <Textarea
          value={commitMessage}
          onChange={(e) => setCommitMessage(e.target.value)}
          placeholder="Commit message…"
          rows={2}
          className="text-xs resize-none bg-muted/20 border-border/40 focus:border-border"
        />
        <Button
          size="sm"
          disabled={!commitMessage.trim() || isMutating}
          onClick={() => {
            onCommit(commitMessage)
            setCommitMessage("")
          }}
          className="w-full h-7 text-xs gap-1.5"
        >
          {isMutating && <IconSpinner className="h-3 w-3 animate-spin" />}
          Commit {state.uncommittedFiles.length} file{state.uncommittedFiles.length !== 1 ? "s" : ""}
          {branch ? ` to ${branch}` : ""}
        </Button>
      </div>
    )
  }

  if (stage === "COMMITTED") {
    return (
      <div className="px-3 pb-3">
        <PushButton
          label={`Push ${state.aheadCount} commit${state.aheadCount !== 1 ? "s" : ""} to origin/${branch || "branch"}`}
          onClick={onPush}
          disabled={isMutating}
        />
      </div>
    )
  }

  if (stage === "PUSHED") {
    return (
      <div className="px-3 pb-3">
        <Button
          size="sm"
          onClick={onOpenPR}
          disabled={isMutating}
          variant="outline"
          className="w-full h-7 text-xs gap-1.5 border-border/60"
        >
          {isMutating && <IconSpinner className="h-3 w-3 animate-spin" />}
          Open PR: {branch} → {baseBranch || "base"}
        </Button>
      </div>
    )
  }

  if (stage === "PR_OPEN") {
    const hasMergeConflicts = state.prMergeable === "CONFLICTING"
    const isApproved = state.prReviewDecision === "APPROVED"
    const canMerge = !hasMergeConflicts && state.prState === "open"

    const blockReason = hasMergeConflicts
      ? `Merge conflicts — rebase onto ${baseBranch} first`
      : !isApproved
        ? "Awaiting review approval"
        : null

    return (
      <div className="px-3 pb-3 space-y-1.5">
        {blockReason && (
          <p className="text-[10px] text-muted-foreground/50 text-center">{blockReason}</p>
        )}
        <Button
          size="sm"
          disabled={!canMerge || isMutating}
          onClick={() => setMergeDialogOpen(true)}
          className={cn(
            "w-full h-7 text-xs gap-1.5",
            canMerge
              ? "bg-purple-600 hover:bg-purple-700 text-white"
              : "opacity-40 cursor-not-allowed",
          )}
        >
          Merge {branch} into {baseBranch || "base"}
        </Button>
        <GitMergeConfirmDialog
          open={mergeDialogOpen}
          onOpenChange={setMergeDialogOpen}
          chatId={chatId}
          branch={branch || ""}
          baseBranch={baseBranch || "main"}
        />
      </div>
    )
  }

  if (stage === "MERGED") {
    return (
      <div className="px-3 pb-3 text-center">
        <p className="text-xs text-green-400/80 font-medium py-1">
          Merged into {baseBranch}
        </p>
      </div>
    )
  }

  return null
}

function PushButton({
  label,
  onClick,
  disabled,
}: {
  label: string
  onClick: () => void
  disabled: boolean
}) {
  return (
    <Button
      size="sm"
      onClick={onClick}
      disabled={disabled}
      className="w-full h-7 text-xs gap-1.5"
    >
      {disabled && <IconSpinner className="h-3 w-3 animate-spin" />}
      {label}
    </Button>
  )
}
