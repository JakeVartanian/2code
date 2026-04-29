/**
 * Session type classifier — keyword heuristics to detect session intent.
 * Zero AI cost. Used to boost relevant memory categories during injection.
 */

export type SessionType =
  | "debugging"
  | "brand-strategy"
  | "design"
  | "deployment"
  | "refactoring"
  | "feature"
  | "auditing"
  | "general"

const SESSION_KEYWORDS: Record<SessionType, string[]> = {
  debugging: ["fix", "bug", "error", "crash", "broken", "fails", "not working", "issue", "problem", "debug", "stack trace", "exception", "undefined", "null"],
  "brand-strategy": ["brand", "voice", "audience", "positioning", "roadmap", "market", "strategy", "vision", "mission", "competitor", "messaging", "tagline", "pitch"],
  design: ["design", "ui", "ux", "layout", "animation", "wireframe", "mockup", "prototype", ".pen", "pencil", "visual", "theme", "color", "font", "responsive"],
  deployment: ["deploy", "release", "ci", "cd", "build", "docker", "production", "pipeline", "server", "host", "publish", "staging"],
  refactoring: ["refactor", "cleanup", "reorganize", "simplify", "extract", "split", "consolidate", "rename", "restructure"],
  feature: ["implement", "new feature", "integrate", "add support", "build out", "wire up"],
  auditing: ["audit", "review", "check", "assess", "scan", "coverage", "analyze", "inspect"],
  general: [],
}

/** Map session types to relevant memory categories for scoring bonuses */
export const SESSION_CATEGORY_MAP: Record<SessionType, string[]> = {
  debugging: ["debugging", "gotcha"],
  "brand-strategy": ["brand", "strategy"],
  design: ["design", "preference"],
  deployment: ["deployment"],
  refactoring: ["convention", "architecture"],
  feature: ["architecture", "convention"],
  auditing: ["architecture", "convention", "gotcha"],
  general: [],
}

/**
 * Classify a session's type from the user's first prompt and optionally mentioned files.
 * Returns the most likely session type based on keyword density.
 */
export function classifySessionType(
  userPrompt: string,
  mentionedFiles?: string[],
): SessionType {
  const text = userPrompt.toLowerCase()
  const scores: Partial<Record<SessionType, number>> = {}

  for (const [type, keywords] of Object.entries(SESSION_KEYWORDS)) {
    if (type === "general") continue
    let score = 0
    for (const kw of keywords) {
      if (text.includes(kw)) score++
    }
    if (score > 0) scores[type as SessionType] = score
  }

  // File extension hints
  if (mentionedFiles) {
    const fileText = mentionedFiles.join(" ").toLowerCase()
    if (fileText.includes(".pen")) scores["design"] = (scores["design"] ?? 0) + 3
    if (fileText.includes("dockerfile") || fileText.includes(".yml") || fileText.includes("ci")) {
      scores["deployment"] = (scores["deployment"] ?? 0) + 2
    }
  }

  // Return highest-scoring type
  let best: SessionType = "general"
  let bestScore = 0
  for (const [type, score] of Object.entries(scores)) {
    if (score > bestScore) {
      bestScore = score
      best = type as SessionType
    }
  }

  return best
}
