import { createContext, useContext } from "react"

export interface DiffStateContextValue {
  selectedFilePath: string | null
  filteredSubChatId: string | null
  viewedCount: number
  handleDiffFileSelect: (file: { path: string }, category: string) => void
  handleSelectNextFile: (filePath: string) => void
  handleCommitSuccess: () => void
  handleCloseDiff: () => void
  handleViewedCountChange: (count: number) => void
  /** Ref to register a function that resets activeTab to "changes" before closing */
  resetActiveTabRef: React.MutableRefObject<(() => void) | null>
}

export const DiffStateContext = createContext<DiffStateContextValue | null>(null)

export function useDiffState() {
  const ctx = useContext(DiffStateContext)
  if (!ctx) throw new Error('useDiffState must be used within DiffStateProvider')
  return ctx
}
