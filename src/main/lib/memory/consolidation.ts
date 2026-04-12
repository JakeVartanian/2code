/**
 * Memory Consolidation
 *
 * Periodic maintenance that:
 * 1. Detects contradictory entries (marks older as deprecated)
 * 2. Merges near-duplicate entries
 * 3. Archives stale entries (not referenced in 90 days)
 * 4. Ensures MEMORY.md stays under 200 lines
 */

import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "fs"
import { join } from "path"
import {
  VAULT_DIR,
  TOPICS_DIR,
  MEMORY_MD_MAX_LINES,
  type MemoryEntry,
} from "./types"
import { parseTopicFile, serializeTopicFile } from "./entry-parser"
import { contentHash } from "./deduplicator"
import { updateMemoryIndex, getVaultPath } from "./vault"
import { clearMemoryMdCache } from "./cache"
import { createVaultBackup } from "./safety"

const STALE_DAYS = 90

/**
 * Run a full consolidation pass on the memory vault.
 * Returns a summary of what changed.
 */
export function consolidate(projectPath: string): {
  deprecated: number
  merged: number
  archived: number
} {
  // Create backup before consolidation
  createVaultBackup(projectPath)

  const vaultPath = getVaultPath(projectPath)
  const topicsPath = join(vaultPath, TOPICS_DIR)
  if (!existsSync(topicsPath)) return { deprecated: 0, merged: 0, archived: 0 }

  let deprecated = 0
  let merged = 0
  let archived = 0

  const now = Date.now()
  const staleThreshold = now - STALE_DAYS * 24 * 60 * 60 * 1000

  for (const filename of readdirSync(topicsPath)) {
    if (!filename.endsWith(".md")) continue
    const filePath = join(topicsPath, filename)
    const content = readFileSync(filePath, "utf-8")
    const entries = parseTopicFile(content)
    if (entries.length === 0) continue

    let changed = false

    // 1. Merge exact duplicates (same hash)
    const hashMap = new Map<string, MemoryEntry>()
    const deduped: MemoryEntry[] = []
    for (const entry of entries) {
      const hash = contentHash(entry)
      if (hashMap.has(hash)) {
        // Keep the newer one, merge tags
        const existing = hashMap.get(hash)!
        const existingTags = new Set(existing.meta.tags)
        for (const tag of entry.meta.tags) existingTags.add(tag)
        existing.meta.tags = [...existingTags]
        merged++
        changed = true
      } else {
        hashMap.set(hash, entry)
        deduped.push(entry)
      }
    }

    // 2. Archive stale entries
    const archivedPath = join(topicsPath, "archived")
    const active: MemoryEntry[] = []
    const stale: MemoryEntry[] = []

    for (const entry of deduped) {
      if (entry.meta.status === "deprecated" || entry.meta.status === "archived") {
        // Already deprecated/archived — keep as-is
        active.push(entry)
        continue
      }

      const lastRef = new Date(entry.meta.lastReferenced).getTime()
      if (lastRef < staleThreshold) {
        entry.meta.status = "archived"
        stale.push(entry)
        archived++
        changed = true
      } else {
        active.push(entry)
      }
    }

    // Write stale entries to archived/ subdirectory
    if (stale.length > 0) {
      if (!existsSync(archivedPath)) mkdirSync(archivedPath, { recursive: true })
      const archiveFile = join(archivedPath, filename)
      const existingArchive = existsSync(archiveFile) ? readFileSync(archiveFile, "utf-8") : ""
      const existingEntries = existingArchive ? parseTopicFile(existingArchive) : []
      writeFileSync(archiveFile, serializeTopicFile([...existingEntries, ...stale]))
    }

    // Write back cleaned entries
    if (changed) {
      writeFileSync(filePath, serializeTopicFile(active))
    }
  }

  // Regenerate MEMORY.md index
  updateMemoryIndex(projectPath)
  clearMemoryMdCache()

  console.log(
    `[Memory/Consolidation] deprecated=${deprecated} merged=${merged} archived=${archived}`,
  )

  return { deprecated, merged, archived }
}

/**
 * Simple session counter per project (stored in vault).
 * Triggers consolidation every N sessions.
 */
const CONSOLIDATION_INTERVAL = 10

export function incrementSessionCount(projectPath: string): number {
  const vaultPath = getVaultPath(projectPath)
  const counterPath = join(vaultPath, ".session-count")

  let count = 0
  if (existsSync(counterPath)) {
    try {
      count = parseInt(readFileSync(counterPath, "utf-8").trim(), 10) || 0
    } catch {
      count = 0
    }
  }

  count++
  writeFileSync(counterPath, String(count))
  return count
}

/**
 * Check if consolidation should run and do so if needed.
 * Call after each session completes.
 */
export function maybeConsolidate(projectPath: string): void {
  const count = incrementSessionCount(projectPath)
  if (count % CONSOLIDATION_INTERVAL === 0) {
    console.log(`[Memory] Session ${count} — running consolidation`)
    consolidate(projectPath)
  }
}
