import { z } from "zod"
import { router, publicProcedure } from "../index"
import {
  initVault,
  hasVault,
  getVault,
  readMemoryMd,
  readTopicFile,
  readTopicEntries,
  addEntry,
  deleteEntry,
  getAllEntries,
  getSessionLogs,
  updateMemoryIndex,
  consolidate,
  createVaultBackup,
  exportVault,
  importVault,
  checkEntryLimit,
  type MemoryEntry,
  type MemoryCategory,
  type MemoryConfidence,
} from "../../memory"
import { createId } from "../../db/utils"

const memoryCategorySchema = z.enum([
  "project-identity",
  "architecture-decision",
  "operational-knowledge",
  "current-context",
  "rejected-approach",
  "convention",
  "debugging-pattern",
])

const memoryConfidenceSchema = z.enum(["low", "medium", "high"])

export const memoryRouter = router({
  /** Get full vault state for a project */
  getVault: publicProcedure
    .input(z.object({ projectPath: z.string() }))
    .query(({ input }) => {
      if (!hasVault(input.projectPath)) return null
      return getVault(input.projectPath)
    }),

  /** Initialize vault for a project (idempotent) */
  init: publicProcedure
    .input(z.object({ projectPath: z.string() }))
    .mutation(({ input }) => {
      return initVault(input.projectPath)
    }),

  /** Get MEMORY.md content (hot tier) for system prompt injection */
  getMemoryIndex: publicProcedure
    .input(z.object({ projectPath: z.string() }))
    .query(({ input }) => {
      return readMemoryMd(input.projectPath)
    }),

  /** Get a topic file's raw content */
  getTopicFile: publicProcedure
    .input(z.object({ projectPath: z.string(), filename: z.string() }))
    .query(({ input }) => {
      return readTopicFile(input.projectPath, input.filename)
    }),

  /** Get parsed entries from a topic file */
  getTopicEntries: publicProcedure
    .input(z.object({ projectPath: z.string(), filename: z.string() }))
    .query(({ input }) => {
      return readTopicEntries(input.projectPath, input.filename)
    }),

  /** Get all entries across all topic files */
  getAllEntries: publicProcedure
    .input(z.object({ projectPath: z.string() }))
    .query(({ input }) => {
      return getAllEntries(input.projectPath)
    }),

  /** Add or update a memory entry */
  upsertEntry: publicProcedure
    .input(
      z.object({
        projectPath: z.string(),
        category: memoryCategorySchema,
        confidence: memoryConfidenceSchema.default("medium"),
        body: z.string().min(1),
        tags: z.array(z.string()).default([]),
        source: z.string().default("user"),
        id: z.string().optional(),
      }),
    )
    .mutation(({ input }) => {
      const entry: MemoryEntry = {
        meta: {
          id: input.id || createId(),
          created: new Date().toISOString(),
          category: input.category,
          confidence: input.confidence,
          source: input.source,
          tags: input.tags,
          status: "active",
          lastReferenced: new Date().toISOString(),
        },
        body: input.body,
      }
      return addEntry(input.projectPath, entry)
    }),

  /** Delete a memory entry by ID */
  deleteEntry: publicProcedure
    .input(z.object({ projectPath: z.string(), entryId: z.string() }))
    .mutation(({ input }) => {
      return deleteEntry(input.projectPath, input.entryId)
    }),

  /** Get session logs (cold tier) */
  getSessionLogs: publicProcedure
    .input(
      z.object({
        projectPath: z.string(),
        limit: z.number().min(1).max(100).default(20),
      }),
    )
    .query(({ input }) => {
      return getSessionLogs(input.projectPath, input.limit)
    }),

  /** Manually trigger memory index regeneration */
  refreshIndex: publicProcedure
    .input(z.object({ projectPath: z.string() }))
    .mutation(({ input }) => {
      updateMemoryIndex(input.projectPath)
      return { success: true }
    }),

  /** Manually trigger consolidation (deduplicate, archive stale, clean index) */
  consolidate: publicProcedure
    .input(z.object({ projectPath: z.string() }))
    .mutation(({ input }) => {
      return consolidate(input.projectPath)
    }),

  /** Create a vault backup */
  backup: publicProcedure
    .input(z.object({ projectPath: z.string() }))
    .mutation(({ input }) => {
      const backupDir = createVaultBackup(input.projectPath)
      return { backupDir }
    }),

  /** Export vault as a single markdown file */
  exportVault: publicProcedure
    .input(z.object({ projectPath: z.string() }))
    .query(({ input }) => {
      return exportVault(input.projectPath)
    }),

  /** Import entries from an exported vault markdown */
  importVault: publicProcedure
    .input(z.object({ projectPath: z.string(), content: z.string() }))
    .mutation(({ input }) => {
      return importVault(input.projectPath, input.content)
    }),

  /** Check entry count against limit */
  checkLimit: publicProcedure
    .input(z.object({ projectPath: z.string() }))
    .query(({ input }) => {
      return checkEntryLimit(input.projectPath)
    }),
})
