import { memo, useCallback, useEffect, useRef, useState } from "react"
import { AnimatePresence, motion } from "motion/react"
import { X } from "lucide-react"
import { cn } from "../../../lib/utils"

interface BtwEntry {
  id: string
  question: string
  answer: string | null
  isLoading: boolean
  error?: string
}

interface BtwPopoverProps {
  entries: BtwEntry[]
  onDismiss: (id: string) => void
  onDismissAll: () => void
}

export const BtwPopover = memo(function BtwPopover({
  entries,
  onDismiss,
  onDismissAll,
}: BtwPopoverProps) {
  if (entries.length === 0) return null

  return (
    <div className="absolute bottom-16 right-4 z-50 flex flex-col gap-2 max-w-sm">
      <AnimatePresence mode="popLayout">
        {entries.map((entry) => (
          <BtwCard key={entry.id} entry={entry} onDismiss={onDismiss} />
        ))}
      </AnimatePresence>
    </div>
  )
})

const BtwCard = memo(function BtwCard({
  entry,
  onDismiss,
}: {
  entry: BtwEntry
  onDismiss: (id: string) => void
}) {
  const cardRef = useRef<HTMLDivElement>(null)

  // Dismiss on Escape
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        onDismiss(entry.id)
      }
    }
    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [entry.id, onDismiss])

  return (
    <motion.div
      ref={cardRef}
      initial={{ opacity: 0, y: 20, scale: 0.95 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -10, scale: 0.95 }}
      transition={{ duration: 0.2 }}
      className={cn(
        "relative rounded-lg border bg-popover/95 backdrop-blur-sm shadow-lg",
        "p-3 pr-8 max-w-sm",
      )}
    >
      {/* Close button */}
      <button
        onClick={() => onDismiss(entry.id)}
        className="absolute top-2 right-2 text-muted-foreground/40 hover:text-muted-foreground transition-colors"
      >
        <X className="w-3 h-3" />
      </button>

      {/* Question */}
      <div className="text-[10px] text-muted-foreground/50 font-medium mb-1">
        /btw
      </div>
      <div className="text-xs text-muted-foreground mb-2 italic">
        {entry.question}
      </div>

      {/* Answer */}
      {entry.isLoading ? (
        <div className="text-xs text-muted-foreground/60 animate-pulse">
          Thinking...
        </div>
      ) : entry.error ? (
        <div className="text-xs text-destructive">
          {entry.error}
        </div>
      ) : (
        <div className="text-xs text-foreground/80 leading-relaxed whitespace-pre-wrap">
          {entry.answer}
        </div>
      )}

      {/* Dismiss hint */}
      {!entry.isLoading && (
        <div className="text-[9px] text-muted-foreground/30 mt-2">
          Press Esc to dismiss
        </div>
      )}
    </motion.div>
  )
})
