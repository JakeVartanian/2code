/**
 * PipelineView — visual flow showing Memory Context → Reasoning → Plan Steps → Expected Outcome.
 * Core visual component of the orchestrator tab.
 */

import { memo, useState, useEffect, useCallback } from "react"
import {
  ChevronDown,
  ChevronRight,
  Brain,
  Lightbulb,
  ListTodo,
  CheckCircle2,
  Clock,
  AlertTriangle,
  Zap,
  Loader2,
} from "lucide-react"
import { cn } from "../../../../lib/utils"
import { trpc } from "../../../../lib/trpc"
import { useAtomValue } from "jotai"
import { selectedProjectAtom } from "../../../../lib/atoms"
import { toast } from "sonner"
import { TaskCard } from "./task-card"
import type { OrchestrationRun, RunStatus, Autonomy } from "../../stores/orchestration-store"

// Collapsible section wrapper
function PipelineSection({
  title,
  icon: Icon,
  defaultOpen,
  children,
  badge,
}: {
  title: string
  icon: React.ElementType
  defaultOpen?: boolean
  children: React.ReactNode
  badge?: string | number
}) {
  const [isOpen, setIsOpen] = useState(defaultOpen ?? true)

  return (
    <div className="border border-border/50 rounded-lg overflow-hidden">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center gap-2 px-4 py-2.5 hover:bg-accent/30 transition-colors"
      >
        {isOpen ? (
          <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5 text-muted-foreground" />
        )}
        <Icon className="w-4 h-4 text-muted-foreground" />
        <span className="text-sm font-medium">{title}</span>
        {badge !== undefined && (
          <span className="text-xs text-muted-foreground ml-auto">{badge}</span>
        )}
      </button>
      {isOpen && (
        <div className="px-4 pb-3 border-t border-border/30">
          {children}
        </div>
      )}
    </div>
  )
}

// Memory section — shows top memories and stats, with Build Brain option
function MemorySection({ projectId }: { projectId: string | null }) {
  const selectedProject = useAtomValue(selectedProjectAtom)
  const { data: stats, refetch: refetchStats } = trpc.memory.stats.useQuery(
    { projectId: projectId || "" },
    { enabled: !!projectId },
  )

  const { data: memories, refetch: refetchList } = trpc.memory.list.useQuery(
    { projectId: projectId || "" },
    { enabled: !!projectId },
  )

  const buildBrainMutation = trpc.ambient.buildBrain.useMutation({
    onSuccess: (result) => {
      if (result.success) {
        toast.success(`Brain built: ${result.memoriesCreated} memories created`)
        refetchStats()
        refetchList()
      } else {
        toast.error(result.error ?? "Failed to build brain")
      }
    },
    onError: (err) => toast.error(err.message),
  })

  const handleBuildBrain = useCallback(() => {
    if (!selectedProject) return
    buildBrainMutation.mutate({
      projectId: selectedProject.id,
      projectPath: selectedProject.path,
    })
  }, [selectedProject])

  const allMemories = memories ?? []
  const hasMemories = (stats?.total ?? 0) > 0
  const [showAll, setShowAll] = useState(false)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const displayMemories = showAll ? allMemories : allMemories.slice(0, 5)
  const hasMore = allMemories.length > 5

  return (
    <PipelineSection
      title="Memory Context"
      icon={Brain}
      badge={stats ? `${stats.total} memories` : undefined}
    >
      <div className="pt-2 space-y-1.5">
        {stats && (
          <div className="flex gap-3 text-xs text-muted-foreground mb-2">
            <span>{stats.total} total</span>
            {stats.staleCount > 0 && (
              <span className="text-yellow-500">{stats.staleCount} stale</span>
            )}
            <span>~{stats.estimatedTokens} tokens</span>
          </div>
        )}
        {hasMemories ? (
          <>
            {displayMemories.map((m) => {
              const isExpanded = expandedId === m.id
              return (
                <button
                  key={m.id}
                  onClick={() => setExpandedId(isExpanded ? null : m.id)}
                  className="w-full text-left text-xs rounded bg-muted/50 hover:bg-muted/70 transition-colors cursor-pointer"
                >
                  <div className="flex items-start gap-2 px-2.5 py-1.5">
                    <ChevronRight className={cn(
                      "w-3 h-3 mt-0.5 shrink-0 text-muted-foreground transition-transform",
                      isExpanded && "rotate-90",
                    )} />
                    <span className="text-[10px] px-1 py-0 rounded bg-foreground/10 text-foreground/70 shrink-0 capitalize">
                      {m.category}
                    </span>
                    <span className={cn("text-foreground/80 flex-1 min-w-0", !isExpanded && "truncate")}>
                      {m.title}
                    </span>
                  </div>
                  {isExpanded && (
                    <div className="px-2.5 pb-2 pt-1 border-t border-border/30 mx-2.5 text-foreground/60 whitespace-pre-wrap">
                      {m.content}
                      {m.linkedFiles && (() => {
                        try {
                          const files = typeof m.linkedFiles === "string" ? JSON.parse(m.linkedFiles) : m.linkedFiles
                          return Array.isArray(files) && files.length > 0 ? (
                            <div className="mt-1.5 text-[10px] text-muted-foreground">
                              Files: {files.join(", ")}
                            </div>
                          ) : null
                        } catch { return null }
                      })()}
                    </div>
                  )}
                </button>
              )
            })}
            {hasMore && (
              <button
                onClick={() => setShowAll(!showAll)}
                className="text-xs text-purple-400 hover:text-purple-300 transition-colors"
              >
                {showAll ? "Show less" : `Show all ${allMemories.length} memories`}
              </button>
            )}
          </>
        ) : (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">
              No memories yet. Build the brain from your project's git history and config files, or they'll be auto-captured from conversations.
            </p>
            {selectedProject && (
              <button
                onClick={handleBuildBrain}
                disabled={buildBrainMutation.isPending}
                className={cn(
                  "w-full flex items-center justify-center gap-2 px-3 py-1.5 rounded-md",
                  "border border-dashed border-purple-500/40 bg-purple-500/5",
                  "text-xs text-purple-400 hover:bg-purple-500/10 transition-colors",
                  "disabled:opacity-50 disabled:cursor-not-allowed",
                )}
              >
                {buildBrainMutation.isPending ? (
                  <>
                    <Loader2 className="w-3 h-3 animate-spin" />
                    <span>Building...</span>
                  </>
                ) : (
                  <>
                    <Zap className="w-3 h-3" />
                    <span>Build Brain from Project</span>
                  </>
                )}
              </button>
            )}
          </div>
        )}
      </div>
    </PipelineSection>
  )
}

// Reasoning section — shows goal and why this approach was chosen
function ReasoningSection({
  userGoal,
  decomposedPlan,
}: {
  userGoal: string
  decomposedPlan: string
}) {
  let planData: any = {}
  try {
    planData = JSON.parse(decomposedPlan)
  } catch { /* ignore */ }

  return (
    <PipelineSection title="Reasoning" icon={Lightbulb} defaultOpen={true}>
      <div className="pt-2 space-y-2">
        <div>
          <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
            Goal
          </span>
          <p className="text-sm mt-0.5">{userGoal}</p>
        </div>
        {planData.reasoning && (
          <div>
            <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
              Approach
            </span>
            <p className="text-xs text-muted-foreground mt-0.5">
              {planData.reasoning}
            </p>
          </div>
        )}
        {planData.type === "existing-tabs" && (
          <div className="text-xs text-blue-400 bg-blue-500/10 px-2 py-1 rounded">
            Orchestrating {planData.tabs?.length ?? 0} existing tabs
          </div>
        )}
      </div>
    </PipelineSection>
  )
}

// Status bar — compact run status with progress
function StatusBar({ run }: { run: OrchestrationRun }) {
  const completedCount = run.tasks.filter((t) => t.status === "completed").length
  const failedCount = run.tasks.filter((t) => t.status === "failed").length
  const runningCount = run.tasks.filter((t) => t.status === "running").length
  const stuckCount = run.tasks.filter((t) => t.status === "stuck").length
  const totalCount = run.tasks.length

  // Live elapsed timer — ticks every second while run is active
  const [elapsed, setElapsed] = useState("")
  useEffect(() => {
    if (!run.startedAt) {
      setElapsed("")
      return
    }

    const compute = () => {
      const diff = (run.completedAt ?? new Date()).getTime() - run.startedAt!.getTime()
      const mins = Math.floor(diff / 60000)
      const secs = Math.floor((diff % 60000) / 1000)
      setElapsed(mins > 0 ? `${mins}m ${secs}s` : `${secs}s`)
    }

    compute()

    // Only tick while the run is still active (no completedAt)
    if (!run.completedAt) {
      const interval = setInterval(compute, 1000)
      return () => clearInterval(interval)
    }
  }, [run.startedAt, run.completedAt])

  const progressPct = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0

  const statusLabel: Record<RunStatus, string> = {
    planning: "Planning",
    running: "Running",
    paused: "Paused",
    validating: "Validating",
    completed: "Completed",
    failed: "Failed",
    cancelled: "Cancelled",
  }

  const statusColor: Record<RunStatus, string> = {
    planning: "text-blue-400",
    running: "text-green-400",
    paused: "text-yellow-400",
    validating: "text-purple-400",
    completed: "text-green-500",
    failed: "text-red-500",
    cancelled: "text-muted-foreground",
  }

  return (
    <div className="flex items-center gap-3 px-4 py-2 border border-border/50 rounded-lg bg-muted/30">
      {/* Status dot */}
      <span className={cn("text-sm font-medium", statusColor[run.status])}>
        {run.status === "running" && <span className="inline-block animate-pulse mr-1">●</span>}
        {statusLabel[run.status]}
      </span>

      {/* Progress bar */}
      <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
        <div
          className={cn(
            "h-full rounded-full transition-all duration-500",
            run.status === "completed" ? "bg-green-500" :
            run.status === "failed" ? "bg-red-500" :
            "bg-blue-500",
          )}
          style={{ width: `${progressPct}%` }}
        />
      </div>

      {/* Stats */}
      <div className="flex items-center gap-2 text-xs text-muted-foreground shrink-0">
        <span>{completedCount}/{totalCount}</span>
        {runningCount > 0 && <span className="text-green-400">{runningCount} active</span>}
        {failedCount > 0 && <span className="text-red-400">{failedCount} failed</span>}
        {stuckCount > 0 && (
          <span className="text-orange-400 flex items-center gap-0.5">
            <AlertTriangle className="w-3 h-3" />
            {stuckCount}
          </span>
        )}
        {elapsed && (
          <span className="flex items-center gap-0.5">
            <Clock className="w-3 h-3" />
            {elapsed}
          </span>
        )}
      </div>
    </div>
  )
}

// Plan section — task list with dependency visualization
function PlanSection({
  run,
  onAutonomyChange,
  onNavigateToTab,
  onRetryTask,
  onSkipTask,
}: {
  run: OrchestrationRun
  onAutonomyChange: (taskId: string, autonomy: Autonomy) => void
  onNavigateToTab: (subChatId: string) => void
  onRetryTask?: (taskId: string) => void
  onSkipTask?: (taskId: string) => void
}) {
  const completedCount = run.tasks.filter((t) => t.status === "completed").length
  const queuedTasks = run.tasks.filter((t) => t.status === "queued")

  return (
    <PipelineSection
      title="Plan"
      icon={ListTodo}
      badge={`${completedCount}/${run.tasks.length} done`}
    >
      <div className="pt-2 space-y-2">
        {run.tasks
          .sort((a, b) => a.sortOrder - b.sortOrder)
          .map((task) => (
            <TaskCard
              key={task.id}
              task={task}
              allTasks={run.tasks}
              onAutonomyChange={onAutonomyChange}
              onNavigateToTab={onNavigateToTab}
              onRetryTask={onRetryTask}
              onSkipTask={onSkipTask}
              queuePosition={
                task.status === "queued"
                  ? queuedTasks.indexOf(task) + 1
                  : undefined
              }
            />
          ))}
        {run.tasks.length === 0 && (
          <p className="text-xs text-muted-foreground">No tasks yet.</p>
        )}
      </div>
    </PipelineSection>
  )
}

// Outcome section — progressive during execution, full summary after completion
function OutcomeSection({
  run,
}: {
  run: OrchestrationRun
}) {
  const completedTasks = run.tasks.filter(
    (t) => t.status === "completed" && t.resultSummary,
  )
  const failedTasks = run.tasks.filter(
    (t) => t.status === "failed" && t.resultSummary,
  )
  const isTerminal = ["completed", "failed", "cancelled"].includes(run.status)

  // Show when there's something to show: terminal state OR completed tasks during execution
  if (!isTerminal && completedTasks.length === 0 && failedTasks.length === 0) return null

  return (
    <PipelineSection
      title={isTerminal ? "Outcome" : "Progress"}
      icon={CheckCircle2}
      defaultOpen={true}
    >
      <div className="pt-2 space-y-2">
        {/* Final aggregated summary (only after run completes) */}
        {isTerminal && run.summary && (
          <div className="text-sm whitespace-pre-wrap">{run.summary}</div>
        )}

        {/* No summary fallback */}
        {isTerminal && !run.summary && (
          <p className={cn("text-xs", run.status === "completed" ? "text-green-500" : "text-red-500")}>
            {run.status === "completed"
              ? "All tasks completed successfully."
              : run.status === "cancelled"
                ? "Orchestration was cancelled."
                : "Orchestration failed. Check individual task statuses."}
          </p>
        )}

        {/* Progressive task summaries (during execution OR when no aggregated summary) */}
        {(!isTerminal || !run.summary) && completedTasks.length > 0 && (
          <div className="space-y-1">
            {!isTerminal && (
              <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                Completed
              </span>
            )}
            {completedTasks.map((t) => (
              <div key={t.id} className="text-xs bg-green-500/5 border border-green-500/20 rounded p-2">
                <span className="font-medium text-green-500">{t.name}:</span>{" "}
                <span className="text-muted-foreground">{t.resultSummary}</span>
              </div>
            ))}
          </div>
        )}

        {/* Failed task summaries */}
        {failedTasks.length > 0 && (
          <div className="space-y-1">
            <span className="text-[10px] font-medium text-red-400 uppercase tracking-wider">
              Failed
            </span>
            {failedTasks.map((t) => (
              <div key={t.id} className="text-xs bg-red-500/5 border border-red-500/20 rounded p-2">
                <span className="font-medium text-red-400">{t.name}:</span>{" "}
                <span className="text-muted-foreground">{t.resultSummary}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </PipelineSection>
  )
}

// Main pipeline view
interface PipelineViewProps {
  run: OrchestrationRun | null
  projectId: string | null
  onAutonomyChange: (taskId: string, autonomy: Autonomy) => void
  onNavigateToTab: (subChatId: string) => void
  onRetryTask?: (taskId: string) => void
  onSkipTask?: (taskId: string) => void
}

export const PipelineView = memo(function PipelineView({
  run,
  projectId,
  onAutonomyChange,
  onNavigateToTab,
  onRetryTask,
  onSkipTask,
}: PipelineViewProps) {
  return (
    <div className="space-y-3 p-4">
      {/* Status bar — only during active/completed runs */}
      {run && <StatusBar run={run} />}

      {/* Memory always shows */}
      <MemorySection projectId={projectId} />

      {/* Reasoning + Plan + Outcome only when there's an active run */}
      {run && (
        <>
          <ReasoningSection
            userGoal={run.userGoal}
            decomposedPlan={run.decomposedPlan}
          />
          <PlanSection
            run={run}
            onAutonomyChange={onAutonomyChange}
            onNavigateToTab={onNavigateToTab}
            onRetryTask={onRetryTask}
            onSkipTask={onSkipTask}
          />
          <OutcomeSection run={run} />
        </>
      )}
    </div>
  )
})
