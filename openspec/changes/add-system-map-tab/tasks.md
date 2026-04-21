# Tasks: Add System Map Tab

## Phase 1: Schema & Types
- [ ] Update `src/main/lib/db/schema/index.ts` — add `"system-map"` to mode comment
- [ ] Update `src/renderer/features/agents/atoms/index.ts` — add to AgentMode union
- [ ] Update `src/renderer/features/agents/stores/sub-chat-store.ts` — SubChatMeta mode type
- [ ] Update `src/main/lib/trpc/routers/chats.ts` — createSubChat mode validation

## Phase 2: Tab Integration
- [ ] Update `src/renderer/features/agents/ui/sub-chat-selector.tsx` — tab ordering (system-map before orchestrator), icon (Network/cyan), close-prevention
- [ ] Update `src/renderer/features/agents/main/active-chat.tsx` — lazy import, auto-creation on workspace load, conditional rendering
- [ ] Update `src/renderer/features/agents/ui/sub-chat-context-menu.tsx` — prevent rename/archive

## Phase 3: Data Layer
- [ ] Create `src/renderer/features/agents/ui/system-map/use-system-map-data.ts` — aggregation hook with tiered polling

## Phase 4: Visual Components
- [ ] Create `src/renderer/features/agents/ui/system-map/system-map-view.tsx` — main container with CSS Grid
- [ ] Create `src/renderer/features/agents/ui/system-map/workflow-stages.tsx` — Superpowers lifecycle indicator (brainstorm→plan→dispatch→execute→verify)
- [ ] Create `src/renderer/features/agents/ui/system-map/map-section.tsx` — reusable collapsible section
- [ ] Create `src/renderer/features/agents/ui/system-map/memory-cluster.tsx` — 6-category memory visualization
- [ ] Create `src/renderer/features/agents/ui/system-map/plan-nodes.tsx` — recent plans with status
- [ ] Create `src/renderer/features/agents/ui/system-map/skill-nodes.tsx` — skills by source
- [ ] Create `src/renderer/features/agents/ui/system-map/agent-nodes.tsx` — active/recent agents
- [ ] Create `src/renderer/features/agents/ui/system-map/orchestration-summary.tsx` — run progress
- [ ] Create `src/renderer/features/agents/ui/system-map/ambient-alerts.tsx` — pending suggestions
- [ ] Create `src/renderer/features/agents/ui/system-map/connection-lines.tsx` — SVG overlay

## Phase 5: Polish & Animation
- [ ] Add Motion enter/exit/layout transitions to all sections
- [ ] Implement health bar summary strip at top
- [ ] Add hover tooltips (Radix Tooltip) on all nodes
- [ ] Implement click-to-navigate (clicking agent → switches to that tab)
- [ ] Add "recently updated" pulse animation (last 30s)
- [ ] Responsive layout for narrow panes (stack to single column)
- [ ] Test with large memory sets (100+ nodes)
