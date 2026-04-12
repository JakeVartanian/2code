/**
 * Cached MEMORY.md reader with mtime tracking.
 * Same pattern as readAgentsMdCached in claude.ts.
 */

import { statSync, readFileSync } from "fs"
import { join } from "path"
import { VAULT_DIR, MEMORY_MD } from "./types"

const cache = new Map<string, { content: string; mtime: number }>()

/** Read MEMORY.md with mtime-based caching */
export function readMemoryMdCached(projectPath: string): string {
  try {
    const memoryMdPath = join(projectPath, VAULT_DIR, MEMORY_MD)
    let stats: { mtimeMs: number } | null = null
    try {
      stats = statSync(memoryMdPath)
    } catch {
      return ""
    }
    if (!stats) return ""

    const cached = cache.get(memoryMdPath)
    if (cached && cached.mtime === stats.mtimeMs) {
      return cached.content
    }

    const content = readFileSync(memoryMdPath, "utf-8")
    if (!content.trim()) return ""

    cache.set(memoryMdPath, { content, mtime: stats.mtimeMs })

    // Trim cache if too large
    if (cache.size > 50) {
      const first = cache.keys().next().value
      if (first) cache.delete(first)
    }

    return content
  } catch {
    return ""
  }
}

/** Clear the cache (e.g., after consolidation) */
export function clearMemoryMdCache(): void {
  cache.clear()
}
