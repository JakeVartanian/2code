import { useMemo } from "react"
import { useStreamingStatusStore } from "../stores/streaming-status-store"
import { useMessageQueueStore } from "../stores/message-queue-store"
import { agentChatStore } from "../stores/agent-chat-store"
import { ChatDataSync } from "../main/chat-data-sync"

/**
 * Renders headless ChatDataSync instances for ALL streaming/queued sub-chats.
 *
 * Lives above ChatView in the component tree so it persists regardless of which
 * workspace is selected (or if no workspace is selected). This prevents Claude
 * subprocesses from being killed when the user switches workspaces or deselects
 * all chats.
 *
 * Uses the bare subChatId as key so React can MOVE instances between this
 * component and ChatView's tabsToRender without unmount/remount cycles.
 */
export function StreamingKeepAlive() {
  const streamingStatuses = useStreamingStatusStore((s) => s.statuses)
  const queues = useMessageQueueStore((s) => s.queues)

  const streamingIds = useMemo(() => {
    const ids: string[] = []
    for (const id of agentChatStore.keys()) {
      const isStreaming = useStreamingStatusStore.getState().isStreaming(id)
      const hasQueued = (useMessageQueueStore.getState().queues[id]?.length ?? 0) > 0
      if (isStreaming || hasQueued) {
        ids.push(id)
      }
    }
    return ids
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streamingStatuses, queues])

  if (streamingIds.length === 0) return null

  return (
    <>
      {streamingIds.map(subChatId => {
        const chat = agentChatStore.get(subChatId)
        if (!chat) return null
        return (
          <ChatDataSync key={subChatId} chat={chat} subChatId={subChatId} streamId={agentChatStore.getStreamId(subChatId)} isActive={false}>
            {null}
          </ChatDataSync>
        )
      })}
    </>
  )
}
