/**
 * In-memory ring buffer that captures recent terminal output per pane.
 * Hooks into terminalManager `data:{paneId}` events, strips ANSI codes,
 * and provides workspace-scoped access to recent lines for Claude context injection.
 */

const MAX_LINES_PER_PANE = 100
const MAX_BYTES_PER_PANE = 50_000

// Strip ANSI escape sequences (colors, cursor moves, etc.)
const ANSI_REGEX = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[()][AB012]|\x1b\[[\?]?[0-9;]*[hlm]|\r/g

interface PaneBuffer {
	lines: string[]
	workspaceId: string
	totalBytes: number
	lastDataAt: number
	/** Partial line accumulator (data chunks don't always end on newlines) */
	partial: string
}

class TerminalOutputBuffer {
	private buffers = new Map<string, PaneBuffer>()
	private sweepInterval: ReturnType<typeof setInterval> | null = null

	/**
	 * Register a terminal pane for output capture.
	 * Call this alongside portManager.registerSession().
	 */
	registerSession(paneId: string, workspaceId: string): void {
		this.buffers.set(paneId, {
			lines: [],
			workspaceId,
			totalBytes: 0,
			lastDataAt: Date.now(),
			partial: "",
		})

		// Start defensive sweep when first buffer is registered
		if (this.buffers.size === 1 && !this.sweepInterval) {
			this.startSweep()
		}
	}

	/**
	 * Unregister a terminal pane and discard its buffer.
	 * Call this alongside portManager.unregisterSession().
	 */
	unregisterSession(paneId: string): void {
		this.buffers.delete(paneId)

		if (this.buffers.size === 0) {
			this.stopSweep()
		}
	}

	/**
	 * Feed raw terminal data into the buffer for a pane.
	 * Called from terminalManager's `data:{paneId}` event handler.
	 */
	onData(paneId: string, data: string): void {
		const buf = this.buffers.get(paneId)
		if (!buf) return

		buf.lastDataAt = Date.now()

		// Strip ANSI and split into lines
		const clean = (buf.partial + data).replace(ANSI_REGEX, "")
		const parts = clean.split("\n")

		// Last part is a partial line (no trailing newline yet)
		buf.partial = parts.pop() || ""

		for (const line of parts) {
			const trimmed = line.trimEnd()
			if (trimmed.length === 0) continue

			buf.lines.push(trimmed)
			buf.totalBytes += trimmed.length

			// Evict oldest lines if over limits
			while (buf.lines.length > MAX_LINES_PER_PANE || buf.totalBytes > MAX_BYTES_PER_PANE) {
				const removed = buf.lines.shift()
				if (removed) buf.totalBytes -= removed.length
			}
		}
	}

	/**
	 * Get recent lines for all panes in a workspace.
	 * Returns a Map of paneId -> lines (most recent last).
	 */
	getRecentLinesByWorkspace(workspaceId: string, lineCount: number): Map<string, { lines: string[]; lastDataAt: number }> {
		const result = new Map<string, { lines: string[]; lastDataAt: number }>()

		for (const [paneId, buf] of this.buffers) {
			if (buf.workspaceId !== workspaceId) continue
			if (buf.lines.length === 0) continue

			result.set(paneId, {
				lines: buf.lines.slice(-lineCount),
				lastDataAt: buf.lastDataAt,
			})
		}

		return result
	}

	/**
	 * Clear all buffers. Called during app cleanup/shutdown.
	 */
	clear(): void {
		this.buffers.clear()
		this.stopSweep()
	}

	/**
	 * Check if a pane is still registered (for defensive sweep).
	 */
	hasPaneId(paneId: string): boolean {
		return this.buffers.has(paneId)
	}

	/**
	 * Remove a buffer entry by paneId if it exists.
	 * Used by the defensive sweep to clean up orphans.
	 */
	removeOrphan(paneId: string): void {
		this.buffers.delete(paneId)
	}

	/**
	 * Get all registered pane IDs (for defensive sweep cross-referencing).
	 */
	getRegisteredPaneIds(): string[] {
		return Array.from(this.buffers.keys())
	}

	private startSweep(): void {
		// Every 60s, check for orphaned buffers
		this.sweepInterval = setInterval(() => {
			// Import terminalManager lazily to avoid circular dependency
			try {
				const { terminalManager } = require("./manager")
				for (const paneId of this.buffers.keys()) {
					const session = terminalManager.getSession(paneId)
					if (!session) {
						console.log(`[OutputBuffer] Removing orphaned buffer for pane ${paneId}`)
						this.buffers.delete(paneId)
					}
				}
			} catch {
				// If manager isn't available, skip sweep
			}
		}, 60_000)
		this.sweepInterval.unref()
	}

	private stopSweep(): void {
		if (this.sweepInterval) {
			clearInterval(this.sweepInterval)
			this.sweepInterval = null
		}
	}
}

export const outputBuffer = new TerminalOutputBuffer()
