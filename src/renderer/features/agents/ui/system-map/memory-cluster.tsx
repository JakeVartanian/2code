/**
 * MemoryCluster — Visualizes the memory bank as category clusters.
 * Each cluster shows colored dots representing individual memories,
 * sized by relevance and colored by state (active/cold/dead).
 */

import { memo, useMemo } from "react"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../../../../components/ui/tooltip"
import { cn } from "../../../../lib/utils"

interface Memory {
  id: string
  category: string
  title: string
  content: string
  relevanceScore: number
  state: "active" | "cold" | "dead"
  updatedAt: string
}

interface MemoryClusterProps {
  memories: Memory[]
}

const CATEGORIES = [
  "architecture",
  "convention",
  "deployment",
  "debugging",
  "preference",
  "gotcha",
  "brand",
  "strategy",
  "design",
] as const

const CATEGORY_COLORS: Record<string, string> = {
  architecture: "border-blue-500/30",
  convention: "border-purple-500/30",
  deployment: "border-green-500/30",
  debugging: "border-amber-500/30",
  preference: "border-cyan-500/30",
  gotcha: "border-red-500/30",
  brand: "border-pink-500/30",
  strategy: "border-indigo-500/30",
  design: "border-yellow-500/30",
}

const CATEGORY_HEADER_COLORS: Record<string, string> = {
  architecture: "text-blue-400",
  convention: "text-purple-400",
  deployment: "text-green-400",
  debugging: "text-amber-400",
  preference: "text-cyan-400",
  gotcha: "text-red-400",
  brand: "text-pink-400",
  strategy: "text-indigo-400",
  design: "text-yellow-400",
}

const STATE_DOT_COLORS: Record<Memory["state"], string> = {
  active: "bg-blue-400",
  cold: "bg-amber-400",
  dead: "bg-zinc-500",
}

function clampDotSize(relevanceScore: number): number {
  const clamped = Math.max(0, Math.min(100, relevanceScore))
  return 6 + (clamped / 100) * 6
}

const MemoryDot = memo(function MemoryDot({ memory }: { memory: Memory }) {
  const size = clampDotSize(memory.relevanceScore)
  const colorClass = STATE_DOT_COLORS[memory.state]

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            "inline-block rounded-full cursor-default transition-opacity duration-200 hover:opacity-80",
            colorClass,
          )}
          style={{ width: size, height: size }}
        />
      </TooltipTrigger>
      <TooltipContent side="top">
        <p className="font-medium">{memory.title}</p>
        <p className="text-zinc-400 text-[10px] capitalize">
          {memory.state} &middot; relevance {memory.relevanceScore}
        </p>
      </TooltipContent>
    </Tooltip>
  )
})

const CategoryCard = memo(function CategoryCard({
  category,
  memories,
}: {
  category: string
  memories: Memory[]
}) {
  const borderClass = CATEGORY_COLORS[category] ?? "border-zinc-700"
  const headerColorClass = CATEGORY_HEADER_COLORS[category] ?? "text-zinc-400"

  return (
    <div
      className={cn(
        "rounded-lg border bg-zinc-900/30 p-3 min-h-[72px]",
        borderClass,
      )}
    >
      <div className="flex items-center justify-between mb-2">
        <span
          className={cn(
            "text-xs font-medium capitalize",
            headerColorClass,
          )}
        >
          {category}
        </span>
        <span className="text-[10px] text-zinc-500 font-mono">
          {memories.length}
        </span>
      </div>
      {memories.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {memories.map((m) => (
            <MemoryDot key={m.id} memory={m} />
          ))}
        </div>
      ) : (
        <p className="text-[10px] text-zinc-600 italic">No memories</p>
      )}
    </div>
  )
})

export const MemoryCluster = memo(function MemoryCluster({
  memories,
}: MemoryClusterProps) {
  const grouped = useMemo(() => {
    const map = new Map<string, Memory[]>()
    for (const cat of CATEGORIES) {
      map.set(cat, [])
    }
    for (const mem of memories) {
      const bucket = map.get(mem.category)
      if (bucket) {
        bucket.push(mem)
      } else {
        // Unknown category — place in closest match or skip
        const existing = map.get("gotcha")
        existing?.push(mem)
      }
    }
    return map
  }, [memories])

  return (
    <TooltipProvider delayDuration={200}>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 pt-3">
        {CATEGORIES.map((cat) => (
          <CategoryCard
            key={cat}
            category={cat}
            memories={grouped.get(cat) ?? []}
          />
        ))}
      </div>
    </TooltipProvider>
  )
})
