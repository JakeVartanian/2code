/**
 * Full assessment panel — conversational format.
 * Tells the user what was noticed, why it matters, and offers one clear action.
 * No section headers, no confidence scores, no raw file paths.
 */

import { memo, useCallback, useEffect, useMemo, useState } from "react"
import { useAtom, useSetAtom } from "jotai"
import { motion } from "motion/react"
import {
  ArrowLeft,
  X,
  ChevronDown,
  Loader2,
} from "lucide-react"
import { toast } from "sonner"
import { assessmentPanelSuggestionIdAtom, implementModeAtom } from "./atoms"
import { useAmbientStore, type AmbientSuggestion } from "./store"
import { formatTrigger } from "./lib/format-trigger"
import { trpc } from "../../lib/trpc"
import { useAgentSubChatStore, type SubChatMeta } from "../agents/stores/sub-chat-store"
import { cn } from "../../lib/utils"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../components/ui/dropdown-menu"
import { PlanIcon, AgentIcon } from "../../components/ui/icons"

const CATEGORY_COLORS: Record<string, string> = {
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

  const handleBack = useCallback(() => {
    setSuggestionId(null)
  }, [setSuggestionId])

  // If the suggestion expires/is dismissed while panel is open, close via effect (not during render)
  useEffect(() => {
    if (suggestionId && !suggestions.find(s => s.id === suggestionId)) {
      setSuggestionId(null)
    }
  }, [suggestions, suggestionId, setSuggestionId])

  if (!suggestion) {
    return null
  }

  // Parse trigger files
  let triggerFiles: string[] = []
  try {
    triggerFiles = Array.isArray(suggestion.triggerFiles)
      ? suggestion.triggerFiles
      : typeof suggestion.triggerFiles === "string"
        ? JSON.parse(suggestion.triggerFiles as string)
        : []
  } catch { /* ignore */ }

  // Split description into the consequence text and evidence (evidence is discarded from UI)
  const { mainText } = parseDescription(suggestion.description)

  // Clean up the title — strip imperative prefixes that feel like commands, not observations
  const cleanTitle = suggestion.title
    .replace(/^Remember:\s*/i, "")
    .replace(/^Note:\s*/i, "")
    .replace(/^Warning:\s*/i, "")

  // Primary filename — just the basename, no path
  const primaryFile = triggerFiles[0]?.split("/").pop() ?? null

  // Trigger context phrase — human-readable, from existing formatter
  const triggerPhrase = formatTrigger(suggestion.triggerEvent, triggerFiles)

  // Only show "I'd fix it by" if suggestedPrompt is meaningfully different from description
  const showFixSuggestion = suggestion.suggestedPrompt
    && !isTooSimilar(suggestion.suggestedPrompt, suggestion.description)

  const dotColor = CATEGORY_COLORS[suggestion.category] ?? "bg-slate-400"

  return (
    <motion.div
      initial={{ x: 16, opacity: 0 }}
      animate={{ x: 0, opacity: 1, transition: { duration: 0.18, ease: "easeOut" } }}
      exit={{ x: 16, opacity: 0, transition: { duration: 0.12, ease: "easeIn" } }}
      className="flex flex-col h-full"
      onKeyDown={(e) => { if (e.key === "Escape") handleBack() }}
      tabIndex={-1}
    >
      {/* ── Navigation strip ── */}
      <div className="sticky top-0 z-10 flex items-center justify-between px-3 h-8 border-b border-border/20 bg-background shrink-0">
        <button
          onClick={handleBack}
          autoFocus
          className="flex items-center gap-1.5 text-muted-foreground/60 hover:text-foreground transition-colors text-[11px]"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Suggestions
        </button>
        <AssessmentDismissButton suggestion={suggestion} />
      </div>

      {/* ── Scrollable content ── */}
      <div className="flex-1 overflow-y-auto min-h-0">

        {/* Anchor: category dot + filename + trigger context */}
        <div className="px-3 pt-4 flex items-center gap-1.5">
          <span className={cn("h-2 w-2 rounded-full shrink-0 opacity-70", dotColor)} />
          {primaryFile && (
            <>
              <span className="text-[11px] font-medium text-foreground/55 font-mono">
                {primaryFile}
              </span>
              {triggerPhrase && (
                <span className="text-muted-foreground/25">·</span>
              )}
            </>
          )}
          {triggerPhrase && (
            <span className="text-[11px] text-muted-foreground/45">
              {triggerPhrase}
            </span>
          )}
        </div>

        {/* What I noticed + why it matters */}
        <div className="px-3 pt-3">
          {/* Title — what was observed */}
          <p className="text-[13px] font-semibold text-foreground/90 leading-snug">
            {cleanTitle}
          </p>

          {/* Consequence — why this matters to the user, in plain language */}
          {mainText && (
            <p className="text-[12px] text-foreground/60 leading-relaxed mt-2">
              {mainText}
            </p>
          )}
        </div>

        {/* Fix suggestion — only shown when it adds new info beyond the description */}
        {showFixSuggestion && (
          <div className="mx-3 mt-4 px-3 py-2.5 rounded-lg bg-foreground/[0.03] border border-border/20">
            <p className="text-[10px] text-muted-foreground/40 mb-1.5">
              I'd fix it by
            </p>
            <p className="text-[12px] text-foreground/60 leading-relaxed">
              {suggestion.suggestedPrompt}
            </p>
          </div>
        )}

        {/* Bottom spacer so content doesn't hide under action bar */}
        <div className="h-20" />
      </div>

      {/* ── Sticky action area ── */}
      <div className="sticky bottom-0 z-10 border-t border-border/20 bg-background px-3 pt-3 pb-5 space-y-2.5 shrink-0">
        {/* Primary CTA */}
        <AssessmentImplementButton suggestion={suggestion} chatId={chatId} />

        {/* Escape hatch — not a button shape, just text */}
        <div className="flex justify-center">
          <AssessmentSnoozeButton suggestion={suggestion} />
        </div>
      </div>
    </motion.div>
  )
})

// ── Helpers ──

function parseDescription(description: string): { mainText: string; evidence: string | null } {
  if (!description) return { mainText: "", evidence: null }

  // Strip metadata suffixes that pipeline appends (non-obvious reasoning, evidence)
  let text = description
    .replace(/\n\n_Why non-obvious:.*?_/gs, "")
    .replace(/\n\n_Evidence:.*?_/gs, "")
    .trim()

  // Cap at ~3 sentences to keep it scannable
  const sentences = text.match(/[^.!?]+[.!?]+/g)
  if (sentences && sentences.length > 3) {
    text = sentences.slice(0, 3).join("").trim()
  }

  return { mainText: text, evidence: null }
}

/** Returns true if two strings share >60% of their content — prevents showing the same text twice */
function isTooSimilar(a: string, b: string): boolean {
  if (!a || !b) return false
  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim()
  const na = normalize(a)
  const nb = normalize(b)
  // Check if one contains most of the other
  if (na.length < 20 || nb.length < 20) return na === nb
  const shorter = na.length < nb.length ? na : nb
  const longer = na.length < nb.length ? nb : na
  return longer.includes(shorter.slice(0, Math.floor(shorter.length * 0.6)))
}

// ── Action components ──

function AssessmentImplementButton({
  suggestion,
  chatId,
}: {
  suggestion: AmbientSuggestion
  chatId: string | null
}) {
  const [lastMode, setLastMode] = useAtom(implementModeAtom)
  const setSuggestionId = useSetAtom(assessmentPanelSuggestionIdAtom)
  const [isApproving, setIsApproving] = useState(false)

  const approveMutation = trpc.ambient.approve.useMutation({
    onSuccess: (result) => {
      if (result.success && result.subChatId) {
        const store = useAgentSubChatStore.getState()
        const tabName = suggestion.title.length > 60
          ? suggestion.title.slice(0, 57) + "..."
          : suggestion.title
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
        // Brief delay so the tab opens before the panel exits — prevents flicker
        setTimeout(() => setSuggestionId(null), 150)
      }
      setIsApproving(false)
    },
    onError: () => {
      toast.error("Failed to create tab. Try again.")
      setIsApproving(false)
    },
  })

  const handleImplement = useCallback((mode: "plan" | "agent") => {
    if (!chatId) return
    setLastMode(mode)
    setIsApproving(true)
    approveMutation.mutate({ suggestionId: suggestion.id, chatId, mode })
  }, [chatId, suggestion.id, approveMutation, setLastMode])

  if (!chatId) return null

  const primaryLabel = lastMode === "plan" ? "Plan this out" : "Start working on this"

  return (
    <div className="flex items-stretch rounded-md overflow-hidden">
      {/* Main action button */}
      <button
        onClick={() => handleImplement(lastMode)}
        disabled={isApproving}
        className={cn(
          "flex-1 flex items-center justify-center gap-1.5",
          "text-[12px] font-medium text-white",
          "h-[34px] px-3",
          "bg-violet-600 hover:bg-violet-500",
          "transition-all duration-150 active:scale-[0.98]",
          "disabled:opacity-60 disabled:cursor-not-allowed disabled:active:scale-100",
        )}
      >
        {isApproving ? (
          <>
            <Loader2 className="h-3 w-3 animate-spin" />
            Opening...
          </>
        ) : (
          primaryLabel
        )}
      </button>

      {/* Mode selector chevron — thin divider, same height */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            disabled={isApproving}
            className={cn(
              "flex items-center justify-center",
              "w-8 h-[34px]",
              "bg-violet-600 hover:bg-violet-500",
              "border-l border-violet-700/50",
              "transition-colors duration-150",
              "disabled:opacity-60 disabled:cursor-not-allowed",
            )}
            aria-label="Choose mode"
          >
            <ChevronDown className="h-3.5 w-3.5 text-white/80" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" side="top" className="w-36">
          <DropdownMenuItem onClick={() => handleImplement("agent")}>
            <AgentIcon className="h-3.5 w-3.5 mr-1.5" />
            Agent mode
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => handleImplement("plan")}>
            <PlanIcon className="h-3.5 w-3.5 mr-1.5" />
            Plan mode
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

// "Not now" — snooze, presented as plain text (not a button shape)
function AssessmentSnoozeButton({ suggestion }: { suggestion: AmbientSuggestion }) {
  const setSuggestionId = useSetAtom(assessmentPanelSuggestionIdAtom)
  const snoozeMutation = trpc.ambient.snooze.useMutation({
    onSuccess: () => setSuggestionId(null),
  })

  return (
    <button
      onClick={() => snoozeMutation.mutate({ suggestionId: suggestion.id })}
      disabled={snoozeMutation.isPending}
      className={cn(
        "text-[11px] text-muted-foreground/40 hover:text-muted-foreground/70",
        "transition-colors duration-150",
        "disabled:opacity-40 disabled:cursor-not-allowed",
      )}
    >
      Not now
    </button>
  )
}

// Dismiss — icon in the nav strip, intentional action
function AssessmentDismissButton({ suggestion }: { suggestion: AmbientSuggestion }) {
  const setSuggestionId = useSetAtom(assessmentPanelSuggestionIdAtom)
  const dismissMutation = trpc.ambient.dismiss.useMutation({
    onSuccess: () => setSuggestionId(null),
  })

  return (
    <button
      onClick={() => dismissMutation.mutate({ suggestionId: suggestion.id })}
      disabled={dismissMutation.isPending}
      aria-label="Dismiss suggestion"
      className={cn(
        "flex items-center justify-center w-6 h-6 rounded",
        "text-muted-foreground/40 hover:text-foreground hover:bg-foreground/8",
        "transition-colors duration-150",
        "disabled:opacity-40 disabled:cursor-not-allowed",
      )}
    >
      <X className="h-3.5 w-3.5" />
    </button>
  )
}
