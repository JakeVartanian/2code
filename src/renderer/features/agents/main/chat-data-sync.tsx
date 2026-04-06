"use client"

import { createContext, useContext, useLayoutEffect, useRef, type MutableRefObject, type ReactNode } from "react"
import { Chat, useChat } from "@ai-sdk/react"
import { useSetAtom } from "jotai"
import { syncMessagesWithStatusAtom, type Message } from "../stores/message-store"
import { useStreamingStatusStore } from "../stores/streaming-status-store"

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
    experimental_throttle: 50,  // Throttle updates to reduce re-renders during streaming
  })

  // Keep messages in a ref for non-reactive access
  const messagesRef = useRef<Message[]>(messages as Message[])
  messagesRef.current = messages as Message[]

  // Get setter for Jotai store
  const syncMessagesAtom = useSetAtom(syncMessagesWithStatusAtom)

  // Sync to Jotai store - this is the ONLY thing we do with messages
  // Using useLayoutEffect to sync before paint
  // CRITICAL: Must pass subChatId to correctly key caches per chat
  useLayoutEffect(() => {
    syncMessagesAtom({ messages: messages as Message[], status, subChatId, updateGlobal: isActive })
  }, [messages, status, subChatId, isActive, syncMessagesAtom])

  // Sync status to global streaming status store for queue processing
  const setStreamingStatus = useStreamingStatusStore((s) => s.setStatus)
  useLayoutEffect(() => {
    setStreamingStatus(subChatId, status as "ready" | "streaming" | "submitted" | "error")
  }, [subChatId, status, setStreamingStatus])

  // Stable refs for actions to prevent context recreation
  const actionsRef = useRef({
    sendMessage,
    stop,
    regenerate,
    setMessages,
    status,
  })

  // Update refs (no re-render triggered)
  actionsRef.current.sendMessage = sendMessage
  actionsRef.current.stop = stop
  actionsRef.current.regenerate = regenerate
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
