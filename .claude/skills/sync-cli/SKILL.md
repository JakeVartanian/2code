---
name: sync-cli
description: Auto-detect latest Claude CLI/SDK features and plan their integration into 2Code
---

# 2Code CLI Sync — Feature Gap Detection & Integration Planning

You are an orchestrator for a 4-agent pipeline that discovers what the latest Claude CLI and Agent SDK support, compares it against what 2Code currently implements, and produces a prioritized integration plan. This skill is designed to be run repeatedly — it always fetches the latest information.

## Phase 1: Discovery (run these 2 agents in PARALLEL)

### Agent 1: CLI Changelog Scout (subagent_type: general-purpose)

**Prompt for this agent:**
```
You are a research agent. Your job is to discover every feature, option, and capability available in the latest Claude Code CLI and @anthropic-ai/claude-agent-sdk.

DO THE FOLLOWING STEPS IN ORDER:

1. **Web search** for the latest Claude Code changelog and release notes:
   - Search: "Claude Code CLI changelog 2026 latest features"
   - Search: "claude-agent-sdk TypeScript SDK new options effort thinking"
   - Search: "Claude Code new tools agent teams compaction 2026"
   - Fetch the GitHub changelog: https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md
   - Fetch the SDK reference: https://platform.claude.com/docs/en/agent-sdk/typescript

2. **Extract a complete feature inventory** organized by category:

   a) **SDK query() Options** — every parameter the Options type accepts:
      - Model/effort: model, effort (low/medium/high/max), fallbackModel
      - Thinking: thinking (ThinkingConfig: adaptive/enabled/disabled), maxThinkingTokens (deprecated)
      - Session: resume, resumeSessionAt, forkSession, continue, sessionId, persistSession
      - Permissions: permissionMode, allowDangerouslySkipPermissions, canUseTool, allowedTools, disallowedTools
      - Tools: tools, mcpServers, strictMcpConfig
      - Agents: agent, agents
      - Budget: maxBudgetUsd, maxTurns
      - Features: enableFileCheckpointing, promptSuggestions, outputFormat, sandbox
      - Settings: settingSources, systemPrompt, betas, plugins, hooks
      - Process: env, cwd, pathToClaudeCodeExecutable, executable, executableArgs, spawnClaudeCodeProcess
      - Debug: debug, debugFile, stderr
      - Streaming: includePartialMessages
      List the FULL type signature and default value for each.

   b) **Query object methods** — runtime methods on the Query instance:
      - setPermissionMode, setModel, setMaxThinkingTokens
      - initializationResult, supportedCommands, supportedModels, supportedAgents
      - mcpServerStatus, accountInfo
      - reconnectMcpServer, toggleMcpServer, setMcpServers
      - streamInput, stopTask, interrupt, rewindFiles, close
      List each with its signature.

   c) **Environment variables** — all CLAUDE_CODE_* and related env vars:
      - CLAUDE_CODE_ENABLE_TASKS, CLAUDE_CODE_NO_FLICKER, CLAUDE_CODE_SUBPROCESS_ENV_SCRUB
      - CLAUDE_STREAM_IDLE_TIMEOUT_MS, MCP_CONNECTION_NONBLOCKING
      - CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS
      - CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS
      - MAX_THINKING_TOKENS
      - Any new ones from recent changelogs

   d) **Message types** — all SDKMessage types the stream can emit:
      - stream_event subtypes (text, tool_use, thinking, etc.)
      - system subtypes (init, status, compact_boundary)
      - assistant message content block types
      - result message fields
      - Any new message types added recently

   e) **New features** from the last ~3 months of changelogs:
      - Agent Teams (experimental)
      - Plugin system enhancements
      - Sandbox mode
      - Hook system (PreToolUse, PostToolUse, CwdChanged, FileChanged, PermissionDenied, TaskCreated)
      - PowerShell tool
      - Structured outputs
      - File checkpointing / rewind
      - Compaction API improvements
      - /effort command and effort frontmatter in skills
      - Any other notable features

3. **Output format**: Return a structured markdown document titled "## CLI Feature Inventory" with sections for each category above. For each feature, include:
   - Feature name
   - Type signature or value format
   - Default value
   - Which CLI version introduced it (if found)
   - Brief description of what it does
```

### Agent 2: 2Code Codebase Auditor (subagent_type: Explore)

**Prompt for this agent:**
```
You are auditing the 2Code Electron desktop app to catalog every Claude CLI/SDK feature it currently implements. Be VERY thorough — search every relevant file.

SCAN THESE FILES AND AREAS:

1. **SDK Integration** — `src/main/lib/trpc/routers/claude.ts`:
   - What input parameters does the chat subscription accept? (the z.object schema)
   - What SDK query options are actually constructed and passed?
   - What message types does the transformer handle?
   - What error categories are handled?
   - What session management features are used (resume, fork, rollback)?

2. **Claude Environment** — `src/main/lib/claude/env.ts`:
   - What env vars are set/stripped?
   - What does buildClaudeEnv() support?

3. **Message Transform** — `src/main/lib/claude/transform.ts`:
   - What message/event types does it handle?
   - What content block types does it process (text, tool_use, thinking)?
   - What system events does it handle (init, compacting, compact_boundary)?

4. **Types** — `src/main/lib/claude/types.ts`:
   - What UIMessageChunk types exist?
   - What metadata is tracked?

5. **Renderer Transport** — `src/renderer/features/agents/lib/ipc-chat-transport.ts`:
   - What parameters does it send to the tRPC subscription?
   - How does it read settings/atoms to build the request?

6. **Settings & Atoms** — `src/renderer/lib/atoms/index.ts` and `src/renderer/features/agents/atoms/`:
   - What Claude-related settings exist (model, thinking, effort, etc.)?
   - What's persisted to localStorage?

7. **Settings UI** — `src/renderer/components/dialogs/settings-tabs/`:
   - What Claude configuration is exposed in the UI?
   - What settings tabs exist?

8. **Models** — `src/renderer/features/agents/lib/models.ts`:
   - What models are listed?
   - How are model IDs mapped?

9. **Package dependencies** — `package.json`:
   - What version of @anthropic-ai/claude-agent-sdk is installed?

OUTPUT FORMAT: Return a structured markdown document titled "## 2Code Feature Inventory" with:

For EACH feature found:
- Feature name
- Status: "Full" | "Partial" | "Hard-coded" | "UI missing"
- File locations (path:line)
- Current implementation details (what value is passed, how it's configured)
- Any limitations or hard-coded values

Organize by category:
- SDK Options Used
- SDK Options NOT Used (you can infer from reading the query options construction)
- Environment Variables Set
- Message Types Handled
- Settings/UI Exposed
- Models Supported
```

## Phase 2: Gap Analysis (run AFTER both Phase 1 agents complete)

### Agent 3: Gap Analyzer (subagent_type: general-purpose)

**Prompt for this agent (include the outputs from Agent 1 and Agent 2 as context):**
```
You have two inventories:

1. **CLI Feature Inventory** — everything available in the latest Claude CLI / Agent SDK
2. **2Code Feature Inventory** — everything 2Code currently implements

Your job is to produce a precise GAP ANALYSIS.

For EACH feature in the CLI inventory:
1. Check if it exists in the 2Code inventory
2. Classify it:
   - **Missing**: Feature exists in CLI but 2Code has zero support
   - **Partial**: 2Code has some support but it's incomplete (e.g., hard-coded value, no UI, deprecated API used)
   - **Full**: 2Code fully supports this feature
   - **N/A**: Feature doesn't apply to a desktop wrapper (e.g., terminal rendering, SSH mode)

3. For Missing and Partial features, assign:
   - **Priority**: Critical / High / Medium / Low
     - Critical: Breaks functionality or uses deprecated APIs that will stop working
     - High: Major user-facing feature that competitors likely support
     - Medium: Useful enhancement that improves the experience
     - Low: Nice-to-have, internal optimization, or edge case
   - **Complexity**: Low (1-2 files, <50 lines) / Medium (3-5 files, <200 lines) / High (5+ files, architectural change)
   - **Quick win?**: Yes if Priority >= Medium AND Complexity <= Medium

OUTPUT FORMAT:

## Gap Analysis Summary
- Total features audited: N
- Full support: N
- Partial support: N
- Missing: N
- N/A: N

## Feature Gap Matrix
| # | Feature | CLI Status | 2Code Status | Priority | Complexity | Quick Win? |
|---|---------|-----------|-------------|----------|------------|------------|
| 1 | Effort levels | GA option | Missing | Critical | Medium | Yes |
| 2 | ThinkingConfig | Replaces maxThinkingTokens | Partial (deprecated API) | Critical | Low | Yes |
| ... |

## Detailed Gaps (Missing & Partial only)

### Gap 1: [Feature Name]
- **CLI**: [What the CLI supports]
- **2Code**: [Current state — what's missing or broken]
- **Impact**: [Why users care]
- **Files affected**: [List of files that need changes]
- **Dependencies**: [Other gaps this depends on or blocks]
```

## Phase 3: Implementation Planning (run AFTER Agent 3 completes)

### Agent 4: Implementation Planner (subagent_type: general-purpose)

**Prompt for this agent (include the output from Agent 3 as context):**
```
You have a gap analysis of features missing from 2Code. Your job is to create CONCRETE implementation plans for each gap, prioritized by the gap analysis.

For each gap (ordered by priority, then by quick-win status):

1. **Read the relevant 2Code source files** to understand the current implementation pattern
2. **Design the change** following existing patterns:
   - New atoms go in src/renderer/lib/atoms/index.ts (follow existing naming: camelCase + Atom suffix, atomWithStorage for persistence)
   - New tRPC input fields go in the z.object() schema in claude.ts
   - New SDK options go in the queryOptions construction in claude.ts
   - New UI settings go in the appropriate settings tab
   - New message types go in types.ts and transform.ts
3. **Write a code sketch** — not full code, but enough to show EXACTLY what changes:
   - The atom definition
   - The tRPC schema addition
   - The queryOptions line
   - The settings UI component (describe, don't full-implement)

OUTPUT FORMAT:

# 2Code CLI Sync — Implementation Plans

## Executive Summary
[2-3 sentences: how far behind, what to prioritize, estimated total effort]

## Quick Wins (do these first)
### [Feature Name]
- **What**: [1 sentence]
- **Why**: [User impact]
- **Changes**:
  - `file.ts:line` — [what to change]
  - `file.ts:line` — [what to change]
- **Code sketch**:
  ```typescript
  // In src/renderer/lib/atoms/index.ts
  export const effortLevelAtom = atomWithStorage<'low' | 'medium' | 'high' | 'max'>(
    'preferences:effort-level',
    'high'
  )
  ```
  ```typescript
  // In src/main/lib/trpc/routers/claude.ts — input schema
  effort: z.enum(['low', 'medium', 'high', 'max']).optional(),
  ```
  ```typescript
  // In queryOptions construction
  ...(input.effort && { effort: input.effort }),
  ```
- **Scope**: X files, ~Y lines

## Major Features (plan carefully)
[Same format but more detail on architectural decisions]

## Future Considerations (track but don't implement yet)
[Features that need more thought or aren't stable yet]
```

## Orchestration Protocol

When this skill is invoked, follow this EXACT sequence:

### Step 1: Launch Phase 1
Launch Agent 1 (CLI Changelog Scout) and Agent 2 (2Code Codebase Auditor) **simultaneously** using the Agent tool. Both are independent research tasks.

### Step 2: Collect Phase 1 Results
Wait for both agents to complete. Store their outputs.

### Step 3: Launch Phase 2
Launch Agent 3 (Gap Analyzer) with both Phase 1 outputs embedded in its prompt context. This agent compares the two inventories.

### Step 4: Launch Phase 3
Launch Agent 4 (Implementation Planner) with the Phase 2 output. This agent reads source files and produces concrete plans.

### Step 5: Synthesize Final Report
Combine all outputs into a single report with this structure:

```markdown
# 2Code <-> Claude CLI Sync Report
Generated: [date]
CLI Version Audited: [version from changelog]
SDK Version in 2Code: [from package.json]

## Executive Summary
[From Agent 4]

## Feature Gap Matrix
[From Agent 3]

## Implementation Plans
[From Agent 4, ordered by priority]

## Raw Inventories
<details>
<summary>CLI Feature Inventory</summary>
[Agent 1 output]
</details>

<details>
<summary>2Code Feature Inventory</summary>
[Agent 2 output]
</details>
```

## Important Notes

- This skill is READ-ONLY. It produces analysis and plans, never writes code.
- Always fetch the LATEST changelog via web search — never rely on cached/hardcoded knowledge.
- The 2Code audit must be fresh each run — read actual source files, don't assume.
- Focus on SDK `query()` Options since that's the primary integration surface for 2Code.
- Flag deprecated APIs that 2Code still uses (e.g., `maxThinkingTokens` → `thinking`).
- The output should be actionable enough to create OpenSpec change proposals from.
