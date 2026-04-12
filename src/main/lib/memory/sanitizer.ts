/**
 * Strip sensitive content (API keys, tokens, passwords) from memory entries
 */

/** Patterns that match common secret formats */
const SECRET_PATTERNS: RegExp[] = [
  // API keys with common prefixes
  /\b(sk-[a-zA-Z0-9_-]{20,})\b/g,
  /\b(sk-ant-[a-zA-Z0-9_-]{20,})\b/g,
  /\b(pk-[a-zA-Z0-9_-]{20,})\b/g,
  /\b(ghp_[a-zA-Z0-9]{36,})\b/g,
  /\b(gho_[a-zA-Z0-9]{36,})\b/g,
  /\b(github_pat_[a-zA-Z0-9_]{22,})\b/g,
  /\b(xoxb-[a-zA-Z0-9-]+)\b/g,
  /\b(xoxp-[a-zA-Z0-9-]+)\b/g,
  /\b(AKIA[0-9A-Z]{16})\b/g,
  /\b(glpat-[a-zA-Z0-9_-]{20,})\b/g,

  // Generic long hex/base64 tokens (40+ chars, likely secrets)
  /\b([a-f0-9]{40,})\b/gi,

  // Bearer tokens
  /Bearer\s+[a-zA-Z0-9._\-/+=]{20,}/g,

  // Connection strings with embedded passwords
  /(?:mongodb|postgres|mysql|redis):\/\/[^@\s]+@[^\s]+/g,

  // Key=value patterns for known env vars
  /(?:API_KEY|SECRET_KEY|ACCESS_TOKEN|PRIVATE_KEY|PASSWORD|DB_PASSWORD|AUTH_TOKEN|REFRESH_TOKEN)\s*[=:]\s*\S+/gi,
]

const REDACTION = "[REDACTED]"

/**
 * Remove sensitive values from text content.
 * Returns sanitized text.
 */
export function sanitize(text: string): string {
  let result = text
  for (const pattern of SECRET_PATTERNS) {
    // Reset lastIndex for global regexes
    pattern.lastIndex = 0
    result = result.replace(pattern, REDACTION)
  }
  return result
}
