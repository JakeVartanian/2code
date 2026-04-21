/**
 * CenterHub — central stats node in the Memory Brain hexagon.
 * Shows total memory count, health breakdown, and average relevance.
 */

import { memo } from "react"
import { motion, useReducedMotion } from "motion/react"
import { Brain } from "lucide-react"
import type { NodePosition } from "./layout"

interface CenterHubProps {
  position: NodePosition
  stats: {
    total: number
    active: number
    cold: number
    dead: number
    avgRelevance: number
  }
}

export const CenterHub = memo(function CenterHub({
  position,
  stats,
}: CenterHubProps) {
  const prefersReducedMotion = useReducedMotion()
  const healthPct =
    stats.total > 0 ? Math.round((stats.active / stats.total) * 100) : 0

  return (
    <motion.div
      className="absolute z-10"
      style={{
        left: position.x - 52,
        top: position.y - 52,
        width: 104,
        height: 104,
      }}
      initial={prefersReducedMotion ? {} : { opacity: 0, scale: 0.7 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.5, ease: [0.25, 0.46, 0.45, 0.94], delay: 0.1 }}
    >
      {/* Ambient glow */}
      <div
        className="absolute -inset-8 rounded-full pointer-events-none blur-3xl"
        style={{
          background:
            "radial-gradient(circle, rgba(6,182,212,0.08) 0%, transparent 70%)",
        }}
      />

      {/* Circle */}
      <div className="relative w-full h-full rounded-full border border-cyan-500/20 bg-[#09090BDD] backdrop-blur-sm flex flex-col items-center justify-center gap-1">
        <Brain className="w-4 h-4 text-cyan-400/60" />
        <span className="text-lg font-bold text-zinc-100 font-mono leading-none">
          {stats.total}
        </span>
        <span className="text-[8px] font-mono text-zinc-500 uppercase tracking-wider">
          memories
        </span>

        {/* Health ring */}
        <svg
          className="absolute inset-0 w-full h-full -rotate-90"
          viewBox="0 0 104 104"
        >
          <circle
            cx="52"
            cy="52"
            r="48"
            fill="none"
            stroke="rgba(39,39,42,0.4)"
            strokeWidth="2"
          />
          <motion.circle
            cx="52"
            cy="52"
            r="48"
            fill="none"
            stroke="rgba(6,182,212,0.4)"
            strokeWidth="2"
            strokeLinecap="round"
            strokeDasharray={`${2 * Math.PI * 48}`}
            initial={
              prefersReducedMotion
                ? { strokeDashoffset: 2 * Math.PI * 48 * (1 - healthPct / 100) }
                : { strokeDashoffset: 2 * Math.PI * 48 }
            }
            animate={{
              strokeDashoffset: 2 * Math.PI * 48 * (1 - healthPct / 100),
            }}
            transition={{ duration: 1, ease: "easeOut", delay: 0.3 }}
          />
        </svg>
      </div>
    </motion.div>
  )
})
