/**
 * MemoryParticle — a single memory dot within a category node.
 * Sized by relevance, colored by state.
 */

import { memo } from "react"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../../../../../components/ui/tooltip"
import { cn } from "../../../../../lib/utils"
import { STATE_COLORS } from "./constants"

interface Memory {
  id: string
  title: string
  relevanceScore: number
  state: "active" | "cold" | "dead"
}

interface MemoryParticleProps {
  memory: Memory
}

function dotSize(relevance: number): number {
  return 5 + (Math.max(0, Math.min(100, relevance)) / 100) * 5
}

export const MemoryParticle = memo(function MemoryParticle({
  memory,
}: MemoryParticleProps) {
  const size = dotSize(memory.relevanceScore)
  const colorClass = STATE_COLORS[memory.state]

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            "inline-block rounded-full cursor-default transition-all duration-200",
            "hover:scale-125 hover:brightness-125",
            colorClass,
          )}
          style={{ width: size, height: size }}
        />
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-[200px]">
        <p className="font-medium text-xs">{memory.title}</p>
        <p className="text-zinc-400 text-[10px] capitalize">
          {memory.state} &middot; relevance {memory.relevanceScore}
        </p>
      </TooltipContent>
    </Tooltip>
  )
})
