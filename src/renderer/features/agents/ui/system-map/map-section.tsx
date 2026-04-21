/**
 * MapSection — Reusable collapsible section for the System Map.
 * Mirrors the visual pattern from PipelineSection in the orchestrator,
 * adapted with cyan accent and AnimatePresence transitions.
 */

import { memo, useState } from "react"
import { ChevronDown, ChevronRight } from "lucide-react"
import { AnimatePresence, motion } from "motion/react"
import { cn } from "../../../../lib/utils"

interface MapSectionProps {
  title: string
  icon: React.ReactNode
  count?: number
  defaultOpen?: boolean
  children: React.ReactNode
  accentColor?: string
}

export const MapSection = memo(function MapSection({
  title,
  icon,
  count,
  defaultOpen = true,
  children,
  accentColor = "cyan",
}: MapSectionProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen)

  const accentMap: Record<string, string> = {
    cyan: "text-cyan-400",
    purple: "text-purple-400",
    amber: "text-amber-400",
    green: "text-green-400",
    red: "text-red-400",
    blue: "text-blue-400",
  }

  const badgeBgMap: Record<string, string> = {
    cyan: "bg-cyan-400/10 text-cyan-400",
    purple: "bg-purple-400/10 text-purple-400",
    amber: "bg-amber-400/10 text-amber-400",
    green: "bg-green-400/10 text-green-400",
    red: "bg-red-400/10 text-red-400",
    blue: "bg-blue-400/10 text-blue-400",
  }

  const accentTextClass = accentMap[accentColor] ?? "text-cyan-400"
  const badgeClass = badgeBgMap[accentColor] ?? "bg-cyan-400/10 text-cyan-400"

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 overflow-hidden">
      <button
        onClick={() => setIsOpen((prev) => !prev)}
        className="w-full flex items-center gap-2.5 px-4 py-3 hover:bg-zinc-800/40 transition-colors duration-200"
      >
        {isOpen ? (
          <ChevronDown className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
        )}
        <span className={cn("shrink-0", accentTextClass)}>{icon}</span>
        <span className="text-sm font-medium text-zinc-100">{title}</span>
        {count !== undefined && (
          <span
            className={cn(
              "ml-auto text-[11px] font-medium px-1.5 py-0.5 rounded-md",
              badgeClass,
            )}
          >
            {count}
          </span>
        )}
      </button>

      <AnimatePresence initial={false}>
        {isOpen && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
            className="overflow-hidden"
          >
            <div className="px-4 pb-4 border-t border-zinc-800/60">
              {children}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
})
