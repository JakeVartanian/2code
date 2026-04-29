/**
 * FTS5 full-text search for project memories.
 * Uses SQLite's built-in FTS5 module (available in better-sqlite3)
 * for fast, stemmed text search with BM25 ranking.
 *
 * The FTS index is kept in sync via SQLite triggers — no application-level
 * sync code needed. The `porter` tokenizer enables stemming so "debugging"
 * matches "debug", "deploys" matches "deployment", etc.
 */

import type Database from "better-sqlite3"

export interface FTSResult {
  memoryId: string
  rank: number
  snippet: string
}

/**
 * Initialize FTS5 virtual table, sync triggers, and backfill existing data.
 * Safe to call multiple times — uses IF NOT EXISTS / IF EXISTS guards.
 */
export function initFTS(sqlite: Database.Database): void {
  // Verify FTS5 is available
  const compileOpts = sqlite.pragma("compile_options") as { compile_options: string }[]
  const hasFTS5 = compileOpts.some(r => r.compile_options === "ENABLE_FTS5")
  if (!hasFTS5) {
    console.warn("[FTS5] FTS5 not available in this SQLite build — skipping")
    return
  }

  // Create the FTS5 virtual table
  // project_id and memory_id are UNINDEXED — used for filtering/joining only
  sqlite.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS project_memories_fts USING fts5(
      title, content, category,
      project_id UNINDEXED, memory_id UNINDEXED,
      tokenize='porter unicode61'
    );
  `)

  // Create sync triggers (drop first to ensure they're up to date)
  sqlite.exec(`
    DROP TRIGGER IF EXISTS project_memories_fts_insert;
    CREATE TRIGGER project_memories_fts_insert AFTER INSERT ON project_memories BEGIN
      INSERT INTO project_memories_fts(title, content, category, project_id, memory_id)
      VALUES (NEW.title, NEW.content, NEW.category, NEW.project_id, NEW.id);
    END;

    DROP TRIGGER IF EXISTS project_memories_fts_update;
    CREATE TRIGGER project_memories_fts_update AFTER UPDATE ON project_memories BEGIN
      DELETE FROM project_memories_fts WHERE memory_id = OLD.id;
      INSERT INTO project_memories_fts(title, content, category, project_id, memory_id)
      VALUES (NEW.title, NEW.content, NEW.category, NEW.project_id, NEW.id);
    END;

    DROP TRIGGER IF EXISTS project_memories_fts_delete;
    CREATE TRIGGER project_memories_fts_delete AFTER DELETE ON project_memories BEGIN
      DELETE FROM project_memories_fts WHERE memory_id = OLD.id;
    END;
  `)

  // Backfill: insert any memories not already in the FTS index
  const backfilled = sqlite.prepare(`
    INSERT INTO project_memories_fts(title, content, category, project_id, memory_id)
    SELECT m.title, m.content, m.category, m.project_id, m.id
    FROM project_memories m
    WHERE m.id NOT IN (SELECT memory_id FROM project_memories_fts)
  `).run()

  const count = backfilled.changes
  if (count > 0) {
    console.log(`[FTS5] Initialized, backfilled ${count} memories`)
  } else {
    console.log("[FTS5] Initialized (index up to date)")
  }
}

/**
 * BM25-ranked full-text search across project memories.
 * Returns results sorted by relevance (lower rank = better match).
 */
export function searchMemories(
  sqlite: Database.Database,
  projectId: string,
  query: string,
  limit: number = 10,
): FTSResult[] {
  if (!query.trim()) return []

  // Sanitize query for FTS5: escape double quotes, wrap terms for prefix matching
  const sanitized = sanitizeFTSQuery(query)
  if (!sanitized) return []

  try {
    const stmt = sqlite.prepare(`
      SELECT
        f.memory_id,
        f.rank,
        snippet(project_memories_fts, 1, '»', '«', '...', 32) as snippet
      FROM project_memories_fts f
      JOIN project_memories m ON m.id = f.memory_id
      WHERE project_memories_fts MATCH ?
        AND f.project_id = ?
        AND m.state = 'active'
        AND m.is_archived = 0
      ORDER BY f.rank
      LIMIT ?
    `)

    const rows = stmt.all(sanitized, projectId, limit) as Array<{
      memory_id: string
      rank: number
      snippet: string
    }>

    return rows.map(r => ({
      memoryId: r.memory_id,
      rank: r.rank,
      snippet: r.snippet,
    }))
  } catch (err) {
    // FTS query syntax errors are expected for some user input
    console.warn("[FTS5] Search failed:", (err as Error).message?.slice(0, 100))
    return []
  }
}

/**
 * Find memories similar to a given title + content.
 * Used for deduplication: checks if a memory with similar meaning already exists.
 */
export function findSimilarMemories(
  sqlite: Database.Database,
  projectId: string,
  title: string,
  content: string,
  limit: number = 5,
): FTSResult[] {
  // Build query from title + key phrases from content
  // Take the title and first 200 chars of content for matching
  const queryText = `${title} ${content.slice(0, 200)}`
  return searchMemories(sqlite, projectId, queryText, limit)
}

/**
 * Sanitize user input for FTS5 query syntax.
 * FTS5 has its own query language — bare words are ORed, quoted phrases are exact.
 * We extract meaningful words and OR them together.
 */
function sanitizeFTSQuery(query: string): string {
  // Remove FTS5 operators and special chars
  const cleaned = query
    .replace(/['"{}()\[\]^~*:]/g, " ")
    .replace(/\b(AND|OR|NOT|NEAR)\b/gi, " ")
    .trim()

  // Extract words 3+ chars, skip common stop words
  const STOP_WORDS = new Set([
    "the", "and", "for", "are", "but", "not", "you", "all",
    "can", "has", "her", "was", "one", "our", "out", "this",
    "that", "with", "have", "from", "they", "been", "said",
    "each", "which", "their", "will", "other", "about", "many",
    "then", "them", "these", "some", "would", "make", "like",
    "into", "time", "very", "when", "come", "could", "more",
    "should", "just", "what", "also",
  ])

  const words = cleaned
    .split(/\s+/)
    .filter(w => w.length >= 3 && !STOP_WORDS.has(w.toLowerCase()))
    .slice(0, 15) // Cap to prevent huge queries

  if (words.length === 0) return ""

  // OR the terms together for broad matching
  return words.map(w => `"${w}"`).join(" OR ")
}
