/**
 * Ambient git monitor — detects commits, branch switches, and merge conflicts
 * by subscribing to the existing gitWatcherRegistry.
 */

import { EventEmitter } from "events"
import { existsSync, readFileSync } from "fs"
import { join } from "path"
import { gitWatcherRegistry } from "../git/watcher/git-watcher"
import type { GitEvent } from "./types"

export class AmbientGitMonitor extends EventEmitter {
  private projectPath: string
  private unsubscribe: (() => void) | null = null
  private lastHead: string | null = null
  private isDisposed = false
  private mergeConflictEmitted = false // Dedup: only emit once per conflict

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
  }

  dispose(): void {
    if (this.isDisposed) return
    this.isDisposed = true
    this.unsubscribe?.()
    this.unsubscribe = null
    this.removeAllListeners()
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
