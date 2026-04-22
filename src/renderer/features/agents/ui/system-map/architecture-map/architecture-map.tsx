/**
 * ArchitectureMap — hero visualization showing the project's system
 * architecture as interconnected zones with confidence coloring.
 */

import { memo, useMemo, useCallback, useRef, useState, useEffect } from "react"
import { motion, AnimatePresence } from "motion/react"
import { Network, RefreshCw, Sparkles, ShieldCheck, X, Info, Loader2, CheckCircle2, XCircle, Clock } from "lucide-react"
import { useAtom } from "jotai"
import { cn } from "../../../../../lib/utils"
import { trpc } from "../../../../../lib/trpc"
import { useArchitectureData } from "./use-architecture-data"
import { ZoneCard } from "./zone-card"
import { ZoneConnections } from "./zone-connections"
import { Legend } from "./legend"
import { computeLayout, ZONE_WIDTH, ZONE_HEIGHT } from "./layout"
import { auditProgressAtom, auditProgressDefaultState } from "../../../../ambient/audit-progress-atom"

// ─── Constants ───────────────────────────────────────────────────────────────

const MAP_HEIGHT = 620

// ─── Empty States ────────────────────────────────────────────────────────────

function NoBrainState({ onBuildBrain, isBuilding }: { onBuildBrain: () => void; isBuilding: boolean }) {
  return (
    <div className="flex flex-col items-center justify-center gap-4 py-20 px-8">
      <div className="w-14 h-14 rounded-2xl border border-zinc-800 bg-zinc-900/50 flex items-center justify-center">
        <Network className="w-7 h-7 text-zinc-600" />
      </div>
      <div className="text-center space-y-1.5">
        <p className="text-sm font-medium text-zinc-300">System Architecture Map</p>
        <p className="text-xs text-zinc-600 max-w-[300px] leading-relaxed">
          Build your project's brain to generate a visual map of the system architecture,
          showing how all the pieces connect.
        </p>
      </div>
      <button
        onClick={onBuildBrain}
        disabled={isBuilding}
        className={cn(
          "flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-medium transition-all duration-200",
          isBuilding
            ? "bg-zinc-800 text-zinc-500 cursor-wait"
            : "bg-cyan-500/10 text-cyan-400 border border-cyan-500/20 hover:bg-cyan-500/20 hover:border-cyan-500/30",
        )}
      >
        {isBuilding ? (
          <>
            <RefreshCw className="w-3.5 h-3.5 animate-spin" />
            Building brain...
          </>
        ) : (
          <>
            <Sparkles className="w-3.5 h-3.5" />
            Build Brain
          </>
        )}
      </button>
    </div>
  )
}

function GeneratingState() {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-20">
      <RefreshCw className="w-6 h-6 text-cyan-400 animate-spin" />
      <p className="text-xs text-zinc-500">Synthesizing architecture map...</p>
    </div>
  )
}

// ─── Audit Progress Panel ───────────────────────────────────────────────────

function AuditProgressPanel({
  progress,
  onCancel,
}: {
  progress: import("../../../../ambient/audit-progress-atom").AuditProgressState
  onCancel: () => void
}) {
  const completedCount = progress.progress.filter(p => p.status === "done" || p.status === "error").length
  const percent = progress.zoneCount > 0 ? Math.round((completedCount / progress.zoneCount) * 100) : 0

  // ETA: use actual elapsed time per zone if we have completed zones, else 45s fallback
  const elapsedMs = Date.now() - (progress.startedAt ?? Date.now())
  const avgMsPerZone = completedCount > 0 ? elapsedMs / completedCount : 45_000
  const remainingCount = progress.zoneCount - completedCount
  const etaMs = remainingCount * avgMsPerZone
  const etaMin = Math.floor(etaMs / 60_000)
  const etaSec = Math.ceil((etaMs % 60_000) / 1000)
  const etaText = remainingCount === 0
    ? "Finishing up..."
    : etaMin > 0
      ? `~${etaMin}:${String(etaSec).padStart(2, "0")} remaining`
      : `~${etaSec}s remaining`

  return (
    <div className="px-4 py-3 space-y-3 bg-zinc-900/80">
      {/* Header row */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ShieldCheck className="w-3.5 h-3.5 text-cyan-400 animate-pulse" />
          <span className="text-xs font-medium text-zinc-200">
            Auditing {completedCount} of {progress.zoneCount} zones
          </span>
          <span className="text-[10px] text-zinc-500 font-mono">{etaText}</span>
        </div>
        <button
          onClick={onCancel}
          className="flex items-center gap-1 px-2 py-1 rounded text-[10px] font-medium text-zinc-500 hover:text-red-400 hover:bg-red-500/10 transition-all duration-150"
        >
          <X className="w-3 h-3" />
          Cancel
        </button>
      </div>

      {/* Progress bar */}
      <div className="h-1.5 rounded-full bg-zinc-800 overflow-hidden">
        <motion.div
          className="h-full rounded-full bg-gradient-to-r from-cyan-500 to-cyan-400"
          initial={{ width: 0 }}
          animate={{ width: `${percent}%` }}
          transition={{ duration: 0.3, ease: "easeOut" }}
        />
      </div>

      {/* Zone status grid */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-1">
        {progress.progress.map((zone) => (
          <div key={zone.zoneId} className="flex items-center justify-between gap-2 py-0.5">
            <div className="flex items-center gap-1.5 min-w-0">
              {zone.status === "done" ? (
                <CheckCircle2 className="w-3 h-3 text-green-400 shrink-0" />
              ) : zone.status === "error" ? (
                <XCircle className="w-3 h-3 text-red-400 shrink-0" />
              ) : zone.status === "auditing" || zone.status === "profiling" ? (
                <Loader2 className="w-3 h-3 text-cyan-400 animate-spin shrink-0" />
              ) : (
                <Clock className="w-3 h-3 text-zinc-600 shrink-0" />
              )}
              <span className={cn(
                "text-[10px] font-mono truncate",
                zone.status === "done" ? "text-green-400/80"
                  : zone.status === "error" ? "text-red-400/80"
                    : zone.status === "auditing" || zone.status === "profiling" ? "text-cyan-400"
                      : "text-zinc-600",
              )}>
                {zone.zoneName}
              </span>
            </div>
            <span className={cn(
              "text-[9px] font-mono shrink-0",
              zone.status === "done" ? "text-zinc-500"
                : zone.status === "error" ? "text-red-400/60"
                  : "text-zinc-700",
            )}>
              {zone.status === "done" ? `${zone.findings} finding${zone.findings !== 1 ? "s" : ""}`
                : zone.status === "error" ? "failed"
                  : zone.status === "profiling" ? "profiling"
                    : zone.status === "auditing" ? "scanning"
                      : "queued"}
            </span>
          </div>
        ))}
      </div>

      {/* Info line */}
      <div className="flex items-start gap-1.5 pt-1">
        <Info className="w-3 h-3 text-zinc-600 shrink-0 mt-0.5" />
        <span className="text-[9px] text-zinc-600 leading-relaxed">
          AI scans each zone for bugs, security vulnerabilities, performance issues, test gaps, dead code, and dependency risks.
        </span>
      </div>
    </div>
  )
}

// ─── Main Component ──────────────────────────────────────────────────────────

interface ArchitectureMapProps {
  projectId: string | null
  projectPath: string | null
  chatId: string
}

export const ArchitectureMap = memo(function ArchitectureMap({
  projectId,
  projectPath,
}: ArchitectureMapProps) {
  const { zones, overallConfidence, hasSystemMap, hasBrain, isLoading } =
    useArchitectureData(projectId)

  const containerRef = useRef<HTMLDivElement>(null)
  const [containerWidth, setContainerWidth] = useState(1000)

  // Measure container width
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerWidth(entry.contentRect.width)
      }
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // Compute layout positions
  const positions = useMemo(
    () => computeLayout(zones, containerWidth, MAP_HEIGHT),
    [zones, containerWidth],
  )

  // Brain build mutation
  const buildBrainMutation = trpc.ambient.buildBrain.useMutation()
  const regenerateMutation = trpc.ambient.regenerateSystemMap.useMutation()
  const auditMutation = trpc.ambient.auditSystemMap.useMutation()
  const auditZoneMutation = trpc.ambient.auditZone.useMutation()
  const utils = trpc.useUtils()

  const [isBuilding, setIsBuilding] = useState(false)
  // Track which zones are currently being audited
  const [auditingZones, setAuditingZones] = useState<Set<string>>(new Set())
  // Live audit progress from subscription
  const [auditProgress, setAuditProgress] = useAtom(auditProgressAtom)
  const cancelAuditMutation = trpc.ambient.cancelAuditRun.useMutation()

  const handleBuildBrain = useCallback(async () => {
    if (!projectId || !projectPath) return
    setIsBuilding(true)
    try {
      await buildBrainMutation.mutateAsync({ projectId, projectPath })
      utils.ambient.getSystemMap.invalidate({ projectId })
      utils.ambient.getBrainStatus.invalidate({ projectId })
    } finally {
      setIsBuilding(false)
    }
  }, [projectId, projectPath, buildBrainMutation, utils])

  const handleRegenerate = useCallback(async () => {
    if (!projectId || !projectPath) return
    try {
      await regenerateMutation.mutateAsync({ projectId, projectPath })
      utils.ambient.getSystemMap.invalidate({ projectId })
    } catch (err) {
      console.error("[ArchitectureMap] Regeneration failed:", err)
    }
  }, [projectId, projectPath, regenerateMutation, utils])

  const handleAudit = useCallback(async () => {
    if (!projectId || !projectPath) return
    // Set initial progress state immediately so the panel appears
    setAuditProgress({
      isRunning: true,
      runId: null,
      startedAt: Date.now(),
      zoneCount: zones.length,
      progress: zones.map(z => ({ zoneId: z.id, zoneName: z.name, status: "pending" as const, findings: 0 })),
    })
    try {
      await auditMutation.mutateAsync({ projectId, projectPath })
      utils.ambient.listSuggestions.invalidate({ projectId })
    } catch (err) {
      console.error("[ArchitectureMap] Audit failed:", err)
      setAuditProgress(auditProgressDefaultState)
    }
  }, [projectId, projectPath, auditMutation, utils, zones, setAuditProgress])

  const handleCancelAudit = useCallback(() => {
    if (auditProgress.runId) {
      cancelAuditMutation.mutate({ runId: auditProgress.runId })
    }
    setAuditProgress(auditProgressDefaultState)
  }, [auditProgress.runId, cancelAuditMutation, setAuditProgress])

  const handleZoneAudit = useCallback(async (zoneId: string) => {
    if (!projectId || !projectPath) return
    setAuditingZones(prev => new Set(prev).add(zoneId))
    try {
      await auditZoneMutation.mutateAsync({ projectId, projectPath, zoneId })
      utils.ambient.listSuggestions.invalidate({ projectId })
    } catch (err) {
      console.error(`[ArchitectureMap] Zone audit failed for ${zoneId}:`, err)
    } finally {
      setAuditingZones(prev => {
        const next = new Set(prev)
        next.delete(zoneId)
        return next
      })
    }
  }, [projectId, projectPath, auditZoneMutation, utils])

  // No project selected
  if (!projectId || !projectPath) {
    return (
      <section className="rounded-lg border border-zinc-800 bg-zinc-900/50 overflow-hidden">
        <NoBrainState onBuildBrain={() => {}} isBuilding={false} />
      </section>
    )
  }

  return (
    <section
      aria-label="System Architecture"
      className="rounded-lg border border-zinc-800 bg-zinc-900/50 overflow-hidden"
    >
      {/* Header */}
      <div className="px-4 py-3 border-b border-zinc-800/60">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <Network className="w-4 h-4 text-cyan-400 shrink-0" />
            <span className="text-sm font-semibold text-zinc-100">System Architecture</span>
            {hasSystemMap && (
              <span className="text-[10px] font-mono font-medium px-2 py-0.5 rounded-full bg-cyan-400/10 text-cyan-400 border border-cyan-400/20">
                {overallConfidence}% confidence
              </span>
            )}
          </div>
          {hasSystemMap && (
            <div className="flex items-center gap-1">
              <button
                onClick={handleAudit}
                disabled={auditProgress.isRunning || auditMutation.isPending}
                className={cn(
                  "flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[10px] font-medium transition-all duration-150",
                  auditProgress.isRunning || auditMutation.isPending
                    ? "bg-cyan-500/10 text-cyan-400 cursor-wait"
                    : "text-zinc-500 hover:text-cyan-400 hover:bg-cyan-500/10",
                )}
                title="Scans each zone's source files with AI to find bugs, security issues, performance problems, test gaps, dead code, and dependency risks."
              >
                <ShieldCheck className={cn("w-3 h-3", (auditProgress.isRunning || auditMutation.isPending) && "animate-pulse")} />
                {auditProgress.isRunning ? `Auditing ${auditProgress.progress.filter(p => p.status === "done" || p.status === "error").length}/${auditProgress.zoneCount}` : "Audit All"}
              </button>
              <button
                onClick={handleRegenerate}
                disabled={regenerateMutation.isPending}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[10px] font-medium
                  text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/60 transition-all duration-150"
              >
                <RefreshCw className={cn("w-3 h-3", regenerateMutation.isPending && "animate-spin")} />
                Regenerate
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Audit Progress Panel */}
      <AnimatePresence>
        {auditProgress.isRunning && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden border-b border-zinc-800/60"
          >
            <AuditProgressPanel
              progress={auditProgress}
              onCancel={handleCancelAudit}
            />
          </motion.div>
        )}
      </AnimatePresence>

      {/* Content */}
      <div ref={containerRef}>
        {isLoading && !hasSystemMap ? (
          <GeneratingState />
        ) : !hasBrain ? (
          <NoBrainState onBuildBrain={handleBuildBrain} isBuilding={isBuilding} />
        ) : !hasSystemMap ? (
          <div className="flex flex-col items-center justify-center gap-4 py-20 px-8">
            <div className="w-14 h-14 rounded-2xl border border-zinc-800 bg-zinc-900/50 flex items-center justify-center">
              <Network className="w-7 h-7 text-cyan-500/60" />
            </div>
            <div className="text-center space-y-1.5">
              <p className="text-sm font-medium text-zinc-300">Brain built, map not yet generated</p>
              <p className="text-xs text-zinc-600 max-w-[300px] leading-relaxed">
                Generate a visual architecture map from your project's brain memories.
              </p>
            </div>
            <button
              onClick={handleRegenerate}
              disabled={regenerateMutation.isPending}
              className={cn(
                "flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-medium transition-all duration-200",
                regenerateMutation.isPending
                  ? "bg-zinc-800 text-zinc-500 cursor-wait"
                  : "bg-cyan-500/10 text-cyan-400 border border-cyan-500/20 hover:bg-cyan-500/20",
              )}
            >
              {regenerateMutation.isPending ? (
                <><RefreshCw className="w-3.5 h-3.5 animate-spin" />Generating...</>
              ) : (
                <><Sparkles className="w-3.5 h-3.5" />Generate Architecture Map</>
              )}
            </button>
          </div>
        ) : (
          /* The architecture diagram */
          <div
            className="relative overflow-hidden"
            style={{
              height: MAP_HEIGHT,
              background: "radial-gradient(ellipse at center, #0F172A 0%, #09090B 100%)",
            }}
          >
            {/* Ambient glow backgrounds behind zones */}
            {zones.map((zone) => {
              const pos = positions.get(zone.id)
              if (!pos) return null
              const glowColor = zone.confidence >= 80 ? "34,197,94"
                : zone.confidence >= 60 ? "6,182,212"
                  : zone.confidence >= 40 ? "245,158,11"
                    : zone.confidence >= 20 ? "236,72,153"
                      : "82,82,91"
              return (
                <motion.div
                  key={`glow-${zone.id}`}
                  className="absolute pointer-events-none"
                  style={{
                    left: pos.x - 40,
                    top: pos.y - 30,
                    width: ZONE_WIDTH + 80,
                    height: ZONE_HEIGHT + 60,
                    background: `radial-gradient(ellipse, rgba(${glowColor}, 0.06) 0%, transparent 70%)`,
                  }}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ duration: 1, delay: 0.5 }}
                />
              )
            })}

            {/* Connection lines */}
            <ZoneConnections
              zones={zones}
              positions={positions}
              width={containerWidth}
              height={MAP_HEIGHT}
            />

            {/* Zone cards */}
            {zones.map((zone, i) => {
              const pos = positions.get(zone.id)
              if (!pos) return null
              const zoneProgress = auditProgress.progress.find(p => p.zoneId === zone.id)
              return (
                <ZoneCard
                  key={zone.id}
                  zone={zone}
                  x={pos.x}
                  y={pos.y}
                  index={i}
                  isAuditing={auditingZones.has(zone.id)}
                  auditStatus={zoneProgress?.status}
                  auditFindingCount={zoneProgress?.findings}
                  onAudit={handleZoneAudit}
                />
              )
            })}

            {/* Legend */}
            <div className="absolute bottom-4 left-4">
              <Legend />
            </div>
          </div>
        )}
      </div>
    </section>
  )
})
