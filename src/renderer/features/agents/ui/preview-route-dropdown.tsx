import { useState, useMemo, useCallback, useEffect, useRef } from "react"
import { useAtom } from "jotai"
import {
  FileText,
  Zap,
  Layers,
  Search,
  Shield,
  Monitor,
  Tablet,
  Smartphone,
} from "lucide-react"
import { cn } from "../../../lib/utils"
import { trpc } from "../../../lib/trpc"
import {
  pageReviewAtomFamily,
  previewAdminModeAtomFamily,
  type PageReviewStatus,
} from "../atoms"
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from "../../../components/ui/popover"
import { Switch } from "../../../components/ui/switch"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../../../components/ui/tooltip"
import {
  motion,
  AnimatePresence,
  useMotionValue,
  useTransform,
  animate,
} from "motion/react"

interface PreviewRouteDropdownProps {
  chatId: string
  projectPath?: string
  baseHost: string | null
  currentPath: string
  onPathChange: (path: string) => void
  isLoading?: boolean
  className?: string
  variant?: "default" | "mobile"
}

type RouteFilter = "all" | "pages" | "api" | "unreviewed"
type ViewportKey = "desktop" | "tablet" | "mobile"

const VIEWPORT_ICONS: Record<ViewportKey, typeof Monitor> = {
  desktop: Monitor,
  tablet: Tablet,
  mobile: Smartphone,
}

function getReviewDot(status: PageReviewStatus | undefined) {
  if (!status) return "bg-muted-foreground/30"
  const count = [status.desktop, status.tablet, status.mobile].filter(
    Boolean,
  ).length
  if (count === 3) return "bg-emerald-500"
  if (count > 0) return "bg-amber-500"
  return "bg-muted-foreground/30"
}

function getTypeIcon(type: string) {
  switch (type) {
    case "api":
      return <Zap className="h-3 w-3 text-amber-500 flex-shrink-0" />
    case "layout":
      return <Layers className="h-3 w-3 text-blue-500 flex-shrink-0" />
    default:
      return (
        <FileText className="h-3 w-3 text-muted-foreground flex-shrink-0" />
      )
  }
}

export function PreviewRouteDropdown({
  chatId,
  projectPath,
  baseHost,
  currentPath,
  onPathChange,
  isLoading = false,
  className,
  variant = "default",
}: PreviewRouteDropdownProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState("")
  const [filter, setFilter] = useState<RouteFilter>("all")
  const [manualPath, setManualPath] = useState("")
  const searchRef = useRef<HTMLInputElement>(null)
  const manualRef = useRef<HTMLInputElement>(null)

  const [reviews, setReviews] = useAtom(pageReviewAtomFamily(chatId))
  const [adminMode, setAdminMode] = useAtom(
    previewAdminModeAtomFamily(chatId),
  )

  // Fetch routes only when popover is open
  const { data: routeData } = trpc.devServer.scanRoutes.useQuery(
    { projectPath: projectPath! },
    { enabled: isOpen && !!projectPath },
  )

  const routes = routeData?.routes ?? []

  // Filter routes
  const filteredRoutes = useMemo(() => {
    let result = routes

    if (filter === "pages") {
      result = result.filter((r) => r.type === "page")
    } else if (filter === "api") {
      result = result.filter((r) => r.type === "api")
    } else if (filter === "unreviewed") {
      result = result.filter((r) => {
        const review = reviews[r.path]
        if (!review) return true
        return !review.desktop || !review.tablet || !review.mobile
      })
    }

    if (searchQuery) {
      const q = searchQuery.toLowerCase()
      result = result.filter(
        (r) =>
          r.path.toLowerCase().includes(q) ||
          r.name.toLowerCase().includes(q),
      )
    }

    return result
  }, [routes, filter, searchQuery, reviews])

  // Stats
  const pageRoutes = useMemo(
    () => routes.filter((r) => r.type === "page"),
    [routes],
  )
  const completedChecks = useMemo(() => {
    let count = 0
    for (const route of pageRoutes) {
      const review = reviews[route.path]
      if (review) {
        if (review.desktop) count++
        if (review.tablet) count++
        if (review.mobile) count++
      }
    }
    return count
  }, [pageRoutes, reviews])
  const totalChecks = pageRoutes.length * 3

  // Focus search when opened
  useEffect(() => {
    if (isOpen) {
      setSearchQuery("")
      setManualPath("")
      // Small delay to let popover render
      const timer = setTimeout(() => searchRef.current?.focus(), 50)
      return () => clearTimeout(timer)
    }
  }, [isOpen])

  const navigateTo = useCallback(
    (path: string) => {
      const finalPath = adminMode ? appendAdminParam(path) : path
      onPathChange(finalPath)
      setIsOpen(false)
    },
    [adminMode, onPathChange],
  )

  const toggleReview = useCallback(
    (routePath: string, viewport: ViewportKey) => {
      const current = reviews[routePath] ?? {
        desktop: false,
        tablet: false,
        mobile: false,
      }
      const updated: PageReviewStatus = {
        ...current,
        [viewport]: !current[viewport],
      }
      setReviews({ ...reviews, [routePath]: updated })
    },
    [reviews, setReviews],
  )

  const handleManualSubmit = useCallback(() => {
    let input = manualPath.trim()
    if (!input) return

    if (input.startsWith("~")) input = input.slice(1)

    let newPath = "/"
    try {
      if (input.startsWith("http://") || input.startsWith("https://")) {
        const url = new URL(input)
        newPath = url.pathname + url.search + url.hash
      } else if (input.startsWith("/")) {
        newPath = input
      } else {
        newPath = "/" + input
      }
    } catch {
      newPath = input.startsWith("/") ? input : "/" + input
    }

    if (!newPath) newPath = "/"
    navigateTo(newPath)
  }, [manualPath, navigateTo])

  // Progress bar animation (ported from PreviewUrlInput)
  const progress = useMotionValue(0)
  const width = useTransform(progress, [0, 100], ["0%", "100%"])
  const glowOpacity = useTransform(progress, [0, 95, 100], [1, 1, 0])
  const animationRef = useRef<ReturnType<typeof animate> | null>(null)

  useEffect(() => {
    if (isLoading) {
      progress.jump(0)
      animationRef.current = animate(progress, 90, {
        duration: 12,
        ease: [0.1, 0.4, 0.2, 1],
      })
      const timeoutId = setTimeout(() => {
        animationRef.current?.stop()
        animationRef.current = animate(progress, 100, {
          duration: 0.15,
          ease: "easeOut",
        })
      }, 15_000)
      return () => {
        clearTimeout(timeoutId)
        animationRef.current?.stop()
      }
    } else {
      animationRef.current?.stop()
      animationRef.current = animate(progress, 100, {
        duration: 0.15,
        ease: "easeOut",
      })
      return () => {
        animationRef.current?.stop()
      }
    }
  }, [isLoading, progress])

  if (!baseHost) return null

  const sharedTriggerStyles =
    "font-mono text-xs rounded-md px-3 h-7 leading-7 w-full max-w-[350px] text-center"

  // Strip __admin param from display path
  const displayPath = currentPath.replace(/[?&]__admin=1/, "").replace(/\?$/, "")

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <div
        className={cn(
          "min-w-0 flex-1 text-center flex items-center justify-center relative",
          className,
        )}
      >
        <div className="relative max-w-[350px] w-full">
          <PopoverTrigger asChild>
            <button
              type="button"
              className={cn(
                sharedTriggerStyles,
                variant === "mobile"
                  ? "truncate text-muted-foreground hover:text-foreground transition-all cursor-pointer bg-muted hover:bg-muted/80 shadow-[inset_0_1px_2px_rgba(0,0,0,0.06)] dark:shadow-[inset_0_1px_2px_rgba(0,0,0,0.2)] outline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring/70"
                  : "truncate text-muted-foreground hover:text-foreground transition-all cursor-pointer hover:bg-background hover:shadow-[inset_0_1px_2px_rgba(0,0,0,0.06)] dark:hover:shadow-[inset_0_1px_2px_rgba(0,0,0,0.2)] outline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring/70",
                adminMode && "text-amber-500/80 hover:text-amber-400",
              )}
            >
              {adminMode && (
                <Shield className="inline h-3 w-3 mr-1 -mt-px" />
              )}
              ~{displayPath}
            </button>
          </PopoverTrigger>

          {/* Progress bar */}
          <AnimatePresence>
            {isLoading && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.15 }}
                className="absolute bottom-0 left-0 right-0 pointer-events-none z-0 rounded-md overflow-hidden"
              >
                <motion.div
                  className="absolute -bottom-2 left-0 h-4"
                  style={{
                    width,
                    opacity: glowOpacity,
                    background: "hsl(var(--primary) / 0.15)",
                    filter: "blur(4px)",
                  }}
                />
                <motion.div
                  className="absolute bottom-0 left-0 h-[0.5px] bg-primary/60"
                  style={{ width }}
                />
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

      <PopoverContent
        side="bottom"
        align="center"
        className="w-[380px] p-0 max-h-[420px] flex flex-col"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        {/* Search */}
        <div className="px-2 pt-2 pb-1.5">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
            <input
              ref={searchRef}
              type="text"
              placeholder="Search routes..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              spellCheck={false}
              className="w-full h-7 pl-7 pr-2 text-xs bg-muted/50 rounded-md outline-none focus:ring-1 focus:ring-ring"
            />
          </div>
        </div>

        {/* Filter tabs + Admin toggle */}
        <div className="flex items-center justify-between px-2 pb-1.5">
          <div className="flex items-center gap-1">
            {(["all", "pages", "api", "unreviewed"] as const).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={cn(
                  "px-1.5 py-0.5 text-[10px] rounded capitalize transition-colors",
                  filter === f
                    ? "bg-foreground/10 text-foreground font-medium"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {f}
              </button>
            ))}
          </div>

          <Tooltip>
            <TooltipTrigger asChild>
              <div className="flex items-center gap-1.5">
                <span className="text-[10px] text-muted-foreground">Admin</span>
                <Switch
                  checked={adminMode}
                  onCheckedChange={setAdminMode}
                  className="h-3.5 w-7 [&_[data-slot=switch-thumb]]:h-2.5 [&_[data-slot=switch-thumb]]:w-[14px] [&_[data-slot=switch-thumb]]:data-[state=checked]:translate-x-[10px]"
                />
              </div>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="max-w-[240px] text-xs">
              Adds <code className="text-[10px] bg-muted/50 px-1 rounded">?__admin=1</code> to URLs so your app can bypass auth/flow guards
            </TooltipContent>
          </Tooltip>
        </div>

        {/* Route count + review progress */}
        <div className="flex items-center justify-between px-3 py-1 text-[10px] text-muted-foreground border-t border-b border-border/50">
          <span>
            {filteredRoutes.length} of {routes.length} routes
          </span>
          {totalChecks > 0 && (
            <span className="tabular-nums">
              {completedChecks}/{totalChecks} reviewed
            </span>
          )}
        </div>

        {/* Route list */}
        <div className="flex-1 overflow-y-auto min-h-0">
          {!projectPath ? (
            <div className="px-3 py-6 text-xs text-muted-foreground text-center">
              No project linked
            </div>
          ) : filteredRoutes.length === 0 ? (
            <div className="px-3 py-6 text-xs text-muted-foreground text-center">
              {routes.length === 0
                ? "No routes found. Start a dev server to scan routes."
                : "No matching routes"}
            </div>
          ) : (
            filteredRoutes.map((route) => {
              const review = reviews[route.path]
              const isCurrentRoute =
                route.path === displayPath ||
                route.path === currentPath
              return (
                <div
                  key={route.path}
                  className={cn(
                    "flex items-center gap-1.5 px-3 py-1.5 hover:bg-muted/50 transition-colors group",
                    isCurrentRoute && "bg-muted/30",
                  )}
                >
                  {/* Review dot */}
                  <span
                    className={cn(
                      "w-1.5 h-1.5 rounded-full flex-shrink-0",
                      getReviewDot(review),
                    )}
                  />

                  {/* Type icon */}
                  {getTypeIcon(route.type)}

                  {/* Route path - clickable */}
                  <button
                    onClick={() => navigateTo(route.path)}
                    className={cn(
                      "text-xs truncate flex-1 font-mono text-left transition-colors",
                      isCurrentRoute
                        ? "text-foreground font-medium"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                    title={route.path}
                  >
                    {route.path}
                  </button>

                  {/* Viewport review checkboxes */}
                  {route.type === "page" && (
                    <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                      {(
                        ["desktop", "tablet", "mobile"] as ViewportKey[]
                      ).map((vp) => {
                        const Icon = VIEWPORT_ICONS[vp]
                        const checked = review?.[vp] ?? false
                        return (
                          <button
                            key={vp}
                            onClick={(e) => {
                              e.stopPropagation()
                              toggleReview(route.path, vp)
                            }}
                            className={cn(
                              "inline-flex items-center justify-center w-4 h-4 rounded-sm border transition-colors",
                              checked
                                ? "bg-primary border-primary text-primary-foreground"
                                : "border-border/60 hover:border-foreground/30",
                            )}
                            title={`Mark ${vp} as reviewed`}
                          >
                            {checked ? (
                              <svg
                                className="h-2.5 w-2.5"
                                fill="none"
                                viewBox="0 0 24 24"
                                stroke="currentColor"
                                strokeWidth={3}
                              >
                                <path
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  d="M5 13l4 4L19 7"
                                />
                              </svg>
                            ) : (
                              <Icon className="h-2 w-2 text-muted-foreground/50" />
                            )}
                          </button>
                        )
                      })}
                    </div>
                  )}
                </div>
              )
            })
          )}
        </div>

        {/* Manual URL input */}
        <div className="border-t px-2 py-1.5 flex items-center gap-1.5">
          <input
            ref={manualRef}
            type="text"
            placeholder="~/path or URL..."
            value={manualPath}
            onChange={(e) => setManualPath(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault()
                handleManualSubmit()
              }
            }}
            spellCheck={false}
            autoComplete="off"
            className="flex-1 h-6 px-2 text-xs font-mono bg-muted/50 rounded-md outline-none focus:ring-1 focus:ring-ring"
          />
          <button
            onClick={handleManualSubmit}
            disabled={!manualPath.trim()}
            className="h-6 px-2 text-[10px] font-medium rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-40 transition-colors"
          >
            Go
          </button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

function appendAdminParam(path: string): string {
  if (path.includes("__admin=1")) return path
  const separator = path.includes("?") ? "&" : "?"
  return `${path}${separator}__admin=1`
}
