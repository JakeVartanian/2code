"use client"

import { memo, useCallback, useEffect, useState } from "react"
import { X, Zap } from "lucide-react"
import { cn } from "../../../lib/utils"
import { getCostTierColor, type ClaudeModel } from "../lib/models"

interface ModelSuggestionChipProps {
  suggestion: { model: ClaudeModel; reason: string } | null
  onAccept: (modelId: string) => void
  onDismiss: () => void
  className?: string
}

export const ModelSuggestionChip = memo(function ModelSuggestionChip({
  suggestion,
  onAccept,
  onDismiss,
  className,
}: ModelSuggestionChipProps) {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    if (suggestion) {
      // Small delay so it doesn't flash on every keystroke
      const timer = setTimeout(() => setVisible(true), 300)
      return () => clearTimeout(timer)
    }
    setVisible(false)
  }, [suggestion])

  const handleAccept = useCallback(() => {
    if (suggestion) {
      onAccept(suggestion.model.id)
      setVisible(false)
    }
  }, [suggestion, onAccept])

  if (!suggestion || !visible) return null

  return (
    <div
      className={cn(
        "flex items-center gap-1.5 px-2 py-1 rounded-md text-xs",
        "bg-muted/60 border border-border/50",
        "animate-in fade-in slide-in-from-bottom-1 duration-200",
        className,
      )}
    >
      <Zap className={cn("h-3 w-3 shrink-0", getCostTierColor(suggestion.model.costTier))} />
      <span className="text-muted-foreground">{suggestion.reason}</span>
      <button
        type="button"
        onClick={handleAccept}
        className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
      >
        Switch
      </button>
      <button
        type="button"
        onClick={onDismiss}
        className="p-0.5 rounded text-muted-foreground/50 hover:text-muted-foreground transition-colors"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  )
})
