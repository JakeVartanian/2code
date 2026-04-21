/**
 * Ambient file watcher — monitors working tree for content changes.
 * Uses chokidar with 30s debounce, batches up to 8 files, flushes on security-sensitive changes.
 */

import { EventEmitter } from "events"
import type { FSWatcher } from "chokidar"
import type { FileBatch, FileChangeEvent } from "./types"

const DEBOUNCE_MS = 30_000 // 30 seconds
const MAX_BATCH_SIZE = 8
const MAX_FILE_SIZE = 50 * 1024 // 50KB — skip larger files (likely generated)

// Files that trigger immediate flush (security-sensitive)
const URGENT_PATTERNS = [
  /\.env/,
  /secrets?\./i,
  /credentials?\./i,
  /auth\//i,
  /\.pem$/,
  /\.key$/,
]

// Always ignore these (same base set as git-watcher + ambient-specific additions)
const IGNORE_PATTERNS = [
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
  "**/out/**",
  "**/.next/**",
  "**/.cache/**",
  "**/*.log",
  "**/*.map",
  "**/target/**",
  "**/__pycache__/**",
  "**/vendor/**",
  "**/.gradle/**",
  "**/Pods/**",
  "**/.idea/**",
  "**/.vscode/**",
  "**/*.swp",
  "**/*.swo",
  "**/*~",
  "**/.git/**",
  "**/coverage/**",
  "**/*.lock",
  "**/package-lock.json",
  "**/bun.lockb",
  "**/yarn.lock",
  "**/*.min.js",
  "**/*.min.css",
  "**/*.d.ts",
]

// Binary/asset extensions to skip
const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".ico", ".svg", ".webp",
  ".woff", ".woff2", ".ttf", ".eot",
  ".mp3", ".mp4", ".mov", ".avi",
  ".zip", ".tar", ".gz", ".rar",
  ".pdf", ".doc", ".docx",
  ".sqlite", ".db",
])

export class AmbientFileWatcher extends EventEmitter {
  private watcher: FSWatcher | null = null
  private pendingFiles: Map<string, FileChangeEvent> = new Map()
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private isDisposed = false
  private projectPath: string
  private projectId: string
  private initPromise: Promise<void>
  private extraIgnorePatterns: string[]

  constructor(config: {
    projectPath: string
    projectId: string
    ignorePatterns?: string[]
  }) {
    super()
    this.projectPath = config.projectPath
    this.projectId = config.projectId
    this.extraIgnorePatterns = config.ignorePatterns ?? []
    this.initPromise = this.initWatcher()
  }

  async waitForReady(): Promise<void> {
    await this.initPromise
  }

  dispose(): void {
    if (this.isDisposed) return
    this.isDisposed = true
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.watcher?.close()
    this.watcher = null
    this.pendingFiles.clear()
    this.removeAllListeners()
  }

  private async initWatcher(): Promise<void> {
    const chokidar = await import("chokidar")
    const path = await import("path")

    const ignored = [...IGNORE_PATTERNS, ...this.extraIgnorePatterns]

    this.watcher = chokidar.watch(this.projectPath, {
      persistent: true,
      ignoreInitial: true,
      ignored,
      awaitWriteFinish: {
        stabilityThreshold: 200,
        pollInterval: 100,
      },
      usePolling: false,
      followSymlinks: false,
      depth: 6, // Limit depth to reduce file descriptor usage
    })

    this.watcher.on("add", (filePath) => this.handleEvent(filePath, "add", path))
    this.watcher.on("change", (filePath) => this.handleEvent(filePath, "change", path))
    this.watcher.on("unlink", (filePath) => this.handleEvent(filePath, "unlink", path))
    this.watcher.on("error", (error) => {
      // EMFILE = too many open files. Close watcher to free fds and stop gracefully.
      if ((error as NodeJS.ErrnoException).code === "EMFILE") {
        console.error("[AmbientFileWatcher] EMFILE — too many open files, disposing watcher")
        this.dispose()
        return
      }
      console.error("[AmbientFileWatcher] Watcher error:", error)
    })

    // Wait for initial scan to complete
    await new Promise<void>((resolve) => {
      this.watcher!.on("ready", resolve)
    })
  }

  private handleEvent(filePath: string, type: "add" | "change" | "unlink", path: typeof import("path")): void {
    if (this.isDisposed) return

    const ext = path.extname(filePath).toLowerCase()

    // Skip binary files
    if (BINARY_EXTENSIONS.has(ext)) return

    const relativePath = path.relative(this.projectPath, filePath)

    const event: FileChangeEvent = {
      path: relativePath,
      type,
      ext,
    }

    this.pendingFiles.set(relativePath, event)

    // Flush immediately if security-sensitive file
    if (URGENT_PATTERNS.some(p => p.test(relativePath))) {
      this.flush()
      return
    }

    // Flush if batch is full
    if (this.pendingFiles.size >= MAX_BATCH_SIZE) {
      this.flush()
      return
    }

    // Otherwise reset debounce timer
    this.scheduleFlush()
  }

  private scheduleFlush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = setTimeout(() => this.flush(), DEBOUNCE_MS)
  }

  private flush(): void {
    if (this.isDisposed || this.pendingFiles.size === 0) return

    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }

    const files = Array.from(this.pendingFiles.values())
    this.pendingFiles.clear()

    const batch: FileBatch = {
      files,
      timestamp: Date.now(),
      projectId: this.projectId,
      projectPath: this.projectPath,
    }

    this.emit("batch", batch)
  }
}
