/**
 * Hook for loading ambient data, auto-starting the agent,
 * and subscribing to real-time updates with toast notifications.
 */

import { useEffect, useRef } from "react"
import { toast } from "sonner"
import { trpc } from "../../../lib/trpc"
import { useAmbientStore } from "../store"

export function useAmbientData(
  projectId: string | null,
  projectPath?: string | null,
) {
  const {
    setSuggestions,
    removeSuggestion,
    setBudgetStatus,
    setAgentStatus,
  } = useAmbientStore()

  const utils = trpc.useUtils()

  // ─── Auto-start ambient agent on project load ───────────────────────
  const ensureRunning = trpc.ambient.ensureRunning.useMutation()
  const hasAutoStarted = useRef<string | null>(null)

  useEffect(() => {
    if (projectId && projectPath && hasAutoStarted.current !== projectId) {
      hasAutoStarted.current = projectId
      ensureRunning.mutate({ projectId, projectPath })
    }
  }, [projectId, projectPath])

  // ─── Queries ────────────────────────────────────────────────────────

  // Fetch suggestions
  const { data: suggestions } = trpc.ambient.listSuggestions.useQuery(
    { projectId: projectId! },
    { enabled: !!projectId, refetchInterval: 30_000 },
  )

  // Fetch budget
  const { data: budget } = trpc.ambient.getBudgetStatus.useQuery(
    { projectId: projectId! },
    { enabled: !!projectId, refetchInterval: 60_000 },
  )

  // Fetch status
  const { data: status } = trpc.ambient.getStatus.useQuery(
    { projectId: projectId! },
    { enabled: !!projectId, refetchInterval: 10_000 },
  )

  // ─── Sync to store ─────────────────────────────────────────────────

  useEffect(() => {
    if (suggestions) {
      setSuggestions(suggestions.map((s) => ({
        id: s.id,
        projectId: s.projectId,
        category: s.category,
        severity: s.severity,
        title: s.title,
        description: s.description,
        triggerEvent: s.triggerEvent,
        triggerFiles: s.triggerFiles,
        analysisModel: s.analysisModel,
        status: s.status,
        confidence: s.confidence,
        suggestedPrompt: s.suggestedPrompt,
        createdAt: s.createdAt ? new Date(s.createdAt as unknown as string) : null,
      })))
    }
  }, [suggestions])

  useEffect(() => {
    if (budget) setBudgetStatus(budget)
  }, [budget])

  useEffect(() => {
    if (status) setAgentStatus(status.agentStatus)
  }, [status])

  // ─── Real-time subscription with toast notifications ────────────────

  trpc.ambient.onUpdate.useSubscription(
    { projectId: projectId! },
    {
      enabled: !!projectId,
      onData: (event) => {
        if (event.type === "new-suggestion") {
          // Invalidate the query cache to trigger immediate refetch
          utils.ambient.listSuggestions.invalidate({ projectId: projectId! })

          // Show toast notification for warning/error severity
          const suggestion = (event as any).suggestion
          if (suggestion) {
            const sev = suggestion.severity as string
            if (sev === "error" || sev === "warning") {
              toast(suggestion.title, {
                description: `${suggestion.category} · ${suggestion.confidence}% confidence`,
                duration: sev === "error" ? 12000 : 8000,
              })
            }
          }
        }
        if (event.type === "suggestion-dismissed" && event.suggestionId) {
          removeSuggestion(event.suggestionId)
        }
        if (event.type === "suggestion-approved" && event.suggestionId) {
          removeSuggestion(event.suggestionId)
        }
      },
    },
  )
}
