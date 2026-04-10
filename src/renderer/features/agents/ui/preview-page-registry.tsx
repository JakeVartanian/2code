"use client"

import { useMemo, useCallback } from "react"
import { useAtom } from "jotai"
import { ArrowLeft, Monitor, Smartphone, Tablet } from "lucide-react"
import { Button } from "../../../components/ui/button"
import { cn } from "../../../lib/utils"
import { trpc } from "../../../lib/trpc"
import { pageReviewAtomFamily, type PageReviewStatus } from "../atoms"

interface PreviewPageRegistryProps {
  chatId: string
  projectPath: string
  onBack: () => void
  onNavigate: (path: string, viewport?: "desktop" | "tablet" | "mobile") => void
}

function formatRelativeTime(timestamp: number | undefined): string {
  if (!timestamp) return "never"
  const now = Date.now()
  const diff = now - timestamp
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return "just now"
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

type ViewportKey = "desktop" | "tablet" | "mobile"

const VIEWPORT_COLUMNS: { key: ViewportKey; icon: typeof Monitor; label: string }[] = [
  { key: "desktop", icon: Monitor, label: "Desktop" },
  { key: "tablet", icon: Tablet, label: "Tablet" },
  { key: "mobile", icon: Smartphone, label: "Mobile" },
]

export function PreviewPageRegistry({
  chatId,
  projectPath,
  onBack,
  onNavigate,
}: PreviewPageRegistryProps) {
  const [reviews, setReviews] = useAtom(pageReviewAtomFamily(chatId))

  const { data: routeData } = trpc.devServer.scanRoutes.useQuery(
    { projectPath },
    { enabled: !!projectPath },
  )

  const routes = routeData?.routes ?? []
  const pageRoutes = useMemo(
    () => routes.filter((r) => r.type === "page"),
    [routes],
  )

  const totalChecks = pageRoutes.length * 3
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

  const handleRouteClick = useCallback(
    (path: string) => {
      onNavigate(path)
    },
    [onNavigate],
  )

  const handleCellClick = useCallback(
    (path: string, viewport: ViewportKey) => {
      toggleReview(path, viewport)
    },
    [toggleReview],
  )

  return (
    <div className="flex flex-col h-full bg-tl-background">
      {/* Header */}
      <div className="flex items-center justify-between px-3 h-10 flex-shrink-0 border-b">
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            onClick={onBack}
            className="h-7 w-7 p-0 hover:bg-muted rounded-md"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
          </Button>
          <span className="text-xs font-medium">Page Registry</span>
        </div>
        <span className="text-xs text-muted-foreground tabular-nums">
          {completedChecks}/{totalChecks}
        </span>
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto">
        {pageRoutes.length === 0 ? (
          <div className="px-3 py-8 text-xs text-muted-foreground text-center">
            No pages found. Start a dev server to scan routes.
          </div>
        ) : (
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b bg-muted/30">
                <th className="text-left px-3 py-2 font-medium text-muted-foreground w-auto">
                  Path
                </th>
                {VIEWPORT_COLUMNS.map(({ key, icon: Icon, label }) => (
                  <th
                    key={key}
                    className="px-2 py-2 font-medium text-muted-foreground text-center w-14"
                  >
                    <div className="flex items-center justify-center gap-1">
                      <Icon className="h-3 w-3" />
                      <span className="hidden sm:inline">{label}</span>
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {pageRoutes.map((route) => {
                const review = reviews[route.path]
                return (
                  <tr
                    key={route.path}
                    className="border-b border-border/50 hover:bg-muted/20 transition-colors"
                  >
                    <td className="px-3 py-1.5">
                      <button
                        onClick={() => handleRouteClick(route.path)}
                        className="font-mono text-foreground hover:text-primary transition-colors truncate max-w-[240px] block text-left"
                        title={route.path}
                      >
                        {route.path}
                      </button>
                    </td>
                    {VIEWPORT_COLUMNS.map(({ key, label }) => (
                      <td key={key} className="px-2 py-1.5 text-center">
                        <button
                          onClick={() => handleCellClick(route.path, key)}
                          className={cn(
                            "inline-flex items-center justify-center w-5 h-5 rounded border transition-colors",
                            review?.[key]
                              ? "bg-primary border-primary text-primary-foreground"
                              : "border-border hover:border-foreground/30",
                          )}
                          aria-label={`Mark ${route.path} ${label} viewport as reviewed`}
                        >
                          {review?.[key] && (
                            <svg
                              className="h-3 w-3"
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
                          )}
                        </button>
                      </td>
                    ))}
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
