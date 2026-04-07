"use client"

import { memo } from "react"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../../../components/ui/tooltip"
import { cn } from "../../../lib/utils"
import { formatCost } from "../lib/models"
import type { MessageTokenData } from "./agent-context-indicator"

interface SessionCostIndicatorProps {
  tokenData: MessageTokenData
  className?: string
}

function getTokenColor(_totalTokens: number): string {
  return "text-muted-foreground"
}

function formatSessionTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`
  return tokens.toString()
}

export const SessionCostIndicator = memo(function SessionCostIndicator({
  tokenData,
  className,
}: SessionCostIndicatorProps) {
  const totalTokens = tokenData.totalInputTokens + tokenData.totalOutputTokens

  if (totalTokens === 0) return null

  const color = getTokenColor(totalTokens)

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          tabIndex={-1}
          className={cn(
            "h-5 px-1.5 flex items-center gap-1 text-[10px] rounded-md",
            "text-muted-foreground/50 hover:text-muted-foreground hover:bg-muted/50",
            "transition-[background-color] duration-150 ease-out",
            className,
          )}
        >
          <span className={cn("font-mono", color)}>
            {formatSessionTokens(totalTokens)}
          </span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="text-xs">
        <div className="space-y-1">
          <div className="font-medium">Session usage</div>
          <div className="flex justify-between gap-3">
            <span className="text-muted-foreground">Input:</span>
            <span className="font-mono">{formatSessionTokens(tokenData.totalInputTokens)}</span>
          </div>
          <div className="flex justify-between gap-3">
            <span className="text-muted-foreground">Output:</span>
            <span className="font-mono">{formatSessionTokens(tokenData.totalOutputTokens)}</span>
          </div>
          <div className="flex justify-between gap-3 pt-1 border-t border-border/30">
            <span className="text-muted-foreground">Total:</span>
            <span className="font-mono font-medium">{formatSessionTokens(totalTokens)}</span>
          </div>
          {tokenData.messageCount > 0 && (
            <div className="flex justify-between gap-3">
              <span className="text-muted-foreground">Messages:</span>
              <span className="font-mono">{tokenData.messageCount}</span>
            </div>
          )}
        </div>
      </TooltipContent>
    </Tooltip>
  )
})
