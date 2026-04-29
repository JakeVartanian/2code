/**
 * Ambient sidebar section — GAAD redesign.
 *
 * Design principles:
 * - Max 3 suggestions, each tells a micro-story (category, headline, trigger)
 * - No inline expansion — click opens full assessment panel
 * - No toasts, no severity badges — headline conveys urgency
 * - Empty state: animated eyes, not a sterile status dashboard
 * - "Active" / "Paused" text removed from header — dot IS the status
 * - Suggestion arrival feels like a blessing from above (drop-in + teal shimmer)
 */

import { memo, useCallback, useState, useRef } from "react"
import { useAtom, useAtomValue, useSetAtom } from "jotai"
import { motion, AnimatePresence } from "motion/react"
import {
  Check,
  ChevronDown,
  ChevronRight,
  RefreshCw,
  Send,
  X,
  Zap,
} from "lucide-react"
import { toast } from "sonner"
import {
  ambientPanelExpandedAtom,
  assessmentPanelSuggestionIdAtom,
  gaadOrchestratorGoalAtom,
} from "./atoms"
import { AssessmentPanel } from "./assessment-panel"
import { useAmbientStore, type AmbientSuggestion, type MaintenanceAction } from "./store"
import { useAmbientData } from "./hooks/use-ambient-data"
import { formatTrigger } from "./lib/format-trigger"
import { trpc } from "../../lib/trpc"
import { useAgentSubChatStore } from "../agents/stores/sub-chat-store"
import { cn } from "../../lib/utils"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../../components/ui/tooltip"

const CATEGORY_DOT_COLORS: Record<string, string> = {
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

// ============ MAIN SECTION ============

export function AmbientSidebarSection({
  projectId,
  projectPath,
  chatId,
}: {
  projectId: string | null
  projectPath: string | null
  chatId: string | null
}) {
  const [expanded, setExpanded] = useAtom(ambientPanelExpandedAtom)
  useAmbientData(projectId, projectPath, expanded)
  const assessmentPanelId = useAtomValue(assessmentPanelSuggestionIdAtom)
  const { suggestions, maintenanceActions, agentStatus } = useAmbientStore()

  const toggleMutation = trpc.ambient.toggle.useMutation({
    onSuccess: (_data, variables) => {
      useAmbientStore.getState().setAgentStatus(variables.enabled ? "running" : "stopped")
    },
    onError: () => {
      toast.error("Failed to toggle GAAD")
    },
  })

  const restartMutation = trpc.ambient.restart.useMutation({
    onSuccess: () => {
      useAmbientStore.getState().setAgentStatus("running")
      toast.success("GAAD restarted")
    },
    onError: () => {
      toast.error("Failed to restart GAAD")
    },
  })

  const pendingSuggestions = suggestions.filter(s => s.status === "pending")
  const visibleSuggestions = pendingSuggestions.filter(s => s.id !== assessmentPanelId)
  const allPendingActions = maintenanceActions.filter(a => a.status === "pending")
  const pendingActions = allPendingActions.slice(0, 3) // Show max 3 at a time
  const badgeCount = pendingSuggestions.length + allPendingActions.length

  return (
    <div className="px-2 pb-2">
      {/* Section header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="group flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
      >
        {expanded
          ? <ChevronDown className="h-3 w-3 flex-shrink-0" />
          : <ChevronRight className="h-3 w-3 flex-shrink-0" />
        }
        <Zap className="h-3 w-3 flex-shrink-0" />
        <span className="flex-1 text-left">GAAD</span>

        {/* Badge count — only when there are pending suggestions */}
        {badgeCount > 0 && (
          <span className="h-[18px] min-w-[18px] px-1 rounded-full bg-teal-500/20 text-teal-300 text-[10px] font-semibold flex items-center justify-center">
            {badgeCount}
          </span>
        )}

        {/* Restart button — appears on hover */}
        {projectId && projectPath && agentStatus === "running" && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                role="button"
                onClick={(e) => {
                  e.stopPropagation()
                  restartMutation.mutate({ projectId, projectPath })
                }}
                className="inline-flex items-center justify-center w-5 h-5 rounded-full opacity-0 group-hover:opacity-100 hover:bg-zinc-700/60 transition-all flex-shrink-0"
              >
                <RefreshCw className={cn(
                  "h-2.5 w-2.5 text-muted-foreground",
                  restartMutation.isPending && "animate-spin",
                )} />
              </span>
            </TooltipTrigger>
            <TooltipContent side="right">Restart GAAD</TooltipContent>
          </Tooltip>
        )}

        {/* Status dot — dot-only, text removed. Dot IS the status. */}
        {projectId && projectPath && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                role="button"
                onClick={(e) => {
                  e.stopPropagation()
                  toggleMutation.mutate({
                    projectId,
                    projectPath,
                    enabled: agentStatus !== "running",
                  })
                }}
                className={cn(
                  "inline-flex items-center justify-center w-5 h-5 rounded-full transition-colors flex-shrink-0",
                  agentStatus === "running"
                    ? "hover:bg-teal-500/20"
                    : "hover:bg-zinc-700/60",
                )}
              >
                <span className={cn(
                  "h-1.5 w-1.5 rounded-full flex-shrink-0",
                  agentStatus === "running" ? "bg-teal-400"
                    : agentStatus === "paused" ? "bg-amber-400"
                    : "bg-zinc-600",
                )} />
              </span>
            </TooltipTrigger>
            <TooltipContent side="right">
              {agentStatus === "running" ? "Click to pause GAAD" : "Click to start GAAD"}
            </TooltipContent>
          </Tooltip>
        )}
      </button>

      {/* Expanded content */}
      {expanded && (
        <div className="mt-1 space-y-0.5">
          {/*
            AnimatePresence with mode="wait" sequences the exit of the watching
            state before the suggestion cards enter. The eyes fade + scale out,
            then the cards drop in from above.
          */}
          <AnimatePresence mode="wait">
            {visibleSuggestions.length === 0 && pendingActions.length === 0 && !assessmentPanelId ? (
              <motion.div
                key="watching"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0, scale: 0.95, transition: { duration: 0.15 } }}
                transition={{ duration: 0.2 }}
              >
                <EmptyState agentStatus={agentStatus} projectId={projectId} />
              </motion.div>
            ) : visibleSuggestions.length > 0 ? (
              <motion.div
                key="suggestions"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.18, delay: 0.06 }}
                className="space-y-0.5"
              >
                {visibleSuggestions.map((suggestion) => (
                  <SuggestionCard
                    key={suggestion.id}
                    suggestion={suggestion}
                  />
                ))}
              </motion.div>
            ) : null}
          </AnimatePresence>

          {/* Maintenance action cards — below suggestions */}
          {pendingActions.length > 0 && (
            <div className="space-y-0.5 mt-1">
              <AnimatePresence>
                {pendingActions.map((action) => (
                  <MaintenanceActionCard
                    key={action.id}
                    action={action}
                    projectId={projectId}
                    projectPath={projectPath}
                  />
                ))}
              </AnimatePresence>
            </div>
          )}

          {/* Inline assessment panel — appears below suggestions when one is selected */}
          <AnimatePresence>
            {assessmentPanelId && (
              <motion.div
                key="assessment"
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto", transition: { duration: 0.2, ease: "easeOut" } }}
                exit={{ opacity: 0, height: 0, transition: { duration: 0.12, ease: "easeIn" } }}
                className="overflow-hidden"
              >
                <AssessmentPanel chatId={chatId} />
              </motion.div>
            )}
          </AnimatePresence>

          {/* Ask GAAD — always present when expanded + running */}
          {agentStatus === "running" && projectId && (
            <AskGAADInput projectId={projectId} chatId={chatId} />
          )}
        </div>
      )}
    </div>
  )
}

// ============ WATCHING EYES ============

// ============ MICRO-STATUS ============

/**
 * Formats a relative time label from a timestamp.
 * Returns e.g. "2m ago", "1h ago", "3h ago"
 */
function timeAgo(ts: number | null): string | null {
  if (!ts) return null
  const delta = Date.now() - ts
  if (delta < 60_000) return "just now"
  if (delta < 3600_000) return `${Math.floor(delta / 60_000)}m ago`
  if (delta < 86400_000) return `${Math.floor(delta / 3600_000)}h ago`
  return null // older than a day, not useful
}

/**
 * Builds a rotating micro-status string from GAAD's activity counters.
 * Shows what GAAD has been doing so it feels alive, not dormant.
 */
function useMicroStatus(): string {
  const { activity, budgetStatus } = useAmbientStore()

  if (!activity) return "warming up"

  const { sessionsAnalyzedToday, changesReviewedToday, suggestionsToday } = activity

  // Show budget degradation warning
  if (budgetStatus?.tier === "paused") return "budget exhausted — paused"
  if (budgetStatus?.tier === "tier0-only") return "budget low — limited analysis"

  // Priority: today's activity stats > generic "watching"
  if (changesReviewedToday > 0 || sessionsAnalyzedToday > 0) {
    const parts: string[] = []
    if (changesReviewedToday > 0) parts.push(`${changesReviewedToday} change${changesReviewedToday > 1 ? "s" : ""} reviewed`)
    if (sessionsAnalyzedToday > 0) parts.push(`${sessionsAnalyzedToday} session${sessionsAnalyzedToday > 1 ? "s" : ""} analyzed`)
    if (suggestionsToday > 0) parts.push(`${suggestionsToday} insight${suggestionsToday > 1 ? "s" : ""}`)
    return `watching · ${parts.join(", ")}`
  }

  return "watching"
}

// ============ EMPTY STATE ============

function EmptyState({ agentStatus, projectId }: { agentStatus: string; projectId: string | null }) {
  const microStatus = useMicroStatus()

  if (agentStatus === "running" && projectId) {
    return <BrainHealthBar projectId={projectId} microStatus={microStatus} />
  }

  if (agentStatus === "running") {
    return (
      <div className="px-2 py-2">
        <span className="gaad-watching-label text-[10px] text-muted-foreground/30 tracking-[0.12em]">
          {microStatus}
        </span>
      </div>
    )
  }

  return (
    <div className="px-2 py-2">
      <span className="text-[11px] text-muted-foreground/50">
        {agentStatus === "paused"
          ? "GAAD is paused. Resume to continue monitoring."
          : "Start GAAD to monitor for issues."}
      </span>
    </div>
  )
}

/** Compact brain health bar — replaces the watching eyes when no suggestions are pending */
function BrainHealthBar({ projectId, microStatus }: { projectId: string; microStatus: string }) {
  const { data: coverage } = trpc.ambient.memoryCoverage.useQuery(
    { projectId },
    { staleTime: 60_000, refetchInterval: 120_000 },
  )

  if (!coverage || coverage.totalMemories === 0) {
    return (
      <div className="px-2 py-2">
        <span className="gaad-watching-label text-[10px] text-muted-foreground/30 tracking-[0.12em]">
          {microStatus}
        </span>
      </div>
    )
  }

  const balance = coverage.overallBalance
  const sparse = coverage.sparseCategories

  return (
    <div className="px-2 py-1.5 space-y-0.5">
      <div className="flex items-center gap-1.5">
        <span className="text-[10px] text-muted-foreground/50">Memory</span>
        <div className="flex-1 h-1 rounded-full bg-muted-foreground/10 overflow-hidden">
          <div
            className="h-full rounded-full bg-teal-400/40 transition-all duration-500"
            style={{ width: `${balance}%` }}
          />
        </div>
        <span className="text-[10px] text-muted-foreground/40 tabular-nums">{balance}%</span>
      </div>
      {sparse.length > 0 && (
        <div className="text-[9px] text-muted-foreground/30 truncate">
          sparse: {sparse.slice(0, 3).join(", ")}
        </div>
      )}
    </div>
  )
}

// ============ SUGGESTION CARD (3-line micro-story) ============

const SuggestionCard = memo(function SuggestionCard({
  suggestion,
}: {
  suggestion: AmbientSuggestion
}) {
  const setAssessmentId = useSetAtom(assessmentPanelSuggestionIdAtom)
  const { removeSuggestion } = useAmbientStore()

  const dismissMutation = trpc.ambient.dismiss.useMutation({
    onMutate: () => {
      // Optimistic removal — don't wait for subscription event
      removeSuggestion(suggestion.id)
    },
  })

  // Parse trigger files
  let triggerFiles: string[] = []
  try {
    triggerFiles = Array.isArray(suggestion.triggerFiles)
      ? suggestion.triggerFiles
      : typeof suggestion.triggerFiles === "string"
        ? JSON.parse(suggestion.triggerFiles as string)
        : []
  } catch { /* ignore */ }

  const dotColor = CATEGORY_DOT_COLORS[suggestion.category] ?? "bg-slate-400"
  const triggerText = formatTrigger(suggestion.triggerEvent, triggerFiles)

  const handleClick = useCallback(() => {
    setAssessmentId(suggestion.id)
  }, [suggestion.id, setAssessmentId])

  const handleDismiss = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    dismissMutation.mutate({ suggestionId: suggestion.id })
  }, [suggestion.id, dismissMutation])

  return (
    /*
      Drop-in from above: y starts at -8px, settles to 0.
      Custom cubic easing [0.22, 1, 0.36, 1] — spring-like without actual spring physics.
      Feels deliberate, not bouncy.
    */
    <motion.div
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -4, transition: { duration: 0.16 } }}
      transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
    >
      <div
        onClick={handleClick}
        /*
          gaad-arrival-shimmer runs once on mount: a teal ring blooms on the
          card border as it lands, then dissolves. Defined in agents-styles.css.
        */
        className="relative rounded-md border border-transparent hover:border-border/40 hover:bg-muted/30 px-2.5 py-2 cursor-pointer group transition-colors gaad-arrival-shimmer"
      >
        {/* Dismiss button (hover reveal) */}
        <button
          onClick={handleDismiss}
          className="absolute top-1.5 right-1.5 p-2 -m-2 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity"
          aria-label={`Dismiss ${suggestion.title}`}
        >
          <X className="h-3.5 w-3.5 text-muted-foreground" />
        </button>

        {/* Category dot — color only, no label text */}
        <div className="flex items-start gap-2 mb-0">
          <span className={cn(
            "h-1.5 w-1.5 rounded-full shrink-0 opacity-60 group-hover:opacity-90 transition-opacity mt-[5px]",
            dotColor,
          )} />
          <div className="flex-1 min-w-0">
            {/* Headline */}
            <p className="text-[12px] font-medium text-foreground/80 leading-snug line-clamp-2">
              {suggestion.title}
            </p>

            {/* Trigger context — plain text, no icon */}
            {triggerText && (
              <p className="text-[10px] text-muted-foreground/45 mt-[3px]">{triggerText}</p>
            )}
          </div>
        </div>
      </div>
    </motion.div>
  )
})

// ============ MAINTENANCE ACTION CARD ============

const MAINTENANCE_TYPE_LABELS: Record<string, string> = {
  "refresh-system-map": "System map",
  "update-memory": "Memory add",
  "run-zone-audit": "Zone audit",
  "refresh-docs": "Docs",
  "archive-stale-memory": "Archive memory",
}

const MaintenanceActionCard = memo(function MaintenanceActionCard({
  action,
  projectId,
  projectPath,
}: {
  action: MaintenanceAction
  projectId: string | null
  projectPath: string | null
}) {
  const { removeMaintenanceAction } = useAmbientStore()
  const [expanded, setExpanded] = useState(false)

  const approveMutation = trpc.ambient.approveMaintenanceAction.useMutation({
    onMutate: () => {
      removeMaintenanceAction(action.id)
    },
    onError: () => {
      toast.error("Failed to execute action")
    },
  })

  const denyMutation = trpc.ambient.denyMaintenanceAction.useMutation({
    onMutate: () => {
      removeMaintenanceAction(action.id)
    },
  })

  const handleApprove = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    if (!projectId || !projectPath) return
    approveMutation.mutate({
      actionId: action.id,
      projectId,
      projectPath,
    })
  }, [action.id, projectId, projectPath, approveMutation])

  const handleDeny = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    if (!projectId) return
    denyMutation.mutate({
      actionId: action.id,
      projectId,
    })
  }, [action.id, projectId, denyMutation])

  const typeLabel = MAINTENANCE_TYPE_LABELS[action.type] ?? action.type

  // Strip "GAAD wants to remember: " prefix from memory actions — the type label already says it
  const displayTitle = action.type === "update-memory"
    ? action.title.replace(/^GAAD wants to remember:\s*/i, "")
    : action.title

  // For memory actions, show the description as expandable detail
  const hasDetail = action.description && action.description.length > 0

  return (
    <motion.div
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -4, transition: { duration: 0.14 } }}
      transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
    >
      <div
        className="rounded-md border border-border/20 bg-muted/15 px-2.5 py-2 group cursor-pointer hover:border-border/40 transition-colors"
        onClick={() => setExpanded(prev => !prev)}
      >
        <div className="flex-1 min-w-0">
          {/* Type label as compact badge */}
          <span className="text-[9px] text-muted-foreground/50 uppercase tracking-wider">
            {typeLabel}
          </span>
          {/* Title — show more text, expand on click */}
          <p className={cn(
            "text-[12px] font-medium text-foreground/70 leading-snug mt-0.5",
            !expanded && "line-clamp-2",
          )}>
            {displayTitle}
          </p>
          {/* Expandable detail */}
          {expanded && hasDetail && (
            <p className="text-[11px] text-foreground/50 leading-relaxed mt-1.5 whitespace-pre-wrap">
              {action.description}
            </p>
          )}
          {/* Show memory category when expanded */}
          {expanded && action.type === "update-memory" && (() => {
            try {
              const details = action.details ? JSON.parse(action.details) : null
              const cat = details?.category
              return cat ? (
                <p className="text-[9px] text-muted-foreground/40 mt-1.5">
                  Saves to: <span className="text-muted-foreground/60">{cat}</span>
                </p>
              ) : null
            } catch { return null }
          })()}
        </div>
        {/* Approve / Deny buttons */}
        <div className="flex items-center gap-1.5 mt-1.5">
          <button
            onClick={handleApprove}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium text-teal-300 bg-teal-500/10 hover:bg-teal-500/20 transition-colors"
          >
            <Check className="h-2.5 w-2.5" />
            Approve
          </button>
          <button
            onClick={handleDeny}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground/50 hover:text-muted-foreground/80 hover:bg-muted/30 transition-colors"
          >
            <X className="h-2.5 w-2.5" />
            Deny
          </button>
        </div>
      </div>
    </motion.div>
  )
})

// ============ ASK GAAD ============

function AskGAADInput({ projectId, chatId }: { projectId: string; chatId: string | null }) {
  const [question, setQuestion] = useState("")
  const [answer, setAnswer] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pinnedRef = useRef(false)
  const [pinned, setPinned] = useState(false)
  const setOrchestratorGoal = useSetAtom(gaadOrchestratorGoalAtom)

  // Keep ref in sync so the timer callback sees current value
  pinnedRef.current = pinned

  const startDismissTimer = useCallback(() => {
    if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current)
    dismissTimerRef.current = setTimeout(() => {
      if (!pinnedRef.current) setAnswer(null)
    }, 60_000)
  }, [])

  const navigateToOrchestrator = useCallback((goal: string) => {
    // Set the goal atom so OrchestratorView picks it up
    setOrchestratorGoal(goal)
    // Navigate to the orchestrator tab
    const store = useAgentSubChatStore.getState()
    const orchTab = store.allSubChats.find((sc: { mode?: string }) => sc.mode === "orchestrator")
    if (orchTab) {
      store.setActiveSubChat(orchTab.id)
    }
  }, [setOrchestratorGoal])

  const askMutation = trpc.ambient.askGAAD.useMutation({
    onSuccess: (data) => {
      const text = data.answer || ""
      // Check if GAAD classified this as a planning request
      if (text.startsWith("[PLAN_REQUEST]")) {
        const goal = text.replace("[PLAN_REQUEST]", "").trim()
        if (goal && chatId) {
          navigateToOrchestrator(goal)
          setAnswer("Loaded into your Orchestrator tab — head there to review and launch the plan.")
          setQuestion("")
          if (textareaRef.current) textareaRef.current.style.height = "auto"
          startDismissTimer()
          return
        }
      }
      setAnswer(text || "GAAD didn't have enough context to answer. Try asking something about your project.")
      setQuestion("")
      if (textareaRef.current) textareaRef.current.style.height = "auto"
      startDismissTimer()
    },
    onError: (err) => {
      console.error("[AskGAAD] Mutation error:", err)
      setAnswer(`Something went wrong: ${err.message}`)
      startDismissTimer()
    },
  })

  const handleSubmit = useCallback(() => {
    const trimmed = question.trim()
    if (!trimmed || askMutation.isPending) return
    setAnswer(null)
    setPinned(false)
    if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current)
    askMutation.mutate({ projectId, question: trimmed })
  }, [question, askMutation, projectId])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      handleSubmit()
    }
  }, [handleSubmit])

  // Auto-resize textarea
  const handleInput = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setQuestion(e.target.value)
    const el = e.target
    el.style.height = "auto"
    el.style.height = Math.min(el.scrollHeight, 120) + "px" // Max ~6 lines
  }, [])

  const handleDismissAnswer = useCallback(() => {
    setAnswer(null)
    setPinned(false)
    if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current)
  }, [])

  const handleTogglePin = useCallback(() => {
    setPinned(prev => {
      const next = !prev
      if (next && dismissTimerRef.current) {
        clearTimeout(dismissTimerRef.current)
      }
      return next
    })
  }, [])

  return (
    <div className="mt-2 px-0.5">
      {/* Input container — textarea with send button inside */}
      <div className="relative rounded-md border border-border/30 bg-muted/20 focus-within:border-teal-500/40 focus-within:ring-1 focus-within:ring-teal-500/20 transition-colors">
        <textarea
          ref={textareaRef}
          value={question}
          onChange={handleInput}
          onKeyDown={handleKeyDown}
          placeholder="Ask GAAD..."
          disabled={askMutation.isPending}
          rows={1}
          className="block w-full resize-none bg-transparent px-2.5 py-2 pr-9 text-[11px] text-foreground placeholder:text-muted-foreground/30 focus:outline-none disabled:opacity-50 leading-relaxed"
          style={{ minHeight: "34px", maxHeight: "120px" }}
        />
        <button
          onClick={handleSubmit}
          disabled={!question.trim() || askMutation.isPending}
          className="absolute right-1.5 bottom-1.5 flex items-center justify-center h-[22px] w-[22px] rounded text-teal-400 hover:bg-teal-500/15 disabled:opacity-20 disabled:hover:bg-transparent transition-colors"
        >
          <Send className="h-3 w-3" />
        </button>
      </div>

      {/* Loading state */}
      {askMutation.isPending && (
        <div className="flex items-center gap-2 mt-2 px-1 py-1.5">
          <div className="flex items-center gap-1">
            <span className="h-1.5 w-1.5 rounded-full bg-teal-400 animate-pulse" />
            <span className="h-1.5 w-1.5 rounded-full bg-teal-400/60 animate-pulse" style={{ animationDelay: "0.15s" }} />
            <span className="h-1.5 w-1.5 rounded-full bg-teal-400/30 animate-pulse" style={{ animationDelay: "0.3s" }} />
          </div>
          <span className="text-[11px] text-teal-400/70">GAAD is thinking...</span>
        </div>
      )}

      {/* Answer bubble */}
      <AnimatePresence>
        {answer != null && answer.length > 0 && (
          <motion.div
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4, transition: { duration: 0.12 } }}
            transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
            className="mt-1.5 rounded-md border border-teal-500/15 bg-teal-500/5 px-2.5 py-2"
          >
            <div className="max-h-[300px] overflow-y-auto">
              <p className="text-[11px] text-foreground/75 leading-relaxed whitespace-pre-wrap break-words">
                {answer}
              </p>
            </div>
            <div className="flex items-center gap-1 mt-1.5 pt-1 border-t border-teal-500/10">
              <button
                onClick={handleTogglePin}
                className={cn(
                  "text-[9px] px-1.5 py-0.5 rounded transition-colors",
                  pinned
                    ? "text-teal-300 bg-teal-500/15"
                    : "text-muted-foreground/40 hover:text-muted-foreground/60",
                )}
              >
                {pinned ? "pinned" : "pin"}
              </button>
              <button
                onClick={handleDismissAnswer}
                className="text-[9px] text-muted-foreground/40 hover:text-muted-foreground/60 px-1.5 py-0.5 rounded transition-colors"
              >
                dismiss
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

// Budget warning removed — GAAD should silently degrade, not whine about it.
