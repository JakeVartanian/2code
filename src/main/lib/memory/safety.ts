/**
 * Memory Safety
 *
 * Vault backup, entry cap enforcement, and import/export.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  copyFileSync,
  statSync,
} from "fs"
import { join, basename } from "path"
import {
  VAULT_DIR,
  TOPICS_DIR,
  SESSIONS_DIR,
  MEMORY_MD,
  LOG_MD,
  MAX_ENTRIES_PER_VAULT,
} from "./types"
import { getVaultPath, getAllEntries, readTopicEntries, writeTopicFile, readMemoryMd } from "./vault"
import { parseTopicFile, serializeTopicFile } from "./entry-parser"
import type { MemoryEntry } from "./types"

const BACKUPS_DIR = ".backups"
const MAX_BACKUPS = 5

/**
 * Create a timestamped backup of the entire vault.
 * Called before consolidation to prevent data loss.
 */
export function createVaultBackup(projectPath: string): string | null {
  const vaultPath = getVaultPath(projectPath)
  if (!existsSync(vaultPath)) return null

  const backupsPath = join(vaultPath, BACKUPS_DIR)
  if (!existsSync(backupsPath)) mkdirSync(backupsPath, { recursive: true })

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)
  const backupDir = join(backupsPath, timestamp)
  mkdirSync(backupDir, { recursive: true })

  // Copy MEMORY.md
  const memoryMdSrc = join(vaultPath, MEMORY_MD)
  if (existsSync(memoryMdSrc)) {
    copyFileSync(memoryMdSrc, join(backupDir, MEMORY_MD))
  }

  // Copy log.md
  const logSrc = join(vaultPath, LOG_MD)
  if (existsSync(logSrc)) {
    copyFileSync(logSrc, join(backupDir, LOG_MD))
  }

  // Copy topic files
  const topicsSrc = join(vaultPath, TOPICS_DIR)
  if (existsSync(topicsSrc)) {
    const topicsBackup = join(backupDir, TOPICS_DIR)
    mkdirSync(topicsBackup, { recursive: true })
    for (const filename of readdirSync(topicsSrc)) {
      const srcFile = join(topicsSrc, filename)
      if (statSync(srcFile).isFile()) {
        copyFileSync(srcFile, join(topicsBackup, filename))
      }
    }
  }

  // Prune old backups (keep MAX_BACKUPS most recent)
  pruneOldBackups(backupsPath)

  console.log(`[Memory/Safety] Backup created: ${backupDir}`)
  return backupDir
}

/**
 * Remove old backups, keeping only the most recent ones.
 */
function pruneOldBackups(backupsPath: string): void {
  const entries = readdirSync(backupsPath)
    .filter((name) => {
      const fullPath = join(backupsPath, name)
      return statSync(fullPath).isDirectory() && !name.startsWith(".")
    })
    .sort()
    .reverse()

  // Remove backups beyond the limit
  for (let i = MAX_BACKUPS; i < entries.length; i++) {
    const oldBackup = join(backupsPath, entries[i]!)
    try {
      // Remove directory recursively
      const { rmSync } = require("fs")
      rmSync(oldBackup, { recursive: true, force: true })
      console.log(`[Memory/Safety] Pruned old backup: ${entries[i]}`)
    } catch (err) {
      console.warn(`[Memory/Safety] Failed to prune backup ${entries[i]}:`, err)
    }
  }
}

/**
 * Check if the vault has reached the entry cap.
 * Returns the number of entries over the limit (0 if under).
 */
export function checkEntryLimit(projectPath: string): {
  total: number
  limit: number
  overLimit: number
} {
  const entries = getAllEntries(projectPath)
  const total = entries.length
  return {
    total,
    limit: MAX_ENTRIES_PER_VAULT,
    overLimit: Math.max(0, total - MAX_ENTRIES_PER_VAULT),
  }
}

/**
 * Enforce the entry cap by archiving oldest entries.
 * Called after addEntry if the vault is over limit.
 */
export function enforceEntryLimit(projectPath: string): number {
  const { total, overLimit } = checkEntryLimit(projectPath)
  if (overLimit <= 0) return 0

  const vaultPath = getVaultPath(projectPath)
  const topicsPath = join(vaultPath, TOPICS_DIR)
  if (!existsSync(topicsPath)) return 0

  // Collect all entries with their source file, sorted by lastReferenced (oldest first)
  const allEntries: { entry: MemoryEntry; filename: string }[] = []
  for (const filename of readdirSync(topicsPath)) {
    if (!filename.endsWith(".md")) continue
    const entries = readTopicEntries(projectPath, filename)
    for (const entry of entries) {
      allEntries.push({ entry, filename })
    }
  }

  allEntries.sort((a, b) => {
    const aDate = new Date(a.entry.meta.lastReferenced).getTime()
    const bDate = new Date(b.entry.meta.lastReferenced).getTime()
    return aDate - bDate // oldest first
  })

  // Archive the oldest entries
  const toRemove = allEntries.slice(0, overLimit)
  const removedIds = new Set(toRemove.map((t) => t.entry.meta.id))

  // Group removals by file and rewrite
  const fileRemovals = new Map<string, Set<string>>()
  for (const { entry, filename } of toRemove) {
    const set = fileRemovals.get(filename) || new Set()
    set.add(entry.meta.id)
    fileRemovals.set(filename, set)
  }

  let removed = 0
  for (const [filename, ids] of fileRemovals) {
    const entries = readTopicEntries(projectPath, filename)
    const filtered = entries.filter((e) => !ids.has(e.meta.id))
    writeTopicFile(projectPath, filename, filtered)
    removed += ids.size
  }

  console.log(`[Memory/Safety] Enforced entry limit: removed ${removed} oldest entries (total was ${total})`)
  return removed
}

/**
 * Export the entire vault as a single markdown file.
 */
export function exportVault(projectPath: string): string {
  const lines: string[] = []
  lines.push("# Memory Vault Export")
  lines.push(`# Exported: ${new Date().toISOString()}`)
  lines.push(`# Project: ${projectPath}`)
  lines.push("")

  // MEMORY.md
  const memoryMd = readMemoryMd(projectPath)
  if (memoryMd) {
    lines.push("---")
    lines.push("## MEMORY.md")
    lines.push("---")
    lines.push(memoryMd)
    lines.push("")
  }

  // Topic files
  const vaultPath = getVaultPath(projectPath)
  const topicsPath = join(vaultPath, TOPICS_DIR)
  if (existsSync(topicsPath)) {
    for (const filename of readdirSync(topicsPath).sort()) {
      if (!filename.endsWith(".md")) continue
      const content = readFileSync(join(topicsPath, filename), "utf-8")
      if (content.trim()) {
        lines.push("---")
        lines.push(`## ${TOPICS_DIR}/${filename}`)
        lines.push("---")
        lines.push(content)
        lines.push("")
      }
    }
  }

  return lines.join("\n")
}

/**
 * Import entries from an exported vault markdown file.
 * Parses the export format and adds entries to the current vault.
 * Returns count of entries imported.
 */
export function importVault(
  projectPath: string,
  exportContent: string,
): { imported: number; skipped: number } {
  const vaultPath = getVaultPath(projectPath)
  const topicsPath = join(vaultPath, TOPICS_DIR)

  // Parse sections from the export
  const sections = exportContent.split(/^---$/m)
  let imported = 0
  let skipped = 0

  for (let i = 0; i < sections.length; i++) {
    const section = sections[i]!.trim()

    // Look for topic file headers
    const topicMatch = section.match(/^## topics\/(.+\.md)$/m)
    if (topicMatch && i + 1 < sections.length) {
      const filename = topicMatch[1]!
      const content = sections[i + 1]!.trim()

      if (content) {
        const newEntries = parseTopicFile(content)
        if (newEntries.length > 0) {
          // Merge with existing entries
          const existing = readTopicEntries(projectPath, filename)
          const existingIds = new Set(existing.map((e) => e.meta.id))

          for (const entry of newEntries) {
            if (!existingIds.has(entry.meta.id)) {
              existing.push(entry)
              imported++
            } else {
              skipped++
            }
          }

          writeTopicFile(projectPath, filename, existing)
        }
      }
      i++ // Skip the content section since we consumed it
    }
  }

  return { imported, skipped }
}
