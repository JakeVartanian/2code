import { memo, useCallback, useMemo, useState } from "react"
import { useAtomValue } from "jotai"
import { AnimatePresence } from "motion/react"
import { userMessageIdsPerChatAtom, chatTruncationAtomFamily } from "../stores/message-store"
import { IsolatedMessageGroup } from "./isolated-message-group"
import { AlertCircle } from "lucide-react"
import {
  computeChapters,
  ChapterHeader,
  CollapsedChapterSummary,
} from "../ui/conversation-chapters"

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

  // Compute chapters from user message IDs.
  // Recomputes only when userMsgIds array changes (new turn added).
  // Uses appStore.get() internally — no additional atom subscriptions.
  const chapters = useMemo(
    () => computeChapters(subChatId, userMsgIds),
    [subChatId, userMsgIds],
  )

  // Track which chapters are collapsed (by chapter index)
  const [collapsedChapters, setCollapsedChapters] = useState<Set<number>>(
    () => new Set(),
  )

  const toggleChapter = useCallback((chapterIndex: number) => {
    setCollapsedChapters((prev) => {
      const next = new Set(prev)
      if (next.has(chapterIndex)) {
        next.delete(chapterIndex)
      } else {
        next.add(chapterIndex)
      }
      return next
    })
  }, [])

  // Only show chapters when there are multiple (single chapter = no headers needed)
  const showChapters = chapters.length > 1

  // Build a lookup: userMsgId → chapter index for quick access
  const userMsgChapterMap = useMemo(() => {
    if (!showChapters) return null
    const map = new Map<string, number>()
    for (const chapter of chapters) {
      for (const uid of chapter.userMsgIds) {
        map.set(uid, chapter.index)
      }
    }
    return map
  }, [chapters, showChapters])

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

      {showChapters
        ? chapters.map((chapter) => {
            const isCollapsed = collapsedChapters.has(chapter.index)
            return (
              <div key={`chapter-${chapter.index}`}>
                <ChapterHeader
                  chapter={chapter}
                  isCollapsed={isCollapsed}
                  onToggle={() => toggleChapter(chapter.index)}
                  isFirst={chapter.index === 0}
                />
                <AnimatePresence initial={false}>
                  {isCollapsed ? (
                    <CollapsedChapterSummary
                      key="collapsed"
                      chapter={chapter}
                      onExpand={() => toggleChapter(chapter.index)}
                    />
                  ) : (
                    chapter.userMsgIds.map((userMsgId) => (
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
                    ))
                  )}
                </AnimatePresence>
              </div>
            )
          })
        : userMsgIds.map((userMsgId) => (
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
