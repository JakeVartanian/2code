import { ChevronDown, ChevronRight, AlertCircle, CheckCircle2, Clock, Loader2, Ban } from "lucide-react"
import { useState } from "react"
import { Badge } from "../../../components/ui/badge"
import type { OrchestrationTaskState } from "../stores/orchestration-store"

const STATUS_CONFIG: Record<string, { color: string; icon: typeof Clock; label: string }> = {
  pending: { color: "bg-muted text-muted-foreground", icon: Clock, label: "Pending" },
  blocked: { color: "bg-yellow-500/10 text-yellow-500", icon: Ban, label: "Blocked" },
  running: { color: "bg-blue-500/10 text-blue-500", icon: Loader2, label: "Running" },
  completed: { color: "bg-green-500/10 text-green-500", icon: CheckCircle2, label: "Done" },
  failed: { color: "bg-red-500/10 text-red-500", icon: AlertCircle, label: "Failed" },
  skipped: { color: "bg-muted text-muted-foreground", icon: Ban, label: "Skipped" },
}

const WORKER_LABELS: Record<string, string> = {
  researcher: "Researcher",
  implementer: "Implementer",
  reviewer: "Reviewer",
  planner: "Planner",
}

interface TaskDetailProps {
  task: OrchestrationTaskState
  isSelected: boolean
  onSelect: () => void
}

export function TaskDetail({ task, isSelected, onSelect }: TaskDetailProps) {
  const config = STATUS_CONFIG[task.status] || STATUS_CONFIG.pending!
  const StatusIcon = config.icon

  return (
    <div className="border rounded-md overflow-hidden">
      <button
        onClick={onSelect}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-muted/50 transition-colors"
      >
        {isSelected ? (
          <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
        )}
        <StatusIcon
          className={`h-3.5 w-3.5 shrink-0 ${
            task.status === "running" ? "animate-spin text-blue-500" : ""
          } ${config.color.split(" ").find((c) => c.startsWith("text-")) || ""}`}
        />
        <span className="text-xs truncate flex-1">{task.description}</span>
        <Badge variant="outline" className="text-[9px] px-1 py-0 shrink-0">
          {WORKER_LABELS[task.workerType] || task.workerType}
        </Badge>
      </button>

      {isSelected && (
        <div className="px-3 pb-3 pt-1 border-t bg-muted/30 space-y-2">
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-muted-foreground">Status:</span>
            <Badge className={`text-[9px] px-1.5 py-0 ${config.color}`}>
              {config.label}
            </Badge>
          </div>

          {task.result && (
            <div className="space-y-1">
              <span className="text-[10px] text-muted-foreground">Result:</span>
              <p className="text-xs text-foreground">{task.result.summary}</p>
              {task.result.filesChanged && task.result.filesChanged.length > 0 && (
                <div>
                  <span className="text-[10px] text-muted-foreground">Files changed:</span>
                  <ul className="text-[10px] text-muted-foreground ml-3 list-disc">
                    {task.result.filesChanged.map((f) => (
                      <li key={f}>{f}</li>
                    ))}
                  </ul>
                </div>
              )}
              {task.result.issues && task.result.issues.length > 0 && (
                <div>
                  <span className="text-[10px] text-red-400">Issues:</span>
                  <ul className="text-[10px] text-red-400 ml-3 list-disc">
                    {task.result.issues.map((issue, i) => (
                      <li key={i}>{issue}</li>
                    ))}
                  </ul>
                </div>
              )}
              {task.result.findings && task.result.findings.length > 0 && (
                <div>
                  <span className="text-[10px] text-muted-foreground">Findings:</span>
                  <ul className="text-[10px] text-muted-foreground ml-3 list-disc">
                    {task.result.findings.map((f, i) => (
                      <li key={i}>{f}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          {task.error && (
            <div className="text-xs text-red-400 bg-red-500/5 rounded p-2">
              {task.error}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
