"use client"

import { useState, useMemo, useCallback, useEffect } from "react"
import { useAtom, useAtomValue } from "jotai"
import { X, Search, FileText, Zap, Layers } from "lucide-react"
import { Button } from "../../../components/ui/button"
import { cn } from "../../../lib/utils"
import { trpc } from "../../../lib/trpc"
import { pageReviewAtomFamily, type PageReviewStatus } from "../atoms"
import { motion, AnimatePresence } from "motion/react"

interface PreviewRoutesDrawerProps {
  isOpen: boolean
  onClose: () => void
  projectPath: string
  chatId: string
  onNavigate: (path: string) => void
}

type RouteFilter = "all" | "pages" | "api" | "unreviewed"

function getReviewDot(status: PageReviewStatus | undefined) {
  if (!status) return "bg-muted-foreground/30" // gray — none reviewed
  const count = [status.desktop, status.tablet, status.mobile].filter(Boolean).length
  if (count === 3) return "bg-emerald-500" // green — all reviewed
  if (count > 0) return "bg-amber-500" // amber — some reviewed
  return "bg-muted-foreground/30" // gray — none reviewed
}

function getTypeIcon(type: string) {
  switch (type) {
    case "api":
      return <Zap className="h-3 w-3 text-amber-500 flex-shrink-0" />
    case "layout":
      return <Layers className="h-3 w-3 text-blue-500 flex-shrink-0" />
    default:
      return <FileText className="h-3 w-3 text-muted-foreground flex-shrink-0" />
  }
}

export function PreviewRoutesDrawer({
  isOpen,
  onClose,
  projectPath,
  chatId,
  onNavigate,
}: PreviewRoutesDrawerProps) {
  const [searchQuery, setSearchQuery] = useState("")
  const [filter, setFilter] = useState<RouteFilter>("all")
  const [reviews] = useAtom(pageReviewAtomFamily(chatId))

  const { data: routeData } = trpc.devServer.scanRoutes.useQuery(
    { projectPath },
    { enabled: isOpen },
  )

  const routes = routeData?.routes ?? []

  // Close on Escape
  useEffect(() => {
    if (!isOpen) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener("keydown", handleKeyDown, true)
    return () => window.removeEventListener("keydown", handleKeyDown, true)
  }, [isOpen, onClose])

  const filteredRoutes = useMemo(() => {
    let result = routes

    // Filter by type
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

    // Filter by search
    if (searchQuery) {
      const q = searchQuery.toLowerCase()
      result = result.filter(
        (r) => r.path.toLowerCase().includes(q) || r.name.toLowerCase().includes(q),
      )
    }

    return result
  }, [routes, filter, searchQuery, reviews])

  const handleRouteClick = useCallback(
    (path: string) => {
      onNavigate(path)
      onClose()
    },
    [onNavigate, onClose],
  )

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Scrim overlay */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="absolute inset-0 bg-black/8 z-10"
            onClick={onClose}
          />

          {/* Drawer */}
          <motion.div
            initial={{ x: -200, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: -200, opacity: 0 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
            className="absolute left-0 top-0 bottom-0 w-[200px] bg-background border-r z-20 flex flex-col"
          >
            {/* Header */}
            <div className="flex items-center justify-between px-3 h-8 flex-shrink-0 border-b">
              <span className="text-xs font-medium">Routes</span>
              <Button
                variant="ghost"
                size="icon"
                onClick={onClose}
                className="h-5 w-5 p-0 hover:bg-muted rounded"
              >
                <X className="h-3 w-3" />
              </Button>
            </div>

            {/* Search */}
            <div className="px-2 py-1.5 border-b">
              <div className="relative">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
                <input
                  type="text"
                  placeholder="Search routes..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full h-7 pl-7 pr-2 text-xs bg-muted/50 rounded-md outline-none focus:ring-1 focus:ring-ring"
                />
              </div>
            </div>

            {/* Filter */}
            <div className="flex items-center gap-1 px-2 py-1 border-b">
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

            {/* Route count */}
            <div className="px-3 py-1 text-[10px] text-muted-foreground border-b">
              {filteredRoutes.length} of {routes.length} routes
            </div>

            {/* Route list */}
            <div className="flex-1 overflow-y-auto">
              {filteredRoutes.length === 0 ? (
                <div className="px-3 py-4 text-xs text-muted-foreground text-center">
                  {routes.length === 0 ? "No routes found" : "No matching routes"}
                </div>
              ) : (
                filteredRoutes.map((route) => (
                  <button
                    key={route.path}
                    onClick={() => handleRouteClick(route.path)}
                    className="flex items-center gap-1.5 w-full px-3 py-1.5 text-left hover:bg-muted transition-colors group"
                  >
                    <span
                      className={cn(
                        "w-1.5 h-1.5 rounded-full flex-shrink-0",
                        getReviewDot(reviews[route.path]),
                      )}
                    />
                    {getTypeIcon(route.type)}
                    <span className="text-xs truncate flex-1 font-mono">
                      {route.path}
                    </span>
                  </button>
                ))
              )}
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  )
}
