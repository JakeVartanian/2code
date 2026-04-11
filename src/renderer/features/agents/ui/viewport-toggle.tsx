import { cn } from "../../../lib/utils"
import { Monitor, Smartphone, Columns2 } from "lucide-react"
import { motion } from "motion/react"
import type { ViewportMode } from "../atoms"

interface ViewportToggleProps {
  value: ViewportMode
  onChange: (mode: ViewportMode) => void
  className?: string
  disableCompare?: boolean
}

const MODES: { mode: ViewportMode; icon: typeof Monitor; label: string }[] = [
  { mode: "desktop", icon: Monitor, label: "Desktop viewport" },
  { mode: "mobile", icon: Smartphone, label: "Mobile viewport" },
  { mode: "compare", icon: Columns2, label: "Compare viewports" },
]

function getIndicatorStyle(value: ViewportMode) {
  const idx = MODES.findIndex((m) => m.mode === value)
  const count = MODES.length
  const width = `calc(${100 / count}% - 2px)`
  const left = idx === 0 ? "2px" : `calc(${(idx / count) * 100}%)`
  return { width, left }
}

export function ViewportToggle({
  value,
  onChange,
  className,
  disableCompare = false,
}: ViewportToggleProps) {
  const modes = disableCompare ? MODES.slice(0, 2) : MODES

  const indicatorStyle = (() => {
    const idx = modes.findIndex((m) => m.mode === value)
    const resolvedIdx = idx >= 0 ? idx : 0
    const count = modes.length
    const width = `calc(${100 / count}% - 2px)`
    const left = resolvedIdx === 0 ? "2px" : `calc(${(resolvedIdx / count) * 100}%)`
    return { width, left }
  })()

  return (
    <motion.div
      layout
      className={cn("flex items-center", className)}
      transition={{
        layout: {
          duration: 0.15,
          ease: "easeInOut",
        },
      }}
    >
      <motion.div
        layout
        className="relative bg-muted rounded-lg h-7 p-0.5 flex"
        role="radiogroup"
        aria-label="Viewport mode"
      >
        {/* Animated selector */}
        <motion.div
          className="absolute inset-y-0.5 rounded-md bg-background shadow transition-all duration-200 ease-in-out"
          animate={indicatorStyle}
          transition={{
            duration: 0.2,
            ease: "easeInOut",
          }}
        />
        {modes.map(({ mode, icon: Icon, label }) => (
          <button
            key={mode}
            role="radio"
            aria-checked={value === mode}
            aria-label={label}
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              onChange(mode)
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault()
                e.stopPropagation()
                onChange(mode)
              }
            }}
            className={cn(
              "relative z-[2] px-2 flex-1 flex items-center justify-center transition-colors duration-200 rounded-md outline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring/70 text-muted-foreground",
            )}
          >
            <Icon className="h-3.5 w-3.5" />
          </button>
        ))}
      </motion.div>
    </motion.div>
  )
}
