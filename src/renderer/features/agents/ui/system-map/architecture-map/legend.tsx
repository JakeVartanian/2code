/**
 * Legend — color key for the architecture map confidence tiers.
 */

import { memo } from "react"

const TIERS = [
  { color: "bg-green-500", label: "Recently audited" },
  { color: "bg-cyan-500", label: "Good confidence" },
  { color: "bg-amber-500", label: "Stale / partial" },
  { color: "bg-pink-500", label: "Low confidence" },
  { color: "bg-zinc-600", label: "Unaudited" },
]

export const Legend = memo(function Legend() {
  return (
    <div className="flex items-center gap-5 px-4 py-2 rounded-lg bg-[#09090BCC] border border-zinc-800/60">
      {TIERS.map((tier) => (
        <div key={tier.label} className="flex items-center gap-1.5">
          <div className={`w-2 h-2 rounded-full ${tier.color}`} />
          <span className="text-[9px] font-mono text-zinc-500">{tier.label}</span>
        </div>
      ))}
    </div>
  )
})
