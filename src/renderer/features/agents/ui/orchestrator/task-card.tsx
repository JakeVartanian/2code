/**
 * TaskCard — individual task within the orchestration plan.
 * Shows status, name, description, autonomy toggle, dependency info,
 * and links to spawned worker tabs.
 */

import { memo, useCallback } from "react"
import { cn } from "../../../../lib/utils"
import type { OrchestrationTask, Autonomy, TaskStatus } from "../../stores/orchestration-store"

// Status symbols and colors
const STATUS_CONFIG: Record<TaskStatus, { icon: string; label: string; color: string }> = {
  pending: { icon: "○", label: "Pending", color: "text-muted-foreground" },
  blocked: { icon: "⏸", label: "Blocked", color: "text-yellow-500" },
  queued: { icon: "⏳", label: "Queued", color: "text-blue-400" },
  running: { icon: "●", label: "Running", color: "text-green-400" },
  validating: { icon: "❓", label: "Review", color: "text-purple-400" },
  completed: { icon: "✓", label: "Done", color: "text-green-500" },
  failed: { icon: "✗", label: "Failed", color: "text-red-500" },
  skipped: { icon: "⊘", label: "Skipped", color: "text-muted-foreground" },
  stuck: { icon: "⚠", label: "Stuck", color: "text-orange-500" },
}

const AUTONOMY_OPTIONS: { value: Autonomy; label: string; description: string }[] = [
  { value: "auto", label: "Auto", description: "Runs freely" },
  { value: "review", label: "Review", description: "Pauses at checkpoints" },
  { value: "supervised", label: "Supervised", description: "Approve every tool call" },
  { value: "plan-only", label: "Plan Only", description: "Read-only analysis" },
]

interface TaskCardProps {
  task: OrchestrationTask
  allTasks: OrchestrationTask[]
  onAutonomyChange: (taskId: string, autonomy: Autonomy) => void
  onNavigateToTab: (subChatId: string) => void
  onRetryTask?: (taskId: string) => void
  onSkipTask?: (taskId: string) => void
  queuePosition?: number
}

export const TaskCard = memo(function TaskCard({
  task,
  allTasks,
  onAutonomyChange,
  onNavigateToTab,
  onRetryTask,
  onSkipTask,
  queuePosition,
}: TaskCardProps) {
  const statusConfig = STATUS_CONFIG[task.status]

  const handleAutonomyChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      onAutonomyChange(task.id, e.target.value as Autonomy)
    },
    [task.id, onAutonomyChange],
  )

  // Resolve dependency names
  const depNames = task.dependsOn
    .map((depId) => allTasks.find((t) => t.id === depId)?.name)
    .filter(Boolean)

  return (
    <div
      className={cn(
        "rounded-lg border border-border/60 p-3 transition-colors",
        task.status === "running" && "border-green-500/40 bg-green-500/5",
        task.status === "failed" && "border-red-500/40 bg-red-500/5",
        task.status === "validating" && "border-purple-500/40 bg-purple-500/5",
        task.status === "stuck" && "border-orange-500/40 bg-orange-500/5",
        task.status === "completed" && "opacity-75",
      )}
    >
      {/* Header row */}
      <div className="flex items-center gap-2">
        {/* Status icon */}
        <span
          className={cn(
            "text-base leading-none",
            statusConfig.color,
            task.status === "running" && "animate-pulse",
          )}
        >
          {statusConfig.icon}
        </span>

        {/* Task name */}
        <span className="text-sm font-medium flex-1 truncate">{task.name}</span>

        {/* Queue position */}
        {task.status === "queued" && queuePosition !== undefined && (
          <span className="text-xs text-muted-foreground">
            {queuePosition > 0 ? `${queuePosition}${ordinalSuffix(queuePosition)} in queue` : "Next up"}
          </span>
        )}

        {/* Status label */}
        <span className={cn("text-xs", statusConfig.color)}>{statusConfig.label}</span>
      </div>

      {/* Description */}
      <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
        {task.description}
      </p>

      {/* Dependencies */}
      {depNames.length > 0 && (
        <div className="flex items-center gap-1 mt-2">
          <span className="text-[10px] text-muted-foreground">Depends on:</span>
          {depNames.map((name, i) => (
            <span
              key={i}
              className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground"
            >
              {name}
            </span>
          ))}
        </div>
      )}

      {/* Bottom row: autonomy + worker tab link */}
      <div className="flex items-center gap-2 mt-2">
        {/* Autonomy selector */}
        <select
          value={task.autonomy}
          onChange={handleAutonomyChange}
          disabled={["completed", "failed", "skipped"].includes(task.status)}
          className="text-xs px-2 py-0.5 rounded border border-border bg-background disabled:opacity-50"
        >
          {AUTONOMY_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>

        <div className="flex-1" />

        {/* Worker tab link */}
        {task.subChatId && (
          <button
            onClick={() => onNavigateToTab(task.subChatId!)}
            className="text-xs text-blue-400 hover:text-blue-300 transition-colors"
          >
            Open Tab →
          </button>
        )}
      </div>

      {/* Result summary (completed, failed, stuck, skipped) */}
      {task.resultSummary && ["completed", "failed", "stuck", "skipped"].includes(task.status) && (
        <div
          className={cn(
            "mt-2 text-xs rounded p-2",
            task.status === "completed" && "text-muted-foreground bg-muted/50",
            task.status === "failed" && "text-red-400 bg-red-500/10",
            task.status === "stuck" && "text-orange-400 bg-orange-500/10",
            task.status === "skipped" && "text-muted-foreground bg-muted/50",
          )}
        >
          {task.resultSummary}
        </div>
      )}

      {/* Stuck task actions */}
      {task.status === "stuck" && (
        <div className="mt-2 flex items-center gap-2">
          {onRetryTask && (
            <button
              onClick={() => onRetryTask(task.id)}
              className="text-xs px-2 py-1 rounded bg-blue-500/10 text-blue-400 hover:bg-blue-500/20 transition-colors"
            >
              Retry
            </button>
          )}
          {onSkipTask && (
            <button
              onClick={() => onSkipTask(task.id)}
              className="text-xs px-2 py-1 rounded bg-yellow-500/10 text-yellow-400 hover:bg-yellow-500/20 transition-colors"
            >
              Skip
            </button>
          )}
          {task.subChatId && (
            <button
              onClick={() => onNavigateToTab(task.subChatId!)}
              className="text-xs px-2 py-1 rounded bg-muted text-muted-foreground hover:bg-muted/80 transition-colors"
            >
              Open Tab
            </button>
          )}
        </div>
      )}
    </div>
  )
})

function ordinalSuffix(n: number): string {
  const v = n % 100
  if (v >= 11 && v <= 13) return "th"
  switch (n % 10) {
    case 1: return "st"
    case 2: return "nd"
    case 3: return "rd"
    default: return "th"
  }
}
