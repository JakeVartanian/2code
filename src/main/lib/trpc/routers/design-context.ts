/**
 * Design context injection helper — builds a compact [Pencil Design Context]
 * block for system prompt injection. Called directly from claude.ts (not via tRPC).
 */

import { and, eq } from "drizzle-orm"
import { getDatabase } from "../../db"
import { projectMemories, projects } from "../../db/schema"
import { readdir, stat } from "node:fs/promises"
import { join, relative, extname } from "node:path"

/**
 * Get a compact design context block for injection into Claude's system prompt.
 * Returns null if no design data exists for this project.
 * Typically ~200-500 tokens — always injected when design data exists.
 */
export async function getDesignContextForInjection(projectId: string): Promise<string | null> {
  const db = getDatabase()

  const allMems = db
    .select()
    .from(projectMemories)
    .where(
      and(
        eq(projectMemories.projectId, projectId),
        eq(projectMemories.isArchived, false),
      )
    )
    .all()
    .filter(m => ["brand", "design", "strategy"].includes(m.category))

  if (allMems.length === 0) return null

  const brand = allMems.filter(m => m.category === "brand")
  const design = allMems.filter(m => m.category === "design")

  // Extract structured brand data
  const colors = brand.filter(m => /color|palette/i.test(m.title)).map(m => m.content).join(", ")
  const fonts = brand.filter(m => /font|typo/i.test(m.title)).map(m => m.content).join(", ")
  const voice = brand.filter(m => /voice|tone/i.test(m.title)).map(m => m.content).join("; ")
  const designVoice = design.find(m => /design voice|design direction|design philosophy/i.test(m.title))

  // Find .pen files in project
  let penFilesSummary = ""
  const project = db.select({ path: projects.path }).from(projects).where(eq(projects.id, projectId)).get()
  if (project?.path) {
    try {
      const penFiles = await findPenFilesShallow(project.path)
      if (penFiles.length > 0) {
        penFilesSummary = penFiles.slice(0, 5).map(f => {
          const relPath = relative(project.path, f.path)
          const ago = formatTimeAgo(f.mtime)
          return `${relPath} (${ago})`
        }).join(", ")
      }
    } catch { /* non-critical */ }
  }

  // Build compact context block
  const lines: string[] = ["[Pencil Design Context]"]
  if (colors) lines.push(`Colors: ${colors}`)
  if (fonts) lines.push(`Fonts: ${fonts}`)
  if (voice) lines.push(`Voice: ${voice}`)
  if (designVoice) lines.push(`Design Direction: ${designVoice.content.slice(0, 200)}`)
  if (penFilesSummary) lines.push(`Design Files: ${penFilesSummary}`)
  // Pencil MCP instructions — tell Claude how to use the design context with Pencil tools
  lines.push("")
  lines.push("## Pencil MCP Usage Instructions")
  lines.push("When designing UI or creating .pen files, follow this protocol:")
  lines.push("1. ALWAYS call get_guidelines() first to load available guides and styles")
  if (colors || fonts || voice) {
    lines.push("2. Call get_guidelines({ category: 'style' }) to see available style archetypes")
    lines.push("3. When calling get_guidelines with a style, pass these params from the brand kit:")
    if (colors) lines.push(`   - colors: Use the brand colors above as primary/secondary/accent`)
    if (fonts) lines.push(`   - fonts: Use the brand fonts above for headings/body/mono`)
    if (voice) lines.push(`   - imagery: Match the voice/tone described above`)
  }
  lines.push("4. Before inserting frames, call find_empty_space_on_canvas to avoid overlaps")
  lines.push("5. Use batch_get({ patterns: [{ reusable: true }] }) to find existing components before creating new ones")
  lines.push("6. After creating designs with batch_design, call get_screenshot to verify the result")
  lines.push("7. Match all colors, fonts, and spacing to the brand kit above — do not invent new values")

  // Strategy context
  const strategy = allMems.filter(m => m.category === "strategy")
  if (strategy.length > 0) {
    lines.push("")
    lines.push("## Design Strategy")
    for (const s of strategy.slice(0, 3)) {
      lines.push(`- ${s.title}: ${s.content.slice(0, 150)}`)
    }
  }

  return lines.join("\n")
}

/** Quick shallow search for .pen files (max 3 depth levels) */
async function findPenFilesShallow(dir: string, depth = 0): Promise<Array<{ path: string; mtime: number }>> {
  if (depth > 3) return []
  const SKIP = new Set(["node_modules", ".git", "dist", "build", ".next", ".2code"])
  const results: Array<{ path: string; mtime: number }> = []
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = join(dir, entry.name)
      if (entry.isDirectory() && !SKIP.has(entry.name)) {
        results.push(...await findPenFilesShallow(fullPath, depth + 1))
      } else if (extname(entry.name) === ".pen") {
        try {
          const s = await stat(fullPath)
          results.push({ path: fullPath, mtime: s.mtimeMs })
        } catch { /* */ }
      }
    }
  } catch { /* */ }
  return results
}

function formatTimeAgo(mtimeMs: number): string {
  const seconds = (Date.now() - mtimeMs) / 1000
  if (seconds < 60) return "just now"
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
  const days = Math.floor(seconds / 86400)
  return days === 1 ? "1d ago" : `${days}d ago`
}
