import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { isAbsolute, resolve } from "node:path"
import { z } from "zod"
import { app } from "electron"
import { router, publicProcedure } from "../index"
import { observable } from "@trpc/server/observable"
import { terminalManager } from "../../terminal/manager"
import type { TerminalEvent } from "../../terminal/types"
import { TRPCError } from "@trpc/server"
import { getDatabase, projects } from "../../db"

function validateTerminalPath(p: string): void {
  if (p.includes("\0")) throw new TRPCError({ code: "BAD_REQUEST", message: "Path contains invalid characters" })
  if (!isAbsolute(p)) throw new TRPCError({ code: "BAD_REQUEST", message: "Path must be absolute" })
  resolve(p) // normalizes — throws on malformed paths
}

/**
 * Validates that the given path is within an allowed directory:
 * - A registered project path
 * - A worktree path (under ~/.2code/worktrees/)
 * - The user's home directory
 * - The app's userData directory
 */
function validateTerminalPathScope(p: string): void {
  const normalized = resolve(p)
  const homeDir = os.homedir()
  const userDataDir = app.getPath("userData")
  const worktreesDir = path.join(homeDir, ".2code", "worktrees")

  // Allow paths under the user's home directory
  if (normalized.startsWith(homeDir + path.sep) || normalized === homeDir) {
    return
  }

  // Allow paths under the app's userData directory
  if (normalized.startsWith(userDataDir + path.sep) || normalized === userDataDir) {
    return
  }

  // Allow paths under the worktrees directory
  if (normalized.startsWith(worktreesDir + path.sep) || normalized === worktreesDir) {
    return
  }

  // Check registered project paths from the database
  const db = getDatabase()
  const allProjects = db.select({ path: projects.path }).from(projects).all()
  for (const project of allProjects) {
    const projectPath = resolve(project.path)
    if (normalized === projectPath || normalized.startsWith(projectPath + path.sep)) {
      return
    }
  }

  throw new TRPCError({
    code: "FORBIDDEN",
    message: "Terminal path must be within a project directory",
  })
}

export const terminalRouter = router({
	/**
	 * Create or attach to an existing terminal session.
	 * Returns serializedState for recovery if reattaching.
	 */
	createOrAttach: publicProcedure
		.input(
			z.object({
				paneId: z.string().min(1),
				tabId: z.string().optional(),
				workspaceId: z.string().optional(),
				scopeKey: z.string().optional(),
				cols: z.number().int().positive().optional(),
				rows: z.number().int().positive().optional(),
				cwd: z.string().optional(),
				initialCommands: z.array(z.string()).optional(),
			}),
		)
		.mutation(async ({ input }) => {
			if (input.cwd) {
				validateTerminalPath(input.cwd)
				validateTerminalPathScope(input.cwd)
			}
			try {
				const result = await terminalManager.createOrAttach(input)
				return {
					paneId: input.paneId,
					isNew: result.isNew,
					serializedState: result.serializedState,
				}
			} catch (err) {
				console.error("[TerminalRouter] createOrAttach error:", err)
				throw new TRPCError({
					code: "INTERNAL_SERVER_ERROR",
					message:
						err instanceof Error ? err.message : "Failed to create terminal",
				})
			}
		}),

	write: publicProcedure
		.input(
			z.object({
				paneId: z.string().min(1),
				data: z.string(),
			}),
		)
		.mutation(({ input }) => {
			terminalManager.write(input)
		}),

	resize: publicProcedure
		.input(
			z.object({
				paneId: z.string().min(1),
				cols: z.number().int().positive(),
				rows: z.number().int().positive(),
			}),
		)
		.mutation(({ input }) => {
			terminalManager.resize(input)
		}),

	/**
	 * Send a signal to the terminal process.
	 */
	signal: publicProcedure
		.input(
			z.object({
				paneId: z.string().min(1),
				signal: z.string().optional(),
			}),
		)
		.mutation(({ input }) => {
			terminalManager.signal(input)
		}),

	/**
	 * Kill terminal session - actually terminate it.
	 */
	kill: publicProcedure
		.input(
			z.object({
				paneId: z.string().min(1),
			}),
		)
		.mutation(async ({ input }) => {
			await terminalManager.kill(input)
		}),

	/**
	 * Detach from terminal - keep session alive.
	 * Called on component unmount. Stores serialized state for recovery.
	 */
	detach: publicProcedure
		.input(
			z.object({
				paneId: z.string().min(1),
				serializedState: z.string().optional(),
			}),
		)
		.mutation(({ input }) => {
			terminalManager.detach(input)
		}),

	/**
	 * Clear scrollback buffer for terminal (used by Cmd+K / clear command)
	 */
	clearScrollback: publicProcedure
		.input(z.object({ paneId: z.string().min(1) }))
		.mutation(({ input }) => {
			terminalManager.clearScrollback(input)
		}),

	getSession: publicProcedure
		.input(z.string().min(1))
		.query(({ input: paneId }) => {
			return terminalManager.getSession(paneId)
		}),

	/**
	 * Get count of active terminal sessions for a workspace
	 */
	getActiveSessionCount: publicProcedure
		.input(z.object({ workspaceId: z.string() }))
		.query(({ input }) => {
			return terminalManager.getSessionCountByWorkspaceId(input.workspaceId)
		}),

	/**
	 * List alive terminal sessions for a given scope key.
	 * Used by new workspaces to discover shared terminals (local mode).
	 */
	listSessionsByScopeKey: publicProcedure
		.input(z.object({ scopeKey: z.string() }))
		.query(({ input }) => {
			return terminalManager.getSessionsByScopeKey(input.scopeKey)
		}),

	/**
	 * Get workspace cwd for terminal initialization
	 */
	getWorkspaceCwd: publicProcedure.input(z.string()).query(({ input }) => {
		// For now, just return null - the workspace path comes from the chat/project
		// In the future this could look up the workspace's root directory
		return null
	}),

	/**
	 * List directory contents for navigation
	 */
	listDirectory: publicProcedure
		.input(z.object({ dirPath: z.string() }))
		.query(async ({ input }) => {
			const { dirPath } = input
			validateTerminalPath(dirPath)

			try {
				const entries = await fs.readdir(dirPath, { withFileTypes: true })

				const items = entries
					.filter((entry) => !entry.name.startsWith("."))
					.map((entry) => ({
						name: entry.name,
						path: path.join(dirPath, entry.name),
						isDirectory: entry.isDirectory(),
					}))
					.sort((a, b) => {
						// Directories first, then alphabetical
						if (a.isDirectory && !b.isDirectory) return -1
						if (!a.isDirectory && b.isDirectory) return 1
						return a.name.localeCompare(b.name)
					})

				// Get parent directory
				const parentPath = path.dirname(dirPath)
				const hasParent = parentPath !== dirPath

				return {
					currentPath: dirPath,
					parentPath: hasParent ? parentPath : null,
					items,
				}
			} catch {
				return {
					currentPath: dirPath,
					parentPath: null,
					items: [],
					error: "Unable to read directory",
				}
			}
		}),

	stream: publicProcedure
		.input(z.string().min(1))
		.subscription(({ input: paneId }) => {
			return observable<TerminalEvent>((emit) => {
				const onData = (data: string) => {
					emit.next({ type: "data", data })
				}

				const onExit = (exitCode: number, signal?: number) => {
					emit.next({ type: "exit", exitCode, signal })
					emit.complete()
				}

				terminalManager.on(`data:${paneId}`, onData)
				terminalManager.on(`exit:${paneId}`, onExit)

				return () => {
					terminalManager.off(`data:${paneId}`, onData)
					terminalManager.off(`exit:${paneId}`, onExit)
				}
			})
		}),
})
