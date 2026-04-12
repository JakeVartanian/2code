/**
 * Memory Vault Manager
 *
 * Manages the filesystem-native memory vault at <project>/.2code/memory/
 * Handles init, read, write, and size enforcement.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from "fs"
import { join, basename } from "path"
import {
  VAULT_DIR,
  TOPICS_DIR,
  SESSIONS_DIR,
  MEMORY_MD,
  LOG_MD,
  MEMORY_MD_MAX_LINES,
  TOPIC_FILE_MAX_LINES,
  CATEGORY_TOPIC_FILE,
  type MemoryEntry,
  type MemoryVault,
  type TopicFile,
  type SessionLog,
  type MemoryCategory,
} from "./types"
import { parseTopicFile, serializeEntry, serializeTopicFile } from "./entry-parser"
import { findDuplicate } from "./deduplicator"
import { sanitize } from "./sanitizer"
import { createId } from "../db/utils"
import { enforceEntryLimit } from "./safety"

/** Get the vault directory path for a project */
export function getVaultPath(projectPath: string): string {
  return join(projectPath, VAULT_DIR)
}

/** Initialize the vault directory structure if it doesn't exist */
export function initVault(projectPath: string): string {
  const vaultPath = getVaultPath(projectPath)
  const topicsPath = join(vaultPath, TOPICS_DIR)
  const sessionsPath = join(vaultPath, SESSIONS_DIR)

  if (!existsSync(vaultPath)) mkdirSync(vaultPath, { recursive: true })
  if (!existsSync(topicsPath)) mkdirSync(topicsPath, { recursive: true })
  if (!existsSync(sessionsPath)) mkdirSync(sessionsPath, { recursive: true })

  // Create MEMORY.md if it doesn't exist
  const memoryMdPath = join(vaultPath, MEMORY_MD)
  if (!existsSync(memoryMdPath)) {
    writeFileSync(
      memoryMdPath,
      [
        "# Project Memory",
        "",
        "This file is automatically maintained by 2Code. It serves as a concise index",
        "of project knowledge. Detailed entries live in `topics/` files.",
        "",
        "## Topics",
        "",
        "_(No memories yet — they'll appear here as you work.)_",
        "",
      ].join("\n"),
    )
  }

  // Create log.md if it doesn't exist
  const logPath = join(vaultPath, LOG_MD)
  if (!existsSync(logPath)) {
    writeFileSync(logPath, "# Memory Changelog\n\n")
  }

  // Gitignore session logs
  const sessionsGitignore = join(sessionsPath, ".gitignore")
  if (!existsSync(sessionsGitignore)) {
    writeFileSync(sessionsGitignore, "*\n!.gitignore\n")
  }

  return vaultPath
}

/** Check if a vault exists for a project */
export function hasVault(projectPath: string): boolean {
  return existsSync(join(getVaultPath(projectPath), MEMORY_MD))
}

/** Read MEMORY.md content (hot tier) */
export function readMemoryMd(projectPath: string): string {
  const memoryMdPath = join(getVaultPath(projectPath), MEMORY_MD)
  if (!existsSync(memoryMdPath)) return ""
  return readFileSync(memoryMdPath, "utf-8")
}

/** Read a topic file and parse its entries */
export function readTopicEntries(projectPath: string, filename: string): MemoryEntry[] {
  const topicPath = join(getVaultPath(projectPath), TOPICS_DIR, filename)
  if (!existsSync(topicPath)) return []
  const content = readFileSync(topicPath, "utf-8")
  return parseTopicFile(content)
}

/** Read raw topic file content */
export function readTopicFile(projectPath: string, filename: string): string {
  const topicPath = join(getVaultPath(projectPath), TOPICS_DIR, filename)
  if (!existsSync(topicPath)) return ""
  return readFileSync(topicPath, "utf-8")
}

/** Write entries to a topic file, enforcing line limit */
export function writeTopicFile(projectPath: string, filename: string, entries: MemoryEntry[]): void {
  const topicPath = join(getVaultPath(projectPath), TOPICS_DIR, filename)
  const content = serializeTopicFile(entries)

  // Enforce line limit — trim oldest entries if over
  const lines = content.split("\n")
  if (lines.length > TOPIC_FILE_MAX_LINES) {
    // Keep the newest entries (they're appended at the end)
    // Re-parse to get entries, drop the oldest until under limit
    while (entries.length > 1) {
      entries.shift() // Remove oldest
      const trimmed = serializeTopicFile(entries)
      if (trimmed.split("\n").length <= TOPIC_FILE_MAX_LINES) break
    }
  }

  writeFileSync(topicPath, serializeTopicFile(entries))
}

/** Write MEMORY.md content, enforcing line limit */
export function writeMemoryMd(projectPath: string, content: string): void {
  const memoryMdPath = join(getVaultPath(projectPath), MEMORY_MD)
  const lines = content.split("\n")
  if (lines.length > MEMORY_MD_MAX_LINES) {
    writeFileSync(memoryMdPath, lines.slice(0, MEMORY_MD_MAX_LINES).join("\n") + "\n")
  } else {
    writeFileSync(memoryMdPath, content)
  }
}

/**
 * Add a memory entry to the vault.
 * Handles: ID assignment, sanitization, deduplication, topic file writing, index update.
 * Returns the entry if written, null if it was a duplicate.
 */
export function addEntry(
  projectPath: string,
  entry: MemoryEntry,
): MemoryEntry | null {
  // Ensure vault exists
  initVault(projectPath)

  // Assign ID if missing
  if (!entry.meta.id) {
    entry.meta.id = createId()
  }

  // Sanitize body
  entry.body = sanitize(entry.body)

  // Determine target topic file
  const topicFilename = CATEGORY_TOPIC_FILE[entry.meta.category]
  const existing = readTopicEntries(projectPath, topicFilename)

  // Check for duplicates
  const dupe = findDuplicate(entry, existing)
  if (dupe) {
    // Update last_referenced on the existing entry instead
    dupe.meta.lastReferenced = new Date().toISOString()
    writeTopicFile(projectPath, topicFilename, existing)
    return null
  }

  // Append entry
  existing.push(entry)
  writeTopicFile(projectPath, topicFilename, existing)

  // Enforce entry cap (archive oldest if over 500)
  enforceEntryLimit(projectPath)

  // Update MEMORY.md index
  updateMemoryIndex(projectPath)

  // Append to log
  appendLog(projectPath, `Added: [${entry.meta.category}] ${entry.body.split("\n")[0]?.slice(0, 80)}`)

  return entry
}

/** Delete an entry by ID from its topic file */
export function deleteEntry(projectPath: string, entryId: string): boolean {
  const vaultPath = getVaultPath(projectPath)
  const topicsPath = join(vaultPath, TOPICS_DIR)
  if (!existsSync(topicsPath)) return false

  for (const filename of readdirSync(topicsPath)) {
    if (!filename.endsWith(".md")) continue
    const entries = readTopicEntries(projectPath, filename)
    const index = entries.findIndex((e) => e.meta.id === entryId)
    if (index !== -1) {
      entries.splice(index, 1)
      writeTopicFile(projectPath, filename, entries)
      updateMemoryIndex(projectPath)
      return true
    }
  }
  return false
}

/** Get all entries across all topic files */
export function getAllEntries(projectPath: string): MemoryEntry[] {
  const topicsPath = join(getVaultPath(projectPath), TOPICS_DIR)
  if (!existsSync(topicsPath)) return []

  const entries: MemoryEntry[] = []
  for (const filename of readdirSync(topicsPath)) {
    if (!filename.endsWith(".md")) continue
    entries.push(...readTopicEntries(projectPath, filename))
  }
  return entries
}

/** Get metadata about all topic files */
export function getTopicFiles(projectPath: string): TopicFile[] {
  const topicsPath = join(getVaultPath(projectPath), TOPICS_DIR)
  if (!existsSync(topicsPath)) return []

  const topics: TopicFile[] = []
  for (const filename of readdirSync(topicsPath)) {
    if (!filename.endsWith(".md")) continue
    const filePath = join(topicsPath, filename)
    const content = readFileSync(filePath, "utf-8")
    const entries = parseTopicFile(content)
    const categories = [...new Set(entries.map((e) => e.meta.category))]

    topics.push({
      filename,
      path: filePath,
      entryCount: entries.length,
      lineCount: content.split("\n").length,
      categories,
    })
  }
  return topics
}

/** Get session log summaries */
export function getSessionLogs(projectPath: string, limit = 20): SessionLog[] {
  const sessionsPath = join(getVaultPath(projectPath), SESSIONS_DIR)
  if (!existsSync(sessionsPath)) return []

  const logs: SessionLog[] = []
  const files = readdirSync(sessionsPath)
    .filter((f) => f.endsWith(".md") && f !== ".gitignore")
    .sort()
    .reverse()
    .slice(0, limit)

  for (const filename of files) {
    const filePath = join(sessionsPath, filename)
    const content = readFileSync(filePath, "utf-8")
    const firstLine = content.split("\n").find((l) => l.trim() && !l.startsWith("#"))?.trim() || ""
    // Parse date from filename: YYYY-MM-DD-slug.md
    const dateMatch = filename.match(/^(\d{4}-\d{2}-\d{2})-(.+)\.md$/)

    logs.push({
      filename,
      path: filePath,
      date: dateMatch?.[1] || "",
      slug: dateMatch?.[2] || basename(filename, ".md"),
      summary: firstLine,
    })
  }
  return logs
}

/** Get full vault state */
export function getVault(projectPath: string): MemoryVault {
  const vaultPath = getVaultPath(projectPath)
  return {
    projectPath,
    vaultPath,
    memoryMd: readMemoryMd(projectPath),
    topics: getTopicFiles(projectPath),
    sessionLogs: getSessionLogs(projectPath),
  }
}

/** Regenerate MEMORY.md index from topic files */
export function updateMemoryIndex(projectPath: string): void {
  const topics = getTopicFiles(projectPath)

  const lines: string[] = [
    "# Project Memory",
    "",
    "This file is automatically maintained by 2Code. It serves as a concise index",
    "of project knowledge. Detailed entries live in `topics/` files.",
    "",
  ]

  if (topics.length === 0 || topics.every((t) => t.entryCount === 0)) {
    lines.push("## Topics", "", "_(No memories yet — they'll appear here as you work.)_", "")
  } else {
    lines.push("## Topics", "")
    for (const topic of topics) {
      if (topic.entryCount === 0) continue
      lines.push(`- **${topic.filename}** — ${topic.entryCount} entries`)

      // Add one-line summaries of the most recent entries (up to 3)
      const entries = readTopicEntries(projectPath, topic.filename)
      const recent = entries
        .filter((e) => e.meta.status === "active")
        .slice(-3)
      for (const entry of recent) {
        const title = entry.body.split("\n")[0]?.replace(/^#+\s*/, "").slice(0, 80) || "(untitled)"
        lines.push(`  - ${title}`)
      }
    }
    lines.push("")

    // Add summary stats
    const totalEntries = topics.reduce((sum, t) => sum + t.entryCount, 0)
    lines.push(`**Total entries:** ${totalEntries}`, "")
  }

  writeMemoryMd(projectPath, lines.join("\n"))
}

/** Append a line to log.md */
function appendLog(projectPath: string, message: string): void {
  const logPath = join(getVaultPath(projectPath), LOG_MD)
  if (!existsSync(logPath)) return
  const timestamp = new Date().toISOString().replace("T", " ").slice(0, 19)
  const line = `- ${timestamp} — ${message}\n`
  const existing = readFileSync(logPath, "utf-8")
  writeFileSync(logPath, existing + line)
}

/** Write a session log to the sessions directory */
export function writeSessionLog(projectPath: string, slug: string, content: string): void {
  initVault(projectPath)
  const date = new Date().toISOString().slice(0, 10)
  const filename = `${date}-${slug}.md`
  const sessionsPath = join(getVaultPath(projectPath), SESSIONS_DIR)
  writeFileSync(join(sessionsPath, filename), content)
  appendLog(projectPath, `Session: ${slug}`)
}
