/**
 * Memory tRPC router — CRUD for persistent project memories,
 * injection into sessions, auto-extraction, and validation.
 */

import { z } from "zod"
import { router, publicProcedure } from "../index"
import { getDatabase } from "../../db"
import { projectMemories, projects } from "../../db/schema"
import { eq, and, desc, sql, like } from "drizzle-orm"
import { createId } from "../../db/utils"
import { getMemoriesForInjection } from "../../memory/injection"
import { extractMemoriesAsync, MEMORY_CATEGORIES } from "../../memory/extraction"
import { validateMemories } from "../../memory/validation"
import * as fs from "fs"
import * as path from "path"

const memoryCategoryEnum = z.enum([
  "architecture",
  "convention",
  "deployment",
  "debugging",
  "preference",
  "gotcha",
])

const memorySourceEnum = z.enum(["auto", "manual", "command", "suggested"])

export const memoryRouter = router({
  /**
   * List memories for a project, with optional filters.
   */
  list: publicProcedure
    .input(
      z.object({
        projectId: z.string(),
        category: memoryCategoryEnum.optional(),
        includeArchived: z.boolean().optional().default(false),
        includeStale: z.boolean().optional().default(true),
        search: z.string().optional(),
      })
    )
    .query(({ input }) => {
      const db = getDatabase()
      let query = db
        .select()
        .from(projectMemories)
        .where(eq(projectMemories.projectId, input.projectId))
        .orderBy(desc(projectMemories.relevanceScore))

      // Apply filters in JS since drizzle chaining conditions is verbose for SQLite
      let results = query.all()

      if (!input.includeArchived) {
        results = results.filter(m => !m.isArchived)
      }
      if (!input.includeStale) {
        results = results.filter(m => !m.isStale)
      }
      if (input.category) {
        results = results.filter(m => m.category === input.category)
      }
      if (input.search) {
        const s = input.search.toLowerCase()
        results = results.filter(
          m =>
            m.title.toLowerCase().includes(s) ||
            m.content.toLowerCase().includes(s)
        )
      }

      return results
    }),

  /**
   * Get formatted memories for system prompt injection (token-budgeted).
   */
  getForInjection: publicProcedure
    .input(
      z.object({
        projectId: z.string(),
        contextHint: z.string().nullable().optional(),
        maxTokens: z.number().optional().default(2000),
      })
    )
    .query(async ({ input }) => {
      return getMemoriesForInjection(
        input.projectId,
        input.contextHint ?? null,
        input.maxTokens
      )
    }),

  /**
   * Get memory statistics for a project.
   */
  stats: publicProcedure
    .input(z.object({ projectId: z.string() }))
    .query(({ input }) => {
      const db = getDatabase()
      const all = db
        .select()
        .from(projectMemories)
        .where(
          and(
            eq(projectMemories.projectId, input.projectId),
            eq(projectMemories.isArchived, false),
          )
        )
        .all()

      const byCategory: Record<string, number> = {}
      let staleCount = 0
      let estimatedTokens = 0

      for (const m of all) {
        byCategory[m.category] = (byCategory[m.category] || 0) + 1
        if (m.isStale) staleCount++
        // Rough token estimate
        estimatedTokens += Math.ceil((m.title.length + m.content.length + 20) / 4)
      }

      return {
        total: all.length,
        byCategory,
        staleCount,
        estimatedTokens,
      }
    }),

  /**
   * Create a new memory.
   */
  create: publicProcedure
    .input(
      z.object({
        projectId: z.string(),
        category: memoryCategoryEnum,
        title: z.string().min(1).max(200),
        content: z.string().min(1),
        source: memorySourceEnum.optional().default("manual"),
        sourceSubChatId: z.string().optional(),
        relevanceScore: z.number().min(0).max(100).optional().default(50),
        linkedFiles: z.array(z.string()).optional(),
      })
    )
    .mutation(({ input }) => {
      const db = getDatabase()
      return db
        .insert(projectMemories)
        .values({
          id: createId(),
          projectId: input.projectId,
          category: input.category,
          title: input.title,
          content: input.content,
          source: input.source,
          sourceSubChatId: input.sourceSubChatId,
          relevanceScore: input.relevanceScore,
          linkedFiles: input.linkedFiles ? JSON.stringify(input.linkedFiles) : null,
        })
        .returning()
        .get()
    }),

  /**
   * Update an existing memory.
   */
  update: publicProcedure
    .input(
      z.object({
        id: z.string(),
        title: z.string().min(1).max(200).optional(),
        content: z.string().min(1).optional(),
        category: memoryCategoryEnum.optional(),
        relevanceScore: z.number().min(0).max(100).optional(),
        isArchived: z.boolean().optional(),
        isStale: z.boolean().optional(),
        linkedFiles: z.array(z.string()).optional(),
      })
    )
    .mutation(({ input }) => {
      const db = getDatabase()
      const { id, ...updates } = input
      const setData: Record<string, unknown> = { updatedAt: new Date() }

      if (updates.title !== undefined) setData.title = updates.title
      if (updates.content !== undefined) setData.content = updates.content
      if (updates.category !== undefined) setData.category = updates.category
      if (updates.relevanceScore !== undefined) setData.relevanceScore = updates.relevanceScore
      if (updates.isArchived !== undefined) setData.isArchived = updates.isArchived
      if (updates.isStale !== undefined) setData.isStale = updates.isStale
      if (updates.linkedFiles !== undefined) setData.linkedFiles = JSON.stringify(updates.linkedFiles)

      return db
        .update(projectMemories)
        .set(setData)
        .where(eq(projectMemories.id, id))
        .returning()
        .get()
    }),

  /**
   * Permanently delete a memory.
   */
  delete: publicProcedure
    .input(z.object({ id: z.string() }))
    .mutation(({ input }) => {
      const db = getDatabase()
      return db
        .delete(projectMemories)
        .where(eq(projectMemories.id, input.id))
        .returning()
        .get()
    }),

  /**
   * Extract memories from a completed session (fire-and-forget Haiku call).
   */
  extractFromSession: publicProcedure
    .input(
      z.object({
        projectId: z.string(),
        subChatId: z.string(),
        messages: z.array(z.unknown()),
        anthropicApiKey: z.string().optional(),
      })
    )
    .mutation(async ({ input }) => {
      // Fire and forget — don't await
      extractMemoriesAsync(
        input.projectId,
        input.subChatId,
        input.messages,
        input.anthropicApiKey
      ).catch(err => {
        console.error("[memory:extractFromSession] Error:", err)
      })
      return { started: true }
    }),

  /**
   * Validate all memories for a project (check linked file existence).
   */
  validate: publicProcedure
    .input(
      z.object({
        projectId: z.string(),
        projectPath: z.string(),
      })
    )
    .mutation(async ({ input }) => {
      return validateMemories(input.projectId, input.projectPath)
    }),

  /**
   * Import memories from a CLAUDE.md or MEMORY.md file.
   * Parses markdown sections into individual memory entries.
   */
  importFromFile: publicProcedure
    .input(
      z.object({
        projectId: z.string(),
        filePath: z.string(),
        source: memorySourceEnum.optional().default("manual"),
      })
    )
    .mutation(({ input }) => {
      const db = getDatabase()

      if (!fs.existsSync(input.filePath)) {
        throw new Error(`File not found: ${input.filePath}`)
      }

      const content = fs.readFileSync(input.filePath, "utf-8")
      const memories: Array<{
        category: string
        title: string
        content: string
      }> = []

      // Parse markdown: split by ## headings
      const sections = content.split(/^##\s+/m).filter(Boolean)

      for (const section of sections) {
        const lines = section.trim().split("\n")
        const title = lines[0]?.trim()
        if (!title) continue

        const body = lines.slice(1).join("\n").trim()
        if (!body || body.length < 10) continue

        // Try to detect category from title/content keywords
        const textLower = (title + " " + body).toLowerCase()
        let category: string = "preference"
        if (/architect|schema|database|api|route|component/.test(textLower)) {
          category = "architecture"
        } else if (/convention|style|naming|format|lint/.test(textLower)) {
          category = "convention"
        } else if (/deploy|build|ci|cd|release|docker/.test(textLower)) {
          category = "deployment"
        } else if (/debug|fix|bug|error|crash|issue/.test(textLower)) {
          category = "debugging"
        } else if (/gotcha|caveat|warning|careful|pitfall|race condition/.test(textLower)) {
          category = "gotcha"
        }

        memories.push({
          category,
          title: title.slice(0, 200),
          content: body,
        })
      }

      // Insert all
      let inserted = 0
      for (const m of memories) {
        db.insert(projectMemories)
          .values({
            id: createId(),
            projectId: input.projectId,
            category: m.category,
            title: m.title,
            content: m.content,
            source: input.source,
            relevanceScore: 50,
          })
          .run()
        inserted++
      }

      return { imported: inserted, total: memories.length }
    }),
})
