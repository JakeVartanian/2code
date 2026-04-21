/**
 * ArchitectureMap — hero visualization showing the project's system
 * architecture as interconnected zones with confidence coloring.
 */

import { memo, useMemo, useCallback, useRef, useState, useEffect } from "react"
import { motion } from "motion/react"
import { Network, RefreshCw, Sparkles } from "lucide-react"
import { cn } from "../../../../../lib/utils"
import { trpc } from "../../../../../lib/trpc"
import { useArchitectureData } from "./use-architecture-data"
import { ZoneCard } from "./zone-card"
import { ZoneConnections } from "./zone-connections"
import { Legend } from "./legend"
import { computeLayout, ZONE_WIDTH, ZONE_HEIGHT } from "./layout"

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
  const utils = trpc.useUtils()

  const [isBuilding, setIsBuilding] = useState(false)

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
            <button
              onClick={handleRegenerate}
              disabled={regenerateMutation.isPending}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[10px] font-medium
                text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/60 transition-all duration-150"
            >
              <RefreshCw className={cn("w-3 h-3", regenerateMutation.isPending && "animate-spin")} />
              Regenerate
            </button>
          )}
        </div>
      </div>

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
              return (
                <ZoneCard
                  key={zone.id}
                  zone={zone}
                  x={pos.x}
                  y={pos.y}
                  index={i}
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
