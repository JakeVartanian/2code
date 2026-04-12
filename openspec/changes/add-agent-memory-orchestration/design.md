# Design: Agent Memory Vault & Orchestration Layer

## Context

2Code is a local-first Electron desktop app wrapping the Claude Code SDK. Users work on projects in isolated git worktrees with Claude in Plan or Agent mode. The existing architecture has:

- A `systemAppend` injection pipeline in `claude.ts` (lines 2202-2230) that already loads AGENTS.md
- A message queue system (`QueueProcessor` + `useMessageQueueStore`) for sequential message delivery
- A native subagent system via `.claude/agents/` markdown files with YAML frontmatter
- Jotai (UI atoms) + Zustand (runtime stores) + React Query (server state) for state management
- SQLite (Drizzle ORM) for persistence with auto-migration on app startup

**Stakeholders**: Solo developer (Jake), end users of 2Code who want Claude to "just know" their project

**Key constraints**:
- Must not degrade responsiveness or break parallel workspace operation (CLAUDE.md core principle)
- Auth flow files are off-limits (DO NOT MODIFY)
- Memory must be portable (travel with project, human-readable, git-committable)
- Must work with Anthropic API, OpenRouter, and Ollama backends

## Goals / Non-Goals

### Goals
- Give Claude deep, persistent project context that compounds across sessions
- Enable end-to-end task execution with minimal user intervention
- Integrate Superpowers workflow (brainstorm → plan → execute → review) with memory persistence
- Auto-capture knowledge without requiring manual curation
- Keep the system simple enough to ship incrementally

### Non-Goals
- Vector database or embedding infrastructure (not needed at project scale)
- Cross-project knowledge sharing (per-project isolation is the right default)
- Real-time multi-user collaboration on memory
- Replacing AGENTS.md or CLAUDE.md (complementary, not competitive)

## Architecture Overview

```
                    +-----------------------+
                    |     User Request      |
                    +-----------+-----------+
                                |
                    +-----------v-----------+
                    |    Orchestrator Agent  |
                    |  (Supervisor Pattern)  |
                    |                       |
                    |  1. Read MEMORY.md    |
                    |  2. Query topic files |
                    |  3. Decompose task    |
                    |  4. Dispatch workers  |
                    |  5. Synthesize results|
                    |  6. Update memory     |
                    +-----------+-----------+
                         |    |    |
              +----------+    |    +----------+
              |               |               |
     +--------v------+ +-----v-------+ +-----v-------+
     |   Researcher  | | Implementer | |  Reviewer   |
     |  (read-only)  | | (worktree)  | | (read-only) |
     |               | |             | |             |
     | Gets: relevant| | Gets: arch  | | Gets: style |
     | topic files   | | decisions + | | conventions |
     | for research  | | plan steps  | | + patterns  |
     +---------------+ +-------------+ +-------------+
```

## Decision 1: Filesystem-Native Memory (Karpathy Pattern)

**Decision**: Memory stored as markdown files in `<project>/.2code/memory/`, NOT in SQLite rows.

**Alternatives considered**:
- SQLite `agent_memory` table (from prior spec) — Opaque to users, can't git-commit, no linking, capped at 4000 chars
- Vector database — Overkill for project-scale knowledge (<1000 files), adds infrastructure dependency
- localStorage/Jotai atoms — Not portable, lost on app reinstall

**Rationale**:
- Three $1B+ projects (Manus, OpenClaw, Claude Code) converged on filesystem-based memory
- LLMs are pretrained on massive amounts of filesystem content; they already know how to navigate markdown
- Users can read, edit, and git-commit their project's memory
- Karpathy's 400K-word wiki operated without any vector DB, using only self-maintained indices
- ETH Zurich found overstuffed context files reduce task success; filesystem approach enables selective loading

### Memory Directory Structure

```
<project>/.2code/memory/
  MEMORY.md                        # HOT: Always loaded (max 200 lines)
                                   # Concise index pointing to topic files
  topics/
    architecture-decisions.md      # WARM: Loaded on demand
    rejected-approaches.md         # WARM: Prevents re-suggesting failed ideas
    debugging-patterns.md          # WARM: Known bugs and solutions
    conventions.md                 # WARM: Discovered (not just declared) patterns
    operational-knowledge.md       # WARM: Environment quirks, gotchas
  sessions/
    2026-04-12-auth-refactor.md   # COLD: Session log, searchable
    2026-04-11-sidebar-fix.md     # COLD: Session log, searchable
  log.md                          # Chronological changelog (append-only)
```

### Memory Entry Format

```markdown
---
created: 2026-04-12T14:30:00Z
category: architecture-decision
confidence: high
source: chat-abc123
tags: [auth, oauth, security]
status: active
last_referenced: 2026-04-12T14:30:00Z
---

## Decision: Use httpOnly cookies for JWT storage

**Context**: Security audit requirement
**Decision**: JWT tokens stored in httpOnly cookies, not localStorage
**Rejected**: localStorage (XSS vulnerability), sessionStorage (tab isolation)
**Rationale**: httpOnly cookies immune to XSS, auto-sent with requests
```

### Three-Tier Architecture

| Tier | Temperature | Storage | Loading | Content |
|------|-------------|---------|---------|---------|
| **Hot** | Always in context | `MEMORY.md` | Every session start | Index + most critical facts (max 200 lines) |
| **Warm** | Loaded on demand | `topics/*.md` | When orchestrator determines relevance | Detailed topic files (max 500 lines each) |
| **Cold** | Searchable only | `sessions/*.md` + `log.md` | On explicit query | Session logs, changelog, historical context |

### SQLite Index Layer (Phase 2)

When the vault grows beyond ~100 files, add a lightweight SQLite FTS5 index for search:
```sql
CREATE VIRTUAL TABLE memory_search USING fts5(
  file_path, title, content, category, tags,
  tokenize='porter unicode61'
);
```
This is a search optimization, NOT the source of truth. Files remain canonical.

## Decision 2: Supervisor-Worker Orchestration

**Decision**: Hierarchical orchestration using Claude Code's native subagent system, NOT a custom agent framework.

**Alternatives considered**:
- LangGraph-style state machine — Over-engineered for a desktop app; rigid conditional edges limit adaptability
- CrewAI-style role-based system — Requires Python runtime; we need TypeScript/Electron-native
- Flat multi-agent spawning — Context explosion; no clean coordination

**Rationale**:
- Claude Code already has a battle-tested subagent system (`.claude/agents/` markdown files)
- Subagents run in their own context windows and return summaries, keeping the orchestrator clean
- The `agents` option in the SDK already supports tool restrictions, model selection, and permission modes
- Adding a custom framework when the platform has one is the wrong abstraction

### Orchestrator Flow

```
1. USER REQUEST arrives
2. ORCHESTRATOR reads MEMORY.md (hot tier)
3. ORCHESTRATOR queries relevant topic files based on request semantics
4. ORCHESTRATOR decomposes into subtasks with:
   - Clear success criteria per task
   - Dependency ordering (which tasks block others)
   - Memory context selection (which topic files each worker needs)
5. For each subtask:
   a. Select worker type (Researcher, Implementer, Reviewer)
   b. Inject: task description + relevant memory entries + Superpowers skill if applicable
   c. Worker executes and returns structured result
   d. CHECKPOINT: Save worker result to orchestration state
   e. If failure: Retry with adjusted context OR escalate to user
6. ORCHESTRATOR synthesizes all worker results
7. ORCHESTRATOR runs memory accretion:
   - Extract decisions, mistakes, patterns from session
   - Deduplicate against existing entries
   - Write to appropriate topic files
   - Update MEMORY.md index if needed
8. ORCHESTRATOR presents final result to user
```

### Worker Types

| Worker | Tools | Memory Context | Purpose |
|--------|-------|---------------|---------|
| **Researcher** | Read, Glob, Grep, WebSearch | Relevant topic files | Investigate before implementing |
| **Implementer** | All (in worktree) | Architecture decisions + plan | Write code following established patterns |
| **Reviewer** | Read, Glob, Grep | Conventions + debugging patterns | Check work against project standards |
| **Planner** | Read, Glob, Grep | Full hot + warm tier | Decompose complex tasks into steps |

### Orchestration State (SQLite)

```sql
CREATE TABLE orchestration_runs (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  sub_chat_id TEXT NOT NULL,
  goal TEXT NOT NULL,                    -- Original user request
  status TEXT DEFAULT 'planning',        -- planning|executing|reviewing|completed|failed|paused
  task_graph TEXT,                       -- JSON: decomposed tasks with dependencies
  memory_context TEXT,                   -- JSON: which topic files were loaded
  checkpoint TEXT,                       -- JSON: completed worker results
  created_at INTEGER,
  updated_at INTEGER,
  completed_at INTEGER
);

CREATE TABLE orchestration_tasks (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES orchestration_runs(id) ON DELETE CASCADE,
  worker_type TEXT NOT NULL,             -- researcher|implementer|reviewer|planner
  description TEXT NOT NULL,
  status TEXT DEFAULT 'pending',         -- pending|blocked|running|completed|failed|skipped
  depends_on TEXT,                       -- JSON array of task IDs
  memory_files TEXT,                     -- JSON: which topic files to inject
  result TEXT,                           -- JSON: worker's structured output
  error TEXT,                            -- Error message if failed
  started_at INTEGER,
  completed_at INTEGER
);
```

## Decision 3: Superpowers as Memory-Aware Skills

**Decision**: Integrate with the Superpowers framework by making skills memory-aware, NOT by building a separate plugin system.

**Alternatives considered**:
- Custom plugin system — Duplicates what Superpowers already does; fragmentation
- Static skill injection — No memory awareness; same context-stuffing problem

**Rationale**:
- Superpowers is already built on Claude Code's native Skills system (SKILL.md files)
- 93K+ GitHub stars, accepted into Anthropic's plugin marketplace
- Its workflow (brainstorm → plan → execute → review) maps directly to our orchestrator's worker types
- Skills just need to declare what memory they read/write; the orchestrator handles injection

### Memory-Aware Skill Format

```markdown
---
name: brainstorm
description: Socratic brainstorming with full project context
memory_reads: [architecture-decisions, rejected-approaches, conventions]
memory_writes: [architecture-decisions]
---

Before proposing any approach, consult the project's architecture decisions
and rejected approaches. Do NOT suggest approaches that appear in
rejected-approaches.md unless you have a specific reason to revisit them.

After the brainstorming session, write any approved decisions to
architecture-decisions.md in the standard entry format.
```

### Superpowers Workflow ↔ Orchestrator Mapping

| Superpowers Step | Orchestrator Worker | Memory Interaction |
|-----------------|--------------------|--------------------|
| Brainstorm | Planner worker | Reads: architecture-decisions, rejected-approaches. Writes: architecture-decisions |
| Write Plan | Planner worker | Reads: all warm tier. Writes: current-context (plan) |
| Execute Plan | Implementer workers (parallel per task) | Reads: architecture-decisions, conventions, plan |
| Code Review | Reviewer worker | Reads: conventions, debugging-patterns |
| Post-Review | Orchestrator | Writes: session log, updates MEMORY.md index |

## Decision 4: Auto-Accretion via Session Hooks

**Decision**: Memory auto-accretes at session completion via a main-process hook, NOT via prompt injection asking Claude to maintain memory.

**Alternatives considered**:
- Prompt injection ("after each response, update your memory files") — Wastes tokens, unreliable, conflicts with task execution
- Manual curation only — Defeats the purpose; memory stays empty
- Claude Code's auto-dream model — Requires 5+ sessions + 24h cooldown; too slow for active development

**Rationale**:
- Session-end hook runs AFTER the main work is done; zero interference with task execution
- Can use a lightweight LLM call (Haiku) for extraction — cheap and fast
- Deduplication and privacy filtering happen in TypeScript, not in the LLM
- Users see memory growing organically without any manual effort

### Accretion Pipeline

```
Session Completes
       |
       v
[Extract Phase] — Haiku call with session transcript (last N messages)
  Prompt: "Extract decisions, mistakes, patterns, conventions, rejected approaches.
           Return as structured JSON."
       |
       v
[Deduplicate Phase] — TypeScript
  - SHA-256 hash of normalized content
  - Fuzzy match against existing entries (>80% similarity = skip)
  - Strip secrets (API keys, tokens, passwords)
       |
       v
[Write Phase] — TypeScript
  - Append entries to appropriate topic files
  - Update MEMORY.md index if new topics added
  - Append session summary to sessions/YYYY-MM-DD-<slug>.md
  - Append to log.md
       |
       v
[Consolidation Phase] — Periodic (every 10 sessions or weekly)
  - Haiku call: "Review these topic files for contradictions, staleness, duplicates"
  - Resolve conflicts, merge entries, archive stale items
  - Ensure MEMORY.md stays under 200 lines
```

## Decision 5: System Prompt Intelligence

**Decision**: Replace naive full-injection with selective, index-driven context loading.

**Current state** (claude.ts lines 2202-2230):
```typescript
// AGENTS.md injected in full (or truncated for Ollama)
systemAppend += agentsMdContent
```

**New approach**:
```typescript
// 1. Always load MEMORY.md (hot tier, max 200 lines)
const memoryIndex = await readMemoryIndex(projectPath)
if (memoryIndex) {
  systemAppend += `\n\n# Project Memory\n${memoryIndex}`
}

// 2. Orchestrator determines which topic files to load based on the user's request
// This happens at orchestration time, NOT at system prompt construction
// Workers get targeted context, not everything

// 3. AGENTS.md still loaded as before (unchanged)
systemAppend += agentsMdContent
```

**Why this is better**:
- Hot tier (MEMORY.md) is always small and relevant — max 200 lines
- Topic files loaded selectively by the orchestrator, not injected wholesale
- Follows the proven pattern from Claude Code's own auto-memory system
- Avoids the ETH Zurich problem of overstuffed context reducing performance

## Risks / Trade-offs

| Risk | Severity | Mitigation |
|------|----------|------------|
| Memory files bloat over time | Medium | 200-line cap on MEMORY.md, 500-line cap per topic, temporal decay |
| Auto-accretion captures noise | Medium | Confidence scoring, deduplication, periodic consolidation |
| Orchestrator adds latency | High | Orchestration is optional; users can still chat directly. Orchestrator only activates for complex tasks |
| Memory conflicts across worktrees | Low | Memory lives in project root, not worktree. All chats for a project share the same vault |
| Superpowers version drift | Low | Skills are markdown files; version-pinned via git |
| Haiku extraction cost | Low | ~$0.001 per session-end extraction; negligible |

## Migration Plan

**From existing users**: No migration needed. Memory vault is additive — `.2code/memory/` doesn't exist yet. First session creates the directory.

**From prior spec's `agentMemory` table**: If anyone implemented the prior spec's DB-based memory, provide a one-time migration script that reads `agentMemory` rows and writes them as entries in the appropriate topic files.

**Rollback**: Delete `.2code/memory/` directory. Remove memory injection from `systemAppend`. All changes are additive and independently revertible.

## Open Questions

1. **Should `.2code/memory/` be gitignored by default?** Argument for: session logs may contain sensitive info. Argument against: memory is most valuable when shared across team members. **Proposed**: gitignore `sessions/` but commit `topics/` and `MEMORY.md`.

2. **Should the orchestrator require explicit activation or be the default?** Proposed: Default to direct chat (current behavior). Orchestrator activates when user invokes a Superpowers skill or sends a message that the system detects as multi-step.

3. **Max depth for orchestrator delegation?** Proposed: 2 levels (orchestrator → workers). Workers cannot spawn sub-workers. This matches Claude Code's native constraint.

4. **Should memory consolidation run automatically or be user-triggered?** Proposed: Auto after 10 sessions, with a manual "Consolidate Memory" button in settings.
