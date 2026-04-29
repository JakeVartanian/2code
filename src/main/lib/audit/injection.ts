/**
 * Audit findings injection — formats open audit findings for system prompt context.
 * Similar pattern to memory/injection.ts but for the audit system.
 */

import { eq, and, desc } from "drizzle-orm"
import { getDatabase } from "../db"
import { auditFindings } from "../db/schema"

interface AuditInjectionResult {
  markdown: string
  findingsUsed: number
  tokensUsed: number
}

/**
 * Get open audit findings formatted for system prompt injection.
 *
 * @param projectId - Project to query findings for
 * @param contextFiles - Optional file paths for relevance boosting (files user is working with)
 * @param maxTokens - Token budget (default 600, ~4 chars per token)
 */
export function getAuditFindingsForInjection(
  projectId: string,
  contextFiles?: string[] | null,
  maxTokens: number = 600,
): AuditInjectionResult {
  const db = getDatabase()

  const findings = db.select()
    .from(auditFindings)
    .where(and(eq(auditFindings.projectId, projectId), eq(auditFindings.status, "open")))
    .orderBy(desc(auditFindings.severity), desc(auditFindings.confidence))
    .limit(50) // Cap query — we'll trim by token budget
    .all()

  if (findings.length === 0) {
    return { markdown: "", findingsUsed: 0, tokensUsed: 0 }
  }

  // If contextFiles provided, boost findings whose affected files overlap
  const contextSet = contextFiles?.length
    ? new Set(contextFiles.map(f => f.replace(/^\.\//, "").replace(/^\//, "")))
    : null

  const scored = findings.map(f => {
    const affected: string[] = f.affectedFiles ? JSON.parse(f.affectedFiles) : []
    const normalizedAffected = affected.map(a => a.replace(/^\.\//, "").replace(/^\//, ""))
    const fileOverlap = contextSet
      ? normalizedAffected.some(a => contextSet.has(a) || [...contextSet].some(c => a.startsWith(c + "/") || c.startsWith(a + "/")))
      : false

    // Score: severity weight + confidence + file relevance boost
    const sevWeight = f.severity === "error" ? 300 : f.severity === "warning" ? 200 : 100
    const score = sevWeight + (f.confidence ?? 50) + (fileOverlap ? 500 : 0)

    return { finding: f, score, affected: normalizedAffected }
  })

  // Sort by score descending (file-relevant findings first, then by severity)
  scored.sort((a, b) => b.score - a.score)

  // Build markdown within token budget
  const header = "# Known Issues (Audit Findings)\nThe following open issues have been identified in this project. Consider these when working on related files.\n"
  const headerTokens = Math.ceil(header.length / 4)
  let tokensUsed = headerTokens
  const lines: string[] = []

  for (const { finding, affected } of scored) {
    const filesStr = affected.length > 0
      ? affected.slice(0, 3).join(", ") + (affected.length > 3 ? ` (+${affected.length - 3})` : "")
      : "unspecified"
    const line = `- **[${finding.severity}] ${finding.zoneName}** — ${finding.title}\n  Files: ${filesStr} | Confidence: ${finding.confidence}%`
    const lineTokens = Math.ceil(line.length / 4)

    if (tokensUsed + lineTokens > maxTokens) break
    lines.push(line)
    tokensUsed += lineTokens
  }

  if (lines.length === 0) {
    return { markdown: "", findingsUsed: 0, tokensUsed: 0 }
  }

  const markdown = header + "\n" + lines.join("\n")
  return { markdown, findingsUsed: lines.length, tokensUsed }
}

/**
 * Compact format for GAAD triage dedup — just titles so GAAD doesn't re-flag known issues.
 * Smaller budget, used in background pipeline context.
 */
export function getAuditFindingsForDedup(
  projectId: string,
  maxTokens: number = 400,
): string {
  const db = getDatabase()

  const findings = db.select({
    severity: auditFindings.severity,
    zoneName: auditFindings.zoneName,
    title: auditFindings.title,
  })
    .from(auditFindings)
    .where(and(eq(auditFindings.projectId, projectId), eq(auditFindings.status, "open")))
    .orderBy(desc(auditFindings.severity), desc(auditFindings.confidence))
    .limit(30)
    .all()

  if (findings.length === 0) return ""

  const header = "## Known Open Findings (do not re-flag these)\n"
  let tokens = Math.ceil(header.length / 4)
  const lines: string[] = []

  for (const f of findings) {
    const line = `- [${f.severity}] ${f.title} (${f.zoneName})`
    const lineTokens = Math.ceil(line.length / 4)
    if (tokens + lineTokens > maxTokens) break
    lines.push(line)
    tokens += lineTokens
  }

  if (lines.length === 0) return ""
  return header + lines.join("\n")
}
