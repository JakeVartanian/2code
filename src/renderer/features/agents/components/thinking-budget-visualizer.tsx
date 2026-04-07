"use client"

import { memo, useCallback } from "react"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../../../components/ui/tooltip"
import { cn } from "../../../lib/utils"

const PRESETS = [
  { value: 8_000, label: "Quick", description: "Fast responses, minimal reflection", costHint: "Lowest cost" },
  { value: 16_000, label: "Light", description: "Brief reasoning for simple tasks", costHint: "Low cost" },
  { value: 32_000, label: "Standard", description: "Balanced depth for most tasks", costHint: "Moderate" },
  { value: 64_000, label: "Deep", description: "Thorough reasoning for complex problems", costHint: "Higher cost" },
  { value: 128_000, label: "Maximum", description: "Deepest analysis, highest quality", costHint: "Highest cost" },
] as const

const MAX_BUDGET = 128_000

interface ThinkingBudgetVisualizerProps {
  budget: number
  onBudgetChange: (budget: number) => void
  compact?: boolean
  className?: string
}

export const ThinkingBudgetVisualizer = memo(function ThinkingBudgetVisualizer({
  budget,
  onBudgetChange,
  compact = false,
  className,
}: ThinkingBudgetVisualizerProps) {
  const activePreset = PRESETS.find((p) => p.value === budget)
  const fillPercent = Math.min((budget / MAX_BUDGET) * 100, 100)

  const handlePresetClick = useCallback(
    (value: number) => {
      onBudgetChange(value)
    },
    [onBudgetChange],
  )

  if (compact) {
    return (
      <div className={cn("flex items-center gap-1", className)}>
        {PRESETS.map((preset) => (
          <Tooltip key={preset.value}>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => handlePresetClick(preset.value)}
                className={cn(
                  "px-1.5 py-0.5 text-[10px] rounded transition-colors",
                  budget === preset.value
                    ? "bg-primary/15 text-primary font-medium"
                    : "text-muted-foreground/60 hover:text-muted-foreground hover:bg-muted/50",
                )}
              >
                {preset.label}
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" className="text-xs">
              <p>{preset.description}</p>
              <p className="text-muted-foreground">{(preset.value / 1000)}k tokens — {preset.costHint}</p>
            </TooltipContent>
          </Tooltip>
        ))}
      </div>
    )
  }

  return (
    <div className={cn("space-y-2", className)}>
      {/* Progress bar */}
      <div className="h-1.5 rounded-full bg-muted/50 overflow-hidden">
        <div
          className={cn(
            "h-full rounded-full transition-all duration-200",
            fillPercent <= 25 ? "bg-emerald-500" :
            fillPercent <= 50 ? "bg-amber-500" :
            fillPercent <= 75 ? "bg-orange-500" :
            "bg-red-500"
          )}
          style={{ width: `${fillPercent}%` }}
        />
      </div>

      {/* Preset buttons */}
      <div className="flex gap-1">
        {PRESETS.map((preset) => (
          <Tooltip key={preset.value}>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => handlePresetClick(preset.value)}
                className={cn(
                  "flex-1 px-1 py-1.5 text-[10px] leading-tight rounded transition-colors text-center",
                  budget === preset.value
                    ? "bg-primary/15 text-primary font-medium ring-1 ring-primary/20"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted/50",
                )}
              >
                <div>{preset.label}</div>
                <div className="text-[9px] opacity-60">{(preset.value / 1000)}k</div>
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs max-w-[180px]">
              <p className="font-medium">{preset.label} ({(preset.value / 1000)}k tokens)</p>
              <p className="text-muted-foreground">{preset.description}</p>
              <p className="text-muted-foreground mt-0.5">{preset.costHint}</p>
            </TooltipContent>
          </Tooltip>
        ))}
      </div>

      {/* Current value */}
      {activePreset && (
        <p className="text-[10px] text-muted-foreground">
          {activePreset.description}
        </p>
      )}
    </div>
  )
})
