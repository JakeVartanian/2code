/**
 * Memory staleness detection — invalidates memories when their linked files change
 * in ways that contradict the memory's content.
 *
 * Called by the pipeline when file changes are detected.
 * Checks if keywords from the memory still exist in the file.
 */

import { existsSync, readFileSync, statSync } from "fs"
import { join } from "path"
import { eq, and } from "drizzle-orm"
import { getDatabase } from "../db"
import { projectMemories } from "../db/schema"

/**
 * Check memories linked to changed files and mark stale ones.
 * A memory is marked stale if its key identifiers (function names, patterns)
 * no longer exist in the linked file.
 */
export function checkStaleness(
  projectId: string,
  projectPath: string,
  changedFiles: string[],
): { validated: number; markedStale: number } {
  const db = getDatabase()
  let validated = 0
  let markedStale = 0

  // Get all non-archived memories for this project that have linked files
  const memories = db.select()
    .from(projectMemories)
    .where(and(
      eq(projectMemories.projectId, projectId),
      eq(projectMemories.isArchived, false),
    ))
    .all()
    .filter(m => m.linkedFiles) // Only check memories with linked files

  for (const memory of memories) {
    const linkedFiles: string[] = JSON.parse(memory.linkedFiles!)

    // Check if any of this memory's linked files were in the changed set
    const affectedFiles = linkedFiles.filter(f => changedFiles.includes(f))
    if (affectedFiles.length === 0) continue

    // Extract keywords from memory content (function names, patterns, identifiers)
    const keywords = extractKeywords(memory.content)
    if (keywords.length === 0) {
      validated++
      continue // No keywords to check = can't determine staleness
    }

    // Check if keywords still exist in at least one linked file
    let foundInAnyFile = false
    for (const file of affectedFiles) {
      const fullPath = join(projectPath, file)
      if (!existsSync(fullPath)) {
        // File deleted — memory is stale
        continue
      }

      try {
        // Skip large files to avoid blocking the event loop
        const stat = statSync(fullPath)
        if (stat.size > 100_000) { foundInAnyFile = true; break } // Assume large files still have keywords

        const content = readFileSync(fullPath, "utf-8")
        if (keywords.some(kw => content.includes(kw))) {
          foundInAnyFile = true
          break
        }
      } catch {
        continue
      }
    }

    if (!foundInAnyFile && !memory.isStale) {
      // Keywords gone from all linked files → mark stale
      db.update(projectMemories)
        .set({
          isStale: true,
          validatedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(projectMemories.id, memory.id))
        .run()
      markedStale++
    } else if (foundInAnyFile && memory.isStale) {
      // Keywords found again → un-stale
      db.update(projectMemories)
        .set({
          isStale: false,
          validatedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(projectMemories.id, memory.id))
        .run()
      validated++
    } else {
      validated++
    }
  }

  return { validated, markedStale }
}

/**
 * Extract identifiers/keywords from memory content that can be searched for in files.
 * Looks for: function names, variable names, class names, file paths, specific patterns.
 */
function extractKeywords(content: string): string[] {
  const keywords: string[] = []

  // Extract identifiers (camelCase, PascalCase, snake_case patterns 4+ chars)
  const identifierPattern = /\b([a-zA-Z_][a-zA-Z0-9_]{3,40})\b/g
  const matches = content.match(identifierPattern) ?? []

  // Filter out common English words that aren't code identifiers
  const COMMON_WORDS = new Set([
    "this", "that", "with", "from", "have", "been", "will", "they",
    "when", "what", "which", "their", "about", "would", "could", "should",
    "always", "never", "must", "file", "files", "code", "uses", "using",
    "pattern", "project", "function", "class", "module", "component",
    "system", "apply", "applies", "change", "changes", "here", "there",
  ])

  for (const match of matches) {
    const lower = match.toLowerCase()
    if (COMMON_WORDS.has(lower)) continue

    // Keep if it looks like a code identifier (has mixed case, underscore, or is long)
    if (match.includes("_") || /[a-z][A-Z]/.test(match) || /^[A-Z][a-z]/.test(match) || match.length >= 8) {
      keywords.push(match)
    }
  }

  // Also extract quoted strings (likely specific values)
  const quotedPattern = /['"`]([^'"`]{4,40})['"`]/g
  let quotedMatch: RegExpExecArray | null
  while ((quotedMatch = quotedPattern.exec(content)) !== null) {
    keywords.push(quotedMatch[1])
  }

  // Deduplicate and limit
  return [...new Set(keywords)].slice(0, 10)
}
