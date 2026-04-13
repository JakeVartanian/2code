import { memo } from "react"
import { useAtomValue } from "jotai"
import { userMessageIdsPerChatAtom, chatTruncationAtomFamily } from "../stores/message-store"
import { IsolatedMessageGroup } from "./isolated-message-group"
import { AlertCircle } from "lucide-react"

// ============================================================================
// ISOLATED MESSAGES SECTION (LAYER 3)
// ============================================================================
// Renders ALL message groups by subscribing to userMessageIdsAtom.
// Only re-renders when a new user message is added (new conversation turn).
// Each group independently subscribes to its own data via IsolatedMessageGroup.
//
// During streaming:
// - This component does NOT re-render (userMessageIds don't change)
// - Individual groups don't re-render (their user msg + assistant IDs don't change)
// - Only the AssistantMessageItem for the streaming message re-renders
// ============================================================================

interface IsolatedMessagesSectionProps {
  subChatId: string
  chatId: string
  isMobile: boolean
  sandboxSetupStatus: "cloning" | "ready" | "error"
  stickyTopClass: string
  sandboxSetupError?: string
  onRetrySetup?: () => void
  onRollback?: (msg: any) => void
  onFork?: (messageId: string) => void
  // Components passed from parent - must be stable references
  UserBubbleComponent: React.ComponentType<{
    messageId: string
    textContent: string
    imageParts: any[]
    skipTextMentionBlocks?: boolean
  }>
  ToolCallComponent: React.ComponentType<{
    icon: any
    title: string
    isPending: boolean
    isError: boolean
  }>
  MessageGroupWrapper: React.ComponentType<{ children: React.ReactNode; isLastGroup?: boolean }>
  toolRegistry: Record<string, { icon: any; title: (args: any) => string }>
}

function areSectionPropsEqual(
  prev: IsolatedMessagesSectionProps,
  next: IsolatedMessagesSectionProps
): boolean {
  return (
    prev.subChatId === next.subChatId &&
    prev.chatId === next.chatId &&
    prev.isMobile === next.isMobile &&
    prev.sandboxSetupStatus === next.sandboxSetupStatus &&
    prev.stickyTopClass === next.stickyTopClass &&
    prev.sandboxSetupError === next.sandboxSetupError &&
    prev.onRetrySetup === next.onRetrySetup &&
    prev.onRollback === next.onRollback &&
    prev.onFork === next.onFork &&
    prev.UserBubbleComponent === next.UserBubbleComponent &&
    prev.ToolCallComponent === next.ToolCallComponent &&
    prev.MessageGroupWrapper === next.MessageGroupWrapper &&
    prev.toolRegistry === next.toolRegistry
  )
}

export const IsolatedMessagesSection = memo(function IsolatedMessagesSection({
  subChatId,
  chatId,
  isMobile,
  sandboxSetupStatus,
  stickyTopClass,
  sandboxSetupError,
  onRetrySetup,
  onRollback,
  onFork,
  UserBubbleComponent,
  ToolCallComponent,
  MessageGroupWrapper,
  toolRegistry,
}: IsolatedMessagesSectionProps) {
  // Per-subchat selector - split panes render fully independently.
  const userMsgIds = useAtomValue(userMessageIdsPerChatAtom(subChatId))
  const truncationState = useAtomValue(chatTruncationAtomFamily(subChatId))

  // Format character count for display
  const formatSize = (chars: number): string => {
    if (chars < 1000) return `${chars} chars`
    if (chars < 1_000_000) return `${(chars / 1000).toFixed(0)}K chars`
    return `${(chars / 1_000_000).toFixed(1)}M chars`
  }

  return (
    <>
      {/* Show truncation banner when older messages are hidden */}
      {truncationState.isTruncated && (
        <div className="mb-4 mx-4 p-3 bg-muted/50 border border-border rounded-lg flex items-start gap-3 text-sm">
          <AlertCircle className="w-4 h-4 mt-0.5 text-muted-foreground flex-shrink-0" />
          <div className="flex-1 space-y-1">
            <p className="text-muted-foreground">
              <strong>Older messages hidden for performance</strong>
            </p>
            <p className="text-xs text-muted-foreground/80">
              Showing the most recent {truncationState.shownCount} of {truncationState.totalCount} messages
              ({formatSize(truncationState.shownChars)} of {formatSize(truncationState.totalChars)}).
              All messages are still saved in your chat history.
            </p>
          </div>
        </div>
      )}
      {userMsgIds.map((userMsgId) => (
        <IsolatedMessageGroup
          key={userMsgId}
          userMsgId={userMsgId}
          subChatId={subChatId}
          chatId={chatId}
          isMobile={isMobile}
          sandboxSetupStatus={sandboxSetupStatus}
          stickyTopClass={stickyTopClass}
          sandboxSetupError={sandboxSetupError}
          onRetrySetup={onRetrySetup}
          onRollback={onRollback}
          onFork={onFork}
          UserBubbleComponent={UserBubbleComponent}
          ToolCallComponent={ToolCallComponent}
          MessageGroupWrapper={MessageGroupWrapper}
          toolRegistry={toolRegistry}
        />
      ))}
    </>
  )
}, areSectionPropsEqual)
