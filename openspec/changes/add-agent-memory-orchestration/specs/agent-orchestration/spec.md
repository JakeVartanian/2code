## ADDED Requirements

### Requirement: Agent Orchestration Manager

The system SHALL provide an orchestration layer that receives complex user goals, decomposes them into a dependency graph of subtasks, delegates each subtask to a specialized worker agent with targeted memory context, and synthesizes results into a coherent outcome. The orchestrator SHALL use Claude Code's native subagent system (`.claude/agents/` markdown files) for worker dispatch.

The orchestrator SHALL be optional — users can continue using direct chat mode. The orchestrator SHALL activate when: (1) the user explicitly requests it (e.g., via a slash command or UI toggle), (2) a Superpowers skill is invoked that requires multi-step execution, or (3) the user's message is detected as requiring multi-step work (configurable sensitivity).

#### Scenario: User sends a complex multi-step request
- **WHEN** the user sends "Refactor the auth system to use JWT with refresh tokens, update all API endpoints, and add tests"
- **AND** the orchestrator is enabled
- **THEN** the orchestrator reads MEMORY.md and relevant topic files (architecture-decisions, conventions)
- **AND** decomposes the request into: (1) Research current auth implementation, (2) Design JWT + refresh token architecture, (3) Implement auth changes, (4) Update API endpoints, (5) Write tests
- **AND** identifies dependencies: task 2 depends on task 1, tasks 3-4 depend on task 2, task 5 depends on tasks 3-4
- **AND** dispatches workers sequentially/parallel according to the dependency graph

#### Scenario: Simple request with orchestrator enabled
- **WHEN** the user sends a simple request like "Fix the typo on line 42 of auth.ts"
- **AND** the orchestrator is enabled
- **THEN** the orchestrator recognizes this as a single-step task
- **AND** handles it directly without spawning workers (no orchestration overhead)

#### Scenario: Orchestrator disabled
- **WHEN** the user sends any message with the orchestrator disabled
- **THEN** the message is handled by the existing direct chat flow (unchanged behavior)

### Requirement: Worker Agent Types

The system SHALL provide four worker agent types, each with restricted tool access and focused system prompts:

1. **Researcher** — Read-only tools (Read, Glob, Grep, WebSearch). Injected with relevant topic files for investigation. Returns structured findings.
2. **Implementer** — Full tool access within the chat's worktree. Injected with architecture decisions, conventions, and the specific plan steps to execute. Returns code changes and test results.
3. **Reviewer** — Read-only tools. Injected with conventions and debugging patterns. Returns structured review with severity-classified issues.
4. **Planner** — Read-only tools. Injected with full hot + warm memory tier. Returns a structured plan with dependency graph and success criteria per task.

Each worker SHALL run in its own context window and return only a structured summary to the orchestrator, keeping the orchestrator's context clean.

#### Scenario: Researcher worker execution
- **WHEN** the orchestrator dispatches a Researcher worker with task "Investigate current auth implementation"
- **THEN** the worker receives: task description + relevant entries from architecture-decisions.md and operational-knowledge.md
- **AND** the worker uses Read, Glob, and Grep to explore the codebase
- **AND** the worker returns a structured summary of findings (file paths, current patterns, identified concerns)
- **AND** the orchestrator receives only the summary, not the worker's full conversation

#### Scenario: Implementer worker with worktree isolation
- **WHEN** the orchestrator dispatches an Implementer worker in a worktree chat
- **THEN** the worker operates within the chat's worktree (isolated from other chats)
- **AND** the worker receives: specific plan steps + architecture decisions + conventions
- **AND** the worker returns: list of files changed, test results, any issues encountered

#### Scenario: Worker failure and recovery
- **WHEN** a worker fails (errors out, produces invalid output, or exceeds max turns)
- **THEN** the orchestrator saves a checkpoint of all completed worker results
- **AND** the orchestrator either retries the failed worker with adjusted context OR escalates to the user
- **AND** no completed worker results are lost

### Requirement: Task Dependency Graph

The orchestrator SHALL decompose complex goals into a directed acyclic graph (DAG) of subtasks with explicit dependencies. Tasks with no dependencies on each other MAY be executed in parallel. Tasks with dependencies SHALL be executed only after all dependencies complete successfully.

The task graph SHALL be stored in the `orchestration_runs` table as JSON and SHALL be visible to the user in the orchestration UI.

#### Scenario: Parallel-eligible tasks
- **WHEN** the task graph contains tasks A and B that have no dependency on each other
- **THEN** the orchestrator MAY dispatch workers for A and B simultaneously
- **AND** task C (which depends on both A and B) waits until both complete

#### Scenario: Dependency chain
- **WHEN** the task graph contains A → B → C (linear dependency)
- **THEN** the orchestrator executes A, waits for completion, then executes B, waits, then C
- **AND** each worker receives the prior worker's results as additional context

### Requirement: Orchestration Checkpointing

The system SHALL checkpoint the orchestration state after each worker completes. The checkpoint SHALL include: all completed worker results, the current position in the task graph, and accumulated memory context. If the app crashes or the user pauses orchestration, it SHALL be resumable from the last checkpoint.

#### Scenario: App crash during orchestration
- **WHEN** the app crashes while worker 3 of 5 is executing
- **THEN** on restart, the system detects an incomplete orchestration run
- **AND** presents the user with options: "Resume from task 3" or "Discard and start over"
- **AND** if resumed, workers 1 and 2's results are loaded from the checkpoint

#### Scenario: User pauses orchestration
- **WHEN** the user clicks "Pause" during orchestration
- **THEN** the current worker is allowed to complete (not aborted mid-stream)
- **AND** the orchestration state is checkpointed
- **AND** the user can resume later from where they left off

### Requirement: Human-in-the-Loop Gates

The orchestrator SHALL require explicit user approval before: (1) executing destructive operations (file deletion, database changes, force push), (2) making architecture decisions that affect the project's memory vault, and (3) spending more than a configurable token/cost threshold on a single orchestration run. The user SHALL be able to configure the approval sensitivity (strict: approve every task, normal: approve destructive only, autonomous: approve nothing).

#### Scenario: Destructive operation detected
- **WHEN** the orchestrator's task graph includes a task that involves `rm -rf`, `DROP TABLE`, or `git push --force`
- **THEN** the orchestrator pauses before dispatching that worker
- **AND** presents the task description and asks the user to approve or modify

#### Scenario: Cost threshold exceeded
- **WHEN** the cumulative token cost of an orchestration run exceeds the user's configured limit (default: $2.00)
- **THEN** the orchestrator pauses and shows: tasks completed, tasks remaining, cost so far, estimated remaining cost
- **AND** the user can approve continuation, modify the plan, or stop

### Requirement: Orchestration UI

The system SHALL provide an orchestration panel in the chat interface showing: the current goal, the task dependency graph (visual), each task's status (pending/running/completed/failed), worker outputs for completed tasks, and controls (pause/resume/stop/approve). The panel SHALL be collapsible and SHALL NOT interfere with normal chat flow.

#### Scenario: User monitors orchestration progress
- **WHEN** an orchestration run is active
- **THEN** the chat interface shows a collapsible panel above the message input
- **AND** the panel displays: goal description, task list with dependency indicators, status badges per task, elapsed time, and cost tracker
- **AND** clicking a completed task expands to show the worker's summary output

#### Scenario: Orchestration completes
- **WHEN** all tasks in the orchestration run complete successfully
- **THEN** the panel shows a completion summary: tasks completed, total time, total cost, memory entries added
- **AND** the orchestrator posts a synthesis message to the chat summarizing what was done
