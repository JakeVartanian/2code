"use client"

import { useState, useRef, useCallback, useEffect, useMemo } from "react"
import { useAtom } from "jotai"
import { Button } from "../../../components/ui/button"
import { RotateCw, Terminal, ClipboardList, SquareArrowOutUpRight } from "lucide-react"
import {
  ExternalLinkIcon,
  IconDoubleChevronRight,
  IconChatBubble,
} from "../../../components/ui/icons"
import { PreviewUrlInput } from "./preview-url-input"
import {
  previewPathAtomFamily,
  viewportModeAtomFamily,
  previewScaleAtomFamily,
  mobileDeviceAtomFamily,
  previewViewModeAtomFamily,
} from "../atoms"
import { cn } from "../../../lib/utils"
import { Logo } from "../../../components/ui/logo"
import { ViewportToggle } from "./viewport-toggle"
import { ScaleControl } from "./scale-control"
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "../../../components/ui/dropdown-menu"
import { trpc } from "../../../lib/trpc"
import { DevicePresetsBar } from "./device-presets-bar"
import { ResizeHandle } from "./resize-handle"
import { MobileCopyLinkButton } from "./mobile-copy-link-button"
import { PreviewCompareView } from "./preview-compare-view"
import { PreviewPageRegistry } from "./preview-page-registry"
import { DEVICE_PRESETS, AGENTS_PREVIEW_CONSTANTS } from "../constants"
// import { getSandboxPreviewUrl } from "@/app/(alpha)/canvas/{components}/settings-tabs/repositories/preview-url"
const getSandboxPreviewUrl = (sandboxId: string, port: number, _type: string) => `https://${sandboxId}-${port}.csb.app` // Desktop mock

/**
 * Dropdown menu for opening preview in different modes:
 * - In 2Code window (Electron)
 * - In system browser
 */
function ExternalLinkDropdown({ url }: { url: string }) {
  const externalMutation = trpc.external.openExternal.useMutation()

  const handleOpenInBrowser = () => {
    externalMutation.mutate(url)
  }

  const handleOpenIn2Code = () => {
    window.open(url, "_blank")
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          className="h-7 w-7 p-0 hover:bg-muted transition-[background-color,transform] duration-150 ease-out active:scale-[0.97] rounded-md"
        >
          <ExternalLinkIcon className="h-3.5 w-3.5 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuItem onClick={handleOpenInBrowser} className="gap-2">
          <SquareArrowOutUpRight className="h-4 w-4" />
          <span>Open in browser</span>
        </DropdownMenuItem>
        <DropdownMenuItem onClick={handleOpenIn2Code} className="gap-2">
          <ExternalLinkIcon className="h-4 w-4" />
          <span>Open in 2Code window</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

interface AgentPreviewProps {
  chatId: string
  sandboxId?: string
  port?: number
  localhostUrl?: string
  projectPath?: string
  repository?: string
  hideHeader?: boolean
  onClose?: () => void
  isMobile?: boolean
}

export function AgentPreview({
  chatId,
  sandboxId,
  port,
  localhostUrl,
  projectPath,
  repository,
  hideHeader = false,
  onClose,
  isMobile = false,
}: AgentPreviewProps) {
  const [isLoaded, setIsLoaded] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const frameRef = useRef<HTMLDivElement>(null)
  const resizeCleanupRef = useRef<(() => void) | null>(null)

  // Persisted state from Jotai atoms (per chatId)
  const [persistedPath, setPersistedPath] = useAtom(
    previewPathAtomFamily(chatId),
  )
  const [viewportMode, setViewportMode] = useAtom(
    viewportModeAtomFamily(chatId),
  )
  const [scale, setScale] = useAtom(previewScaleAtomFamily(chatId))
  const [device, setDevice] = useAtom(mobileDeviceAtomFamily(chatId))
  const [previewViewMode, setPreviewViewMode] = useAtom(
    previewViewModeAtomFamily(chatId),
  )

  // Local state for resizing
  const [isResizing, setIsResizing] = useState(false)
  const [maxWidth, setMaxWidth] = useState<number>(
    AGENTS_PREVIEW_CONSTANTS.MAX_WIDTH,
  )

  // Dual state architecture:
  // - loadedPath: Controls iframe src (stable, only changes on manual navigation)
  // - currentPath: Display path (updates immediately on internal navigation)
  const [loadedPath, setLoadedPath] = useState(persistedPath)
  const [currentPath, setCurrentPath] = useState(persistedPath)

  // Listen for reload events from external header
  useEffect(() => {
    const handleReload = (e: CustomEvent) => {
      if (e.detail?.chatId === chatId) {
        setReloadKey((prev) => prev + 1)
        setIsRefreshing(true)
        setTimeout(() => setIsRefreshing(false), 400)
      }
    }

    window.addEventListener(
      "agent-preview-reload",
      handleReload as EventListener,
    )
    return () =>
      window.removeEventListener(
        "agent-preview-reload",
        handleReload as EventListener,
      )
  }, [chatId])

  // Listen for navigation events from external header
  useEffect(() => {
    const handleNavigate = (e: CustomEvent) => {
      if (e.detail?.chatId === chatId && e.detail?.path) {
        setLoadedPath(e.detail.path)
        setCurrentPath(e.detail.path)
        setPersistedPath(e.detail.path)
        setIsLoaded(false)
      }
    }

    window.addEventListener(
      "agent-preview-navigate",
      handleNavigate as EventListener,
    )
    return () =>
      window.removeEventListener(
        "agent-preview-navigate",
        handleNavigate as EventListener,
      )
  }, [chatId, setPersistedPath])

  // Dispatch path updates to header
  useEffect(() => {
    window.dispatchEvent(
      new CustomEvent("agent-preview-path-update", {
        detail: { chatId, path: currentPath },
      }),
    )
  }, [chatId, currentPath])

  // Sync loadedPath when persistedPath changes (e.g., on mount with stored value)
  useEffect(() => {
    setLoadedPath(persistedPath)
    setCurrentPath(persistedPath)
  }, [persistedPath])

  // Compute base host and preview URL — localhost takes priority over sandbox
  const previewBaseUrl = useMemo(() => {
    if (localhostUrl) return localhostUrl
    if (sandboxId && port) return getSandboxPreviewUrl(sandboxId, port, "agents")
    return null
  }, [localhostUrl, sandboxId, port])

  const baseHost = useMemo(() => {
    if (!previewBaseUrl) return null
    try {
      return new URL(previewBaseUrl).host
    } catch {
      return null
    }
  }, [previewBaseUrl])

  const previewUrl = useMemo(() => {
    if (!previewBaseUrl) return null
    return `${previewBaseUrl}${loadedPath}`
  }, [previewBaseUrl, loadedPath])

  const isLocalhost = !!localhostUrl

  // Handle path selection from URL bar
  const handlePathSelect = useCallback(
    (path: string) => {
      setLoadedPath(path) // Triggers iframe reload via src change
      setCurrentPath(path) // Updates URL bar display
      setPersistedPath(path) // Persist to localStorage
      setIsLoaded(false) // Show loading state
    },
    [setPersistedPath],
  )

  // Listen for SET_URL messages from iframe for bi-directional sync
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      // Verify source is our iframe
      if (
        !iframeRef.current ||
        event.source !== iframeRef.current.contentWindow
      ) {
        return
      }

      // Handle SET_URL messages from preview script
      if (event.data?.type === "SET_URL") {
        const newPath = event.data.url || "/"

        // Skip srcdoc paths (edge case from iframe)
        if (newPath.includes("srcdoc")) {
          return
        }

        // Update ONLY currentPath for immediate display update
        // Do NOT update loadedPath - that would cause iframe remount
        setCurrentPath(newPath)
        setPersistedPath(newPath) // Persist to localStorage
      }
    }

    window.addEventListener("message", handleMessage)
    return () => window.removeEventListener("message", handleMessage)
  }, [setPersistedPath])

  // Calculate max width on mount and window resize
  useEffect(() => {
    const updateMaxWidth = () => {
      const availableWidth = window.innerWidth - 64 // Account for padding/margins
      setMaxWidth(Math.max(AGENTS_PREVIEW_CONSTANTS.MIN_WIDTH, availableWidth))
    }

    updateMaxWidth()
    window.addEventListener("resize", updateMaxWidth)
    return () => window.removeEventListener("resize", updateMaxWidth)
  }, [])

  // Cleanup resize handlers on unmount
  useEffect(() => {
    return () => {
      resizeCleanupRef.current?.()
    }
  }, [])

  const handleReload = useCallback(() => {
    if (isRefreshing) return
    setIsRefreshing(true)
    setIsLoaded(false)
    setReloadKey((prev) => prev + 1)
    setTimeout(() => setIsRefreshing(false), 400)
  }, [isRefreshing])

  const handlePresetChange = useCallback(
    (presetName: string) => {
      const preset = DEVICE_PRESETS.find((p) => p.name === presetName)
      if (preset) {
        setDevice({
          width: preset.width,
          height: preset.height,
          preset: preset.name,
        })
      }
    },
    [setDevice],
  )

  const handleWidthChange = useCallback(
    (width: number) => {
      setDevice({
        ...device,
        width,
        preset: "Custom",
      })
    },
    [device, setDevice],
  )

  const handleResizeStart = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault()
      e.stopPropagation()

      const handle = e.currentTarget as HTMLElement
      const pointerId = e.pointerId
      const isLeftHandle = handle.getAttribute("data-side") === "left"
      const startX = e.clientX
      const startWidth = device.width
      const frame = frameRef.current

      if (!frame) return

      handle.setPointerCapture(pointerId)
      setIsResizing(true)

      const handlePointerMove = (e: PointerEvent) => {
        let delta = e.clientX - startX
        if (isLeftHandle) {
          delta = -delta
        }
        const newWidth = Math.round(
          Math.max(
            AGENTS_PREVIEW_CONSTANTS.MIN_WIDTH,
            Math.min(maxWidth, startWidth + delta * 2),
          ),
        )
        frame.style.width = `${newWidth}px`
        setDevice({
          ...device,
          width: newWidth,
          preset: "Custom",
        })
      }

      const handlePointerUp = () => {
        if (handle.hasPointerCapture(pointerId)) {
          handle.releasePointerCapture(pointerId)
        }
        setIsResizing(false)
        cleanup()
      }

      const handlePointerCancel = () => {
        if (handle.hasPointerCapture(pointerId)) {
          handle.releasePointerCapture(pointerId)
        }
        cleanup()
      }

      const cleanup = () => {
        handle.removeEventListener("pointermove", handlePointerMove as any)
        handle.removeEventListener("pointerup", handlePointerUp as any)
        handle.removeEventListener("pointercancel", handlePointerCancel as any)
        document.body.style.userSelect = ""
        document.body.style.cursor = ""
        resizeCleanupRef.current = null
      }

      document.body.style.userSelect = "none"
      document.body.style.cursor = "ew-resize"
      handle.addEventListener("pointermove", handlePointerMove as any)
      handle.addEventListener("pointerup", handlePointerUp as any)
      handle.addEventListener("pointercancel", handlePointerCancel as any)
      resizeCleanupRef.current = cleanup
    },
    [device, maxWidth, setDevice],
  )

  return (
    <div
      className={cn(
        "flex flex-col bg-tl-background",
        isMobile ? "h-full w-full" : "h-full",
      )}
    >
      {/* Mobile Header */}
      {isMobile && !hideHeader && (
        <div
          className="flex-shrink-0 bg-background/95 backdrop-blur border-b h-11 min-h-[44px] max-h-[44px]"
          data-mobile-preview-header
          style={{
            // @ts-expect-error - WebKit-specific property for Electron window dragging
            WebkitAppRegion: "drag",
          }}
        >
          <div
            className="flex h-full items-center px-2 gap-2"
            style={{
              // @ts-expect-error - WebKit-specific property
              WebkitAppRegion: "no-drag",
            }}
          >
            {/* Chat button */}
            <Button
              variant="ghost"
              size="icon"
              onClick={onClose}
              className="h-7 w-7 p-0 hover:bg-foreground/10 transition-[background-color,transform] duration-150 ease-out active:scale-[0.97] flex-shrink-0 rounded-md"
            >
              <IconChatBubble className="h-4 w-4" />
              <span className="sr-only">Back to chat</span>
            </Button>

            {/* Reload button */}
            <Button
              variant="ghost"
              size="icon"
              onClick={handleReload}
              disabled={isRefreshing}
              className="h-7 w-7 p-0 hover:bg-foreground/10 transition-[background-color,transform] duration-150 ease-out active:scale-[0.97] flex-shrink-0 rounded-md"
            >
              <RotateCw
                className={cn("h-4 w-4", isRefreshing && "animate-spin")}
              />
            </Button>

            {/* URL Input - centered, flexible */}
            <div className="flex-1 min-w-0 mx-1">
              <PreviewUrlInput
                baseHost={baseHost ?? ""}
                currentPath={currentPath}
                onPathChange={handlePathSelect}
                isLoading={!isLoaded}
                className="w-full"
                variant="mobile"
              />
            </div>

            {/* Scale control */}
            <ScaleControl value={scale} onChange={setScale} />

            {/* Copy link button */}
            {previewUrl && <MobileCopyLinkButton url={previewUrl} />}
          </div>
        </div>
      )}

      {/* Desktop Header */}
      {!isMobile && !hideHeader && (
        <div className="flex items-center justify-between px-3 h-10 bg-tl-background flex-shrink-0">
          {/* Left: Refresh + Viewport Toggle + Scale */}
          <div className="flex items-center gap-1 flex-1">
            <Button
              variant="ghost"
              onClick={handleReload}
              disabled={isRefreshing}
              className="h-7 w-7 p-0 hover:bg-muted transition-[background-color,transform] duration-150 ease-out active:scale-[0.97] rounded-md"
            >
              <RotateCw
                className={cn(
                  "h-3.5 w-3.5 text-muted-foreground",
                  isRefreshing && "animate-spin",
                )}
              />
            </Button>

            <ViewportToggle value={viewportMode} onChange={setViewportMode} />

            <ScaleControl value={scale} onChange={setScale} />
          </div>

          {/* Center: URL bar */}
          <div className="flex-1 mx-2 min-w-0 flex items-center justify-center">
            <PreviewUrlInput
              baseHost={baseHost}
              currentPath={currentPath}
              onPathChange={handlePathSelect}
              isLoading={!isLoaded}
              className="max-w-[350px] w-full"
            />
          </div>

          {/* Right: Registry + External link + Close */}
          <div className="flex items-center justify-end gap-1 flex-1">
            {projectPath && (
              <Button
                variant="ghost"
                className={cn(
                  "h-7 w-7 p-0 hover:bg-muted transition-[background-color,transform] duration-150 ease-out active:scale-[0.97] rounded-md",
                  previewViewMode === "registry" && "bg-muted",
                )}
                onClick={() =>
                  setPreviewViewMode(
                    previewViewMode === "registry" ? "preview" : "registry",
                  )
                }
              >
                <ClipboardList className="h-3.5 w-3.5 text-muted-foreground" />
              </Button>
            )}
            {previewUrl && <ExternalLinkDropdown url={previewUrl} />}

            {onClose && (
              <Button
                variant="ghost"
                className="h-7 w-7 p-0 hover:bg-muted transition-[background-color,transform] duration-150 ease-out active:scale-[0.97] rounded-md"
                onClick={onClose}
              >
                <IconDoubleChevronRight className="h-4 w-4 text-muted-foreground" />
              </Button>
            )}
          </div>
        </div>
      )}

      {/* Device presets bar - only visible in mobile viewport mode (not on actual mobile devices) */}
      {!isMobile && !hideHeader && viewportMode === "mobile" && (
        <DevicePresetsBar
          selectedPreset={device.preset}
          width={device.width}
          height={device.height}
          onPresetChange={handlePresetChange}
          onWidthChange={handleWidthChange}
          maxWidth={maxWidth}
        />
      )}

      {/* Registry view */}
      {previewViewMode === "registry" && projectPath && (
        <PreviewPageRegistry
          chatId={chatId}
          projectPath={projectPath}
          onBack={() => setPreviewViewMode("preview")}
          onNavigate={(path, viewport) => {
            handlePathSelect(path)
            if (viewport === "mobile") setViewportMode("mobile")
            else if (viewport === "desktop") setViewportMode("desktop")
            setPreviewViewMode("preview")
          }}
        />
      )}

      {/* Content area */}
      {previewViewMode !== "registry" && <div
        className={cn(
          "flex-1 relative flex items-center justify-center overflow-hidden",
          isMobile ? "w-full h-full" : "px-1 pb-1",
        )}
      >
        {!previewUrl ? (
          // Empty state — no dev server detected
          <div className="flex flex-col items-center justify-center h-full px-6 text-center gap-4">
            <div className="flex items-center justify-center w-12 h-12 rounded-xl bg-muted/50">
              <Terminal className="h-6 w-6 text-muted-foreground" />
            </div>
            <div className="space-y-1.5">
              <p className="text-sm font-medium text-foreground">No server detected</p>
              <p className="text-xs text-muted-foreground leading-relaxed max-w-[240px]">
                Start a dev server in your project and it will appear here automatically.
              </p>
            </div>
            <div className="flex flex-wrap items-center justify-center gap-1.5 text-[11px] text-muted-foreground font-mono">
              <span className="px-1.5 py-0.5 bg-muted rounded">npm run dev</span>
              <span>·</span>
              <span className="px-1.5 py-0.5 bg-muted rounded">bun dev</span>
              <span>·</span>
              <span className="px-1.5 py-0.5 bg-muted rounded">yarn dev</span>
            </div>
          </div>
        ) : isMobile ? (
          // Mobile: Fullscreen iframe with scale support
          <div className="relative overflow-hidden w-full h-full flex-shrink-0 bg-background">
            <div
              className="w-full h-full"
              style={
                scale !== 100
                  ? {
                      width: `${(100 / scale) * 100}%`,
                      height: `${(100 / scale) * 100}%`,
                      transform: `scale(${scale / 100})`,
                      transformOrigin: "top left",
                    }
                  : undefined
              }
            >
              <iframe
                ref={iframeRef}
                key={reloadKey}
                src={previewUrl}
                width="100%"
                height="100%"
                style={{ border: "none" }}
                title="Preview"
                sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
                allow="clipboard-write"
                onLoad={() => setIsLoaded(true)}
                onError={() => setIsLoaded(true)}
              />
            </div>
            {/* Loading overlay */}
            {!isLoaded && (
              <div className="absolute inset-0 flex items-center justify-center bg-background z-10">
                <Logo className="w-6 h-6 animate-pulse" />
              </div>
            )}
          </div>
        ) : viewportMode === "compare" ? (
          <PreviewCompareView
            chatId={chatId}
            previewUrl={previewUrl}
            reloadKey={reloadKey}
          />
        ) : (
          <>
            {/* Left resize handle - only in mobile viewport mode (not on actual mobile devices) */}
            {viewportMode === "mobile" && (
              <ResizeHandle
                side="left"
                onPointerDown={handleResizeStart}
                isResizing={isResizing}
              />
            )}

            {/* Frame with dynamic size */}
            <div
              ref={frameRef}
              className={cn(
                "relative overflow-hidden flex-shrink-0 bg-background",
                !isResizing &&
                  "transition-[width,height,margin] duration-300 ease-in-out",
                viewportMode === "desktop"
                  ? "border-[0.5px] rounded-sm"
                  : "shadow-lg border",
              )}
              style={{
                width:
                  viewportMode === "desktop" ? "100%" : `${device.width}px`,
                height: "100%",
                maxHeight:
                  viewportMode === "mobile" ? `${device.height}px` : "100%",
                marginLeft: viewportMode === "mobile" ? "16px" : "0",
                marginRight: viewportMode === "mobile" ? "16px" : "0",
                borderRadius: viewportMode === "desktop" ? "8px" : "24px",
              }}
            >
              {/* Scale transform wrapper */}
              <div
                className="w-full h-full"
                style={
                  scale !== 100
                    ? {
                        width: `${(100 / scale) * 100}%`,
                        height: `${(100 / scale) * 100}%`,
                        transform: `scale(${scale / 100})`,
                        transformOrigin: "top left",
                      }
                    : undefined
                }
              >
                <iframe
                  ref={iframeRef}
                  key={reloadKey}
                  src={previewUrl}
                  width="100%"
                  height="100%"
                  style={{
                    border: "none",
                    borderRadius: viewportMode === "desktop" ? "8px" : "24px",
                  }}
                  sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
                  onLoad={() => setIsLoaded(true)}
                  title="Preview"
                  tabIndex={-1}
                />

                {/* Loading overlay */}
                {!isLoaded && (
                  <div className="absolute inset-0 flex items-center justify-center bg-background z-10 rounded-[inherit]">
                    <Logo className="w-6 h-6 animate-pulse" />
                  </div>
                )}
              </div>
            </div>

            {/* Right resize handle - only in mobile viewport mode (not on actual mobile devices) */}
            {viewportMode === "mobile" && (
              <ResizeHandle
                side="right"
                onPointerDown={handleResizeStart}
                isResizing={isResizing}
              />
            )}
          </>
        )}
      </div>
      }
    </div>
  )
}
