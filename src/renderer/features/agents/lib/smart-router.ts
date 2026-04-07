/**
 * Smart Model Router — classifies task complexity from prompt text
 * and recommends the most cost-effective model.
 *
 * Runs entirely client-side, no API calls.
 */

import { type ClaudeModel, CLAUDE_MODELS } from "./models"

export type TaskComplexity = "simple" | "moderate" | "complex"

/**
 * Classify task complexity based on prompt text and context signals.
 */
export function classifyTaskComplexity(
  prompt: string,
  options?: {
    /** Number of @file mentions in the prompt */
    fileMentionCount?: number
    /** Whether the user is in plan mode (read-only) */
    isPlanMode?: boolean
    /** Whether this is a follow-up in an existing session */
    isFollowUp?: boolean
  },
): TaskComplexity {
  const text = prompt.trim()
  const wordCount = text.split(/\s+/).length
  const fileMentions = options?.fileMentionCount ?? 0

  // Complex signals
  const complexPatterns = [
    /\barchitect/i,
    /\brefactor/i,
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
  ]

  // Simple signals
  const simplePatterns = [
    /^(what|how|why|when|where|who|explain|describe|tell me|show me)\b/i,
    /\bfix.*typo/i,
    /\brename/i,
    /\badd.*import/i,
    /\bremove.*unused/i,
    /\bupdate.*version/i,
    /\byes\b/i,
    /\bno\b/i,
    /\bcontinue\b/i,
    /\bthanks/i,
    /\bformat/i,
    /\blint/i,
  ]

  const hasComplexSignal = complexPatterns.some((p) => p.test(text))
  const hasSimpleSignal = simplePatterns.some((p) => p.test(text))

  // Short follow-ups are almost always simple
  if (options?.isFollowUp && wordCount < 10 && !hasComplexSignal) {
    return "simple"
  }

  // Very short prompts without file context
  if (wordCount < 15 && fileMentions === 0 && !hasComplexSignal) {
    return "simple"
  }

  // Long prompts with many file mentions
  if (wordCount > 100 || fileMentions >= 3 || hasComplexSignal) {
    return "complex"
  }

  return "moderate"
}

/**
 * Recommend the most cost-effective model for a given complexity.
 * Returns null if the current model is already appropriate.
 */
export function recommendModel(
  complexity: TaskComplexity,
  currentModelId: string,
): { model: ClaudeModel; reason: string } | null {
  const current = CLAUDE_MODELS.find((m) => m.id === currentModelId)
  if (!current) return null // custom model, don't suggest

  switch (complexity) {
    case "simple": {
      if (currentModelId === "haiku") return null
      const haiku = CLAUDE_MODELS.find((m) => m.id === "haiku")!
      const savings = currentModelId === "opus" ? "~19x" : "~4x"
      return {
        model: haiku,
        reason: `Haiku handles this — ${savings} cheaper`,
      }
    }

    case "moderate": {
      if (currentModelId === "sonnet" || currentModelId === "haiku") return null
      const sonnet = CLAUDE_MODELS.find((m) => m.id === "sonnet")!
      return {
        model: sonnet,
        reason: "Sonnet handles this — ~5x cheaper",
      }
    }

    case "complex": {
      // Don't suggest upgrading — let user decide
      return null
    }
  }
}
