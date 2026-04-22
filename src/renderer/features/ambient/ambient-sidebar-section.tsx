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

import { memo, useCallback } from "react"
import { useAtom, useSetAtom } from "jotai"
import { motion, AnimatePresence } from "motion/react"
import {
  ChevronDown,
  ChevronRight,
  X,
  Zap,
} from "lucide-react"
import { toast } from "sonner"
import {
  ambientPanelExpandedAtom,
  assessmentPanelSuggestionIdAtom,
} from "./atoms"
import { useAmbientStore, type AmbientSuggestion } from "./store"
import { useAmbientData } from "./hooks/use-ambient-data"
import { formatTrigger } from "./lib/format-trigger"
import { trpc } from "../../lib/trpc"
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
  useAmbientData(projectId, projectPath)

  const [expanded, setExpanded] = useAtom(ambientPanelExpandedAtom)
  const { suggestions, agentStatus } = useAmbientStore()

  const toggleMutation = trpc.ambient.toggle.useMutation({
    onSuccess: (_data, variables) => {
      useAmbientStore.getState().setAgentStatus(variables.enabled ? "running" : "stopped")
    },
    onError: () => {
      toast.error("Failed to toggle GAAD")
    },
  })

  const pendingSuggestions = suggestions.filter(s => s.status === "pending")
  const badgeCount = pendingSuggestions.length

  return (
    <div className="px-2 pb-2">
      {/* Section header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
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
            {pendingSuggestions.length === 0 ? (
              <motion.div
                key="watching"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0, scale: 0.95, transition: { duration: 0.15 } }}
                transition={{ duration: 0.2 }}
              >
                <EmptyState agentStatus={agentStatus} />
              </motion.div>
            ) : (
              <motion.div
                key="suggestions"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.18, delay: 0.06 }}
                className="space-y-0.5"
              >
                {pendingSuggestions.map((suggestion) => (
                  <SuggestionCard
                    key={suggestion.id}
                    suggestion={suggestion}
                  />
                ))}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      )}
    </div>
  )
}

// ============ WATCHING EYES ============

/**
 * SVG eyes that communicate GAAD's presence without words.
 * Two almond-shaped sockets with pupils that slowly drift left/right.
 * Blink animation runs via CSS — no JS timers needed.
 */
function WatchingEyes() {
  return (
    <svg
      width="28"
      height="12"
      viewBox="0 0 28 12"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      className="gaad-eyes"
    >
      {/* Left eye socket */}
      <ellipse
        cx="8"
        cy="6"
        rx="7"
        ry="4.5"
        fill="rgba(148,163,184,0.08)"
        stroke="rgba(148,163,184,0.18)"
        strokeWidth="0.5"
        className="gaad-lid gaad-lid-left"
        style={{ transformOrigin: "8px 6px" }}
      />
      {/* Left pupil */}
      <circle
        cx="8"
        cy="6"
        r="2"
        fill="rgba(94,234,212,0.55)"
        className="gaad-pupil gaad-pupil-left"
        style={{ transformOrigin: "8px 6px" }}
      />

      {/* Right eye socket */}
      <ellipse
        cx="20"
        cy="6"
        rx="7"
        ry="4.5"
        fill="rgba(148,163,184,0.08)"
        stroke="rgba(148,163,184,0.18)"
        strokeWidth="0.5"
        className="gaad-lid gaad-lid-right"
        style={{ transformOrigin: "20px 6px" }}
      />
      {/* Right pupil */}
      <circle
        cx="20"
        cy="6"
        r="2"
        fill="rgba(94,234,212,0.55)"
        className="gaad-pupil gaad-pupil-right"
        style={{ transformOrigin: "20px 6px" }}
      />
    </svg>
  )
}

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
  const { activity } = useAmbientStore()

  if (!activity) return "warming up"

  const { sessionsAnalyzedToday, changesReviewedToday, suggestionsToday, lastInsightAt } = activity

  // Priority: last insight time > today's activity > generic
  const ago = timeAgo(lastInsightAt)
  if (ago && suggestionsToday > 0) {
    return `last insight ${ago}`
  }

  const parts: string[] = []
  if (sessionsAnalyzedToday > 0) parts.push(`${sessionsAnalyzedToday} session${sessionsAnalyzedToday > 1 ? "s" : ""} analyzed`)
  if (changesReviewedToday > 0) parts.push(`${changesReviewedToday} change${changesReviewedToday > 1 ? "s" : ""} reviewed`)

  if (parts.length > 0) return parts.join(", ")

  return "watching"
}

// ============ EMPTY STATE ============

function EmptyState({ agentStatus }: { agentStatus: string }) {
  const microStatus = useMicroStatus()

  if (agentStatus === "running") {
    return (
      <div className="px-2 py-3 flex flex-col items-center gap-2">
        <WatchingEyes />
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

// Budget warning removed — GAAD should silently degrade, not whine about it.
