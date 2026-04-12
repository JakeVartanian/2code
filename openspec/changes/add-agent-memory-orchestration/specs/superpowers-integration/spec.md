## ADDED Requirements

### Requirement: Memory-Aware Superpowers Skills

The system SHALL enhance Superpowers skills with memory awareness by supporting `memory_reads` and `memory_writes` fields in skill YAML frontmatter. When a skill declares `memory_reads`, the orchestrator SHALL load the specified topic files and inject their contents into the skill's context. When a skill declares `memory_writes`, the orchestrator SHALL capture the skill's output and persist relevant entries to the specified topic files.

Skills without memory declarations SHALL continue to work as before (no breaking change).

#### Scenario: Brainstorm skill reads rejected approaches
- **WHEN** the user invokes the brainstorm skill (e.g., `/brainstorm` or `@brainstorm`)
- **AND** the brainstorm skill declares `memory_reads: [architecture-decisions, rejected-approaches]`
- **THEN** the orchestrator loads `topics/architecture-decisions.md` and `topics/rejected-approaches.md`
- **AND** injects their contents into the brainstorm skill's context
- **AND** the skill avoids re-suggesting approaches listed in rejected-approaches.md

#### Scenario: Brainstorm skill writes new decision
- **WHEN** the brainstorm skill completes with an approved design decision
- **AND** the brainstorm skill declares `memory_writes: [architecture-decisions]`
- **THEN** the orchestrator extracts the decision from the skill's output
- **AND** writes it to `topics/architecture-decisions.md` in the standard entry format
- **AND** updates `MEMORY.md` index if needed

#### Scenario: Skill without memory declarations
- **WHEN** a skill is invoked that has no `memory_reads` or `memory_writes` in its frontmatter
- **THEN** the skill executes with the default context (MEMORY.md hot tier only, same as any session)
- **AND** no special memory loading or writing occurs

### Requirement: Superpowers Workflow ↔ Orchestrator Integration

The system SHALL map the Superpowers seven-step workflow to the orchestrator's worker dispatch system:

1. **Brainstorm** → Planner worker with full memory context
2. **Plan** → Planner worker; writes approved plan to `topics/current-context.md`
3. **Execute** → Implementer workers dispatched per plan task (parallel where safe)
4. **Review** → Reviewer worker with conventions and debugging patterns
5. **Post-Review** → Orchestrator writes session log and updates memory

The orchestrator SHALL manage transitions between these steps, including checkpoint-and-recover at each transition.

#### Scenario: Full Superpowers workflow execution
- **WHEN** the user invokes the Superpowers workflow for "Add user authentication"
- **THEN** the orchestrator executes the following sequence:
  1. Brainstorm: Planner worker asks clarifying questions, proposes approaches (with memory context), user approves
  2. Plan: Planner worker decomposes approved design into tasks, writes plan to memory
  3. Execute: Implementer workers execute each plan task (with worktree isolation)
  4. Review: Reviewer worker checks all changes against project conventions
  5. Post-Review: Orchestrator writes session log, extracts decisions/patterns, updates memory vault
- **AND** checkpoints are saved between each step
- **AND** the user can pause/resume at any step boundary

#### Scenario: User interrupts during execution
- **WHEN** the user pauses the Superpowers workflow during the Execute step (e.g., after 3 of 7 tasks complete)
- **THEN** the orchestrator saves a checkpoint with: completed tasks, their outputs, remaining tasks
- **AND** when resumed, the orchestrator picks up from task 4 without re-executing tasks 1-3

### Requirement: Skill Discovery and Loading

The system SHALL discover and load skills from three locations (in priority order):
1. Project-level: `<project>/.claude/skills/` and `<project>/.2code/skills/`
2. User-level: `~/.claude/skills/` and `~/.2code/skills/`
3. Plugin-level: Skills bundled with installed Superpowers packages

Skills SHALL be markdown files with YAML frontmatter following the Claude Code Skills format, extended with optional `memory_reads` and `memory_writes` arrays.

The system SHALL provide a Skills panel in settings showing all discovered skills, their memory declarations, and enable/disable toggles.

#### Scenario: Project has custom skills
- **WHEN** a project contains `.2code/skills/deploy-check.md`
- **THEN** the skill appears in the Skills panel and is available for invocation
- **AND** if it declares `memory_reads: [operational-knowledge]`, the orchestrator injects operational knowledge when the skill is invoked

#### Scenario: Conflicting skill names across scopes
- **WHEN** a project-level skill and a user-level skill have the same name
- **THEN** the project-level skill takes priority
- **AND** the user-level skill is shown as "overridden" in the Skills panel

### Requirement: Memory-Driven Context for Direct Chat

Even when the full orchestrator is not active, the system SHALL provide intelligent context loading for direct chat sessions. When a user sends a message in direct chat mode, the system SHALL:

1. Always include MEMORY.md (hot tier) in the system prompt
2. Analyze the user's message for topic relevance
3. If the message references a known topic area (e.g., mentions "auth" and there's an architecture-decisions entry about auth), include a brief pointer: "Relevant memory: see architecture-decisions.md for auth patterns"
4. NOT auto-load full topic files (to avoid context stuffing)

The Claude agent can then use Read tool to load specific topic files as needed.

#### Scenario: User asks about a topic with existing memory
- **WHEN** the user sends "How does our auth work?" in direct chat mode
- **AND** the memory vault contains entries about auth in architecture-decisions.md
- **THEN** the system prompt includes MEMORY.md (which has a one-line pointer to the auth decision)
- **AND** Claude reads the full architecture-decisions.md entry for auth using the Read tool
- **AND** responds with accurate, memory-informed context

#### Scenario: User asks about a topic with no memory
- **WHEN** the user sends "How does our payment system work?" in direct chat mode
- **AND** the memory vault has no entries about payments
- **THEN** the system prompt includes MEMORY.md (no relevant pointers)
- **AND** Claude investigates from scratch using codebase tools
- **AND** the auto-accretion pipeline captures any discoveries for future sessions
