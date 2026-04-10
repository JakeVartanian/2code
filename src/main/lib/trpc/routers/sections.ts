import { z } from "zod"
import { router, publicProcedure } from "../index"
import { getDatabase, projects } from "../../db"
import { eq } from "drizzle-orm"
import {
  getOrDetectSections,
  writeSectionsConfig,
  readSectionsConfig,
} from "../../sections/sections-config"
import { detectSections } from "../../sections/detect-sections"
import type { SectionsConfig } from "../../../../shared/section-types"

const WorkspaceSectionSchema = z.object({
  id: z.string(),
  name: z.string(),
  patterns: z.array(z.string()),
  enabled: z.boolean(),
  color: z.string().optional(),
  icon: z.string().optional(),
})

const SectionsConfigSchema = z.object({
  version: z.literal(1),
  sections: z.array(WorkspaceSectionSchema),
  autoDetected: z.boolean().optional(),
})

export const sectionsRouter = router({
  /**
   * Get sections for a project (auto-detect if none saved)
   */
  get: publicProcedure
    .input(z.object({ projectId: z.string() }))
    .query(async ({ input }) => {
      const db = getDatabase()
      const project = db
        .select()
        .from(projects)
        .where(eq(projects.id, input.projectId))
        .get()

      if (!project) {
        throw new Error("Project not found")
      }

      const config = await getOrDetectSections(project.path)
      return {
        config,
        projectPath: project.path,
      }
    }),

  /**
   * Save sections config for a project
   */
  save: publicProcedure
    .input(
      z.object({
        projectId: z.string(),
        config: SectionsConfigSchema,
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDatabase()
      const project = db
        .select()
        .from(projects)
        .where(eq(projects.id, input.projectId))
        .get()

      if (!project) {
        throw new Error("Project not found")
      }

      await writeSectionsConfig(project.path, input.config as SectionsConfig)
      return { success: true }
    }),

  /**
   * Re-run auto-detection (ignores saved config)
   */
  detect: publicProcedure
    .input(z.object({ projectId: z.string() }))
    .mutation(async ({ input }) => {
      const db = getDatabase()
      const project = db
        .select()
        .from(projects)
        .where(eq(projects.id, input.projectId))
        .get()

      if (!project) {
        throw new Error("Project not found")
      }

      return detectSections(project.path)
    }),

  /**
   * Toggle a specific section's enabled state
   */
  toggle: publicProcedure
    .input(
      z.object({
        projectId: z.string(),
        sectionId: z.string(),
        enabled: z.boolean(),
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDatabase()
      const project = db
        .select()
        .from(projects)
        .where(eq(projects.id, input.projectId))
        .get()

      if (!project) {
        throw new Error("Project not found")
      }

      // Load current config (or auto-detect)
      const config = await getOrDetectSections(project.path)

      // Update the section
      const section = config.sections.find((s) => s.id === input.sectionId)
      if (!section) {
        throw new Error(`Section "${input.sectionId}" not found`)
      }
      section.enabled = input.enabled

      // Save (auto-persist on toggle)
      await writeSectionsConfig(project.path, config)
      return { success: true, config }
    }),

  /**
   * Get sections config by project path (used by Claude session setup)
   */
  getByPath: publicProcedure
    .input(z.object({ projectPath: z.string() }))
    .query(async ({ input }) => {
      return getOrDetectSections(input.projectPath)
    }),
})
