import { z } from "zod"
import { router, publicProcedure } from "../index"
import { relative } from "node:path"
import {
  searchTextInProject,
  replaceTextInFile,
  convertHtmlToSourceFormat,
} from "../../preview-edit/source-mapper"

export const previewEditRouter = router({
  /**
   * Apply a text edit from the inline preview editor.
   *
   * The injected script now sends per-text-node changes, so originalText
   * is typically a single line/fragment (e.g. "grew up in rural usa.")
   * rather than the entire paragraph's textContent.
   */
  applyTextEdit: publicProcedure
    .input(
      z.object({
        projectPath: z.string(),
        originalText: z.string(),
        newText: z.string(),
        newHtml: z.string().optional(),
        parentContext: z.string().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const { projectPath, originalText, newText, newHtml, parentContext } = input

      if (!originalText.trim()) {
        return { error: "empty-text" as const }
      }

      // Normalize whitespace for comparison
      const normOld = originalText.replace(/\s+/g, " ").trim()
      const normNew = newText.replace(/\s+/g, " ").trim()
      if (normOld === normNew && (!newHtml || !newHtml.trim())) {
        return { error: "no-change" as const }
      }

      // Search for the original text in source files
      const matches = await searchTextInProject(projectPath, originalText.trim())

      if (matches.length === 0) {
        return { error: "not-found" as const }
      }

      if (matches.length === 1) {
        const match = matches[0]
        const replacement = newHtml && newHtml !== newText
          ? convertHtmlToSourceFormat(newHtml, match.filePath)
          : newText

        const success = await replaceTextInFile(
          match.filePath,
          match.lineNumber,
          originalText.trim(),
          replacement.trim(),
        )
        if (success) {
          return { success: true as const, filePath: relative(projectPath, match.filePath) }
        }
        return { error: "replace-failed" as const }
      }

      // Multiple matches — try narrowing with parent context
      if (parentContext) {
        const narrowed = matches.filter((m) =>
          m.lineContent.includes(parentContext.slice(0, 80)),
        )
        if (narrowed.length === 1) {
          const match = narrowed[0]
          const replacement = newHtml && newHtml !== newText
            ? convertHtmlToSourceFormat(newHtml, match.filePath)
            : newText

          const success = await replaceTextInFile(
            match.filePath,
            match.lineNumber,
            originalText.trim(),
            replacement.trim(),
          )
          if (success) {
            return { success: true as const, filePath: relative(projectPath, match.filePath) }
          }
        }
      }

      return {
        error: "multiple-matches" as const,
        matches: matches.slice(0, 5).map((m) => ({
          filePath: relative(projectPath, m.filePath),
          lineNumber: m.lineNumber,
        })),
      }
    }),
})
