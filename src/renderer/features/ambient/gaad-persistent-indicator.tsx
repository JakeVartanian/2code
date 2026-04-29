/**
 * GAAD persistent indicator — always visible, even when sidebar is closed.
 *
 * When the sidebar is open, this component renders nothing (GAAD shows in the sidebar).
 * When the sidebar is closed, GAAD's eyes appear pinned to the left edge of the window,
 * vertically centered, with a subtle expand-on-hover to show pending suggestion count.
 *
 * Clicking the indicator opens the sidebar.
 */

import { memo, useCallback } from "react"
import { useAtomValue, useSetAtom } from "jotai"
import { motion, AnimatePresence } from "motion/react"
import { agentsSidebarOpenAtom } from "../../lib/atoms"
import { useAmbientStore } from "./store"
import { selectedProjectAtom } from "../agents/atoms"
import { cn } from "../../lib/utils"
import { trpc } from "../../lib/trpc"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../../components/ui/tooltip"

/**
 * Compact watching eyes for the collapsed indicator.
 * Same SVG as the sidebar version but slightly smaller.
 */
function MiniWatchingEyes() {
  return (
    <svg
      width="22"
      height="10"
      viewBox="0 0 28 12"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      className="gaad-eyes"
    >
      <ellipse
        cx="8" cy="6" rx="7" ry="4.5"
        fill="rgba(148,163,184,0.08)"
        stroke="rgba(148,163,184,0.18)"
        strokeWidth="0.5"
        className="gaad-lid gaad-lid-left"
        style={{ transformOrigin: "8px 6px" }}
      />
      <circle
        cx="8" cy="6" r="2"
        fill="rgba(94,234,212,0.55)"
        className="gaad-pupil gaad-pupil-left"
        style={{ transformOrigin: "8px 6px" }}
      />
      <ellipse
        cx="20" cy="6" rx="7" ry="4.5"
        fill="rgba(148,163,184,0.08)"
        stroke="rgba(148,163,184,0.18)"
        strokeWidth="0.5"
        className="gaad-lid gaad-lid-right"
        style={{ transformOrigin: "20px 6px" }}
      />
      <circle
        cx="20" cy="6" r="2"
        fill="rgba(94,234,212,0.55)"
        className="gaad-pupil gaad-pupil-right"
        style={{ transformOrigin: "20px 6px" }}
      />
    </svg>
  )
}

export const GaadPersistentIndicator = memo(function GaadPersistentIndicator() {
  const sidebarOpen = useAtomValue(agentsSidebarOpenAtom)
  const selectedProject = useAtomValue(selectedProjectAtom)
  const setSidebarOpen = useSetAtom(agentsSidebarOpenAtom)
  const { suggestions, agentStatus } = useAmbientStore()

  const pendingCount = suggestions.filter(s => s.status === "pending").length

  const { data: coverage } = trpc.ambient.memoryCoverage.useQuery(
    { projectId: selectedProject?.id ?? "" },
    { enabled: !!selectedProject?.id && agentStatus === "running", staleTime: 60_000 },
  )

  const handleClick = useCallback(() => {
    setSidebarOpen(true)
  }, [setSidebarOpen])

  // Only show when sidebar is closed, a project is selected, and GAAD is active
  const shouldShow = !sidebarOpen && selectedProject && agentStatus !== "stopped"

  return (
    <AnimatePresence>
      {shouldShow && (
        <motion.div
          initial={{ x: -32, opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          exit={{ x: -32, opacity: 0 }}
          transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
          className="absolute left-0 top-1/2 -translate-y-1/2 z-40"
        >
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={handleClick}
                className={cn(
                  "group flex items-center gap-1.5",
                  "rounded-r-lg",
                  "pl-1.5 pr-2 py-2.5",
                  "bg-background/80 backdrop-blur-sm",
                  "border border-l-0 border-border/20",
                  "hover:bg-muted/50 hover:border-border/40",
                  "transition-all duration-200",
                  "cursor-pointer",
                )}
              >
                <MiniWatchingEyes />

                {/* Badge — pending suggestion count */}
                {pendingCount > 0 && (
                  <span className="h-[14px] min-w-[14px] px-0.5 rounded-full bg-teal-500/25 text-teal-300 text-[9px] font-semibold flex items-center justify-center leading-none">
                    {pendingCount}
                  </span>
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent side="right" className="text-xs">
              {pendingCount > 0
                ? `GAAD — ${pendingCount} insight${pendingCount > 1 ? "s" : ""} waiting`
                : agentStatus === "running"
                  ? coverage && coverage.totalMemories > 0
                    ? `Memory: ${coverage.overallBalance}% coverage`
                    : "GAAD is watching"
                  : "GAAD is paused"
              }
            </TooltipContent>
          </Tooltip>
        </motion.div>
      )}
    </AnimatePresence>
  )
})
