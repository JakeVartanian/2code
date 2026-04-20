# Proposal: Add Ambient Background Agent

## Summary

Add an always-on, budget-controlled ambient background agent that monitors file saves and git activity, applies a tiered analysis funnel (local heuristics -> Haiku triage -> Sonnet analysis), surfaces actionable suggestions through a non-intrusive sidebar UI, and invisibly enriches every Claude session with accumulated project knowledge.

## Motivation

2Code already has orchestration (multi-agent task execution) and memory (project knowledge persistence). What's missing is the proactive layer -- something that watches development activity and surfaces insights without being asked. This makes 2Code feel like a dev pair that's always paying attention, and makes every session mysteriously smarter over time.

## Scope

- New backend module: `src/main/lib/ambient/` (13 files)
- New DB tables: `ambientSuggestions`, `ambientBudget`, `ambientFeedback`
- New tRPC router: `ambient`
- New frontend feature: `src/renderer/features/ambient/`
- Upgrades to existing memory injection pipeline
- Provider abstraction for multi-provider API calls
- Settings UI merged into Memory tab
- Sidebar section with compact suggestion rows

## Key Design Decisions

1. **Tiered funnel**: 85-92% of events filtered locally (free) before any API call
2. **Two channels**: Invisible (enriches all sessions) + Interactive (sidebar suggestions)
3. **Budget-controlled**: $0.50/day default cap with graceful degradation
4. **Learning from dismissals**: Category weights decay, preventing notification fatigue
5. **Mid-session injection is impossible**: Redesigned as "Enhanced Initial Injection" with predictive pre-loading
6. **Provider abstraction**: Works with Anthropic OAuth, OpenRouter, or Tier-0-only for Ollama/no credentials
7. **Brain backfill**: One-click "Build Brain" for existing projects (analyzes git history + past chats)

## Full Design

See `/Users/jakevartanian/.claude/plans/snazzy-conjuring-lampson.md` for the complete 1400-line architecture plan including:
- Backend file structure and service architecture
- Database schema (audited for consistency)
- tRPC router API surface
- Frontend store/atoms design
- UI layout (audited for 160px sidebar constraint)
- Compounding intelligence flywheel
- Cost model and budget system
- Cold start strategy
- Anti-fatigue mechanisms
- Provider abstraction with availability matrix
- Implementation phases (11 phases)
- Verification plan
- Full audit resolution log

## Status

- [x] Plan created
- [x] DB audit passed (schema corrected)
- [x] UX audit passed (layout, accessibility, notification coherence fixed)
- [x] AI/SDK audit passed (mid-session injection redesigned, provider abstraction added)
- [ ] Implementation (11 phases)
