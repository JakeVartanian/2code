import { useAtom } from "jotai"
import { X, Workflow, DollarSign, Clock } from "lucide-react"
import { useEffect, useMemo } from "react"
import { Button } from "../../../components/ui/button"
import { Badge } from "../../../components/ui/badge"
import { trpc } from "../../../lib/trpc"
import {
  orchestrationPanelOpenAtom,
  orchestrationSelectedRunIdAtom,
} from "../atoms"
import { useOrchestrationStore } from "../stores/orchestration-store"
import { TaskGraphView } from "./task-graph-view"
import { ApprovalDialog } from "./approval-dialog"
import { OrchestrationControls } from "./orchestration-controls"

interface OrchestrationPanelProps {
  chatId: string
}

export function OrchestrationPanel({ chatId }: OrchestrationPanelProps) {
  const [isOpen, setIsOpen] = useAtom(orchestrationPanelOpenAtom)
  const [selectedRunId, setSelectedRunId] = useAtom(orchestrationSelectedRunIdAtom)
  const handleEvent = useOrchestrationStore((s) => s.handleEvent)
  const runs = useOrchestrationStore((s) => s.runs)

  // Fetch runs list from DB
  const { data: dbRuns } = trpc.orchestration.listRuns.useQuery(
    { chatId },
    { enabled: isOpen, staleTime: 5_000 },
  )

  // Auto-select the latest run
  useEffect(() => {
    if (!selectedRunId && dbRuns && dbRuns.length > 0) {
      setSelectedRunId(dbRuns[dbRuns.length - 1]!.id)
    }
  }, [dbRuns, selectedRunId, setSelectedRunId])

  // Subscribe to progress events for the selected run
  trpc.orchestration.onProgress.useSubscription(
    { runId: selectedRunId! },
    {
      enabled: !!selectedRunId,
      onData: handleEvent,
    },
  )

  // Get full status from DB for selected run
  const { data: runStatus } = trpc.orchestration.getStatus.useQuery(
    { runId: selectedRunId! },
    { enabled: !!selectedRunId, refetchInterval: 3_000 },
  )

  // Merge DB tasks with live store state
  const activeRun = selectedRunId ? runs[selectedRunId] : undefined
  const tasks = useMemo(() => {
    if (activeRun?.tasks.length) return activeRun.tasks
    if (runStatus?.tasks) {
      return runStatus.tasks.map((t) => ({
        id: t.id,
        description: t.description,
        workerType: t.workerType,
        status: t.status,
        result: t.result ?? undefined,
        error: t.error ?? undefined,
      }))
    }
    return []
  }, [activeRun?.tasks, runStatus?.tasks])

  const status = activeRun?.status || runStatus?.run?.status || "unknown"
  const goal = activeRun?.goal || runStatus?.run?.goal || ""

  if (!isOpen) return null

  return (
    <div className="border-b bg-background">
      <div className="px-3 py-2 space-y-2 max-h-[40vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Workflow className="h-3.5 w-3.5 text-foreground" />
            <span className="text-xs font-medium">Orchestration</span>
            <StatusBadge status={status} />
          </div>
          <div className="flex items-center gap-1">
            {activeRun && (
              <div className="flex items-center gap-2 text-[10px] text-muted-foreground mr-2">
                <span className="flex items-center gap-0.5">
                  <DollarSign className="h-2.5 w-2.5" />
                  {activeRun.costUsd.toFixed(4)}
                </span>
              </div>
            )}
            <Button
              variant="ghost"
              size="sm"
              className="h-5 w-5 p-0"
              onClick={() => setIsOpen(false)}
            >
              <X className="h-3 w-3" />
            </Button>
          </div>
        </div>

        {/* Goal */}
        {goal && (
          <p className="text-[11px] text-muted-foreground line-clamp-2 pl-5">
            {goal}
          </p>
        )}

        {/* Controls */}
        {selectedRunId && (
          <OrchestrationControls runId={selectedRunId} status={status} />
        )}

        {/* Approval dialog */}
        <ApprovalDialog />

        {/* Task graph */}
        <TaskGraphView tasks={tasks} />

        {/* Run selector if multiple runs */}
        {dbRuns && dbRuns.length > 1 && (
          <div className="flex items-center gap-1 pt-1 border-t">
            <span className="text-[10px] text-muted-foreground">Runs:</span>
            {dbRuns.map((run) => (
              <button
                key={run.id}
                onClick={() => setSelectedRunId(run.id)}
                className={`text-[10px] px-1.5 py-0.5 rounded ${
                  selectedRunId === run.id
                    ? "bg-foreground/10 text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {run.goal.slice(0, 20)}...
              </button>
            ))}
          </div>
        )}

        {/* Empty state */}
        {!selectedRunId && (!dbRuns || dbRuns.length === 0) && (
          <div className="text-xs text-muted-foreground text-center py-6">
            No orchestration runs yet. Send a message with orchestration enabled to start.
          </div>
        )}
      </div>
    </div>
  )
}

function StatusBadge({ status }: { status: string }) {
  const config: Record<string, { color: string; label: string }> = {
    planning: { color: "bg-blue-500/10 text-blue-500", label: "Planning" },
    executing: { color: "bg-blue-500/10 text-blue-500", label: "Executing" },
    reviewing: { color: "bg-purple-500/10 text-purple-500", label: "Reviewing" },
    completed: { color: "bg-green-500/10 text-green-500", label: "Completed" },
    failed: { color: "bg-red-500/10 text-red-500", label: "Failed" },
    paused: { color: "bg-yellow-500/10 text-yellow-500", label: "Paused" },
  }

  const c = config[status]
  if (!c) return null

  return (
    <Badge className={`text-[9px] px-1.5 py-0 ${c.color}`}>
      {c.label}
    </Badge>
  )
}
