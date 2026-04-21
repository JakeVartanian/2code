/**
 * CategoryNode — a visual zone card for a single memory category.
 * Shows category icon, memory count, health bar, strongest memory,
 * and individual memory particles.
 */

import { memo, useMemo } from "react"
import { motion, useReducedMotion } from "motion/react"
import {
  TooltipProvider,
} from "../../../../../components/ui/tooltip"
import { cn } from "../../../../../lib/utils"
import { CATEGORY_META, NODE_WIDTH, NODE_HEIGHT, type Category } from "./constants"
import { MemoryParticle } from "./memory-particle"

interface Memory {
  id: string
  title: string
  content: string
  relevanceScore: number
  state: "active" | "cold" | "dead"
}

interface CategoryNodeProps {
  category: Category
  memories: Memory[]
  x: number
  y: number
  index: number
}

export const CategoryNode = memo(function CategoryNode({
  category,
  memories,
  x,
  y,
  index,
}: CategoryNodeProps) {
  const prefersReducedMotion = useReducedMotion()
  const meta = CATEGORY_META[category]
  const Icon = meta.icon

  // Compute health: ratio of active memories
  const health = useMemo(() => {
    if (memories.length === 0) return 0
    const active = memories.filter((m) => m.state === "active").length
    return Math.round((active / memories.length) * 100)
  }, [memories])

  // Strongest memory by relevance
  const strongest = useMemo(() => {
    if (memories.length === 0) return null
    return memories.reduce((best, m) =>
      m.relevanceScore > best.relevanceScore ? m : best
    )
  }, [memories])

  // Limit displayed particles to prevent overflow
  const displayedMemories = useMemo(() => {
    return memories.slice(0, 20)
  }, [memories])

  return (
    <motion.div
      className="absolute"
      style={{ left: x, top: y, width: NODE_WIDTH }}
      initial={prefersReducedMotion ? {} : { opacity: 0, scale: 0.85, y: 10 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      transition={{
        duration: 0.45,
        ease: [0.25, 0.46, 0.45, 0.94],
        delay: index * 0.07,
      }}
    >
      {/* Ambient glow */}
      <div
        className="absolute -inset-6 rounded-full pointer-events-none blur-2xl"
        style={{
          background: `radial-gradient(ellipse, rgba(${meta.glowRgb}, ${memories.length > 0 ? 0.08 : 0.03}) 0%, transparent 70%)`,
        }}
      />

      {/* Card */}
      <div
        className={cn(
          "relative rounded-xl border bg-[#09090BCC] backdrop-blur-sm",
          "transition-all duration-200 ease-out cursor-default",
          "hover:shadow-lg hover:scale-[1.02]",
          meta.color,
        )}
        style={{ minHeight: NODE_HEIGHT }}
      >
        <div className="p-3.5 space-y-2.5">
          {/* Header: icon + name + count badge */}
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <Icon className={cn("w-4 h-4 shrink-0", meta.textColor)} />
              <span className="text-[13px] font-semibold text-zinc-100 truncate">
                {meta.label}
              </span>
            </div>
            <span
              className={cn(
                "text-[10px] font-mono font-semibold px-2 py-0.5 rounded-md shrink-0",
                meta.badgeBg,
                meta.badgeText,
              )}
            >
              {memories.length}
            </span>
          </div>

          {/* Strongest memory subtitle */}
          {strongest ? (
            <p className="text-[10px] text-zinc-500 leading-relaxed truncate">
              {strongest.title}
            </p>
          ) : (
            <p className="text-[10px] text-zinc-600 italic">No memories</p>
          )}

          {/* Health bar */}
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <span className="text-[9px] font-mono text-zinc-600">health</span>
              <span className={cn("text-[9px] font-mono", meta.textColor)} style={{ opacity: 0.7 }}>
                {health}%
              </span>
            </div>
            <div className="h-[3px] rounded-full bg-zinc-800/80 overflow-hidden">
              <motion.div
                className={cn("h-full rounded-full", meta.barFill)}
                initial={prefersReducedMotion ? { width: `${health}%` } : { width: 0 }}
                animate={{ width: `${health}%` }}
                transition={{
                  duration: 0.6,
                  ease: [0.25, 0.46, 0.45, 0.94],
                  delay: index * 0.07 + 0.2,
                }}
              />
            </div>
          </div>

          {/* Memory particles */}
          {displayedMemories.length > 0 && (
            <TooltipProvider delayDuration={200}>
              <div className="flex flex-wrap items-center gap-1 pt-0.5">
                {displayedMemories.map((m) => (
                  <MemoryParticle key={m.id} memory={m} />
                ))}
                {memories.length > 20 && (
                  <span className="text-[9px] text-zinc-600 font-mono ml-1">
                    +{memories.length - 20}
                  </span>
                )}
              </div>
            </TooltipProvider>
          )}
        </div>
      </div>
    </motion.div>
  )
})
