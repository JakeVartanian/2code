/**
 * Assessment panel — compact centered prompt.
 * One finding, one question, yes or no or custom. Then it's gone.
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useAtom, useSetAtom } from "jotai"
import { motion, AnimatePresence } from "motion/react"
import { ChevronRight, Loader2, Send } from "lucide-react"
import { toast } from "sonner"
import { assessmentPanelSuggestionIdAtom, implementModeAtom } from "./atoms"
import { useAmbientStore, type AmbientSuggestion } from "./store"
import { trpc } from "../../lib/trpc"
import { useAgentSubChatStore, type SubChatMeta } from "../agents/stores/sub-chat-store"
import { useMessageQueueStore } from "../agents/stores/message-queue-store"
import { createQueueItem, generateQueueId } from "../agents/lib/queue-utils"
import { cn } from "../../lib/utils"

const CATEGORY_DOT: Record<string, string> = {
  bug: "bg-rose-400",
  security: "bg-amber-400",
  performance: "bg-blue-400",
  "test-gap": "bg-violet-400",
  "dead-code": "bg-slate-400",
  dependency: "bg-emerald-400",
  "blind-spot": "bg-indigo-400",
  "next-step": "bg-teal-400",
  risk: "bg-orange-400",
  memory: "bg-cyan-400",
  design: "bg-yellow-400",
}

export const AssessmentPanel = memo(function AssessmentPanel({
  chatId,
}: {
  chatId: string | null
}) {
  const [suggestionId, setSuggestionId] = useAtom(assessmentPanelSuggestionIdAtom)
  const { suggestions } = useAmbientStore()

  const suggestion = useMemo(
    () => suggestions.find(s => s.id === suggestionId),
    [suggestions, suggestionId],
  )

  useEffect(() => {
    if (suggestionId && !suggestions.find(s => s.id === suggestionId)) {
      setSuggestionId(null)
    }
  }, [suggestions, suggestionId, setSuggestionId])

  if (!suggestion) return null

  const title = cleanTitle(suggestion.title)
  const prompt = suggestion.suggestedPrompt ? cleanPrompt(suggestion.suggestedPrompt) : null
  const dotColor = CATEGORY_DOT[suggestion.category] ?? "bg-slate-400"

  return (
    <div
      className="pt-1.5"
      onKeyDown={(e) => { if (e.key === "Escape") setSuggestionId(null) }}
      tabIndex={-1}
    >
      <div className="w-full rounded-xl border border-border/20 bg-muted/30 backdrop-blur-sm overflow-hidden">
        <div className="px-4 pt-4 pb-3 space-y-2.5">
          {/* Category */}
          <div className="flex items-center gap-1.5">
            <span className={cn("h-1.5 w-1.5 rounded-full", dotColor)} />
            <span className="text-[10px] text-muted-foreground/40 font-mono uppercase tracking-wider">
              {suggestion.category}
            </span>
          </div>

          {/* Title */}
          <p className="text-[13px] font-medium text-foreground/90 leading-snug">
            {title}
          </p>

          {/* Solution toggle */}
          {prompt && <ExpandablePrompt fullPrompt={prompt} />}
        </div>

        {/* Divider */}
        <div className="mx-4 border-t border-border/10" />

        {/* Actions */}
        <div className="px-4 py-4">
          <PromptActions suggestion={suggestion} chatId={chatId} />
        </div>
      </div>
    </div>
  )
})

// ── Expandable solution ──

function ExpandablePrompt({ fullPrompt }: { fullPrompt: string }) {
  const [expanded, setExpanded] = useState(false)

  return (
    <div>
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1.5 py-1.5 group"
      >
        <ChevronRight
          className={cn(
            "h-3.5 w-3.5 text-foreground/30 shrink-0 transition-transform duration-150",
            expanded && "rotate-90",
          )}
        />
        <span className="text-[11px] text-foreground/45 font-mono group-hover:text-foreground/60 transition-colors">
          view solution
        </span>
      </button>
      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1, transition: { duration: 0.15, ease: "easeOut" } }}
            exit={{ height: 0, opacity: 0, transition: { duration: 0.1, ease: "easeIn" } }}
            className="overflow-hidden"
          >
            <p className="text-[11px] text-foreground/60 leading-relaxed font-mono pt-1.5 pb-1">
              {fullPrompt}
            </p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

// ── Text cleanup ──

function cleanTitle(title: string): string {
  return title
    .replace(/^(Remember|Note|Warning|Important):\s*/i, "")
    .trim()
}

function cleanPrompt(text: string): string {
  return text
    .replace(/^Before continuing[^.]*\.\s*/i, "")
    .replace(/Confirm the test environment\.\s*/i, "")
    .replace(/\s{2,}/g, " ")
    .trim()
}

// ── Tab naming ──

function shortTabName(title: string, category: string): string {
  const prefix = category === "bug" ? "Fix: "
    : category === "security" ? "Sec: "
    : category === "performance" ? "Perf: "
    : category === "test-gap" ? "Test: "
    : category === "dead-code" ? "Clean: "
    : category === "dependency" ? "Dep: "
    : category === "blind-spot" ? "Check: "
    : category === "next-step" ? "Next: "
    : category === "risk" ? "Risk: "
    : category === "design" ? "Design: "
    : ""

  const cleaned = title
    .replace(/^(Remember|Note|Warning|Important):\s*/i, "")
    .replace(/\s*[-—–]\s*.+$/, "")
  const maxBody = 30 - prefix.length
  if (cleaned.length <= maxBody) return prefix + cleaned
  return prefix + cleaned.slice(0, maxBody - 1).trimEnd() + "…"
}

// ── Actions ──

function PromptActions({
  suggestion,
  chatId,
}: {
  suggestion: AmbientSuggestion
  chatId: string | null
}) {
  const [lastMode] = useAtom(implementModeAtom)
  const setSuggestionId = useSetAtom(assessmentPanelSuggestionIdAtom)
  const [isApproving, setIsApproving] = useState(false)
  const [showCustom, setShowCustom] = useState(false)
  const [customMessage, setCustomMessage] = useState("")
  const inputRef = useRef<HTMLTextAreaElement>(null)

  const approveMutation = trpc.ambient.approve.useMutation({
    onSuccess: (result) => {
      if (result.success && result.subChatId) {
        const store = useAgentSubChatStore.getState()
        const tabName = shortTabName(suggestion.title, suggestion.category)
        const newMeta: SubChatMeta = {
          id: result.subChatId,
          name: tabName,
          mode: lastMode,
          created_at: new Date().toISOString(),
        }
        store.addToAllSubChats(newMeta)
        if (!store.openSubChatIds.includes(result.subChatId)) {
          store.addToOpenSubChats(result.subChatId)
        }
        store.setActiveSubChat(result.subChatId)

        // Queue the prompt so it actually gets sent to Claude
        const promptText = suggestion.suggestedPrompt || suggestion.description || suggestion.title
        const fullMessage = customMessage.trim()
          ? `${promptText}\n\nAdditional context: ${customMessage.trim()}`
          : promptText
        const queueItem = createQueueItem(generateQueueId(), fullMessage)
        useMessageQueueStore.getState().addToQueue(result.subChatId, queueItem)

        advanceToNext(suggestion.id, setSuggestionId)
      }
      setIsApproving(false)
    },
    onError: () => {
      toast.error("Failed to create tab. Try again.")
      setIsApproving(false)
    },
  })

  const dismissMutation = trpc.ambient.dismiss.useMutation({
    onSuccess: () => {
      advanceToNext(suggestion.id, setSuggestionId)
    },
  })

  const handleApprove = useCallback(() => {
    if (!chatId) return
    setIsApproving(true)
    approveMutation.mutate({ suggestionId: suggestion.id, chatId, mode: lastMode })
  }, [chatId, suggestion.id, approveMutation, lastMode])

  const handleNo = useCallback(() => {
    dismissMutation.mutate({ suggestionId: suggestion.id })
  }, [suggestion.id, dismissMutation])

  const handleCustomToggle = useCallback(() => {
    setShowCustom(prev => {
      if (!prev) setTimeout(() => inputRef.current?.focus(), 50)
      return !prev
    })
  }, [])

  const handleCustomSend = useCallback(() => {
    if (!customMessage.trim()) return
    handleApprove()
  }, [customMessage, handleApprove])

  return (
    <div className="space-y-2.5">
      {/* Main buttons */}
      <div className="flex gap-2">
        <button
          onClick={handleApprove}
          disabled={isApproving || !chatId}
          className={cn(
            "flex-1 h-8 rounded-lg text-[11px] font-medium",
            "bg-violet-600 hover:bg-violet-500 text-white",
            "transition-all duration-150 active:scale-[0.97]",
            "disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100",
            "flex items-center justify-center gap-1.5",
          )}
        >
          {isApproving && !showCustom ? (
            <>
              <Loader2 className="h-3 w-3 animate-spin" />
              Opening...
            </>
          ) : (
            "Yes"
          )}
        </button>
        <button
          onClick={handleNo}
          disabled={dismissMutation.isPending}
          className={cn(
            "flex-1 h-8 rounded-lg text-[11px] font-medium font-mono",
            "text-foreground/40 hover:text-foreground/60",
            "bg-foreground/[0.04] hover:bg-foreground/[0.08]",
            "border border-border/10",
            "transition-all duration-150 active:scale-[0.97]",
            "disabled:opacity-50 disabled:cursor-not-allowed",
          )}
        >
          No
        </button>
      </div>

      {/* Custom message toggle */}
      <button
        onClick={handleCustomToggle}
        className={cn(
          "w-full h-7 rounded-lg text-[10px] font-mono",
          "text-foreground/30 hover:text-foreground/50",
          "hover:bg-foreground/[0.04]",
          "transition-colors duration-150",
          showCustom && "text-foreground/50 bg-foreground/[0.04]",
        )}
      >
        custom message
      </button>

      {/* Custom message input */}
      <AnimatePresence>
        {showCustom && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1, transition: { duration: 0.15, ease: "easeOut" } }}
            exit={{ height: 0, opacity: 0, transition: { duration: 0.1, ease: "easeIn" } }}
            className="overflow-hidden"
          >
            <div className="flex gap-1.5">
              <textarea
                ref={inputRef}
                value={customMessage}
                onChange={(e) => setCustomMessage(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault()
                    handleCustomSend()
                  }
                }}
                placeholder="Add context for the fix..."
                rows={2}
                className={cn(
                  "flex-1 resize-none rounded-lg px-2.5 py-2",
                  "text-[11px] font-mono text-foreground/70 placeholder:text-foreground/20",
                  "bg-foreground/[0.03] border border-border/15",
                  "focus:outline-none focus:border-violet-500/30",
                  "transition-colors duration-150",
                )}
              />
              <button
                onClick={handleCustomSend}
                disabled={!customMessage.trim() || isApproving || !chatId}
                className={cn(
                  "self-end h-8 w-8 rounded-lg shrink-0",
                  "bg-violet-600 hover:bg-violet-500 text-white",
                  "flex items-center justify-center",
                  "transition-all duration-150 active:scale-[0.95]",
                  "disabled:opacity-30 disabled:cursor-not-allowed disabled:active:scale-100",
                )}
              >
                {isApproving ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Send className="h-3 w-3" />
                )}
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

// ── Advance to next pending suggestion or close panel ──

function advanceToNext(
  currentId: string,
  setSuggestionId: (id: string | null) => void,
) {
  setTimeout(() => {
    const { suggestions } = useAmbientStore.getState()
    const next = suggestions.find(s => s.id !== currentId && s.status === "pending")
    setSuggestionId(next?.id ?? null)
  }, 150)
}
