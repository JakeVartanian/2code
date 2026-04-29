/**
 * Ambient git monitor — detects commits, branch switches, and merge conflicts
 * by subscribing to the existing gitWatcherRegistry.
 */

import { EventEmitter } from "events"
import { exec } from "child_process"
import { promisify } from "util"
import { existsSync, readFileSync } from "fs"
import { join } from "path"
import { gitWatcherRegistry } from "../git/watcher/git-watcher"
import type { GitEvent, FileBatch, FileChangeEvent } from "./types"

const execAsync = promisify(exec)

const DIFF_POLL_INTERVAL = 20_000 // Check for changed files every 20s

export class AmbientGitMonitor extends EventEmitter {
  private projectPath: string
  private unsubscribe: (() => void) | null = null
  private lastHead: string | null = null
  private isDisposed = false
  private mergeConflictEmitted = false // Dedup: only emit once per conflict
  private diffPollTimer: ReturnType<typeof setInterval> | null = null
  private initialPollTimer: ReturnType<typeof setTimeout> | null = null
  private lastDiffFingerprint = "" // Track diff content to detect real changes

  constructor(projectPath: string) {
    super()
    this.projectPath = projectPath
    this.lastHead = this.readHead()
  }

  async start(): Promise<void> {
    if (this.isDisposed) return

    // Subscribe to the existing git watcher for this project
    const unsub = await gitWatcherRegistry.subscribe(
      this.projectPath,
      () => this.checkGitState(),
    )

    // If disposed during await, immediately unsubscribe to prevent leak
    if (this.isDisposed) {
      unsub()
    } else {
      this.unsubscribe = unsub
    }

    // Periodic lightweight diff poll — replaces chokidar file watcher.
    // Uses `git diff` and `git ls-files --others` (instant, zero fd overhead)
    // to detect working-tree changes for the ambient pipeline.
    this.diffPollTimer = setInterval(() => {
      if (this.isDisposed) return
      this.emitChangedFiles().catch(() => {})
    }, DIFF_POLL_INTERVAL)

    // Run once on start after a short delay
    this.initialPollTimer = setTimeout(() => {
      if (!this.isDisposed) this.emitChangedFiles().catch(() => {})
    }, 5000)
  }

  dispose(): void {
    if (this.isDisposed) return
    this.isDisposed = true
    this.unsubscribe?.()
    this.unsubscribe = null
    if (this.diffPollTimer) clearInterval(this.diffPollTimer)
    this.diffPollTimer = null
    if (this.initialPollTimer) clearTimeout(this.initialPollTimer)
    this.initialPollTimer = null
    this.removeAllListeners()
  }

  /**
   * Use `git diff` to detect modified files and emit as a file-batch event.
   * This replaces the chokidar file watcher — zero fd overhead, instant.
   */
  private async emitChangedFiles(): Promise<void> {
    try {
      // Get modified tracked files + untracked files + stat fingerprint in one shot
      const [diffStatResult, untrackedResult] = await Promise.all([
        execAsync("git diff --stat", { cwd: this.projectPath, timeout: 5000 }).catch(() => ({ stdout: "" })),
        execAsync("git ls-files --others --exclude-standard", { cwd: this.projectPath, timeout: 5000 }).catch(() => ({ stdout: "" })),
      ])

      // Use diff stat as fingerprint — changes when file content changes, not just file names
      const fingerprint = diffStatResult.stdout + "|" + untrackedResult.stdout
      if (fingerprint === this.lastDiffFingerprint) return // Nothing actually changed
      this.lastDiffFingerprint = fingerprint

      // Now get file names for the batch
      const { stdout: diffNames } = await execAsync(
        "git diff --name-only", { cwd: this.projectPath, timeout: 5000 },
      ).catch(() => ({ stdout: "" }))

      const files = [
        ...diffNames.trim().split("\n").filter(Boolean),
        ...untrackedResult.stdout.trim().split("\n").filter(Boolean),
      ]

      if (files.length === 0) return

      // Build file-batch event (limit to 8 files per batch)
      const path = await import("path")
      const batch: FileBatch = {
        files: files.slice(0, 8).map((filePath): FileChangeEvent => ({
          path: filePath,
          type: "change",
          ext: path.extname(filePath).toLowerCase(),
        })),
        timestamp: Date.now(),
        projectId: "", // Set by the agent when processing
        projectPath: this.projectPath,
      }

      this.emit("file-batch", batch)
    } catch { /* non-critical */ }
  }

  private checkGitState(): void {
    if (this.isDisposed) return

    const currentHead = this.readHead()
    if (!currentHead) return

    // HEAD changed
    if (this.lastHead && currentHead !== this.lastHead) {
      // Determine if this is a commit or a branch switch
      const currentBranch = this.readCurrentBranch()
      const previousBranch = this.lastHead

      if (this.isBranchRef(currentHead) !== this.isBranchRef(this.lastHead)) {
        // Branch switch (HEAD went from one ref to another)
        const event: GitEvent = {
          type: "branch-switch",
          ref: currentBranch ?? currentHead,
          previousRef: this.lastHead,
          timestamp: Date.now(),
        }
        this.emit("git-event", event)
      } else {
        // Same branch, new commit
        const event: GitEvent = {
          type: "commit",
          ref: currentHead,
          previousRef: this.lastHead,
          timestamp: Date.now(),
        }
        this.emit("git-event", event)
      }
    }

    // Check for merge conflict (deduplicated — only emit once per conflict)
    const mergeHeadPath = join(this.projectPath, ".git", "MERGE_HEAD")
    if (existsSync(mergeHeadPath)) {
      if (!this.mergeConflictEmitted) {
        this.mergeConflictEmitted = true
        const event: GitEvent = {
          type: "merge-conflict",
          timestamp: Date.now(),
        }
        this.emit("git-event", event)
      }
    } else {
      this.mergeConflictEmitted = false // Reset when conflict is resolved
    }

    this.lastHead = currentHead
  }

  private readHead(): string | null {
    try {
      const headPath = join(this.projectPath, ".git", "HEAD")
      if (!existsSync(headPath)) return null
      return readFileSync(headPath, "utf-8").trim()
    } catch {
      return null
    }
  }

  private readCurrentBranch(): string | null {
    const head = this.readHead()
    if (!head) return null
    if (head.startsWith("ref: refs/heads/")) {
      return head.replace("ref: refs/heads/", "")
    }
    return null // detached HEAD
  }

  private isBranchRef(head: string): boolean {
    return head.startsWith("ref: ")
  }
}
