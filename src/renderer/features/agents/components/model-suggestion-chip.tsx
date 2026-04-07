"use client"

import { memo, useCallback, useEffect, useState } from "react"
import { X, Zap, SlidersHorizontal } from "lucide-react"
import { cn } from "../../../lib/utils"
import { getCostTierColor, type ClaudeModel } from "../lib/models"
import { recordDismissal, type SettingsRecommendation } from "../lib/smart-router"

interface ModelSuggestionChipProps {
  suggestion: { model: ClaudeModel; reason: string } | null
  /** The model the user currently has selected (needed for dismissal tracking) */
  currentModelId?: string
  onAccept: (modelId: string) => void
  onDismiss: () => void
  /** Optional settings recommendations to show alongside model suggestion */
  settingsRecommendations?: SettingsRecommendation[]
  /** Called when user accepts a settings recommendation */
  onAcceptSettingsChange?: (recommendation: SettingsRecommendation) => void
  className?: string
}

export const ModelSuggestionChip = memo(function ModelSuggestionChip({
  suggestion,
  currentModelId,
  onAccept,
  onDismiss,
  settingsRecommendations,
  onAcceptSettingsChange,
  className,
}: ModelSuggestionChipProps) {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    if (suggestion || (settingsRecommendations && settingsRecommendations.length > 0)) {
      // Small delay so it doesn't flash on every keystroke
      const timer = setTimeout(() => setVisible(true), 300)
      return () => clearTimeout(timer)
    }
    setVisible(false)
  }, [suggestion, settingsRecommendations])

  const handleAccept = useCallback(() => {
    if (suggestion) {
      onAccept(suggestion.model.id)
      setVisible(false)
    }
  }, [suggestion, onAccept])

  const handleDismiss = useCallback(() => {
    // Record the dismissal so we learn the user's preference
    if (suggestion && currentModelId) {
      recordDismissal(currentModelId, suggestion.model.id)
    }
    onDismiss()
  }, [suggestion, currentModelId, onDismiss])

  const hasModelSuggestion = suggestion !== null
  const hasSettingsSuggestion = settingsRecommendations && settingsRecommendations.length > 0

  if ((!hasModelSuggestion && !hasSettingsSuggestion) || !visible) return null

  return (
    <div
      className={cn(
        "flex flex-col gap-1",
        "animate-in fade-in slide-in-from-bottom-1 duration-200",
        className,
      )}
    >
      {/* Model recommendation */}
      {hasModelSuggestion && (
        <div className="flex items-center gap-1.5 px-2 py-1 rounded-md text-xs bg-muted/60 border border-border/50">
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
            onClick={handleDismiss}
            className="p-0.5 rounded text-muted-foreground/50 hover:text-muted-foreground transition-colors"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      )}

      {/* Settings recommendations (effort, thinking) */}
      {hasSettingsSuggestion && onAcceptSettingsChange && settingsRecommendations.map((rec, i) => (
        <div
          key={`${rec.type}-${i}`}
          className="flex items-center gap-1.5 px-2 py-1 rounded-md text-xs bg-muted/40 border border-border/30"
        >
          <SlidersHorizontal className="h-3 w-3 shrink-0 text-muted-foreground" />
          <span className="text-muted-foreground">{rec.reason}</span>
          <button
            type="button"
            onClick={() => onAcceptSettingsChange(rec)}
            className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
          >
            {rec.type === "effort" ? `Set ${rec.suggested}` : `Use ${rec.suggested}`}
          </button>
        </div>
      ))}
    </div>
  )
})
