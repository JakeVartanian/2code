/**
 * Background Tasks Indicator — shows actively streaming workspaces
 * that aren't the currently selected one. Sits below the Ambient
 * section in the sidebar. Click to navigate to the workspace.
 */

import { memo, useMemo, useCallback } from "react"
import { useAtomValue, useSetAtom } from "jotai"
import { Loader2 } from "lucide-react"
import {
  loadingSubChatsAtom,
  selectedAgentChatIdAtom,
  showNewChatFormAtom,
} from "../agents/atoms"
import { trpc } from "../../lib/trpc"
import { TextShimmer } from "../../components/ui/text-shimmer"

export const BackgroundTasksIndicator = memo(function BackgroundTasksIndicator() {
  const loadingSubChats = useAtomValue(loadingSubChatsAtom)
  const selectedChatId = useAtomValue(selectedAgentChatIdAtom)
  const setSelectedChatId = useSetAtom(selectedAgentChatIdAtom)
  const setShowNewChatForm = useSetAtom(showNewChatFormAtom)

  // Group loading sub-chats by parent chat, excluding the currently selected workspace
  const backgroundChatIds = useMemo(() => {
    const ids = new Set<string>()
    for (const [, parentChatId] of loadingSubChats) {
      if (parentChatId !== selectedChatId) {
        ids.add(parentChatId)
      }
    }
    return [...ids]
  }, [loadingSubChats, selectedChatId])

  // Fetch chat list to resolve names
  const { data: allChats } = trpc.chats.list.useQuery({})

  const items = useMemo(() => {
    if (!allChats) return []
    const chatMap = new Map(allChats.map((c) => [c.id, c]))
    return backgroundChatIds.map((chatId) => {
      const chat = chatMap.get(chatId)
      // Count how many sub-chats are streaming in this workspace
      let tabCount = 0
      for (const [, parentId] of loadingSubChats) {
        if (parentId === chatId) tabCount++
      }
      return {
        id: chatId,
        name: chat?.name || "Workspace",
        branch: chat?.branch,
        tabCount,
      }
    })
  }, [allChats, backgroundChatIds, loadingSubChats])

  const handleClick = useCallback((chatId: string) => {
    setSelectedChatId(chatId)
    setShowNewChatForm(false)
  }, [setSelectedChatId, setShowNewChatForm])

  if (items.length === 0) return null

  return (
    <div className="px-2 pb-1">
      {/* Section header */}
      <div className="flex items-center gap-1.5 px-1.5 py-1 text-xs font-medium text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin flex-shrink-0 text-blue-400/70" />
        <TextShimmer
          as="span"
          duration={3}
          className="text-muted-foreground"
        >
          {items.length === 1 ? "1 workspace working" : `${items.length} workspaces working`}
        </TextShimmer>
      </div>

      {/* Workspace items — click to navigate */}
      <div className="space-y-0.5">
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => handleClick(item.id)}
            className="flex w-full items-center gap-1.5 px-2 py-0.5 rounded text-[11px] text-muted-foreground/70 hover:text-muted-foreground hover:bg-muted/50 transition-colors cursor-pointer text-left"
          >
            <span className="h-1.5 w-1.5 rounded-full bg-blue-400/60 flex-shrink-0 animate-pulse" />
            <span className="truncate flex-1 min-w-0">
              {item.name}
            </span>
            {item.tabCount > 1 && (
              <span className="text-muted-foreground/40 flex-shrink-0">
                {item.tabCount} tabs
              </span>
            )}
          </button>
        ))}
      </div>
    </div>
  )
})
