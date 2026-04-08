# Change: Add GitHub Workflow Panel

## Why
Users with multiple git worktrees (one per chat) lose track of which branch they're on, accidentally push to the wrong place, and have no clear visual guide through the commit → push → PR → merge workflow. The current `PrStatusBar` only appears after a PR exists and shows no guidance before that point.

## What Changes
- Add a collapsible `GitWorkflowPanel` to the top of each chat view, replacing `PrStatusBar`
- Panel has two modes: **worktree** (5-stage workflow: Changes → Commit → Push → PR → Merged) and **direct** (simple commit + push for local-mode chats)
- Action area always previews exactly what will happen before clicking (files for commit, SHAs for push, branches for merge)
- Real-time updates via existing `useGitWatcher` hook (chokidar, ~100ms latency) — no new IPC or watchers needed
- Pre-flight refetch on every action to ensure the preview is fresh before executing
- Merge requires typed branch-name confirmation (Radix Dialog)
- Add `getWorkflowState` query and `stageAll` mutation to `git-operations.ts`
- Update CLAUDE.md to accurately describe the worktree model (currently listed as "Planned" but already built)

## Impact
- Affected specs: `github-workflow` (new capability)
- Affected code: `src/main/lib/git/git-operations.ts`, `src/renderer/features/agents/main/active-chat.tsx`, `src/renderer/features/agents/ui/pr-status-bar.tsx` (deleted), new `src/renderer/features/agents/ui/git-workflow/` directory
