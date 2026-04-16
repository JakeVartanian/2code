import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState } from "react"
import { useAtom, useAtomValue } from "jotai"
import { flushSync } from "react-dom"
import {
  agentsChangesPanelCollapsedAtom,
  filteredDiffFilesAtom,
  filteredSubChatIdAtom,
  selectedDiffFilePathAtom,
} from "../../atoms"
import type { ParsedDiffFile } from "../../ui/agent-diff-utils"
import { DiffStateContext } from "./diff-state-context"

export interface DiffStateProviderProps {
  isDiffSidebarOpen: boolean
  parsedFileDiffs: ParsedDiffFile[] | null
  isDiffSidebarNarrow: boolean
  setIsDiffSidebarOpen: (open: boolean) => void
  setDiffStats: (stats: { isLoading: boolean; hasChanges: boolean; fileCount: number; additions: number; deletions: number }) => void
  setDiffContent: (content: string | null) => void
  setParsedFileDiffs: (files: ParsedDiffFile[] | null) => void
  setPrefetchedFileContents: (contents: Record<string, string>) => void
  fetchDiffStats: () => void
  children: React.ReactNode
}

export const DiffStateProvider = memo(function DiffStateProvider({
  isDiffSidebarOpen,
  parsedFileDiffs,
  isDiffSidebarNarrow,
  setIsDiffSidebarOpen,
  setDiffStats,
  setDiffContent,
  setParsedFileDiffs,
  setPrefetchedFileContents,
  fetchDiffStats,
  children,
}: DiffStateProviderProps) {
  // Viewed count state - kept here to avoid re-rendering ChatView
  const [viewedCount, setViewedCount] = useState(0)

  // Ref for resetting activeTab to "changes" before closing
  // This prevents React 19 ref cleanup issues with HistoryView's ContextMenu components
  const resetActiveTabRef = useRef<(() => void) | null>(null)

  // All diff-related atoms are read HERE, not in ChatView
  const [selectedFilePath, setSelectedFilePath] = useAtom(selectedDiffFilePathAtom)
  const [, setFilteredDiffFiles] = useAtom(filteredDiffFilesAtom)
  const [filteredSubChatId, setFilteredSubChatId] = useAtom(filteredSubChatIdAtom)
  const isChangesPanelCollapsed = useAtomValue(agentsChangesPanelCollapsedAtom)

  // Auto-select first file when diff sidebar opens - use useLayoutEffect for synchronous update
  // This prevents the initial render from showing all 11 files before filter kicks in
  useLayoutEffect(() => {
    if (!isDiffSidebarOpen) {
      setSelectedFilePath(null)
      setFilteredDiffFiles(null)
      return
    }

    // Determine which file to select
    let fileToSelect = selectedFilePath
    if (!fileToSelect && parsedFileDiffs && parsedFileDiffs.length > 0) {
      const firstFile = parsedFileDiffs[0]
      fileToSelect = firstFile.newPath !== '/dev/null' ? firstFile.newPath : firstFile.oldPath
      if (fileToSelect && fileToSelect !== '/dev/null') {
        setSelectedFilePath(fileToSelect)
      }
    }

    // Filter logic based on layout mode
    const shouldShowAllFiles = isDiffSidebarNarrow && isChangesPanelCollapsed

    if (shouldShowAllFiles) {
      setFilteredDiffFiles(null)
    } else if (fileToSelect) {
      setFilteredDiffFiles([fileToSelect])
    } else {
      setFilteredDiffFiles(null)
    }
  }, [isDiffSidebarOpen, selectedFilePath, parsedFileDiffs, isDiffSidebarNarrow, isChangesPanelCollapsed, setFilteredDiffFiles, setSelectedFilePath])

  // Stable callbacks
  const handleDiffFileSelect = useCallback((file: { path: string }, _category: string) => {
    setSelectedFilePath(file.path)
    setFilteredDiffFiles([file.path])
  }, [setSelectedFilePath, setFilteredDiffFiles])

  const handleSelectNextFile = useCallback((filePath: string) => {
    setSelectedFilePath(filePath)
    setFilteredDiffFiles([filePath])
  }, [setSelectedFilePath, setFilteredDiffFiles])

  const handleCommitSuccess = useCallback(() => {
    setSelectedFilePath(null)
    setFilteredDiffFiles(null)
    setParsedFileDiffs(null)
    setDiffContent(null)
    setPrefetchedFileContents({})
    setDiffStats({
      fileCount: 0,
      additions: 0,
      deletions: 0,
      isLoading: true,
      hasChanges: false,
    })
    setTimeout(() => {
      fetchDiffStats()
    }, 2000)
  }, [setSelectedFilePath, setFilteredDiffFiles, setParsedFileDiffs, setDiffContent, setPrefetchedFileContents, setDiffStats, fetchDiffStats])

  const handleCloseDiff = useCallback(() => {
    // Use flushSync to reset activeTab synchronously before closing.
    // This unmounts HistoryView's ContextMenu components in a single commit,
    // preventing React 19 ref cleanup "Maximum update depth exceeded" error.
    flushSync(() => {
      resetActiveTabRef.current?.()
    })
    setIsDiffSidebarOpen(false)
    setFilteredSubChatId(null)
  }, [setIsDiffSidebarOpen, setFilteredSubChatId])

  const handleViewedCountChange = useCallback((count: number) => {
    setViewedCount(count)
  }, [])

  const contextValue = useMemo(() => ({
    selectedFilePath,
    filteredSubChatId,
    viewedCount,
    handleDiffFileSelect,
    handleSelectNextFile,
    handleCommitSuccess,
    handleCloseDiff,
    handleViewedCountChange,
    resetActiveTabRef,
  }), [selectedFilePath, filteredSubChatId, viewedCount, handleDiffFileSelect, handleSelectNextFile, handleCommitSuccess, handleCloseDiff, handleViewedCountChange])

  return (
    <DiffStateContext.Provider value={contextValue}>
      {children}
    </DiffStateContext.Provider>
  )
})
