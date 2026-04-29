/**
 * In-memory per-account rate limit tracking.
 * No DB persistence needed — rate limits are ephemeral and naturally clear on app restart.
 */

interface RateLimitEntry {
  rateLimitedAt: number
  resetsAt: number | null
}

const rateLimitedAccounts = new Map<string, RateLimitEntry>()

// Default cooldown: 2 hours (fallback when no reset time is known from SDK events).
// Anthropic rate limits are typically 5-hour or 7-day windows. A short default (e.g. 5 min)
// causes the app to cycle back to the rate-limited account every few minutes, hitting 429s
// repeatedly instead of staying on the account that has capacity.
// 2 hours is long enough to avoid cycling but short enough to recover within a session.
const DEFAULT_COOLDOWN_MS = 2 * 60 * 60 * 1000

export function markAccountRateLimited(accountId: string, resetsAt?: number): void {
  rateLimitedAccounts.set(accountId, {
    rateLimitedAt: Date.now(),
    resetsAt: resetsAt ?? null,
  })
}

export function isAccountRateLimited(accountId: string): boolean {
  const entry = rateLimitedAccounts.get(accountId)
  if (!entry) return false

  // Check if the rate limit has expired
  const expiresAt = entry.resetsAt ?? (entry.rateLimitedAt + DEFAULT_COOLDOWN_MS)
  if (Date.now() >= expiresAt) {
    rateLimitedAccounts.delete(accountId)
    return false
  }

  return true
}

export function clearAccountRateLimit(accountId: string): void {
  rateLimitedAccounts.delete(accountId)
}

export function getRateLimitStatus(): Array<{ accountId: string; rateLimitedAt: number; resetsAt: number | null }> {
  // Clean up expired entries first
  for (const [id, entry] of rateLimitedAccounts) {
    const expiresAt = entry.resetsAt ?? (entry.rateLimitedAt + DEFAULT_COOLDOWN_MS)
    if (Date.now() >= expiresAt) {
      rateLimitedAccounts.delete(id)
    }
  }

  return Array.from(rateLimitedAccounts.entries()).map(([accountId, entry]) => ({
    accountId,
    rateLimitedAt: entry.rateLimitedAt,
    resetsAt: entry.resetsAt,
  }))
}
