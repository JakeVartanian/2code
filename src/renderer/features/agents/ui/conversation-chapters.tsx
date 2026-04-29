import { memo, useCallback } from "react"
import { motion, AnimatePresence } from "motion/react"
import { ChevronRight, MessageSquare } from "lucide-react"
import { cn } from "../../../lib/utils"
import { appStore } from "../../../lib/jotai-store"
import {
  messageAtomFamily,
  getPerChatMessageKey,
  assistantIdsPerChatAtomFamily,
  type Message,
} from "../stores/message-store"

// ============================================================================
// CONVERSATION CHAPTERS
// ============================================================================
// Auto-segments conversations into collapsible chapters based on:
// 1. Time gaps between messages (>2 min between assistant startedAt timestamps)
// 2. Fallback: every 8 turns if no time gaps detected
//
// Chapter title = first user message text, truncated to 60 chars.
// Chapters are collapsible, with a thin header bar between message groups.
// ============================================================================

export interface Chapter {
  /** Index of this chapter (0-based) */
  index: number
  /** User message IDs in this chapter */
  userMsgIds: string[]
  /** Chapter title derived from first user message */
  title: string
  /** Number of assistant messages across all turns in this chapter */
  assistantCount: number
}

const TIME_GAP_MS = 2 * 60 * 1000 // 2 minutes
const MAX_TURNS_PER_CHAPTER = 8

/**
 * Extract the first line/sentence of user message text for use as chapter title.
 * Returns truncated text (max 60 chars).
 */
function extractChapterTitle(message: Message | null): string {
  if (!message?.parts) return "Untitled"

  const textParts = message.parts.filter((p) => p.type === "text")
  const rawText = textParts.map((p) => p.text || "").join(" ").trim()

  if (!rawText) {
    // Check for image/file attachments
    const hasImages = message.parts.some((p) => p.type === "data-image")
    if (hasImages) return "Image attachment"
    return "Untitled"
  }

  // Take first line
  const firstLine = rawText.split("\n")[0]?.trim() || rawText
  // Strip leading slash commands
  const cleaned = firstLine.replace(/^\/\w+\s*/, "").trim() || firstLine

  if (cleaned.length <= 60) return cleaned
  // Truncate at word boundary
  const truncated = cleaned.slice(0, 57)
  const lastSpace = truncated.lastIndexOf(" ")
  return (lastSpace > 30 ? truncated.slice(0, lastSpace) : truncated) + "..."
}

/**
 * Get the startedAt timestamp from the first assistant message after a user message.
 * Uses appStore.get() to read imperatively without creating subscriptions.
 */
function getAssistantTimestamp(
  subChatId: string,
  userMsgId: string,
): number | null {
  const key = `${subChatId}:${userMsgId}`
  const assistantIds = appStore.get(assistantIdsPerChatAtomFamily(key))
  if (!assistantIds || assistantIds.length === 0) return null

  const firstAssistant = appStore.get(
    messageAtomFamily(getPerChatMessageKey(subChatId, assistantIds[0]!)),
  )
  return (firstAssistant?.metadata as any)?.startedAt ?? null
}

/**
 * Compute chapters from an ordered list of user message IDs.
 * Reads message data imperatively from the Jotai store (no subscriptions).
 */
export function computeChapters(
  subChatId: string,
  userMsgIds: string[],
): Chapter[] {
  if (userMsgIds.length === 0) return []

  // Don't chapter short conversations
  if (userMsgIds.length <= 3) {
    return [
      {
        index: 0,
        userMsgIds,
        title: extractChapterTitle(
          appStore.get(
            messageAtomFamily(
              getPerChatMessageKey(subChatId, userMsgIds[0]!),
            ),
          ),
        ),
        assistantCount: countAssistantMessages(subChatId, userMsgIds),
      },
    ]
  }

  const chapters: Chapter[] = []
  let currentChapter: string[] = [userMsgIds[0]!]
  let lastTimestamp = getAssistantTimestamp(subChatId, userMsgIds[0]!)

  for (let i = 1; i < userMsgIds.length; i++) {
    const userMsgId = userMsgIds[i]!
    const timestamp = getAssistantTimestamp(subChatId, userMsgId)

    let shouldSplit = false

    // Time gap detection
    if (timestamp && lastTimestamp && timestamp - lastTimestamp > TIME_GAP_MS) {
      shouldSplit = true
    }

    // Max turns per chapter
    if (currentChapter.length >= MAX_TURNS_PER_CHAPTER) {
      shouldSplit = true
    }

    if (shouldSplit) {
      // Flush current chapter
      chapters.push({
        index: chapters.length,
        userMsgIds: currentChapter,
        title: extractChapterTitle(
          appStore.get(
            messageAtomFamily(
              getPerChatMessageKey(subChatId, currentChapter[0]!),
            ),
          ),
        ),
        assistantCount: countAssistantMessages(subChatId, currentChapter),
      })
      currentChapter = [userMsgId]
    } else {
      currentChapter.push(userMsgId)
    }

    if (timestamp) lastTimestamp = timestamp
  }

  // Flush last chapter
  if (currentChapter.length > 0) {
    chapters.push({
      index: chapters.length,
      userMsgIds: currentChapter,
      title: extractChapterTitle(
        appStore.get(
          messageAtomFamily(
            getPerChatMessageKey(subChatId, currentChapter[0]!),
          ),
        ),
      ),
      assistantCount: countAssistantMessages(subChatId, currentChapter),
    })
  }

  return chapters
}

function countAssistantMessages(
  subChatId: string,
  userMsgIds: string[],
): number {
  let count = 0
  for (const uid of userMsgIds) {
    const key = `${subChatId}:${uid}`
    const assistantIds = appStore.get(assistantIdsPerChatAtomFamily(key))
    count += assistantIds?.length ?? 0
  }
  return count
}

// ============================================================================
// CHAPTER HEADER COMPONENT
// ============================================================================

interface ChapterHeaderProps {
  chapter: Chapter
  isCollapsed: boolean
  onToggle: () => void
  isFirst: boolean
}

export const ChapterHeader = memo(function ChapterHeader({
  chapter,
  isCollapsed,
  onToggle,
  isFirst,
}: ChapterHeaderProps) {
  const turnCount = chapter.userMsgIds.length

  return (
    <div
      className={cn(
        "group/chapter flex items-center gap-2 px-4 cursor-pointer select-none",
        !isFirst && "mt-2 pt-2 border-t border-border/40",
      )}
      onClick={onToggle}
    >
      {/* Collapse chevron */}
      <motion.div
        animate={{ rotate: isCollapsed ? 0 : 90 }}
        transition={{ duration: 0.15 }}
        className="text-muted-foreground/40 group-hover/chapter:text-muted-foreground/70 transition-colors"
      >
        <ChevronRight className="w-3 h-3" />
      </motion.div>

      {/* Chapter number + title */}
      <span className="text-[10px] font-medium text-muted-foreground/40 uppercase tracking-wider whitespace-nowrap">
        Ch {chapter.index + 1}
      </span>
      <span className="text-[11px] text-muted-foreground/60 truncate group-hover/chapter:text-muted-foreground/80 transition-colors">
        {chapter.title}
      </span>

      {/* Turn count badge */}
      <span className="ml-auto text-[9px] text-muted-foreground/30 whitespace-nowrap flex items-center gap-1">
        <MessageSquare className="w-2.5 h-2.5" />
        {turnCount} {turnCount === 1 ? "turn" : "turns"}
      </span>
    </div>
  )
})

// ============================================================================
// COLLAPSED CHAPTER SUMMARY
// ============================================================================

interface CollapsedChapterProps {
  chapter: Chapter
  onExpand: () => void
}

export const CollapsedChapterSummary = memo(function CollapsedChapterSummary({
  chapter,
  onExpand,
}: CollapsedChapterProps) {
  const turnCount = chapter.userMsgIds.length

  return (
    <motion.div
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: "auto" }}
      exit={{ opacity: 0, height: 0 }}
      transition={{ duration: 0.15 }}
      className="px-4 py-2 cursor-pointer"
      onClick={onExpand}
    >
      <div className="text-[10px] text-muted-foreground/30 italic text-center hover:text-muted-foreground/50 transition-colors">
        {turnCount} {turnCount === 1 ? "message" : "messages"} collapsed
        {" \u2014 "}
        click to expand
      </div>
    </motion.div>
  )
})
