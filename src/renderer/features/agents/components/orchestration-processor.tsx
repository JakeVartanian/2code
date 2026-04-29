/**
 * OrchestrationProcessor — headless component that drives the orchestration
 * runtime loop. Mounted at app level (alongside QueueProcessor).
 *
 * Responsibilities:
 * 1. Watch orchestration store for active runs with status "running"
 * 2. Spawn worker sub-chats for runnable tasks (pending + deps met)
 * 3. Send task instructions via message queue (reuses QueueProcessor pipeline)
 * 4. Monitor streaming status → detect worker completion
 * 5. Extract completion reports → call completeTask
 * 6. Run stuck detection periodically
 * 7. Aggregate results when all tasks finish
 */

import { useEffect, useRef, useCallback } from "react"
import { Chat } from "@ai-sdk/react"
import { toast } from "sonner"
import { useOrchestrationStore } from "../stores/orchestration-store"
import { useStreamingStatusStore } from "../stores/streaming-status-store"
import { useMessageQueueStore } from "../stores/message-queue-store"
import { useAgentSubChatStore } from "../stores/sub-chat-store"
import { agentChatStore } from "../stores/agent-chat-store"
import { IPCChatTransport } from "../lib/ipc-chat-transport"
import { trpcClient } from "../../../lib/trpc"
import { generateQueueId } from "../lib/queue-utils"
import { selectedAgentChatIdAtom } from "../atoms"
import { appStore } from "../../../lib/jotai-store"
import type { OrchestrationRun, OrchestrationTask } from "../stores/orchestration-store"

/** Build a Sonner action that navigates to the stuck worker's sub-chat tab */
function goToWorkerTab(chatId: string, subChatId: string | null | undefined) {
  if (!subChatId) return undefined
  return {
    label: "Go to tab",
    onClick: () => {
      appStore.set(selectedAgentChatIdAtom, chatId)
      const store = useAgentSubChatStore.getState()
      store.addToOpenSubChats(subChatId)
      store.setActiveSubChat(subChatId)
    },
  }
}

// Default max concurrent workers (overridden by .2code/orchestrator.json)
const DEFAULT_MAX_WORKERS = 4

// How often to check for stuck workers (ms)
const STUCK_CHECK_INTERVAL = 60_000

// Debounce for processing ticks (ms)
const TICK_DEBOUNCE = 200

// How long to wait for a task to start streaming before considering it stuck (ms)
const SPAWN_TIMEOUT = 5 * 60 * 1000 // 5 minutes

// How long a "stuck" task can sit before being auto-skipped (ms)
const STUCK_AUTO_SKIP_TIMEOUT = 5 * 60 * 1000 // 5 minutes

/**
 * Sanitize user-controlled text to prevent prompt boundary manipulation.
 * Replaces XML-like tags with bracketed equivalents.
 */
function sanitize(text: string): string {
  return text.replace(/<\/?[a-z_-]+(?:\s[^>]*)?\/?>/gi, (match) => `[${match.slice(1, -1)}]`)
}

/**
 * Build the task instruction message that gets sent to the worker sub-chat.
 */
function buildTaskInstruction(
  task: OrchestrationTask,
  allTasks: OrchestrationTask[],
): string {
  const parts: string[] = []

  parts.push(`# Task: ${sanitize(task.name)}`)
  parts.push("")
  parts.push(sanitize(task.description))

  // Add scope boundaries
  if (task.allowedPaths && task.allowedPaths.length > 0) {
    parts.push("")
    parts.push("## File Scope")
    parts.push("You may modify files matching these patterns:")
    for (const p of task.allowedPaths) {
      parts.push(`- ${p}`)
    }
    parts.push("")
    parts.push("Do NOT modify files outside your scope — other workers handle their own files.")
  }

  // Add context from completed dependencies
  const completedDeps = task.dependsOn
    .map((depId) => allTasks.find((t) => t.id === depId))
    .filter((t): t is OrchestrationTask => t?.status === "completed" && !!t.resultSummary)

  if (completedDeps.length > 0) {
    parts.push("")
    parts.push("## Context from Completed Tasks")
    for (const dep of completedDeps) {
      parts.push(`### ${sanitize(dep.name)}`)
      parts.push(sanitize(dep.resultSummary!))
    }
  }

  // Completion instructions
  parts.push("")
  parts.push("## When Done")
  parts.push("When you have completed ALL work, end your final message with:")
  parts.push("```")
  parts.push('<orchestrator-report>')
  parts.push('{"status": "completed", "summary": "Brief description of what was done", "filesModified": ["list/of/files.ts"], "blockers": []}')
  parts.push('</orchestrator-report>')
  parts.push("```")

  return parts.join("\n")
}

/**
 * Extract the LAST orchestrator report from the worker's messages.
 * Uses matchAll to find all reports and returns the final one,
 * since a retried worker may have multiple reports.
 */
function extractCompletionReport(
  messages: string,
): { status: string; summary: string; filesModified: string[]; blockers: string[] } | null {
  const regex = /<orchestrator-report>\s*([\s\S]*?)\s*<\/orchestrator-report>/g
  let lastMatch: RegExpExecArray | null = null
  let match: RegExpExecArray | null

  while ((match = regex.exec(messages)) !== null) {
    lastMatch = match
  }

  if (!lastMatch) return null

  try {
    return JSON.parse(lastMatch[1]!)
  } catch {
    return null
  }
}

/**
 * Create a Chat object for a worker sub-chat and register it in agentChatStore.
 * This bridges the orchestration flow to the existing QueueProcessor → Claude CLI pipeline.
 */
async function createWorkerChat(
  subChatId: string,
  chatId: string,
  mode: "agent" | "plan",
): Promise<boolean> {
  try {
    // Fetch parent chat data to get worktree path and project path
    const chatData = await trpcClient.chats.get.query({ id: chatId })
    if (!chatData) {
      console.error(`[OrchestrationProcessor] Parent chat ${chatId} not found`)
      return false
    }

    const worktreePath = chatData.worktreePath || (chatData as any).project?.path
    if (!worktreePath) {
      console.error(`[OrchestrationProcessor] No working directory for chat ${chatId}`)
      return false
    }

    const projectPath = (chatData as any).project?.path as string | undefined

    // Create the IPC transport
    const transport = new IPCChatTransport({
      chatId,
      subChatId,
      cwd: worktreePath,
      projectPath,
      mode,
    })

    // Create the Chat object with streaming status sync callbacks
    const chat = new Chat<any>({
      id: subChatId,
      messages: [],
      transport,
      onError: () => {
        useStreamingStatusStore.getState().setStatus(subChatId, "ready")
      },
      onFinish: () => {
        useStreamingStatusStore.getState().setStatus(subChatId, "ready")
      },
    })

    // Register in agentChatStore so QueueProcessor can find it
    agentChatStore.set(subChatId, chat, chatId)
    agentChatStore.setStreamId(subChatId, null)

    return true
  } catch (error) {
    console.error(`[OrchestrationProcessor] Failed to create worker chat:`, error)
    return false
  }
}

export function OrchestrationProcessor() {
  const tickTimerRef = useRef<NodeJS.Timeout | null>(null)
  const stuckTimerRef = useRef<NodeJS.Timeout | null>(null)
  const processingRef = useRef(false)
  const completionCheckingRef = useRef(false)

  // Track which tasks we've already spawned/queued to avoid double-spawn
  const spawnedTasksRef = useRef<Set<string>>(new Set())
  // Track which sub-chats we've detected completion for
  const completedSubChatsRef = useRef<Set<string>>(new Set())
  // Track retry counts for stuck workers
  const retryCountsRef = useRef<Map<string, number>>(new Map())
  // Track which sub-chats have ever been in a streaming/submitted state
  // This prevents false positive completion detection on freshly spawned workers
  const hasEverStreamedRef = useRef<Set<string>>(new Set())
  // Ref to scheduleTick for use in callbacks defined before it
  const scheduleTickRef = useRef<() => void>(() => {})
  // Track when tasks were spawned (for spawn timeout detection)
  const spawnTimesRef = useRef<Map<string, number>>(new Map())
  // Configured max workers (loaded from .2code/orchestrator.json via tRPC)
  const maxWorkersRef = useRef(DEFAULT_MAX_WORKERS)
  // Track when tasks entered "stuck" state for auto-skip timeout
  const stuckTimestampsRef = useRef<Map<string, number>>(new Map())
  // Whether we've done initial DB rehydration
  const rehydratedRef = useRef(false)
  // Whether a tick was requested while processTick was in-flight
  const pendingTickRef = useRef(false)
  // Concurrency guard for checkStuck
  const stuckCheckingRef = useRef(false)

  /**
   * Main processing tick — check for runnable tasks and spawn workers.
   */
  const processTick = useCallback(async () => {
    if (processingRef.current || !rehydratedRef.current) return
    processingRef.current = true

    try {
      const store = useOrchestrationStore.getState()

      for (const [chatId, run] of store.runs) {
        if (run.status !== "running") continue

        // Get runnable tasks (pending + deps met)
        const runnableTasks = store.getNextRunnableTasks(chatId)
        const runningCount = store.getRunningWorkerCount(chatId)
        const queuedCount = run.tasks.filter((t) => t.status === "queued").length
        const availableSlots = maxWorkersRef.current - runningCount - queuedCount

        if (availableSlots <= 0 || runnableTasks.length === 0) continue

        // Spawn workers for runnable tasks (up to available slots)
        const toSpawn = runnableTasks.slice(0, availableSlots)

        for (const task of toSpawn) {
          // Skip if already spawned
          if (spawnedTasksRef.current.has(task.id)) continue
          spawnedTasksRef.current.add(task.id)

          try {
            // Spawn the worker sub-chat via tRPC (DB-first)
            const result = await trpcClient.orchestration.spawnTask.mutate({
              taskId: task.id,
              runId: run.id,
              chatId,
            })

            // DB succeeded — now update store to match
            store.linkTaskSubChat(chatId, task.id, result.subChatId)
            store.updateTaskStatus(chatId, task.id, "queued")

            // Add the worker sub-chat to the open tabs
            const subChatStore = useAgentSubChatStore.getState()
            subChatStore.addToAllSubChats({
              id: result.subChatId,
              name: task.name,
              mode: task.mode,
              orchestrationRunId: run.id,
              orchestrationTaskId: task.id,
            })
            subChatStore.addToOpenSubChats(result.subChatId)

            // Create a Chat object (with IPCChatTransport) so QueueProcessor can send messages.
            // Without this, QueueProcessor silently skips the message because agentChatStore
            // has no entry for the worker sub-chat.
            const chatCreated = await createWorkerChat(
              result.subChatId,
              chatId,
              task.mode === "plan" ? "plan" : "agent",
            )
            if (!chatCreated) {
              throw new Error("Failed to create worker Chat object (no working directory?)")
            }

            // Build task instruction and enqueue it
            const instruction = buildTaskInstruction(task, run.tasks)
            useMessageQueueStore.getState().addToQueue(result.subChatId, {
              id: generateQueueId(),
              message: instruction,
              timestamp: new Date(),
              status: "pending",
            })

            // Update DB first, then store
            await trpcClient.orchestration.updateTaskStatus.mutate({
              taskId: task.id,
              runId: run.id,
              status: "running",
            })
            store.updateTaskStatus(chatId, task.id, "running")
            spawnTimesRef.current.set(task.id, Date.now())
          } catch (error) {
            console.error(`[OrchestrationProcessor] Failed to spawn task ${task.name}:`, error)
            spawnedTasksRef.current.delete(task.id)
            const failMsg = `Spawn failed: ${error instanceof Error ? error.message : "unknown"}`
            // Route through completeTask for cascade — prevents infinite retry on spawn failure
            try {
              await trpcClient.orchestration.completeTask.mutate({
                taskId: task.id,
                runId: run.id,
                resultSummary: failMsg,
                finalStatus: "failed",
              })
            } catch {
              // DB failure is non-fatal here, store still updates
            }
            store.updateTaskStatus(chatId, task.id, "failed", failMsg)
          }
        }
      }
    } finally {
      processingRef.current = false
      // Re-schedule if a tick was requested while we were processing
      if (pendingTickRef.current) {
        pendingTickRef.current = false
        scheduleTickRef.current()
      }
    }
  }, [])

  /**
   * Check for worker completions by monitoring streaming status.
   * Uses a concurrency guard to prevent overlapping checks.
   */
  const checkWorkerCompletions = useCallback(async () => {
    // Concurrency guard — skip if already checking
    if (completionCheckingRef.current) return
    completionCheckingRef.current = true

    try {
      const store = useOrchestrationStore.getState()
      const statuses = useStreamingStatusStore.getState().statuses

      for (const [chatId, run] of store.runs) {
        if (run.status !== "running") continue

        const runningTasks = run.tasks.filter(
          (t) => t.status === "running" && t.subChatId,
        )

        for (const task of runningTasks) {
          const subChatId = task.subChatId!
          const subChatStatus = statuses[subChatId] ?? "ready"

          // Track when a worker has actually started streaming
          if (subChatStatus === "streaming" || subChatStatus === "submitted") {
            hasEverStreamedRef.current.add(subChatId)
          }

          // Check for spawn timeout — task running but never streamed
          if (
            !hasEverStreamedRef.current.has(subChatId) &&
            !completedSubChatsRef.current.has(subChatId)
          ) {
            const spawnTime = spawnTimesRef.current.get(task.id)
            if (spawnTime && Date.now() - spawnTime > SPAWN_TIMEOUT) {
              completedSubChatsRef.current.add(subChatId)
              const failMsg = "Worker timed out: never started streaming after spawn"
              try {
                await trpcClient.orchestration.completeTask.mutate({
                  taskId: task.id, runId: run.id, resultSummary: failMsg, finalStatus: "failed",
                })
              } catch { /* non-fatal */ }
              store.updateTaskStatus(chatId, task.id, "failed", failMsg)
              scheduleTickRef.current()
              continue
            }
          }

          // Handle streaming error — mark task as failed via completeTask for cascade
          if (
            subChatStatus === "error" &&
            hasEverStreamedRef.current.has(subChatId) &&
            !completedSubChatsRef.current.has(subChatId)
          ) {
            completedSubChatsRef.current.add(subChatId)
            try {
              await trpcClient.orchestration.completeTask.mutate({
                taskId: task.id,
                runId: run.id,
                resultSummary: "Worker encountered a streaming error",
                finalStatus: "failed",
              })
            } catch { /* non-fatal */ }
            store.updateTaskStatus(chatId, task.id, "failed", "Worker encountered a streaming error")
            scheduleTickRef.current()
            continue
          }

          // Worker finished streaming: status is "ready" AND it has previously streamed
          // This prevents false positives on workers that haven't started yet
          if (
            subChatStatus === "ready" &&
            hasEverStreamedRef.current.has(subChatId) &&
            !completedSubChatsRef.current.has(subChatId)
          ) {
            completedSubChatsRef.current.add(subChatId)

            // Try to extract the completion report
            let resultSummary = "Task completed (no structured report)"

            try {
              // Fetch messages from DB — only scan the LAST assistant message
              // to avoid false positive matches from source code or earlier messages
              const subChatData = await trpcClient.chats.getSubChat.query({
                id: subChatId,
              })

              if (subChatData?.messages) {
                const rawMessages = typeof subChatData.messages === "string"
                  ? subChatData.messages
                  : JSON.stringify(subChatData.messages)

                // Parse messages and extract only the final assistant message content
                let lastAssistantContent = ""
                try {
                  const parsed = JSON.parse(rawMessages) as Array<{ role?: string; content?: unknown }>
                  for (let i = parsed.length - 1; i >= 0; i--) {
                    if (parsed[i]?.role === "assistant") {
                      lastAssistantContent = typeof parsed[i]!.content === "string"
                        ? parsed[i]!.content as string
                        : JSON.stringify(parsed[i]!.content)
                      break
                    }
                  }
                } catch {
                  // Fallback: if messages aren't parseable, use raw string (less safe)
                  lastAssistantContent = rawMessages
                }

                const report = extractCompletionReport(lastAssistantContent)
                if (report) {
                  resultSummary = report.summary
                  if (report.status === "failed") {
                    // Worker reported failure — route through completeTask for cascade
                    await trpcClient.orchestration.completeTask.mutate({
                      taskId: task.id,
                      runId: run.id,
                      resultSummary,
                      finalStatus: "failed",
                    })
                    store.updateTaskStatus(chatId, task.id, "failed", resultSummary)
                    scheduleTickRef.current()
                    continue
                  }
                }
              }
            } catch {
              // Non-fatal: use default summary
            }

            // Complete the task — DB first, then store
            try {
              const result = await trpcClient.orchestration.completeTask.mutate({
                taskId: task.id,
                runId: run.id,
                resultSummary,
              })

              // DB succeeded — update store
              store.updateTaskStatus(chatId, task.id, "completed", resultSummary)

              // Reset retry count on successful completion (recovery from stuck)
              retryCountsRef.current.delete(task.id)
              spawnTimesRef.current.delete(task.id)

              if (result.unblocked > 0 || (result.cascadeFailed ?? 0) > 0) {
                // Refresh run data from DB to get updated task statuses
                const freshRun = await trpcClient.orchestration.getRun.query({ runId: run.id })
                if (freshRun) {
                  store.setRun(chatId, {
                    ...run,
                    status: freshRun.status as OrchestrationRun["status"],
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
                      autonomy: (t.autonomy || "auto") as any,
                      allowedPaths: t.allowedPaths ? JSON.parse(t.allowedPaths) : null,
                      resultSummary: t.resultSummary,
                      startedAt: t.startedAt ? new Date(t.startedAt) : null,
                      completedAt: t.completedAt ? new Date(t.completedAt) : null,
                    })),
                  })
                }

                // Trigger another tick to spawn unblocked tasks
                scheduleTickRef.current()
              }

              // The completeTask transaction atomically determines if the run is terminal.
              // Only the call that triggers the terminal transition gets a non-null runTerminalStatus,
              // preventing duplicate aggregation from concurrent completions.
              if (result.runTerminalStatus) {
                const runFinalStatus = result.runTerminalStatus as OrchestrationRun["status"]

                // Try to aggregate results
                try {
                  await trpcClient.orchestration.aggregateRun.mutate({ runId: run.id })
                  const finalRun = await trpcClient.orchestration.getRun.query({ runId: run.id })
                  if (finalRun) {
                    store.updateRunStatus(chatId, finalRun.status as OrchestrationRun["status"], finalRun.summary ?? undefined)
                  } else {
                    store.updateRunStatus(chatId, runFinalStatus)
                  }
                } catch (err) {
                  console.error("[OrchestrationProcessor] Aggregation failed:", err)
                  store.updateRunStatus(chatId, runFinalStatus)
                }

                // Desktop notification
                if (typeof Notification !== "undefined" && Notification.permission === "granted") {
                  const freshRunState = useOrchestrationStore.getState().getRunForChat(chatId)
                  const completedCount = freshRunState?.tasks.filter(t => t.status === "completed").length ?? 0
                  const failedCount = freshRunState?.tasks.filter(t => t.status === "failed").length ?? 0
                  new Notification(
                    runFinalStatus === "completed" ? "Orchestration Complete" : "Orchestration Finished with Failures",
                    {
                      body: `${completedCount} completed, ${failedCount} failed for: ${run.userGoal.slice(0, 60)}`,
                    },
                  )
                }
              }
            } catch (error) {
              console.error("[OrchestrationProcessor] Complete task failed:", error)
              // DB call failed — remove from completed set so we retry
              completedSubChatsRef.current.delete(subChatId)
            }
          }
        }
      }
    } finally {
      completionCheckingRef.current = false
    }
  }, [])

  /**
   * Schedule a debounced processing tick.
   */
  const scheduleTick = useCallback(() => {
    // If processTick is currently in-flight, mark a pending tick instead of debouncing
    if (processingRef.current) {
      pendingTickRef.current = true
      return
    }
    if (tickTimerRef.current) clearTimeout(tickTimerRef.current)
    tickTimerRef.current = setTimeout(() => {
      tickTimerRef.current = null
      processTick()
    }, TICK_DEBOUNCE)
  }, [processTick])

  // Keep ref in sync so callbacks defined before scheduleTick can use it
  scheduleTickRef.current = scheduleTick

  /**
   * Check for stuck workers periodically.
   */
  const checkStuck = useCallback(async () => {
    // Concurrency guard — diagnosis calls can take seconds (Claude API)
    if (stuckCheckingRef.current) return
    stuckCheckingRef.current = true

    try {
    const store = useOrchestrationStore.getState()

    for (const [chatId, run] of store.runs) {
      if (run.status !== "running") continue

      // Auto-skip tasks that have been "stuck" beyond the timeout
      const stuckTasks = run.tasks.filter((t) => t.status === "stuck")
      for (const task of stuckTasks) {
        const stuckSince = stuckTimestampsRef.current.get(task.id)
        if (!stuckSince) {
          // First time seeing this task as stuck — record timestamp
          stuckTimestampsRef.current.set(task.id, Date.now())
          continue
        }
        if (Date.now() - stuckSince > STUCK_AUTO_SKIP_TIMEOUT) {
          // Auto-skip: task has been stuck too long without manual intervention
          try {
            await trpcClient.orchestration.completeTask.mutate({
              taskId: task.id,
              runId: run.id,
              resultSummary: "Auto-skipped: stuck task exceeded timeout without manual intervention",
              finalStatus: "skipped",
            })
            store.updateTaskStatus(chatId, task.id, "skipped", "Auto-skipped: stuck task exceeded timeout without manual intervention")
            stuckTimestampsRef.current.delete(task.id)
            scheduleTickRef.current()
          } catch {
            // Non-fatal — will retry on next tick
          }
        }
      }

      try {
        const stuckWorkers = await trpcClient.orchestration.checkStuckWorkers.query({
          runId: run.id,
        })

        for (const stuck of stuckWorkers) {
          const retries = retryCountsRef.current.get(stuck.taskId) ?? 0

          if (retries >= 2) {
            // Max retries exceeded — escalate (auto-skip timer starts)
            store.updateTaskStatus(chatId, stuck.taskId, "stuck", stuck.reason)
            if (!stuckTimestampsRef.current.has(stuck.taskId)) {
              stuckTimestampsRef.current.set(stuck.taskId, Date.now())
            }
            toast.error(`Worker "${stuck.taskName}" is stuck and needs attention`, {
              duration: 10000,
              action: goToWorkerTab(chatId, stuck.subChatId),
            })
            continue
          }

          // Try to diagnose and intervene
          try {
            const diagnosis = await trpcClient.orchestration.diagnoseWorker.mutate({
              taskId: stuck.taskId,
              runId: run.id,
              stuckReason: stuck.reason,
            })

            switch (diagnosis.intervention) {
              case "retry_with_hint":
                if (diagnosis.hint && stuck.subChatId) {
                  // Inject guidance message into worker queue
                  useMessageQueueStore.getState().addToQueue(stuck.subChatId, {
                    id: generateQueueId(),
                    message: `[Orchestrator guidance]: ${diagnosis.hint}`,
                    timestamp: new Date(),
                    status: "pending",
                  })
                  retryCountsRef.current.set(stuck.taskId, retries + 1)
                }
                break

              case "skip":
                // Use completeTask with "skipped" to properly unblock dependents
                try {
                  const skipResult = await trpcClient.orchestration.completeTask.mutate({
                    taskId: stuck.taskId,
                    runId: run.id,
                    resultSummary: diagnosis.reason,
                    finalStatus: "skipped",
                  })
                  store.updateTaskStatus(chatId, stuck.taskId, "skipped", diagnosis.reason)
                  if (skipResult.unblocked > 0) {
                    // Refresh run to get updated dependency states
                    const freshRun = await trpcClient.orchestration.getRun.query({ runId: run.id })
                    if (freshRun) {
                      store.setRun(chatId, {
                        id: freshRun.id,
                        chatId: freshRun.chatId,
                        controllerSubChatId: freshRun.controllerSubChatId,
                        userGoal: freshRun.userGoal,
                        decomposedPlan: freshRun.decomposedPlan,
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
                          autonomy: (t.autonomy || "auto") as any,
                          allowedPaths: t.allowedPaths ? JSON.parse(t.allowedPaths) : null,
                          resultSummary: t.resultSummary,
                          startedAt: t.startedAt ? new Date(t.startedAt) : null,
                          completedAt: t.completedAt ? new Date(t.completedAt) : null,
                        })),
                      })
                    }
                    scheduleTickRef.current()
                  }
                } catch {
                  // Fallback: at least update store
                  store.updateTaskStatus(chatId, stuck.taskId, "skipped", diagnosis.reason)
                }
                break

              case "escalate":
                // DB first, then store
                try {
                  await trpcClient.orchestration.updateTaskStatus.mutate({
                    taskId: stuck.taskId,
                    runId: run.id,
                    status: "stuck",
                    resultSummary: stuck.reason,
                  })
                } catch { /* non-fatal */ }
                store.updateTaskStatus(chatId, stuck.taskId, "stuck", stuck.reason)
                if (!stuckTimestampsRef.current.has(stuck.taskId)) {
                  stuckTimestampsRef.current.set(stuck.taskId, Date.now())
                }
                toast.error(`Worker "${stuck.taskName}" needs manual intervention: ${diagnosis.diagnosis}`, {
                  duration: 15000,
                  action: goToWorkerTab(chatId, stuck.subChatId),
                })
                break

              case "re_scope":
                // DB first, then store
                try {
                  await trpcClient.orchestration.updateTaskStatus.mutate({
                    taskId: stuck.taskId,
                    runId: run.id,
                    status: "stuck",
                    resultSummary: `Re-scope needed: ${diagnosis.diagnosis}`,
                  })
                } catch { /* non-fatal */ }
                store.updateTaskStatus(chatId, stuck.taskId, "stuck", `Re-scope needed: ${diagnosis.diagnosis}`)
                if (!stuckTimestampsRef.current.has(stuck.taskId)) {
                  stuckTimestampsRef.current.set(stuck.taskId, Date.now())
                }
                toast.warning(`Worker "${stuck.taskName}" needs re-scoping: ${diagnosis.diagnosis}`, {
                  duration: 10000,
                  action: goToWorkerTab(chatId, stuck.subChatId),
                })
                break

              default:
                // Unknown intervention from LLM — treat as escalation
                store.updateTaskStatus(chatId, stuck.taskId, "stuck", stuck.reason)
                if (!stuckTimestampsRef.current.has(stuck.taskId)) {
                  stuckTimestampsRef.current.set(stuck.taskId, Date.now())
                }
                toast.warning(`Worker "${stuck.taskName}" needs attention (unrecognized intervention: ${diagnosis.intervention})`, {
                  duration: 10000,
                  action: goToWorkerTab(chatId, stuck.subChatId),
                })
                break
            }
          } catch (err) {
            console.error("[OrchestrationProcessor] Diagnosis failed:", err)
          }
        }
      } catch (err) {
        console.error("[OrchestrationProcessor] Stuck check failed:", err)
      }
    }
    } finally {
      stuckCheckingRef.current = false
    }
  }, [scheduleTick])

  useEffect(() => {
    // Rehydrate store from DB on mount (handles app restart/refresh)
    // rehydratedRef gates processTick — ticks are blocked until rehydration completes
    // to prevent double-spawning tasks that are already running in DB
    if (!rehydratedRef.current) {
      ;(async () => {
        try {
          const store = useOrchestrationStore.getState()
          const subChatStore = useAgentSubChatStore.getState()

          // Collect all chatIds from open sub-chats to check for active runs
          const chatIds = new Set<string>()
          for (const [chatId] of store.runs) chatIds.add(chatId)

          // Also discover chatIds from sub-chats with orchestration metadata
          for (const sc of subChatStore.allSubChats) {
            if (sc.orchestrationRunId) {
              // Sub-chat belongs to an orchestration — we need its chatId
              // Query the sub-chat's parent chatId from DB
              try {
                const subChatData = await trpcClient.chats.getSubChat.query({ id: sc.id })
                if (subChatData?.chatId) chatIds.add(subChatData.chatId)
              } catch { /* skip */ }
            }
          }

          // For each known chatId, check for active runs in DB and hydrate store
          for (const chatId of chatIds) {
            try {
              const activeRuns = await trpcClient.orchestration.getActiveRuns.query({ chatId })
              if (activeRuns.length > 0) {
                const latestRun = activeRuns[0]!
                const fullRun = await trpcClient.orchestration.getRun.query({ runId: latestRun.id })
                if (fullRun) {
                  store.setRun(chatId, {
                    id: fullRun.id,
                    chatId: fullRun.chatId,
                    controllerSubChatId: fullRun.controllerSubChatId,
                    userGoal: fullRun.userGoal,
                    decomposedPlan: fullRun.decomposedPlan || "",
                    status: fullRun.status as any,
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
                      autonomy: (t.autonomy || "auto") as any,
                      allowedPaths: t.allowedPaths ? JSON.parse(t.allowedPaths) : null,
                      resultSummary: t.resultSummary,
                      startedAt: t.startedAt ? new Date(t.startedAt) : null,
                      completedAt: t.completedAt ? new Date(t.completedAt) : null,
                    })),
                  })

                  // Also mark already-spawned tasks so we don't double-spawn
                  for (const task of fullRun.tasks) {
                    if (["running", "queued", "completed", "failed", "skipped"].includes(task.status)) {
                      spawnedTasksRef.current.add(task.id)
                    }
                  }
                }

                // Load concurrency config for this workspace
                const config = await trpcClient.orchestration.getConfig.query({ chatId })
                maxWorkersRef.current = config.concurrency
              }
            } catch { /* non-fatal per workspace */ }
          }
        } catch {
          // Non-fatal — initial rehydration can silently fail
        } finally {
          // Mark rehydration complete — unblocks processTick and triggers first tick
          rehydratedRef.current = true
          scheduleTick()
        }
      })()
    }

    // Subscribe to orchestration store changes → trigger processing
    const unsubRuns = useOrchestrationStore.subscribe(
      (state) => state.runs,
      () => scheduleTick(),
    )

    // Subscribe to streaming status changes → check for worker completions
    // Also track "has ever streamed" for completion detection
    const unsubStatus = useStreamingStatusStore.subscribe(
      (state) => state.statuses,
      (statuses) => {
        // Track streaming transitions
        for (const [subChatId, status] of Object.entries(statuses)) {
          if (status === "streaming" || status === "submitted") {
            hasEverStreamedRef.current.add(subChatId)
          }
        }
        checkWorkerCompletions()
      },
    )

    // Subscribe to message queue changes → may need to process
    const unsubQueue = useMessageQueueStore.subscribe(
      (state) => state.queues,
      () => scheduleTick(),
    )

    // Stuck worker check interval
    stuckTimerRef.current = setInterval(checkStuck, STUCK_CHECK_INTERVAL)

    return () => {
      unsubRuns()
      unsubStatus()
      unsubQueue()
      if (tickTimerRef.current) clearTimeout(tickTimerRef.current)
      if (stuckTimerRef.current) clearInterval(stuckTimerRef.current)
    }
  }, [scheduleTick, checkWorkerCompletions, checkStuck])

  // Clean up tracking refs when runs change significantly
  useEffect(() => {
    return useOrchestrationStore.subscribe(
      (state) => state.runs,
      (runs: Map<string, OrchestrationRun>) => {
        // Collect all active task IDs and sub-chat IDs
        const activeTaskIds = new Set<string>()
        const activeSubChatIds = new Set<string>()
        for (const [, run] of runs) {
          for (const task of run.tasks) {
            activeTaskIds.add(task.id)
            if (task.subChatId) activeSubChatIds.add(task.subChatId)
          }
        }

        // Clean up spawned tracking for tasks no longer active
        for (const taskId of spawnedTasksRef.current) {
          if (!activeTaskIds.has(taskId)) {
            spawnedTasksRef.current.delete(taskId)
          }
        }

        // Clean up completed tracking for sub-chats no longer active
        for (const subChatId of completedSubChatsRef.current) {
          if (!activeSubChatIds.has(subChatId)) {
            completedSubChatsRef.current.delete(subChatId)
          }
        }

        // Clean up hasEverStreamed for sub-chats no longer active
        for (const subChatId of hasEverStreamedRef.current) {
          if (!activeSubChatIds.has(subChatId)) {
            hasEverStreamedRef.current.delete(subChatId)
          }
        }

        // Clean up retry counts for tasks no longer active
        for (const taskId of retryCountsRef.current.keys()) {
          if (!activeTaskIds.has(taskId)) {
            retryCountsRef.current.delete(taskId)
          }
        }

        // Clean up spawn times for tasks no longer active
        for (const taskId of spawnTimesRef.current.keys()) {
          if (!activeTaskIds.has(taskId)) {
            spawnTimesRef.current.delete(taskId)
          }
        }

        // Clean up stuck timestamps for tasks no longer active
        for (const taskId of stuckTimestampsRef.current.keys()) {
          if (!activeTaskIds.has(taskId)) {
            stuckTimestampsRef.current.delete(taskId)
          }
        }
      },
    )
  }, [])

  return null
}
