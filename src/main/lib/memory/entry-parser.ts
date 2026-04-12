/**
 * Parse and serialize memory entries with YAML frontmatter + markdown body
 */

import type { MemoryEntry, MemoryEntryMeta, MemoryCategory, MemoryConfidence, MemoryStatus } from "./types"

const FRONTMATTER_REGEX = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/

const VALID_CATEGORIES: Set<string> = new Set([
  "project-identity",
  "architecture-decision",
  "operational-knowledge",
  "current-context",
  "rejected-approach",
  "convention",
  "debugging-pattern",
])

const VALID_CONFIDENCES: Set<string> = new Set(["low", "medium", "high"])
const VALID_STATUSES: Set<string> = new Set(["active", "deprecated", "archived"])

/** Parse a simple YAML key-value block (no nested objects) */
function parseSimpleYaml(yaml: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const line of yaml.split("\n")) {
    const match = line.match(/^(\w[\w-]*):\s*(.*)$/)
    if (match) {
      result[match[1]] = match[2].trim()
    }
  }
  return result
}

/** Parse a YAML array value like [tag1, tag2, tag3] or bare value */
function parseTagsValue(raw: string): string[] {
  if (!raw) return []
  // [tag1, tag2, tag3]
  const bracketMatch = raw.match(/^\[(.*)\]$/)
  if (bracketMatch) {
    return bracketMatch[1]
      .split(",")
      .map((t) => t.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean)
  }
  // single value
  return [raw.replace(/^["']|["']$/g, "")]
}

/** Parse a single memory entry from its markdown string */
export function parseEntry(raw: string): MemoryEntry | null {
  const match = raw.match(FRONTMATTER_REGEX)
  if (!match) return null

  const yamlBlock = match[1]
  const body = match[2].trim()
  const fields = parseSimpleYaml(yamlBlock)

  const category = fields.category as MemoryCategory
  if (!VALID_CATEGORIES.has(category)) return null

  const confidence = (fields.confidence || "medium") as MemoryConfidence
  const status = (fields.status || "active") as MemoryStatus

  const meta: MemoryEntryMeta = {
    id: fields.id || "",
    created: fields.created || new Date().toISOString(),
    category,
    confidence: VALID_CONFIDENCES.has(confidence) ? confidence : "medium",
    source: fields.source || "unknown",
    tags: parseTagsValue(fields.tags || ""),
    status: VALID_STATUSES.has(status) ? status : "active",
    lastReferenced: fields.lastReferenced || fields["last-referenced"] || fields.created || new Date().toISOString(),
  }

  return { meta, body }
}

/** Parse all entries from a topic file (entries separated by \n---\n) */
export function parseTopicFile(content: string): MemoryEntry[] {
  if (!content.trim()) return []

  // Split on entry boundaries: a line that is exactly "---" preceded by a blank line
  // Each entry starts with --- (frontmatter open)
  const entries: MemoryEntry[] = []

  // Split the file into chunks starting with ---
  const chunks = content.split(/\n(?=---\n)/)

  for (const chunk of chunks) {
    const trimmed = chunk.trim()
    if (!trimmed || !trimmed.startsWith("---")) continue
    const entry = parseEntry(trimmed)
    if (entry) entries.push(entry)
  }

  return entries
}

/** Serialize a memory entry back to markdown with frontmatter */
export function serializeEntry(entry: MemoryEntry): string {
  const { meta, body } = entry
  const lines = [
    "---",
    `id: ${meta.id}`,
    `created: ${meta.created}`,
    `category: ${meta.category}`,
    `confidence: ${meta.confidence}`,
    `source: ${meta.source}`,
    `tags: [${meta.tags.join(", ")}]`,
    `status: ${meta.status}`,
    `lastReferenced: ${meta.lastReferenced}`,
    "---",
    "",
    body,
  ]
  return lines.join("\n")
}

/** Serialize multiple entries into a topic file */
export function serializeTopicFile(entries: MemoryEntry[]): string {
  return entries.map(serializeEntry).join("\n\n")
}
