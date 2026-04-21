/**
 * AgentNodes — List of active and recent sub-agent status cards.
 * Shows streaming state, mode badge, and status indicators.
 */

import { memo } from "react"
import { Bot, Check, Loader2 } from "lucide-react"
import { motion } from "motion/react"
import { cn } from "../../../../lib/utils"

interface Agent {
  id: string
  name: string
  mode: string
  isStreaming: boolean
  isActive: boolean
}

interface AgentNodesProps {
  agents: Agent[]
}

function getAgentStatus(agent: Agent): "running" | "idle" | "completed" {
  if (agent.isStreaming) return "running"
  if (agent.isActive) return "idle"
  return "completed"
}

const STATUS_CONFIG: Record<
  "running" | "idle" | "completed",
  { label: string; dotClass: string; textClass: string }
> = {
  running: {
    label: "Running",
    dotClass: "bg-green-400",
    textClass: "text-green-400",
  },
  idle: {
    label: "Idle",
    dotClass: "bg-zinc-500",
    textClass: "text-zinc-500",
  },
  completed: {
    label: "Done",
    dotClass: "bg-blue-400",
    textClass: "text-blue-400",
  },
}

const MODE_STYLES: Record<string, string> = {
  agent: "bg-cyan-400/10 text-cyan-400 border-cyan-400/20",
  plan: "bg-purple-400/10 text-purple-400 border-purple-400/20",
}

const AgentCard = memo(function AgentCard({ agent }: { agent: Agent }) {
  const status = getAgentStatus(agent)
  const config = STATUS_CONFIG[status]
  const modeStyle =
    MODE_STYLES[agent.mode.toLowerCase()] ??
    "bg-zinc-700/50 text-zinc-400 border-zinc-600/30"

  return (
    <div className="flex items-center gap-3 px-3 py-2.5 rounded-lg border border-zinc-800 bg-zinc-900/30 hover:bg-zinc-800/40 transition-colors duration-200">
      {/* Status indicator */}
      <div className="relative shrink-0">
        {status === "running" ? (
          <>
            <motion.span
              className={cn("absolute inset-0 rounded-full", config.dotClass)}
              animate={{ scale: [1, 1.8, 1], opacity: [0.5, 0, 0.5] }}
              transition={{
                duration: 1.5,
                repeat: Infinity,
                ease: "easeInOut",
              }}
              style={{ width: 8, height: 8 }}
            />
            <span
              className={cn("block w-2 h-2 rounded-full", config.dotClass)}
            />
          </>
        ) : status === "completed" ? (
          <Check className="w-3.5 h-3.5 text-blue-400" />
        ) : (
          <span
            className={cn("block w-2 h-2 rounded-full", config.dotClass)}
          />
        )}
      </div>

      {/* Agent info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <Bot className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
          <span className="text-sm text-zinc-200 truncate font-medium">
            {agent.name}
          </span>
        </div>
      </div>

      {/* Badges */}
      <div className="flex items-center gap-2 shrink-0">
        <span
          className={cn(
            "text-[10px] font-medium px-1.5 py-0.5 rounded border capitalize",
            modeStyle,
          )}
        >
          {agent.mode}
        </span>
        {status === "running" && (
          <Loader2 className="w-3 h-3 text-green-400 animate-spin" />
        )}
        <span className={cn("text-[10px] font-medium", config.textClass)}>
          {config.label}
        </span>
      </div>
    </div>
  )
})

export const AgentNodes = memo(function AgentNodes({
  agents,
}: AgentNodesProps) {
  if (agents.length === 0) {
    return (
      <p className="text-xs text-zinc-600 italic pt-3">No active agents.</p>
    )
  }

  return (
    <div className="space-y-2 pt-3">
      {agents.map((agent) => (
        <AgentCard key={agent.id} agent={agent} />
      ))}
    </div>
  )
})
