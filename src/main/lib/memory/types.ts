/**
 * Memory Vault type definitions
 *
 * Three-tier memory architecture:
 * - Hot: MEMORY.md (always loaded, max 200 lines)
 * - Warm: topics/*.md (loaded on demand, max 500 lines each)
 * - Cold: sessions/*.md + log.md (searchable only)
 */

export type MemoryCategory =
  | "project-identity"
  | "architecture-decision"
  | "operational-knowledge"
  | "current-context"
  | "rejected-approach"
  | "convention"
  | "debugging-pattern"

export type MemoryConfidence = "low" | "medium" | "high"

export type MemoryStatus = "active" | "deprecated" | "archived"

export type MemoryTier = "hot" | "warm" | "cold"

/** YAML frontmatter for a memory entry */
export interface MemoryEntryMeta {
  id: string
  created: string // ISO 8601
  category: MemoryCategory
  confidence: MemoryConfidence
  source: string // chat ID or "user"
  tags: string[]
  status: MemoryStatus
  lastReferenced: string // ISO 8601
}

/** A single memory entry (frontmatter + markdown body) */
export interface MemoryEntry {
  meta: MemoryEntryMeta
  body: string // Markdown content after frontmatter
}

/** Category → default topic filename mapping */
export const CATEGORY_TOPIC_FILE: Record<MemoryCategory, string> = {
  "project-identity": "project-identity.md",
  "architecture-decision": "architecture-decisions.md",
  "operational-knowledge": "operational-knowledge.md",
  "current-context": "current-context.md",
  "rejected-approach": "rejected-approaches.md",
  "convention": "conventions.md",
  "debugging-pattern": "debugging-patterns.md",
}

/** Metadata about a topic file */
export interface TopicFile {
  filename: string
  path: string
  entryCount: number
  lineCount: number
  categories: MemoryCategory[]
}

/** Summary of a session log */
export interface SessionLog {
  filename: string
  path: string
  date: string // YYYY-MM-DD
  slug: string
  summary: string // First line / title
}

/** Full vault state */
export interface MemoryVault {
  projectPath: string
  vaultPath: string
  memoryMd: string // Raw MEMORY.md content
  topics: TopicFile[]
  sessionLogs: SessionLog[]
}

/** Size limits */
export const MEMORY_MD_MAX_LINES = 200
export const TOPIC_FILE_MAX_LINES = 500
export const MAX_ENTRIES_PER_VAULT = 500

/** Directory structure constants */
export const VAULT_DIR = ".2code/memory"
export const TOPICS_DIR = "topics"
export const SESSIONS_DIR = "sessions"
export const MEMORY_MD = "MEMORY.md"
export const LOG_MD = "log.md"
