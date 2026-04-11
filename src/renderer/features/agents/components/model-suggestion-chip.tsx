import { memo, useCallback, useEffect, useState } from "react"
import { X, Zap, SlidersHorizontal } from "lucide-react"
import { cn } from "../../../lib/utils"
import { getCostTierColor, type ClaudeModel } from "../lib/models"
import { type SettingsRecommendation } from "../lib/smart-router"

interface ModelSuggestionChipProps {
  modelSuggestion: { model: ClaudeModel; reason: string } | null
  settingsRecommendations: SettingsRecommendation[]
  onAccept: () => void
  onDismiss: () => void
  className?: string
}

export const ModelSuggestionChip = memo(function ModelSuggestionChip({
  modelSuggestion,
  settingsRecommendations,
  onAccept,
  onDismiss,
  className,
}: ModelSuggestionChipProps) {
  const [visible, setVisible] = useState(false)

  const hasSuggestion = modelSuggestion !== null || settingsRecommendations.length > 0

  useEffect(() => {
    if (hasSuggestion) {
      const timer = setTimeout(() => setVisible(true), 300)
      return () => clearTimeout(timer)
    }
    setVisible(false)
  }, [hasSuggestion])

  const handleAccept = useCallback(() => {
    onAccept()
    setVisible(false)
  }, [onAccept])

  if (!hasSuggestion || !visible) return null

  // Build combined label
  const effortRec = settingsRecommendations.find((r) => r.type === "effort")
  const thinkingRec = settingsRecommendations.find((r) => r.type === "thinking")

  let label: string
  let useZap = false
  let costTier: ClaudeModel["costTier"] | undefined

  if (modelSuggestion && effortRec) {
    label = `Switch to ${modelSuggestion.model.name} · ${effortRec.suggested} effort`
    useZap = true
    costTier = modelSuggestion.model.costTier
  } else if (modelSuggestion) {
    label = `Switch to ${modelSuggestion.model.name}`
    useZap = true
    costTier = modelSuggestion.model.costTier
  } else if (effortRec) {
    label = `Set ${effortRec.suggested} effort`
  } else if (thinkingRec) {
    label = `Use ${thinkingRec.suggested} thinking`
  } else {
    return null
  }

  return (
    <div
      className={cn(
        "flex items-center gap-0.5 px-1.5 py-1 rounded-md bg-primary/5 border border-primary/10",
        "animate-in fade-in slide-in-from-bottom-1 duration-200",
        className,
      )}
    >
      <button
        type="button"
        onClick={handleAccept}
        className="flex items-center gap-1 px-1.5 py-0 rounded text-[11px] font-medium text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
      >
        {useZap ? (
          <Zap className={cn("h-2.5 w-2.5 shrink-0", costTier && getCostTierColor(costTier))} />
        ) : (
          <SlidersHorizontal className="h-2.5 w-2.5 shrink-0" />
        )}
        <span>{label}</span>
      </button>
      <button
        type="button"
        onClick={onDismiss}
        className="p-0.25 rounded text-muted-foreground/40 hover:text-muted-foreground hover:bg-primary/10 transition-colors ml-0.5"
      >
        <X className="h-2 w-2" />
      </button>
    </div>
  )
})
