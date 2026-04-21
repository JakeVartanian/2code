/**
 * System Map Audit — analyzes each zone's linked files and creates
 * ambientSuggestions so the architecture map reflects audit status.
 *
 * Flow:
 * 1. Read system map zones from DB
 * 2. For each zone, read its linkedFiles from disk
 * 3. Call Sonnet to analyze the zone for issues
 * 4. Persist findings as ambientSuggestions with matching triggerFiles
 * 5. Existing useArchitectureData hook picks them up automatically
 */

import { readFileSync, existsSync, statSync, readdirSync } from "fs"
import { join, relative } from "path"
import { eq, and } from "drizzle-orm"
import { getDatabase } from "../db"
import { ambientSuggestions, projects } from "../db/schema"
import { createId } from "../db/utils"
import type { AmbientProvider } from "./provider"
import type { SystemZone } from "../../../shared/system-map-types"
import type { SuggestionCategory, SuggestionSeverity } from "./types"

// Lazy import for real-time events
let ambientEvents: import("events").EventEmitter | null = null
function getAmbientEvents() {
  if (!ambientEvents) {
    ambientEvents = require("../trpc/routers/ambient").ambientEvents
  }
  return ambientEvents
}

const AUDIT_SYSTEM_PROMPT = `You are auditing a software project zone (a logical component of the architecture).

You will be given the zone name, description, and the contents of its key source files.

Analyze for:
1. Bugs or logic errors
2. Security vulnerabilities (injection, auth issues, secrets exposure)
3. Performance problems (N+1 queries, memory leaks, unnecessary re-renders)
4. Missing test coverage for critical paths
5. Dead code or unused exports
6. Dependency issues (outdated, insecure, unnecessary)

For each finding, provide a structured JSON object. If the zone looks healthy, say so with a high confidence "audit-pass" entry.

Output ONLY a valid JSON array:
[
  {
    "title": "Short title (max 60 chars)",
    "description": "2-4 sentence markdown explanation of the issue and impact",
    "category": "bug|security|performance|test-gap|dead-code|dependency",
    "severity": "info|warning|error",
    "confidence": 75,
    "files": ["relative/path/to/affected/file.ts"],
    "suggestedPrompt": "A prompt to fix this issue"
  }
]

If no issues found, return a single entry:
[
  {
    "title": "Zone audit passed",
    "description": "No significant issues found in this zone.",
    "category": "security",
    "severity": "info",
    "confidence": 90,
    "files": [],
    "suggestedPrompt": ""
  }
]

Be precise. Only flag real issues, not style preferences. Confidence reflects how certain you are this is a genuine problem.`

export interface AuditProgress {
  zoneId: string
  zoneName: string
  status: "pending" | "auditing" | "done" | "error"
  findings: number
}

export interface AuditResult {
  zonesAudited: number
  totalFindings: number
  suggestionsCreated: number
  durationMs: number
  progress: AuditProgress[]
}

/**
 * Audit all zones in the system map. Creates ambientSuggestions
 * for each finding so the architecture map updates automatically.
 */
export async function auditSystemMap(
  projectId: string,
  projectPath: string,
  provider: AmbientProvider,
  onProgress?: (progress: AuditProgress[]) => void,
): Promise<AuditResult> {
  const start = Date.now()
  const db = getDatabase()

  // 1. Load system map zones
  const project = db
    .select({ systemMap: projects.systemMap })
    .from(projects)
    .where(eq(projects.id, projectId))
    .get()

  if (!project?.systemMap) {
    return { zonesAudited: 0, totalFindings: 0, suggestionsCreated: 0, durationMs: 0, progress: [] }
  }

  let zones: SystemZone[]
  try {
    zones = JSON.parse(project.systemMap)
    if (!Array.isArray(zones)) zones = []
  } catch {
    return { zonesAudited: 0, totalFindings: 0, suggestionsCreated: 0, durationMs: 0, progress: [] }
  }

  // 2. Expire any existing audit-generated suggestions for this project
  //    (triggerEvent = "file-change" with analysisModel = "sonnet-audit")
  //    so we get fresh results
  db.update(ambientSuggestions)
    .set({ status: "expired" })
    .where(and(
      eq(ambientSuggestions.projectId, projectId),
      eq(ambientSuggestions.status, "pending"),
      eq(ambientSuggestions.analysisModel, "sonnet-audit"),
    ))
    .run()

  // 3. Audit each zone
  const progress: AuditProgress[] = zones.map(z => ({
    zoneId: z.id,
    zoneName: z.name,
    status: "pending" as const,
    findings: 0,
  }))

  let totalFindings = 0
  let suggestionsCreated = 0

  for (let i = 0; i < zones.length; i++) {
    const zone = zones[i]
    progress[i].status = "auditing"
    onProgress?.(progress)

    try {
      const findings = await auditZone(zone, projectId, projectPath, provider)
      progress[i].findings = findings.length
      progress[i].status = "done"
      totalFindings += findings.length

      // Persist each finding as an ambientSuggestion
      for (const finding of findings) {
        // Skip "audit passed" entries with empty suggestedPrompt
        if (finding.title === "Zone audit passed" && !finding.suggestedPrompt) {
          // Still create a marker suggestion so the zone shows as audited
          persistAuditSuggestion(projectId, zone, {
            ...finding,
            title: `${zone.name}: audit passed`,
            confidence: finding.confidence,
          })
          suggestionsCreated++
          continue
        }

        persistAuditSuggestion(projectId, zone, finding)
        suggestionsCreated++
      }
    } catch (err) {
      console.error(`[SystemMapAudit] Failed to audit zone "${zone.name}":`, err)
      progress[i].status = "error"
    }

    onProgress?.(progress)
  }

  return {
    zonesAudited: zones.length,
    totalFindings,
    suggestionsCreated,
    durationMs: Date.now() - start,
    progress,
  }
}

/**
 * Audit a single zone by reading its linked files and calling Sonnet.
 */
async function auditZone(
  zone: SystemZone,
  projectId: string,
  projectPath: string,
  provider: AmbientProvider,
): Promise<AuditFinding[]> {
  // Read file contents for this zone
  const fileContents = readZoneFiles(zone.linkedFiles, projectPath)

  if (!fileContents.trim()) {
    console.warn(`[SystemMapAudit] No readable files for zone "${zone.name}"`)
    return [{
      title: "Zone audit passed",
      description: "No source files found to audit for this zone.",
      category: "security" as SuggestionCategory,
      severity: "info" as SuggestionSeverity,
      confidence: 50,
      files: zone.linkedFiles,
      suggestedPrompt: "",
    }]
  }

  const userPrompt = `# Zone: ${zone.name}
## Description: ${zone.description}
## Linked Files: ${zone.linkedFiles.join(", ")}

${fileContents}`

  const result = await provider.callSonnet(AUDIT_SYSTEM_PROMPT, userPrompt.slice(0, 30000))
  return parseAuditFindings(result.text, zone)
}

export interface RawAuditFinding {
  title: string
  description: string
  category: SuggestionCategory
  severity: SuggestionSeverity
  confidence: number
  files: string[]
  suggestedPrompt: string
}

// Keep internal alias for backward compat
type AuditFinding = RawAuditFinding

/**
 * Read files for a zone, expanding directories to their contents.
 * Truncates to stay within token budget.
 */
export function readZoneFiles(linkedFiles: string[], projectPath: string): string {
  const MAX_TOTAL = 25000 // ~6k tokens
  let content = ""

  for (const filePath of linkedFiles) {
    if (content.length >= MAX_TOTAL) break

    const absPath = filePath.startsWith("/") ? filePath : join(projectPath, filePath)

    try {
      const stat = statSync(absPath)

      if (stat.isDirectory()) {
        // Read up to 5 files from the directory
        const entries = readdirSync(absPath)
          .filter(f => /\.(ts|tsx|js|jsx|py|rs|go|sol|vue|svelte)$/.test(f))
          .slice(0, 5)

        for (const entry of entries) {
          if (content.length >= MAX_TOTAL) break
          const entryPath = join(absPath, entry)
          try {
            const entryContent = readFileSync(entryPath, "utf-8")
            const relPath = relative(projectPath, entryPath)
            const truncated = entryContent.slice(0, 4000)
            content += `\n### File: ${relPath}\n\`\`\`\n${truncated}\n\`\`\`\n`
          } catch { /* skip unreadable */ }
        }
      } else if (stat.isFile()) {
        const fileContent = readFileSync(absPath, "utf-8")
        const relPath = relative(projectPath, absPath)
        const truncated = fileContent.slice(0, 5000)
        content += `\n### File: ${relPath}\n\`\`\`\n${truncated}\n\`\`\`\n`
      }
    } catch { /* skip missing files */ }
  }

  return content
}

/**
 * Parse audit findings from Sonnet response.
 */
export function parseAuditFindings(text: string, zone: SystemZone): RawAuditFinding[] {
  try {
    const cleaned = text.replace(/```(?:json)?\s*/g, "").replace(/```/g, "")
    const jsonMatch = cleaned.match(/\[[\s\S]*\]/)
    if (!jsonMatch) return []

    const parsed = JSON.parse(jsonMatch[0])
    if (!Array.isArray(parsed)) return []

    const validCategories = new Set([
      "bug", "security", "performance", "test-gap", "dead-code", "dependency",
    ])

    return parsed
      .filter((f: any) => f.title && f.description)
      .slice(0, 8) // max 8 findings per zone
      .map((f: any): AuditFinding => ({
        title: String(f.title).slice(0, 60),
        description: String(f.description).slice(0, 500),
        category: validCategories.has(f.category) ? f.category : "security",
        severity: ["info", "warning", "error"].includes(f.severity) ? f.severity : "info",
        confidence: typeof f.confidence === "number" ? Math.min(100, Math.max(0, f.confidence)) : 50,
        files: Array.isArray(f.files) ? f.files.filter((p: any) => typeof p === "string") : zone.linkedFiles,
        suggestedPrompt: typeof f.suggestedPrompt === "string" ? f.suggestedPrompt : "",
      }))
  } catch (err) {
    console.warn("[SystemMapAudit] Failed to parse findings:", err)
    return []
  }
}

/**
 * Persist a single audit finding as an ambientSuggestion.
 */
function persistAuditSuggestion(
  projectId: string,
  zone: SystemZone,
  finding: AuditFinding,
): void {
  const db = getDatabase()
  const suggestionId = createId()

  // Use the zone's linkedFiles as triggerFiles so useArchitectureData matches them
  const triggerFiles = finding.files.length > 0 ? finding.files : zone.linkedFiles

  db.insert(ambientSuggestions)
    .values({
      id: suggestionId,
      projectId,
      category: finding.category,
      severity: finding.severity,
      title: finding.title,
      description: finding.description,
      triggerEvent: "file-change",
      triggerFiles: JSON.stringify(triggerFiles),
      analysisModel: "sonnet-audit",
      confidence: finding.confidence,
      suggestedPrompt: finding.suggestedPrompt || undefined,
    })
    .run()

  // Emit real-time event
  try {
    const events = getAmbientEvents()
    if (events) {
      events.emit(`project:${projectId}`, {
        type: "new-suggestion",
        suggestionId,
        suggestion: {
          id: suggestionId,
          category: finding.category,
          severity: finding.severity,
          title: finding.title,
          confidence: finding.confidence,
        },
      })
    }
  } catch { /* non-critical */ }
}
