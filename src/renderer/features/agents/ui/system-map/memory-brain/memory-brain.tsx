/**
 * MemoryBrain — visual brain map showing memory categories as
 * interconnected nodes in a hexagonal layout with ambient glows,
 * health bars, and memory particles.
 */

import { memo, useMemo, useRef, useState, useEffect } from "react"
import { motion } from "motion/react"
import { Brain } from "lucide-react"

import { CATEGORIES, MAP_HEIGHT, type Category } from "./constants"
import { computeBrainLayout } from "./layout"
import { CategoryNode } from "./category-node"
import { CategoryConnections } from "./category-connections"
import { BrainLegend } from "./brain-legend"
import { CenterHub } from "./center-hub"

// ─── Types ──────────────────────────────────────────────────────────────────

interface Memory {
  id: string
  category: string
  title: string
  content: string
  relevanceScore: number
  state: "active" | "cold" | "dead"
  updatedAt: string
}

interface MemoryBrainProps {
  memories: Memory[]
}

// ─── Empty State ────────────────────────────────────────────────────────────

function EmptyBrainState() {
  return (
    <div className="flex flex-col items-center justify-center gap-4 py-16 px-8">
      <motion.div
        className="w-14 h-14 rounded-2xl border border-zinc-800 bg-zinc-900/50 flex items-center justify-center"
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.4 }}
      >
        <Brain className="w-7 h-7 text-zinc-600" />
      </motion.div>
      <div className="text-center space-y-1.5">
        <p className="text-sm font-medium text-zinc-300">Memory Brain</p>
        <p className="text-xs text-zinc-600 max-w-[320px] leading-relaxed">
          Start chatting to build project memory automatically, or build the brain
          from your codebase in Settings.
        </p>
      </div>
    </div>
  )
}

// ─── Main Component ─────────────────────────────────────────────────────────

export const MemoryBrain = memo(function MemoryBrain({
  memories,
}: MemoryBrainProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [containerWidth, setContainerWidth] = useState(800)

  // Measure container
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

  // Group memories by category
  const grouped = useMemo(() => {
    const map = new Map<Category, Memory[]>()
    for (const cat of CATEGORIES) {
      map.set(cat, [])
    }
    for (const mem of memories) {
      const bucket = map.get(mem.category as Category)
      if (bucket) {
        bucket.push(mem)
      }
    }
    return map
  }, [memories])

  // Category counts for connection visibility
  const categoryCounts = useMemo(() => {
    const counts = new Map<Category, number>()
    for (const [cat, mems] of grouped) {
      counts.set(cat, mems.length)
    }
    return counts
  }, [grouped])

  // Compute layout
  const positions = useMemo(
    () => computeBrainLayout(containerWidth, MAP_HEIGHT),
    [containerWidth],
  )

  // Stats
  const stats = useMemo(() => {
    const active = memories.filter((m) => m.state === "active").length
    const cold = memories.filter((m) => m.state === "cold").length
    const dead = memories.filter((m) => m.state === "dead").length
    const avgRelevance =
      memories.length > 0
        ? Math.round(
            memories.reduce((sum, m) => sum + m.relevanceScore, 0) /
              memories.length,
          )
        : 0
    return { total: memories.length, active, cold, dead, avgRelevance }
  }, [memories])

  if (memories.length === 0) {
    return (
      <div ref={containerRef}>
        <EmptyBrainState />
      </div>
    )
  }

  return (
    <div ref={containerRef}>
      <div
        className="relative overflow-hidden rounded-lg"
        style={{
          height: MAP_HEIGHT,
          background:
            "radial-gradient(ellipse at center, #0F172A 0%, #09090B 100%)",
        }}
      >
        {/* Connection lines */}
        <CategoryConnections
          positions={positions}
          categoryCounts={categoryCounts}
          width={containerWidth}
          height={MAP_HEIGHT}
        />

        {/* Center hub */}
        <CenterHub
          position={positions.get("center")!}
          stats={stats}
        />

        {/* Category nodes */}
        {CATEGORIES.map((cat, i) => {
          const pos = positions.get(cat)
          if (!pos) return null
          return (
            <CategoryNode
              key={cat}
              category={cat}
              memories={grouped.get(cat) ?? []}
              x={pos.x}
              y={pos.y}
              index={i}
            />
          )
        })}

        {/* Legend */}
        <div className="absolute bottom-3 left-3">
          <BrainLegend />
        </div>
      </div>
    </div>
  )
})
