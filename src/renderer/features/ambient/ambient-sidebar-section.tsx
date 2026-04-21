/**
 * Ambient sidebar section — suggestion list with expandable detail cards,
 * implement/snooze/dismiss actions, badge count, and history view.
 *
 * Design principles:
 * - Surface actionable info only; hide internal metrics
 * - Budget/injection shown only when degraded or heavy
 * - Status pill replaces separate power icon + dot
 * - Empty state explains what to expect, not just "nothing"
 */

import { memo, useCallback, useMemo, useState } from "react"
import { useAtom, useSetAtom } from "jotai"
import {
  ChevronDown,
  ChevronRight,
  X,
  Zap,
  ShieldAlert,
  Bug,
  Gauge,
  FlaskConical,
  Trash2,
  Package,
  Play,
  Clock,
  Check,
  Loader2,
  FileCode,
  History,
  Brain,
  AlertTriangle,
} from "lucide-react"
import { toast } from "sonner"
import {
  ambientPanelExpandedAtom,
  expandedSuggestionIdAtom,
  implementModeAtom,
  suggestionHistoryExpandedAtom,
} from "./atoms"
import { useAmbientStore, type AmbientSuggestion } from "./store"
import { useAmbientData } from "./hooks/use-ambient-data"
import { trpc } from "../../lib/trpc"
import { useAgentSubChatStore, type SubChatMeta } from "../agents/stores/sub-chat-store"
import { cn } from "../../lib/utils"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../../components/ui/tooltip"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../components/ui/dropdown-menu"
import { PlanIcon, AgentIcon } from "../../components/ui/icons"

const MAX_VISIBLE = 3

const CATEGORY_ICONS: Record<string, typeof Bug> = {
  bug: Bug,
  security: ShieldAlert,
  performance: Gauge,
  "test-gap": FlaskConical,
  "dead-code": Trash2,
  dependency: Package,
}

const SEVERITY_COLORS: Record<string, string> = {
  error: "text-rose-400",
  warning: "text-amber-400",
  info: "text-slate-400",
}

const SEVERITY_BG: Record<string, string> = {
  error: "bg-rose-500/15 text-rose-400",
  warning: "bg-amber-500/15 text-amber-400",
  info: "bg-slate-500/15 text-slate-400",
}

const CATEGORY_COLORS: Record<string, string> = {
  bug: "text-rose-400",
  security: "text-amber-400",
  performance: "text-blue-400",
  "test-gap": "text-violet-400",
  "dead-code": "text-slate-400",
  dependency: "text-emerald-400",
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
  const { suggestions, agentStatus, budgetStatus } = useAmbientStore()
  const [showHistory, setShowHistory] = useAtom(suggestionHistoryExpandedAtom)

  const toggleMutation = trpc.ambient.toggle.useMutation({
    onSuccess: (_data, variables) => {
      useAmbientStore.getState().setAgentStatus(variables.enabled ? "running" : "stopped")
    },
    onError: () => {
      toast.error("Failed to toggle GAAD")
    },
  })

  const { data: brainStatus } = trpc.ambient.getBrainStatus.useQuery(
    { projectId: projectId! },
    { enabled: !!projectId, refetchInterval: 60_000 },
  )

  const pendingSuggestions = suggestions.filter(s => s.status === "pending")
  const visibleSuggestions = pendingSuggestions.slice(0, MAX_VISIBLE)
  const moreCount = Math.max(0, pendingSuggestions.length - MAX_VISIBLE)
  const [showAll, setShowAll] = useState(false)
  const displaySuggestions = showAll ? pendingSuggestions : visibleSuggestions

  const badgeCount = pendingSuggestions.length
  const hasBrain = (brainStatus?.memoryCount ?? 0) > 0
  const isFirstRun = agentStatus !== "running" && !hasBrain

  return (
    <div className="px-2 pb-2">
      {/* Section header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
      >
        {expanded ? <ChevronDown className="h-3 w-3 flex-shrink-0" /> : <ChevronRight className="h-3 w-3 flex-shrink-0" />}
        <Zap className="h-3 w-3 flex-shrink-0" />
        <span className="flex-1 text-left">GAAD</span>

        {/* Badge count */}
        {badgeCount > 0 && (
          <span className="h-[18px] min-w-[18px] px-1 rounded-full bg-teal-500/20 text-teal-300 text-[10px] font-semibold flex items-center justify-center">
            {badgeCount}
          </span>
        )}

        {/* Status pill — merged toggle + status indicator */}
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
                  "inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full transition-colors font-medium",
                  agentStatus === "running"
                    ? "bg-teal-500/15 text-teal-400 hover:bg-teal-500/25"
                    : "bg-zinc-700/40 text-muted-foreground/50 hover:bg-zinc-700/60 hover:text-muted-foreground",
                )}
              >
                <span className={cn(
                  "h-1.5 w-1.5 rounded-full flex-shrink-0",
                  agentStatus === "running" ? "bg-teal-400"
                    : agentStatus === "paused" ? "bg-amber-400"
                    : "bg-zinc-500",
                )} />
                {agentStatus === "running" ? "Active" : agentStatus === "paused" ? "Paused" : "Off"}
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
          {/* Budget warning — only when degraded */}
          <BudgetWarning budgetStatus={budgetStatus} />

          {/* Onboarding state — no brain, agent not running */}
          {isFirstRun && (
            <OnboardingCTA projectId={projectId} projectPath={projectPath} />
          )}

          {/* Empty state when agent is running but no suggestions */}
          {!isFirstRun && displaySuggestions.length === 0 && !showHistory && (
            <p className="px-2 py-1.5 text-[11px] text-muted-foreground/50">
              {agentStatus === "running"
                ? "No findings yet \u2014 will notify when something comes up."
                : "Start the agent to monitor for issues."}
            </p>
          )}

          {/* Suggestions */}
          {displaySuggestions.map((suggestion) => (
            <SuggestionCard
              key={suggestion.id}
              suggestion={suggestion}
              chatId={chatId}
            />
          ))}
          {!showAll && moreCount > 0 && (
            <button
              onClick={() => setShowAll(true)}
              className="w-full px-2 py-0.5 text-[10px] text-muted-foreground/60 hover:text-muted-foreground text-center transition-colors"
            >
              +{moreCount} more
            </button>
          )}
          {showAll && pendingSuggestions.length > MAX_VISIBLE && (
            <button
              onClick={() => setShowAll(false)}
              className="w-full px-2 py-0.5 text-[10px] text-muted-foreground/60 hover:text-muted-foreground text-center transition-colors"
            >
              Show less
            </button>
          )}

          {/* History link */}
          <SuggestionHistory projectId={projectId} showHistory={showHistory} setShowHistory={setShowHistory} />

          {/* Project index details — collapsed by default, only when brain exists */}
          {hasBrain && (
            <ProjectIndexDetails
              projectId={projectId}
              projectPath={projectPath}
              brainStatus={brainStatus}
            />
          )}
        </div>
      )}
    </div>
  )
}

// ============ BUDGET WARNING (only when degraded) ============

function BudgetWarning({ budgetStatus }: { budgetStatus: ReturnType<typeof useAmbientStore>["budgetStatus"] }) {
  if (!budgetStatus || budgetStatus.tier === "normal") return null

  return (
    <div className={cn(
      "mx-1 mb-1 px-2 py-1.5 rounded-md text-[11px] flex items-center gap-1.5",
      budgetStatus.tier === "paused"
        ? "bg-red-500/10 text-red-400 border border-red-500/20"
        : "bg-amber-500/10 text-amber-400 border border-amber-500/20",
    )}>
      <AlertTriangle className="h-3 w-3 flex-shrink-0" />
      <span>
        {budgetStatus.tier === "paused"
          ? "Daily limit reached \u2014 resumes tomorrow"
          : budgetStatus.tier === "tier0-only"
            ? "Budget low \u2014 using fast analysis only"
            : "Budget conserving \u2014 fewer checks today"}
      </span>
    </div>
  )
}

// ============ ONBOARDING CTA ============

function OnboardingCTA({
  projectId,
  projectPath,
}: {
  projectId: string | null
  projectPath: string | null
}) {
  const buildBrainMutation = trpc.ambient.buildBrain.useMutation({
    onSuccess: (result) => {
      if (result.success) {
        toast.success(`Project indexed: ${result.memoriesCreated} entries created`)
      } else {
        toast.error(result.error ?? "Failed to index project")
      }
    },
    onError: () => toast.error("Failed to index project"),
  })

  if (!projectId || !projectPath) return null

  return (
    <div className="px-2 pt-1 pb-2 space-y-2">
      <p className="text-[11px] text-muted-foreground/60 leading-relaxed">
        Watches for bugs, security issues, and performance problems as you code.
      </p>
      <button
        onClick={() => buildBrainMutation.mutate({ projectId, projectPath })}
        disabled={buildBrainMutation.isPending}
        className={cn(
          "w-full text-[11px] py-1.5 px-2 rounded-md font-medium transition-colors",
          "bg-teal-500/10 text-teal-300 hover:bg-teal-500/20 border border-teal-500/20",
          "disabled:opacity-50 disabled:cursor-not-allowed",
          "flex items-center justify-center gap-1.5",
        )}
      >
        {buildBrainMutation.isPending ? (
          <><Loader2 className="h-3 w-3 animate-spin" />Indexing project...</>
        ) : (
          <><Brain className="h-3 w-3" />Index this project</>
        )}
      </button>
    </div>
  )
}

// ============ PROJECT INDEX DETAILS (collapsed by default) ============

function ProjectIndexDetails({
  projectId,
  projectPath,
  brainStatus,
}: {
  projectId: string | null
  projectPath: string | null
  brainStatus: { memoryCount: number } | null | undefined
}) {
  const [open, setOpen] = useState(false)

  const trimMutation = trpc.ambient.trimMemories.useMutation({
    onSuccess: () => toast.success("Cleaned up low-value entries"),
  })

  const buildBrainMutation = trpc.ambient.buildBrain.useMutation({
    onSuccess: (result) => {
      if (result.success) {
        toast.success(`Re-indexed: ${result.memoriesCreated} created, ${result.memoriesUpdated ?? 0} updated`)
      } else {
        toast.error(result.error ?? "Failed to re-index")
      }
    },
    onError: () => toast.error("Failed to re-index project"),
  })

  if (!brainStatus || !projectId) return null

  const memoryCount = brainStatus.memoryCount
  const isHeavy = memoryCount * 80 > 2500

  return (
    <div className="px-2 pt-1 pb-0.5">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-1 text-[10px] text-muted-foreground/40 hover:text-muted-foreground/70 transition-colors"
      >
        <ChevronRight className={cn("h-2.5 w-2.5 transition-transform flex-shrink-0", open && "rotate-90")} />
        <Brain className="h-2.5 w-2.5 flex-shrink-0" />
        <span>Project index</span>
        <span className="ml-auto text-muted-foreground/30">
          {memoryCount} {memoryCount === 1 ? "entry" : "entries"}
        </span>
      </button>

      {open && (
        <div className="mt-1.5 ml-5 space-y-1.5">
          {isHeavy && (
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] text-amber-400/80">Index is large — may slow sessions</span>
              <button
                onClick={() => trimMutation.mutate({ projectId })}
                disabled={trimMutation.isPending}
                className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400 hover:bg-amber-500/20 transition-colors disabled:opacity-50 flex-shrink-0"
              >
                {trimMutation.isPending ? "..." : "Clean up"}
              </button>
            </div>
          )}
          {projectPath && (
            <button
              onClick={() => buildBrainMutation.mutate({ projectId, projectPath })}
              disabled={buildBrainMutation.isPending}
              className="text-[10px] text-muted-foreground/40 hover:text-muted-foreground/70 transition-colors flex items-center gap-1"
            >
              {buildBrainMutation.isPending ? (
                <><Loader2 className="h-2.5 w-2.5 animate-spin" />Re-indexing...</>
              ) : (
                "Re-index project"
              )}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

// ============ SUGGESTION CARD ============

const SuggestionCard = memo(function SuggestionCard({
  suggestion,
  chatId,
}: {
  suggestion: AmbientSuggestion
  chatId: string | null
}) {
  const [expandedId, setExpandedId] = useAtom(expandedSuggestionIdAtom)
  const isExpanded = expandedId === suggestion.id

  const dismissMutation = trpc.ambient.dismiss.useMutation()
  const snoozeMutation = trpc.ambient.snooze.useMutation({
    onSuccess: () => {
      toast("Snoozed until tomorrow", { duration: 3000 })
    },
  })

  const Icon = CATEGORY_ICONS[suggestion.category] ?? Bug
  const severityColor = SEVERITY_COLORS[suggestion.severity] ?? "text-slate-400"

  const handleToggle = useCallback(() => {
    setExpandedId(isExpanded ? null : suggestion.id)
  }, [isExpanded, suggestion.id, setExpandedId])

  const handleDismiss = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    dismissMutation.mutate({ suggestionId: suggestion.id })
  }, [suggestion.id, dismissMutation])

  const handleSnooze = useCallback(() => {
    snoozeMutation.mutate({ suggestionId: suggestion.id })
  }, [suggestion.id, snoozeMutation])

  // Parse trigger files
  let triggerFiles: string[] = []
  try {
    triggerFiles = Array.isArray(suggestion.triggerFiles)
      ? suggestion.triggerFiles
      : typeof suggestion.triggerFiles === "string"
        ? JSON.parse(suggestion.triggerFiles as string)
        : []
  } catch { /* ignore */ }

  return (
    <div className={cn(
      "rounded-md border transition-colors",
      isExpanded ? "border-border/60 bg-muted/30" : "border-transparent hover:bg-muted/30",
    )}>
      {/* Compact row */}
      <div
        onClick={handleToggle}
        className="flex items-center gap-1.5 px-1.5 py-1 cursor-pointer group"
      >
        <Icon className={cn(
          "h-3 w-3 flex-shrink-0",
          isExpanded ? (CATEGORY_COLORS[suggestion.category] ?? severityColor) : severityColor,
        )} />
        <span className="flex-1 truncate text-[11px] text-foreground/80">
          {suggestion.title}
        </span>
        <span className={cn(
          "text-[9px] px-1 py-0 rounded uppercase font-medium",
          SEVERITY_BG[suggestion.severity] ?? "bg-slate-500/15 text-slate-400",
        )}>
          {suggestion.severity === "error" ? "high" : suggestion.severity === "warning" ? "med" : "low"}
        </span>
        <button
          onClick={handleDismiss}
          className="h-4 w-4 flex-shrink-0 flex items-center justify-center rounded opacity-0 group-hover:opacity-100 hover:bg-muted transition-opacity"
          aria-label="Dismiss"
        >
          <X className="h-2.5 w-2.5 text-muted-foreground" />
        </button>
      </div>

      {/* Expanded detail */}
      {isExpanded && (
        <div className="px-2 pb-2 pt-0.5 border-t border-border/30 mx-1">
          {/* Confidence bar */}
          <div className="flex items-center gap-2 mt-1.5 mb-2">
            <div className="flex-1 h-1 rounded-full bg-muted overflow-hidden">
              <div
                className={cn(
                  "h-full rounded-full transition-all",
                  suggestion.confidence >= 80 ? "bg-green-500/70" :
                  suggestion.confidence >= 50 ? "bg-amber-500/70" : "bg-slate-500/70",
                )}
                style={{ width: `${suggestion.confidence}%` }}
              />
            </div>
            <span className="text-[10px] text-muted-foreground shrink-0">{suggestion.confidence}%</span>
          </div>

          {/* Description */}
          {suggestion.description && (
            <p className="text-[11px] text-foreground/70 leading-relaxed mb-2 line-clamp-4">
              {suggestion.description}
            </p>
          )}

          {/* Affected files */}
          {triggerFiles.length > 0 && (
            <div className="mb-2.5 space-y-0.5">
              <span className="text-[9px] text-muted-foreground uppercase tracking-wider">Files</span>
              {triggerFiles.slice(0, 3).map((file) => (
                <div key={file} className="flex items-center gap-1 text-[10px] text-muted-foreground">
                  <FileCode className="h-2.5 w-2.5 flex-shrink-0" />
                  <span className="truncate font-mono">{file}</span>
                </div>
              ))}
              {triggerFiles.length > 3 && (
                <span className="text-[10px] text-muted-foreground/60">+{triggerFiles.length - 3} more</span>
              )}
            </div>
          )}

          {/* Action bar */}
          <div className="flex items-center gap-1.5">
            <ImplementButton suggestion={suggestion} chatId={chatId} />
            <button
              onClick={handleSnooze}
              disabled={snoozeMutation.isPending}
              className="text-[11px] px-2 py-1 rounded border border-border/50 text-muted-foreground hover:bg-muted/50 transition-colors disabled:opacity-50"
            >
              <Clock className="h-3 w-3 inline mr-0.5 -mt-0.5" />
              Snooze
            </button>
            <button
              onClick={handleDismiss}
              className="text-[11px] px-2 py-1 rounded text-muted-foreground/60 hover:text-muted-foreground transition-colors"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}
    </div>
  )
})

// ============ IMPLEMENT SPLIT BUTTON ============

function ImplementButton({
  suggestion,
  chatId,
}: {
  suggestion: AmbientSuggestion
  chatId: string | null
}) {
  const [lastMode, setLastMode] = useAtom(implementModeAtom)
  const setExpandedId = useSetAtom(expandedSuggestionIdAtom)
  const [isApproving, setIsApproving] = useState(false)

  const approveMutation = trpc.ambient.approve.useMutation({
    onSuccess: (result) => {
      if (result.success && result.subChatId) {
        const store = useAgentSubChatStore.getState()
        const newMeta: SubChatMeta = {
          id: result.subChatId,
          name: suggestion.title,
          mode: lastMode,
          created_at: new Date().toISOString(),
        }
        store.addToAllSubChats(newMeta)
        if (!store.openSubChatIds.includes(result.subChatId)) {
          store.addToOpenSubChats(result.subChatId)
        }
        store.setActiveSubChat(result.subChatId)
        setExpandedId(null)
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

  return (
    <div className="flex items-center">
      <button
        onClick={() => handleImplement(lastMode)}
        disabled={isApproving}
        className={cn(
          "text-[11px] px-2 py-1 rounded-l font-medium transition-colors",
          "bg-violet-600 text-white hover:bg-violet-500",
          "disabled:opacity-50 disabled:cursor-not-allowed",
        )}
      >
        {isApproving ? (
          <><Loader2 className="h-3 w-3 inline mr-0.5 -mt-0.5 animate-spin" />Opening...</>
        ) : (
          <><Play className="h-3 w-3 inline mr-0.5 -mt-0.5" />{lastMode === "plan" ? "Plan" : "Implement"}</>
        )}
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            disabled={isApproving}
            className={cn(
              "text-[11px] px-1 py-1 rounded-r border-l border-violet-700 transition-colors",
              "bg-violet-600 text-white hover:bg-violet-500",
              "disabled:opacity-50 disabled:cursor-not-allowed",
            )}
          >
            <ChevronDown className="h-3 w-3" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="top" className="w-36">
          <DropdownMenuItem onClick={() => handleImplement("plan")}>
            <PlanIcon className="h-3.5 w-3.5 mr-1.5" />
            Plan mode
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => handleImplement("agent")}>
            <AgentIcon className="h-3.5 w-3.5 mr-1.5" />
            Agent mode
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

// ============ SUGGESTION HISTORY ============

function SuggestionHistory({
  projectId,
  showHistory,
  setShowHistory,
}: {
  projectId: string | null
  showHistory: boolean
  setShowHistory: (v: boolean) => void
}) {
  const { data: dismissedData } = trpc.ambient.listSuggestions.useQuery(
    { projectId: projectId!, status: "dismissed", limit: 20 },
    { enabled: !!projectId && showHistory },
  )
  const { data: approvedData } = trpc.ambient.listSuggestions.useQuery(
    { projectId: projectId!, status: "approved", limit: 20 },
    { enabled: !!projectId && showHistory },
  )

  const historyItems = [
    ...(dismissedData ?? []).map(s => ({ ...s, disposition: "dismissed" as const })),
    ...(approvedData ?? []).map(s => ({ ...s, disposition: "approved" as const })),
  ].sort((a, b) => {
    const aTime = a.createdAt ? new Date(a.createdAt as unknown as string).getTime() : 0
    const bTime = b.createdAt ? new Date(b.createdAt as unknown as string).getTime() : 0
    return bTime - aTime
  })

  // Only show the history toggle if there's been prior activity
  const hasHistory = showHistory || (historyItems.length > 0)

  return (
    <>
      <button
        onClick={() => setShowHistory(!showHistory)}
        className="w-full px-2 py-0.5 text-[10px] text-muted-foreground/40 hover:text-muted-foreground/60 text-left transition-colors flex items-center gap-1"
      >
        <History className="h-2.5 w-2.5" />
        <span>{showHistory ? "Hide history" : "Past findings"}</span>
      </button>

      {showHistory && (
        <div className="max-h-32 overflow-y-auto space-y-0.5 px-1">
          {historyItems.length === 0 ? (
            <p className="px-1 py-1 text-[10px] text-muted-foreground/40 italic">No history yet</p>
          ) : (
            historyItems.map((item) => {
              const ItemIcon = item.disposition === "approved" ? Check : X
              const iconColor = item.disposition === "approved" ? "text-green-500" : "text-muted-foreground/40"
              return (
                <div key={item.id} className="flex items-center gap-1.5 px-1 py-0.5 text-[10px] text-muted-foreground/50">
                  <ItemIcon className={cn("h-2.5 w-2.5 flex-shrink-0", iconColor)} />
                  <span className="truncate">{item.title}</span>
                </div>
              )
            })
          )}
        </div>
      )}
    </>
  )
}
