/**
 * Ambient sidebar section — compact suggestion list with indicator dot.
 * Designed to work at 160px minimum sidebar width.
 */

import { useAtom } from "jotai"
import { ChevronDown, ChevronRight, X, Zap, ShieldAlert, Bug, Gauge } from "lucide-react"
import { ambientPanelExpandedAtom } from "./atoms"
import { useAmbientStore } from "./store"
import { useAmbientData } from "./hooks/use-ambient-data"
import { trpc } from "../../lib/trpc"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../../components/ui/tooltip"

const MAX_VISIBLE = 3

const SEVERITY_ICONS: Record<string, typeof Bug> = {
  bug: Bug,
  security: ShieldAlert,
  performance: Gauge,
}

const SEVERITY_COLORS: Record<string, string> = {
  error: "text-red-500",
  warning: "text-amber-500",
  info: "text-teal-500",
}

export function AmbientSidebarSection({ projectId }: { projectId: string | null }) {
  // Connect data pipeline — fetches from tRPC, syncs to store, subscribes to real-time updates
  useAmbientData(projectId)

  const [expanded, setExpanded] = useAtom(ambientPanelExpandedAtom)
  const { suggestions, agentStatus, budgetStatus } = useAmbientStore()
  const dismissMutation = trpc.ambient.dismiss.useMutation()

  const pendingSuggestions = suggestions.filter(s => s.status === "pending")
  const visibleSuggestions = pendingSuggestions.slice(0, MAX_VISIBLE)
  const moreCount = Math.max(0, pendingSuggestions.length - MAX_VISIBLE)

  // Determine indicator color
  const indicatorColor = getIndicatorColor(pendingSuggestions)

  // Status dot color
  const statusColor = agentStatus === "running" ? "bg-green-500"
    : agentStatus === "paused" ? "bg-amber-500"
    : "bg-zinc-500"

  return (
    <div className="px-2 pb-2">
      {/* Section header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-1 rounded px-1 py-1 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
      >
        {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        <Zap className="h-3 w-3" />
        <span className="flex-1 text-left">Ambient</span>

        {/* Indicator dot */}
        {indicatorColor && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                className={`h-2 w-2 rounded-full ${indicatorColor}`}
                aria-label={`Ambient: ${pendingSuggestions.length} suggestion${pendingSuggestions.length !== 1 ? "s" : ""} pending`}
              />
            </TooltipTrigger>
            <TooltipContent side="right">
              {pendingSuggestions.length} suggestion{pendingSuggestions.length !== 1 ? "s" : ""} pending
            </TooltipContent>
          </Tooltip>
        )}

        {/* Status dot */}
        <Tooltip>
          <TooltipTrigger asChild>
            <span className={`h-1.5 w-1.5 rounded-full ${statusColor}`} />
          </TooltipTrigger>
          <TooltipContent side="right">
            Agent {agentStatus}
          </TooltipContent>
        </Tooltip>
      </button>

      {/* Expanded content */}
      {expanded && (
        <div className="mt-1 space-y-0.5">
          {visibleSuggestions.length === 0 ? (
            <p className="px-2 py-1 text-[10px] text-muted-foreground/60">
              No suggestions
            </p>
          ) : (
            <>
              {visibleSuggestions.map((suggestion) => (
                <SuggestionRow
                  key={suggestion.id}
                  suggestion={suggestion}
                  onDismiss={() => {
                    dismissMutation.mutate({ suggestionId: suggestion.id })
                  }}
                />
              ))}
              {moreCount > 0 && (
                <p className="px-2 py-0.5 text-[10px] text-muted-foreground/60 text-center">
                  {moreCount} more
                </p>
              )}
            </>
          )}

          {/* Budget bar */}
          {budgetStatus && (
            <div className="px-2 pt-1">
              <div className="h-1 w-full rounded-full bg-muted overflow-hidden">
                <div
                  className="h-full rounded-full bg-teal-500/60 transition-all"
                  style={{ width: `${Math.min(100, budgetStatus.percentUsed)}%` }}
                />
              </div>
              <p className="text-[9px] text-muted-foreground/50 mt-0.5">
                {budgetStatus.percentUsed}% budget used
              </p>
            </div>
          )}

          {/* Injection weight indicator */}
          <InjectionWeightBar projectId={projectId} />
        </div>
      )}
    </div>
  )
}

function SuggestionRow({
  suggestion,
  onDismiss,
}: {
  suggestion: { id: string; category: string; severity: string; title: string }
  onDismiss: () => void
}) {
  const Icon = SEVERITY_ICONS[suggestion.category] ?? Bug
  const colorClass = SEVERITY_COLORS[suggestion.severity] ?? "text-teal-500"

  return (
    <div className="group flex items-center gap-1.5 rounded px-1.5 py-1 hover:bg-muted/50 transition-colors">
      <Icon className={`h-3 w-3 flex-shrink-0 ${colorClass}`} />
      <span className="flex-1 truncate text-[11px] text-foreground/80">
        {suggestion.title}
      </span>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={(e) => {
              e.stopPropagation()
              onDismiss()
            }}
            className="h-4 w-4 flex-shrink-0 flex items-center justify-center rounded opacity-0 group-hover:opacity-100 hover:bg-muted transition-opacity"
            aria-label="Dismiss — system will learn from this"
          >
            <X className="h-2.5 w-2.5 text-muted-foreground" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="right">
          Dismiss — system will learn
        </TooltipContent>
      </Tooltip>
    </div>
  )
}

/**
 * Injection weight indicator — shows how heavy the memory injection is for new sessions.
 * Green = light, amber = moderate, red = heavy (shows Trim button).
 */
function InjectionWeightBar({ projectId }: { projectId: string | null }) {
  const { data: brainStatus, refetch: refetchBrain } = trpc.ambient.getBrainStatus.useQuery(
    { projectId: projectId! },
    { enabled: !!projectId, refetchInterval: 60_000 },
  )

  const trimMutation = trpc.ambient.trimMemories.useMutation({
    onSuccess: (result) => {
      refetchBrain()
      if (result.trimmed > 0) {
        // Toast would be nice but keeping it quiet — the bar update is enough
      }
    },
  })

  if (!brainStatus || brainStatus.memoryCount === 0) return null

  // Estimate injection tokens: ~80 tokens per memory on average (title + content)
  const estimatedTokens = brainStatus.memoryCount * 80
  // Budget caps at 3000 tokens, so effective injection is min of estimate and cap
  const effectiveTokens = Math.min(estimatedTokens, 3000)
  const percent = Math.round((effectiveTokens / 3000) * 100)

  // Color coding
  const isHeavy = effectiveTokens > 2500
  const barColor = isHeavy ? "bg-red-500/70"
    : effectiveTokens > 1500 ? "bg-amber-500/60"
    : "bg-green-500/60"

  const label = isHeavy
    ? `~${effectiveTokens} tokens injected — Trim will archive low-value memories (they auto-reactivate when relevant again)`
    : `~${effectiveTokens} tokens injected per session`

  return (
    <div className="px-2 pt-1">
      <Tooltip>
        <TooltipTrigger asChild>
          <div>
            <div className="h-1 w-full rounded-full bg-muted overflow-hidden">
              <div
                className={`h-full rounded-full ${barColor} transition-all`}
                style={{ width: `${percent}%` }}
              />
            </div>
            <div className="flex items-center justify-between mt-0.5">
              <p className={`text-[9px] ${isHeavy ? "text-red-400/70" : "text-muted-foreground/50"}`}>
                {isHeavy ? "injection heavy" : `~${effectiveTokens}t injected`}
              </p>
              {isHeavy && (
                <button
                  onClick={() => trimMutation.mutate({ projectId: projectId! })}
                  disabled={trimMutation.isPending}
                  className="text-[9px] px-1.5 py-0.5 rounded bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-colors disabled:opacity-50"
                >
                  {trimMutation.isPending ? "..." : "Trim"}
                </button>
              )}
            </div>
          </div>
        </TooltipTrigger>
        <TooltipContent side="right" className="max-w-[200px]">
          {label}
        </TooltipContent>
      </Tooltip>
    </div>
  )
}

function getIndicatorColor(suggestions: { severity: string }[]): string | null {
  if (suggestions.length === 0) return null
  if (suggestions.some(s => s.severity === "error")) return "bg-red-500"
  if (suggestions.some(s => s.severity === "warning")) return "bg-amber-500"
  return "bg-teal-500"
}
