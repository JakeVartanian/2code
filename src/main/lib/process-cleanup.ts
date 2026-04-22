/**
 * Orphan process cleanup.
 *
 * On startup, detects and kills orphaned child processes (Claude CLI, node, PTY)
 * left behind by a previous crash. Works by writing our PID to a file on start,
 * then on next start checking if the old PID is still running. If it's not
 * (meaning we crashed), we scan for child processes that reference our app paths
 * and kill them.
 *
 * Only runs on macOS/Linux — Windows handles child process cleanup differently.
 */

import { app } from "electron"
import { execFile } from "child_process"
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs"
import { join } from "path"

const PID_FILE = "2code.pid"

function getPidFilePath(): string {
  return join(app.getPath("userData"), PID_FILE)
}

/**
 * Write current process PID to disk so the next launch can detect crashes.
 */
export function writePidFile(): void {
  try {
    const dir = app.getPath("userData")
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(getPidFilePath(), String(process.pid), "utf-8")
  } catch (error) {
    console.warn("[ProcessCleanup] Failed to write PID file:", error)
  }
}

/**
 * Check if a process with the given PID is still running.
 */
function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * On startup, check for orphaned processes from a previous crashed session.
 * Runs asynchronously — does not block startup.
 */
export async function cleanupOrphanedProcesses(): Promise<void> {
  if (process.platform === "win32") return

  const pidFilePath = getPidFilePath()

  try {
    if (!existsSync(pidFilePath)) return

    const oldPid = parseInt(readFileSync(pidFilePath, "utf-8").trim(), 10)
    if (isNaN(oldPid)) return

    // If the old process is still running, it's a live instance (not a crash)
    if (isProcessRunning(oldPid)) return

    console.log(`[ProcessCleanup] Previous instance (PID ${oldPid}) not running — checking for orphans`)

    // Find claude processes that are orphaned (parent PID = 1, meaning reparented to launchd)
    // and whose command line contains our app's paths
    const appIdentifiers = [
      "2Code.app",         // Production app
      "2Code Dev",         // Dev mode
      "resources/bin/claude", // Bundled CLI
      "electron-vite",     // Build processes spawned by Claude CLI Bash tool
      "esbuild.*2code",    // esbuild service processes
    ]

    const killed = await findAndKillOrphans(appIdentifiers)
    if (killed > 0) {
      console.log(`[ProcessCleanup] Killed ${killed} orphaned process(es)`)
    }
  } catch (error) {
    console.warn("[ProcessCleanup] Cleanup failed (non-critical):", error)
  }
}

/**
 * Find processes matching our app identifiers that have been reparented to PID 1
 * (orphaned) and kill them.
 */
function findAndKillOrphans(identifiers: string[]): Promise<number> {
  return new Promise((resolve) => {
    // ps -eo pid,ppid,command — lists all processes with PID, parent PID, and full command
    execFile("ps", ["-eo", "pid,ppid,command"], { timeout: 5000 }, (error, stdout) => {
      if (error) {
        console.warn("[ProcessCleanup] ps failed:", error)
        resolve(0)
        return
      }

      let killed = 0
      const lines = stdout.split("\n")

      for (const line of lines) {
        const trimmed = line.trim()
        // Parse: PID PPID COMMAND...
        const match = trimmed.match(/^(\d+)\s+(\d+)\s+(.+)$/)
        if (!match) continue

        const pid = parseInt(match[1], 10)
        const ppid = parseInt(match[2], 10)
        const command = match[3]

        // Skip our own process
        if (pid === process.pid) continue

        // Only target orphaned processes (parent = 1 = launchd/init)
        if (ppid !== 1) continue

        // Check if command matches any of our identifiers
        const isOurProcess = identifiers.some((id) => command.includes(id))
        if (!isOurProcess) continue

        // Skip macOS system processes that might match broadly
        if (command.includes("/System/") || command.includes("/usr/libexec/")) continue

        try {
          console.log(`[ProcessCleanup] Killing orphaned process PID ${pid}: ${command.slice(0, 120)}`)
          process.kill(pid, "SIGTERM")
          killed++

          // Follow up with SIGKILL after 2s in case SIGTERM is ignored
          setTimeout(() => {
            try {
              if (isProcessRunning(pid)) {
                process.kill(pid, "SIGKILL")
                console.log(`[ProcessCleanup] Force-killed PID ${pid}`)
              }
            } catch {
              // Already dead
            }
          }, 2000)
        } catch {
          // Process may have already exited
        }
      }

      resolve(killed)
    })
  })
}
