import { AlertTriangle } from "lucide-react"
import { Button } from "../../../components/ui/button"
import { trpc } from "../../../lib/trpc"
import { useOrchestrationStore } from "../stores/orchestration-store"

export function ApprovalDialog() {
  const approvalQueue = useOrchestrationStore((s) => s.approvalQueue)
  const removeApproval = useOrchestrationStore((s) => s.removeApproval)
  const approveMutation = trpc.orchestration.approveTask.useMutation()

  const current = approvalQueue[0]
  if (!current) return null

  const handleApprove = () => {
    approveMutation.mutate({ taskId: current.taskId, approved: true })
    removeApproval(current.taskId)
  }

  const handleReject = () => {
    approveMutation.mutate({ taskId: current.taskId, approved: false })
    removeApproval(current.taskId)
  }

  return (
    <div className="border rounded-lg bg-yellow-500/5 border-yellow-500/20 p-3 space-y-2">
      <div className="flex items-center gap-2">
        <AlertTriangle className="h-3.5 w-3.5 text-yellow-500 shrink-0" />
        <span className="text-xs font-medium text-yellow-500">Approval Required</span>
        {approvalQueue.length > 1 && (
          <span className="text-[10px] text-muted-foreground">
            +{approvalQueue.length - 1} more
          </span>
        )}
      </div>
      <p className="text-xs text-foreground pl-5">{current.description}</p>
      <div className="flex items-center gap-2 pl-5">
        <Button
          size="sm"
          variant="default"
          className="h-6 text-[10px] px-2"
          onClick={handleApprove}
          disabled={approveMutation.isPending}
        >
          Approve
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 text-[10px] px-2"
          onClick={handleReject}
          disabled={approveMutation.isPending}
        >
          Skip
        </Button>
      </div>
    </div>
  )
}
