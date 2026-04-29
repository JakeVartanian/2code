/**
 * useArchitectureData — fetches system map zones and enriches them
 * with open audit finding counts from the canonical auditFindings table.
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

  // 2. Open audit findings summary per zone (canonical source of truth)
  const findingSummaryQuery = trpc.ambient.getZoneFindingSummary.useQuery(
    { projectId: projectId! },
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
    const findingSummary = findingSummaryQuery.data ?? {}
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

    // Enrich zones with audit finding data
    const enriched: EnrichedZone[] = rawZones.map((zone) => {
      const summary = findingSummary[zone.id]
      return {
        ...zone,
        confidence: summary?.avgConfidence ?? 0,
        severity: (summary?.maxSeverity ?? "none") as Severity,
        issueCount: summary?.issueCount ?? 0,
        lastAuditedAt: summary?.lastAuditedAt ?? null,
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
  }, [mapQuery.data, findingSummaryQuery.data, brainQuery.data])

  return {
    ...result,
    isLoading: mapQuery.isLoading || findingSummaryQuery.isLoading,
  }
}
