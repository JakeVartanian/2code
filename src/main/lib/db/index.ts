import Database from "better-sqlite3"
import { drizzle } from "drizzle-orm/better-sqlite3"
import { migrate } from "drizzle-orm/better-sqlite3/migrator"
import { app } from "electron"
import { join } from "path"
import { existsSync, mkdirSync } from "fs"
import { readdir as readdirAsync, rm as rmAsync } from "fs/promises"
import * as schema from "./schema"

let db: ReturnType<typeof drizzle<typeof schema>> | null = null
let sqlite: Database.Database | null = null

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
 * Initialize the database with Drizzle ORM
 */
export function initDatabase() {
  if (db) {
    return db
  }

  const dbPath = getDatabasePath()
  console.log(`[DB] Initializing database at: ${dbPath}`)

  // Create SQLite connection
  sqlite = new Database(dbPath)
  sqlite.pragma("journal_mode = WAL")
  sqlite.pragma("busy_timeout = 5000")
  sqlite.pragma("synchronous = NORMAL")
  sqlite.pragma("foreign_keys = ON")

  // Create Drizzle instance
  db = drizzle(sqlite, { schema })

  // Run migrations
  const migrationsPath = getMigrationsPath()
  console.log(`[DB] Running migrations from: ${migrationsPath}`)

  try {
    migrate(db, { migrationsFolder: migrationsPath })
    console.log("[DB] Migrations completed")
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    // "duplicate column name" means the column already exists — DB is in the correct state
    if (msg.includes("duplicate column name")) {
      console.warn("[DB] Migration warning (column already exists, skipping):", msg)
    } else {
      console.error("[DB] Migration error:", error)
      throw error
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
    console.log("[DB] Database connection closed")
  }
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
    const allSubChatIds = new Set(
      database.select({ id: schema.subChats.id }).from(schema.subChats).all().map((r) => r.id),
    )
    // Also include chatIds since Ollama sessions use chatId
    const allChatIds = new Set(
      database.select({ id: schema.chats.id }).from(schema.chats).all().map((r) => r.id),
    )

    const entries = await readdirAsync(sessionsDir, { withFileTypes: true })
    let removed = 0
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (!allSubChatIds.has(entry.name) && !allChatIds.has(entry.name)) {
        await rmAsync(join(sessionsDir, entry.name), { recursive: true, force: true })
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
