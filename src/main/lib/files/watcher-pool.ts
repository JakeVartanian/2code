import { watch, type FSWatcher } from "node:fs"
import { getFdPressure, hasFdHeadroom, onFdPressureChange, type FdPressureLevel } from "../fd-pressure"

// macOS GUI apps default to 256 file descriptors. Electron itself, Claude
// subprocesses, DB, network sockets, and chokidar git watchers all compete
// for the same budget. Keep this low to leave headroom.
const BASE_MAX_WATCHERS = 32

interface WatchEntry {
  watcher: FSWatcher
  callbacks: Set<(eventType: string) => void>
  lastAccess: number // For LRU eviction under pressure
}

const pool = new Map<string, WatchEntry>()

/**
 * Get the effective watcher cap based on FD pressure.
 */
function getEffectiveMaxWatchers(): number {
  const pressure = getFdPressure()
  switch (pressure) {
    case "normal": return BASE_MAX_WATCHERS
    case "warning": return Math.floor(BASE_MAX_WATCHERS * 0.5) // 16
    case "critical": return 4 // Bare minimum
  }
}

/**
 * Close the least-recently-used watcher entries to make room.
 * Called when FD pressure increases.
 */
export function evictLruWatchers(targetSize: number): number {
  if (pool.size <= targetSize) return 0

  // Sort by last access time (oldest first)
  const entries = [...pool.entries()].sort(
    (a, b) => a[1].lastAccess - b[1].lastAccess,
  )

  let evicted = 0
  for (const [path, entry] of entries) {
    if (pool.size <= targetSize) break
    // Don't evict entries with active callbacks — they're in use
    if (entry.callbacks.size > 0) continue
    try { entry.watcher.close() } catch {}
    pool.delete(path)
    evicted++
  }

  if (evicted > 0) {
    console.log(`[watcher-pool] Evicted ${evicted} LRU watchers (pool: ${pool.size}/${targetSize})`)
  }
  return evicted
}

// Register for FD pressure changes — auto-shed watchers when pressure rises
let pressureCleanup: (() => void) | null = null

function initPressureListener(): void {
  if (pressureCleanup) return
  pressureCleanup = onFdPressureChange((level: FdPressureLevel) => {
    if (level === "critical") {
      // Emergency: close all watchers with no active callbacks
      evictLruWatchers(4)
    } else if (level === "warning") {
      evictLruWatchers(getEffectiveMaxWatchers())
    }
  })
}

// Initialize lazily on first watchFile call
let initialized = false

/**
 * Watch a file path with reference counting. Multiple subscribers to the same
 * path share a single fs.watch() handle. When all subscribers unsubscribe the
 * handle is closed.
 *
 * FD-pressure-aware: reduces watcher cap and evicts LRU watchers under pressure.
 *
 * Returns an unsubscribe function.
 */
export function watchFile(
  fullPath: string,
  callback: (eventType: string) => void,
): () => void {
  if (!initialized) {
    initialized = true
    initPressureListener()
  }

  const existing = pool.get(fullPath)
  if (existing) {
    existing.callbacks.add(callback)
    existing.lastAccess = Date.now()
    return () => {
      existing.callbacks.delete(callback)
      if (existing.callbacks.size === 0) {
        existing.watcher.close()
        pool.delete(fullPath)
      }
    }
  }

  // Enforce dynamic cap based on FD pressure
  const maxWatchers = getEffectiveMaxWatchers()
  if (pool.size >= maxWatchers) {
    // Try evicting unused watchers first
    if (evictLruWatchers(maxWatchers - 1) === 0) {
      console.warn(
        `[watcher-pool] At ${maxWatchers} watcher limit (pressure: ${getFdPressure()}) — skipping watch for ${fullPath}`,
      )
      return () => {} // no-op cleanup
    }
  }

  // Check FD headroom before opening a new watcher
  if (!hasFdHeadroom(2)) {
    console.warn(`[watcher-pool] No FD headroom — skipping watch for ${fullPath}`)
    return () => {}
  }

  let watcher: FSWatcher
  try {
    watcher = watch(fullPath, (eventType) => {
      const entry = pool.get(fullPath)
      if (entry) {
        entry.lastAccess = Date.now()
        for (const cb of entry.callbacks) {
          cb(eventType)
        }
      }
    })
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === "EMFILE" || code === "ENFILE") {
      console.error(
        `[watcher-pool] EMFILE/ENFILE: too many open files — cannot watch ${fullPath}`,
      )
      // Emergency eviction: try to free FDs for other consumers
      evictLruWatchers(Math.floor(pool.size * 0.5))
    }
    // File may not exist yet, or FD limit hit — return no-op cleanup
    return () => {}
  }

  // Handle errors on the watcher itself (e.g. EMFILE during rename)
  watcher.on("error", (err: Error) => {
    const code = (err as NodeJS.ErrnoException & { code?: string }).code
    if (code === "EMFILE" || code === "ENFILE") {
      console.error(`[watcher-pool] EMFILE on watcher for ${fullPath} — closing`)
      // Emergency eviction
      evictLruWatchers(Math.floor(pool.size * 0.5))
    } else {
      console.error(`[watcher-pool] Watcher error for ${fullPath}:`, err.message)
    }
    // Clean up the broken watcher
    pool.delete(fullPath)
    try {
      watcher.close()
    } catch {}
  })

  const entry: WatchEntry = { watcher, callbacks: new Set([callback]), lastAccess: Date.now() }
  pool.set(fullPath, entry)

  return () => {
    entry.callbacks.delete(callback)
    if (entry.callbacks.size === 0) {
      watcher.close()
      pool.delete(fullPath)
    }
  }
}

/**
 * Get the current pool size (for debugging).
 */
export function getWatcherPoolSize(): number {
  return pool.size
}
