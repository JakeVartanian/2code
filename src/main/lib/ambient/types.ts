/**
 * Ambient Background Agent — shared types
 */

// ============ CATEGORIES & SEVERITY ============

export type SuggestionCategory =
  | "bug"
  | "security"
  | "performance"
  | "test-gap"
  | "dead-code"
  | "dependency"
  // GAAD partner categories
  | "next-step"    // what to build/do next (includes ideas, momentum, tools)
  | "risk"         // something that might bite you (includes security, performance)
  | "memory"       // pattern worth remembering (auto-saved to project memory)

export type SuggestionSeverity = "info" | "warning" | "error"

export type SuggestionStatus =
  | "pending"
  | "dismissed"
  | "approved"
  | "snoozed"
  | "expired"

export type TriggerEvent =
  | "file-change"
  | "commit"
  | "branch-switch"
  | "ci-failure"
  | "tool-error"
  | "memory-conflict"
  | "session-synthesis"
  | "chat-batch"

export type AnalysisModel = "heuristic" | "haiku" | "sonnet"

export type DismissReason =
  | "not-relevant"
  | "already-handled"
  | "wrong"
  | "suppress-type"

// ============ PIPELINE TYPES ============

export interface FileChangeEvent {
  path: string
  type: "add" | "change" | "unlink"
  ext: string
  sizeBytes?: number
}

export interface FileBatch {
  files: FileChangeEvent[]
  timestamp: number
  projectId: string
  projectPath: string
}

export interface GitEvent {
  type: "commit" | "branch-switch" | "merge-conflict"
  ref?: string
  previousRef?: string
  timestamp: number
}

export interface ChatActivityEvent {
  subChatId: string
  chatId: string
  projectId: string
  activityType: "user-prompt" | "tool-call" | "tool-error" | "session-complete" | "session-error"
  /** Lightweight summary — truncated to ~500 chars to avoid memory pressure */
  summary: string
  toolName?: string
  filePaths?: string[]
  timestamp: number
  /** Rich metadata available on session-complete events */
  sessionMeta?: {
    durationSeconds?: number
    model?: string
    filesRead?: string[]
    filesModified?: string[]
    toolCallCount?: number
    errorCount?: number
    lastAssistantExcerpt?: string
  }
}

export type AmbientEvent =
  | { kind: "file-batch"; batch: FileBatch }
  | { kind: "git"; event: GitEvent }
  | { kind: "chat"; event: ChatActivityEvent }

// ============ HEURISTIC RESULTS ============

export interface HeuristicResult {
  category: SuggestionCategory
  severity: SuggestionSeverity
  title: string
  description: string
  confidence: number // 0-100
  triggerFiles: string[]
  triggerEvent: TriggerEvent
}

// ============ TRIAGE RESULTS ============

export interface TriageItem {
  /** Index into the batch of heuristic results */
  index: number
  relevance: number // 0.0-1.0
  category: SuggestionCategory
  urgency: "low" | "medium" | "high"
  summary: string
}

export interface TriageResult {
  items: TriageItem[]
  tokensUsed: { input: number; output: number }
}

// ============ ANALYSIS RESULTS ============

export interface AnalysisResult {
  title: string
  description: string // Markdown
  category: SuggestionCategory
  severity: SuggestionSeverity
  confidence: number // 0-100
  suggestedPrompt: string // Pre-filled prompt for agent tab
  triggerFiles: string[]
  tokensUsed: { input: number; output: number }
}

// ============ BUDGET ============

export interface BudgetConfig {
  /** Max daily spend in cents (default 50 = $0.50) */
  dailyLimitCents: number
  /** Max Haiku calls per hour */
  haikuRateLimit: number
  /** Max Sonnet calls per hour */
  sonnetRateLimit: number
}

export interface BudgetStatus {
  date: string // YYYY-MM-DD
  haikuCalls: number
  sonnetCalls: number
  totalCostCents: number
  dailyLimitCents: number
  percentUsed: number
  isExhausted: boolean
  tier: "normal" | "conserving" | "tier0-only" | "paused"
}

// ============ CONFIG ============

export interface AmbientConfig {
  enabled: boolean
  sensitivity: "low" | "medium" | "high"
  budget: BudgetConfig
  enabledCategories: SuggestionCategory[]
  ignorePatterns: string[]
  quietHours?: { start: string; end: string } // "HH:MM" format
  autoMemoryWrite: boolean
  triageThreshold: number // 0.0-1.0, default 0.7
}

// ============ AGENT STATUS ============

export type AmbientAgentStatus = "running" | "paused" | "stopped"

export interface AmbientStatus {
  agentStatus: AmbientAgentStatus
  budget: BudgetStatus | null
  pendingSuggestions: number
  lastEventAt: number | null
  lastAnalysisAt: number | null
}

// ============ FEEDBACK ============

export interface CategoryWeight {
  category: SuggestionCategory
  weight: number // 0.0-1.5 (stored as integer × 100 in DB)
  isSuppressed: boolean
  totalDismissals: number
  totalApprovals: number
}

// ============ PROVIDER ============

export type AmbientProviderType = "anthropic" | "openrouter" | "none"

export interface AmbientProviderInfo {
  type: AmbientProviderType
  supportsHaiku: boolean
  supportsSonnet: boolean
}
