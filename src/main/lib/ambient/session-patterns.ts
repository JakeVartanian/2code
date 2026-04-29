/**
 * Cross-session pattern detection — tracks file churn across sessions.
 * Files modified in 3+ sessions within a 7-day window are flagged as "churn files"
 * and injected into synthesis context for deeper analysis.
 */

import { and, eq, gte, sql } from "drizzle-orm"
import { getDatabase } from "../db"
import { sessionFileActivity } from "../db/schema"
import { createId } from "../db/utils"

const CHURN_THRESHOLD = 3      // Modified in N+ sessions to count as churn
const CHURN_WINDOW_DAYS = 7    // Look-back window
const EXPIRY_DAYS = 30         // Auto-delete rows older than this

export class SessionPatternTracker {
  /**
   * Record files modified during a session.
   * Called at session-complete with the list of modified files.
   */
  recordSessionFiles(projectId: string, filesModified: string[], timestamp = new Date()): void {
    if (filesModified.length === 0) return

    const db = getDatabase()

    // Insert one row per file (batch insert)
    for (const filePath of filesModified.slice(0, 50)) { // Cap at 50 files per session
      db.insert(sessionFileActivity).values({
        id: createId(),
        projectId,
        filePath,
        timestamp,
      }).run()
    }

    // Opportunistic cleanup: expire old rows
    this.expireOldRows(db, projectId)
  }

  /**
   * Get files that have been modified in 3+ sessions within the last 7 days.
   * Returns array of { filePath, sessionCount } sorted by frequency descending.
   */
  getChurnFiles(projectId: string, days = CHURN_WINDOW_DAYS): Array<{ filePath: string; sessionCount: number }> {
    const db = getDatabase()
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000)

    const rows = db.select({
      filePath: sessionFileActivity.filePath,
      count: sql<number>`count(*)`.as("count"),
    })
      .from(sessionFileActivity)
      .where(and(
        eq(sessionFileActivity.projectId, projectId),
        gte(sessionFileActivity.timestamp, cutoff),
      ))
      .groupBy(sessionFileActivity.filePath)
      .having(sql`count(*) >= ${CHURN_THRESHOLD}`)
      .orderBy(sql`count(*) DESC`)
      .limit(10)
      .all()

    return rows.map(r => ({
      filePath: r.filePath,
      sessionCount: Number(r.count),
    }))
  }

  /**
   * Build compact context string for synthesis injection.
   * Returns empty string if no churn detected.
   */
  buildChurnContext(projectId: string): string {
    const churn = this.getChurnFiles(projectId)
    if (churn.length === 0) return ""

    const lines = churn.map(c =>
      `Cross-session: \`${c.filePath}\` modified in ${c.sessionCount}/${CHURN_WINDOW_DAYS} recent sessions`,
    )
    return lines.join("\n")
  }

  private expireOldRows(db: ReturnType<typeof getDatabase>, projectId: string): void {
    try {
      const cutoff = new Date(Date.now() - EXPIRY_DAYS * 24 * 60 * 60 * 1000)
      db.delete(sessionFileActivity)
        .where(and(
          eq(sessionFileActivity.projectId, projectId),
          sql`${sessionFileActivity.timestamp} < ${cutoff.getTime()}`,
        ))
        .run()
    } catch { /* non-critical */ }
  }
}
