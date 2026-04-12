/**
 * Skill Memory Context
 *
 * Loads specified topic files for injection into worker/skill context.
 * Given a skill's memory_reads list, formats the content for prompt injection.
 */

import { readTopicFile, readTopicEntries, hasVault } from "./vault"
import { readMemoryMdCached } from "./cache"
import type { MemoryEntry } from "./types"

/**
 * Load and format memory context from a list of topic filenames.
 * Returns a formatted string suitable for injection into a worker's system prompt.
 */
export function loadSkillMemoryContext(
  projectPath: string,
  memoryReads: string[],
): string {
  if (!hasVault(projectPath) || memoryReads.length === 0) return ""

  const parts: string[] = []

  for (const filename of memoryReads) {
    // Special case: "MEMORY.md" loads the hot-tier index
    if (filename === "MEMORY.md" || filename === "memory.md") {
      const content = readMemoryMdCached(projectPath)
      if (content) {
        parts.push(`## MEMORY.md\n${content}`)
      }
      continue
    }

    // Ensure .md extension
    const normalizedFilename = filename.endsWith(".md") ? filename : `${filename}.md`
    const content = readTopicFile(projectPath, normalizedFilename)
    if (content) {
      parts.push(`## ${normalizedFilename}\n${content}`)
    }
  }

  if (parts.length === 0) return ""
  return `<skill-memory>\n${parts.join("\n\n")}\n</skill-memory>`
}

/**
 * Extract memory entries from worker output based on memory_writes declarations.
 * Looks for structured JSON blocks in the output tagged with memory write markers.
 */
export function extractSkillMemoryWrites(
  outputText: string,
  memoryWrites: string[],
): { filename: string; entries: Partial<MemoryEntry>[] }[] {
  if (memoryWrites.length === 0) return []

  const results: { filename: string; entries: Partial<MemoryEntry>[] }[] = []

  // Look for memory write blocks in the output
  const memoryBlockRegex = /```(?:memory|json:memory)\s*\n?([\s\S]*?)\n?\s*```/g
  let match: RegExpExecArray | null

  while ((match = memoryBlockRegex.exec(outputText)) !== null) {
    try {
      const parsed = JSON.parse(match[1]!)
      if (Array.isArray(parsed)) {
        // Array of entries with target filename
        for (const item of parsed) {
          if (item.topic && memoryWrites.includes(item.topic)) {
            const filename = item.topic.endsWith(".md") ? item.topic : `${item.topic}.md`
            const existing = results.find((r) => r.filename === filename)
            const entry: Partial<MemoryEntry> = {
              body: item.content || item.body || "",
              meta: {
                id: "",
                created: new Date().toISOString(),
                category: item.category || "operational-knowledge",
                confidence: item.confidence || "medium",
                source: "skill",
                tags: item.tags || [],
                status: "active",
                lastReferenced: new Date().toISOString(),
              },
            }
            if (existing) {
              existing.entries.push(entry)
            } else {
              results.push({ filename, entries: [entry] })
            }
          }
        }
      } else if (parsed.topic && memoryWrites.includes(parsed.topic)) {
        // Single entry
        const filename = parsed.topic.endsWith(".md") ? parsed.topic : `${parsed.topic}.md`
        results.push({
          filename,
          entries: [{
            body: parsed.content || parsed.body || "",
            meta: {
              id: "",
              created: new Date().toISOString(),
              category: parsed.category || "operational-knowledge",
              confidence: parsed.confidence || "medium",
              source: "skill",
              tags: parsed.tags || [],
              status: "active",
              lastReferenced: new Date().toISOString(),
            },
          }],
        })
      }
    } catch {
      // Invalid JSON — skip
    }
  }

  return results
}
