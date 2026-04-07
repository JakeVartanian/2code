"use client"

import { memo } from "react"
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "../../../components/ui/hover-card"
import { cn } from "../../../lib/utils"
import { formatCost } from "../lib/models"

export interface AgentMessageMetadata {
  model?: string
  sessionId?: string
  totalCostUsd?: number
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  cacheReadInputTokens?: number
  cacheCreationInputTokens?: number
  finalTextId?: string
  durationMs?: number
  resultSubtype?: string
}

interface AgentMessageUsageProps {
  metadata?: AgentMessageMetadata
  isStreaming?: boolean
  isMobile?: boolean
}

function formatTokens(tokens: number): string {
  if (tokens >= 1000) {
    return `${(tokens / 1000).toFixed(1)}k`
  }
  return tokens.toString()
}

function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`
  }
  const seconds = ms / 1000
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`
  }
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = Math.round(seconds % 60)
  return `${minutes}m ${remainingSeconds}s`
}

function UsageRow({ label, value, className }: { label: string; value: string | number; className?: string }) {
  return (
    <div className="flex justify-between text-xs gap-4">
      <span className="text-muted-foreground">{label}</span>
      <span className={cn("font-mono text-foreground", className)}>
        {typeof value === "number" ? value.toLocaleString() : value}
      </span>
    </div>
  )
}

export const AgentMessageUsage = memo(function AgentMessageUsage({
  metadata,
  isStreaming = false,
  isMobile = false,
}: AgentMessageUsageProps) {
  if (!metadata || isStreaming) return null

  const {
    inputTokens = 0,
    outputTokens = 0,
    totalTokens = 0,
    cacheReadInputTokens,
    cacheCreationInputTokens,
    totalCostUsd,
    durationMs,
    resultSubtype,
  } = metadata

  const hasUsage = inputTokens > 0 || outputTokens > 0

  if (!hasUsage) return null

  const displayTokens = totalTokens || inputTokens + outputTokens
  const hasCost = totalCostUsd !== undefined && totalCostUsd > 0
  const hasCacheInfo = (cacheReadInputTokens && cacheReadInputTokens > 0) ||
    (cacheCreationInputTokens && cacheCreationInputTokens > 0)

  return (
    <HoverCard openDelay={400} closeDelay={100}>
      <HoverCardTrigger asChild>
        <button
          tabIndex={-1}
          className={cn(
            "h-5 px-1.5 flex items-center gap-1 text-[10px] rounded-md",
            "text-muted-foreground/60 hover:text-muted-foreground hover:bg-muted/50",
            "transition-[background-color,transform] duration-150 ease-out",
          )}
        >
          <span className="font-mono">{formatTokens(displayTokens)}</span>
          {hasCost && (
            <span className="font-mono text-muted-foreground/40">
              {formatCost(totalCostUsd)}
            </span>
          )}
        </button>
      </HoverCardTrigger>
      <HoverCardContent
        sideOffset={4}
        align="end"
        className="w-auto pt-2 px-2 pb-0 shadow-sm rounded-lg border-border/50 overflow-hidden"
      >
        <div className="space-y-1.5 pb-2">
          {/* Status & Duration group */}
          {(resultSubtype || (durationMs !== undefined && durationMs > 0)) && (
            <div className="space-y-1">
              {resultSubtype && (
                <UsageRow label="Status" value={resultSubtype === "success" ? "Success" : "Failed"} />
              )}
              {durationMs !== undefined && durationMs > 0 && (
                <UsageRow label="Duration" value={formatDuration(durationMs)} />
              )}
            </div>
          )}

          {/* Token breakdown */}
          {displayTokens > 0 && (
            <div className="space-y-1 pt-1.5 mt-1 border-t border-border/50">
              <UsageRow label="Input" value={inputTokens.toLocaleString()} />
              <UsageRow label="Output" value={outputTokens.toLocaleString()} />
              {hasCacheInfo && cacheReadInputTokens && cacheReadInputTokens > 0 && (
                <UsageRow label="Cache read" value={cacheReadInputTokens.toLocaleString()} className="text-emerald-500" />
              )}
              {hasCacheInfo && cacheCreationInputTokens && cacheCreationInputTokens > 0 && (
                <UsageRow label="Cache write" value={cacheCreationInputTokens.toLocaleString()} className="text-amber-500" />
              )}
              <div className="flex justify-between text-xs gap-4 pt-1 border-t border-border/30">
                <span className="text-muted-foreground font-medium">Total</span>
                <span className="font-mono font-medium text-foreground">
                  {displayTokens.toLocaleString()}
                </span>
              </div>
            </div>
          )}

          {/* Cost */}
          {hasCost && (
            <div className="flex justify-between text-xs gap-4 pt-1.5 mt-1 border-t border-border/50">
              <span className="text-muted-foreground">Cost</span>
              <span className="font-mono font-medium text-foreground">
                {formatCost(totalCostUsd)}
              </span>
            </div>
          )}
        </div>
      </HoverCardContent>
    </HoverCard>
  )
})
