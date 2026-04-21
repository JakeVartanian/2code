/**
 * useSystemMapData — aggregates data from multiple sources to feed the System Map visualization.
 *
 * Sources:
 * 1. Project Memories (tRPC: memory.list)
 * 2. Skills (tRPC: skills.list)
 * 3. Orchestration Runs (Zustand store + tRPC: orchestration.getActiveRuns)
 * 4. Sub-Agents / Tabs (Zustand store: useAgentSubChatStore)
 * 5. Ambient Suggestions (tRPC: ambient.listSuggestions)
 * 6. Plans (stubbed — derived from sub-chat state)
 * 7. Workflow Stage (derived from orchestration + streaming state)
 */

import { useMemo } from "react"
import { trpc } from "@/lib/trpc"
import { useAgentSubChatStore } from "../../stores/sub-chat-store"
import { useOrchestrationStore } from "../../stores/orchestration-store"
import { useStreamingStatusStore } from "../../stores/streaming-status-store"

// ─── Types ───────────────────────────────────────────────────────────────────

type WorkflowStage = "brainstorm" | "plan" | "dispatch" | "execute" | "verify"

interface MemoryItem {
  id: string
  category: string
  title: string
  content: string
  relevanceScore: number
  state: "active" | "cold" | "dead"
  linkedFiles?: string[]
  updatedAt: string
}

interface MemoryStats {
  total: number
  byCategory: Record<string, number>
}

interface SkillItem {
  name: string
  source: "user" | "project" | "plugin"
  description?: string
}

interface ActiveRun {
  id: string
  userGoal: string
  status: string
  tasks: Array<{ id: string; name: string; status: string }>
}

interface AgentItem {
  id: string
  name: string
  mode: string
  isStreaming: boolean
  isActive: boolean
}

interface SuggestionItem {
  id: string
  title: string
  category: string
  severity: string
  confidence: number
  triggerFiles: string[]
}

interface PlanItem {
  path: string
  name: string
  modifiedAt: string
}

interface WorkflowState {
  activeStage: WorkflowStage | null
  completedStages: string[]
}

export interface SystemMapData {
  // Memories
  memories: MemoryItem[]
  memoryStats: MemoryStats

  // Skills
  skills: SkillItem[]

  // Orchestration
  activeRuns: ActiveRun[]

  // Sub-agents
  agents: AgentItem[]

  // Ambient
  suggestions: SuggestionItem[]

  // Plans
  plans: PlanItem[]

  // Workflow
  workflowStage: WorkflowState

  // Loading states
  isLoading: boolean
}

// ─── Helper: derive memory state from relevance + staleness ──────────────────

function deriveMemoryState(memory: {
  relevanceScore: number
  isStale?: boolean | null
  isArchived?: boolean | null
}): "active" | "cold" | "dead" {
  if (memory.isArchived) return "dead"
  if (memory.isStale) return "cold"
  if (memory.relevanceScore < 20) return "cold"
  return "active"
}

// ─── Hook ────────────────────────────────────────────────────────────────────

export function useSystemMapData(projectId: string | null, chatId: string): SystemMapData {
  const hasProject = !!projectId

  // ── 1. Project Memories ──────────────────────────────────────────────────

  const memoriesQuery = trpc.memory.list.useQuery(
    {
      projectId: projectId!,
      includeArchived: false,
      includeStale: true,
    },
    {
      enabled: hasProject,
      refetchInterval: 10_000,
      placeholderData: (prev) => prev,
    },
  )

  const memories = useMemo<MemoryItem[]>(() => {
    if (!memoriesQuery.data) return []
    return memoriesQuery.data.map((m) => ({
      id: m.id,
      category: m.category,
      title: m.title,
      content: m.content,
      relevanceScore: m.relevanceScore,
      state: deriveMemoryState(m),
      linkedFiles: m.linkedFiles ? tryParseStringArray(m.linkedFiles) : undefined,
      updatedAt: m.updatedAt instanceof Date
        ? m.updatedAt.toISOString()
        : String(m.updatedAt ?? ""),
    }))
  }, [memoriesQuery.data])

  const memoryStats = useMemo<MemoryStats>(() => {
    const byCategory: Record<string, number> = {}
    for (const m of memories) {
      byCategory[m.category] = (byCategory[m.category] || 0) + 1
    }
    return { total: memories.length, byCategory }
  }, [memories])

  // ── 2. Skills ────────────────────────────────────────────────────────────

  // Skills router needs `cwd` — we don't have direct access to project path
  // in the renderer. Pass undefined to get user + plugin skills only.
  // Project skills require the cwd which comes from the chat's worktree/project path.
  const skillsQuery = trpc.skills.list.useQuery(
    { cwd: undefined },
    {
      refetchInterval: 30_000,
      placeholderData: (prev) => prev,
    },
  )

  const skills = useMemo<SkillItem[]>(() => {
    if (!skillsQuery.data) return []
    return skillsQuery.data.map((s) => ({
      name: s.name,
      source: s.source,
      description: s.description || undefined,
    }))
  }, [skillsQuery.data])

  // ── 3. Orchestration Runs ────────────────────────────────────────────────

  // Primary: get from Zustand store (already in-memory, no network call)
  const orchestrationRun = useOrchestrationStore((s) => s.getRunForChat(chatId))

  // Secondary: also fetch active runs from DB to catch runs not yet in the store
  const activeRunsQuery = trpc.orchestration.getActiveRuns.useQuery(
    { chatId },
    {
      enabled: !!chatId,
      refetchInterval: 3_000,
      placeholderData: (prev) => prev,
    },
  )

  const activeRuns = useMemo<ActiveRun[]>(() => {
    const runs: ActiveRun[] = []

    // Add in-memory run from Zustand store (richest data — includes tasks)
    if (orchestrationRun) {
      runs.push({
        id: orchestrationRun.id,
        userGoal: orchestrationRun.userGoal,
        status: orchestrationRun.status,
        tasks: orchestrationRun.tasks.map((t) => ({
          id: t.id,
          name: t.name,
          status: t.status,
        })),
      })
    }

    // Add any DB runs not already represented from the store
    if (activeRunsQuery.data) {
      const storeRunId = orchestrationRun?.id
      for (const dbRun of activeRunsQuery.data) {
        if (dbRun.id === storeRunId) continue // Already added from store
        runs.push({
          id: dbRun.id,
          userGoal: dbRun.userGoal,
          status: dbRun.status,
          tasks: [], // DB query doesn't include tasks — they load when the run view opens
        })
      }
    }

    return runs
  }, [orchestrationRun, activeRunsQuery.data])

  // ── 4. Sub-Agents (Tabs) ─────────────────────────────────────────────────

  const allSubChats = useAgentSubChatStore((s) => s.allSubChats)
  const openSubChatIds = useAgentSubChatStore((s) => s.openSubChatIds)
  const activeSubChatId = useAgentSubChatStore((s) => s.activeSubChatId)
  const streamingStatuses = useStreamingStatusStore((s) => s.statuses)

  const agents = useMemo<AgentItem[]>(() => {
    return allSubChats.map((sc) => ({
      id: sc.id,
      name: sc.name,
      mode: sc.mode || "agent",
      isStreaming:
        streamingStatuses[sc.id] === "streaming" ||
        streamingStatuses[sc.id] === "submitted",
      isActive: sc.id === activeSubChatId,
    }))
  }, [allSubChats, activeSubChatId, streamingStatuses])

  // ── 5. Ambient Suggestions ───────────────────────────────────────────────

  const suggestionsQuery = trpc.ambient.listSuggestions.useQuery(
    {
      projectId: projectId!,
      status: "pending",
    },
    {
      enabled: hasProject,
      refetchInterval: 15_000,
      placeholderData: (prev) => prev,
    },
  )

  const suggestions = useMemo<SuggestionItem[]>(() => {
    if (!suggestionsQuery.data) return []
    return suggestionsQuery.data.map((s) => ({
      id: s.id,
      title: s.title,
      category: s.category,
      severity: s.severity,
      confidence: (s as any).confidence ?? 50,
      triggerFiles: Array.isArray(s.triggerFiles) ? s.triggerFiles : [],
    }))
  }, [suggestionsQuery.data])

  // ── 6. Plans (stub) ──────────────────────────────────────────────────────

  // TODO: Plans are .md files stored on disk. A proper implementation would need
  // a tRPC endpoint to list plan files in the worktree, or track active plan paths
  // via Jotai atoms (currentPlanPathAtomFamily). For now, derive from sub-chat
  // state — sub-chats in "plan" mode indicate active planning.
  const plans = useMemo<PlanItem[]>(() => {
    const planSubChats = allSubChats.filter((sc) => sc.mode === "plan")
    return planSubChats.map((sc) => ({
      path: `subchat://${sc.id}`,
      name: sc.name || "Untitled Plan",
      modifiedAt: sc.updated_at || sc.created_at || new Date().toISOString(),
    }))
  }, [allSubChats])

  // ── 7. Workflow Stage (derived) ──────────────────────────────────────────

  const workflowStage = useMemo<WorkflowState>(() => {
    const completedStages: string[] = []

    // Check orchestration status
    const runStatus = orchestrationRun?.status
    const hasActiveOrchestration = !!orchestrationRun && !["completed", "failed", "cancelled"].includes(runStatus || "")

    // Check if any sub-agents are actively streaming
    const hasStreamingAgents = Object.values(streamingStatuses).some(
      (s) => s === "streaming" || s === "submitted",
    )

    // Check if there are plan-mode sub-chats (indicates planning phase)
    const hasPlanSubChats = allSubChats.some((sc) => sc.mode === "plan")

    // Derive active stage
    let activeStage: WorkflowStage | null = null

    if (runStatus === "validating") {
      activeStage = "verify"
      completedStages.push("brainstorm", "plan", "dispatch", "execute")
    } else if (runStatus === "running" || hasStreamingAgents) {
      activeStage = "execute"
      completedStages.push("brainstorm", "plan", "dispatch")
    } else if (runStatus === "planning") {
      activeStage = "dispatch"
      completedStages.push("brainstorm", "plan")
    } else if (hasPlanSubChats && !hasActiveOrchestration) {
      activeStage = "plan"
      completedStages.push("brainstorm")
    } else if (hasActiveOrchestration) {
      activeStage = "execute"
      completedStages.push("brainstorm", "plan", "dispatch")
    } else {
      // Default idle state
      activeStage = openSubChatIds.length > 0 ? "brainstorm" : null
    }

    // If run completed, all stages are done
    if (runStatus === "completed") {
      activeStage = null
      completedStages.push("brainstorm", "plan", "dispatch", "execute", "verify")
    }

    return {
      activeStage,
      completedStages: [...new Set(completedStages)],
    }
  }, [orchestrationRun, streamingStatuses, allSubChats, openSubChatIds])

  // ── Loading state ────────────────────────────────────────────────────────

  const isLoading =
    memoriesQuery.isLoading ||
    skillsQuery.isLoading ||
    activeRunsQuery.isLoading ||
    suggestionsQuery.isLoading

  // ── Return aggregated data ───────────────────────────────────────────────

  return {
    memories,
    memoryStats,
    skills,
    activeRuns,
    agents,
    suggestions,
    plans,
    workflowStage,
    isLoading,
  }
}

// ─── Utilities ───────────────────────────────────────────────────────────────

/**
 * Safely parse a JSON string that may be a serialized string array,
 * or return the value if it's already an array.
 */
function tryParseStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value as string[]
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value)
      if (Array.isArray(parsed)) return parsed
    } catch {
      // Not valid JSON — return empty
    }
  }
  return []
}
