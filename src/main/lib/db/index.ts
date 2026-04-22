import Database from "better-sqlite3"
import { drizzle } from "drizzle-orm/better-sqlite3"
import { migrate } from "drizzle-orm/better-sqlite3/migrator"
import { inArray } from "drizzle-orm"
import { app } from "electron"
import { join } from "path"
import { existsSync, mkdirSync, readFileSync, readdirSync } from "fs"
import { readdir as readdirAsync, rm as rmAsync } from "fs/promises"
import crypto from "crypto"
import * as schema from "./schema"

let db: ReturnType<typeof drizzle<typeof schema>> | null = null
let sqlite: Database.Database | null = null
// Prevents infinite retry loops — once init fails, stop trying
let dbInitFailed: Error | null = null
// Track if closeDatabase() was called (vs never opened)
let dbExplicitlyClosed = false

/**
 * Get the database path in the app's user data directory
 */
function getDatabasePath(): string {
  const userDataPath = app.getPath("userData")
  const dataDir = join(userDataPath, "data")

  // Ensure data directory exists
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true })
  }

  return join(dataDir, "agents.db")
}

/**
 * Get the migrations folder path
 * Handles both development and production (packaged) environments
 */
function getMigrationsPath(): string {
  if (app.isPackaged) {
    // Production: migrations bundled in resources
    return join(process.resourcesPath, "migrations")
  }
  // Development: from out/main -> apps/desktop/drizzle
  return join(__dirname, "../../drizzle")
}

/**
 * When migrations fail due to schema already existing (e.g. from db:push),
 * read the journal, find unapplied migrations, and mark them as applied
 * so Drizzle doesn't retry them on every startup.
 */
function applyMigrationsIndividually(
  database: ReturnType<typeof drizzle<typeof schema>>,
  migrationsPath: string,
) {
  if (!sqlite) return

  try {
    const journalPath = join(migrationsPath, "meta", "_journal.json")
    const journal = JSON.parse(readFileSync(journalPath, "utf-8"))

    // Get already-applied hashes
    const applied = new Set(
      sqlite.prepare("SELECT hash FROM __drizzle_migrations").all()
        .map((r: any) => r.hash),
    )

    for (const entry of journal.entries) {
      const sqlPath = join(migrationsPath, `${entry.tag}.sql`)
      if (!existsSync(sqlPath)) continue

      const sql = readFileSync(sqlPath, "utf-8")
      const hash = crypto.createHash("sha256").update(sql).digest("hex")

      if (applied.has(hash)) continue

      // Try to run the migration — if it fails on duplicate column, just record it
      const statements = sql.split("--> statement-breakpoint")
      let allOk = true
      for (const stmt of statements) {
        const trimmed = stmt.trim()
        if (!trimmed || trimmed.startsWith("--")) continue
        try {
          sqlite.exec(trimmed)
        } catch (e: any) {
          if (e.message?.includes("duplicate column name") || e.message?.includes("already exists")) {
            // Schema already matches — safe to skip
          } else {
            console.error(`[DB] Migration ${entry.tag} statement failed:`, e.message)
            allOk = false
            break
          }
        }
      }

      if (allOk) {
        sqlite.prepare(
          "INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)",
        ).run(hash, entry.when)
        console.log(`[DB] Recorded migration ${entry.tag} as applied`)
      }
    }
  } catch (e) {
    console.error("[DB] Failed to sync migration journal:", e)
  }
}

/**
 * Initialize the database with Drizzle ORM
 */
export function initDatabase() {
  if (db) {
    return db
  }

  // Don't retry if a previous attempt already failed
  if (dbInitFailed) {
    throw dbInitFailed
  }

  const dbPath = getDatabasePath()
  console.log(`[DB] Initializing database at: ${dbPath}`)

  try {
    // Create SQLite connection
    sqlite = new Database(dbPath)
    console.log("[DB] SQLite connection opened")

    sqlite.pragma("journal_mode = WAL")
    // Increased from 5000ms to 15000ms to handle concurrent writes from multiple sessions
    // With 3-5 concurrent Claude sessions, database lock contention is common
    sqlite.pragma("busy_timeout = 15000")
    sqlite.pragma("synchronous = NORMAL")
    sqlite.pragma("foreign_keys = ON")

    // Create Drizzle instance
    db = drizzle(sqlite, { schema })
    console.log("[DB] Drizzle ORM initialized")
  } catch (error) {
    // Close any partial connection to avoid leaking handles
    if (sqlite) {
      try { sqlite.close() } catch {}
      sqlite = null
    }
    db = null
    dbInitFailed = error instanceof Error ? error : new Error(String(error))
    console.error("[DB] Failed to open database:", dbInitFailed.message)
    throw dbInitFailed
  }

  // Run migrations
  const migrationsPath = getMigrationsPath()
  console.log(`[DB] Running migrations from: ${migrationsPath}`)

  try {
    migrate(db, { migrationsFolder: migrationsPath })
    console.log("[DB] Migrations completed")
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    const causeMsg = (error as any)?.cause?.message ?? ""
    const fullMsg = `${msg} ${causeMsg}`
    // "duplicate column name" / "already exists" means the schema was applied out-of-band
    // (e.g. db:push). The DB is in the correct state — apply remaining migrations one at a
    // time so the journal catches up and this doesn't repeat on every startup.
    if (fullMsg.includes("duplicate column name") || fullMsg.includes("already exists")) {
      console.warn("[DB] Column already exists, syncing migration journal...")
      applyMigrationsIndividually(db, migrationsPath)
    } else {
      console.error("[DB] Migration error:", error)
      // DB connection is still valid even if a migration fails —
      // don't throw, just log. The app can operate with whatever state the DB is in.
    }
  }

  return db
}

/**
 * Get the database instance
 */
export function getDatabase() {
  if (!db) {
    return initDatabase()
  }
  return db
}

/**
 * Close the database connection
 */
export function closeDatabase(): void {
  if (sqlite) {
    sqlite.close()
    sqlite = null
    db = null
    dbExplicitlyClosed = true
    console.log("[DB] Database connection closed")
  }
}

/**
 * Check if the database connection has been explicitly closed.
 * Used by shutdown handlers to avoid writing after close.
 */
export function isDatabaseClosed(): boolean {
  return dbExplicitlyClosed
}

/**
 * Clean up orphaned claude-sessions directories that no longer have a matching sub-chat in the DB.
 * Runs async in the background — does not block startup.
 */
export async function cleanupOrphanedSessionDirs(): Promise<void> {
  try {
    const sessionsDir = join(app.getPath("userData"), "claude-sessions")
    if (!existsSync(sessionsDir)) return

    const database = getDatabase()

    const entries = await readdirAsync(sessionsDir, { withFileTypes: true })
    const dirNames = entries.filter((e) => e.isDirectory()).map((e) => e.name)
    if (dirNames.length === 0) return

    // Only query IDs that actually exist on disk, in batches of 200
    const validIds = new Set<string>()
    const BATCH = 200
    for (let i = 0; i < dirNames.length; i += BATCH) {
      const batch = dirNames.slice(i, i + BATCH)
      const subChatHits = database.select({ id: schema.subChats.id }).from(schema.subChats).where(inArray(schema.subChats.id, batch)).all()
      const chatHits = database.select({ id: schema.chats.id }).from(schema.chats).where(inArray(schema.chats.id, batch)).all()
      for (const r of subChatHits) validIds.add(r.id)
      for (const r of chatHits) validIds.add(r.id)
    }

    let removed = 0
    for (const name of dirNames) {
      if (!validIds.has(name)) {
        await rmAsync(join(sessionsDir, name), { recursive: true, force: true })
        removed++
      }
    }
    if (removed > 0) {
      console.log(`[DB] Cleaned up ${removed} orphaned claude-session directories`)
    }
  } catch (error) {
    console.error("[DB] Error cleaning up orphaned sessions:", error)
  }
}

// Re-export schema for convenience
export * from "./schema"
