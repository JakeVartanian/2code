# Implementation Tasks: Agent Memory Vault & Orchestration Layer

## Phase 1: Memory Vault Foundation (Core Infrastructure)

### 1.1 Memory Filesystem Layer
- [ ] 1.1.1 Create `src/main/lib/memory/vault.ts` — Memory vault manager: init directory structure, read/write entries, enforce size limits (200-line MEMORY.md, 500-line topic files)
- [ ] 1.1.2 Create `src/main/lib/memory/entry-parser.ts` — Parse memory entries with YAML frontmatter + markdown body; serialize entries back to markdown
- [ ] 1.1.3 Create `src/main/lib/memory/deduplicator.ts` — SHA-256 hash normalization + fuzzy matching (>80% similarity detection) for deduplication
- [ ] 1.1.4 Create `src/main/lib/memory/sanitizer.ts` — Strip API keys, tokens, passwords, credentials from extracted content before writing
- [ ] 1.1.5 Create `src/main/lib/memory/types.ts` — TypeScript types: MemoryEntry, MemoryVault, MemoryCategory, MemoryTier, TopicFile, SessionLog

### 1.2 Memory tRPC Router
- [ ] 1.2.1 Create `src/main/lib/trpc/routers/memory.ts` — CRUD procedures: `getVault(projectPath)`, `getTopicFile(projectPath, topic)`, `upsertEntry(projectPath, entry)`, `deleteEntry(projectPath, entryId)`, `getMemoryIndex(projectPath)` (returns MEMORY.md content for system prompt injection)
- [ ] 1.2.2 Add `consolidate(projectPath)` procedure — triggers consolidation pass (contradiction detection, staleness check, index cleanup)
- [ ] 1.2.3 Add `getSessionLogs(projectPath, limit?)` procedure — returns cold-tier session logs for UI display
- [ ] 1.2.4 Register memory router in `src/main/lib/trpc/routers/index.ts`

### 1.3 System Prompt Integration
- [ ] 1.3.1 Modify `src/main/lib/trpc/routers/claude.ts` lines 2202-2230 — Add MEMORY.md injection into `systemAppend` BEFORE AGENTS.md (so memory gets prompt-cached). Read `MEMORY.md` via a cached reader (same pattern as `readAgentsMdCached`)
- [ ] 1.3.2 Create `src/main/lib/memory/cache.ts` — Cached MEMORY.md reader with mtime tracking (same pattern as agents.md cache in claude.ts line 609)
- [ ] 1.3.3 Ensure MEMORY.md injection follows Ollama truncation logic (cap at 300 chars for Ollama, full for Anthropic API)

### 1.4 Auto-Accretion Pipeline
- [ ] 1.4.1 Create `src/main/lib/memory/accretion.ts` — Post-session extraction: accepts session transcript (last N messages), calls Haiku for structured extraction, returns array of candidate MemoryEntry objects
- [ ] 1.4.2 Create `src/main/lib/memory/accretion-prompt.ts` — The extraction prompt for Haiku: instructs it to identify decisions, mistakes, patterns, conventions, rejected approaches; return as structured JSON
- [ ] 1.4.3 Integrate accretion into `src/main/lib/trpc/routers/claude.ts` post-stream section — After session save completes (non-blocking, fire-and-forget), call accretion pipeline with the session's messages
- [ ] 1.4.4 Create `src/main/lib/memory/session-logger.ts` — Writes session summaries to `sessions/YYYY-MM-DD-<slug>.md` and appends to `log.md`
- [ ] 1.4.5 Add `.gitignore` generation — When vault is initialized, create `.2code/memory/sessions/.gitignore` with `*` (gitignore session logs by default)

### 1.5 Memory Consolidation
- [ ] 1.5.1 Create `src/main/lib/memory/consolidation.ts` — Consolidation logic: reads all topic files, detects contradictions (Haiku call), merges duplicates, marks stale entries (90-day no-reference), trims MEMORY.md to 200 lines
- [ ] 1.5.2 Add session counter tracking — Track session count per project in SQLite (simple counter table); trigger auto-consolidation at every 10th session
- [ ] 1.5.3 Add `memory.consolidate` tRPC procedure for manual trigger from UI

## Phase 2: Memory UI

### 2.1 Memory Panel
- [ ] 2.1.1 Create `src/renderer/features/memory/components/memory-panel.tsx` — Main memory viewer panel: shows MEMORY.md index, links to topic files, category badges, search/filter
- [ ] 2.1.2 Create `src/renderer/features/memory/components/topic-file-viewer.tsx` — Displays entries from a single topic file with edit/delete/pin actions per entry
- [ ] 2.1.3 Create `src/renderer/features/memory/components/memory-entry-editor.tsx` — Add/edit form: content textarea, category select, confidence select, tags input, pin toggle
- [ ] 2.1.4 Create `src/renderer/features/memory/components/session-log-viewer.tsx` — Timeline view of session logs (cold tier)

### 2.2 Memory Indicator
- [ ] 2.2.1 Create `src/renderer/features/memory/components/memory-indicator.tsx` — Compact `h-5` pill in chat header: `Memory: 12 entries` showing count of active memories for current project. Click opens memory panel
- [ ] 2.2.2 Mount memory indicator in `src/renderer/features/agents/main/active-chat.tsx` chat header area

### 2.3 Memory Atoms & State
- [ ] 2.3.1 Create `src/renderer/features/memory/atoms/index.ts` — Jotai atoms: `memoryCategoryFilterAtom`, `memorySearchAtom`, `memoryPanelOpenAtom`
- [ ] 2.3.2 Add memory settings to existing settings dialog: consolidation interval, auto-accretion toggle, confidence threshold for auto-extraction

## Phase 3: Agent Orchestration

### 3.1 Orchestration Schema
- [ ] 3.1.1 Add `orchestration_runs` table to `src/main/lib/db/schema/index.ts` — Fields: id, chatId, subChatId, goal, status (planning|executing|reviewing|completed|failed|paused), taskGraph (JSON), memoryContext (JSON), checkpoint (JSON), timestamps
- [ ] 3.1.2 Add `orchestration_tasks` table — Fields: id, runId, workerType, description, status (pending|blocked|running|completed|failed|skipped), dependsOn (JSON), memoryFiles (JSON), result (JSON), error, timestamps
- [ ] 3.1.3 Generate migration: `drizzle/00XX_orchestration.sql`
- [ ] 3.1.4 Add type exports and relations

### 3.2 Orchestration Engine (Main Process)
- [ ] 3.2.1 Create `src/main/lib/orchestration/orchestrator.ts` — Core orchestration engine: receives goal + memory context, produces task graph, dispatches workers, manages checkpoints, synthesizes results
- [ ] 3.2.2 Create `src/main/lib/orchestration/task-decomposer.ts` — Uses Claude (via SDK) to decompose a goal into a DAG of subtasks with dependencies, worker type assignments, and memory file selections per task
- [ ] 3.2.3 Create `src/main/lib/orchestration/worker-dispatch.ts` — Dispatches workers via the existing subagent system: builds agent options with tool restrictions, injects memory context, captures structured results
- [ ] 3.2.4 Create `src/main/lib/orchestration/checkpoint.ts` — Saves/loads orchestration state to SQLite for crash recovery and pause/resume
- [ ] 3.2.5 Create `src/main/lib/orchestration/types.ts` — TypeScript types: OrchestrationRun, OrchestrationTask, TaskGraph, WorkerType, CheckpointData

### 3.3 Orchestration tRPC Router
- [ ] 3.3.1 Create `src/main/lib/trpc/routers/orchestration.ts` — Procedures: `start(chatId, subChatId, goal)`, `pause(runId)`, `resume(runId)`, `stop(runId)`, `approveTask(taskId)`, `getStatus(runId)`, `listRuns(chatId)`
- [ ] 3.3.2 Add `onProgress` subscription — Streams orchestration progress events to renderer (task started, task completed, task failed, checkpoint saved, approval needed)
- [ ] 3.3.3 Register orchestration router in `src/main/lib/trpc/routers/index.ts`

### 3.4 Worker Agent Definitions
- [ ] 3.4.1 Create default worker agent markdown files in `resources/agents/` — Four files: `researcher.md`, `implementer.md`, `reviewer.md`, `planner.md` with YAML frontmatter (tools, model, permissionMode) and focused system prompts
- [ ] 3.4.2 Enhance `src/main/lib/trpc/routers/agent-utils.ts` — `buildAgentsOption()` should include orchestration worker agents from `resources/agents/` in addition to user/project agents

### 3.5 Human-in-the-Loop Gates
- [ ] 3.5.1 Add approval queue to orchestration engine — When a task requires approval (destructive ops, cost threshold exceeded, architecture decisions), pause execution and emit an approval-needed event
- [ ] 3.5.2 Add cost tracking — Track cumulative token cost per orchestration run; pause when configurable limit exceeded (default $2.00)
- [ ] 3.5.3 Add approval sensitivity setting — Three levels: strict (approve every task), normal (approve destructive only), autonomous (approve nothing except cost limits)

## Phase 4: Orchestration UI

### 4.1 Orchestration Panel
- [ ] 4.1.1 Create `src/renderer/features/orchestration/components/orchestration-panel.tsx` — Collapsible panel above message input: shows goal, task graph visualization, task status badges, elapsed time, cost tracker
- [ ] 4.1.2 Create `src/renderer/features/orchestration/components/task-graph-view.tsx` — Visual DAG rendering of task dependencies with status coloring (pending=gray, running=blue, completed=green, failed=red, blocked=yellow)
- [ ] 4.1.3 Create `src/renderer/features/orchestration/components/task-detail.tsx` — Expandable task detail: shows worker type, memory files injected, result summary, error details
- [ ] 4.1.4 Create `src/renderer/features/orchestration/components/approval-dialog.tsx` — Modal for human-in-the-loop approvals: shows task description, risk level, approve/modify/reject buttons

### 4.2 Orchestration Controls
- [ ] 4.2.1 Create `src/renderer/features/orchestration/components/orchestration-controls.tsx` — Pause/Resume/Stop buttons + approval sensitivity selector
- [ ] 4.2.2 Add orchestration toggle to chat header or input area — Button/toggle to enable orchestration mode for the current chat
- [ ] 4.2.3 Add keyboard shortcut: `Cmd+Shift+O` to toggle orchestration mode

### 4.3 Orchestration Atoms & State
- [ ] 4.3.1 Create `src/renderer/features/orchestration/atoms/index.ts` — Jotai atoms: `orchestrationEnabledAtom` (persisted), `orchestrationApprovalLevelAtom` (persisted), `orchestrationCostLimitAtom` (persisted), `orchestrationPanelOpenAtom`
- [ ] 4.3.2 Create `src/renderer/features/orchestration/stores/orchestration-store.ts` — Zustand store for runtime orchestration state: active runs, progress events, approval queue

## Phase 5: Superpowers Integration

### 5.1 Skill Memory Schema
- [ ] 5.1.1 Extend agent/skill parser in `src/main/lib/trpc/routers/agent-utils.ts` — Parse `memory_reads` and `memory_writes` arrays from skill YAML frontmatter
- [ ] 5.1.2 Create `src/main/lib/memory/skill-context.ts` — Given a skill's `memory_reads` list, loads and formats the specified topic files for context injection

### 5.2 Skill ↔ Orchestrator Bridge
- [ ] 5.2.1 Modify `src/main/lib/orchestration/worker-dispatch.ts` — When dispatching a worker that corresponds to a Superpowers skill (brainstorm, plan, execute, review), load the skill's `memory_reads` and inject into worker context
- [ ] 5.2.2 Add post-skill memory capture — After a skill-enhanced worker completes, check `memory_writes` declarations and extract relevant entries from the worker's output for persistence

### 5.3 Superpowers Workflow Orchestration
- [ ] 5.3.1 Create `src/main/lib/orchestration/superpowers-workflow.ts` — Predefined orchestration template for the full Superpowers workflow: brainstorm → plan → execute → review → post-review. Maps each step to appropriate worker type with memory context
- [ ] 5.3.2 Add `/superpowers` slash command — Invokes the full Superpowers workflow through the orchestrator with all five steps

### 5.4 Skills Discovery UI
- [ ] 5.4.1 Create `src/renderer/features/memory/components/skills-panel.tsx` — Skills discovery panel in settings: shows all discovered skills (project + user + plugin), their memory declarations, enable/disable toggles

## Phase 6: Recovery & Safety

### 6.1 Crash Recovery
- [ ] 6.1.1 Add startup check in main process — On app start, detect incomplete orchestration runs (status = 'executing' or 'planning') and present recovery options to user
- [ ] 6.1.2 Add checkpoint validation — Verify checkpoint data integrity before resuming; offer "start fresh" if checkpoint is corrupted

### 6.2 Memory Safety
- [ ] 6.2.1 Add memory vault backup — Before consolidation, create a timestamped backup of the vault in `.2code/memory/.backups/`
- [ ] 6.2.2 Add max memory entries limit — Cap at 500 entries total per vault (across all topic files) to prevent unbounded growth
- [ ] 6.2.3 Add memory import/export — Allow users to export vault as a single markdown file and import from external sources

### 6.3 Orchestration Safety
- [ ] 6.3.1 Add max orchestration depth — Hard limit of 2 levels (orchestrator → workers, no sub-workers)
- [ ] 6.3.2 Add max concurrent workers — Limit to 3 parallel workers to avoid overwhelming the system
- [ ] 6.3.3 Add orchestration timeout — Auto-pause if an orchestration run exceeds 30 minutes without user interaction

## Phase 7: Integration & Polish

### 7.1 Auto-Continuation Bridge
- [ ] 7.1.1 Integrate auto-continuation (from prior spec) as a primitive within the orchestrator — The task extractor becomes one input to the orchestrator's task graph, not a standalone system
- [ ] 7.1.2 Commitment ledger becomes a view of the orchestration task graph — Same data, surfaced in the UI as the existing commitment ledger design

### 7.2 Build Verification
- [ ] 7.2.1 `bun run build` succeeds with no type errors
- [ ] 7.2.2 `bun run db:generate` produces valid migration files
- [ ] 7.2.3 App starts cleanly with new tables (auto-migration)
- [ ] 7.2.4 Memory vault initializes correctly on first project session
- [ ] 7.2.5 Orchestration UI renders without errors in both light and dark themes
