/**
 * System map freshness checker — detects when the system map has drifted
 * from the actual codebase (uncovered files, dead linkedFiles references).
 *
 * Cost: zero (filesystem checks only). Called from processFileBatch().
 */

import { existsSync } from "fs"
import { join } from "path"
import type { SystemZone } from "../../../shared/system-map-types"

// In-memory counters (reset daily via resetDailyCounters)
const uncoveredFileCounters = new Map<string, Set<string>>() // projectId → uncovered files
let lastResetDay = new Date().toDateString()

function ensureReset(projectId: string): Set<string> {
  const today = new Date().toDateString()
  if (today !== lastResetDay) {
    uncoveredFileCounters.clear()
    lastResetDay = today
  }
  if (!uncoveredFileCounters.has(projectId)) {
    uncoveredFileCounters.set(projectId, new Set())
  }
  return uncoveredFileCounters.get(projectId)!
}

export interface MapFreshnessResult {
  type: "refresh-system-map" | "refresh-zone"
  title: string
  description: string
  details: Record<string, unknown>
}

/**
 * Check if changed files are covered by the system map zones,
 * and whether zone linkedFiles still exist on disk.
 *
 * Returns maintenance action suggestions (caller creates the actual actions).
 */
export function checkMapFreshness(
  projectId: string,
  projectPath: string,
  changedFiles: string[],
  zones: SystemZone[],
): MapFreshnessResult[] {
  const results: MapFreshnessResult[] = []

  // Build set of all files covered by any zone
  const coveredFiles = new Set<string>()
  for (const zone of zones) {
    for (const f of zone.linkedFiles) {
      coveredFiles.add(f)
    }
  }

  // Track uncovered files (source files only, skip config/assets)
  const uncovered = ensureReset(projectId)
  for (const changed of changedFiles) {
    if (!coveredFiles.has(changed) && isSourceFile(changed)) {
      uncovered.add(changed)
    }
  }

  // After 5+ uncovered files: suggest system map refresh
  if (uncovered.size >= 5) {
    results.push({
      type: "refresh-system-map",
      title: `System map needs refresh — ${uncovered.size} files not in any zone`,
      description: `Files like ${[...uncovered].slice(0, 3).join(", ")} are not covered by any zone in the system map.`,
      details: { uncoveredFiles: [...uncovered].slice(0, 10), count: uncovered.size },
    })
  }

  // Check for dead linkedFiles per zone (files that no longer exist)
  for (const zone of zones) {
    const deadFiles: string[] = []
    for (const f of zone.linkedFiles) {
      const fullPath = join(projectPath, f)
      if (!existsSync(fullPath)) {
        deadFiles.push(f)
      }
    }
    if (deadFiles.length >= 2) {
      results.push({
        type: "refresh-zone" as any, // Will use "refresh-system-map" action type
        title: `Zone "${zone.name}" has ${deadFiles.length} stale file references`,
        description: `Files no longer exist: ${deadFiles.slice(0, 3).join(", ")}${deadFiles.length > 3 ? ` (+${deadFiles.length - 3} more)` : ""}`,
        details: { zoneId: zone.id, zoneName: zone.name, deadFiles },
      })
    }
  }

  return results
}

/**
 * Flag a project's system map for refresh. Creates a pending maintenance action
 * if one doesn't already exist. Called after memory consolidation/enrichment
 * affects architecture-related categories.
 */
export function flagMapForRefresh(projectId: string, reason: string): void {
  try {
    const { getDatabase } = require("../db")
    const { maintenanceActions } = require("../db/schema")
    const { eq, and } = require("drizzle-orm")
    const { createId } = require("../db/utils")

    const db = getDatabase()

    // Check if a pending refresh action already exists
    const existing = db.select({ id: maintenanceActions.id })
      .from(maintenanceActions)
      .where(and(
        eq(maintenanceActions.projectId, projectId),
        eq(maintenanceActions.type, "refresh-system-map"),
        eq(maintenanceActions.status, "pending"),
      ))
      .get()

    if (existing) return // Already flagged

    const actionId = createId()
    db.insert(maintenanceActions)
      .values({
        id: actionId,
        projectId,
        type: "refresh-system-map",
        title: "System map may need refresh",
        description: reason,
        details: JSON.stringify({ trigger: "memory-evolution" }),
      })
      .run()

    console.log(`[MapFreshness] Flagged map for refresh: ${reason}`)
  } catch (err) {
    // Non-critical
    console.warn("[MapFreshness] Failed to flag map refresh:", err)
  }
}

function isSourceFile(path: string): boolean {
  return /\.(ts|tsx|js|jsx|py|go|rs|java|rb|css|scss|vue|svelte)$/.test(path)
}
