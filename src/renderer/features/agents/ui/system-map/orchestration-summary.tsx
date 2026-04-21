/**
 * OrchestrationSummary — Compact summary of active orchestration runs.
 * Shows run goal, progress bar, and per-task status dots.
 */

import { memo } from "react"
import { cn } from "../../../../lib/utils"

interface Task {
  id: string
  name: string
  status: string
}

interface Run {
  id: string
  userGoal: string
  status: string
  tasks: Task[]
}

interface OrchestrationSummaryProps {
  runs: Run[]
}

const TASK_STATUS_COLORS: Record<string, string> = {
  completed: "bg-green-400",
  running: "bg-cyan-400 animate-pulse",
  queued: "bg-zinc-600",
  failed: "bg-red-400",
  stuck: "bg-orange-400",
  skipped: "bg-zinc-500",
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text
  return text.slice(0, maxLen - 1) + "\u2026"
}

const RunCard = memo(function RunCard({ run }: { run: Run }) {
  const completedCount = run.tasks.filter(
    (t) => t.status === "completed",
  ).length
  const totalCount = run.tasks.length
  const progressPct =
    totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0

  const isTerminal = ["completed", "failed", "cancelled"].includes(run.status)

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/30 p-3 space-y-2.5">
      {/* Goal */}
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm text-zinc-200 font-medium leading-snug">
          {truncate(run.userGoal, 120)}
        </p>
        <span
          className={cn(
            "text-[10px] font-medium px-1.5 py-0.5 rounded shrink-0 capitalize",
            run.status === "running"
              ? "bg-green-400/10 text-green-400"
              : run.status === "completed"
                ? "bg-blue-400/10 text-blue-400"
                : run.status === "failed"
                  ? "bg-red-400/10 text-red-400"
                  : "bg-zinc-700/50 text-zinc-400",
          )}
        >
          {run.status}
        </span>
      </div>

      {/* Progress bar */}
      <div className="space-y-1">
        <div className="flex items-center justify-between text-[11px] text-zinc-500">
          <span>
            {completedCount}/{totalCount} tasks
          </span>
          <span>{progressPct}%</span>
        </div>
        <div className="h-1.5 rounded-full bg-zinc-800 overflow-hidden">
          <div
            className={cn(
              "h-full rounded-full transition-all duration-500 ease-out",
              isTerminal && run.status === "completed"
                ? "bg-green-500"
                : isTerminal && run.status === "failed"
                  ? "bg-red-500"
                  : "bg-cyan-500",
            )}
            style={{ width: `${progressPct}%` }}
          />
        </div>
      </div>

      {/* Task status dots */}
      {run.tasks.length > 0 && (
        <div className="flex items-center gap-1 flex-wrap">
          {run.tasks.map((task) => (
            <span
              key={task.id}
              className={cn(
                "w-2.5 h-2.5 rounded-full",
                TASK_STATUS_COLORS[task.status] ?? "bg-zinc-700",
              )}
              title={`${task.name}: ${task.status}`}
            />
          ))}
        </div>
      )}
    </div>
  )
})

export const OrchestrationSummary = memo(function OrchestrationSummary({
  runs,
}: OrchestrationSummaryProps) {
  if (runs.length === 0) {
    return (
      <p className="text-xs text-zinc-600 italic pt-3">
        No orchestration runs.
      </p>
    )
  }

  return (
    <div className="space-y-2 pt-3">
      {runs.map((run) => (
        <RunCard key={run.id} run={run} />
      ))}
    </div>
  )
})
