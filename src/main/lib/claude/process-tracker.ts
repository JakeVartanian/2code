/**
 * Process tree tracker for Claude CLI subprocesses.
 *
 * Problem: When the Claude CLI spawns child processes (e.g., `bun run build`
 * via the Bash tool), aborting the CLI session only kills the CLI process
 * itself. Grandchild processes (like `electron-vite build`) become orphaned
 * and continue consuming CPU/memory indefinitely.
 *
 * Solution: Track the PID of each CLI subprocess and kill the entire process
 * tree (process group) when a session is aborted. Also run a periodic reaper
 * to catch any orphans that slip through.
 */

import { execSync, spawn, type ChildProcess } from "node:child_process"
import { isWindows } from "../platform"

/** Map of subChatId → CLI subprocess PID */
const trackedPids = new Map<string, number>()

/** Register a CLI subprocess PID for a session */
export function trackSessionPid(subChatId: string, pid: number): void {
  trackedPids.set(subChatId, pid)
}

/** Unregister a session's PID (called on normal completion) */
export function untrackSessionPid(subChatId: string): void {
  trackedPids.delete(subChatId)
}

/** Get all tracked PIDs (for debugging) */
export function getTrackedPids(): Map<string, number> {
  return new Map(trackedPids)
}

/**
 * Kill all descendant processes of a given PID.
 * Uses `pgrep -P` recursively to find children before killing,
 * so we kill bottom-up (children first, then parent).
 */
function getDescendantPids(parentPid: number): number[] {
  if (isWindows()) return []

  try {
    const output = execSync(`pgrep -P ${parentPid}`, {
      encoding: "utf-8",
      timeout: 3000,
    }).trim()

    if (!output) return []

    const childPids = output
      .split("\n")
      .map((s) => parseInt(s, 10))
      .filter((n) => !isNaN(n))

    // Recurse to get grandchildren
    const allDescendants: number[] = []
    for (const childPid of childPids) {
      allDescendants.push(...getDescendantPids(childPid))
      allDescendants.push(childPid)
    }
    return allDescendants
  } catch {
    // pgrep returns exit code 1 when no matches found
    return []
  }
}

/**
 * Kill a process and all its descendants.
 * Kills children first (bottom-up) to prevent orphaning.
 */
export function killProcessTree(pid: number): void {
  const descendants = getDescendantPids(pid)

  // Kill children first (bottom-up order from getDescendantPids)
  for (const childPid of descendants) {
    try {
      process.kill(childPid, "SIGTERM")
    } catch {
      // Already dead — fine
    }
  }

  // Kill the parent
  try {
    process.kill(pid, "SIGTERM")
  } catch {
    // Already dead — fine
  }

  // Give processes 2s to exit gracefully, then SIGKILL any survivors
  setTimeout(() => {
    for (const childPid of [...descendants, pid]) {
      try {
        // Check if still alive (signal 0 = existence check)
        process.kill(childPid, 0)
        // Still alive — force kill
        process.kill(childPid, "SIGKILL")
      } catch {
        // Already dead — good
      }
    }
  }, 2000)
}

/**
 * Kill the process tree for a specific session and untrack it.
 * Called when a Claude session is aborted.
 */
export function killSessionProcessTree(subChatId: string): void {
  const pid = trackedPids.get(subChatId)
  if (pid) {
    console.log(`[process-tracker] Killing process tree for session ${subChatId.slice(-8)}, root PID ${pid}`)
    killProcessTree(pid)
    trackedPids.delete(subChatId)
  }
}

/**
 * Kill process trees for all tracked sessions.
 * Called on app quit.
 */
export function killAllSessionProcessTrees(): void {
  for (const [subChatId, pid] of trackedPids) {
    console.log(`[process-tracker] Killing process tree for session ${subChatId.slice(-8)}, root PID ${pid}`)
    killProcessTree(pid)
  }
  trackedPids.clear()
}

// --- Orphan Reaper ---

let reaperInterval: ReturnType<typeof setInterval> | null = null

/**
 * Find orphaned node processes that were spawned by the bundled Claude CLI.
 * An "orphan" is a process whose parent is PID 1 (init/launchd) and whose
 * command line references our bundled binary path or electron-vite.
 */
function findOrphanedProcesses(): number[] {
  if (isWindows()) return []

  try {
    // Find node processes whose parent is 1 (orphaned) and whose command
    // matches electron-vite or esbuild from our project directory.
    // We specifically look for processes with PPID=1 that reference our repo path.
    const output = execSync(
      `ps -eo pid,ppid,command | grep -E "electron-vite|esbuild.*2code" | grep -v grep`,
      { encoding: "utf-8", timeout: 5000 },
    ).trim()

    if (!output) return []

    const orphanPids: number[] = []
    for (const line of output.split("\n")) {
      const parts = line.trim().split(/\s+/)
      const pid = parseInt(parts[0], 10)
      const ppid = parseInt(parts[1], 10)

      if (isNaN(pid) || isNaN(ppid)) continue

      // Only kill if truly orphaned (PPID=1) — means parent died without cleaning up
      if (ppid === 1) {
        orphanPids.push(pid)
      }
    }

    return orphanPids
  } catch {
    return []
  }
}

/**
 * Reap orphaned processes that were spawned by Claude CLI sessions.
 * Returns the number of processes killed.
 */
export function reapOrphanedProcesses(): number {
  const orphans = findOrphanedProcesses()
  if (orphans.length === 0) return 0

  console.log(`[process-tracker] Found ${orphans.length} orphaned process(es): ${orphans.join(", ")}`)

  let killed = 0
  for (const pid of orphans) {
    try {
      process.kill(pid, "SIGTERM")
      killed++
      console.log(`[process-tracker] Killed orphan PID ${pid}`)
    } catch {
      // Already dead
    }
  }

  return killed
}

/**
 * Start the periodic orphan reaper.
 * Runs every 60 seconds to catch any processes that slipped through.
 */
export function startOrphanReaper(): void {
  if (reaperInterval) return

  // Run once immediately
  reapOrphanedProcesses()

  // Then every 60 seconds
  reaperInterval = setInterval(() => {
    reapOrphanedProcesses()
  }, 60_000)
}

/**
 * Stop the periodic orphan reaper.
 */
export function stopOrphanReaper(): void {
  if (reaperInterval) {
    clearInterval(reaperInterval)
    reaperInterval = null
  }
}

// --- Custom Spawn Wrapper ---

/**
 * Create a `spawnClaudeCodeProcess` function that captures the PID
 * for a given session. Pass the returned function as the
 * `spawnClaudeCodeProcess` option in the SDK query() call.
 *
 * The wrapper spawns the CLI process, records its PID in the tracker,
 * and returns an object satisfying the SDK's SpawnedProcess interface.
 */
export function createTrackedSpawn(subChatId: string) {
  return (options: {
    command: string
    args: string[]
    cwd?: string
    env: Record<string, string | undefined>
    signal: AbortSignal
  }) => {
    const child: ChildProcess = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env as NodeJS.ProcessEnv,
      stdio: ["pipe", "pipe", "pipe"],
    })

    // Track the PID for process tree cleanup
    if (child.pid) {
      trackSessionPid(subChatId, child.pid)
      console.log(`[process-tracker] Tracking PID ${child.pid} for session ${subChatId.slice(-8)}`)
    }

    // Clean up tracking when the process exits naturally
    child.on("exit", () => {
      untrackSessionPid(subChatId)
    })

    // Wire up abort signal to kill the process tree (not just the process)
    if (options.signal) {
      const onAbort = () => {
        if (child.pid) {
          killProcessTree(child.pid)
        }
      }
      options.signal.addEventListener("abort", onAbort, { once: true })
    }

    // Return SpawnedProcess-compatible object
    return {
      stdin: child.stdin!,
      stdout: child.stdout!,
      get killed() {
        return child.killed
      },
      get exitCode() {
        return child.exitCode
      },
      kill(signal: NodeJS.Signals) {
        return child.kill(signal)
      },
      on(event: string, listener: (...args: any[]) => void) {
        child.on(event, listener)
      },
      once(event: string, listener: (...args: any[]) => void) {
        child.once(event, listener)
      },
      off(event: string, listener: (...args: any[]) => void) {
        child.off(event, listener)
      },
    }
  }
}
