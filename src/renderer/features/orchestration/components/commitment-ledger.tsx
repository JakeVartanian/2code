import { CheckCircle2, Circle, Loader2, XCircle, Ban } from "lucide-react"
import { Badge } from "../../../components/ui/badge"
import { trpc } from "../../../lib/trpc"

interface CommitmentLedgerProps {
  chatId: string
}

/**
 * Commitment Ledger — a read-only view of orchestration tasks as a persistent checklist.
 * This is the "commitment ledger" concept: the orchestration task graph surfaced
 * as a simple, scannable list of what was committed to and what got done.
 */
export function CommitmentLedger({ chatId }: CommitmentLedgerProps) {
  const { data: runs } = trpc.orchestration.listRuns.useQuery(
    { chatId },
    { staleTime: 10_000 },
  )

  if (!runs || runs.length === 0) return null

  // Show the most recent run
  const latestRun = runs[runs.length - 1]!

  return <RunLedger runId={latestRun.id} goal={latestRun.goal} status={latestRun.status} />
}

function RunLedger({ runId, goal, status }: { runId: string; goal: string; status: string }) {
  const { data } = trpc.orchestration.getStatus.useQuery(
    { runId },
    { staleTime: 5_000 },
  )

  if (!data) return null

  const tasks = data.tasks
  const completed = tasks.filter((t) => t.status === "completed").length
  const total = tasks.length

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-[11px] text-muted-foreground line-clamp-1">
          {goal}
        </span>
        <Badge
          variant="outline"
          className="text-[9px] px-1.5 py-0 shrink-0 ml-2"
        >
          {completed}/{total}
        </Badge>
      </div>

      <div className="space-y-0.5">
        {tasks.map((task) => (
          <div key={task.id} className="flex items-center gap-2 py-0.5">
            <StatusIcon status={task.status} />
            <span
              className={`text-[11px] flex-1 ${
                task.status === "completed"
                  ? "text-muted-foreground line-through"
                  : task.status === "failed"
                    ? "text-red-400"
                    : task.status === "skipped"
                      ? "text-muted-foreground/50 line-through"
                      : "text-foreground"
              }`}
            >
              {task.description}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

function StatusIcon({ status }: { status: string }) {
  switch (status) {
    case "completed":
      return <CheckCircle2 className="h-3 w-3 shrink-0 text-green-500" />
    case "running":
      return <Loader2 className="h-3 w-3 shrink-0 text-blue-500 animate-spin" />
    case "failed":
      return <XCircle className="h-3 w-3 shrink-0 text-red-500" />
    case "skipped":
      return <Ban className="h-3 w-3 shrink-0 text-muted-foreground/50" />
    default:
      return <Circle className="h-3 w-3 shrink-0 text-muted-foreground/30" />
  }
}
