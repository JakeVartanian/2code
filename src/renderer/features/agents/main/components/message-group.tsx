import { useEffect, useRef } from "react"

interface MessageGroupProps {
  children: React.ReactNode
  isLastGroup?: boolean
}

export function MessageGroup({ children, isLastGroup }: MessageGroupProps) {
  const groupRef = useRef<HTMLDivElement>(null)
  const userMessageRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const groupEl = groupRef.current
    if (!groupEl) return

    // Find the actual bubble element (not the wrapper which includes gradient)
    const bubbleEl = groupEl.querySelector('[data-user-bubble]') as HTMLDivElement | null
    if (!bubbleEl) return

    userMessageRef.current = bubbleEl

    const updateHeight = () => {
      const height = bubbleEl.offsetHeight
      // Set CSS variable directly on DOM - no React state, no re-renders
      groupEl.style.setProperty('--user-message-height', `${height}px`)
    }

    updateHeight()

    const observer = new ResizeObserver(updateHeight)
    observer.observe(bubbleEl)

    return () => observer.disconnect()
  }, [])

  return (
    <div
      ref={groupRef}
      className="relative"
      style={{
        // content-visibility: auto - browser skips layout/paint for elements outside viewport
        // Huge optimization for long chats - only visible content renders
        // NOT applied to last group: it's always visible and actively streaming,
        // content-visibility on it interferes with scrollHeight during streaming
        ...(!isLastGroup && {
          contentVisibility: "auto",
          containIntrinsicSize: "auto 200px",
        }),
        // Last group has minimum height of chat container (minus padding)
        ...(isLastGroup && { minHeight: "calc(var(--chat-container-height) - 32px)" }),
      }}
      data-last-group={isLastGroup || undefined}
    >
      {children}
    </div>
  )
}
