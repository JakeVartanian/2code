# Tasks: Add Ambient Background Agent

## Phase 1 — Foundation
- [ ] Add `ambientSuggestions` table to DB schema
- [ ] Add `ambientBudget` table to DB schema
- [ ] Add `ambientFeedback` table to DB schema
- [ ] Generate migration file (`bun run db:generate`)
- [ ] Create `src/main/lib/ambient/types.ts`
- [ ] Create `src/main/lib/ambient/config.ts` (default config + `.2code/ambient.json` loader)
- [ ] Create `src/main/lib/ambient/budget.ts` (token budget tracker with atomic increment)

## Phase 2 — Event Sources
- [ ] Create `src/main/lib/ambient/file-watcher.ts` (chokidar, 30s debounce, batch 5-8 files)
- [ ] Create `src/main/lib/ambient/git-monitor.ts` (subscribe to existing gitWatcherRegistry)
- [ ] Create `src/main/lib/ambient/index.ts` (AmbientAgent class, lifecycle, registry)

## Phase 3 — Tier 0 (Free Heuristics)
- [ ] Create `src/main/lib/ambient/heuristics.ts` (pattern matching, file type filter, dedup)
- [ ] Integrate with memory system (load gotchas for pattern matching)

## Phase 4 — Frontend UI
- [ ] Create `src/main/lib/trpc/routers/ambient.ts` (queries, mutations, subscription)
- [ ] Register ambient router in `src/main/lib/trpc/routers/index.ts`
- [ ] Create `src/renderer/features/ambient/store.ts` (Zustand)
- [ ] Create `src/renderer/features/ambient/atoms.ts` (UI-only atoms)
- [ ] Create `src/renderer/features/ambient/ambient-sidebar-section.tsx` (compact rows)
- [ ] Create `src/renderer/features/ambient/ambient-indicator.tsx` (teal/amber/red dot)
- [ ] Create `src/renderer/features/ambient/ambient-suggestion-card.tsx` (expanded popover)
- [ ] Create `src/renderer/features/ambient/hooks/use-ambient-subscription.ts`
- [ ] Create `src/renderer/features/ambient/hooks/use-ambient-actions.ts`
- [ ] Add ambient section to sidebar in `agents-layout.tsx` or `agents-sidebar.tsx`

## Phase 5 — Tier 1 (Haiku Triage)
- [ ] Create `src/main/lib/ambient/provider.ts` (multi-provider abstraction)
- [ ] Create `src/main/lib/ambient/triage.ts` (batch Haiku classification)
- [ ] Wire budget checks into triage calls
- [ ] Create `src/main/lib/ambient/feedback.ts` (dismissal learning, weight decay)

## Phase 6 — Tier 2 (Sonnet Analysis)
- [ ] Create `src/main/lib/ambient/analysis.ts` (deep analysis, suggested prompt generation)
- [ ] Wire memory writing for high-confidence findings (via `evolveMemory`)
- [ ] Wire suggestion persistence to DB + tRPC subscription emit

## Phase 7 — Rapid Onboarding + Brain Backfill
- [ ] Create `src/main/lib/ambient/onboarding.ts` (new project scan)
- [ ] Create `src/main/lib/ambient/backfill.ts` (existing project "Build Brain")
- [ ] Add `buildBrain` and `refreshBrain` mutations to ambient router
- [ ] Add Build Brain / Refresh UI to Memory settings tab
- [ ] Write memories in ALWAYS/NEVER/Applies-to directive format

## Phase 8 — Compounding Intelligence
- [ ] Create `src/main/lib/ambient/memory-evolution.ts` (progressive refinement, dedup, confidence building)
- [ ] Create `src/main/lib/ambient/staleness.ts` (invalidate memories on file changes)
- [ ] Create `src/main/lib/ambient/synthesis.ts` (weekly Haiku reflection)
- [ ] Convention crystallization: after 5+ pattern instances, auto-create directive memory
- [ ] Architecture mapping: temporal coupling from git log

## Phase 9 — Enhanced Initial Injection
- [ ] Upgrade `getMemoriesForInjection` to accept file path list (not just text hint)
- [ ] Add `getCoupledFiles(projectId, filePaths)` using ambient architecture map
- [ ] Add `getBrainSummary(projectId)` for compact project overview block
- [ ] Upgrade injection in `claude.ts` to use enhanced context when ambient brain exists
- [ ] Increase token budget to 3000 when project has rich brain

## Phase 10 — Orchestration Bridge
- [ ] Add `draftOrchestrationPlan` mutation (calls decomposeGoal with suggestion context)
- [ ] Add "Launch Plan" action to suggestion cards for complex findings
- [ ] Enrich orchestrator decomposition with ambient architecture knowledge

## Phase 11 — Polish
- [ ] Add ambient settings section to Memory tab (enable, sensitivity, budget, categories, quiet hours)
- [ ] Add category weight visualization with reset buttons
- [ ] Implement cold start observation mode (4-hour silent period)
- [ ] Implement quiet hours (no API calls during configured window)
- [ ] Implement budget degradation tiers (>50%, 25-50%, 10-25%, <5%)
- [ ] Add "Brain" status card (memory count, confidence, last built/refreshed)
- [ ] Add error-based degradation (API errors → Tier 0 only, retry with backoff)
- [ ] Accessibility pass: ARIA labels, keyboard nav, focus management, tooltips
