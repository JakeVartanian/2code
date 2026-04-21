/**
 * BrainLegend — color key for memory states in the brain visualization.
 */

import { memo } from "react"

const TIERS = [
  { color: "bg-emerald-400", label: "Active" },
  { color: "bg-amber-400", label: "Cold" },
  { color: "bg-zinc-500", label: "Dead" },
]

export const BrainLegend = memo(function BrainLegend() {
  return (
    <div className="flex items-center gap-4 px-3 py-1.5 rounded-lg bg-[#09090BCC] border border-zinc-800/60">
      {TIERS.map((tier) => (
        <div key={tier.label} className="flex items-center gap-1.5">
          <div className={`w-2 h-2 rounded-full ${tier.color}`} />
          <span className="text-[9px] font-mono text-zinc-500">
            {tier.label}
          </span>
        </div>
      ))}
    </div>
  )
})
