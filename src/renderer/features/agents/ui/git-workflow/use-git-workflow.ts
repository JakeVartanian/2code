import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { trpc } from "../../../../lib/trpc"
import { useGitWatcher } from "../../../../lib/hooks/use-file-change-listener"

export type WorkflowStage =
  | "LOCAL_CHANGES"
  | "COMMITTED"
  | "PUSHED"
  | "PR_OPEN"
  | "MERGED"

export type WorkflowMode = "worktree" | "direct"

export interface WorkflowState {
  mode: WorkflowMode
  stage: WorkflowStage | null
  // Local git state
  uncommittedFiles: Array<{ path: string; status: "M" | "A" | "D" | "R" | "?" }>
  unpushedCommits: Array<{ sha: string; shortSha: string; message: string }>
  aheadCount: number
  behindCount: number
  hasRemote: boolean
  isClean: boolean
  // GitHub-side PR state
  prNumber: number | null
  prUrl: string | null
  prState: "open" | "draft" | "merged" | "closed" | null
  prMergeable: string | null
  prReviewDecision: string | null
  // Loading / error
  isLoading: boolean
  isRefetching: boolean
}

function deriveStage(
  mode: WorkflowMode,
  state: {
    hasUncommittedChanges: boolean
    aheadCount: number
    hasRemote: boolean
    prNumber: number | null
    prState: "open" | "draft" | "merged" | "closed" | null
  },
): WorkflowStage | null {
  if (mode === "direct") return null // direct mode uses simple commit/push, no staged workflow

  if (state.prState === "merged") return "MERGED"
  if (state.prNumber && (state.prState === "open" || state.prState === "draft")) return "PR_OPEN"
  if (state.hasRemote && state.aheadCount === 0 && !state.hasUncommittedChanges) return "PUSHED"
  if (state.aheadCount > 0 && !state.hasUncommittedChanges) return "COMMITTED"
  return "LOCAL_CHANGES"
}

interface UseGitWorkflowOptions {
  chatId: string
  worktreePath: string | null
  branch: string | null
  baseBranch: string | null
  prNumber: number | null
  prUrl: string | null
}

export function useGitWorkflow({
  chatId,
  worktreePath,
  branch,
  baseBranch,
  prNumber,
  prUrl,
}: UseGitWorkflowOptions) {
  const queryClient = useQueryClient()
  const mode: WorkflowMode = worktreePath ? "worktree" : "direct"

  // Whether base branch dropdown is open — gates the getBranches fetch
  const [isBranchDropdownOpen, setIsBranchDropdownOpen] = useState(false)

  // Subscribe to the git watcher so state updates within ~100ms of any git op
  useGitWatcher(worktreePath, {
    onChange: () => {
      queryClient.invalidateQueries({ queryKey: [["changes", "getWorkflowState"]] })
    },
  })

  // Background git fetch to keep remote tracking refs up-to-date.
  // Without this, ahead/behind counts go stale because they compare against
  // local copies of remote refs that only update on fetch.
  const fetchMutation = trpc.changes.fetch.useMutation()
  const lastFetchRef = useRef(0)

  useEffect(() => {
    if (!worktreePath) return
    const doFetch = () => {
      const now = Date.now()
      if (now - lastFetchRef.current < 90_000) return // debounce: 90s minimum between fetches
      lastFetchRef.current = now
      fetchMutation.mutate(
        { worktreePath },
        {
          onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: [["changes", "getWorkflowState"]] })
          },
        },
      )
    }

    // Fetch on mount
    doFetch()

    // Then every 2 minutes
    const interval = setInterval(doFetch, 120_000)
    return () => clearInterval(interval)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [worktreePath])

  // Aggregate local git state — fast, no network
  const {
    data: workflowData,
    isLoading: isWorkflowLoading,
    isRefetching: isWorkflowRefetching,
    refetch: refetchWorkflow,
  } = trpc.changes.getWorkflowState.useQuery(
    { worktreePath: worktreePath || "", baseBranch: baseBranch ?? undefined },
    {
      enabled: !!worktreePath,
      refetchInterval: 30_000,
      staleTime: 5_000,
    },
  )

  // GitHub-side PR status — polls every 60s since it's network
  const { data: prStatusData, refetch: refetchPrStatus } = trpc.chats.getPrStatus.useQuery(
    { chatId },
    {
      enabled: !!prNumber,
      refetchInterval: 60_000,
    },
  )

  // Remote branches — fetched lazily when the base branch dropdown opens
  const { data: branchesData } = trpc.changes.getBranches.useQuery(
    { worktreePath: worktreePath || "" },
    {
      enabled: !!worktreePath && isBranchDropdownOpen,
      staleTime: 30_000,
    },
  )

  const pr = prStatusData?.pr
  const prState = pr?.state as "open" | "draft" | "merged" | "closed" | null ?? null
  const prMergeable = pr?.mergeable ?? null
  const prReviewDecision = pr?.reviewDecision ?? null

  const stage = useMemo(
    () =>
      deriveStage(mode, {
        hasUncommittedChanges: workflowData?.hasUncommittedChanges ?? false,
        aheadCount: workflowData?.aheadCount ?? 0,
        hasRemote: workflowData?.hasRemote ?? false,
        prNumber,
        prState,
      }),
    [mode, workflowData, prNumber, prState],
  )

  const state: WorkflowState = {
    mode,
    stage,
    uncommittedFiles: workflowData?.uncommittedFiles ?? [],
    unpushedCommits: workflowData?.unpushedCommits ?? [],
    aheadCount: workflowData?.aheadCount ?? 0,
    behindCount: workflowData?.behindCount ?? 0,
    hasRemote: workflowData?.hasRemote ?? false,
    isClean: workflowData?.isClean ?? true,
    prNumber,
    prUrl,
    prState,
    prMergeable,
    prReviewDecision,
    isLoading: isWorkflowLoading,
    isRefetching: isWorkflowRefetching,
  }

  // Mutations
  const stageAllMutation = trpc.changes.stageAll.useMutation()
  const commitMutation = trpc.changes.commit.useMutation()
  const pushMutation = trpc.changes.push.useMutation()
  const createPrMutation = trpc.changes.createPR.useMutation()
  const mergeFromDefaultMutation = trpc.changes.mergeFromDefault.useMutation()
  const renameBranchMutation = trpc.changes.renameBranch.useMutation()
  const updateBaseBranchMutation = trpc.chats.updateBaseBranch.useMutation()

  const preflight = useCallback(async () => {
    // Fetch remote refs first so ahead/behind counts are accurate before acting
    if (worktreePath) {
      lastFetchRef.current = Date.now()
      await fetchMutation.mutateAsync({ worktreePath }).catch(() => {})
    }
    await Promise.allSettled([refetchWorkflow(), refetchPrStatus()])
  }, [worktreePath, fetchMutation, refetchWorkflow, refetchPrStatus])

  const handleCommit = useCallback(
    async (message: string) => {
      if (!worktreePath) return
      try {
        await preflight()
        await stageAllMutation.mutateAsync({ worktreePath })
        await commitMutation.mutateAsync({ worktreePath, message })
        queryClient.invalidateQueries({ queryKey: [["changes", "getWorkflowState"]] })
      } catch (err) {
        toast.error((err as Error).message || "Commit failed", { position: "top-center" })
      }
    },
    [worktreePath, preflight, stageAllMutation, commitMutation, queryClient],
  )

  const handlePush = useCallback(async () => {
    if (!worktreePath) return
    try {
      await preflight()
      await pushMutation.mutateAsync({ worktreePath, setUpstream: !state.hasRemote })
      queryClient.invalidateQueries({ queryKey: [["changes", "getWorkflowState"]] })
    } catch (err) {
      toast.error((err as Error).message || "Push failed", { position: "top-center" })
    }
  }, [worktreePath, preflight, pushMutation, state.hasRemote, queryClient])

  const handleOpenPR = useCallback(async () => {
    if (!worktreePath) return
    try {
      await preflight()
      await createPrMutation.mutateAsync({ worktreePath })
    } catch (err) {
      toast.error((err as Error).message || "Failed to open PR", { position: "top-center" })
    }
  }, [worktreePath, preflight, createPrMutation])

  const handleRebase = useCallback(async () => {
    if (!worktreePath) return
    try {
      await preflight()
      await mergeFromDefaultMutation.mutateAsync({ worktreePath, useRebase: true })
      queryClient.invalidateQueries({ queryKey: [["changes", "getWorkflowState"]] })
      toast.success("Rebased onto base branch", { position: "top-center" })
    } catch (err) {
      toast.error((err as Error).message || "Rebase failed", { position: "top-center" })
    }
  }, [worktreePath, preflight, mergeFromDefaultMutation, queryClient])

  const handleRenameBranch = useCallback(
    async (newBranchName: string) => {
      if (!worktreePath) return
      try {
        await renameBranchMutation.mutateAsync({ worktreePath, newBranchName })
        queryClient.invalidateQueries({ queryKey: [["changes", "getWorkflowState"]] })
        queryClient.invalidateQueries({ queryKey: [["chats"]] })
        toast.success(`Branch renamed to ${newBranchName}`, { position: "top-center" })
      } catch (err) {
        toast.error((err as Error).message || "Rename failed", { position: "top-center" })
        throw err
      }
    },
    [worktreePath, renameBranchMutation, queryClient],
  )

  const handleUpdateBaseBranch = useCallback(
    async (newBaseBranch: string) => {
      try {
        await updateBaseBranchMutation.mutateAsync({ id: chatId, baseBranch: newBaseBranch })
        queryClient.invalidateQueries({ queryKey: [["changes", "getWorkflowState"]] })
        queryClient.invalidateQueries({ queryKey: [["chats"]] })
      } catch (err) {
        toast.error((err as Error).message || "Failed to update base branch", { position: "top-center" })
        throw err
      }
    },
    [chatId, updateBaseBranchMutation, queryClient],
  )

  const isMutating =
    stageAllMutation.isPending ||
    commitMutation.isPending ||
    pushMutation.isPending ||
    createPrMutation.isPending ||
    mergeFromDefaultMutation.isPending ||
    renameBranchMutation.isPending ||
    updateBaseBranchMutation.isPending

  // Live branch from git — always reflects the actual checked-out branch,
  // even when the agent switches via raw `git checkout` (bypassing our mutations).
  const liveBranch = workflowData?.currentBranch ?? branch

  // Auto-sync DB when we detect branch drift from agent's raw git commands.
  // This keeps the chat record in sync so other UI components see the correct branch.
  const lastSyncedBranchRef = useRef<string | null>(null)
  const updateChatBranchMutation = trpc.chats.updateBranch.useMutation()

  useEffect(() => {
    if (!liveBranch || !chatId || isMutating) return
    if (lastSyncedBranchRef.current === liveBranch) return
    if (liveBranch === branch) {
      lastSyncedBranchRef.current = liveBranch
      return
    }

    lastSyncedBranchRef.current = liveBranch
    updateChatBranchMutation.mutate(
      { id: chatId, branch: liveBranch },
      { onSuccess: () => queryClient.invalidateQueries({ queryKey: [["chats"]] }) },
    )
  }, [liveBranch, branch, chatId, isMutating, queryClient, updateChatBranchMutation])

  return {
    state,
    stage,
    mode,
    branch: liveBranch,
    baseBranch,
    remoteBranches: branchesData?.remote ?? [],
    isBranchDropdownOpen,
    setIsBranchDropdownOpen,
    isMutating,
    handleCommit,
    handlePush,
    handleOpenPR,
    handleRebase,
    handleRenameBranch,
    handleUpdateBaseBranch,
    refetch: preflight,
  }
}
