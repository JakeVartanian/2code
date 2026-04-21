/**
 * WorkflowStages — Horizontal pipeline showing the Superpowers lifecycle:
 * Brainstorm -> Plan -> Dispatch -> Execute -> Verify
 *
 * Active stage pulses with cyan glow, completed stages show checkmarks,
 * and future stages remain muted.
 */

import { memo } from "react"
import { Check } from "lucide-react"
import { motion } from "motion/react"
import { cn } from "../../../../lib/utils"

const STAGES = ["Brainstorm", "Plan", "Dispatch", "Execute", "Verify"] as const
type Stage = (typeof STAGES)[number]

interface WorkflowStagesProps {
  activeStage: string | null
  completedStages: string[]
}

function getStageState(
  stage: Stage,
  activeStage: string | null,
  completedStages: string[],
): "active" | "completed" | "future" {
  if (completedStages.includes(stage)) return "completed"
  if (activeStage === stage) return "active"
  return "future"
}

const StagePill = memo(function StagePill({
  stage,
  state,
}: {
  stage: Stage
  state: "active" | "completed" | "future"
}) {
  return (
    <div className="relative flex items-center justify-center">
      {state === "active" && (
        <motion.div
          className="absolute inset-0 rounded-full bg-cyan-400/20"
          animate={{ scale: [1, 1.3, 1], opacity: [0.4, 0.1, 0.4] }}
          transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
        />
      )}
      <div
        className={cn(
          "relative flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-colors duration-200",
          state === "active" &&
            "bg-cyan-400/15 text-cyan-300 border border-cyan-400/40 shadow-[0_0_8px_rgba(34,211,238,0.15)]",
          state === "completed" &&
            "bg-zinc-700/60 text-zinc-300 border border-zinc-600/50",
          state === "future" &&
            "bg-transparent text-zinc-600 border border-zinc-800",
        )}
      >
        {state === "completed" && (
          <Check className="w-3 h-3 text-green-400 shrink-0" />
        )}
        {state === "active" && (
          <motion.span
            className="w-1.5 h-1.5 rounded-full bg-cyan-400 shrink-0"
            animate={{ opacity: [1, 0.3, 1] }}
            transition={{ duration: 1.5, repeat: Infinity, ease: "easeInOut" }}
          />
        )}
        <span>{stage}</span>
      </div>
    </div>
  )
})

const ConnectorLine = memo(function ConnectorLine({
  state,
}: {
  state: "completed" | "future"
}) {
  return (
    <div
      className={cn(
        "w-6 h-px shrink-0",
        state === "completed" ? "bg-zinc-600" : "bg-zinc-800",
      )}
    />
  )
})

export const WorkflowStages = memo(function WorkflowStages({
  activeStage,
  completedStages,
}: WorkflowStagesProps) {
  return (
    <div className="flex items-center justify-center gap-1 flex-wrap py-2">
      {STAGES.map((stage, index) => {
        const state = getStageState(stage, activeStage, completedStages)
        const prevState =
          index > 0
            ? getStageState(STAGES[index - 1], activeStage, completedStages)
            : null

        return (
          <div key={stage} className="flex items-center gap-1">
            {index > 0 && (
              <ConnectorLine
                state={
                  prevState === "completed" ? "completed" : "future"
                }
              />
            )}
            <StagePill stage={stage} state={state} />
          </div>
        )
      })}
    </div>
  )
})
