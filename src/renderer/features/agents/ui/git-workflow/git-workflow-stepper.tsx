import { Check } from "lucide-react"
import { cn } from "../../../../lib/utils"
import type { WorkflowStage } from "./use-git-workflow"

const STAGES: { id: WorkflowStage; label: string }[] = [
  { id: "LOCAL_CHANGES", label: "Changes" },
  { id: "COMMITTED", label: "Commit" },
  { id: "PUSHED", label: "Push" },
  { id: "PR_OPEN", label: "PR" },
  { id: "MERGED", label: "Merged" },
]

interface GitWorkflowStepperProps {
  stage: WorkflowStage
}

export function GitWorkflowStepper({ stage }: GitWorkflowStepperProps) {
  const currentIdx = STAGES.findIndex((s) => s.id === stage)

  return (
    <div className="px-3 py-2">
      <div className="flex items-center gap-0">
        {STAGES.map((s, idx) => {
          const isDone = currentIdx > idx
          const isCurrent = currentIdx === idx
          const isLast = idx === STAGES.length - 1

          return (
            <div key={s.id} className="flex items-center flex-1 min-w-0">
              {/* Node */}
              <div className="flex flex-col items-center gap-1 flex-shrink-0">
                <div
                  className={cn(
                    "h-5 w-5 rounded-full border-2 flex items-center justify-center transition-all",
                    isDone && "bg-green-500/20 border-green-500/60",
                    isCurrent && "bg-blue-500/20 border-blue-400 shadow-[0_0_8px_rgba(96,165,250,0.3)]",
                    !isDone && !isCurrent && "bg-transparent border-muted-foreground/25",
                  )}
                >
                  {isDone ? (
                    <Check className="h-2.5 w-2.5 text-green-400" />
                  ) : isCurrent ? (
                    <div className="h-1.5 w-1.5 rounded-full bg-blue-400" />
                  ) : null}
                </div>
                <span
                  className={cn(
                    "text-[9px] font-medium whitespace-nowrap",
                    isCurrent && "text-blue-400",
                    isDone && "text-green-500/70",
                    !isDone && !isCurrent && "text-muted-foreground/40",
                  )}
                >
                  {s.label}
                </span>
              </div>

              {/* Connector */}
              {!isLast && (
                <div
                  className={cn(
                    "h-0.5 flex-1 mx-1 mb-3 transition-colors",
                    isDone ? "bg-green-500/40" : "bg-muted-foreground/15",
                  )}
                />
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
