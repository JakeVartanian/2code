/**
 * FindingsBrowser — filterable, paginated list of audit findings.
 * Findings persist until explicitly resolved or dismissed.
 */

import { memo, useState } from "react"
import {
  AlertCircle, AlertTriangle, Info,
  ChevronLeft, ChevronRight, FileCode2,
} from "lucide-react"
import { cn } from "../../../../../lib/utils"
import { trpc } from "../../../../../lib/trpc"

interface FindingsBrowserProps {
  projectId: string
  chatId: string
}

const STATUS_OPTIONS = [
  { value: "open", label: "Open" },
  { value: "resolved", label: "Resolved" },
  { value: "dismissed", label: "Dismissed" },
  { value: "wont-fix", label: "Won't Fix" },
]

const SEVERITY_OPTIONS = [
  { value: "", label: "All" },
  { value: "error", label: "Error" },
  { value: "warning", label: "Warning" },
  { value: "info", label: "Info" },
]

function relativeTime(ts: string | Date | null): string {
  if (!ts) return ""
  const diff = Date.now() - new Date(ts).getTime()
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return "just now"
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  return `${days}d ago`
}

export const FindingsBrowser = memo(function FindingsBrowser({ projectId, chatId }: FindingsBrowserProps) {
  const [status, setStatus] = useState("open")
  const [severity, setSeverity] = useState("")
  const [cursor, setCursor] = useState<string | undefined>()

  const findingsQuery = trpc.ambient.listAuditFindings.useQuery(
    {
      projectId,
      status,
      severity: severity || undefined,
      limit: 20,
      cursor,
    },
    { placeholderData: (prev) => prev },
  )

  const resolveMutation = trpc.ambient.resolveAuditFinding.useMutation()
  const dismissMutation = trpc.ambient.dismissAuditFinding.useMutation()
  const utils = trpc.useUtils()

  const findings = findingsQuery.data?.findings ?? []
  const hasMore = findingsQuery.data?.hasMore ?? false

  return (
    <div className="pt-3 space-y-3">
      {/* Filter bar */}
      <div className="flex items-center gap-2 flex-wrap">
        {/* Status filter */}
        <div className="flex items-center gap-0.5 rounded-md bg-zinc-800/50 p-0.5">
          {STATUS_OPTIONS.map(opt => (
            <button
              key={opt.value}
              onClick={() => { setStatus(opt.value); setCursor(undefined) }}
              className={cn(
                "text-[9px] font-mono px-2 py-1 rounded transition-colors",
                status === opt.value
                  ? "bg-zinc-700 text-zinc-200"
                  : "text-zinc-500 hover:text-zinc-300",
              )}
            >
              {opt.label}
            </button>
          ))}
        </div>

        {/* Severity filter */}
        <div className="flex items-center gap-0.5 rounded-md bg-zinc-800/50 p-0.5">
          {SEVERITY_OPTIONS.map(opt => (
            <button
              key={opt.value}
              onClick={() => { setSeverity(opt.value); setCursor(undefined) }}
              className={cn(
                "text-[9px] font-mono px-2 py-1 rounded transition-colors",
                severity === opt.value
                  ? "bg-zinc-700 text-zinc-200"
                  : "text-zinc-500 hover:text-zinc-300",
              )}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* Findings list */}
      {findings.length === 0 ? (
        <div className="py-6 text-center">
          <p className="text-xs text-zinc-600">
            {status === "open" ? "No open findings. Run an audit to discover issues." : `No ${status} findings.`}
          </p>
        </div>
      ) : (
        <div className="space-y-1.5">
          {findings.map((f: any) => (
            <div
              key={f.id}
              className="flex items-start gap-2.5 px-3 py-2.5 rounded-lg border border-zinc-800/40 bg-zinc-900/20 hover:bg-zinc-800/20 transition-colors"
            >
              {/* Severity icon */}
              {f.severity === "error" ? <AlertCircle className="w-3.5 h-3.5 text-red-400 shrink-0 mt-0.5" /> :
               f.severity === "warning" ? <AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0 mt-0.5" /> :
               <Info className="w-3.5 h-3.5 text-blue-400 shrink-0 mt-0.5" />}

              <div className="flex-1 min-w-0 space-y-1">
                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400">
                    {f.zoneName}
                  </span>
                  <span className="text-[9px] font-mono text-zinc-600">
                    {f.category}
                  </span>
                </div>
                <p className="text-[11px] text-zinc-300 leading-relaxed">{f.title}</p>
                {f.affectedFiles?.length > 0 && (
                  <div className="flex items-center gap-1 text-[9px] text-zinc-600">
                    <FileCode2 className="w-2.5 h-2.5" />
                    <span className="truncate">{f.affectedFiles.slice(0, 2).join(", ")}</span>
                    {f.affectedFiles.length > 2 && <span>+{f.affectedFiles.length - 2}</span>}
                  </div>
                )}
              </div>

              <div className="flex flex-col items-end gap-1.5 shrink-0">
                <span className="text-[9px] font-mono text-zinc-600">{relativeTime(f.createdAt)}</span>
                <span className={cn(
                  "text-[9px] font-mono font-semibold",
                  f.confidence >= 70 ? "text-green-400/70" : f.confidence >= 40 ? "text-amber-400/70" : "text-zinc-600",
                )}>
                  {f.confidence}%
                </span>
                {f.status === "open" && (
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => resolveMutation.mutate({ findingId: f.id, chatId }, {
                        onSuccess: () => utils.ambient.listAuditFindings.invalidate({ projectId }),
                      })}
                      className="text-[8px] font-mono px-1.5 py-0.5 rounded text-cyan-400 hover:bg-cyan-500/10"
                    >
                      Fix
                    </button>
                    <button
                      onClick={() => dismissMutation.mutate({ findingId: f.id, reason: "not-relevant" }, {
                        onSuccess: () => utils.ambient.listAuditFindings.invalidate({ projectId }),
                      })}
                      className="text-[8px] font-mono px-1.5 py-0.5 rounded text-zinc-600 hover:bg-zinc-700/50"
                    >
                      Dismiss
                    </button>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Pagination */}
      {(hasMore || cursor) && (
        <div className="flex items-center justify-center gap-2 pt-2">
          {cursor && (
            <button
              onClick={() => setCursor(undefined)}
              className="flex items-center gap-1 text-[9px] font-mono text-zinc-500 hover:text-zinc-300"
            >
              <ChevronLeft className="w-3 h-3" /> First
            </button>
          )}
          {hasMore && (
            <button
              onClick={() => setCursor(findingsQuery.data?.nextCursor)}
              className="flex items-center gap-1 text-[9px] font-mono text-zinc-500 hover:text-zinc-300"
            >
              More <ChevronRight className="w-3 h-3" />
            </button>
          )}
        </div>
      )}
    </div>
  )
})
