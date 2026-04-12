import { Pause, Play, Square } from "lucide-react"
import { Button } from "../../../components/ui/button"
import { trpc } from "../../../lib/trpc"

interface OrchestrationControlsProps {
  runId: string
  status: string
}

export function OrchestrationControls({ runId, status }: OrchestrationControlsProps) {
  const pauseMutation = trpc.orchestration.pause.useMutation()
  const resumeMutation = trpc.orchestration.resume.useMutation()
  const stopMutation = trpc.orchestration.stop.useMutation()

  const isRunning = status === "planning" || status === "executing" || status === "reviewing"
  const isPaused = status === "paused"
  const isTerminal = status === "completed" || status === "failed"

  if (isTerminal) return null

  return (
    <div className="flex items-center gap-1 pl-5">
      {isRunning && (
        <Button
          variant="ghost"
          size="sm"
          className="h-6 text-[10px] px-2 gap-1"
          onClick={() => pauseMutation.mutate({ runId })}
          disabled={pauseMutation.isPending}
        >
          <Pause className="h-3 w-3" />
          Pause
        </Button>
      )}
      {isPaused && (
        <Button
          variant="ghost"
          size="sm"
          className="h-6 text-[10px] px-2 gap-1"
          onClick={() => resumeMutation.mutate({ runId })}
          disabled={resumeMutation.isPending}
        >
          <Play className="h-3 w-3" />
          Resume
        </Button>
      )}
      {(isRunning || isPaused) && (
        <Button
          variant="ghost"
          size="sm"
          className="h-6 text-[10px] px-2 gap-1 text-red-400 hover:text-red-300"
          onClick={() => stopMutation.mutate({ runId })}
          disabled={stopMutation.isPending}
        >
          <Square className="h-3 w-3" />
          Stop
        </Button>
      )}
    </div>
  )
}
