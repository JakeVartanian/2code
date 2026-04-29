/**
 * Hook for loading ambient data, auto-starting the agent,
 * and subscribing to real-time updates with toast notifications.
 */

import { useEffect, useRef } from "react"
import { useSetAtom } from "jotai"
import { toast } from "sonner"
import { trpc } from "../../../lib/trpc"
import { useAmbientStore } from "../store"
import { auditProgressAtom, auditProgressDefaultState } from "../audit-progress-atom"

export function useAmbientData(
  projectId: string | null,
  projectPath?: string | null,
  isExpanded?: boolean,
) {
  const {
    setSuggestions,
    removeSuggestion,
    setMaintenanceActions,
    removeMaintenanceAction,
    setBudgetStatus,
    setAgentStatus,
    setActivity,
  } = useAmbientStore()

  const utils = trpc.useUtils()
  const setAuditProgress = useSetAtom(auditProgressAtom)

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

  // Fetch suggestions — always poll (needed for badge count even when collapsed)
  const { data: suggestions } = trpc.ambient.listSuggestions.useQuery(
    { projectId: projectId! },
    { enabled: !!projectId, refetchInterval: 30_000 },
  )

  // Fetch maintenance actions — slower when collapsed since only shown in expanded view
  const { data: maintenanceActionsData } = trpc.ambient.listMaintenanceActions.useQuery(
    { projectId: projectId! },
    { enabled: !!projectId, refetchInterval: isExpanded ? 30_000 : 120_000 },
  )

  // Fetch budget — only needed in expanded view
  const { data: budget } = trpc.ambient.getBudgetStatus.useQuery(
    { projectId: projectId! },
    { enabled: !!projectId, refetchInterval: isExpanded ? 60_000 : false },
  )

  // Fetch status — poll faster when expanded, slower when collapsed
  const { data: status } = trpc.ambient.getStatus.useQuery(
    { projectId: projectId! },
    { enabled: !!projectId, refetchInterval: isExpanded ? 10_000 : 30_000 },
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
    if (maintenanceActionsData) {
      setMaintenanceActions(maintenanceActionsData.map((a) => ({
        id: a.id,
        projectId: a.projectId,
        type: a.type,
        title: a.title,
        description: a.description,
        details: a.details,
        status: a.status,
        createdAt: a.createdAt ? new Date(a.createdAt as unknown as string) : null,
      })))
    }
  }, [maintenanceActionsData])

  useEffect(() => {
    if (budget) setBudgetStatus(budget)
  }, [budget])

  useEffect(() => {
    if (status) {
      setAgentStatus(status.agentStatus)
      if (status.activity) setActivity(status.activity)
    }
  }, [status])

  // ─── Real-time subscription with toast notifications ────────────────

  trpc.ambient.onUpdate.useSubscription(
    { projectId: projectId! },
    {
      enabled: !!projectId,
      onData: (event) => {
        if (event.type === "new-suggestion") {
          utils.ambient.listSuggestions.invalidate({ projectId: projectId! })

          // Toast for high-severity findings so users don't miss critical issues
          const s = event.suggestion
          if (s) {
            const label = s.category === "next-step" ? "Next step"
              : s.category === "risk" ? "Risk"
              : s.category === "bug" ? "Bug"
              : s.category === "test-gap" ? "Test gap"
              : s.category === "design" ? "Design"
              : s.category

            if (s.severity === "error") {
              toast.error(s.title, {
                description: `${label} — ${s.confidence}% confidence`,
                duration: 8000,
              })
            } else if (s.severity === "warning") {
              toast.warning(s.title, {
                description: `${label} — ${s.confidence}% confidence`,
                duration: 6000,
              })
            }
          }
        }
        if (event.type === "suggestion-expired" && event.suggestionId) {
          removeSuggestion(event.suggestionId)
        }
        if (event.type === "suggestion-dismissed" && event.suggestionId) {
          removeSuggestion(event.suggestionId)
        }
        if (event.type === "suggestion-approved" && event.suggestionId) {
          removeSuggestion(event.suggestionId)
        }
        if (event.type === "maintenance-action-requested") {
          utils.ambient.listMaintenanceActions.invalidate({ projectId: projectId! })
        }
        if (event.type === "maintenance-action-completed" && event.actionId) {
          removeMaintenanceAction(event.actionId)
        }
        if (event.type === "maintenance-action-denied" && event.actionId) {
          removeMaintenanceAction(event.actionId)
        }
        if (event.type === "finding-resolved") {
          // Refetch audit findings when a finding is resolved
          utils.ambient.listAuditFindings.invalidate({ projectId: projectId! })
        }
        if (event.type === "audit-progress" && event.progress) {
          // Update live progress atom
          const allDone = event.progress.every(
            (p) => p.status === "done" || p.status === "error",
          )
          setAuditProgress((prev) => ({
            isRunning: !allDone,
            runId: event.runId ?? prev.runId,
            startedAt: prev.startedAt ?? Date.now(),
            zoneCount: event.progress!.length,
            progress: event.progress!,
          }))
          if (allDone) {
            // Reset after a short delay so the "done" state is visible
            setTimeout(() => {
              setAuditProgress(auditProgressDefaultState)
            }, 3000)
          }
          // Refetch audit runs for live progress in the dashboard
          utils.ambient.listAuditRuns.invalidate({ projectId: projectId! })
        }
      },
    },
  )
}
