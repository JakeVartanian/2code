import { Wand2, X } from "lucide-react"
import { memo, useCallback, useEffect, useRef, useState } from "react"

import { IconSpinner } from "../../../components/ui/icons"
import { cn } from "../../../lib/utils"
import { trpc } from "../../../lib/trpc"
import type { AgentsMentionsEditorHandle } from "../mentions"
import { toast } from "sonner"

interface PromptOptimizerChipProps {
  editorRef: React.RefObject<AgentsMentionsEditorHandle | null>
  hasContent: boolean
  isStreaming: boolean
}

function estimateTokens(text: string): number {
  const words = text.split(/\s+/).filter(Boolean).length
  return Math.ceil(words * 1.3)
}

export const PromptOptimizerChip = memo(function PromptOptimizerChip({
  editorRef,
  hasContent,
  isStreaming,
}: PromptOptimizerChipProps) {
  const [isOptimizing, setIsOptimizing] = useState(false)
  const [previousText, setPreviousText] = useState<string | null>(null)
  const [savings, setSavings] = useState<{ tokens: number; percent: number } | null>(null)
  const textAtOptimizeTimeRef = useRef<string | null>(null)

  const optimizeMutation = trpc.claude.optimizePrompt.useMutation()

  // Check text length to decide visibility
  const currentText = editorRef.current?.getValue() || ""
  const textLength = currentText.trim().length
  const showChip = hasContent && textLength >= 40 && !isStreaming

  // Clear savings when editor content changes
  useEffect(() => {
    if (savings && previousText !== null) {
      const current = editorRef.current?.getValue() || ""
      if (current !== textAtOptimizeTimeRef.current) {
        setSavings(null)
        setPreviousText(null)
        textAtOptimizeTimeRef.current = null
      }
    }
  })

  const handleOptimize = useCallback(async () => {
    if (isOptimizing || !editorRef.current) return

    const text = editorRef.current.getValue()
    if (!text || text.trim().length < 40) return

    setPreviousText(text)
    textAtOptimizeTimeRef.current = text
    setIsOptimizing(true)
    setSavings(null)

    try {
      const result = await optimizeMutation.mutateAsync({ text })

      // Discard if user edited during optimization
      const currentText = editorRef.current?.getValue() || ""
      if (currentText !== textAtOptimizeTimeRef.current) {
        setIsOptimizing(false)
        setPreviousText(null)
        textAtOptimizeTimeRef.current = null
        return
      }

      editorRef.current.setValue(result.optimized)
      textAtOptimizeTimeRef.current = result.optimized

      const originalTokens = result.originalTokenCount
      const optimizedTokens = result.optimizedTokenCount
      const savedTokens = originalTokens - optimizedTokens
      const percent = originalTokens > 0 ? Math.round((savedTokens / originalTokens) * 100) : 0

      if (percent >= 2) {
        setSavings({ tokens: savedTokens, percent })
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error"
      console.error("[PromptOptimizer] Failed:", msg)
      toast.error("Couldn't optimize prompt")
      setPreviousText(null)
      textAtOptimizeTimeRef.current = null
    } finally {
      setIsOptimizing(false)
    }
  }, [isOptimizing, editorRef, optimizeMutation])

  const handleUndo = useCallback(() => {
    if (previousText !== null && editorRef.current) {
      editorRef.current.setValue(previousText)
      textAtOptimizeTimeRef.current = null
    }
    setSavings(null)
    setPreviousText(null)
  }, [previousText, editorRef])

  // Keyboard shortcut: Cmd+Shift+O
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "o") {
        e.preventDefault()
        handleOptimize()
      }
    }
    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [handleOptimize])

  if (!showChip && !savings && !isOptimizing) return null

  // Savings state — show result with undo
  if (savings) {
    const label = savings.percent < 5
      ? "Optimized"
      : `Saved ${savings.percent}%`

    return (
      <div
        className={cn(
          "flex items-center gap-0.5 px-1.5 py-1 rounded-md bg-green-500/5 border border-green-500/10",
          "animate-in fade-in slide-in-from-bottom-1 duration-200",
        )}
      >
        <span className="flex items-center gap-1 px-1.5 py-0 text-[11px] font-medium text-green-300">
          <Wand2 className="h-2.5 w-2.5 shrink-0" />
          <span>{label}</span>
        </span>
        <button
          type="button"
          onClick={handleUndo}
          className="p-0.25 rounded text-muted-foreground/40 hover:text-muted-foreground hover:bg-primary/10 transition-colors ml-0.5"
          aria-label="Undo optimization"
        >
          <X className="h-2 w-2" />
        </button>
      </div>
    )
  }

  // Loading state
  if (isOptimizing) {
    return (
      <div
        className={cn(
          "flex items-center gap-0.5 px-1.5 py-1 rounded-md bg-primary/5 border border-primary/10",
        )}
      >
        <span className="flex items-center gap-1 px-1.5 py-0 text-[11px] font-medium text-muted-foreground">
          <IconSpinner className="h-2.5 w-2.5 shrink-0" />
          <span>Optimizing...</span>
        </span>
      </div>
    )
  }

  // Idle — small chip button
  return (
    <div
      className={cn(
        "flex items-center gap-0.5 px-1.5 py-1 rounded-md bg-primary/5 border border-primary/10",
        "animate-in fade-in slide-in-from-bottom-1 duration-200",
      )}
    >
      <button
        type="button"
        onClick={handleOptimize}
        className="flex items-center gap-1 px-1.5 py-0 rounded text-[11px] font-medium text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
      >
        <Wand2 className="h-2.5 w-2.5 shrink-0" />
        <span>Optimize</span>
      </button>
    </div>
  )
})
