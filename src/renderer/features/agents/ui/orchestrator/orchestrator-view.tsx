/**
 * OrchestratorView — the main orchestrator tab component.
 * Renders the visual pipeline (Memory → Reasoning → Plan → Outcome),
 * goal input, control buttons, "Orchestrate Existing Tabs", and run history.
 *
 * Flow: Goal input → Decomposition (Claude call) → Plan Review (editable) → Start Run
 */

import { memo, useState, useCallback, useMemo } from "react"
import { useAtomValue } from "jotai"
import {
  Play,
  Pause,
  Square,
  History,
  Layers,
  Send,
  Loader2,
} from "lucide-react"
import { toast } from "sonner"
import { Button } from "../../../../components/ui/button"
import { cn } from "../../../../lib/utils"
import { trpc, trpcClient } from "../../../../lib/trpc"
import { selectedProjectAtom } from "../../../../lib/atoms"
import { PipelineView } from "./pipeline-view"
import { PlanEditor, type PlanTask } from "./plan-editor"
import { useOrchestrationStore } from "../../stores/orchestration-store"
import { useAgentSubChatStore } from "../../stores/sub-chat-store"
import type { Autonomy, OrchestrationRun } from "../../stores/orchestration-store"

interface OrchestratorViewProps {
  chatId: string
  subChatId: string
  onNavigateToSubChat: (subChatId: string) => void
}

export const OrchestratorView = memo(function OrchestratorView({
  chatId,
  subChatId,
  onNavigateToSubChat,
}: OrchestratorViewProps) {
  const selectedProject = useAtomValue(selectedProjectAtom)
  const [goalInput, setGoalInput] = useState("")
  const [showHistory, setShowHistory] = useState(false)
  const [isDecomposing, setIsDecomposing] = useState(false)
  const [isStartingRun, setIsStartingRun] = useState(false)

  // Plan review state: holds the decomposed plan before user approves
  const [pendingPlan, setPendingPlan] = useState<{
    reasoning: string
    tasks: PlanTask[]
    userGoal: string
  } | null>(null)

  // Store
  const run = useOrchestrationStore((s) => s.getRunForChat(chatId))
  const setRun = useOrchestrationStore((s) => s.setRun)
  const updateRunStatus = useOrchestrationStore((s) => s.updateRunStatus)
  const updateTaskAutonomy = useOrchestrationStore((s) => s.updateTaskAutonomy)

  // Sub-chat store for "Orchestrate Existing Tabs"
  const openSubChatIds = useAgentSubChatStore((s) => s.openSubChatIds)
  const allSubChats = useAgentSubChatStore((s) => s.allSubChats)

  // tRPC mutations
  const decomposeMutation = trpc.orchestration.decompose.useMutation({
    onError: (err) => {
      toast.error(`Decomposition failed: ${err.message}`)
      setIsDecomposing(false)
    },
  })

  const startRunMutation = trpc.orchestration.startRun.useMutation({
    onError: (err) => toast.error(`Failed to start: ${err.message}`),
  })

  const updateStatusMutation = trpc.orchestration.updateRunStatus.useMutation()

  const orchestrateExistingMutation = trpc.orchestration.orchestrateExistingTabs.useMutation({
    onSuccess: async (result) => {
      // Hydrate the store with the new run so the OrchestrationProcessor monitors it
      try {
        const fullRun = await trpcClient.orchestration.getRun.query({ runId: result.runId })
        if (fullRun) {
          const storeRun: OrchestrationRun = {
            id: fullRun.id,
            chatId: fullRun.chatId,
            controllerSubChatId: fullRun.controllerSubChatId,
            userGoal: fullRun.userGoal,
            decomposedPlan: fullRun.decomposedPlan || "",
            status: fullRun.status as OrchestrationRun["status"],
            summary: fullRun.summary,
            preOrchestrationCommit: fullRun.preOrchestrationCommit,
            startedAt: fullRun.startedAt ? new Date(fullRun.startedAt) : null,
            completedAt: fullRun.completedAt ? new Date(fullRun.completedAt) : null,
            tasks: fullRun.tasks.map((t) => ({
              id: t.id,
              runId: t.runId,
              name: t.name,
              description: t.description,
              mode: (t.mode || "agent") as "plan" | "agent",
              subChatId: t.subChatId,
              status: t.status as any,
              sortOrder: t.sortOrder ?? 0,
              dependsOn: t.dependsOn ? JSON.parse(t.dependsOn) : [],
              autonomy: (t.autonomy || "auto") as Autonomy,
              allowedPaths: t.allowedPaths ? JSON.parse(t.allowedPaths) : null,
              resultSummary: t.resultSummary,
              startedAt: t.startedAt ? new Date(t.startedAt) : null,
              completedAt: t.completedAt ? new Date(t.completedAt) : null,
            })),
          }
          setRun(chatId, storeRun)
        }
      } catch (err) {
        console.error("[OrchestratorView] Failed to hydrate run:", err)
      }

      toast.success(
        `Orchestrating ${result.taskCount} existing tabs`,
      )
    },
    onError: (err) => toast.error(`Failed: ${err.message}`),
  })

  // Run history
  const { data: runHistory } = trpc.orchestration.getRunHistory.useQuery(
    { chatId, limit: 10 },
    { enabled: showHistory },
  )

  // Get eligible tabs for "Orchestrate Existing Tabs"
  const eligibleTabs = useMemo(() => {
    return allSubChats.filter(
      (sc) =>
        openSubChatIds.includes(sc.id) &&
        sc.id !== subChatId &&
        sc.mode !== "orchestrator",
    )
  }, [allSubChats, openSubChatIds, subChatId])

  // Handle goal submission → run decomposition
  const handleDecompose = useCallback(async () => {
    if (!goalInput.trim()) return
    setIsDecomposing(true)

    try {
      const plan = await decomposeMutation.mutateAsync({
        chatId,
        userGoal: goalInput.trim(),
      })

      // Convert decomposed plan to editable format
      const editableTasks: PlanTask[] = plan.tasks.map((t) => ({
        name: t.name,
        description: t.description,
        mode: t.mode,
        dependsOn: t.dependsOn,
        allowedPaths: t.allowedPaths,
        acceptanceCriteria: t.acceptanceCriteria,
        estimatedComplexity: t.estimatedComplexity,
        autonomy: "auto" as Autonomy,
      }))

      setPendingPlan({
        reasoning: plan.reasoning,
        tasks: editableTasks,
        userGoal: goalInput.trim(),
      })
    } finally {
      setIsDecomposing(false)
    }
  }, [goalInput, chatId, decomposeMutation])

  // Handle plan approval → create the run and start
  const handleApprovePlan = useCallback(async () => {
    if (!pendingPlan || pendingPlan.tasks.length === 0) return
    setIsStartingRun(true)

    try {
      const result = await startRunMutation.mutateAsync({
        chatId,
        controllerSubChatId: subChatId,
        userGoal: pendingPlan.userGoal,
        decomposedPlan: JSON.stringify({
          reasoning: pendingPlan.reasoning,
          tasks: pendingPlan.tasks,
        }),
        initialStatus: "running",
        tasks: pendingPlan.tasks.map((t, i) => ({
          name: t.name,
          description: t.description,
          mode: t.mode,
          sortOrder: i,
          dependsOn: t.dependsOn,
          autonomy: t.autonomy,
          allowedPaths: t.allowedPaths,
          systemPromptAppend: "", // Will be built by the processor
        })),
      })

      // Fetch the full run data and set it in the store
      const fullRun = await trpcClient.orchestration.getRun.query({ runId: result.run.id })
      if (fullRun) {
        const storeRun: OrchestrationRun = {
          id: fullRun.id,
          chatId: fullRun.chatId,
          controllerSubChatId: fullRun.controllerSubChatId,
          userGoal: fullRun.userGoal,
          decomposedPlan: fullRun.decomposedPlan || "",
          status: fullRun.status as OrchestrationRun["status"],
          summary: fullRun.summary,
          preOrchestrationCommit: fullRun.preOrchestrationCommit,
          startedAt: fullRun.startedAt ? new Date(fullRun.startedAt) : null,
          completedAt: fullRun.completedAt ? new Date(fullRun.completedAt) : null,
          tasks: fullRun.tasks.map((t) => ({
            id: t.id,
            runId: t.runId,
            name: t.name,
            description: t.description,
            mode: (t.mode || "agent") as "plan" | "agent",
            subChatId: t.subChatId,
            status: t.status as any,
            sortOrder: t.sortOrder ?? 0,
            dependsOn: t.dependsOn ? JSON.parse(t.dependsOn) : [],
            autonomy: (t.autonomy || "auto") as Autonomy,
            allowedPaths: t.allowedPaths ? JSON.parse(t.allowedPaths) : null,
            resultSummary: t.resultSummary,
            startedAt: t.startedAt ? new Date(t.startedAt) : null,
            completedAt: t.completedAt ? new Date(t.completedAt) : null,
          })),
        }
        setRun(chatId, storeRun)
      }

      toast.success(`Orchestration started with ${result.taskCount} tasks`)
      setPendingPlan(null)
      setGoalInput("")
    } finally {
      setIsStartingRun(false)
    }
  }, [pendingPlan, chatId, subChatId, startRunMutation, setRun])

  // Handle plan cancellation
  const handleCancelPlan = useCallback(() => {
    setPendingPlan(null)
  }, [])

  // Handle plan task changes
  const handleTasksChange = useCallback(
    (tasks: PlanTask[]) => {
      if (pendingPlan) {
        setPendingPlan({ ...pendingPlan, tasks })
      }
    },
    [pendingPlan],
  )

  // Handle orchestrating existing tabs
  const handleOrchestrateExisting = useCallback(() => {
    if (eligibleTabs.length === 0) {
      toast.error("No eligible tabs to orchestrate. Open some tabs with conversations first.")
      return
    }

    orchestrateExistingMutation.mutate({
      chatId,
      controllerSubChatId: subChatId,
      subChatIds: eligibleTabs.map((sc) => sc.id),
    })
  }, [chatId, subChatId, eligibleTabs, orchestrateExistingMutation])

  // Handle autonomy change — persist to DB first, then update store
  const handleAutonomyChange = useCallback(
    async (taskId: string, autonomy: Autonomy) => {
      try {
        await trpcClient.orchestration.updateTaskAutonomy.mutate({ taskId, autonomy })
      } catch {
        // Non-fatal — store still updates for immediate UI feedback
      }
      updateTaskAutonomy(chatId, taskId, autonomy)
    },
    [chatId, updateTaskAutonomy],
  )

  // Handle retry a stuck task
  const handleRetryTask = useCallback(async (taskId: string) => {
    if (!run) return
    const task = run.tasks.find((t) => t.id === taskId)
    if (!task?.subChatId) return

    try {
      // Re-queue the worker with a guidance message
      await trpcClient.orchestration.updateTaskStatus.mutate({
        taskId, runId: run.id, status: "running",
      })
      useOrchestrationStore.getState().updateTaskStatus(chatId, taskId, "running")

      // Import message queue to inject guidance
      const { useMessageQueueStore } = await import("../../stores/message-queue-store")
      const { generateQueueId } = await import("../../lib/queue-utils")
      useMessageQueueStore.getState().addToQueue(task.subChatId, {
        id: generateQueueId(),
        message: "[Orchestrator]: You were previously stuck. Please try a different approach to complete the task. Review what went wrong and adjust your strategy.",
        timestamp: new Date(),
        status: "pending",
      })

      toast.success(`Retrying "${task.name}"`)
    } catch (err) {
      toast.error(`Failed to retry: ${err instanceof Error ? err.message : "unknown"}`)
    }
  }, [run, chatId])

  // Handle skip a stuck task
  const handleSkipTask = useCallback(async (taskId: string) => {
    if (!run) return
    const task = run.tasks.find((t) => t.id === taskId)
    if (!task) return

    try {
      await trpcClient.orchestration.completeTask.mutate({
        taskId, runId: run.id, resultSummary: "Manually skipped by user", finalStatus: "skipped",
      })
      useOrchestrationStore.getState().updateTaskStatus(chatId, taskId, "skipped", "Manually skipped by user")

      // Refresh run to get updated dependency states
      const freshRun = await trpcClient.orchestration.getRun.query({ runId: run.id })
      if (freshRun) {
        setRun(chatId, {
          id: freshRun.id,
          chatId: freshRun.chatId,
          controllerSubChatId: freshRun.controllerSubChatId,
          userGoal: freshRun.userGoal,
          decomposedPlan: freshRun.decomposedPlan || "",
          status: freshRun.status as OrchestrationRun["status"],
          summary: freshRun.summary,
          preOrchestrationCommit: freshRun.preOrchestrationCommit,
          startedAt: freshRun.startedAt ? new Date(freshRun.startedAt) : null,
          completedAt: freshRun.completedAt ? new Date(freshRun.completedAt) : null,
          tasks: freshRun.tasks.map((t) => ({
            id: t.id,
            runId: t.runId,
            name: t.name,
            description: t.description,
            mode: (t.mode || "agent") as "plan" | "agent",
            subChatId: t.subChatId,
            status: t.status as any,
            sortOrder: t.sortOrder ?? 0,
            dependsOn: t.dependsOn ? JSON.parse(t.dependsOn) : [],
            autonomy: (t.autonomy || "auto") as Autonomy,
            allowedPaths: t.allowedPaths ? JSON.parse(t.allowedPaths) : null,
            resultSummary: t.resultSummary,
            startedAt: t.startedAt ? new Date(t.startedAt) : null,
            completedAt: t.completedAt ? new Date(t.completedAt) : null,
          })),
        })
      }

      toast.success(`Skipped "${task.name}"`)
    } catch (err) {
      toast.error(`Failed to skip: ${err instanceof Error ? err.message : "unknown"}`)
    }
  }, [run, chatId, setRun])

  // Handle pause/resume/cancel
  const handlePause = useCallback(async () => {
    if (run) {
      updateStatusMutation.mutate({ runId: run.id, status: "paused" })
      updateRunStatus(chatId, "paused")
      // Abort all running workers so they stop burning API credits
      try {
        await trpcClient.orchestration.abortRunWorkers.mutate({
          runId: run.id,
          reason: "paused",
        })
      } catch { /* non-fatal */ }
    }
  }, [run, chatId, updateRunStatus, updateStatusMutation])

  const handleResume = useCallback(() => {
    if (run) {
      updateStatusMutation.mutate({ runId: run.id, status: "running" })
      updateRunStatus(chatId, "running")
    }
  }, [run, chatId, updateRunStatus, updateStatusMutation])

  const handleCancel = useCallback(async () => {
    if (run) {
      updateStatusMutation.mutate({ runId: run.id, status: "cancelled" })
      updateRunStatus(chatId, "cancelled")
      // Abort all running workers and mark them failed
      try {
        await trpcClient.orchestration.abortRunWorkers.mutate({
          runId: run.id,
          reason: "cancelled",
        })
      } catch { /* non-fatal */ }
    }
  }, [run, chatId, updateRunStatus, updateStatusMutation])

  const isRunActive = run && ["running", "paused", "validating", "planning"].includes(run.status)
  const isPlanReview = pendingPlan !== null

  return (
    <div className="h-full flex flex-col">
      {/* Pipeline content (scrollable) */}
      <div className="flex-1 overflow-y-auto">
        {/* Show plan editor when in review mode */}
        {isPlanReview ? (
          <div className="p-4">
            <div className="mb-3">
              <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                Goal
              </span>
              <p className="text-sm mt-0.5">{pendingPlan.userGoal}</p>
            </div>
            <PlanEditor
              reasoning={pendingPlan.reasoning}
              tasks={pendingPlan.tasks}
              onTasksChange={handleTasksChange}
              onApprove={handleApprovePlan}
              onCancel={handleCancelPlan}
              isStarting={isStartingRun}
            />
          </div>
        ) : (
          <>
            <PipelineView
              run={run ?? null}
              projectId={selectedProject?.id ?? null}
              onAutonomyChange={handleAutonomyChange}
              onNavigateToTab={onNavigateToSubChat}
              onRetryTask={handleRetryTask}
              onSkipTask={handleSkipTask}
            />

            {/* Run history drawer */}
            {showHistory && (
              <div className="px-4 pb-4">
                <div className="border border-border/50 rounded-lg overflow-hidden">
                  <div className="px-4 py-2 border-b border-border/30 flex items-center gap-2">
                    <History className="w-4 h-4 text-muted-foreground" />
                    <span className="text-sm font-medium">Run History</span>
                  </div>
                  <div className="max-h-64 overflow-y-auto">
                    {runHistory?.length === 0 ? (
                      <p className="p-4 text-xs text-muted-foreground">No previous runs.</p>
                    ) : (
                      runHistory?.map((r) => (
                        <div
                          key={r.id}
                          className="px-4 py-2 border-b border-border/30 last:border-b-0"
                        >
                          <div className="flex items-center gap-2">
                            <span
                              className={cn(
                                "text-xs font-medium capitalize",
                                r.status === "completed" && "text-green-500",
                                r.status === "failed" && "text-red-500",
                                r.status === "cancelled" && "text-muted-foreground",
                              )}
                            >
                              {r.status}
                            </span>
                            <span className="text-xs text-muted-foreground flex-1 truncate">
                              {r.userGoal}
                            </span>
                            {r.startedAt && (
                              <span className="text-[10px] text-muted-foreground shrink-0">
                                {new Date(r.startedAt).toLocaleDateString()}
                              </span>
                            )}
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* Control bar (sticky bottom) — hidden during plan review */}
      {!isPlanReview && (
        <div className="border-t border-border bg-background/80 backdrop-blur-sm">
          {/* Orchestrate Existing Tabs button */}
          {!isRunActive && eligibleTabs.length > 0 && (
            <div className="px-4 pt-3">
              <button
                onClick={handleOrchestrateExisting}
                disabled={orchestrateExistingMutation.isPending}
                className={cn(
                  "w-full flex items-center justify-center gap-2 px-4 py-2 rounded-lg",
                  "border border-dashed border-blue-500/40 bg-blue-500/5",
                  "text-sm text-blue-400 hover:bg-blue-500/10 transition-colors",
                  "disabled:opacity-50 disabled:cursor-not-allowed",
                )}
              >
                <Layers className="w-4 h-4" />
                <span>
                  Orchestrate {eligibleTabs.length} Existing Tab{eligibleTabs.length !== 1 ? "s" : ""}
                </span>
              </button>
            </div>
          )}

          {/* Goal input + action buttons */}
          <div className="p-4 flex items-center gap-2">
            {/* Goal input */}
            <div className="flex-1 relative">
              <input
                value={goalInput}
                onChange={(e) => setGoalInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault()
                    handleDecompose()
                  }
                }}
                placeholder={
                  isRunActive
                    ? "Orchestration in progress..."
                    : "Describe your goal (e.g., 'Add user authentication with tests')"
                }
                disabled={isRunActive || isDecomposing}
                className={cn(
                  "w-full px-4 py-2 rounded-lg border border-border bg-background text-sm",
                  "placeholder:text-muted-foreground/60",
                  "disabled:opacity-50 disabled:cursor-not-allowed",
                )}
              />
            </div>

            {/* Start / Pause / Resume / Cancel buttons */}
            {isRunActive ? (
              <>
                {run.status === "paused" ? (
                  <Button size="sm" variant="outline" onClick={handleResume}>
                    <Play className="w-3.5 h-3.5 mr-1" />
                    Resume
                  </Button>
                ) : (
                  <Button size="sm" variant="outline" onClick={handlePause}>
                    <Pause className="w-3.5 h-3.5 mr-1" />
                    Pause
                  </Button>
                )}
                <Button size="sm" variant="ghost" onClick={handleCancel} className="text-destructive">
                  <Square className="w-3.5 h-3.5 mr-1" />
                  Cancel
                </Button>
              </>
            ) : (
              <Button
                size="sm"
                onClick={handleDecompose}
                disabled={!goalInput.trim() || isDecomposing}
              >
                {isDecomposing ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />
                    Planning...
                  </>
                ) : (
                  <>
                    <Send className="w-3.5 h-3.5 mr-1" />
                    Plan
                  </>
                )}
              </Button>
            )}

            {/* History toggle */}
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setShowHistory(!showHistory)}
              className="text-muted-foreground"
            >
              <History className="w-3.5 h-3.5" />
            </Button>
          </div>
        </div>
      )}
    </div>
  )
})
