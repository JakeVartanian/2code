/**
 * Project Identity — a structured overview of WHAT a project is.
 *
 * Unlike code-level memories (architecture, conventions, debugging), the identity
 * document captures the product's purpose, audience, philosophy, and direction.
 * It's the foundation GAAD uses to understand any project holistically.
 *
 * - Generated from README, package.json, CLAUDE.md, git history, and directory structure
 * - Visible and editable by the user in the Brain page
 * - Auto-refreshed on brain build or when source files change (unless manually edited)
 * - Injected with highest priority into every Claude session
 */

import { eq, and } from "drizzle-orm"
import { readFileSync, existsSync } from "fs"
import { join } from "path"
import { getDatabase } from "../db"
import { projectMemories } from "../db/schema"
import { createId } from "../db/utils"
import { callClaude } from "../claude/api"
import { exec } from "child_process"
import { promisify } from "util"

const execAsync = promisify(exec)

// ============ IDENTITY PROMPT ============

const IDENTITY_SYSTEM = `You are analyzing a software project to understand WHAT it is — not how it's built at the code level.

From the README, package.json, CLAUDE.md, git history, and project structure, write a Project Overview covering:

1. **WHAT THIS IS**: One clear sentence describing the product/project.
2. **WHO IT'S FOR**: Target audience, users, or stakeholders.
3. **CORE PROBLEM**: What problem does it solve? Why does it exist?
4. **TECH STACK**: Key technologies and frameworks, and why they were chosen (if visible).
5. **ARCHITECTURE IN BRIEF**: High-level structure (e.g., "monorepo with frontend and API", "Electron app with React renderer", "Solidity contracts with Hardhat tooling").
6. **CURRENT PHASE**: Where is this project in its lifecycle? (early prototype, active development, growth, mature/maintenance)
7. **DESIGN & UX DIRECTION**: Any visible design principles, UI philosophy, or brand identity.
8. **KEY DECISIONS**: Major architectural, product, or strategic decisions visible from the codebase (e.g., "desktop-only until 1.0", "CLI-first auth flow", "SQLite over Postgres").

Write as a cohesive, readable document with clear headers. NOT a bullet list of facts.
This document will be the #1 context that guides all future analysis of this project.
Stay under 500 words. Be specific to THIS project — don't be generic.`

// ============ CORE ============

/**
 * Generate or refresh the project identity document.
 * Reads project files and synthesizes a structured overview.
 */
export async function synthesizeIdentity(
  projectId: string,
  projectPath: string,
): Promise<string | null> {
  // Gather context — read more than brain build does (full README, not truncated)
  const readme = readIfExists(join(projectPath, "README.md"), 15000)
  const packageJson = readIfExists(join(projectPath, "package.json"), 5000)
  const claudeMd = readIfExists(join(projectPath, "CLAUDE.md"), 8000)

  // Get directory tree (shallow, 3 levels)
  let dirTree = ""
  try {
    const { stdout } = await execAsync(
      "find . -maxdepth 3 -type d -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/dist/*' -not -path '*/.next/*' | sort | head -80",
      { cwd: projectPath, timeout: 5000 },
    )
    dirTree = stdout.trim()
  } catch { /* non-critical */ }

  // Get recent git log for trajectory
  let gitLog = ""
  try {
    const { stdout } = await execAsync(
      'git log --oneline --no-decorate -30',
      { cwd: projectPath, timeout: 5000 },
    )
    gitLog = stdout.trim()
  } catch { /* non-critical */ }

  // Build the context
  let context = "# Project Files\n\n"
  if (packageJson) context += `## package.json\n\`\`\`json\n${packageJson}\n\`\`\`\n\n`
  if (readme) context += `## README.md\n${readme}\n\n`
  if (claudeMd) context += `## CLAUDE.md\n${claudeMd}\n\n`
  if (dirTree) context += `## Directory Structure\n\`\`\`\n${dirTree}\n\`\`\`\n\n`
  if (gitLog) context += `## Recent Commits\n\`\`\`\n${gitLog}\n\`\`\`\n\n`

  if (context.length < 200) {
    console.log("[Identity] Not enough project context to synthesize identity")
    return null
  }

  try {
    const { text } = await callClaude({
      system: IDENTITY_SYSTEM,
      userMessage: context.slice(0, 30000), // Cap total context
      maxTokens: 1200,
      timeoutMs: 60_000,
    })

    if (!text || text.length < 100) {
      console.log("[Identity] Synthesis returned empty/short response")
      return null
    }

    return text.trim()
  } catch (err) {
    console.error("[Identity] Synthesis failed:", err instanceof Error ? err.message : err)
    return null
  }
}

/**
 * Get the existing project identity document.
 */
export function getIdentity(projectId: string): { id: string; content: string; source: string; updatedAt: Date | null } | null {
  const db = getDatabase()
  return db.select({
    id: projectMemories.id,
    content: projectMemories.content,
    source: projectMemories.source,
    updatedAt: projectMemories.updatedAt,
  })
    .from(projectMemories)
    .where(and(
      eq(projectMemories.projectId, projectId),
      eq(projectMemories.category, "strategy"),
      eq(projectMemories.isArchived, false),
    ))
    // identity or identity-manual source
    .all()
    .find(m => m.source === "identity" || m.source === "identity-manual") ?? null
}

/**
 * Create or update the identity document from synthesis.
 * Will NOT overwrite manually-edited identity docs (source="identity-manual").
 * Returns true if the identity was updated.
 */
export async function refreshIdentity(
  projectId: string,
  projectPath: string,
  force: boolean = false,
): Promise<boolean> {
  const db = getDatabase()
  const existing = getIdentity(projectId)

  // Don't auto-overwrite user edits (unless forced)
  if (existing?.source === "identity-manual" && !force) {
    console.log("[Identity] Skipping refresh — user has manually edited the identity doc")
    return false
  }

  const content = await synthesizeIdentity(projectId, projectPath)
  if (!content) return false

  if (existing) {
    db.update(projectMemories)
      .set({
        content,
        source: "identity",
        relevanceScore: 95,
        validatedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(projectMemories.id, existing.id))
      .run()
  } else {
    db.insert(projectMemories)
      .values({
        id: createId(),
        projectId,
        category: "strategy",
        title: "Project Overview",
        content,
        source: "identity",
        relevanceScore: 95,
        state: "active",
      })
      .run()
  }

  console.log(`[Identity] ${existing ? "Updated" : "Created"} project identity for ${projectId} (${content.length} chars)`)
  return true
}

/**
 * Save user's manual edits to the identity document.
 * Marks source as "identity-manual" to prevent auto-overwrite.
 */
export function saveIdentityManual(projectId: string, content: string): void {
  const db = getDatabase()
  const existing = getIdentity(projectId)

  if (existing) {
    db.update(projectMemories)
      .set({
        content,
        source: "identity-manual",
        updatedAt: new Date(),
      })
      .where(eq(projectMemories.id, existing.id))
      .run()
  } else {
    db.insert(projectMemories)
      .values({
        id: createId(),
        projectId,
        category: "strategy",
        title: "Project Overview",
        content,
        source: "identity-manual",
        relevanceScore: 95,
        state: "active",
      })
      .run()
  }
}

// ============ HELPERS ============

function readIfExists(path: string, maxChars?: number): string | null {
  if (!existsSync(path)) return null
  try {
    let content = readFileSync(path, "utf-8")
    if (maxChars && content.length > maxChars) {
      content = content.slice(0, maxChars) + "\n[...truncated]"
    }
    return content
  } catch {
    return null
  }
}
