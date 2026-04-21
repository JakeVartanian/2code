/**
 * RecentRuns — timeline of past audit runs with expandable findings.
 */

import { memo, useState } from "react"
import { motion, AnimatePresence } from "motion/react"
import {
  ChevronDown, ChevronRight, Clock, RotateCcw,
  AlertTriangle, AlertCircle, Info, Loader2,
} from "lucide-react"
import { cn } from "../../../../../lib/utils"
import { trpc } from "../../../../../lib/trpc"

interface RecentRunsProps {
  projectId: string
  chatId: string
}

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

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const secs = Math.round(ms / 1000)
  if (secs < 60) return `${secs}s`
  return `${Math.floor(secs / 60)}m ${secs % 60}s`
}

function scoreColor(score: number): string {
  if (score >= 80) return "text-green-400"
  if (score >= 60) return "text-cyan-400"
  if (score >= 40) return "text-amber-400"
  return "text-red-400"
}

const TRIGGER_LABELS: Record<string, string> = {
  "manual-zone": "Zone",
  "manual-all": "Full",
  "on-commit": "Commit",
  scheduled: "Scheduled",
  skill: "Skill",
}

export const RecentRuns = memo(function RecentRuns({ projectId, chatId }: RecentRunsProps) {
  const [expandedRun, setExpandedRun] = useState<string | null>(null)

  const runsQuery = trpc.ambient.listAuditRuns.useQuery(
    { projectId, limit: 10 },
    { refetchInterval: 30_000, placeholderData: (prev) => prev },
  )

  const runs = runsQuery.data?.runs ?? []

  if (runs.length === 0) {
    return (
      <div className="py-6 text-center">
        <p className="text-xs text-zinc-600">
          No audits yet. Click <span className="text-cyan-400">Audit All</span> above or audit individual zones to get started.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-2 pt-3">
      {runs.map((run: any) => (
        <RunRow
          key={run.id}
          run={run}
          isExpanded={expandedRun === run.id}
          onToggle={() => setExpandedRun(expandedRun === run.id ? null : run.id)}
          chatId={chatId}
          projectId={projectId}
        />
      ))}
    </div>
  )
})

function RunRow({
  run,
  isExpanded,
  onToggle,
  chatId,
  projectId,
}: {
  run: any
  isExpanded: boolean
  onToggle: () => void
  chatId: string
  projectId: string
}) {
  const isRunning = run.status === "running"

  return (
    <div className="rounded-lg border border-zinc-800/60 bg-zinc-900/30 overflow-hidden">
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-3 px-3 py-2.5 hover:bg-zinc-800/30 transition-colors"
      >
        {isExpanded
          ? <ChevronDown className="w-3 h-3 text-zinc-500 shrink-0" />
          : <ChevronRight className="w-3 h-3 text-zinc-500 shrink-0" />}

        {/* Status indicator */}
        {isRunning ? (
          <Loader2 className="w-3 h-3 text-cyan-400 animate-spin shrink-0" />
        ) : (
          <div className={cn(
            "w-2 h-2 rounded-full shrink-0",
            run.status === "completed" ? "bg-green-500" :
            run.status === "failed" ? "bg-red-500" :
            run.status === "cancelled" ? "bg-zinc-500" : "bg-cyan-500",
          )} />
        )}

        {/* Trigger badge */}
        <span className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400 shrink-0">
          {TRIGGER_LABELS[run.trigger] || run.trigger}
        </span>

        {/* Zones */}
        <div className="flex items-center gap-1 min-w-0 flex-1">
          {run.zones?.slice(0, 3).map((z: any) => (
            <span key={z.zoneId} className="text-[10px] text-zinc-500 truncate">
              {z.zoneName}
            </span>
          ))}
          {run.zones?.length > 3 && (
            <span className="text-[10px] text-zinc-600">+{run.zones.length - 3}</span>
          )}
        </div>

        {/* Severity dots */}
        <div className="flex items-center gap-1.5 shrink-0">
          {run.errorCount > 0 && (
            <span className="flex items-center gap-0.5 text-[9px] font-mono text-red-400">
              <AlertCircle className="w-2.5 h-2.5" />{run.errorCount}
            </span>
          )}
          {run.warningCount > 0 && (
            <span className="flex items-center gap-0.5 text-[9px] font-mono text-amber-400">
              <AlertTriangle className="w-2.5 h-2.5" />{run.warningCount}
            </span>
          )}
          {run.infoCount > 0 && (
            <span className="flex items-center gap-0.5 text-[9px] font-mono text-blue-400">
              <Info className="w-2.5 h-2.5" />{run.infoCount}
            </span>
          )}
        </div>

        {/* Score */}
        <span className={cn("text-[10px] font-mono font-semibold shrink-0", scoreColor(run.overallScore))}>
          {run.overallScore}
        </span>

        {/* Time */}
        <span className="text-[9px] font-mono text-zinc-600 shrink-0">
          {relativeTime(run.startedAt)}
        </span>
      </button>

      {/* Expanded: show findings */}
      <AnimatePresence>
        {isExpanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <ExpandedRunDetails runId={run.id} chatId={chatId} projectId={projectId} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function ExpandedRunDetails({ runId, chatId, projectId }: { runId: string; chatId: string; projectId: string }) {
  const runQuery = trpc.ambient.getAuditRun.useQuery({ runId })
  const resolveMutation = trpc.ambient.resolveAuditFinding.useMutation()
  const dismissMutation = trpc.ambient.dismissAuditFinding.useMutation()
  const utils = trpc.useUtils()

  const run = runQuery.data as any
  if (!run) return <div className="px-3 py-4 text-[10px] text-zinc-600">Loading...</div>

  const findings = run.findings ?? []

  return (
    <div className="border-t border-zinc-800/40 px-3 py-3 space-y-2">
      {/* Run meta */}
      <div className="flex items-center gap-3 text-[9px] font-mono text-zinc-600">
        <span><Clock className="w-2.5 h-2.5 inline mr-1" />{formatDuration(run.durationMs)}</span>
        <span>{run.totalFindings} finding{run.totalFindings !== 1 ? "s" : ""}</span>
        {run.partialErrors?.length > 0 && (
          <span className="text-amber-500">{run.partialErrors.length} zone error{run.partialErrors.length !== 1 ? "s" : ""}</span>
        )}
      </div>

      {/* Findings list */}
      {findings.length === 0 ? (
        <p className="text-[10px] text-zinc-600">No findings in this run.</p>
      ) : (
        <div className="space-y-1.5">
          {findings.map((f: any) => (
            <div key={f.id} className="flex items-start gap-2 px-2 py-1.5 rounded bg-zinc-800/30">
              <span className={cn(
                "text-[8px] font-mono px-1 py-0.5 rounded shrink-0 mt-0.5",
                f.severity === "error" ? "bg-red-500/15 text-red-400" :
                f.severity === "warning" ? "bg-amber-500/15 text-amber-400" :
                "bg-blue-500/15 text-blue-400",
              )}>
                {f.severity}
              </span>
              <div className="flex-1 min-w-0">
                <p className="text-[10px] text-zinc-300 truncate">{f.title}</p>
                <p className="text-[9px] text-zinc-600 truncate">{f.zoneName}</p>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                {f.status === "open" && (
                  <>
                    <button
                      onClick={() => {
                        resolveMutation.mutate({ findingId: f.id, chatId }, {
                          onSuccess: () => {
                            utils.ambient.getAuditRun.invalidate({ runId })
                            utils.ambient.listAuditFindings.invalidate({ projectId })
                          },
                        })
                      }}
                      className="text-[8px] font-mono px-1.5 py-0.5 rounded text-cyan-400 hover:bg-cyan-500/10 transition-colors"
                    >
                      Fix
                    </button>
                    <button
                      onClick={() => {
                        dismissMutation.mutate({ findingId: f.id, reason: "not-relevant" }, {
                          onSuccess: () => {
                            utils.ambient.getAuditRun.invalidate({ runId })
                            utils.ambient.listAuditFindings.invalidate({ projectId })
                          },
                        })
                      }}
                      className="text-[8px] font-mono px-1.5 py-0.5 rounded text-zinc-600 hover:bg-zinc-700/50 transition-colors"
                    >
                      Dismiss
                    </button>
                  </>
                )}
                {f.status === "resolved" && (
                  <span className="text-[8px] font-mono text-green-500">Resolved</span>
                )}
                {f.status === "dismissed" && (
                  <span className="text-[8px] font-mono text-zinc-600">Dismissed</span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
