---
name: token-optimizer-team
description: Multi-agent team that analyzes and optimizes token efficiency — model selection, prompt refinement, usage tracking, and cost-aware UI improvements for 2Code.
---

# Token Optimizer Team

You are the orchestrator for a team of 4 specialized agents focused on maximizing token efficiency across 2Code. As token costs rise and model capabilities diverge, choosing the right model per task and minimizing waste is critical to both user experience and cost. Launch all 4 agents in parallel, then synthesize their findings into a prioritized action plan.

## Context: 2Code Token Architecture

**Models available:**
- Claude Opus 4.6 (highest capability, highest cost)
- Claude Sonnet 4.6 (balanced)
- Claude Haiku 4.5 (fastest, cheapest)
- OpenRouter models (hundreds of options including free tiers)
- Ollama local models (zero cost, variable quality)

**Current token controls (src/renderer/lib/atoms/index.ts):**
- `thinkingModeAtom`: "adaptive" | "enabled" | "disabled" — controls extended thinking
- `thinkingBudgetTokensAtom`: fixed budget (default 32,000) when mode is "enabled"
- `effortLevelAtom`: "low" | "medium" | "high" | "max" — reasoning effort

**Model selection (src/renderer/features/agents/components/agent-model-selector.tsx):**
- Flat list of Claude + OpenRouter + Ollama models
- No per-task recommendation or cost visibility
- No token usage feedback after sessions

**Session management (src/main/lib/trpc/routers/claude.ts):**
- Sessions spawn Claude subprocess with model + env
- No token counting returned to UI
- No cost estimation or tracking

---

## The Team

### Agent 1: Token Usage Analyst (subagent_type: general-purpose)
**Role:** Map every token consumption point, identify waste, and quantify optimization opportunities.

**Prompt for this agent:**
```
You are the Token Usage Analyst for the 2Code Electron desktop app. Your mission is to find where tokens are consumed, wasted, or could be reduced.

READ AND ANALYZE these files:

1. **Session configuration** — src/main/lib/trpc/routers/claude.ts
   - How are prompts constructed before sending to Claude?
   - What system prompts, context, or preambles are prepended?
   - Are file contents sent in full or summarized?
   - How are @mentions (files, folders, tools) resolved — do they inject full file contents?
   - Is there any prompt deduplication between messages in a session?

2. **Thinking/effort configuration** — src/renderer/lib/atoms/index.ts
   - thinkingModeAtom: "adaptive" vs "enabled" (fixed budget) vs "disabled"
   - thinkingBudgetTokensAtom: default 32,000 — is this too high for most tasks?
   - effortLevelAtom: "low"/"medium"/"high"/"max" — how does this map to actual token use?
   - Are users guided on when to use which setting?

3. **Model routing** — src/renderer/features/agents/lib/models.ts and agent-model-selector.tsx
   - Is there any task-based model recommendation? (e.g., "use Haiku for quick questions")
   - Do users know the cost implications of their model choice?
   - When OpenRouter free models are available, are they surfaced prominently?

4. **Message history management** — Search for how conversation context is built
   - How many previous messages are sent with each request?
   - Is there context window management or truncation?
   - Are tool results (which can be very large) included in full in subsequent messages?

5. **File injection patterns** — Search for file reading and context injection
   - When a user @mentions a file, is the entire file injected?
   - For large files (>1000 lines), is there any summarization or chunking?
   - Are binary files or non-text files accidentally sent as context?

For each finding, provide:
- File path and line number
- Current token impact (estimate: low/medium/high/critical)
- Specific optimization with estimated token savings
- Whether the optimization is transparent to the user or requires UI changes
```

### Agent 2: Smart Model Router (subagent_type: ai-engineer)
**Role:** Design an intelligent model routing system that selects the optimal model based on task complexity, cost, and quality requirements.

**Prompt for this agent:**
```
You are the Smart Model Router architect for 2Code. Design a system that automatically recommends or selects the most cost-effective model for each user task.

ANALYZE THE CURRENT STATE:

1. Read src/renderer/features/agents/components/agent-model-selector.tsx — understand current model selection UX
2. Read src/renderer/features/agents/lib/models.ts — current model definitions
3. Read src/renderer/lib/atoms/index.ts — look for model-related atoms, effort levels, thinking modes
4. Read src/main/lib/trpc/routers/claude.ts — how model selection flows into the subprocess
5. Search for "sendMessage" in the claude.ts router — understand how model choice is passed to the SDK

DESIGN A SMART ROUTING SYSTEM:

1. **Task Classification Heuristics** (runs in renderer, no API call needed):
   - Short question (<50 words, no code context) → recommend Haiku
   - Code review/explanation → recommend Sonnet
   - Complex architecture/debugging with @file mentions → recommend Opus
   - Plan mode (read-only) → can use cheaper model than Agent mode
   - Quick follow-up in existing session → same model or cheaper

2. **Cost-Awareness Layer:**
   - Define approximate cost tiers for each model (tokens/dollar)
   - Show relative cost indicator in model selector (e.g., $, $$, $$$)
   - For OpenRouter models, use actual pricing from API response
   - Track cumulative session cost estimate

3. **Auto-Downgrade Opportunities:**
   - When thinking mode is "enabled" with 32k budget but task is simple → suggest lowering
   - When effort is "max" for a quick question → suggest "high"
   - When Opus is selected but prompt is <100 tokens → suggest Sonnet/Haiku

4. **Implementation Plan:**
   - Where should the routing logic live? (renderer atom? tRPC middleware? separate module?)
   - How to avoid adding latency to message sending?
   - How to make recommendations non-intrusive (suggestion chip vs forced override)?
   - How to learn from user overrides (if user always picks Opus, stop suggesting Haiku)?

Provide concrete TypeScript code for:
- A `classifyTaskComplexity(prompt, context)` function
- A `recommendModel(complexity, availableModels, userPreferences)` function
- UI component changes to show the recommendation
```

### Agent 3: Prompt Efficiency Engineer (subagent_type: code-reviewer)
**Role:** Audit all system prompts, context injection, and message construction for token waste.

**Prompt for this agent:**
```
You are the Prompt Efficiency Engineer for 2Code. Your mission is to find and eliminate token waste in how prompts are constructed and sent to Claude.

SEARCH AND ANALYZE:

1. **System prompt construction** in src/main/lib/trpc/routers/claude.ts:
   - Find where the system prompt is built for Claude sessions
   - How much of the system prompt is static boilerplate vs dynamic?
   - Are there redundant instructions repeated across messages?
   - Is the system prompt different for Plan vs Agent mode? (Plan mode needs fewer tool instructions)
   - Look for buildAgentsOption, parseMentions, and how context is assembled

2. **Context injection patterns** — search the entire src/main/ directory:
   - When skills are mentioned (@[skill:name]), how much content is injected?
   - When files are mentioned (@[file:...]), is the full file sent or just relevant sections?
   - When folders are mentioned, are directory listings or full contents injected?
   - Are CLAUDE.md / AGENTS.md always injected regardless of relevance?

3. **Message history efficiency:**
   - Search for how previous messages are passed to subsequent Claude calls
   - Is the full conversation history sent, or is it windowed/summarized?
   - Are tool results (bash output, file reads) kept in full in history?
   - Large tool outputs (e.g., 500-line file reads) — are they truncated in subsequent context?

4. **Streaming and chunking overhead:**
   - Check the message transformation pipeline (claude/transform.ts)
   - Is there metadata bloat in the streaming format?
   - Are UIMessageChunks carrying unnecessary fields?

5. **MCP tool descriptions:**
   - How are MCP tool schemas injected into context?
   - If a user has 20 MCP servers with 100+ tools, how much context does this consume?
   - Are unused tool descriptions still sent?

6. **Prompt compression opportunities:**
   - Identify repeated phrases or boilerplate that could be shortened
   - Find instructions that could be moved to system prompt once vs repeated per message
   - Look for JSON schemas or structured data that could be more compact

For each waste point, provide:
- Exact location (file:line)
- Estimated tokens wasted per message/session
- Concrete optimization (shorter prompt, lazy loading, summarization, etc.)
- Risk assessment (will the optimization degrade response quality?)
```

### Agent 4: Token-Aware UX Designer (subagent_type: front-end-dev)
**Role:** Design UI features that help users be mindful of token usage and make cost-effective choices.

**Prompt for this agent:**
```
You are the Token-Aware UX Designer for 2Code. Your mission is to design UI improvements that make users mindful of token consumption without being annoying.

ANALYZE CURRENT UI:

1. Read src/renderer/features/agents/components/agent-model-selector.tsx — current model picker UX
2. Read src/renderer/components/dialogs/settings-tabs/agents-models-tab.tsx — model settings
3. Read src/renderer/features/agents/main/active-chat.tsx (first 200 lines) — chat interface structure
4. Read src/renderer/features/agents/atoms/index.ts — agent state atoms
5. Search for "thinkingMode" and "effortLevel" in src/renderer/ — how thinking/effort UI works

DESIGN THESE UI FEATURES:

1. **Token Usage Badge (per message)**
   - After each assistant response, show a subtle token count badge
   - Format: "~2.4k tokens" or "$0.03" depending on user preference
   - Click to expand: input tokens, output tokens, thinking tokens, cost breakdown
   - Design spec: position, colors, typography, interaction states
   - Component structure using existing Radix UI primitives (Badge, Tooltip, Popover)

2. **Session Cost Tracker (chat header)**
   - Running total of tokens/cost for the current session
   - Subtle progress bar or counter in the chat header area
   - Color coding: green (efficient), yellow (moderate), red (expensive session)
   - Reset on new session, persist in sub_chats table
   - Show comparison: "This session: $0.42 | Average: $0.18"

3. **Smart Model Recommendation Chip**
   - When the user types a prompt, show a non-intrusive suggestion near the send button
   - "Haiku could handle this 3x cheaper" or "Consider Opus for this complex task"
   - One-click to switch model from the chip
   - Dismissible, with "Don't show again" option
   - Only appears when the recommendation differs from the selected model

4. **Thinking Budget Visualizer**
   - Current thinkingBudgetTokensAtom is a raw number (32,000) — not intuitive
   - Design a visual slider with labeled presets: "Quick" (8k), "Standard" (32k), "Deep" (64k), "Maximum" (128k)
   - Show estimated cost impact of each preset
   - Contextual: only show when thinking mode is "enabled"

5. **Token Efficiency Score (settings/dashboard)**
   - Aggregate stats: total tokens used, average per session, trend over time
   - Model usage breakdown: "60% Opus, 30% Sonnet, 10% Haiku"
   - Suggestions: "You could save ~40% by using Sonnet for your quick questions"
   - Store in localStorage or SQLite for persistence

For each UI feature, provide:
- Wireframe description (ASCII layout or detailed prose)
- React component structure (using existing components from src/renderer/components/ui/)
- Jotai atoms needed for state
- Data flow: where does token count come from? (Claude SDK response → tRPC → renderer)
- Accessibility considerations
- Concrete code snippets for key components
```

---

## Orchestration Protocol

### Phase 1: Parallel Analysis
Launch ALL 4 agents simultaneously using the Agent tool. Each agent runs independently.

### Phase 2: Synthesis
After all agents complete, combine findings into a unified report.

### Phase 3: Top 3 Feature Recommendations
Based on all agent findings, identify the **top 3 highest-impact features** that:
1. Maximize token savings (quantified in tokens and estimated dollars)
2. Are implementable within the existing 2Code architecture
3. Include UI improvements that make users naturally more mindful
4. Are forward-looking as token costs evolve across models

### Output Format

```markdown
# 2Code Token Optimizer Report

## Executive Summary
[2-3 sentences: current token efficiency state, biggest waste areas, total savings potential]

## Top 3 Features for Maximum Token Optimization

### Feature 1: [Name]
- **Impact:** [estimated token savings per session, cost reduction %]
- **Effort:** [small/medium/large]
- **What it does:** [1-2 sentences]
- **UI Changes:** [what the user sees]
- **Backend Changes:** [what changes in main process]
- **Implementation:** [key code changes with file paths]

### Feature 2: [Name]
...

### Feature 3: [Name]
...

## All Findings by Agent

### Token Usage Analysis
[Agent 1 key findings — waste points ranked by impact]

### Smart Model Routing
[Agent 2 — routing design with code]

### Prompt Efficiency
[Agent 3 — prompt compression opportunities]

### Token-Aware UX
[Agent 4 — UI feature designs with wireframes]

## Quick Wins (implement today)
[Changes that save tokens with <30 min of work]

## Forward-Looking Recommendations
[How to prepare for: rising token costs, new model tiers, usage-based billing, token budgets]
```

## Important Notes

- This skill produces ANALYSIS + RECOMMENDATIONS + CODE. It does not auto-apply changes.
- After the report, ask the user: "Which of the top 3 features should I implement first?"
- Token counts are estimates based on typical usage patterns — actual savings depend on user behavior.
- Never compromise response quality for token savings — only eliminate genuine waste.
- The Claude SDK (`@anthropic-ai/claude-code`) handles most prompt construction internally — focus optimizations on what 2Code controls (model selection, thinking config, context injection, UX nudges).
- OpenRouter model pricing comes from `m.pricing.prompt` in the API response — use this for accurate cost display.
- The thinking budget (32k default) is often the largest source of "optional" token spend — making this more visible and tunable is high-value.
- Forward-looking: as Anthropic introduces tiered pricing or token budgets per plan, 2Code should be ready to enforce and display limits.
