/**
 * useArchitectureData — fetches system map zones and computes
 * confidence/severity overlays from ambient suggestions.
 */

import { useMemo } from "react"
import { trpc } from "../../../../../lib/trpc"
import type { SystemZone } from "../../../../../../shared/system-map-types"

// ─── Types ───────────────────────────────────────────────────────────────────

export type Severity = "none" | "info" | "warning" | "error"

export interface EnrichedZone extends SystemZone {
  confidence: number         // 0-100
  severity: Severity
  issueCount: number
  lastAuditedAt: string | null
}

export interface ArchitectureMapData {
  zones: EnrichedZone[]
  overallConfidence: number
  lastBuiltAt: string | null
  hasSystemMap: boolean
  hasBrain: boolean
  isLoading: boolean
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function normalizePath(p: string): string {
  let n = p.replace(/\\/g, "/")
  if (n.startsWith("./")) n = n.slice(2)
  if (n.startsWith("/")) n = n.slice(1)
  if (n.endsWith("/")) n = n.slice(0, -1)
  return n
}

function isUnderPath(filePath: string, dirPath: string): boolean {
  const nf = normalizePath(filePath)
  const nd = normalizePath(dirPath)
  return nf === nd || nf.startsWith(nd + "/")
}

function maxSeverity(a: Severity, b: Severity): Severity {
  const order: Record<Severity, number> = { none: 0, info: 1, warning: 2, error: 3 }
  return order[a] >= order[b] ? a : b
}

// ─── Hook ────────────────────────────────────────────────────────────────────

export function useArchitectureData(
  projectId: string | null,
): ArchitectureMapData {
  const hasProject = !!projectId

  // 1. System map zones
  const mapQuery = trpc.ambient.getSystemMap.useQuery(
    { projectId: projectId! },
    {
      enabled: hasProject,
      refetchInterval: 30_000,
      placeholderData: (prev) => prev,
    },
  )

  // 2. Ambient suggestions for overlay
  const suggestionsQuery = trpc.ambient.listSuggestions.useQuery(
    { projectId: projectId!, status: "pending", limit: 500 },
    {
      enabled: hasProject,
      refetchInterval: 15_000,
      placeholderData: (prev) => prev,
    },
  )

  // 3. Brain status
  const brainQuery = trpc.ambient.getBrainStatus.useQuery(
    { projectId: projectId! },
    {
      enabled: hasProject,
      refetchInterval: 30_000,
      placeholderData: (prev) => prev,
    },
  )

  const result = useMemo<Omit<ArchitectureMapData, "isLoading">>(() => {
    const rawZones: SystemZone[] = mapQuery.data?.zones ?? []
    const suggestions = suggestionsQuery.data ?? []
    const brainStatus = brainQuery.data

    if (rawZones.length === 0) {
      return {
        zones: [],
        overallConfidence: 0,
        lastBuiltAt: mapQuery.data?.builtAt
          ? (mapQuery.data.builtAt instanceof Date
            ? mapQuery.data.builtAt.toISOString()
            : String(mapQuery.data.builtAt))
          : null,
        hasSystemMap: false,
        hasBrain: (brainStatus?.memoryCount ?? 0) > 0,
      }
    }

    // Enrich zones with suggestion overlays
    const enriched: EnrichedZone[] = rawZones.map((zone) => {
      let totalConfidence = 0
      let confidenceCount = 0
      let severity: Severity = "none"
      let issueCount = 0
      let latestAnalysis: string | null = null

      for (const s of suggestions) {
        const triggerFiles = Array.isArray(s.triggerFiles) ? s.triggerFiles : []
        const zoneLinked = zone.linkedFiles

        // Check if any trigger file falls under (or contains) any of the zone's linked paths
        const matches = triggerFiles.some((tf) =>
          zoneLinked.some((zf) => isUnderPath(tf, zf) || isUnderPath(zf, tf)),
        )

        if (matches) {
          issueCount++
          severity = maxSeverity(severity, (s.severity ?? "none") as Severity)
          const conf = (s as any).confidence ?? 50
          totalConfidence += conf
          confidenceCount++
          const ts = s.createdAt instanceof Date
            ? s.createdAt.toISOString()
            : typeof s.createdAt === "string" ? s.createdAt : null
          if (ts && (!latestAnalysis || ts > latestAnalysis)) {
            latestAnalysis = ts
          }
        }
      }

      return {
        ...zone,
        confidence: confidenceCount > 0 ? Math.round(totalConfidence / confidenceCount) : 0,
        severity,
        issueCount,
        lastAuditedAt: latestAnalysis,
      }
    })

    const overallConfidence = enriched.length > 0
      ? Math.round(enriched.reduce((sum, z) => sum + z.confidence, 0) / enriched.length)
      : 0

    return {
      zones: enriched,
      overallConfidence,
      lastBuiltAt: mapQuery.data?.builtAt
        ? (mapQuery.data.builtAt instanceof Date
          ? mapQuery.data.builtAt.toISOString()
          : String(mapQuery.data.builtAt))
        : null,
      hasSystemMap: true,
      hasBrain: (brainStatus?.memoryCount ?? 0) > 0,
    }
  }, [mapQuery.data, suggestionsQuery.data, brainQuery.data])

  return {
    ...result,
    isLoading: mapQuery.isLoading || suggestionsQuery.isLoading,
  }
}
