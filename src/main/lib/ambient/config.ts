/**
 * Ambient agent configuration — defaults + per-project .2code/ambient.json loader
 */

import { existsSync, readFileSync } from "fs"
import { join } from "path"
import type { AmbientConfig, SuggestionCategory } from "./types"

const DEFAULT_CONFIG: AmbientConfig = {
  enabled: true,
  sensitivity: "medium",
  budget: {
    dailyLimitCents: 500, // $5.00/day — budget should never be the reason GAAD goes quiet
    haikuRateLimit: 60, // calls per hour — no artificial bottleneck
    sonnetRateLimit: 20, // calls per hour — Sonnet is where the real insights come from
  },
  enabledCategories: ["bug", "security", "performance", "test-gap", "blind-spot", "next-step", "risk", "memory", "design"],
  ignorePatterns: [],
  autoMemoryWrite: false, // Disabled — suggestions are in ambientSuggestions table, don't pollute project memories
  triageThreshold: 0.55, // Lowered from 0.65 — upstream context improvements make lower threshold viable
}

const VALID_CATEGORIES: SuggestionCategory[] = [
  "bug",
  "security",
  "performance",
  "test-gap",
  "dead-code",
  "dependency",
  "blind-spot",
  "next-step",
  "risk",
  "memory",
  "design",
]

/**
 * Load ambient config for a project. Merges .2code/ambient.json (if exists) over defaults.
 */
export function loadAmbientConfig(projectPath: string): AmbientConfig {
  const configPath = join(projectPath, ".2code", "ambient.json")

  if (!existsSync(configPath)) {
    return { ...DEFAULT_CONFIG }
  }

  try {
    const raw = readFileSync(configPath, "utf-8")
    const parsed = JSON.parse(raw)
    return mergeConfig(DEFAULT_CONFIG, parsed)
  } catch (err) {
    console.warn(`[Ambient] Failed to parse ${configPath}:`, err)
    return { ...DEFAULT_CONFIG }
  }
}

function mergeConfig(defaults: AmbientConfig, overrides: Partial<AmbientConfig>): AmbientConfig {
  const config: AmbientConfig = { ...defaults }

  if (typeof overrides.enabled === "boolean") config.enabled = overrides.enabled
  if (overrides.sensitivity === "low" || overrides.sensitivity === "medium" || overrides.sensitivity === "high") {
    config.sensitivity = overrides.sensitivity
  }

  if (overrides.budget && typeof overrides.budget === "object") {
    config.budget = {
      dailyLimitCents: validInt(overrides.budget.dailyLimitCents, 10, 500, defaults.budget.dailyLimitCents),
      haikuRateLimit: validInt(overrides.budget.haikuRateLimit, 1, 100, defaults.budget.haikuRateLimit),
      sonnetRateLimit: validInt(overrides.budget.sonnetRateLimit, 1, 50, defaults.budget.sonnetRateLimit),
    }
  }

  if (Array.isArray(overrides.enabledCategories)) {
    config.enabledCategories = overrides.enabledCategories.filter(
      (c): c is SuggestionCategory => VALID_CATEGORIES.includes(c as SuggestionCategory)
    )
  }

  if (Array.isArray(overrides.ignorePatterns)) {
    config.ignorePatterns = overrides.ignorePatterns.filter(p => typeof p === "string")
  }

  if (overrides.quietHours && typeof overrides.quietHours === "object") {
    const { start, end } = overrides.quietHours
    if (isValidTime(start) && isValidTime(end)) {
      config.quietHours = { start, end }
    }
  }

  if (typeof overrides.autoMemoryWrite === "boolean") config.autoMemoryWrite = overrides.autoMemoryWrite
  if (typeof overrides.triageThreshold === "number") {
    config.triageThreshold = Math.max(0, Math.min(1, overrides.triageThreshold))
  }

  return config
}

function validInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback
  return Math.max(min, Math.min(max, Math.round(value)))
}

function isValidTime(value: unknown): value is string {
  if (typeof value !== "string") return false
  return /^\d{2}:\d{2}$/.test(value)
}

/**
 * Check if current time is within quiet hours.
 */
export function isQuietHours(config: AmbientConfig): boolean {
  if (!config.quietHours) return false

  const now = new Date()
  const currentMinutes = now.getHours() * 60 + now.getMinutes()

  const [startH, startM] = config.quietHours.start.split(":").map(Number)
  const [endH, endM] = config.quietHours.end.split(":").map(Number)
  const startMinutes = startH * 60 + startM
  const endMinutes = endH * 60 + endM

  if (startMinutes <= endMinutes) {
    // Same day range (e.g., 09:00 - 17:00)
    return currentMinutes >= startMinutes && currentMinutes < endMinutes
  } else {
    // Overnight range (e.g., 22:00 - 08:00)
    return currentMinutes >= startMinutes || currentMinutes < endMinutes
  }
}

/**
 * Get the heuristic confidence threshold based on sensitivity setting.
 */
export function getHeuristicThreshold(sensitivity: AmbientConfig["sensitivity"]): number {
  switch (sensitivity) {
    case "low": return 80
    case "medium": return 65
    case "high": return 50
  }
}
