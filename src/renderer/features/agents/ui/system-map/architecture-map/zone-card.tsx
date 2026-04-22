/**
 * ZoneCard — renders a single system zone in the architecture map.
 * Ambient glow, colored border, confidence bar, tech stack description,
 * "audited X ago" timestamp, per-zone audit button, and audit badge.
 */

import { memo, useCallback } from "react"
import { motion, useReducedMotion } from "motion/react"
import {
  Monitor, Server, Database, Shield, Brain, Package,
  Globe, Key, Cpu, HardDrive, Cloud, Code, GitBranch,
  Layout, Terminal, FileCode, Workflow, Zap, Settings, Layers,
  ShieldCheck, Loader2, CheckCircle2, XCircle, Clock,
  type LucideIcon,
} from "lucide-react"
import { cn } from "../../../../../lib/utils"
import type { EnrichedZone, Severity } from "./use-architecture-data"
import { ZONE_WIDTH, ZONE_HEIGHT } from "./layout"

// ─── Icon lookup ─────────────────────────────────────────────────────────────

const ICON_MAP: Record<string, LucideIcon> = {
  monitor: Monitor, server: Server, database: Database, shield: Shield,
  brain: Brain, package: Package, globe: Globe, key: Key, cpu: Cpu,
  "hard-drive": HardDrive, cloud: Cloud, code: Code, "git-branch": GitBranch,
  layout: Layout, terminal: Terminal, "file-code": FileCode,
  workflow: Workflow, zap: Zap, settings: Settings, layers: Layers,
}

// ─── Confidence color tiers ──────────────────────────────────────────────────

interface ColorTier {
  border: string
  glow: string
  glowOpacity: number
  barFill: string
  textColor: string
  iconColor: string
  badgeBg: string
  badgeText: string
}

function getColorTier(confidence: number, severity: Severity): ColorTier {
  if (severity === "error") return {
    border: "border-red-500/30",
    glow: "rgba(239,68,68,",
    glowOpacity: 0.12,
    barFill: "bg-red-500/70",
    textColor: "text-red-400",
    iconColor: "text-red-400/80",
    badgeBg: "bg-red-500/15",
    badgeText: "text-red-400",
  }
  if (confidence >= 80) return {
    border: "border-green-500/25",
    glow: "rgba(34,197,94,",
    glowOpacity: 0.12,
    barFill: "bg-gradient-to-r from-green-500 to-green-400",
    textColor: "text-green-400",
    iconColor: "text-green-500",
    badgeBg: "bg-green-500/15",
    badgeText: "text-green-400",
  }
  if (confidence >= 60) return {
    border: "border-cyan-500/25",
    glow: "rgba(6,182,212,",
    glowOpacity: 0.10,
    barFill: "bg-cyan-500/80",
    textColor: "text-cyan-400",
    iconColor: "text-cyan-400/80",
    badgeBg: "bg-cyan-400/15",
    badgeText: "text-cyan-400",
  }
  if (confidence >= 40) return {
    border: "border-amber-500/25",
    glow: "rgba(245,158,11,",
    glowOpacity: 0.08,
    barFill: "bg-amber-500/70",
    textColor: "text-amber-400",
    iconColor: "text-amber-500/70",
    badgeBg: "bg-amber-500/15",
    badgeText: "text-amber-400",
  }
  if (confidence >= 20) return {
    border: "border-pink-500/25",
    glow: "rgba(236,72,153,",
    glowOpacity: 0.06,
    barFill: "bg-pink-500/60",
    textColor: "text-pink-400",
    iconColor: "text-pink-500/70",
    badgeBg: "bg-pink-500/15",
    badgeText: "text-pink-400",
  }
  return {
    border: "border-zinc-700/50",
    glow: "rgba(82,82,91,",
    glowOpacity: 0.04,
    barFill: "bg-zinc-600/50",
    textColor: "text-zinc-500",
    iconColor: "text-zinc-600",
    badgeBg: "bg-zinc-700/30",
    badgeText: "text-zinc-500",
  }
}

// ─── Audit badge logic ──────────────────────────────────────────────────────

function getAuditBadge(zone: EnrichedZone): { color: string; bg: string } | null {
  if (!zone.lastAuditedAt) return null // Never audited → no badge

  const hoursSinceAudit = (Date.now() - new Date(zone.lastAuditedAt).getTime()) / (1000 * 60 * 60)

  if (zone.severity === "error") {
    return { color: "text-red-400", bg: "bg-red-500/20" }
  }
  if (hoursSinceAudit > 168) { // > 7 days stale
    return { color: "text-red-400", bg: "bg-red-500/20" }
  }
  if (zone.severity === "warning") {
    return { color: "text-amber-400", bg: "bg-amber-500/20" }
  }
  return { color: "text-green-400", bg: "bg-green-500/20" }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return "just now"
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  return `${days}d ago`
}

// ─── Component ───────────────────────────────────────────────────────────────

interface ZoneCardProps {
  zone: EnrichedZone
  x: number
  y: number
  index: number
  isAuditing?: boolean
  auditStatus?: "pending" | "profiling" | "auditing" | "done" | "error"
  auditFindingCount?: number
  onAudit?: (zoneId: string) => void
}

export const ZoneCard = memo(function ZoneCard({ zone, x, y, index, isAuditing, auditStatus, auditFindingCount, onAudit }: ZoneCardProps) {
  const prefersReducedMotion = useReducedMotion()
  const tier = getColorTier(zone.confidence, zone.severity)
  const Icon = ICON_MAP[zone.icon] || Code
  const badge = getAuditBadge(zone)

  const handleAudit = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    onAudit?.(zone.id)
  }, [onAudit, zone.id])

  return (
    <motion.div
      className="absolute"
      style={{ left: x, top: y, width: ZONE_WIDTH }}
      initial={prefersReducedMotion ? {} : { opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.4, ease: [0.25, 0.46, 0.45, 0.94], delay: index * 0.08 }}
    >
      {/* Ambient glow behind card */}
      <div
        className="absolute -inset-8 rounded-full pointer-events-none blur-2xl"
        style={{
          background: `radial-gradient(ellipse, ${tier.glow}${tier.glowOpacity}) 0%, transparent 70%)`,
        }}
      />

      {/* Card */}
      <div
        className={cn(
          "relative rounded-xl border bg-[#09090BCC] backdrop-blur-sm",
          "transition-all duration-200 ease-out cursor-default",
          "hover:shadow-lg hover:scale-[1.02]",
          tier.border,
        )}
        style={{ minHeight: ZONE_HEIGHT }}
      >
        {/* Audit badge overlay (top-right) */}
        {badge && (
          <div className={cn(
            "absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full flex items-center justify-center",
            badge.bg, "border border-zinc-800",
          )}>
            <ShieldCheck className={cn("w-3 h-3", badge.color)} />
          </div>
        )}

        <div className="p-4 space-y-3">
          {/* Header: icon + name + confidence badge */}
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2.5 min-w-0">
              <Icon className={cn("w-[18px] h-[18px] shrink-0", tier.iconColor)} />
              <span className="text-sm font-semibold text-zinc-100 truncate">
                {zone.name}
              </span>
            </div>
            <span
              className={cn(
                "text-[9px] font-mono font-semibold px-2 py-0.5 rounded-md shrink-0",
                tier.badgeBg, tier.badgeText,
              )}
            >
              {zone.confidence}%
            </span>
          </div>

          {/* Description */}
          <p className="text-[11px] text-zinc-500 leading-relaxed line-clamp-2">
            {zone.description}
          </p>

          {/* Confidence bar */}
          <div className="h-[3px] rounded-full bg-zinc-800/80 overflow-hidden">
            <motion.div
              className={cn("h-full rounded-full", tier.barFill)}
              initial={prefersReducedMotion ? { width: `${zone.confidence}%` } : { width: 0 }}
              animate={{ width: `${zone.confidence}%` }}
              transition={{
                duration: 0.6,
                ease: [0.25, 0.46, 0.45, 0.94],
                delay: index * 0.08 + 0.2,
              }}
            />
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              {auditStatus === "pending" ? (
                <span className="flex items-center gap-1 text-[9px] font-mono text-zinc-600">
                  <Clock className="w-2.5 h-2.5" />
                  Queued...
                </span>
              ) : auditStatus === "profiling" ? (
                <span className="flex items-center gap-1 text-[9px] font-mono text-cyan-400">
                  <Loader2 className="w-2.5 h-2.5 animate-spin" />
                  Building profile...
                </span>
              ) : auditStatus === "auditing" ? (
                <span className="flex items-center gap-1 text-[9px] font-mono text-cyan-400">
                  <Loader2 className="w-2.5 h-2.5 animate-spin" />
                  Scanning...
                </span>
              ) : auditStatus === "done" ? (
                <span className="flex items-center gap-1 text-[9px] font-mono text-green-400">
                  <CheckCircle2 className="w-2.5 h-2.5" />
                  {auditFindingCount ?? 0} finding{(auditFindingCount ?? 0) !== 1 ? "s" : ""}
                </span>
              ) : auditStatus === "error" ? (
                <span className="flex items-center gap-1 text-[9px] font-mono text-red-400">
                  <XCircle className="w-2.5 h-2.5" />
                  Error
                </span>
              ) : isAuditing ? (
                <span className="flex items-center gap-1 text-[9px] font-mono text-cyan-400">
                  <Loader2 className="w-2.5 h-2.5 animate-spin" />
                  Auditing...
                </span>
              ) : (
                <span className={cn("text-[9px] font-mono", tier.textColor)} style={{ opacity: 0.7 }}>
                  {zone.lastAuditedAt
                    ? `Audited ${relativeTime(zone.lastAuditedAt)}`
                    : "Never audited"}
                </span>
              )}
              {/* Per-zone audit button */}
              {onAudit && !auditStatus && (
                <button
                  onClick={handleAudit}
                  disabled={isAuditing}
                  className={cn(
                    "flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-mono transition-all duration-150",
                    isAuditing
                      ? "text-cyan-400/50 cursor-wait"
                      : "text-zinc-600 hover:text-cyan-400 hover:bg-cyan-500/10",
                  )}
                  title={isAuditing ? "Audit in progress..." : "Audit this zone"}
                >
                  <ShieldCheck className={cn("w-2.5 h-2.5", isAuditing && "animate-pulse")} />
                </button>
              )}
            </div>
            {!auditStatus && zone.issueCount > 0 && (
              <span className="text-[9px] font-mono text-amber-400/70">
                {zone.issueCount} issue{zone.issueCount !== 1 ? "s" : ""}
              </span>
            )}
          </div>
        </div>
      </div>
    </motion.div>
  )
})
