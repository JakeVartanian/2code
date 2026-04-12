## ADDED Requirements

### Requirement: Project Memory Vault

The system SHALL maintain a filesystem-native memory vault per project at `<project>/.2code/memory/` containing structured markdown files organized into three tiers: Hot (always loaded), Warm (loaded on demand), and Cold (searchable only).

The Hot tier SHALL consist of a single `MEMORY.md` file no larger than 200 lines, serving as a concise index pointing to detailed topic files. This file SHALL be loaded into the system prompt at every session start.

The Warm tier SHALL consist of topic files in `topics/` directory, each no larger than 500 lines, organized by category: architecture-decisions, rejected-approaches, debugging-patterns, conventions, and operational-knowledge.

The Cold tier SHALL consist of session logs in `sessions/` directory and an append-only `log.md` changelog.

#### Scenario: First session on a project with no memory
- **WHEN** a Claude session starts for a project with no `.2code/memory/` directory
- **THEN** the system creates the directory structure with an empty `MEMORY.md` containing a header and category placeholders
- **AND** the system prompt includes the empty memory header (minimal token cost)

#### Scenario: Session with existing memory
- **WHEN** a Claude session starts for a project with an existing memory vault
- **THEN** the system reads `MEMORY.md` (max 200 lines) and injects it into the system prompt
- **AND** topic files are NOT loaded into the system prompt (they are loaded on demand by the orchestrator)

#### Scenario: Memory vault exceeds size limits
- **WHEN** `MEMORY.md` exceeds 200 lines during auto-accretion
- **THEN** the system moves older/less-referenced entries to appropriate topic files
- **AND** replaces them with one-line pointers in `MEMORY.md`
- **AND** `MEMORY.md` is brought back under 200 lines

### Requirement: Memory Entry Format

Each memory entry SHALL be a markdown section with optional YAML frontmatter containing: `created` (ISO 8601 timestamp), `category` (one of: project-identity, architecture-decision, operational-knowledge, current-context, rejected-approach, convention, debugging-pattern), `confidence` (low/medium/high), `source` (chat ID or session reference), `tags` (array of strings), `status` (active/deprecated/archived), and `last_referenced` (ISO 8601 timestamp).

The body SHALL be human-readable markdown with structured fields appropriate to the category.

#### Scenario: Architecture decision entry
- **WHEN** the auto-accretion pipeline extracts an architecture decision
- **THEN** the entry includes: Context (why the decision was needed), Decision (what was chosen), Rejected alternatives (what was considered and why it was rejected), and Rationale (why the chosen approach wins)
- **AND** the entry is written to `topics/architecture-decisions.md`

#### Scenario: Rejected approach entry
- **WHEN** an approach is tried and abandoned during a session
- **THEN** the auto-accretion pipeline creates an entry in `topics/rejected-approaches.md`
- **AND** the entry includes: What was attempted, Why it failed, and What was done instead
- **AND** future sessions can query this file to avoid re-suggesting the same approach

### Requirement: Auto-Accretion Pipeline

The system SHALL automatically extract knowledge from completed Claude sessions and persist it to the memory vault without manual user intervention. Extraction SHALL run as a post-session hook in the main process using a lightweight LLM call (Haiku-class model).

The pipeline SHALL: (1) extract decisions, mistakes, patterns, conventions, and rejected approaches from the session transcript, (2) deduplicate against existing entries using normalized content hashing and fuzzy matching (>80% similarity threshold), (3) strip sensitive content (API keys, tokens, passwords, credentials), (4) write entries to appropriate topic files, (5) update `MEMORY.md` index if new topics were added, (6) append a session summary to `sessions/YYYY-MM-DD-<slug>.md`, and (7) append to `log.md`.

#### Scenario: Session produces new architecture decision
- **WHEN** a session completes where the user and Claude decided to use httpOnly cookies for JWT storage
- **THEN** the accretion pipeline extracts this as a `category: architecture-decision` entry
- **AND** writes it to `topics/architecture-decisions.md` with full context, decision, rejected alternatives, and rationale
- **AND** updates `MEMORY.md` index if this is the first architecture decision
- **AND** appends a session summary to `sessions/`

#### Scenario: Duplicate knowledge detected
- **WHEN** the accretion pipeline extracts a fact that is >80% similar to an existing entry
- **THEN** the duplicate is discarded
- **AND** the existing entry's `last_referenced` timestamp is updated

#### Scenario: Session produces no extractable knowledge
- **WHEN** a session completes with only trivial exchanges (greetings, clarifications, no decisions or code changes)
- **THEN** the accretion pipeline writes only a minimal session log
- **AND** no topic files are modified

### Requirement: Memory Consolidation

The system SHALL periodically consolidate the memory vault to resolve contradictions, merge duplicate entries, archive stale entries, and ensure `MEMORY.md` stays under 200 lines. Consolidation SHALL run automatically after every 10 sessions and SHALL be manually triggerable via a UI button.

#### Scenario: Contradictory entries detected
- **WHEN** consolidation finds two entries that contradict each other (e.g., "use JWT" and "use session cookies")
- **THEN** the newer entry is kept and the older entry is marked `status: deprecated` with a note referencing the superseding entry

#### Scenario: Stale entries detected
- **WHEN** an entry has not been referenced in 90 days
- **THEN** the entry is moved from its topic file to a `topics/archived/` subdirectory
- **AND** its pointer in `MEMORY.md` is removed

### Requirement: Memory UI

The system SHALL provide a Memory panel accessible from the chat header and project settings that displays the current memory vault contents organized by category. Users SHALL be able to: view all entries grouped by topic file, manually add/edit/delete entries, pin entries (always included in hot tier), trigger manual consolidation, and view session history.

#### Scenario: User views memory panel
- **WHEN** the user clicks the memory indicator in the chat header
- **THEN** a panel opens showing the MEMORY.md index and links to each topic file
- **AND** each entry shows: content preview, category badge, confidence indicator, last referenced date

#### Scenario: User manually adds a memory
- **WHEN** the user clicks "Add Memory" and enters content with a category
- **THEN** the entry is written to the appropriate topic file with `source: user` and `confidence: high`
- **AND** `MEMORY.md` index is updated if needed

### Requirement: Memory Portability

The memory vault SHALL be stored within the project directory (not in app data) so it travels with the project when cloned, forked, or moved. Session logs (`sessions/`) SHALL be gitignored by default. Topic files (`topics/`) and `MEMORY.md` SHALL NOT be gitignored by default.

#### Scenario: Project cloned by team member
- **WHEN** a team member clones a project with an existing `.2code/memory/` directory
- **THEN** they receive all topic files and the MEMORY.md index
- **AND** they do NOT receive session logs (gitignored)
- **AND** their 2Code instance loads the shared memory on first session

#### Scenario: Project moved to different machine
- **WHEN** a project directory is copied or moved to a different machine
- **THEN** the memory vault is intact and functional without any migration step
