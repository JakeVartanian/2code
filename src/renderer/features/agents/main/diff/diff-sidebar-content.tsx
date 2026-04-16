import { lazy, memo, Suspense, useCallback, useEffect, useMemo, useState } from "react"
import { useAtom } from "jotai"
import { toast } from "sonner"
import { cn } from "../../../../lib/utils"
import { trpc } from "../../../../lib/trpc"
import {
  agentsChangesPanelCollapsedAtom,
  agentsChangesPanelWidthAtom,
  diffActiveTabAtom,
  selectedCommitAtom,
  type SelectedCommit,
} from "../../atoms"
import type { DiffViewMode } from "../../ui/agent-diff-utils"
import { ChangesPanel } from "../../../changes"
import { CommitFileItem } from "./commit-file-item"
import { useDiffState } from "./diff-state-context"

// Lazy-loaded: @pierre/diffs (~10MB) only loads when diff view opens
const AgentDiffView = lazy(() => import("../../ui/agent-diff-view").then(m => ({ default: m.AgentDiffView })))

export interface DiffSidebarContentProps {
  worktreePath: string | null
  selectedFilePath: string | null
  onFileSelect: (file: { path: string }, category: string) => void
  chatId: string
  sandboxId: string | null
  repository: { owner: string; name: string } | null
  diffStats: { isLoading: boolean; hasChanges: boolean; fileCount: number; additions: number; deletions: number }
  setDiffStats: (stats: { isLoading: boolean; hasChanges: boolean; fileCount: number; additions: number; deletions: number }) => void
  diffContent: string | null
  parsedFileDiffs: unknown
  prefetchedFileContents: Record<string, string> | undefined
  setDiffCollapseState: (state: Map<string, boolean>) => void
  diffViewRef: React.RefObject<{ expandAll: () => void; collapseAll: () => void; getViewedCount: () => number; markAllViewed: () => void; markAllUnviewed: () => void } | null>
  agentChat: { prUrl?: string; prNumber?: number } | null | undefined
  // Real-time sidebar width for responsive layout during resize
  sidebarWidth: number
  // Commit with AI
  onCommitWithAI?: () => void
  isCommittingWithAI?: boolean
  // Diff view mode
  diffMode: DiffViewMode
  setDiffMode: (mode: DiffViewMode) => void
  // Create PR callback
  onCreatePr?: () => void
  // Called after successful commit to reset diff view state
  onCommitSuccess?: () => void
  // Called after discarding/deleting changes to refresh diff
  onDiscardSuccess?: () => void
  // Subchats with changed files for filtering
  subChats?: Array<{ id: string; name: string; filePaths: string[]; fileCount: number }>
  // Initial subchat filter (e.g., from Review button)
  initialSubChatFilter?: string | null
  // Callback when marking file as viewed to select next file
  onSelectNextFile?: (filePath: string) => void
}

export const DiffSidebarContent = memo(function DiffSidebarContent({
  worktreePath,
  chatId,
  sandboxId,
  repository,
  diffStats,
  setDiffStats,
  diffContent,
  parsedFileDiffs,
  prefetchedFileContents,
  setDiffCollapseState,
  diffViewRef,
  agentChat,
  sidebarWidth,
  onCommitWithAI,
  isCommittingWithAI = false,
  diffMode,
  setDiffMode,
  onCreatePr,
  onDiscardSuccess,
  subChats = [],
}: Omit<DiffSidebarContentProps, 'selectedFilePath' | 'onFileSelect' | 'onCommitSuccess' | 'initialSubChatFilter' | 'onSelectNextFile'>) {
  // Get values from context instead of props
  const {
    selectedFilePath,
    filteredSubChatId,
    handleDiffFileSelect,
    handleSelectNextFile,
    handleCommitSuccess,
    handleViewedCountChange,
    resetActiveTabRef,
  } = useDiffState()

  // Compute initial selected file synchronously for first render
  // This prevents AgentDiffView from rendering all files before filter kicks in
  const initialSelectedFile = useMemo(() => {
    if (selectedFilePath) return selectedFilePath
    if (parsedFileDiffs && (parsedFileDiffs as any).length > 0) {
      const firstFile = (parsedFileDiffs as any)[0]
      const filePath = firstFile.newPath !== '/dev/null' ? firstFile.newPath : firstFile.oldPath
      if (filePath && filePath !== '/dev/null') {
        return filePath
      }
    }
    return null
  }, [selectedFilePath, parsedFileDiffs])
  const [changesPanelWidth, setChangesPanelWidth] = useAtom(agentsChangesPanelWidthAtom)
  const [isChangesPanelCollapsed, setIsChangesPanelCollapsed] = useAtom(agentsChangesPanelCollapsedAtom)
  const [isResizing, setIsResizing] = useState(false)

  // Active tab state (Changes/History) - atom so external components can switch tabs
  const [activeTab, setActiveTab] = useAtom(diffActiveTabAtom)

  // Register the reset function so handleCloseDiff can reset to "changes" tab before closing
  // This prevents React 19 ref cleanup issues with HistoryView's ContextMenu components
  useEffect(() => {
    resetActiveTabRef.current = () => setActiveTab("changes")
    return () => {
      resetActiveTabRef.current = null
    }
  }, [resetActiveTabRef])

  // Selected commit for History tab
  const [selectedCommit, setSelectedCommit] = useAtom(selectedCommitAtom)

  // When sidebar is narrow (< 500px), use vertical layout
  const isNarrow = sidebarWidth < 500

  // Get diff stats for collapsed header display
  const { data: diffStatus } = trpc.changes.getStatus.useQuery(
    { worktreePath: worktreePath || "" },
    { enabled: !!worktreePath && isNarrow }
  )

  // Handle resize drag
  const handleResizePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return

      event.preventDefault()
      event.stopPropagation()

      const startX = event.clientX
      const startWidth = changesPanelWidth
      const pointerId = event.pointerId
      const handleElement = event.currentTarget as HTMLElement

      const minWidth = 200
      const maxWidth = 450

      const clampWidth = (width: number) =>
        Math.max(minWidth, Math.min(maxWidth, width))

      handleElement.setPointerCapture?.(pointerId)
      setIsResizing(true)

      const handlePointerMove = (e: PointerEvent) => {
        const delta = e.clientX - startX
        const newWidth = clampWidth(startWidth + delta)
        setChangesPanelWidth(newWidth)
      }

      const handlePointerUp = () => {
        if (handleElement.hasPointerCapture?.(pointerId)) {
          handleElement.releasePointerCapture(pointerId)
        }
        document.removeEventListener("pointermove", handlePointerMove)
        document.removeEventListener("pointerup", handlePointerUp)
        setIsResizing(false)
      }

      document.addEventListener("pointermove", handlePointerMove)
      document.addEventListener("pointerup", handlePointerUp, { once: true })
    },
    [changesPanelWidth, setChangesPanelWidth]
  )

  // Handle commit selection in History tab
  const handleCommitSelect = useCallback((commit: SelectedCommit) => {
    setSelectedCommit(commit)
  }, [setSelectedCommit])

  // Handle file selection in commit (History tab)
  const handleCommitFileSelect = useCallback((file: { path: string }, commitHash: string) => {
    handleDiffFileSelect(file, "")
  }, [handleDiffFileSelect])

  // Fetch commit files when a commit is selected
  const { data: commitFiles } = trpc.changes.getCommitFiles.useQuery(
    {
      worktreePath: worktreePath || "",
      commitHash: selectedCommit?.hash || "",
    },
    {
      enabled: !!worktreePath && !!selectedCommit,
      staleTime: 60000,
    }
  )

  // Fetch commit file diff when a commit is selected
  const { data: commitFileDiff } = trpc.changes.getCommitFileDiff.useQuery(
    {
      worktreePath: worktreePath || "",
      commitHash: selectedCommit?.hash || "",
      filePath: selectedFilePath || "",
    },
    {
      enabled: !!worktreePath && !!selectedCommit && !!selectedFilePath,
      staleTime: 60000,
    }
  )

  // Use commit diff or regular diff based on selection
  // Only use commit data when in History tab, otherwise always use regular diff
  const shouldUseCommitDiff = activeTab === "history" && selectedCommit
  const effectiveDiff = shouldUseCommitDiff && commitFileDiff ? commitFileDiff : diffContent
  const effectiveParsedFiles = shouldUseCommitDiff ? null : parsedFileDiffs
  const effectivePrefetchedContents = shouldUseCommitDiff ? {} : prefetchedFileContents

  // Shared commit history view content
  const renderCommitHistoryContent = () => {
    if (!selectedCommit) return null
    if (!commitFiles) {
      return (
        <div className="flex items-center justify-center h-32 text-muted-foreground text-sm">
          Loading files...
        </div>
      )
    }
    if (commitFiles.length === 0) {
      return (
        <div className="flex items-center justify-center h-32 text-muted-foreground text-sm">
          No files changed in this commit
        </div>
      )
    }
    return (
      <>
        <div className="px-3 py-2 border-b border-border/50">
          <div className="flex items-start justify-between gap-2 mb-1">
            <div className="text-sm font-medium text-foreground flex-1">
              {selectedCommit.message}
            </div>
            <button
              onClick={() => {
                navigator.clipboard.writeText(selectedCommit.hash)
                toast.success('Copied SHA to clipboard')
              }}
              className="text-xs font-mono text-muted-foreground hover:text-foreground underline cursor-pointer shrink-0"
            >
              {selectedCommit.shortHash}
            </button>
          </div>
          {selectedCommit.description && (
            <div className="text-xs text-foreground/80 mb-2 whitespace-pre-wrap">
              {selectedCommit.description}
            </div>
          )}
          <div className="text-xs text-muted-foreground">
            {selectedCommit.author} • {selectedCommit.date ? new Date(selectedCommit.date).toLocaleString() : 'Unknown date'}
          </div>
        </div>

        <div className="px-2 py-1.5 text-xs text-muted-foreground font-medium bg-muted/30 border-b border-border/50">
          Files in commit ({commitFiles.length})
        </div>
        {commitFiles.map((file) => (
          <CommitFileItem
            key={file.path}
            file={file}
            onClick={() => {}}
          />
        ))}
      </>
    )
  }

  if (isNarrow) {
    // Count changed files for collapsed header
    const changedFilesCount = diffStatus
      ? (diffStatus.staged?.length || 0) + (diffStatus.unstaged?.length || 0) + (diffStatus.untracked?.length || 0)
      : 0
    const stagedCount = diffStatus?.staged?.length || 0

    // Vertical layout: ChangesPanel on top, diff/file list below
    return (
      <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
        {worktreePath && (
          <div className={cn(
            "flex-shrink-0 overflow-hidden flex flex-col",
            "h-[45%] min-h-[200px] border-b border-border/50"
          )}>
            <ChangesPanel
              worktreePath={worktreePath}
              activeTab={activeTab}
              selectedFilePath={selectedFilePath}
              onFileSelect={handleDiffFileSelect}
              onFileOpenPinned={() => {}}
              onCreatePr={onCreatePr}
              onCommitSuccess={handleCommitSuccess}
              onDiscardSuccess={onDiscardSuccess}
              subChats={subChats}
              initialSubChatFilter={filteredSubChatId}
              chatId={chatId}
              selectedCommitHash={selectedCommit?.hash}
              onCommitSelect={handleCommitSelect}
              onCommitFileSelect={handleCommitFileSelect}
              onActiveTabChange={setActiveTab}
              pushCount={diffStatus?.pushCount}
            />
          </div>
        )}
        <div className="flex-1 overflow-hidden flex flex-col relative">
          <div className={cn(
            "absolute inset-0 overflow-y-auto",
            activeTab === "history" && selectedCommit ? "z-10" : "z-0 invisible"
          )}>
            {renderCommitHistoryContent()}
          </div>
          <div className={cn(
            "absolute inset-0 overflow-hidden",
            activeTab === "history" && selectedCommit ? "z-0 invisible" : "z-10"
          )}>
            <Suspense fallback={null}>
              <AgentDiffView
                ref={diffViewRef}
                chatId={chatId}
                sandboxId={sandboxId}
                worktreePath={worktreePath || undefined}
                repository={repository}
                onStatsChange={setDiffStats}
                initialDiff={effectiveDiff}
                initialParsedFiles={effectiveParsedFiles}
                prefetchedFileContents={effectivePrefetchedContents}
                showFooter={false}
                onCollapsedStateChange={setDiffCollapseState}
                onSelectNextFile={handleSelectNextFile}
                onViewedCountChange={handleViewedCountChange}
                initialSelectedFile={initialSelectedFile}
              />
            </Suspense>
          </div>
        </div>
      </div>
    )
  }

  // Horizontal layout: files on left, diff on right
  return (
    <div className="flex flex-1 min-h-0 overflow-hidden">
      {worktreePath && (
        <div
          className="h-full flex-shrink-0 relative"
          style={{ width: changesPanelWidth }}
        >
          <ChangesPanel
            worktreePath={worktreePath}
            activeTab={activeTab}
            selectedFilePath={selectedFilePath}
            onFileSelect={handleDiffFileSelect}
            onFileOpenPinned={() => {}}
            onCreatePr={onCreatePr}
            onCommitSuccess={handleCommitSuccess}
            onDiscardSuccess={onDiscardSuccess}
            subChats={subChats}
            initialSubChatFilter={filteredSubChatId}
            chatId={chatId}
            selectedCommitHash={selectedCommit?.hash}
            onCommitSelect={handleCommitSelect}
            onCommitFileSelect={handleCommitFileSelect}
            onActiveTabChange={setActiveTab}
            pushCount={diffStatus?.pushCount}
          />
          <div
            onPointerDown={handleResizePointerDown}
            className="absolute top-0 bottom-0 cursor-col-resize z-10"
            style={{
              right: 0,
              width: "4px",
              marginRight: "-2px",
            }}
          />
        </div>
      )}
      <div className={cn(
        "flex-1 h-full min-w-0 overflow-hidden relative",
        "border-l border-border/50"
      )}>
        <div className={cn(
          "absolute inset-0 overflow-y-auto",
          activeTab === "history" && selectedCommit ? "z-10" : "z-0 invisible"
        )}>
          {renderCommitHistoryContent()}
        </div>
        <div className={cn(
          "absolute inset-0 overflow-hidden",
          activeTab === "history" && selectedCommit ? "z-0 invisible" : "z-10"
        )}>
          <Suspense fallback={null}>
            <AgentDiffView
              ref={diffViewRef}
              chatId={chatId}
              sandboxId={sandboxId}
              worktreePath={worktreePath || undefined}
              repository={repository}
              onStatsChange={setDiffStats}
              initialDiff={effectiveDiff}
              initialParsedFiles={effectiveParsedFiles}
              prefetchedFileContents={effectivePrefetchedContents}
              showFooter={true}
              onCollapsedStateChange={setDiffCollapseState}
              onSelectNextFile={handleSelectNextFile}
              onViewedCountChange={handleViewedCountChange}
              initialSelectedFile={initialSelectedFile}
            />
          </Suspense>
        </div>
      </div>
    </div>
  )
})
