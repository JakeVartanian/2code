import { useState } from "react"
import type { OrchestrationTaskState } from "../stores/orchestration-store"
import { TaskDetail } from "./task-detail"

const STATUS_COLORS: Record<string, string> = {
  pending: "bg-muted-foreground/30",
  blocked: "bg-yellow-500/50",
  running: "bg-blue-500",
  completed: "bg-green-500",
  failed: "bg-red-500",
  skipped: "bg-muted-foreground/20",
}

interface TaskGraphViewProps {
  tasks: OrchestrationTaskState[]
}

export function TaskGraphView({ tasks }: TaskGraphViewProps) {
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)

  if (tasks.length === 0) {
    return (
      <div className="text-xs text-muted-foreground text-center py-4">
        No tasks yet
      </div>
    )
  }

  // Progress bar
  const completed = tasks.filter((t) => t.status === "completed").length
  const failed = tasks.filter((t) => t.status === "failed").length
  const running = tasks.filter((t) => t.status === "running").length
  const total = tasks.length

  return (
    <div className="space-y-3">
      {/* Progress summary */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between text-[10px] text-muted-foreground">
          <span>
            {completed}/{total} tasks complete
            {running > 0 && ` (${running} running)`}
            {failed > 0 && ` (${failed} failed)`}
          </span>
          <span>{Math.round((completed / total) * 100)}%</span>
        </div>
        {/* Status dot bar */}
        <div className="flex gap-0.5 h-1.5 rounded-full overflow-hidden bg-muted">
          {tasks.map((task) => (
            <div
              key={task.id}
              className={`flex-1 rounded-full transition-colors duration-300 ${
                STATUS_COLORS[task.status] || STATUS_COLORS.pending
              } ${task.status === "running" ? "animate-pulse" : ""}`}
            />
          ))}
        </div>
      </div>

      {/* Task list */}
      <div className="space-y-1">
        {tasks.map((task) => (
          <TaskDetail
            key={task.id}
            task={task}
            isSelected={selectedTaskId === task.id}
            onSelect={() =>
              setSelectedTaskId(selectedTaskId === task.id ? null : task.id)
            }
          />
        ))}
      </div>
    </div>
  )
}
