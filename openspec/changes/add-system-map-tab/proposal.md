# Proposal: Add System Map Tab

## Status: Draft

## Summary

Add a new "System Map" tab to 2Code that provides a real-time, visually beautiful overview of the entire workspace system state. It sits to the LEFT of the orchestrator brain tab and serves as a constellation dashboard showing: project memories, active plans, installed skills, running agents, orchestration progress, and ambient alerts — all interconnected with relationship lines.

## Motivation

Currently, understanding the full state of a workspace requires switching between multiple tabs, checking the ambient panel, and mentally reconstructing what's happening. The System Map provides a single "god view" — a calm, stunning visualization that answers: "What does this system look like? What's active? What's connected to what?"

This is especially valuable when using the Superpowers workflow (brainstorming → planning → sub-agent dispatching → verification) because it visually maps the entire development lifecycle at a glance.

## What Changes

### New Tab Mode: `"system-map"`
- Added as the 4th sub-chat mode alongside `"agent" | "plan" | "orchestrator"`
- Auto-created on workspace load (like orchestrator)
- Cannot be closed, renamed, or archived
- Always positioned first in tab bar (before orchestrator)
- Uses cyan-colored Network icon (vs orchestrator's purple Brain)

### New Feature Directory: `src/renderer/features/agents/ui/system-map/`
- `system-map-view.tsx` — Main container with CSS Grid layout
- `map-section.tsx` — Reusable collapsible section component
- `memory-cluster.tsx` — Memory nodes grouped by 6 categories, sized by relevance
- `plan-nodes.tsx` — Recent plans with progress indicators
- `skill-nodes.tsx` — Installed skills by source (user/project/plugin)
- `agent-nodes.tsx` — Active/recent sub-agents with status dots
- `orchestration-summary.tsx` — Active run progress and task graph
- `ambient-alerts.tsx` — Pending suggestions with severity
- `connection-lines.tsx` — SVG overlay for inter-node relationships
- `use-system-map-data.ts` — Custom hook aggregating all data sources

### Visual Layout (Constellation Dashboard)
```
┌──────────────────────────────────────────────────┐
│  WORKFLOW STAGES (Superpowers lifecycle)           │
│  ◉ Brainstorm → ◉ Plan → ○ Dispatch → ○ Execute → ○ Verify │
├──────────────────────────────────────────────────┤
│          [ System Health Bar ]                     │
│  memories: 47  |  agents: 3  |  alerts: 2         │
├────────────────────────┬─────────────────────────┤
│                        │                          │
│   MEMORY BANK          │   ACTIVE WORK            │
│   6 category clusters  │   orchestration runs     │
│   colored by state     │   + running agents       │
│                        │                          │
├────────────────────────┬─────────────────────────┤
│                        │                          │
│   PLANS                │   SKILLS                 │
│   recent .md files     │   by source              │
│   with status          │   usage indicators       │
│                        │                          │
├────────────────────────┴─────────────────────────┤
│          [ AMBIENT ALERTS ]                       │
│  pending suggestions with severity colors         │
└──────────────────────────────────────────────────┘
```

### Superpowers Workflow Stage Indicator
A horizontal pipeline at the top showing the current Superpowers development lifecycle stage:
- **Brainstorm** — highlighted when brainstorming skill was recently invoked
- **Plan** — highlighted when writing-plans skill active or plan files recently modified
- **Dispatch** — highlighted when dispatching-parallel-agents skill used or orchestration planning
- **Execute** — highlighted when sub-agents are actively running
- **Verify** — highlighted when verification-before-completion skill invoked

Each stage is a pill with a connecting line. Active stage pulses with cyan glow. Completed stages show a checkmark. This gives instant awareness of "where we are in the workflow."

### Connection Lines (SVG Overlay)
Lightweight bezier curves at low opacity (0.15) connecting related nodes:
- Memory → linked agent that generated it
- Orchestration task → its worker tab
- Skill → memories that reference it
- Brightens on hover for exploration

### Data Sources (all existing, no new endpoints needed)
- `projectMemories` table — primary knowledge base
- `orchestrationRuns` + `orchestrationTasks` — task DAGs
- `subChats` store — active/recent tabs
- `~/.claude/plans/*.md` — plan files
- `trpc.skills.list` — installed skills
- `ambientSuggestions` — pending alerts

## Technical Approach

### No New Dependencies
- Uses CSS Grid for layout (no React Flow or D3)
- Uses Motion (framer-motion, already installed) for animations
- Uses inline SVG for connection lines
- Uses existing Mermaid for optional "export graph" feature
- Matches existing visual language (Tailwind + Radix + Lucide)

### Performance
- Lazy-loaded (`React.lazy`) — zero cost when not active
- Tiered polling: orchestration 3s, memories 10s, ambient 15s, skills 30s
- `memo()` on each section, `placeholderData` to prevent flashes
- Connection lines calculated via ResizeObserver, batched with rAF

### Color Scheme
- Cyan accent (`text-cyan-400`) for the tab icon and section headers
- Memory nodes: blue (active), amber (cold), gray (dead)
- Status dots: green (running), blue (completed), red (failed), yellow (pending)
- Connection lines: `stroke-cyan-500/15`, brightening to `/40` on hover

## Impact

- **Schema**: Add `"system-map"` to mode column comment (no migration needed — text column)
- **Bundle**: Minimal — all custom components, no new deps
- **Performance**: Negligible when tab inactive; tiered polling when active
- **UX**: Provides immediate visual awareness of workspace state

## Risks

- **Visual density**: Too much information could overwhelm. Mitigated by collapsible sections and progressive disclosure (show top N, expand for more).
- **Polling load**: Multiple tRPC queries. Mitigated by generous intervals and `enabled: !!projectId` guards.
- **Connection line complexity**: Could get noisy with many nodes. Mitigated by low opacity, hover-to-reveal, and max connection count.

## Out of Scope (Future)
- Interactive node dragging/repositioning
- Custom user layouts/pinning nodes
- Timeline/history view of system evolution
- Mermaid full-graph export (nice-to-have, Phase 5 stretch)
