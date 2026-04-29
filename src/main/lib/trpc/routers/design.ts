/**
 * Design tRPC router — Pencil integration, brand kit management,
 * design tokens, visual references, and .pen file discovery.
 */

import { z } from "zod"
import { router, publicProcedure } from "../index"
import { getDatabase } from "../../db"
import { projectMemories, projects } from "../../db/schema"
import { eq, and, desc } from "drizzle-orm"
import { createId } from "../../db/utils"
import { readdir, stat, unlink, mkdir, copyFile, readFile } from "node:fs/promises"
import { join, relative, basename, extname } from "node:path"
import { existsSync } from "node:fs"
import { BrowserWindow, dialog } from "electron"
// callClaude is imported lazily inside autoFillDesign to avoid circular dependency
// (design.ts → claude/api.ts → trpc/routers/claude.ts → index.ts → design.ts)

// ─── Helpers ───────────────────────────────────────────────────────────────────

/** Recursively find .pen files in a directory */
async function findPenFiles(dir: string, maxDepth = 5, depth = 0): Promise<Array<{ path: string; name: string; mtime: number }>> {
  if (depth > maxDepth) return []

  const results: Array<{ path: string; name: string; mtime: number }> = []
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = join(dir, entry.name)
      if (entry.isDirectory()) {
        // Skip common non-project dirs
        if (["node_modules", ".git", "dist", "build", ".next", ".2code"].includes(entry.name)) continue
        const sub = await findPenFiles(fullPath, maxDepth, depth + 1)
        results.push(...sub)
      } else if (extname(entry.name) === ".pen") {
        try {
          const s = await stat(fullPath)
          results.push({ path: fullPath, name: entry.name, mtime: s.mtimeMs })
        } catch { /* skip unreadable */ }
      }
    }
  } catch { /* permission denied or not a directory */ }
  return results
}

/** Get project path from project ID */
function getProjectPath(projectId: string): string | null {
  const db = getDatabase()
  const project = db.select({ path: projects.path }).from(projects).where(eq(projects.id, projectId)).get()
  return project?.path ?? null
}

// ─── Router ────────────────────────────────────────────────────────────────────

export const designRouter = router({
  /**
   * List all .pen files in the project directory.
   */
  listPenFiles: publicProcedure
    .input(z.object({ projectId: z.string() }))
    .query(async ({ input }) => {
      const projectPath = getProjectPath(input.projectId)
      if (!projectPath) return []

      const files = await findPenFiles(projectPath)
      // Sort by most recently modified
      files.sort((a, b) => b.mtime - a.mtime)
      return files
    }),

  /**
   * Get the full design kit: all brand + design + strategy memories, structured.
   */
  getDesignKit: publicProcedure
    .input(z.object({ projectId: z.string() }))
    .query(({ input }) => {
      const db = getDatabase()

      const allDesignMemories = db
        .select()
        .from(projectMemories)
        .where(
          and(
            eq(projectMemories.projectId, input.projectId),
            eq(projectMemories.isArchived, false),
          )
        )
        .orderBy(desc(projectMemories.relevanceScore))
        .all()
        .filter(m => ["brand", "design", "strategy"].includes(m.category))

      const brand = allDesignMemories.filter(m => m.category === "brand")
      const design = allDesignMemories.filter(m => m.category === "design")
      const strategy = allDesignMemories.filter(m => m.category === "strategy")

      // Extract structured brand fields from brand memories
      const colors = brand.filter(m => /color|palette/i.test(m.title))
      const typography = brand.filter(m => /font|typo/i.test(m.title))
      const voice = brand.filter(m => /voice|tone|persona/i.test(m.title))
      const designVoice = design.find(m => /design voice|design direction|design philosophy/i.test(m.title))

      return {
        brand,
        design,
        strategy,
        structured: {
          colors,
          typography,
          voice,
          designVoice: designVoice ?? null,
        },
        totalCount: allDesignMemories.length,
      }
    }),

  /**
   * Save/upsert a brand kit field as a memory.
   */
  saveBrandKit: publicProcedure
    .input(z.object({
      projectId: z.string(),
      field: z.enum(["colors", "typography", "voice", "designVoice", "logo", "brandName"]),
      title: z.string(),
      content: z.string(),
      /** If provided, update existing memory instead of creating new */
      memoryId: z.string().optional(),
    }))
    .mutation(({ input }) => {
      const db = getDatabase()
      const now = new Date()

      // Map field to category
      const category = input.field === "designVoice" ? "design" : "brand"

      if (input.memoryId) {
        // Update existing
        db.update(projectMemories)
          .set({
            title: input.title,
            content: input.content,
            updatedAt: now,
          })
          .where(eq(projectMemories.id, input.memoryId))
          .run()
        return { id: input.memoryId, action: "updated" as const }
      } else {
        // Create new
        const id = createId()
        db.insert(projectMemories)
          .values({
            id,
            projectId: input.projectId,
            category,
            title: input.title,
            content: input.content,
            source: "manual",
            relevanceScore: 80, // Brand/design memories are high priority
          })
          .run()
        return { id, action: "created" as const }
      }
    }),

  /**
   * List visual references for a project.
   * References are stored as design memories with source "reference".
   */
  listReferences: publicProcedure
    .input(z.object({ projectId: z.string() }))
    .query(({ input }) => {
      const db = getDatabase()

      return db
        .select()
        .from(projectMemories)
        .where(
          and(
            eq(projectMemories.projectId, input.projectId),
            eq(projectMemories.category, "design"),
            eq(projectMemories.source, "reference" as any),
            eq(projectMemories.isArchived, false),
          )
        )
        .orderBy(desc(projectMemories.createdAt))
        .all()
        .map(m => {
          let imagePath = ""
          let tags: string[] = []
          try {
            const linked = JSON.parse(m.linkedFiles ?? "[]")
            imagePath = linked[0] ?? ""
          } catch { /* */ }
          try {
            // Tags stored in title as comma-separated after "Reference: "
            const tagStr = m.title.replace(/^Reference:\s*/i, "")
            tags = tagStr.split(",").map(t => t.trim()).filter(Boolean)
          } catch { /* */ }
          return {
            id: m.id,
            imagePath,
            tags,
            description: m.content,
            createdAt: m.createdAt,
          }
        })
    }),

  /**
   * Add a visual reference image.
   * Copies the image to .2code/design-refs/ and creates a memory entry.
   */
  addReference: publicProcedure
    .input(z.object({
      projectId: z.string(),
      sourcePath: z.string(),
      tags: z.array(z.string()).default([]),
      description: z.string().default(""),
    }))
    .mutation(async ({ input }) => {
      const projectPath = getProjectPath(input.projectId)
      if (!projectPath) throw new Error("Project not found")

      // Ensure .2code/design-refs/ exists
      const refsDir = join(projectPath, ".2code", "design-refs")
      await mkdir(refsDir, { recursive: true })

      // Copy image to refs dir with unique name
      const ext = extname(input.sourcePath)
      const fileName = `ref-${Date.now()}${ext}`
      const destPath = join(refsDir, fileName)
      await copyFile(input.sourcePath, destPath)

      // Create memory entry
      const db = getDatabase()
      const id = createId()
      db.insert(projectMemories)
        .values({
          id,
          projectId: input.projectId,
          category: "design",
          title: `Reference: ${input.tags.join(", ") || "general"}`,
          content: input.description || "Visual design reference",
          source: "reference" as any,
          linkedFiles: JSON.stringify([destPath]),
          relevanceScore: 70,
        })
        .run()

      return { id, imagePath: destPath }
    }),

  /**
   * Remove a visual reference — deletes image file and memory entry.
   */
  removeReference: publicProcedure
    .input(z.object({ referenceId: z.string() }))
    .mutation(async ({ input }) => {
      const db = getDatabase()

      // Get the memory to find the image path
      const memory = db.select().from(projectMemories).where(eq(projectMemories.id, input.referenceId)).get()
      if (!memory) return { success: false }

      // Delete the image file
      try {
        const linked = JSON.parse(memory.linkedFiles ?? "[]")
        if (linked[0] && existsSync(linked[0])) {
          await unlink(linked[0])
        }
      } catch { /* non-critical */ }

      // Delete the memory
      db.delete(projectMemories).where(eq(projectMemories.id, input.referenceId)).run()

      return { success: true }
    }),

  /**
   * Get references matched by tag for injection into Claude sessions.
   * Returns image paths for multimodal injection.
   */
  getReferencesForInjection: publicProcedure
    .input(z.object({
      projectId: z.string(),
      contextHint: z.string().default(""),
      maxCount: z.number().default(3),
    }))
    .query(({ input }) => {
      const db = getDatabase()

      const allRefs = db
        .select()
        .from(projectMemories)
        .where(
          and(
            eq(projectMemories.projectId, input.projectId),
            eq(projectMemories.category, "design"),
            eq(projectMemories.source, "reference" as any),
            eq(projectMemories.isArchived, false),
          )
        )
        .all()

      if (allRefs.length === 0) return []

      // Score by tag matching against context hint
      const hintLower = input.contextHint.toLowerCase()
      const scored = allRefs.map(ref => {
        let score = 0
        const tags = ref.title.replace(/^Reference:\s*/i, "").split(",").map(t => t.trim().toLowerCase())
        for (const tag of tags) {
          if (hintLower.includes(tag)) score += 10
        }
        // Recency boost
        if (ref.createdAt) {
          const daysSince = (Date.now() - ref.createdAt.getTime()) / (1000 * 60 * 60 * 24)
          if (daysSince <= 7) score += 5
        }
        return { ref, score }
      })

      scored.sort((a, b) => b.score - a.score)

      return scored.slice(0, input.maxCount).map(s => {
        let imagePath = ""
        try {
          const linked = JSON.parse(s.ref.linkedFiles ?? "[]")
          imagePath = linked[0] ?? ""
        } catch { /* */ }
        return {
          id: s.ref.id,
          imagePath,
          title: s.ref.title,
          description: s.ref.content,
        }
      })
    }),

  /**
   * Compute design confidence score (0-100).
   * Used by GAAD to decide whether to ask clarifying questions.
   */
  getDesignConfidence: publicProcedure
    .input(z.object({ projectId: z.string() }))
    .query(async ({ input }) => {
      const db = getDatabase()
      const projectPath = getProjectPath(input.projectId)

      const allMems = db
        .select()
        .from(projectMemories)
        .where(
          and(
            eq(projectMemories.projectId, input.projectId),
            eq(projectMemories.isArchived, false),
          )
        )
        .all()

      const brandCount = allMems.filter(m => m.category === "brand").length
      const designCount = allMems.filter(m => m.category === "design").length
      const strategyCount = allMems.filter(m => m.category === "strategy").length

      let score = 0

      // Brand memories exist (+25)
      if (brandCount > 0) score += Math.min(brandCount * 8, 25)

      // Design memories exist (+25)
      if (designCount > 0) score += Math.min(designCount * 8, 25)

      // .pen files exist in project (+20)
      if (projectPath) {
        const penFiles = await findPenFiles(projectPath, 3)
        if (penFiles.length > 0) score += 20
      }

      // Strategy memories (+15)
      if (strategyCount > 0) score += Math.min(strategyCount * 5, 15)

      // No conflicting memories (+15) — simple heuristic: no duplicates by title pattern
      const titles = allMems.filter(m => ["brand", "design"].includes(m.category)).map(m => m.title.toLowerCase())
      const uniqueTitles = new Set(titles)
      if (titles.length === uniqueTitles.size) score += 15

      const level = score >= 80 ? "ready" : score >= 50 ? "fair" : "low"

      const missing: string[] = []
      if (brandCount === 0) missing.push("No brand colors or typography defined")
      if (designCount === 0) missing.push("No design direction or voice set")
      if (strategyCount === 0) missing.push("No design strategy documented")

      return { score: Math.min(score, 100), level, missing, brandCount, designCount, strategyCount }
    }),

  /**
   * Build the compact design context block for system prompt injection.
   * Called by claude.ts during session setup.
   */
  getDesignContextBlock: publicProcedure
    .input(z.object({ projectId: z.string() }))
    .query(async ({ input }) => {
      const db = getDatabase()
      const projectPath = getProjectPath(input.projectId)

      const allMems = db
        .select()
        .from(projectMemories)
        .where(
          and(
            eq(projectMemories.projectId, input.projectId),
            eq(projectMemories.isArchived, false),
          )
        )
        .all()
        .filter(m => ["brand", "design", "strategy"].includes(m.category))

      if (allMems.length === 0) return null

      const brand = allMems.filter(m => m.category === "brand")
      const design = allMems.filter(m => m.category === "design")

      // Extract structured info for compact block
      const colors = brand.filter(m => /color|palette/i.test(m.title)).map(m => m.content).join(", ")
      const fonts = brand.filter(m => /font|typo/i.test(m.title)).map(m => m.content).join(", ")
      const voice = brand.filter(m => /voice|tone/i.test(m.title)).map(m => m.content).join("; ")
      const designVoice = design.find(m => /design voice|design direction|design philosophy/i.test(m.title))

      // Find .pen files
      let penFilesSummary = ""
      if (projectPath) {
        const penFiles = await findPenFiles(projectPath, 3)
        if (penFiles.length > 0) {
          penFilesSummary = penFiles.slice(0, 5).map(f => {
            const relPath = relative(projectPath!, f.path)
            const ago = formatTimeAgo(f.mtime)
            return `${relPath} (${ago})`
          }).join(", ")
        }
      }

      // Build compact context block (~200-500 tokens)
      const lines: string[] = ["[Pencil Design Context]"]
      if (colors) lines.push(`Colors: ${colors}`)
      if (fonts) lines.push(`Fonts: ${fonts}`)
      if (voice) lines.push(`Voice: ${voice}`)
      if (designVoice) lines.push(`Design Direction: ${designVoice.content.slice(0, 200)}`)
      if (penFilesSummary) lines.push(`Design Files: ${penFilesSummary}`)

      return lines.join("\n")
    }),

  /**
   * Open a file picker for reference images and add them.
   * Returns the created references or null if cancelled.
   */
  pickAndAddReferences: publicProcedure
    .input(z.object({
      projectId: z.string(),
      tags: z.array(z.string()).default([]),
      description: z.string().default(""),
    }))
    .mutation(async ({ input }) => {
      const window = BrowserWindow.getFocusedWindow()
      if (!window) throw new Error("No focused window")

      const result = await dialog.showOpenDialog(window, {
        properties: ["openFile", "multiSelections"],
        title: "Select Reference Images",
        buttonLabel: "Add References",
        filters: [
          { name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "gif", "svg"] },
        ],
      })

      if (result.canceled || result.filePaths.length === 0) return []

      const projectPath = getProjectPath(input.projectId)
      if (!projectPath) throw new Error("Project not found")

      const refsDir = join(projectPath, ".2code", "design-refs")
      await mkdir(refsDir, { recursive: true })

      const created: Array<{ id: string; imagePath: string; fileName: string }> = []
      const db = getDatabase()

      for (const sourcePath of result.filePaths) {
        const ext = extname(sourcePath)
        const originalName = basename(sourcePath, ext)
        const fileName = `ref-${Date.now()}-${originalName}${ext}`
        const destPath = join(refsDir, fileName)
        await copyFile(sourcePath, destPath)

        const id = createId()
        db.insert(projectMemories)
          .values({
            id,
            projectId: input.projectId,
            category: "design",
            title: `Reference: ${input.tags.join(", ") || originalName}`,
            content: input.description || `Visual design reference: ${originalName}`,
            source: "reference" as any,
            linkedFiles: JSON.stringify([destPath]),
            relevanceScore: 70,
          })
          .run()

        created.push({ id, imagePath: destPath, fileName })
      }

      return created
    }),

  /**
   * Read a reference image as base64 data URL for display in renderer.
   */
  readReferenceImage: publicProcedure
    .input(z.object({ imagePath: z.string() }))
    .query(async ({ input }) => {
      if (!existsSync(input.imagePath)) return null
      try {
        const buffer = await readFile(input.imagePath)
        const ext = extname(input.imagePath).slice(1).toLowerCase()
        const mime = ext === "svg" ? "image/svg+xml"
          : ext === "webp" ? "image/webp"
          : ext === "gif" ? "image/gif"
          : ext === "png" ? "image/png"
          : "image/jpeg"
        return `data:${mime};base64,${buffer.toString("base64")}`
      } catch {
        return null
      }
    }),

  /**
   * Auto-fill the design brain by analyzing the project codebase.
   * Uses callClaude to scan tailwind config, CSS, components, AGENTS.md, etc.
   * and extract design-relevant information into structured memories.
   */
  autoFillDesign: publicProcedure
    .input(z.object({ projectId: z.string() }))
    .mutation(async ({ input }) => {
      const projectPath = getProjectPath(input.projectId)
      if (!projectPath) throw new Error("Project not found")

      // Gather project context for Claude to analyze
      const context = await gatherDesignContext(projectPath)

      // Lazy import to avoid circular dependency
      const { callClaude } = await import("../../claude/api")

      const result = await callClaude({
        system: `You are a design system analyst. Analyze this project's codebase and extract design information.

Return a JSON object with these fields (use null for anything you can't determine):
{
  "colors": { "title": "Color Palette", "content": "description of colors found with hex values" } | null,
  "typography": { "title": "Typography", "content": "fonts and type scale used" } | null,
  "voice": { "title": "Voice & Tone", "content": "brand personality and design tone" } | null,
  "designVoice": { "title": "Design Voice", "content": "overall design philosophy and aesthetic direction" } | null,
  "strategy": { "title": "Design Strategy", "content": "key design decisions and patterns" } | null
}

Be specific — include actual hex values, font names, spacing values. If you see Tailwind classes, translate them to their actual values. If AGENTS.md has design instructions, incorporate them. Only include fields where you have real evidence.

Return ONLY the JSON, no markdown fences, no explanation.`,
        userMessage: context,
        model: "sonnet",
        maxTokens: 2000,
        timeoutMs: 60_000,
      })

      // Parse the response
      let parsed: Record<string, { title: string; content: string } | null>
      try {
        // Strip markdown fences if present
        const cleaned = result.text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim()
        parsed = JSON.parse(cleaned)
      } catch {
        throw new Error("Claude returned unparseable design analysis")
      }

      // Save each extracted field as a memory
      const db = getDatabase()
      const created: Array<{ category: string; title: string }> = []

      const fields: Array<{ key: string; category: "brand" | "design" | "strategy" }> = [
        { key: "colors", category: "brand" },
        { key: "typography", category: "brand" },
        { key: "voice", category: "brand" },
        { key: "designVoice", category: "design" },
        { key: "strategy", category: "strategy" },
      ]

      for (const field of fields) {
        const value = parsed[field.key]
        if (!value || !value.title || !value.content) continue

        // Check if a similar memory already exists (don't duplicate)
        const existing = db.select()
          .from(projectMemories)
          .where(
            and(
              eq(projectMemories.projectId, input.projectId),
              eq(projectMemories.category, field.category),
              eq(projectMemories.isArchived, false),
            )
          )
          .all()
          .find(m => m.title.toLowerCase() === value.title.toLowerCase())

        if (existing) continue

        db.insert(projectMemories)
          .values({
            id: createId(),
            projectId: input.projectId,
            category: field.category,
            title: value.title,
            content: value.content,
            source: "auto",
            relevanceScore: 75,
          })
          .run()

        created.push({ category: field.category, title: value.title })
      }

      return { created, tokensUsed: result.inputTokens + result.outputTokens }
    }),
})

/**
 * Gather design-relevant files from the project for Claude to analyze.
 * Reads tailwind config, CSS files, AGENTS.md, package.json, etc.
 */
async function gatherDesignContext(projectPath: string): Promise<string> {
  const sections: string[] = [`Project path: ${projectPath}\n`]

  // Files to check for design info, in priority order
  const designFiles = [
    { path: "AGENTS.md", label: "AGENTS.md (project instructions)" },
    { path: "CLAUDE.md", label: "CLAUDE.md (project instructions)" },
    { path: "tailwind.config.ts", label: "Tailwind Config" },
    { path: "tailwind.config.js", label: "Tailwind Config" },
    { path: "tailwind.config.mjs", label: "Tailwind Config" },
    { path: "src/app/globals.css", label: "Global CSS" },
    { path: "src/styles/globals.css", label: "Global CSS" },
    { path: "src/index.css", label: "Global CSS" },
    { path: "app/globals.css", label: "Global CSS" },
    { path: "styles/globals.css", label: "Global CSS" },
    { path: "package.json", label: "Package.json (for font/UI packages)" },
    { path: ".2code/ambient.json", label: "Ambient config" },
  ]

  for (const file of designFiles) {
    const fullPath = join(projectPath, file.path)
    if (!existsSync(fullPath)) continue
    try {
      let content = await readFile(fullPath, "utf-8")
      // Truncate large files — we only need the design-relevant parts
      if (content.length > 3000) {
        content = content.slice(0, 3000) + "\n...(truncated)"
      }
      sections.push(`--- ${file.label} (${file.path}) ---\n${content}\n`)
    } catch { /* skip unreadable */ }
  }

  // Find some representative component files for style patterns
  try {
    const componentDirs = ["src/components", "src/app", "src/renderer/components", "components", "app"]
    for (const dir of componentDirs) {
      const fullDir = join(projectPath, dir)
      if (!existsSync(fullDir)) continue
      const entries = await readdir(fullDir, { withFileTypes: true })
      const tsxFiles = entries.filter(e => e.isFile() && /\.(tsx|jsx)$/.test(e.name)).slice(0, 3)
      for (const file of tsxFiles) {
        try {
          let content = await readFile(join(fullDir, file.name), "utf-8")
          if (content.length > 2000) content = content.slice(0, 2000) + "\n...(truncated)"
          sections.push(`--- Component: ${dir}/${file.name} ---\n${content}\n`)
        } catch { /* skip */ }
      }
      break // Only scan the first matching component dir
    }
  } catch { /* non-critical */ }

  // Include existing design memories for context
  const db = getDatabase()
  const existingMems = db.select()
    .from(projectMemories)
    .where(and(
      eq(projectMemories.projectId, getProjectIdByPath(projectPath) ?? ""),
      eq(projectMemories.isArchived, false),
    ))
    .all()
    .filter(m => ["brand", "design", "strategy"].includes(m.category))

  if (existingMems.length > 0) {
    sections.push("--- Existing Design Memories ---")
    for (const m of existingMems) {
      sections.push(`[${m.category}] ${m.title}: ${m.content}`)
    }
    sections.push("(Don't duplicate these — only add NEW information)\n")
  }

  return sections.join("\n")
}

function getProjectIdByPath(projectPath: string): string | null {
  const db = getDatabase()
  const project = db.select({ id: projects.id }).from(projects).where(eq(projects.path, projectPath)).get()
  return project?.id ?? null
}

function formatTimeAgo(mtimeMs: number): string {
  const seconds = (Date.now() - mtimeMs) / 1000
  if (seconds < 60) return "just now"
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
  const days = Math.floor(seconds / 86400)
  return days === 1 ? "1d ago" : `${days}d ago`
}
