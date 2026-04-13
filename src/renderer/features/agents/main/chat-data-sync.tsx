import { createContext, useContext, useLayoutEffect, useRef, type MutableRefObject, type ReactNode } from "react"
import { Chat, useChat } from "@ai-sdk/react"
import { useSetAtom } from "jotai"
import { syncMessagesWithStatusAtom, type Message } from "../stores/message-store"
import { useStreamingStatusStore } from "../stores/streaming-status-store"
import { loadingSubChatsAtom, setLoading, clearLoading } from "../atoms"
import { agentChatStore } from "../stores/agent-chat-store"

// ============================================================================
// CHAT DATA SYNC (LAYER 1)
// ============================================================================
// This component's ONLY job is to:
// 1. Call useChat() to get messages and status
// 2. Sync them to Jotai store
// 3. Sync streaming status to Zustand store
// 4. Provide chat actions (sendMessage, stop, regenerate, setMessages) via context
// 5. Provide messages via a ref (non-reactive access for callbacks/effects)
//
// It WILL re-render on every streaming chunk (~20Hz with throttle), but:
// - It does NO expensive computations
// - It renders ONLY children (which are memoized)
// - All message rendering is done by isolated components that subscribe to atoms
// ============================================================================

// Context for chat actions (sendMessage, stop, regenerate, setMessages)
// Uses getter properties backed by refs so the context value never changes identity,
// preventing children from re-rendering due to context changes.
interface ChatActionsContextValue {
  sendMessage: ReturnType<typeof useChat>["sendMessage"]
  stop: ReturnType<typeof useChat>["stop"]
  regenerate: ReturnType<typeof useChat>["regenerate"]
  setMessages: ReturnType<typeof useChat>["setMessages"]
  /** Current streaming status - access via getter for always-fresh value */
  readonly status: string
  /** Whether this chat is currently streaming */
  readonly isStreaming: boolean
  /** Ref to current messages array - use for non-reactive access in callbacks/effects */
  readonly messagesRef: MutableRefObject<Message[]>
}

const ChatActionsContext = createContext<ChatActionsContextValue | null>(null)

export function useChatActions() {
  const context = useContext(ChatActionsContext)
  if (!context) {
    throw new Error("useChatActions must be used within ChatDataSync")
  }
  return context
}

// Props
interface ChatDataSyncProps {
  chat: Chat<any>
  subChatId: string
  streamId?: string | null
  isActive?: boolean
  children: ReactNode
}

export function ChatDataSync({
  chat,
  subChatId,
  streamId,
  isActive = true,
  children,
}: ChatDataSyncProps) {
  // Call useChat - this causes re-renders on every chunk
  const { messages, sendMessage, status, stop, regenerate, setMessages } = useChat({
    id: subChatId,
    chat,
    resume: !!streamId,
    // PERF: Inactive tabs use a much slower throttle to reduce re-render frequency.
    // Active tabs need 50ms for smooth streaming UX; inactive tabs only need to keep
    // the internal message buffer up to date for when they become active again.
    experimental_throttle: isActive ? 50 : 500,
  })

  // Keep messages in a ref for non-reactive access
  const messagesRef = useRef<Message[]>(messages as Message[])
  messagesRef.current = messages as Message[]

  // Get setter for Jotai store
  const syncMessagesAtom = useSetAtom(syncMessagesWithStatusAtom)

  // Track whether we have pending (un-synced) messages from when this tab was inactive.
  // When isActive transitions to true, we flush the latest messages immediately.
  const hasPendingSyncRef = useRef(false)
  const prevIsActiveRef = useRef(isActive)

  // Sync to Jotai store - this is the ONLY thing we do with messages
  // Using useLayoutEffect to sync before paint
  // CRITICAL: Must pass subChatId to correctly key caches per chat
  //
  // PERF OPTIMIZATION: When isActive=false, we skip syncing to the global Jotai store
  // entirely. The per-subChat atoms are still updated (updateGlobal: false) so that
  // split-pane rendering and status tracking remain correct, but we only do this when
  // the messages actually change structurally (new message count or status change).
  const prevMessageCountRef = useRef(0)
  const prevStatusRef = useRef(status)

  useLayoutEffect(() => {
    if (isActive) {
      // Active tab: always sync immediately (original behavior)
      syncMessagesAtom({ messages: messages as Message[], status, subChatId, updateGlobal: true })
      hasPendingSyncRef.current = false
    } else {
      // Inactive tab: only sync per-subChat atoms when message count or status changes.
      // This prevents the 20Hz re-render cascade for hidden tabs during streaming.
      const messageCount = messages.length
      const statusChanged = status !== prevStatusRef.current
      const countChanged = messageCount !== prevMessageCountRef.current

      if (statusChanged || countChanged) {
        syncMessagesAtom({ messages: messages as Message[], status, subChatId, updateGlobal: false })
        prevMessageCountRef.current = messageCount
        prevStatusRef.current = status
      }
      hasPendingSyncRef.current = true
    }
  }, [messages, status, subChatId, isActive, syncMessagesAtom])

  // Flush pending sync when tab becomes active (catch-up)
  useLayoutEffect(() => {
    if (isActive && !prevIsActiveRef.current && hasPendingSyncRef.current) {
      // Tab just became active - flush latest messages to global store
      syncMessagesAtom({ messages: messages as Message[], status, subChatId, updateGlobal: true })
      hasPendingSyncRef.current = false
    }
    prevIsActiveRef.current = isActive
  }, [isActive, messages, status, subChatId, syncMessagesAtom])

  // Sync status to global streaming status store for queue processing.
  // CRITICAL: Do NOT clear status on unmount — this causes a race condition when
  // switching workspaces. The sequence is: ChatDataSync unmounts → clearStatus →
  // StreamingKeepAlive sees isStreaming=false → stops rendering headless ChatDataSync →
  // Chat transport orphaned → Claude subprocess dies. Status is cleared explicitly by
  // agentChatStore.delete() and removeFromOpenSubChats instead.
  const setStreamingStatus = useStreamingStatusStore((s) => s.setStatus)
  useLayoutEffect(() => {
    setStreamingStatus(subChatId, status as "ready" | "streaming" | "submitted" | "error")
  }, [subChatId, status, setStreamingStatus])

  // Sync loading state to loadingSubChatsAtom so ALL tabs (active AND inactive)
  // show sidebar loading indicators when streaming. Previously only ChatViewInner
  // did this, so background tabs never showed loading dots in the sidebar.
  // CRITICAL: Do NOT clear loading on unmount — same race condition as streaming status.
  // Loading is cleared when status changes to non-streaming (the else branch below),
  // and explicitly by agentChatStore.delete() / removeFromOpenSubChats.
  const setLoadingSubChats = useSetAtom(loadingSubChatsAtom)
  const isStreaming = status === "streaming" || status === "submitted"
  useLayoutEffect(() => {
    const parentChatId = agentChatStore.getParentChatId(subChatId)
    if (!parentChatId) return
    if (isStreaming) {
      setLoading(setLoadingSubChats, subChatId, parentChatId)
    } else {
      clearLoading(setLoadingSubChats, subChatId)
    }
  }, [isStreaming, subChatId, setLoadingSubChats])

  // Stable refs for actions to prevent context recreation
  const actionsRef = useRef({
    sendMessage,
    stop,
    regenerate: regenerate.bind(chat),
    setMessages,
    status,
  })

  // Update refs (no re-render triggered)
  actionsRef.current.sendMessage = sendMessage
  actionsRef.current.stop = stop
  actionsRef.current.regenerate = regenerate.bind(chat)
  actionsRef.current.setMessages = setMessages
  actionsRef.current.status = status

  // Stable context value with getter properties — identity never changes,
  // so React never propagates context updates to children.
  const contextValue = useRef<ChatActionsContextValue>({
    get sendMessage() {
      return actionsRef.current.sendMessage
    },
    get stop() {
      return actionsRef.current.stop
    },
    get regenerate() {
      return actionsRef.current.regenerate
    },
    get setMessages() {
      return actionsRef.current.setMessages
    },
    get status() {
      return actionsRef.current.status
    },
    get isStreaming() {
      const s = actionsRef.current.status
      return s === "streaming" || s === "submitted"
    },
    messagesRef,
  }).current

  return (
    <ChatActionsContext.Provider value={contextValue}>
      {children}
    </ChatActionsContext.Provider>
  )
}
