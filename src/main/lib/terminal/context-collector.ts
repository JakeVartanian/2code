/**
 * Terminal Context Collector
 *
 * Gathers terminal state (running dev servers + recent output) and formats it
 * as markdown for injection into Claude's system prompt. All reads on the
 * message-send hot path are in-memory lookups (<3ms total).
 *
 * External server detection runs on a background timer to avoid blocking.
 */

import { portManager } from "./port-manager"
import { outputBuffer } from "./output-buffer"
import type { DetectedPort } from "./types"
import { detectRunningServers, type DetectedServer } from "../trpc/routers/dev-server"

// ── Types ──────────────────────────────────────────────────────────

interface TerminalContext {
	servers: DetectedServer[]
	internalPorts: DetectedPort[]
	terminalOutputs: TerminalSnapshot[]
}

interface TerminalSnapshot {
	paneId: string
	lines: string[]
	lastDataAt: number
	hasErrors: boolean
}

// ── Error detection ────────────────────────────────────────────────

const ERROR_PATTERNS = /\b(error|Error:|ERR!|EADDRINUSE|ENOENT|FATAL|panic|Traceback|failed|FAIL|Cannot find|Segmentation fault|Uncaught|Unhandled|SyntaxError|TypeError|ReferenceError|ModuleNotFoundError)\b/

function hasErrorPatterns(lines: string[]): boolean {
	for (const line of lines) {
		if (ERROR_PATTERNS.test(line)) return true
	}
	return false
}

// ── Relevance keywords for smart injection ─────────────────────────

const RELEVANCE_KEYWORDS = /\b(server|terminal|port|localhost|running|start|dev|error|build|run|crash|fail|log|output|console|restart|stop|kill)\b/i

// ── Background external server scanner ─────────────────────────────

const SCAN_INTERVAL_MS = 10_000
const externalServerCache = new Map<string, { servers: DetectedServer[]; timestamp: number }>()
const activeProjects = new Map<string, number>() // projectPath -> refcount
let scanInterval: ReturnType<typeof setInterval> | null = null

function startBackgroundScanner(): void {
	if (scanInterval) return

	scanInterval = setInterval(async () => {
		for (const projectPath of activeProjects.keys()) {
			try {
				const servers = await detectRunningServers(projectPath)
				externalServerCache.set(projectPath, { servers, timestamp: Date.now() })
			} catch (err) {
				console.error(`[TerminalContext] Background scan failed for ${projectPath}:`, err)
			}
		}
	}, SCAN_INTERVAL_MS)
	scanInterval.unref()

	// Run an immediate scan for new projects
	for (const projectPath of activeProjects.keys()) {
		detectRunningServers(projectPath)
			.then((servers) => {
				externalServerCache.set(projectPath, { servers, timestamp: Date.now() })
			})
			.catch(() => { /* non-critical */ })
	}
}

function stopBackgroundScanner(): void {
	if (scanInterval) {
		clearInterval(scanInterval)
		scanInterval = null
	}
}

/**
 * Register a project for background server scanning.
 * Called when a chat session starts sending messages.
 */
export function registerProjectForScanning(projectPath: string): void {
	const count = activeProjects.get(projectPath) || 0
	activeProjects.set(projectPath, count + 1)

	if (activeProjects.size === 1) {
		startBackgroundScanner()
	}
}

/**
 * Unregister a project from background scanning.
 * Called when a chat session ends.
 */
export function unregisterProjectFromScanning(projectPath: string): void {
	const count = activeProjects.get(projectPath) || 0
	if (count <= 1) {
		activeProjects.delete(projectPath)
		externalServerCache.delete(projectPath)
	} else {
		activeProjects.set(projectPath, count - 1)
	}

	if (activeProjects.size === 0) {
		stopBackgroundScanner()
	}
}

// ── Main API ───────────────────────────────────────────────────────

/**
 * Gather all terminal context for a chat session.
 * All reads are in-memory — no blocking I/O on the hot path.
 */
export function gatherTerminalContext(
	projectPath: string,
	_cwd: string,
	chatId: string,
): TerminalContext {
	// 1. Ports from 2Code's own terminals (in-memory Map filter)
	const internalPorts = portManager.getPortsByWorkspace(chatId)

	// 2. Recent terminal output (in-memory ring buffer read)
	const rawOutputs = outputBuffer.getRecentLinesByWorkspace(chatId, 50)
	const terminalOutputs: TerminalSnapshot[] = []

	for (const [paneId, { lines, lastDataAt }] of rawOutputs) {
		terminalOutputs.push({
			paneId,
			lines,
			lastDataAt,
			hasErrors: hasErrorPatterns(lines),
		})
	}

	// Sort: panes with errors first, then by recency
	terminalOutputs.sort((a, b) => {
		if (a.hasErrors !== b.hasErrors) return a.hasErrors ? -1 : 1
		return b.lastDataAt - a.lastDataAt
	})

	// Cap at 4 most relevant panes
	if (terminalOutputs.length > 4) {
		terminalOutputs.length = 4
	}

	// 3. External servers from background cache (instant Map lookup)
	const cached = externalServerCache.get(projectPath)
	const externalServers = cached?.servers || []

	// Merge: deduplicate by port (prefer external DetectedServer which has framework info)
	const serversByPort = new Map<number, DetectedServer>()
	for (const server of externalServers) {
		serversByPort.set(server.port, server)
	}
	// Add internal ports that weren't already found externally
	for (const port of internalPorts) {
		if (!serversByPort.has(port.port)) {
			serversByPort.set(port.port, {
				port: port.port,
				url: `http://localhost:${port.port}`,
				framework: null,
				status: "running" as const,
			})
		}
	}

	return {
		servers: Array.from(serversByPort.values()),
		internalPorts,
		terminalOutputs,
	}
}

/**
 * Determine whether terminal context should be injected into this message.
 */
export function shouldInjectTerminalContext(
	ctx: TerminalContext,
	userPrompt: string,
	isFirstMessage: boolean,
): boolean {
	// Always inject if servers are running
	if (ctx.servers.length > 0) return true

	// Always inject if terminal output has errors
	if (ctx.terminalOutputs.some((t) => t.hasErrors)) return true

	// Always inject on first message (establish awareness)
	if (isFirstMessage) return true

	// Inject if user mentions relevant keywords
	if (RELEVANCE_KEYWORDS.test(userPrompt)) return true

	// Skip injection for irrelevant messages
	return false
}

// ── Token budget ───────────────────────────────────────────────────

const MAX_CONTEXT_CHARS = 6000 // ~1,500 tokens

/**
 * Format terminal context as markdown for system prompt injection.
 * Hard-capped at ~1,500 tokens to prevent system prompt bloat.
 */
export function formatTerminalContextMarkdown(ctx: TerminalContext): string {
	if (ctx.servers.length === 0 && ctx.terminalOutputs.length === 0) {
		return ""
	}

	let md = "# Terminal Awareness\n"

	// ── Running servers section ──
	if (ctx.servers.length > 0) {
		md += "\n## Running Dev Servers\n"
		for (const server of ctx.servers) {
			const framework = server.framework ? ` — ${server.framework}` : ""
			md += `- **${server.url}**${framework} (running)\n`
		}
	}

	// ── Terminal output section ──
	if (ctx.terminalOutputs.length > 0) {
		md += "\n## Terminal Output (recent)\n"

		for (let i = 0; i < ctx.terminalOutputs.length; i++) {
			const snapshot = ctx.terminalOutputs[i]
			const age = Date.now() - snapshot.lastDataAt
			const isIdle = age > 60_000
			const label = snapshot.hasErrors ? "has errors" : isIdle ? "idle" : "active"

			md += `\n### Terminal ${i + 1} (${label})\n`

			if (isIdle && !snapshot.hasErrors) {
				md += "No recent output.\n"
			} else {
				md += "```\n"
				md += snapshot.lines.join("\n")
				md += "\n```\n"
			}

			// Bail early if we're approaching the budget
			if (md.length > MAX_CONTEXT_CHARS - 200) {
				if (i < ctx.terminalOutputs.length - 1) {
					md += `\n_(${ctx.terminalOutputs.length - i - 1} more terminal(s) omitted for brevity)_\n`
				}
				break
			}
		}
	} else if (ctx.servers.length > 0) {
		md += "\n_No terminal output available (servers detected via port scan)._\n"
	}

	// ── Instruction block ──
	if (ctx.servers.length > 0 || ctx.terminalOutputs.some((t) => t.hasErrors)) {
		md += "\n> **IMPORTANT:** "
		if (ctx.servers.length > 0) {
			md += "Dev servers listed above are already running. Do NOT start another unless the user explicitly asks. "
		}
		if (ctx.terminalOutputs.some((t) => t.hasErrors)) {
			md += "If the user reports an error, check the terminal output above first."
		}
		md += "\n"
	}

	// Enforce hard cap
	if (md.length > MAX_CONTEXT_CHARS) {
		md = md.slice(0, MAX_CONTEXT_CHARS - 50) + "\n\n_(terminal context truncated)_\n"
	}

	return md
}
