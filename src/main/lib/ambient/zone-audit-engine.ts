/**
 * Zone Audit Engine — smart two-phase audit system.
 *
 * Phase A: Generate an optimal audit profile for a zone (first-time only)
 * Phase B: Execute audit using the profile, persist findings to auditFindings
 *          + ambientSuggestions (backward compat)
 *
 * Features:
 * - Two-level concurrency guard (project-level for Audit All, zone-level for individual)
 * - Per-zone 5-minute cooldown between manual audits
 * - AbortController for cancellation
 * - Per-zone error handling (partial failures don't stop the run)
 * - Density-normalized scoring
 */

import { eq, and } from "drizzle-orm"
import { getDatabase } from "../db"
import {
  auditRuns, auditRunZones, auditProfiles, auditFindings,
  ambientSuggestions, projects,
} from "../db/schema"
import { createId } from "../db/utils"
import type { AmbientProvider } from "./provider"
import type { SystemZone } from "../../../shared/system-map-types"
import type { AuditProgress, AuditRunResult } from "../../../shared/audit-types"
import type { SuggestionCategory, SuggestionSeverity } from "./types"
import { readZoneFiles, parseAuditFindings as parseFindings, type RawAuditFinding } from "./system-map-audit"

// Lazy import for real-time events
let ambientEvents: import("events").EventEmitter | null = null
function getAmbientEvents() {
  if (!ambientEvents) {
    ambientEvents = require("../trpc/routers/ambient").ambientEvents
  }
  return ambientEvents
}

// ─── Concurrency & Cooldown ─────────────────────────────────────────────────

// Two-level lock: projectId → "all" (project lock) or Set<zoneId> (zone locks)
const auditLocks = new Map<string, "all" | Set<string>>()
// Per-zone cooldown timestamps
const zoneCooldowns = new Map<string, number>() // key: `${projectId}:${zoneId}`
const COOLDOWN_MS = 5 * 60 * 1000 // 5 minutes

// Active abort controllers keyed by runId
const activeAbortControllers = new Map<string, AbortController>()

function acquireZoneLock(projectId: string, zoneId: string): string | null {
  const lock = auditLocks.get(projectId)
  if (lock === "all") return "A full audit is already running for this project"
  if (lock instanceof Set && lock.has(zoneId)) return `Zone "${zoneId}" is already being audited`

  // Check cooldown
  const key = `${projectId}:${zoneId}`
  const lastAudit = zoneCooldowns.get(key)
  if (lastAudit && Date.now() - lastAudit < COOLDOWN_MS) {
    const waitSec = Math.ceil((COOLDOWN_MS - (Date.now() - lastAudit)) / 1000)
    return `Zone was recently audited. Wait ${waitSec}s before re-auditing.`
  }

  if (!lock) {
    auditLocks.set(projectId, new Set([zoneId]))
  } else {
    lock.add(zoneId)
  }
  return null
}

function releaseZoneLock(projectId: string, zoneId: string): void {
  const lock = auditLocks.get(projectId)
  if (lock instanceof Set) {
    lock.delete(zoneId)
    if (lock.size === 0) auditLocks.delete(projectId)
  }
  zoneCooldowns.set(`${projectId}:${zoneId}`, Date.now())
}

function acquireProjectLock(projectId: string): string | null {
  const lock = auditLocks.get(projectId)
  if (lock === "all") return "A full audit is already running"
  if (lock instanceof Set && lock.size > 0) return "Individual zone audits are running. Wait for them to complete."
  auditLocks.set(projectId, "all")
  return null
}

function releaseProjectLock(projectId: string): void {
  auditLocks.delete(projectId)
}

// ─── Profile Generation ─────────────────────────────────────────────────────

const PROFILE_SYSTEM_PROMPT = `You are analyzing a software project zone to determine the OPTIMAL audit strategy.

Given the zone name, description, and sample source files, determine:
1. Which audit categories matter MOST for this zone
2. What domain-specific patterns or vulnerabilities to focus on
3. Appropriate severity threshold

Output ONLY valid JSON:
{
  "name": "Short profile name (e.g., 'Smart Contract Security')",
  "description": "1-2 sentence description of the audit focus",
  "categories": ["security", "bug"],
  "severityThreshold": "info",
  "customPrompt": "Domain-specific focus areas. E.g., 'Check for reentrancy, access control issues, gas optimization...'"
}

Category options: bug, security, performance, test-gap, dead-code, dependency
Severity options: info, warning, error

Be specific to the zone's technology and purpose. A smart contract zone needs different checks than a React frontend.`

/**
 * Generate an optimal audit profile for a zone.
 * Called on first audit of a zone that has no existing profile.
 */
export async function generateZoneAuditProfile(
  zone: SystemZone,
  projectId: string,
  projectPath: string,
  provider: AmbientProvider,
): Promise<string> {
  const db = getDatabase()
  const fileContents = readZoneFiles(zone.linkedFiles, projectPath)

  const userPrompt = `# Zone: ${zone.name}
## Description: ${zone.description}
## Linked Files: ${zone.linkedFiles.join(", ")}

${fileContents.slice(0, 15000)}`

  const result = await provider.callSonnet(PROFILE_SYSTEM_PROMPT, userPrompt)

  // Parse the profile
  let profileData: any = {}
  try {
    const cleaned = result.text.replace(/```(?:json)?\s*/g, "").replace(/```/g, "")
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/)
    if (jsonMatch) profileData = JSON.parse(jsonMatch[0])
  } catch {
    profileData = {}
  }

  const validCategories = new Set(["bug", "security", "performance", "test-gap", "dead-code", "dependency"])
  const categories = Array.isArray(profileData.categories)
    ? profileData.categories.filter((c: string) => validCategories.has(c))
    : ["bug", "security", "performance", "test-gap", "dead-code", "dependency"]

  const profileId = createId()
  db.insert(auditProfiles).values({
    id: profileId,
    projectId,
    name: String(profileData.name || `${zone.name} Audit`).slice(0, 60),
    description: String(profileData.description || "Auto-generated audit profile").slice(0, 200),
    zoneIds: JSON.stringify([zone.id]),
    zoneNames: JSON.stringify([zone.name]),
    categories: JSON.stringify(categories),
    severityThreshold: ["info", "warning", "error"].includes(profileData.severityThreshold)
      ? profileData.severityThreshold : "info",
    customPromptAppend: String(profileData.customPrompt || "").slice(0, 2000),
    isAutoGenerated: true,
  }).run()

  console.log(`[ZoneAudit] Generated profile "${profileData.name}" for zone "${zone.name}"`)
  return profileId
}

// ─── Zone Audit Execution ───────────────────────────────────────────────────

const BASE_AUDIT_PROMPT = `You are auditing a software project zone (a logical component of the architecture).

Analyze the source files for issues. For each finding, provide a structured JSON object.

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

If no issues found, return:
[{"title":"Zone audit passed","description":"No significant issues found.","category":"security","severity":"info","confidence":90,"files":[],"suggestedPrompt":""}]

Be precise. Only flag real issues, not style preferences.`

/**
 * Execute a single-zone audit. Creates auditRuns, auditFindings, and ambientSuggestions records.
 */
export async function executeZoneAudit(
  zone: SystemZone,
  profileId: string | null,
  projectId: string,
  projectPath: string,
  provider: AmbientProvider,
  trigger: string = "manual-zone",
  signal?: AbortSignal,
): Promise<AuditRunResult> {
  const start = Date.now()
  const db = getDatabase()

  // Load profile for custom prompt enrichment
  let customPrompt = ""
  let categories: string[] | null = null
  let severityThreshold = "info"

  if (profileId) {
    const profile = db.select().from(auditProfiles).where(eq(auditProfiles.id, profileId)).get()
    if (profile) {
      customPrompt = profile.customPromptAppend
      try { categories = JSON.parse(profile.categories) } catch { /* use all */ }
      severityThreshold = profile.severityThreshold
      // Update lastUsedAt
      db.update(auditProfiles).set({ lastUsedAt: new Date() }).where(eq(auditProfiles.id, profileId)).run()
    }
  }

  // Create audit run record
  const runId = createId()
  db.insert(auditRuns).values({
    id: runId,
    projectId,
    profileId,
    trigger,
    status: "running",
    initiatedBy: trigger.startsWith("manual") ? "user" : trigger === "on-commit" ? "ambient" : "schedule",
    startedAt: new Date(),
  }).run()

  const progress: AuditProgress[] = [{
    zoneId: zone.id,
    zoneName: zone.name,
    status: "auditing",
    findings: 0,
  }]

  let totalFindings = 0
  let errorCount = 0
  let warningCount = 0
  let infoCount = 0
  const partialErrors: Array<{ zoneId: string; error: string }> = []

  try {
    if (signal?.aborted) throw new Error("Audit cancelled")

    // Build enriched system prompt
    let systemPrompt = BASE_AUDIT_PROMPT
    if (customPrompt) {
      systemPrompt += `\n\nADDITIONAL FOCUS AREAS:\n${customPrompt}`
    }
    if (categories && categories.length < 6) {
      systemPrompt += `\n\nONLY report findings in these categories: ${categories.join(", ")}`
    }

    // Read zone files
    const fileContents = readZoneFiles(zone.linkedFiles, projectPath)
    if (!fileContents.trim()) {
      progress[0].status = "done"
      finalizeRun(db, runId, 0, 0, 0, 0, 100, Date.now() - start, partialErrors)
      db.insert(auditRunZones).values({ runId, zoneId: zone.id, zoneName: zone.name, zoneScore: 100 }).run()
      return { runId, zonesAudited: 1, totalFindings: 0, suggestionsCreated: 0, overallScore: 100, durationMs: Date.now() - start, progress, partialErrors }
    }

    const userPrompt = `# Zone: ${zone.name}\n## Description: ${zone.description}\n## Files: ${zone.linkedFiles.join(", ")}\n\n${fileContents}`

    // Call Sonnet with timeout
    const result = await Promise.race([
      provider.callSonnet(systemPrompt, userPrompt.slice(0, 30000)),
      new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error("Sonnet timeout (45s)")), 45000)
        signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("Audit cancelled")) })
      }),
    ])

    // Parse findings
    const rawFindings = parseFindings(result.text, zone)

    // Filter by severity threshold
    const sevOrder: Record<string, number> = { info: 0, warning: 1, error: 2 }
    const minSev = sevOrder[severityThreshold] ?? 0
    const filtered = rawFindings.filter(f => (sevOrder[f.severity] ?? 0) >= minSev)

    totalFindings = filtered.length

    // Expire only THIS zone's previous audit suggestions (not blanket expiration)
    expireZoneAuditSuggestions(db, projectId, zone)

    // Persist findings
    for (const finding of filtered) {
      if (finding.title === "Zone audit passed" && !finding.suggestedPrompt) {
        // Still count as audited but not a real finding
        continue
      }

      // Create ambientSuggestion for backward compat with useArchitectureData
      const suggestionId = createId()
      const triggerFiles = finding.files.length > 0 ? finding.files : zone.linkedFiles
      db.insert(ambientSuggestions).values({
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
        auditRunId: runId,
      }).run()

      // Create auditFinding
      const findingId = createId()
      db.insert(auditFindings).values({
        id: findingId,
        runId,
        projectId,
        suggestionId,
        zoneId: zone.id,
        zoneName: zone.name,
        category: finding.category,
        severity: finding.severity,
        title: finding.title,
        description: finding.description,
        confidence: finding.confidence,
        affectedFiles: JSON.stringify(triggerFiles),
        suggestedPrompt: finding.suggestedPrompt || undefined,
      }).run()

      // Count by severity
      if (finding.severity === "error") errorCount++
      else if (finding.severity === "warning") warningCount++
      else infoCount++

      // Emit real-time event
      emitSuggestionEvent(projectId, suggestionId, finding)
    }

    progress[0].status = "done"
    progress[0].findings = totalFindings

  } catch (err: any) {
    progress[0].status = "error"
    progress[0].errorMessage = err?.message || "Unknown error"
    partialErrors.push({ zoneId: zone.id, error: err?.message || "Unknown error" })
    console.error(`[ZoneAudit] Failed to audit zone "${zone.name}":`, err)
  }

  // Compute score
  const score = computeZoneScore(errorCount, warningCount, infoCount, zone.linkedFiles.length)

  // Insert zone record
  db.insert(auditRunZones).values({ runId, zoneId: zone.id, zoneName: zone.name, zoneScore: score }).run()

  // Finalize run
  const status = signal?.aborted ? "cancelled" : partialErrors.length > 0 && totalFindings === 0 ? "failed" : "completed"
  finalizeRun(db, runId, totalFindings, errorCount, warningCount, infoCount, score, Date.now() - start, partialErrors, status)

  return {
    runId,
    zonesAudited: 1,
    totalFindings,
    suggestionsCreated: totalFindings,
    overallScore: score,
    durationMs: Date.now() - start,
    progress,
    partialErrors,
  }
}

/**
 * Audit all zones in the system map. Creates a single auditRun spanning all zones.
 */
export async function auditAllZones(
  projectId: string,
  projectPath: string,
  profileId: string | null,
  provider: AmbientProvider,
  onProgress?: (progress: AuditProgress[]) => void,
): Promise<AuditRunResult> {
  const start = Date.now()
  const db = getDatabase()

  // Load system map zones
  const project = db.select({ systemMap: projects.systemMap }).from(projects).where(eq(projects.id, projectId)).get()
  if (!project?.systemMap) {
    return { runId: "", zonesAudited: 0, totalFindings: 0, suggestionsCreated: 0, overallScore: 0, durationMs: 0, progress: [], partialErrors: [] }
  }

  let zones: SystemZone[]
  try {
    zones = JSON.parse(project.systemMap)
    if (!Array.isArray(zones)) zones = []
  } catch {
    return { runId: "", zonesAudited: 0, totalFindings: 0, suggestionsCreated: 0, overallScore: 0, durationMs: 0, progress: [], partialErrors: [] }
  }

  // Load profile settings if provided
  let customPrompt = ""
  let categories: string[] | null = null
  let severityThreshold = "info"
  if (profileId) {
    const profile = db.select().from(auditProfiles).where(eq(auditProfiles.id, profileId)).get()
    if (profile) {
      customPrompt = profile.customPromptAppend
      try { categories = JSON.parse(profile.categories) } catch { /* use all */ }
      severityThreshold = profile.severityThreshold
      db.update(auditProfiles).set({ lastUsedAt: new Date() }).where(eq(auditProfiles.id, profileId)).run()
    }
  }

  // Create audit run
  const runId = createId()
  const controller = new AbortController()
  activeAbortControllers.set(runId, controller)

  db.insert(auditRuns).values({
    id: runId,
    projectId,
    profileId,
    trigger: "manual-all",
    status: "running",
    initiatedBy: "user",
    startedAt: new Date(),
  }).run()

  const progress: AuditProgress[] = zones.map(z => ({
    zoneId: z.id, zoneName: z.name, status: "pending" as const, findings: 0,
  }))

  let totalFindings = 0
  let totalErrors = 0
  let totalWarnings = 0
  let totalInfos = 0
  const partialErrors: Array<{ zoneId: string; error: string }> = []
  const zoneScores: number[] = []

  for (let i = 0; i < zones.length; i++) {
    if (controller.signal.aborted) {
      for (let j = i; j < zones.length; j++) progress[j].status = "error"
      break
    }

    const zone = zones[i]
    progress[i].status = "auditing"
    onProgress?.(progress)

    try {
      // Build prompt
      let systemPrompt = BASE_AUDIT_PROMPT
      if (customPrompt) systemPrompt += `\n\nADDITIONAL FOCUS AREAS:\n${customPrompt}`
      if (categories && categories.length < 6) systemPrompt += `\n\nONLY report findings in these categories: ${categories.join(", ")}`

      const fileContents = readZoneFiles(zone.linkedFiles, projectPath)
      if (!fileContents.trim()) {
        progress[i].status = "done"
        db.insert(auditRunZones).values({ runId, zoneId: zone.id, zoneName: zone.name, zoneScore: 100 }).run()
        zoneScores.push(100)
        continue
      }

      const userPrompt = `# Zone: ${zone.name}\n## Description: ${zone.description}\n## Files: ${zone.linkedFiles.join(", ")}\n\n${fileContents}`

      const result = await Promise.race([
        provider.callSonnet(systemPrompt, userPrompt.slice(0, 30000)),
        new Promise<never>((_, reject) => {
          const timer = setTimeout(() => reject(new Error("Sonnet timeout (45s)")), 45000)
          controller.signal.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("Audit cancelled")) })
        }),
      ])

      const rawFindings = parseFindings(result.text, zone)
      const sevOrder: Record<string, number> = { info: 0, warning: 1, error: 2 }
      const minSev = sevOrder[severityThreshold] ?? 0
      const filtered = rawFindings.filter(f => (sevOrder[f.severity] ?? 0) >= minSev)

      // Expire only this zone's previous audit suggestions
      expireZoneAuditSuggestions(db, projectId, zone)

      let zoneErrors = 0, zoneWarnings = 0, zoneInfos = 0

      for (const finding of filtered) {
        if (finding.title === "Zone audit passed" && !finding.suggestedPrompt) continue

        const suggestionId = createId()
        const triggerFiles = finding.files.length > 0 ? finding.files : zone.linkedFiles

        db.insert(ambientSuggestions).values({
          id: suggestionId, projectId, category: finding.category, severity: finding.severity,
          title: finding.title, description: finding.description, triggerEvent: "file-change",
          triggerFiles: JSON.stringify(triggerFiles), analysisModel: "sonnet-audit",
          confidence: finding.confidence, suggestedPrompt: finding.suggestedPrompt || undefined,
          auditRunId: runId,
        }).run()

        db.insert(auditFindings).values({
          id: createId(), runId, projectId, suggestionId, zoneId: zone.id, zoneName: zone.name,
          category: finding.category, severity: finding.severity, title: finding.title,
          description: finding.description, confidence: finding.confidence,
          affectedFiles: JSON.stringify(triggerFiles), suggestedPrompt: finding.suggestedPrompt || undefined,
        }).run()

        if (finding.severity === "error") { zoneErrors++; totalErrors++ }
        else if (finding.severity === "warning") { zoneWarnings++; totalWarnings++ }
        else { zoneInfos++; totalInfos++ }

        emitSuggestionEvent(projectId, suggestionId, finding)
      }

      const zoneFindingCount = zoneErrors + zoneWarnings + zoneInfos
      totalFindings += zoneFindingCount
      progress[i].status = "done"
      progress[i].findings = zoneFindingCount

      const zoneScore = computeZoneScore(zoneErrors, zoneWarnings, zoneInfos, zone.linkedFiles.length)
      db.insert(auditRunZones).values({ runId, zoneId: zone.id, zoneName: zone.name, zoneScore }).run()
      zoneScores.push(zoneScore)

    } catch (err: any) {
      progress[i].status = "error"
      progress[i].errorMessage = err?.message
      partialErrors.push({ zoneId: zone.id, error: err?.message || "Unknown error" })
      db.insert(auditRunZones).values({ runId, zoneId: zone.id, zoneName: zone.name, zoneScore: 0 }).run()
      zoneScores.push(0)
      console.error(`[ZoneAudit] Failed zone "${zone.name}":`, err)
    }

    onProgress?.(progress)
  }

  activeAbortControllers.delete(runId)

  const overallScore = zoneScores.length > 0
    ? Math.round(zoneScores.reduce((a, b) => a + b, 0) / zoneScores.length)
    : 0

  const status = controller.signal.aborted ? "cancelled" : "completed"
  finalizeRun(db, runId, totalFindings, totalErrors, totalWarnings, totalInfos, overallScore, Date.now() - start, partialErrors, status)

  return {
    runId,
    zonesAudited: zones.length,
    totalFindings,
    suggestionsCreated: totalFindings,
    overallScore,
    durationMs: Date.now() - start,
    progress,
    partialErrors,
  }
}

// ─── Public API for tRPC ────────────────────────────────────────────────────

/**
 * Audit a single zone with concurrency guard and profile auto-generation.
 */
export async function auditZone(
  projectId: string,
  projectPath: string,
  zoneId: string,
  provider: AmbientProvider,
): Promise<AuditRunResult> {
  // Lock
  const lockError = acquireZoneLock(projectId, zoneId)
  if (lockError) throw new Error(lockError)

  try {
    // Load zone from system map
    const db = getDatabase()
    const project = db.select({ systemMap: projects.systemMap }).from(projects).where(eq(projects.id, projectId)).get()
    if (!project?.systemMap) throw new Error("No system map found")

    const zones: SystemZone[] = JSON.parse(project.systemMap)
    const zone = zones.find(z => z.id === zoneId)
    if (!zone) throw new Error(`Zone "${zoneId}" not found in system map`)

    // Check for existing auto-generated profile for this zone
    let profileId: string | null = null
    const existing = db.select().from(auditProfiles)
      .where(and(
        eq(auditProfiles.projectId, projectId),
        eq(auditProfiles.isAutoGenerated, true),
      ))
      .all()
      .find(p => {
        try {
          const ids = JSON.parse(p.zoneIds || "[]")
          return Array.isArray(ids) && ids.includes(zoneId)
        } catch { return false }
      })

    if (existing) {
      profileId = existing.id
    } else {
      // Phase A: Generate profile
      profileId = await generateZoneAuditProfile(zone, projectId, projectPath, provider)
    }

    // Phase B: Execute audit
    return await executeZoneAudit(zone, profileId, projectId, projectPath, provider, "manual-zone")
  } finally {
    releaseZoneLock(projectId, zoneId)
  }
}

/**
 * Audit all zones with project-level lock.
 */
export async function auditAllZonesWithLock(
  projectId: string,
  projectPath: string,
  provider: AmbientProvider,
  onProgress?: (progress: AuditProgress[]) => void,
): Promise<AuditRunResult> {
  const lockError = acquireProjectLock(projectId)
  if (lockError) throw new Error(lockError)

  try {
    return await auditAllZones(projectId, projectPath, null, provider, onProgress)
  } finally {
    releaseProjectLock(projectId)
  }
}

/**
 * Cancel an in-progress audit run.
 */
export function cancelAuditRun(runId: string): boolean {
  const controller = activeAbortControllers.get(runId)
  if (!controller) return false
  controller.abort()
  activeAbortControllers.delete(runId)
  return true
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function computeZoneScore(errors: number, warnings: number, infos: number, fileCount: number): number {
  const rawPenalty = errors * 15 + warnings * 5 + infos * 1
  const normalizedPenalty = rawPenalty / Math.max(1, fileCount) * 3
  return Math.round(Math.max(0, Math.min(100, 100 - normalizedPenalty)))
}

function finalizeRun(
  db: ReturnType<typeof getDatabase>,
  runId: string,
  totalFindings: number,
  errorCount: number,
  warningCount: number,
  infoCount: number,
  overallScore: number,
  durationMs: number,
  partialErrors: Array<{ zoneId: string; error: string }>,
  status: string = "completed",
): void {
  db.update(auditRuns).set({
    status,
    totalFindings,
    errorCount,
    warningCount,
    infoCount,
    overallScore,
    durationMs,
    partialErrors: partialErrors.length > 0 ? JSON.stringify(partialErrors) : null,
    completedAt: new Date(),
  }).where(eq(auditRuns.id, runId)).run()
}

function expireZoneAuditSuggestions(
  db: ReturnType<typeof getDatabase>,
  projectId: string,
  zone: SystemZone,
): void {
  // Only expire suggestions that match this zone's linkedFiles
  const existing = db.select({ id: ambientSuggestions.id, triggerFiles: ambientSuggestions.triggerFiles })
    .from(ambientSuggestions)
    .where(and(
      eq(ambientSuggestions.projectId, projectId),
      eq(ambientSuggestions.status, "pending"),
      eq(ambientSuggestions.analysisModel, "sonnet-audit"),
    ))
    .all()

  for (const s of existing) {
    try {
      const files = s.triggerFiles ? JSON.parse(s.triggerFiles) : []
      const matches = Array.isArray(files) && files.some((f: string) =>
        zone.linkedFiles.some(zf => f.startsWith(zf) || zf.startsWith(f)))
      if (matches) {
        db.update(ambientSuggestions).set({ status: "expired" }).where(eq(ambientSuggestions.id, s.id)).run()
      }
    } catch { /* skip */ }
  }
}

function emitSuggestionEvent(projectId: string, suggestionId: string, finding: RawAuditFinding): void {
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
