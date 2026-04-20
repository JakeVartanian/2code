/**
 * Ambient agent Zustand store — manages suggestions, budget status, and agent state.
 * Follows the orchestration-store pattern: server-state-derived, per-project.
 */

import { create } from "zustand"

export interface AmbientSuggestion {
  id: string
  projectId: string
  category: string
  severity: string
  title: string
  description: string
  triggerEvent: string
  triggerFiles: string[]
  analysisModel: string | null
  status: string
  confidence: number
  suggestedPrompt: string | null
  createdAt: Date | null
}

export interface AmbientBudgetStatus {
  date: string
  haikuCalls: number
  sonnetCalls: number
  totalCostCents: number
  dailyLimitCents: number
  percentUsed: number
  isExhausted: boolean
  tier: "normal" | "conserving" | "tier0-only" | "paused"
}

interface AmbientState {
  // Per-project state
  suggestions: AmbientSuggestion[]
  budgetStatus: AmbientBudgetStatus | null
  agentStatus: "running" | "paused" | "stopped"
  enabled: boolean
  categoryWeights: Map<string, number>

  // Actions
  setSuggestions: (suggestions: AmbientSuggestion[]) => void
  addSuggestion: (suggestion: AmbientSuggestion) => void
  removeSuggestion: (id: string) => void
  setBudgetStatus: (status: AmbientBudgetStatus | null) => void
  setAgentStatus: (status: "running" | "paused" | "stopped") => void
  setEnabled: (enabled: boolean) => void
  setCategoryWeights: (weights: Map<string, number>) => void
  reset: () => void
}

export const useAmbientStore = create<AmbientState>((set) => ({
  suggestions: [],
  budgetStatus: null,
  agentStatus: "stopped",
  enabled: true,
  categoryWeights: new Map(),

  setSuggestions: (suggestions) => set({ suggestions }),

  addSuggestion: (suggestion) => set((state) => ({
    suggestions: [suggestion, ...state.suggestions].slice(0, 10), // Cap at 10
  })),

  removeSuggestion: (id) => set((state) => ({
    suggestions: state.suggestions.filter(s => s.id !== id),
  })),

  setBudgetStatus: (budgetStatus) => set({ budgetStatus }),

  setAgentStatus: (agentStatus) => set({ agentStatus }),

  setEnabled: (enabled) => set({ enabled }),

  setCategoryWeights: (categoryWeights) => set({ categoryWeights }),

  reset: () => set({
    suggestions: [],
    budgetStatus: null,
    agentStatus: "stopped",
    enabled: true,
    categoryWeights: new Map(),
  }),
}))
