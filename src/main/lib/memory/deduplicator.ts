/**
 * Deduplication for memory entries.
 * Uses normalized content hashing + simple similarity check.
 */

import crypto from "crypto"
import type { MemoryEntry } from "./types"

/** Normalize text for comparison: lowercase, collapse whitespace, strip punctuation */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

/** SHA-256 hash of normalized content */
export function contentHash(entry: MemoryEntry): string {
  const normalized = normalize(entry.body)
  return crypto.createHash("sha256").update(normalized).digest("hex")
}

/**
 * Simple word-overlap similarity (Jaccard index).
 * Returns 0.0–1.0 where 1.0 means identical word sets.
 */
function jaccardSimilarity(a: string, b: string): number {
  const wordsA = new Set(normalize(a).split(" ").filter(Boolean))
  const wordsB = new Set(normalize(b).split(" ").filter(Boolean))
  if (wordsA.size === 0 && wordsB.size === 0) return 1.0
  if (wordsA.size === 0 || wordsB.size === 0) return 0.0

  let intersection = 0
  for (const w of wordsA) {
    if (wordsB.has(w)) intersection++
  }
  const union = wordsA.size + wordsB.size - intersection
  return union === 0 ? 0 : intersection / union
}

const SIMILARITY_THRESHOLD = 0.8

/**
 * Check if a candidate entry is a duplicate of any existing entry.
 * Returns the existing entry it duplicates, or null if novel.
 */
export function findDuplicate(
  candidate: MemoryEntry,
  existing: MemoryEntry[],
): MemoryEntry | null {
  const candidateHash = contentHash(candidate)

  for (const entry of existing) {
    // Exact hash match
    if (contentHash(entry) === candidateHash) return entry

    // Fuzzy match — same category + high word overlap
    if (
      entry.meta.category === candidate.meta.category &&
      jaccardSimilarity(entry.body, candidate.body) >= SIMILARITY_THRESHOLD
    ) {
      return entry
    }
  }

  return null
}
