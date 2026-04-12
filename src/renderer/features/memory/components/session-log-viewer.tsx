import { Clock } from "lucide-react"
import { trpc } from "../../../lib/trpc"

interface SessionLogViewerProps {
  projectPath: string
}

export function SessionLogViewer({ projectPath }: SessionLogViewerProps) {
  const { data: logs } = trpc.memory.getSessionLogs.useQuery(
    { projectPath, limit: 20 },
    { staleTime: 30_000 },
  )

  if (!logs || logs.length === 0) {
    return (
      <p className="text-xs text-muted-foreground py-4 text-center">
        No session logs yet
      </p>
    )
  }

  return (
    <div className="space-y-1.5">
      {logs.map((log) => (
        <div
          key={log.filename}
          className="flex items-start gap-2 p-1.5 rounded-md hover:bg-foreground/5 transition-colors"
        >
          <Clock className="h-3 w-3 text-muted-foreground mt-0.5 shrink-0" />
          <div className="min-w-0">
            <span className="text-[10px] text-muted-foreground">{log.date}</span>
            <p className="text-[11px] text-foreground/80 truncate">{log.slug}</p>
            {log.summary && (
              <p className="text-[10px] text-muted-foreground truncate">{log.summary}</p>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}
