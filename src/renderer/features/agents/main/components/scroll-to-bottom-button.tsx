import { memo, useEffect, useRef, useState } from "react"
import { ArrowDown } from "lucide-react"
import { AnimatePresence, motion } from "motion/react"
import { Tooltip, TooltipContent, TooltipTrigger } from "../../../../components/ui/tooltip"
import { Kbd } from "../../../../components/ui/kbd"
import { cn } from "../../../../lib/utils"

export const ScrollToBottomButton = memo(function ScrollToBottomButton({
  containerRef,
  onScrollToBottom,
  hasStackedCards = false,
  subChatId,
  isActive = true,
  isSplitPane = false,
}: {
  containerRef: React.RefObject<HTMLElement | null>
  onScrollToBottom: () => void
  hasStackedCards?: boolean
  subChatId?: string
  isActive?: boolean
  isSplitPane?: boolean
}) {
  const [isVisible, setIsVisible] = useState(false)
  const shouldMonitor = isActive || isSplitPane

  // Keep current monitoring state in ref for scroll event handler
  const shouldMonitorRef = useRef(shouldMonitor)
  shouldMonitorRef.current = shouldMonitor

  useEffect(() => {
    // Skip scroll monitoring for tabs that are not visible (keep-alive)
    if (!shouldMonitor) return

    const container = containerRef.current
    if (!container) return

    // RAF throttle to avoid setState on every scroll event
    let rafId: number | null = null
    let lastAtBottom: boolean | null = null

    const checkVisibility = () => {
      // Skip if tab is not visible or RAF already pending
      if (!shouldMonitorRef.current || rafId !== null) return

      rafId = requestAnimationFrame(() => {
        rafId = null
        // Double-check current monitoring state in RAF callback
        if (!shouldMonitorRef.current) return

        const threshold = 50
        const atBottom =
          container.scrollHeight - container.scrollTop - container.clientHeight <=
          threshold

        // Only update state if value actually changed
        if (lastAtBottom !== atBottom) {
          lastAtBottom = atBottom
          setIsVisible(!atBottom)
        }
      })
    }

    // Check initial state after a short delay to allow scroll position to be set
    // This handles the case when entering a sub-chat that's scrolled to a specific position
    const timeoutId = setTimeout(() => {
      // Skip if tab is not visible
      if (!shouldMonitorRef.current) return

      // Direct check for initial state (no RAF needed)
      const threshold = 50
      const atBottom =
        container.scrollHeight - container.scrollTop - container.clientHeight <=
        threshold
      lastAtBottom = atBottom
      setIsVisible(!atBottom)
    }, 50)

    container.addEventListener("scroll", checkVisibility, { passive: true })
    return () => {
      clearTimeout(timeoutId)
      if (rafId !== null) cancelAnimationFrame(rafId)
      container.removeEventListener("scroll", checkVisibility)
    }
  }, [containerRef, subChatId, shouldMonitor])

  return (
    <AnimatePresence>
      {isVisible && (
        <Tooltip delayDuration={300}>
          <TooltipTrigger asChild>
            <motion.button
              initial={{ opacity: 0, scale: 0.96, y: 8 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.96, y: 8 }}
              transition={{ duration: 0.2, ease: [0.23, 1, 0.32, 1] }}
              onClick={onScrollToBottom}
              className={cn(
                "absolute p-2 rounded-full bg-background border border-border shadow-md hover:bg-accent active:scale-[0.97] transition-[color,background-color,bottom] duration-200 z-20",
              )}
              style={{
                right: "0.75rem",
                // Wide screen (container > 48rem): button sits in bottom-right corner
                // Narrow screen (container <= 48rem): button lifts above the input
                bottom: "clamp(0.75rem, (48rem - var(--chat-container-width, 0px)) * 1000, calc(var(--chat-input-height, 4rem) + 1rem))",
              }}
              aria-label="Scroll to bottom"
            >
              <ArrowDown className="h-4 w-4 text-muted-foreground" />
            </motion.button>
          </TooltipTrigger>
          <TooltipContent side="top">
            Scroll to bottom
            <span className="inline-flex items-center gap-0.5">
              <Kbd>⌘</Kbd>
              <Kbd>
                <ArrowDown className="h-3 w-3" />
              </Kbd>
            </span>
          </TooltipContent>
        </Tooltip>
      )}
    </AnimatePresence>
  )
})
