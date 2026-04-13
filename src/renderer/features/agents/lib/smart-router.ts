/**
 * Smart Model Router — classifies task complexity from prompt text
 * and recommends the most cost-effective model + settings.
 *
 * Runs entirely client-side, no API calls. Zero latency overhead
 * because classification happens during the debounce window while
 * the user is still typing.
 */

import { type ClaudeModel, CLAUDE_MODELS, estimateCost, formatCost } from "./models"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TaskComplexity = "simple" | "moderate" | "complex"

export type EffortLevel = "low" | "medium" | "high"
export type ThinkingMode = "adaptive" | "enabled" | "disabled"

export type TaskClassificationContext = {
  /** Number of @file / @folder mentions in the prompt */
  fileMentionCount?: number
  /** Whether the user is in plan mode (read-only) */
  isPlanMode?: boolean
  /** Whether this is a follow-up in an existing session */
  isFollowUp?: boolean
  /** Number of messages already in the conversation */
  messageCount?: number
  /** Whether the prompt contains code blocks (``` fences) */
  hasCodeBlocks?: boolean
  /** Whether any @[agent:...] mentions are present */
  hasAgentMentions?: boolean
  /** Whether any @[tool:...] / MCP tool mentions are present */
  hasToolMentions?: boolean
}

export type ModelRecommendation = {
  model: ClaudeModel
  reason: string
}

export type SettingsRecommendation = {
  type: "effort" | "thinking"
  current: string
  suggested: string
  reason: string
}

export type SmartRouterResult = {
  complexity: TaskComplexity
  modelRecommendation: ModelRecommendation | null
  settingsRecommendations: SettingsRecommendation[]
}

// ---------------------------------------------------------------------------
// User Preference Learning
// ---------------------------------------------------------------------------

const DISMISSAL_STORAGE_KEY = "smart-router:dismissals"
const DISMISSAL_THRESHOLD = 3 // After N dismissals for a direction, stop suggesting

type DismissalRecord = {
  /** Key format: "{fromModel}->{toModel}" e.g. "opus->haiku" */
  [directionKey: string]: number
}

function getDismissals(): DismissalRecord {
  try {
    const raw = localStorage.getItem(DISMISSAL_STORAGE_KEY)
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

/** Record that the user dismissed a suggestion to switch from one model to another. */
export function recordDismissal(fromModelId: string, toModelId: string): void {
  const dismissals = getDismissals()
  const key = `${fromModelId}->${toModelId}`
  dismissals[key] = (dismissals[key] ?? 0) + 1
  try {
    localStorage.setItem(DISMISSAL_STORAGE_KEY, JSON.stringify(dismissals))
  } catch {
    // localStorage full or unavailable — ignore
  }
}

/** Check whether the user has dismissed this direction enough times to suppress it. */
function isSuppressed(fromModelId: string, toModelId: string): boolean {
  const dismissals = getDismissals()
  const key = `${fromModelId}->${toModelId}`
  return (dismissals[key] ?? 0) >= DISMISSAL_THRESHOLD
}

/** Reset all learned dismissals (e.g. from a settings button). */
export function resetDismissals(): void {
  try {
    localStorage.removeItem(DISMISSAL_STORAGE_KEY)
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// Session Cost Tracking
// ---------------------------------------------------------------------------

const sessionCosts = new Map<string, { inputTokens: number; outputTokens: number; modelId: string }>()

/** Record token usage for a sub-chat session. Called from the streaming handler. */
export function recordSessionTokens(
  subChatId: string,
  modelId: string,
  inputTokens: number,
  outputTokens: number,
): void {
  const existing = sessionCosts.get(subChatId)
  if (existing) {
    existing.inputTokens += inputTokens
    existing.outputTokens += outputTokens
    existing.modelId = modelId
  } else {
    sessionCosts.set(subChatId, { inputTokens, outputTokens, modelId })
  }
}

/** Get cumulative estimated cost for a sub-chat session. */
export function getSessionCost(subChatId: string): { cost: number; formatted: string } | null {
  const data = sessionCosts.get(subChatId)
  if (!data) return null
  const cost = estimateCost(data.modelId, data.inputTokens, data.outputTokens)
  return { cost, formatted: formatCost(cost) }
}

/** Clear session cost data (e.g. when sub-chat is deleted). */
export function clearSessionCost(subChatId: string): void {
  sessionCosts.delete(subChatId)
}

// ---------------------------------------------------------------------------
// Task Classification
// ---------------------------------------------------------------------------

// Patterns that signal a complex task requiring the most capable model
const COMPLEX_PATTERNS = [
  /\barchitect/i,
  /\brefactor\b/i,
  /\bmigrat/i,
  /\bdesign.*system/i,
  /\bfull.*implementation/i,
  /\bbuild.*from.*scratch/i,
  /\bconvert.*entire/i,
  /\brewrite/i,
  /\boptimize.*performance/i,
  /\bsecurity.*audit/i,
  /\bdebugging.*complex/i,
  /\bmulti.*file/i,
  /\bcross.?cutting/i,
  /\bbreaking.*change/i,
  /\btype.?system/i,
  /\bconcurrency/i,
  /\brace.*condition/i,
  /\bmemory.*leak/i,
  /\bdeadlock/i,
  /\bscalability/i,
  /\bdistributed/i,
  /\bmonorepo/i,
  /\bCI\/CD/i,
  /\binfrastructure/i,
]

// Patterns that signal a simple task suitable for a fast/cheap model
const SIMPLE_PATTERNS = [
  /^(what|how|why|when|where|who|explain|describe|tell me|show me)\b/i,
  /\bfix.*typo/i,
  /\brename\b/i,
  /\badd.*import/i,
  /\bremove.*unused/i,
  /\bupdate.*version/i,
  /^(yes|no|ok|sure|thanks|thank you|continue|go ahead|looks good|lgtm)\s*[.!?]?$/i,
  /\bformat\b/i,
  /\blint\b/i,
  /\bspelling/i,
  /\bcomment.*out/i,
  /\bdelete.*line/i,
  /\badd.*log/i,
  /\bconsole\.log/i,
]

/**
 * Classify task complexity based on prompt text and context signals.
 * Uses a weighted scoring approach: each signal adds or subtracts points,
 * and the final score maps to a complexity tier.
 */
export function classifyTaskComplexity(
  prompt: string,
  options?: TaskClassificationContext,
): TaskComplexity {
  const text = prompt.trim()
  if (!text) return "simple"

  const wordCount = text.split(/\s+/).length
  const fileMentions = options?.fileMentionCount ?? 0

  // Score: negative = simple, positive = complex
  let score = 0

  // --- Word count signals ---
  if (wordCount < 5) score -= 3
  else if (wordCount < 15) score -= 1
  else if (wordCount > 80) score += 2
  else if (wordCount > 200) score += 4

  // --- Pattern matching ---
  const hasComplexSignal = COMPLEX_PATTERNS.some((p) => p.test(text))
  const hasSimpleSignal = SIMPLE_PATTERNS.some((p) => p.test(text))

  if (hasComplexSignal) score += 3
  if (hasSimpleSignal) score -= 2

  // --- Context signals ---
  if (fileMentions >= 3) score += 2
  else if (fileMentions >= 1) score += 1

  if (options?.hasCodeBlocks) score += 1
  if (options?.hasAgentMentions) score += 2 // delegating to agents = complex workflow
  if (options?.hasToolMentions) score += 1

  // Follow-ups in existing sessions tend to be simpler (context already established)
  if (options?.isFollowUp) score -= 1
  if (options?.isFollowUp && wordCount < 10 && !hasComplexSignal) score -= 2

  // Plan mode is read-only, generally lighter workload
  if (options?.isPlanMode) score -= 1

  // Deep conversations (many messages) suggest incremental work, not greenfield
  if (options?.messageCount && options.messageCount > 10) score -= 1

  // --- Map score to tier ---
  if (score <= -1) return "simple"
  if (score >= 3) return "complex"
  return "moderate"
}

// ---------------------------------------------------------------------------
// Model Recommendation
// ---------------------------------------------------------------------------

/**
 * Recommend the most cost-effective model for a given complexity.
 * Returns null if the current model is already appropriate or if
 * the user has dismissed this suggestion direction enough times.
 */
export function recommendModel(
  complexity: TaskComplexity,
  currentModelId: string,
): ModelRecommendation | null {
  const current = CLAUDE_MODELS.find((m) => m.id === currentModelId)
  if (!current) return null // custom/OpenRouter model, don't suggest

  switch (complexity) {
    case "simple": {
      if (currentModelId === "haiku") return null
      if (isSuppressed(currentModelId, "haiku")) return null
      const haiku = CLAUDE_MODELS.find((m) => m.id === "haiku")!
      const inputRatio = Math.round(current.inputCostPer1M / haiku.inputCostPer1M)
      return {
        model: haiku,
        reason: `Haiku handles this ~${inputRatio}x cheaper`,
      }
    }

    case "moderate": {
      if (currentModelId === "sonnet" || currentModelId === "haiku") return null
      if (isSuppressed(currentModelId, "sonnet")) return null
      const sonnet = CLAUDE_MODELS.find((m) => m.id === "sonnet")!
      const inputRatio = Math.round(current.inputCostPer1M / sonnet.inputCostPer1M)
      return {
        model: sonnet,
        reason: `Sonnet handles this ~${inputRatio}x cheaper`,
      }
    }

    case "complex": {
      if (currentModelId === "opus") return null
      if (isSuppressed(currentModelId, "opus")) return null
      const opus = CLAUDE_MODELS.find((m) => m.id === "opus")!
      return {
        model: opus,
        reason: `This task needs Opus for best results`,
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Settings Recommendations (effort + thinking)
// ---------------------------------------------------------------------------

/**
 * Suggest effort and thinking mode adjustments based on task complexity.
 * These are secondary suggestions shown alongside model recommendations.
 */
export function recommendSettings(
  complexity: TaskComplexity,
  currentEffort: EffortLevel,
  currentThinkingMode: ThinkingMode,
): SettingsRecommendation[] {
  const suggestions: SettingsRecommendation[] = []

  // Effort adjustments
  if (complexity === "simple" && currentEffort === "high") {
    suggestions.push({
      type: "effort",
      current: currentEffort,
      suggested: "medium",
      reason: "Lower effort saves tokens on simple tasks",
    })
  }

  if (complexity === "complex" && (currentEffort === "low" || currentEffort === "medium")) {
    suggestions.push({
      type: "effort",
      current: currentEffort,
      suggested: "high",
      reason: "Higher effort improves results for complex tasks",
    })
  }

  return suggestions
}

// ---------------------------------------------------------------------------
// Full Analysis (convenience wrapper)
// ---------------------------------------------------------------------------

/**
 * Run the full smart routing analysis: classify complexity, recommend model,
 * and suggest settings adjustments. This is the main entry point.
 */
export function analyzeTask(
  prompt: string,
  context: TaskClassificationContext & {
    currentModelId: string
    currentEffort: EffortLevel
    currentThinkingMode: ThinkingMode
  },
): SmartRouterResult {
  const complexity = classifyTaskComplexity(prompt, context)
  const modelRecommendation = recommendModel(complexity, context.currentModelId)
  const settingsRecommendations = recommendSettings(
    complexity,
    context.currentEffort,
    context.currentThinkingMode,
  )

  return {
    complexity,
    modelRecommendation,
    settingsRecommendations,
  }
}
