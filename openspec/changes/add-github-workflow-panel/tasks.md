## 1. Backend
- [x] 1.1 Add `getWorkflowState` query to `git-operations.ts`
- [x] 1.2 Add `stageAll` mutation to `git-operations.ts`

## 2. Frontend — Hook
- [x] 2.1 Create `use-git-workflow.ts` hook (watcher + queries + mutations + stage derivation)

## 3. Frontend — Components
- [x] 3.1 `git-panel-pill.tsx` (collapsed single-line view)
- [x] 3.2 `git-branch-context.tsx` (branch relationship header)
- [x] 3.3 `git-workflow-stepper.tsx` (5-stage stepper)
- [x] 3.4 `git-divergence-warning.tsx` (base-behind banner)
- [x] 3.5 `git-changed-files.tsx` (M/A/D file list)
- [x] 3.6 `git-local-commits.tsx` (unpushed commits)
- [x] 3.7 `git-pr-card.tsx` (PR status + checks)
- [x] 3.8 `git-action-area.tsx` (contextual action button)
- [x] 3.9 `git-merge-confirm-dialog.tsx` (typed confirmation)
- [x] 3.10 `git-workflow-panel.tsx` (container)

## 4. Wire-up
- [x] 4.1 Replace `PrStatusBar` with `GitWorkflowPanel` in `active-chat.tsx`
- [x] 4.2 Delete `pr-status-bar.tsx`

## 5. Docs
- [x] 5.1 Update `CLAUDE.md` with accurate worktree model description
