/**
 * Memory Brain constants — colors, icons, and category metadata.
 */

import type { LucideIcon } from "lucide-react"
import {
  Brain,
  Code,
  Rocket,
  Bug,
  Settings,
  AlertTriangle,
} from "lucide-react"

// ─── Category metadata ──────────────────────────────────────────────────────

export interface CategoryMeta {
  label: string
  icon: LucideIcon
  color: string        // Tailwind border color
  glowRgb: string      // RGB for radial gradient glow
  textColor: string    // Tailwind text color for header
  barFill: string      // Tailwind gradient for health bar
  badgeBg: string      // Badge background
  badgeText: string    // Badge text color
  dotColor: string     // Active dot color
}

export const CATEGORIES = [
  "architecture",
  "convention",
  "deployment",
  "debugging",
  "preference",
  "gotcha",
] as const

export type Category = (typeof CATEGORIES)[number]

export const CATEGORY_META: Record<Category, CategoryMeta> = {
  architecture: {
    label: "Architecture",
    icon: Brain,
    color: "border-blue-500/30",
    glowRgb: "59,130,246",
    textColor: "text-blue-400",
    barFill: "bg-gradient-to-r from-blue-500 to-blue-400",
    badgeBg: "bg-blue-500/15",
    badgeText: "text-blue-400",
    dotColor: "bg-blue-400",
  },
  convention: {
    label: "Convention",
    icon: Code,
    color: "border-purple-500/30",
    glowRgb: "168,85,247",
    textColor: "text-purple-400",
    barFill: "bg-gradient-to-r from-purple-500 to-purple-400",
    badgeBg: "bg-purple-500/15",
    badgeText: "text-purple-400",
    dotColor: "bg-purple-400",
  },
  deployment: {
    label: "Deployment",
    icon: Rocket,
    color: "border-green-500/30",
    glowRgb: "34,197,94",
    textColor: "text-green-400",
    barFill: "bg-gradient-to-r from-green-500 to-green-400",
    badgeBg: "bg-green-500/15",
    badgeText: "text-green-400",
    dotColor: "bg-green-400",
  },
  debugging: {
    label: "Debugging",
    icon: Bug,
    color: "border-amber-500/30",
    glowRgb: "245,158,11",
    textColor: "text-amber-400",
    barFill: "bg-gradient-to-r from-amber-500 to-amber-400",
    badgeBg: "bg-amber-500/15",
    badgeText: "text-amber-400",
    dotColor: "bg-amber-400",
  },
  preference: {
    label: "Preference",
    icon: Settings,
    color: "border-cyan-500/30",
    glowRgb: "6,182,212",
    textColor: "text-cyan-400",
    barFill: "bg-gradient-to-r from-cyan-500 to-cyan-400",
    badgeBg: "bg-cyan-500/15",
    badgeText: "text-cyan-400",
    dotColor: "bg-cyan-400",
  },
  gotcha: {
    label: "Gotcha",
    icon: AlertTriangle,
    color: "border-red-500/30",
    glowRgb: "239,68,68",
    textColor: "text-red-400",
    barFill: "bg-gradient-to-r from-red-500 to-red-400",
    badgeBg: "bg-red-500/15",
    badgeText: "text-red-400",
    dotColor: "bg-red-400",
  },
}

// ─── Semantic connections between categories ────────────────────────────────

export interface CategoryConnection {
  from: Category
  to: Category
  label: string
}

export const CATEGORY_CONNECTIONS: CategoryConnection[] = [
  { from: "architecture", to: "convention", label: "patterns" },
  { from: "architecture", to: "deployment", label: "infra" },
  { from: "convention", to: "preference", label: "style" },
  { from: "debugging", to: "gotcha", label: "pitfalls" },
  { from: "deployment", to: "debugging", label: "ops" },
  { from: "gotcha", to: "architecture", label: "design" },
]

// ─── State colors ───────────────────────────────────────────────────────────

export const STATE_COLORS = {
  active: "bg-emerald-400",
  cold: "bg-amber-400",
  dead: "bg-zinc-500",
} as const

// ─── Dimensions ─────────────────────────────────────────────────────────────

export const NODE_WIDTH = 220
export const NODE_HEIGHT = 140
export const MAP_HEIGHT = 520
export const PADDING = 30
