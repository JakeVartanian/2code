export type CostTier = "$" | "$$" | "$$$"

export type ClaudeModel = {
  id: string
  name: string
  version: string
  costTier: CostTier
  /** Approximate cost per 1M input tokens (USD) */
  inputCostPer1M: number
  /** Approximate cost per 1M output tokens (USD) */
  outputCostPer1M: number
  /** Short descriptor for the model */
  tagline: string
}

export const CLAUDE_MODELS: ClaudeModel[] = [
  {
    id: "opus",
    name: "Opus",
    version: "4.6",
    costTier: "$$$",
    inputCostPer1M: 15,
    outputCostPer1M: 75,
    tagline: "Most capable",
  },
  {
    id: "sonnet",
    name: "Sonnet",
    version: "4.6",
    costTier: "$$",
    inputCostPer1M: 3,
    outputCostPer1M: 15,
    tagline: "Recommended",
  },
  {
    id: "haiku",
    name: "Haiku",
    version: "4.5",
    costTier: "$",
    inputCostPer1M: 0.8,
    outputCostPer1M: 4,
    tagline: "Fastest",
  },
]

/** Estimate cost in USD from token counts and model ID */
export function estimateCost(
  modelId: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const model = CLAUDE_MODELS.find((m) => m.id === modelId)
  if (!model) return 0
  return (
    (inputTokens / 1_000_000) * model.inputCostPer1M +
    (outputTokens / 1_000_000) * model.outputCostPer1M
  )
}

/** Format USD cost for display */
export function formatCost(usd: number): string {
  if (usd < 0.01) return "<$0.01"
  if (usd < 1) return `$${usd.toFixed(2)}`
  return `$${usd.toFixed(2)}`
}

/** Cost tier color classes */
export function getCostTierColor(tier: CostTier): string {
  switch (tier) {
    case "$":
      return "text-emerald-500"
    case "$$":
      return "text-amber-500"
    case "$$$":
      return "text-orange-500"
  }
}
