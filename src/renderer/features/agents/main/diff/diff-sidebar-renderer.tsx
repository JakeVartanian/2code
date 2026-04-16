import { memo, useCallback } from "react"
import { Button } from "../../../../components/ui/button"
import { IconCloseSidebarRight } from "../../../../components/ui/icons"
import { ResizableSidebar } from "../../../../components/ui/resizable-sidebar"
import { agentsDiffSidebarWidthAtom } from "../../atoms"
import type { DiffViewMode, ParsedDiffFile } from "../../ui/agent-diff-utils"
import type { AgentDiffViewRef } from "../../ui/agent-diff-view"
import { DiffCenterPeekDialog } from "../../../changes/components/diff-center-peek-dialog"
import { DiffFullPageView } from "../../../changes/components/diff-full-page-view"
import { DiffSidebarHeader } from "../../../changes/components/diff-sidebar-header"
import { DiffSidebarContent } from "./diff-sidebar-content"
import { useDiffState } from "./diff-state-context"

export interface DiffSidebarRendererProps {
  worktreePath: string | null
  chatId: string
  sandboxId: string | null
  repository: { owner: string; name: string } | null
  diffStats: { isLoading: boolean; hasChanges: boolean; fileCount: number; additions: number; deletions: number }
  diffContent: string | null
  parsedFileDiffs: ParsedDiffFile[] | null
  prefetchedFileContents: Record<string, string>
  setDiffCollapseState: (state: { allCollapsed: boolean; allExpanded: boolean }) => void
  diffViewRef: React.RefObject<AgentDiffViewRef | null>
  diffSidebarRef: React.RefObject<HTMLDivElement | null>
  agentChat: { prUrl?: string; prNumber?: number } | null | undefined
  branchData: { current: string } | undefined
  gitStatus: { pushCount?: number; pullCount?: number; hasUpstream?: boolean; ahead?: number; behind?: number; staged?: any[]; unstaged?: any[]; untracked?: any[] } | undefined
  isGitStatusLoading: boolean
  isDiffSidebarOpen: boolean
  diffDisplayMode: "side-peek" | "center-peek" | "full-page"
  diffSidebarWidth: number
  handleReview: () => void
  isReviewing: boolean
  handleCreatePrDirect: () => void
  handleCreatePr: () => void
  isCreatingPr: boolean
  handleMergePr: () => void
  mergePrMutation: { isPending: boolean }
  handleRefreshGitStatus: () => void
  hasPrNumber: boolean
  isPrOpen: boolean
  hasMergeConflicts: boolean
  handleFixConflicts: () => void
  handleExpandAll: () => void
  handleCollapseAll: () => void
  diffMode: DiffViewMode
  setDiffMode: (mode: DiffViewMode) => void
  handleMarkAllViewed: () => void
  handleMarkAllUnviewed: () => void
  isDesktop: boolean
  isFullscreen: boolean
  setDiffDisplayMode: (mode: "side-peek" | "center-peek" | "full-page") => void
  handleCommitToPr: (selectedPaths?: string[]) => void
  isCommittingToPr: boolean
  subChatsWithFiles: Array<{ id: string; name: string; filePaths: string[]; fileCount: number }>
  setDiffStats: (stats: { isLoading: boolean; hasChanges: boolean; fileCount: number; additions: number; deletions: number }) => void
  onDiscardSuccess?: () => void
}

export const DiffSidebarRenderer = memo(function DiffSidebarRenderer({
  worktreePath,
  chatId,
  sandboxId,
  repository,
  diffStats,
  diffContent,
  parsedFileDiffs,
  prefetchedFileContents,
  setDiffCollapseState,
  diffViewRef,
  diffSidebarRef,
  agentChat,
  branchData,
  gitStatus,
  isGitStatusLoading,
  isDiffSidebarOpen,
  diffDisplayMode,
  diffSidebarWidth,
  handleReview,
  isReviewing,
  handleCreatePrDirect,
  handleCreatePr,
  isCreatingPr,
  handleMergePr,
  mergePrMutation,
  handleRefreshGitStatus,
  hasPrNumber,
  isPrOpen,
  hasMergeConflicts,
  handleFixConflicts,
  handleExpandAll,
  handleCollapseAll,
  diffMode,
  setDiffMode,
  handleMarkAllViewed,
  handleMarkAllUnviewed,
  isDesktop,
  isFullscreen,
  setDiffDisplayMode,
  handleCommitToPr,
  isCommittingToPr,
  subChatsWithFiles,
  setDiffStats,
  onDiscardSuccess,
}: DiffSidebarRendererProps) {
  // Get callbacks and state from context
  const { handleCloseDiff, viewedCount, handleViewedCountChange } = useDiffState()

  const handleReviewWithAI = useCallback(() => {
    if (diffDisplayMode !== "side-peek") {
      handleCloseDiff()
    }
    handleReview()
  }, [diffDisplayMode, handleCloseDiff, handleReview])

  const handleCreatePrWithAI = useCallback(() => {
    if (diffDisplayMode !== "side-peek") {
      handleCloseDiff()
    }
    handleCreatePr()
  }, [diffDisplayMode, handleCloseDiff, handleCreatePr])

  // Width for responsive layouts - use stored width for sidebar, fixed for dialog/fullpage
  const effectiveWidth = diffDisplayMode === "side-peek"
    ? diffSidebarWidth
    : diffDisplayMode === "center-peek"
      ? 1200
      : typeof window !== 'undefined' ? window.innerWidth : 1200

  const diffViewContent = (
    <div
      ref={diffSidebarRef}
      className="flex flex-col h-full min-w-0 overflow-hidden"
    >
      {/* Unified Header - branch selector, fetch, review, PR actions, close */}
      {worktreePath ? (
        <DiffSidebarHeader
          worktreePath={worktreePath}
          currentBranch={branchData?.current ?? ""}
          diffStats={diffStats}
          sidebarWidth={effectiveWidth}
          pushCount={gitStatus?.pushCount ?? 0}
          pullCount={gitStatus?.pullCount ?? 0}
          hasUpstream={gitStatus?.hasUpstream ?? true}
          isSyncStatusLoading={isGitStatusLoading}
          aheadOfDefault={gitStatus?.ahead ?? 0}
          behindDefault={gitStatus?.behind ?? 0}
          onReview={handleReviewWithAI}
          isReviewing={isReviewing}
          onCreatePr={handleCreatePrDirect}
          isCreatingPr={isCreatingPr}
          onCreatePrWithAI={handleCreatePrWithAI}
          isCreatingPrWithAI={isCreatingPr}
          onMergePr={handleMergePr}
          isMergingPr={mergePrMutation.isPending}
          onClose={handleCloseDiff}
          onRefresh={handleRefreshGitStatus}
          hasPrNumber={hasPrNumber}
          isPrOpen={isPrOpen}
          hasMergeConflicts={hasMergeConflicts}
          onFixConflicts={handleFixConflicts}
          onExpandAll={handleExpandAll}
          onCollapseAll={handleCollapseAll}
          viewMode={diffMode}
          onViewModeChange={setDiffMode}
          viewedCount={viewedCount}
          onMarkAllViewed={handleMarkAllViewed}
          onMarkAllUnviewed={handleMarkAllUnviewed}
          isDesktop={isDesktop}
          isFullscreen={isFullscreen}
          displayMode={diffDisplayMode}
          onDisplayModeChange={setDiffDisplayMode}
        />
      ) : sandboxId ? (
        <div className="flex items-center h-10 px-2 border-b border-border/50 bg-background flex-shrink-0">
          <Button
            variant="ghost"
            size="sm"
            className="h-6 w-6 p-0 flex-shrink-0 hover:bg-foreground/10"
            onClick={handleCloseDiff}
          >
            <IconCloseSidebarRight className="size-4 text-muted-foreground" />
          </Button>
          <span className="text-sm text-muted-foreground ml-2">Changes</span>
        </div>
      ) : null}

      {/* Content: file list + diff view - vertical when narrow */}
      <DiffSidebarContent
        worktreePath={worktreePath}
        chatId={chatId}
        sandboxId={sandboxId}
        repository={repository}
        diffStats={diffStats}
        setDiffStats={setDiffStats}
        diffContent={diffContent}
        parsedFileDiffs={parsedFileDiffs}
        prefetchedFileContents={prefetchedFileContents}
        setDiffCollapseState={setDiffCollapseState}
        diffViewRef={diffViewRef}
        agentChat={agentChat}
        sidebarWidth={effectiveWidth}
        onCommitWithAI={handleCommitToPr}
        isCommittingWithAI={isCommittingToPr}
        diffMode={diffMode}
        setDiffMode={setDiffMode}
        onCreatePr={handleCreatePrDirect}
        onDiscardSuccess={onDiscardSuccess}
        subChats={subChatsWithFiles}
      />
    </div>
  )

  // Render based on display mode
  if (diffDisplayMode === "side-peek") {
    return (
      <ResizableSidebar
        isOpen={isDiffSidebarOpen}
        onClose={handleCloseDiff}
        widthAtom={agentsDiffSidebarWidthAtom}
        minWidth={320}
        side="right"
        animationDuration={0}
        initialWidth={0}
        exitWidth={0}
        showResizeTooltip={true}
        className="bg-background border-l"
        style={{ borderLeftWidth: "0.5px", overflow: "hidden" }}
      >
        {diffViewContent}
      </ResizableSidebar>
    )
  }

  if (diffDisplayMode === "center-peek") {
    return (
      <DiffCenterPeekDialog
        isOpen={isDiffSidebarOpen}
        onClose={handleCloseDiff}
      >
        {diffViewContent}
      </DiffCenterPeekDialog>
    )
  }

  if (diffDisplayMode === "full-page") {
    return (
      <DiffFullPageView
        isOpen={isDiffSidebarOpen}
        onClose={handleCloseDiff}
      >
        {diffViewContent}
      </DiffFullPageView>
    )
  }

  return null
})
