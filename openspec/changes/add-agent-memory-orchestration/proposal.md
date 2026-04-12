# Change: Add Agent Memory Vault & Orchestration Layer

## Why

2Code's current architecture treats every Claude session as stateless — the agent starts fresh each time with no knowledge of prior sessions, decisions made, mistakes encountered, or the project's evolving context. The existing plan for a "Memory Curator" (DB-stored bullet points capped at 4000 chars) is architecturally insufficient — it produces exactly the kind of overstuffed context injection that ETH Zurich research shows *reduces* task success rates.

Meanwhile, the auto-continuation system from the prior spec is a linear task queue extracted from a single response. What's actually needed is an **orchestrating agent** that understands the full project context, can decompose complex goals into dependency graphs, delegate to specialized workers with targeted context injection, and accrete knowledge automatically across sessions.

Andrej Karpathy's LLM Wiki architecture (April 2026) proved that an LLM-maintained markdown knowledge base with structured indices, bidirectional links, and active maintenance dramatically outperforms both RAG and static context files. Three independent $1B+ projects (Manus, OpenClaw, Claude Code itself) converged on file-based memory. This is the proven pattern.

## What Changes

### 1. Memory Vault (Karpathy-Inspired Knowledge Base)
- **Filesystem-native memory** per project: structured markdown files in `.2code/memory/` within each project directory
- **Three-tier architecture**: Hot (always loaded, max 200 lines), Warm (loaded on demand by topic), Cold (session logs, searchable)
- **Auto-accretion**: Decisions, mistakes, conventions, and rejected approaches captured automatically at session end
- **Active maintenance**: Periodic consolidation (lint) to resolve contradictions, merge duplicates, decay stale entries
- **Five memory categories**: Project Identity, Architecture Decisions, Operational Knowledge, Current Context, Rejected Approaches

### 2. Agent Orchestration Manager
- **Supervisor-Worker pattern** using Claude Code's native subagent system
- **Memory-aware orchestrator**: Reads vault index, selects relevant context per worker, injects only what's needed
- **Task decomposition**: Complex goals broken into dependency graphs with clear success criteria
- **Checkpoint-and-recover**: State saved after each worker completes; failures don't lose prior progress
- **Human-in-the-loop gates**: User approval required for architecture decisions and destructive operations

### 3. Superpowers Integration
- **Skills read from and write to memory**: Brainstorming checks rejected approaches, planning reads architecture decisions
- **Memory-aware skill dispatch**: Orchestrator injects relevant memory context when invoking skills
- **Superpowers workflow maps to orchestration**: brainstorm → plan → execute → review, with memory persistence at each stage
- **Skills declare memory schema**: Each skill specifies what categories it reads and writes

### 4. System Prompt Intelligence (Replaces Dumb Injection)
- **Selective context loading**: Instead of injecting everything, the orchestrator queries the vault and loads only task-relevant memories
- **Index-pointer pattern**: MEMORY.md is a concise index (<200 lines) pointing to detailed topic files loaded on demand
- **Path-scoped rules**: Memory entries tagged with file patterns only load when relevant files are being worked on

## Impact

- **Affected specs**: None existing (new capabilities)
- **Affected code**:
  - `src/main/lib/trpc/routers/claude.ts` — System prompt injection pipeline (lines 2202-2230)
  - `src/main/lib/trpc/routers/index.ts` — Register new routers (memory, orchestration)
  - `src/main/lib/db/schema/index.ts` — New tables for memory index + orchestration state
  - `src/renderer/features/agents/atoms/index.ts` — New atoms for memory/orchestration UI state
  - `src/renderer/features/agents/stores/` — New stores for orchestration runtime
  - `src/renderer/features/agents/main/active-chat.tsx` — Mount memory indicator, orchestration controls
  - `src/main/lib/trpc/routers/agent-utils.ts` — Agent loading enhanced with memory awareness
  - New feature directory: `src/renderer/features/memory/`
  - New feature directory: `src/renderer/features/orchestration/`
  - New main-process directory: `src/main/lib/memory/`
