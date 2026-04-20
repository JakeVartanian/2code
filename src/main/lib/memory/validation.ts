/**
 * Memory validation module — checks linked files for existence
 * and marks memories as stale when references become invalid.
 */

import { getDatabase } from "../db"
import { projectMemories } from "../db/schema"
import { eq, and } from "drizzle-orm"
import * as fs from "fs"
import * as path from "path"

export interface ValidationResult {
  totalChecked: number
  validated: number
  markedStale: number
  alreadyStale: number
  details: Array<{
    memoryId: string
    title: string
    missingFiles: string[]
    isNewlyStale: boolean
  }>
}

/**
 * Validate all memories for a project by checking linked file existence.
 * Marks memories as stale when their referenced files no longer exist.
 *
 * @param projectId - The project to validate memories for
 * @param projectPath - The root path of the project (for resolving relative paths)
 */
export async function validateMemories(
  projectId: string,
  projectPath: string,
): Promise<ValidationResult> {
  const db = getDatabase()
  const now = new Date()

  const memories = db
    .select()
    .from(projectMemories)
    .where(
      and(
        eq(projectMemories.projectId, projectId),
        eq(projectMemories.isArchived, false),
      )
    )
    .all()

  const result: ValidationResult = {
    totalChecked: 0,
    validated: 0,
    markedStale: 0,
    alreadyStale: 0,
    details: [],
  }

  for (const memory of memories) {
    // Only check memories with linked files
    if (!memory.linkedFiles) {
      // No linked files = always valid, update timestamp
      db.update(projectMemories)
        .set({ validatedAt: now, isStale: false })
        .where(eq(projectMemories.id, memory.id))
        .run()
      result.validated++
      continue
    }

    result.totalChecked++

    let linkedFiles: string[]
    try {
      linkedFiles = JSON.parse(memory.linkedFiles)
      if (!Array.isArray(linkedFiles)) continue
    } catch {
      continue
    }

    // Check each linked file
    const missingFiles: string[] = []
    for (const filePath of linkedFiles) {
      const resolvedPath = path.isAbsolute(filePath)
        ? filePath
        : path.resolve(projectPath, filePath)

      if (!fs.existsSync(resolvedPath)) {
        missingFiles.push(filePath)
      }
    }

    if (missingFiles.length > 0) {
      const wasStale = memory.isStale
      db.update(projectMemories)
        .set({ isStale: true, validatedAt: now })
        .where(eq(projectMemories.id, memory.id))
        .run()

      if (wasStale) {
        result.alreadyStale++
      } else {
        result.markedStale++
      }

      result.details.push({
        memoryId: memory.id,
        title: memory.title,
        missingFiles,
        isNewlyStale: !wasStale,
      })
    } else {
      // All files exist — mark as valid
      db.update(projectMemories)
        .set({ isStale: false, validatedAt: now })
        .where(eq(projectMemories.id, memory.id))
        .run()
      result.validated++
    }
  }

  return result
}
