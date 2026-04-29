import { useAtomValue } from "jotai"
import { Clock, X } from "lucide-react"
import { memo, useCallback, useEffect, useState } from "react"
import { Button } from "../../../components/ui/button"
import { appStore } from "../../../lib/jotai-store"
import { pendingTasksAtom } from "../atoms"

function formatCountdown(ms: number): string {
  if (ms <= 0) return "any moment"
  const totalSeconds = Math.ceil(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes > 0) return `${minutes}:${seconds.toString().padStart(2, "0")}`
  return `0:${seconds.toString().padStart(2, "0")}`
}

interface PendingTaskBannerProps {
  subChatId: string
}

export const PendingTaskBanner = memo(function PendingTaskBanner({
  subChatId,
}: PendingTaskBannerProps) {
  const pendingTasks = useAtomValue(pendingTasksAtom)
  const task = pendingTasks.get(subChatId)
  const [now, setNow] = useState(Date.now())

  // Tick every second while a task is pending
  useEffect(() => {
    if (!task) return
    const interval = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(interval)
  }, [task])

  const handleCancel = useCallback(() => {
    const current = appStore.get(pendingTasksAtom)
    if (current.has(subChatId)) {
      const next = new Map(current)
      next.delete(subChatId)
      appStore.set(pendingTasksAtom, next)
    }
  }, [subChatId])

  if (!task) return null

  const elapsed = now - task.scheduledAt
  const remaining = task.estimatedMs ? task.estimatedMs - elapsed : null
  const hasEstimate = remaining !== null
  // If past estimated time, show "any moment"
  const displayTime = hasEstimate && remaining > 0 ? formatCountdown(remaining) : null
  const isPastDue = hasEstimate && remaining <= 0

  // Progress percentage (0 to 1)
  const progress =
    hasEstimate && task.estimatedMs! > 0
      ? Math.min(elapsed / task.estimatedMs!, 1)
      : null

  return (
    <div className="border border-border bg-muted/30 overflow-hidden flex flex-col rounded-t-xl border-b-0 pb-6">
      {/* Progress bar */}
      {progress !== null && (
        <div className="h-0.5 w-full bg-muted/50">
          <div
            className="h-full bg-blue-500/60 transition-all duration-1000 ease-linear"
            style={{ width: `${progress * 100}%` }}
          />
        </div>
      )}

      <div className="flex items-center justify-between pr-1 pl-3 h-8">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Clock className="w-3.5 h-3.5 text-blue-400 animate-pulse" />
          <span>
            {isPastDue ? (
              <>Checking back any moment<PulsingDots /></>
            ) : displayTime ? (
              <>Checking back in <span className="font-mono tabular-nums text-foreground/80">{displayTime}</span></>
            ) : (
              <>Waiting for scheduled task<PulsingDots /></>
            )}
          </span>
          <span className="text-muted-foreground/60 truncate max-w-[200px]">
            {task.description}
          </span>
        </div>

        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 text-muted-foreground hover:text-foreground"
          onClick={handleCancel}
          title="Dismiss"
        >
          <X className="w-3.5 h-3.5" />
        </Button>
      </div>
    </div>
  )
})

function PulsingDots() {
  const [dotCount, setDotCount] = useState(1)

  useEffect(() => {
    const interval = setInterval(() => {
      setDotCount((prev) => (prev % 3) + 1)
    }, 800)
    return () => clearInterval(interval)
  }, [])

  return <span className="inline-block w-[1em] text-left">{".".repeat(dotCount)}</span>
}
