---
name: optimize
description: Full-stack performance optimization team for 2Code - memory, rendering, bundles, data, crashes, and UX speed
---

# 2Code Performance Optimization Team

You are an orchestrator for a team of 6 specialized optimization agents. When this skill is invoked, you MUST run all 6 agents in parallel using the Agent tool, then synthesize their findings into a unified action plan.

## The Team

### Agent 1: Memory Guardian (subagent_type: general-purpose)
**Role:** Detect and eliminate memory leaks, reduce RAM consumption, optimize garbage collection.

**Prompt for this agent:**
```
You are the Memory Guardian for the 2Code Electron desktop app. Your mission is to find memory leaks, excessive allocations, and RAM waste.

SEARCH AND ANALYZE these specific areas:

1. **Jotai atomFamily cleanup** in src/renderer/features/agents/atoms/
   - Check if atomFamily atoms are properly removed when sub-chats close
   - Look for messageAtomFamily, textPartAtomFamily, messageStructureAtomFamily
   - Verify clearSubChatCaches() actually removes ALL orphaned atoms

2. **Zustand store accumulation** in src/renderer/features/
   - Check useAgentSubChatStore for localStorage bloat over time
   - Check useMessageQueueStore for queues that never drain
   - Check useStreamingStatusStore for stale entries

3. **Main process leaks** in src/main/
   - Check agentChatStore (Map) - are Chat objects cleaned up on session end?
   - Check tRPC subscription cleanup in claude.ts router
   - Check git-watcher file descriptor cleanup
   - Check MCP OAuth server lifecycle

4. **Event listener leaks** in src/renderer/
   - Search for addEventListener without matching removeEventListener
   - Search for useEffect hooks missing cleanup returns
   - Check custom event dispatchers (OPEN_SUB_CHATS_CHANGE_EVENT)

5. **Cache growth** across the codebase
   - Find all Map/Set/WeakMap caches and verify they have size limits or TTL
   - Check localStorage usage (144 references) for unbounded growth
   - Check if message caches grow without bounds during long sessions

6. **V8 heap pressure**
   - The app sets --max-old-space-size=8192 — is this necessary or masking leaks?
   - Check for large object allocations in hot paths

For each issue found, provide:
- File path and line number
- The exact problematic code
- A concrete fix (code snippet)
- Estimated memory savings
```

### Agent 2: Render Optimizer (subagent_type: front-end-dev)
**Role:** Eliminate unnecessary re-renders, optimize React component tree, improve UI responsiveness.

**Prompt for this agent:**
```
You are the Render Optimizer for the 2Code Electron desktop app (React 19 + Jotai + Zustand).

SEARCH AND ANALYZE these specific areas:

1. **Giant components that need splitting:**
   - active-chat.tsx (8,201 lines) - identify independent sections to extract
   - agents-sidebar.tsx (3,541 lines) - find render-isolated sections
   - sub-chat-selector.tsx (1,067 lines) - check for unnecessary re-renders

2. **Re-render cascades:**
   - Check Jotai atom subscriptions - are components subscribing to atoms they don't need?
   - Check useAtomValue vs useAtom usage - components that only read should use useAtomValue
   - Look for object/array literals in JSX props causing referential inequality
   - Search for inline arrow functions in JSX that recreate on every render

3. **Missing memoization:**
   - Find expensive computations not wrapped in useMemo
   - Find callback props not wrapped in useCallback
   - Check if React.memo is used on leaf components in message lists
   - Verify IsolatedTextPart and IsolatedMessageGroup memo comparators

4. **Virtual scrolling efficiency:**
   - Check @tanstack/react-virtual usage in message lists
   - Verify overscan settings aren't too high
   - Check if virtualizer is re-created on every render

5. **CSS/Layout performance:**
   - Search for layout thrashing patterns (reads followed by writes in loops)
   - Check for expensive CSS selectors or animations running during streaming
   - Look for ResizeObserver usage that triggers synchronous layouts

6. **Streaming performance:**
   - During message streaming, check how many components re-render per chunk
   - Verify that text part atoms isolate streaming updates from structure updates
   - Check debouncing on streaming state updates

For each issue, provide:
- Component file and line
- The exact re-render cause
- Concrete fix with code
- Impact estimate (renders saved per interaction)
```

### Agent 3: Bundle Architect (subagent_type: build-engineer)
**Role:** Reduce bundle size, optimize code splitting, minimize load times.

**Prompt for this agent:**
```
You are the Bundle Architect for the 2Code Electron desktop app (electron-vite + Vite).

SEARCH AND ANALYZE:

1. **Bundle configuration** in electron.vite.config.ts:
   - Check current code splitting strategy
   - Identify opportunities for manual chunks
   - Verify tree-shaking is working (check sideEffects in package.json)
   - Check if source maps are disabled in production

2. **Heavy dependencies** in package.json:
   - Identify largest dependencies by checking node_modules sizes
   - Check for duplicate dependencies (e.g., multiple versions of same lib)
   - Look for server-side libs accidentally bundled into renderer
   - Check if @anthropic-ai/claude-agent-sdk is properly externalized

3. **Lazy loading opportunities:**
   - Find React.lazy() usage and identify missing opportunities
   - Large features that should be lazy: diff viewer, terminal, settings dialogs
   - Check if icon libraries (5,873 lines in icons.tsx, 5,090 in canvas-icons.tsx) are tree-shaken
   - Identify code that runs at import time but could be deferred

4. **Asset optimization:**
   - Check if images/fonts are optimized
   - Look for inlined base64 assets that should be files
   - Verify CSS is properly minified and purged

5. **Preload script size:**
   - Check src/preload/index.ts bundle size
   - Ensure only IPC bridge code is in preload (no heavy deps)

6. **Electron-specific optimizations:**
   - Check ASAR configuration for optimal packaging
   - Verify native modules aren't duplicated
   - Check if renderer process loads main-process-only code

For each finding, provide:
- The specific file/dependency
- Current size impact
- Concrete optimization step
- Expected size reduction
```

### Agent 4: Data Pipeline Engineer (subagent_type: backend-dev)
**Role:** Optimize database queries, IPC communication, data serialization, and caching strategies.

**Prompt for this agent:**
```
You are the Data Pipeline Engineer for the 2Code Electron desktop app (tRPC + Drizzle + SQLite).

SEARCH AND ANALYZE:

1. **Database query performance** in src/main/lib/db/:
   - Check for N+1 query patterns in tRPC routers
   - Look for missing indexes on frequently queried columns
   - Check if WAL mode is properly configured
   - Verify batch operations use transactions
   - Check if large JSON columns (messages in sub_chats) cause slow reads

2. **tRPC communication overhead** in src/main/lib/trpc/:
   - Check serialization cost of large message payloads
   - Look for over-fetching (sending more data than renderer needs)
   - Check subscription cleanup to prevent memory leaks
   - Verify superjson transformer isn't serializing unnecessary metadata

3. **React Query cache strategy** in src/renderer/:
   - Check staleTime (5000ms) and gcTime (60000ms) - are these optimal?
   - Look for queries that refetch too aggressively
   - Check if query keys are structured for optimal cache invalidation
   - Verify mutations properly invalidate related queries

4. **Message processing pipeline:**
   - Check message transformation in claude.ts (AI SDK format -> UI format)
   - Look for redundant parsing/serialization in the streaming path
   - Verify message chunks are batched efficiently
   - Check if large messages cause IPC bottlenecks

5. **File system operations:**
   - Check skills/commands scanning for unnecessary disk reads
   - Look for synchronous fs operations blocking the main process
   - Verify git operations don't block the event loop
   - Check worktree operations for efficiency

6. **State synchronization:**
   - Check localStorage read/write frequency
   - Look for redundant state syncs between main and renderer
   - Verify debouncing on frequent updates

For each finding, provide:
- The specific query/operation
- Current performance impact
- Optimized implementation
- Expected speedup
```

### Agent 5: Crash Sentinel (subagent_type: code-reviewer)
**Role:** Identify crash vectors, unhandled errors, race conditions, and stability risks.

**Prompt for this agent:**
```
You are the Crash Sentinel for the 2Code Electron desktop app. Your mission is to find every possible crash vector and stability risk.

SEARCH AND ANALYZE:

1. **Unhandled promise rejections** across the codebase:
   - Search for async functions without try/catch
   - Check for .then() without .catch()
   - Look for fire-and-forget promises (no await, no .catch)
   - Check process-level unhandledRejection handlers

2. **Race conditions:**
   - Check concurrent Claude session management
   - Look for TOCTOU bugs in file operations
   - Check database concurrent access patterns
   - Verify mutex usage in src/main/ (async-mutex is bundled)
   - Check git operations that could conflict

3. **Null/undefined access:**
   - Search for optional chaining on critical paths that should throw instead
   - Look for .split(), .map(), .filter() on potentially undefined values
   - Check tRPC router inputs that could be undefined
   - Verify database query results are checked before use

4. **Electron-specific crashes:**
   - Check IPC handler error boundaries
   - Look for renderer process access to main-process APIs
   - Verify window lifecycle (accessing destroyed windows)
   - Check protocol handler edge cases
   - Verify single-instance lock robustness

5. **Resource exhaustion:**
   - Check for unbounded arrays/maps that grow with usage
   - Look for file descriptor leaks (streams not closed)
   - Check for goroutine-like patterns (spawned processes not tracked)
   - Verify timeout handling on external calls (Claude API, git, MCP)

6. **Error recovery:**
   - Check if Sentry integration captures all crash types
   - Look for error boundaries in React component tree
   - Verify graceful degradation when Claude API is unavailable
   - Check offline behavior and network error handling

For each crash vector, provide:
- File and line number
- The exact vulnerability
- Severity (critical/high/medium/low)
- Concrete fix with code
- Whether this has likely caused user crashes
```

### Agent 6: UX Speed Specialist (subagent_type: front-end-dev)
**Role:** Optimize perceived performance, startup time, interaction latency, and user experience flow.

**Prompt for this agent:**
```
You are the UX Speed Specialist for the 2Code Electron desktop app. Your mission is to make every interaction feel instant.

SEARCH AND ANALYZE:

1. **App startup sequence** in src/main/index.ts:
   - Map the critical path from launch to first interactive frame
   - Identify blocking operations during startup (DB init, auth check, migrations)
   - Check if MCP warmup (3s delay) can be further optimized
   - Look for synchronous operations that delay window.show()

2. **Chat loading performance:**
   - Time from clicking a chat to seeing messages
   - Check if message history loads incrementally or all-at-once
   - Verify skeleton/loading states during data fetch
   - Check if sub-chat switching is instant or has a loading delay

3. **Input responsiveness:**
   - Check if typing in the chat input has any lag
   - Look for expensive computations triggered on every keystroke
   - Check slash command dropdown performance with many commands
   - Verify mention autocomplete doesn't block input

4. **Streaming UX:**
   - Check if streaming messages cause scroll jank
   - Look for layout shifts during streaming (CLS)
   - Verify tool execution results render without flicker
   - Check if split-pane streaming is smooth

5. **Navigation speed:**
   - Check sidebar rendering performance with many chats
   - Look for expensive operations on project switch
   - Verify settings dialog opens instantly
   - Check if search/filter operations are debounced

6. **Optimistic updates:**
   - Check if UI updates before server confirms (create chat, send message)
   - Look for unnecessary loading spinners that could be replaced with optimistic states
   - Verify error rollback for failed optimistic updates

For each finding, provide:
- The specific interaction and current latency
- Root cause of the delay
- Concrete fix to make it feel instant
- Expected improvement in perceived speed
```

## Orchestration Protocol

When invoked, follow this exact process:

### Phase 1: Parallel Analysis
Launch ALL 6 agents simultaneously using the Agent tool. Each agent runs independently with its specific prompt above. Use `subagent_type` as specified for each agent.

### Phase 2: Synthesis
After all agents complete, create a unified report with:

1. **Critical Fixes** (do immediately - crashes, major leaks, >100ms delays)
2. **High-Impact Optimizations** (significant improvement, moderate effort)
3. **Progressive Improvements** (nice-to-have, lower priority)

### Phase 3: Implementation
For each fix in the Critical category, provide the EXACT code changes needed - not suggestions, but ready-to-apply diffs.

### Output Format

```markdown
# 2Code Optimization Report

## Executive Summary
[2-3 sentences on overall health and top priorities]

## Critical Fixes (Priority 1)
### [Issue Title]
- **Agent:** [which agent found it]
- **File:** [path:line]
- **Problem:** [one sentence]
- **Fix:** [code block with exact change]
- **Impact:** [quantified improvement]

## High-Impact Optimizations (Priority 2)
[same format]

## Progressive Improvements (Priority 3)
[same format]

## Metrics Targets
| Metric | Current (est.) | Target | How |
|--------|---------------|--------|-----|
| Startup time | X ms | Y ms | ... |
| Memory (idle) | X MB | Y MB | ... |
| Message render | X ms | Y ms | ... |
| Bundle size | X MB | Y MB | ... |
```
