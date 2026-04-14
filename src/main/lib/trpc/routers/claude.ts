import { observable } from "@trpc/server/observable"
import { eq } from "drizzle-orm"
import { app, BrowserWindow, powerMonitor } from "electron"
import { existsSync } from "fs"
import * as fs from "fs/promises"
import * as os from "os"
import path from "path"
import { z } from "zod"
import {
  buildClaudeEnv,
  checkOfflineFallback,
  ChunkBatcher,
  createTransformer,
  getBundledClaudeBinaryPath,
  logClaudeEnv,
  logRawClaudeMessage,
  type BatchedUIMessageChunk,
  type UIMessageChunk,
} from "../../claude"
import {
  getMergedGlobalMcpServers,
  getMergedLocalProjectMcpServers,
  GLOBAL_MCP_PATH,
  readClaudeConfig,
  readClaudeDirConfig,
  readProjectMcpJson,
  removeMcpServerConfig,
  resolveProjectPathFromWorktree,
  updateMcpServerConfig,
  writeClaudeConfig,
  type ClaudeConfig,
  type McpServerConfig,
} from "../../claude-config"
import { anthropicAccounts, anthropicSettings, chats, claudeCodeCredentials, getDatabase, projects as projectsTable, subChats } from "../../db"
import { scheduleDebouncedWrite, flushPendingWrite, flushAllPendingWrites } from "../../db/debounced-writer"
import { createRollbackStash } from "../../git/stash"
import {
  ensureMcpTokensFresh,
  fetchMcpTools,
  fetchMcpToolsStdio,
  getMcpAuthStatus,
  startMcpOAuth,
  type McpToolInfo,
} from "../../mcp-auth"
import { fetchOAuthMetadata, getMcpBaseUrl } from "../../oauth"
import { discoverPluginMcpServers } from "../../plugins"
import { publicProcedure, router } from "../index"
import { buildAgentsOption } from "./agent-utils"
import {
  getApprovedPluginMcpServers,
  getEnabledPlugins,
} from "./claude-settings"
import { getExistingClaudeCredentials, refreshClaudeToken, isTokenExpired } from "../../claude-token"
import { markAccountRateLimited, isAccountRateLimited } from "../../claude/rate-limit-tracker"

/**
 * Parse @[agent:name], @[skill:name], and @[tool:servername] mentions from prompt text
 * Returns the cleaned prompt and lists of mentioned agents/skills/MCP servers
 *
 * File mention formats:
 * - @[file:local:relative/path] - file inside project (relative path)
 * - @[file:external:/absolute/path] - file outside project (absolute path)
 * - @[file:owner/repo:path] - legacy web format (repo:path)
 * - @[folder:local:path] or @[folder:external:path] - folder mentions
 */
function findBrowserExecutable(): string | undefined {
  const platform = process.platform
  const candidates: Record<string, string[]> = {
    darwin: [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    ],
    win32: [
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
      "C:\\Program Files (x86)\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
    ],
    linux: [
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/brave-browser",
      "/usr/bin/chromium-browser",
      "/usr/bin/chromium",
    ],
  }
  for (const p of candidates[platform] ?? []) {
    if (existsSync(p)) return p
  }
  return undefined
}

function parseMentions(prompt: string): {
  cleanedPrompt: string
  agentMentions: string[]
  skillMentions: string[]
  fileMentions: string[]
  folderMentions: string[]
  toolMentions: string[]
} {
  const agentMentions: string[] = []
  const skillMentions: string[] = []
  const fileMentions: string[] = []
  const folderMentions: string[] = []
  const toolMentions: string[] = []

  // Match @[prefix:name] pattern
  const mentionRegex = /@\[(file|folder|skill|agent|tool):([^\]]+)\]/g
  let match

  while ((match = mentionRegex.exec(prompt)) !== null) {
    const [, type, name] = match
    switch (type) {
      case "agent":
        agentMentions.push(name)
        break
      case "skill":
        skillMentions.push(name)
        break
      case "file":
        fileMentions.push(name)
        break
      case "folder":
        folderMentions.push(name)
        break
      case "tool":
        // Validate: server name (alphanumeric, underscore, hyphen) or full tool id (mcp__server__tool)
        if (
          /^[a-zA-Z0-9_-]+$/.test(name) ||
          /^mcp__[a-zA-Z0-9_-]+__[a-zA-Z0-9_-]+$/.test(name)
        ) {
          toolMentions.push(name)
        }
        break
    }
  }

  // Clean agent/skill/tool mentions from prompt (they will be added as context or hints)
  // Keep file/folder mentions as they are useful context
  let cleanedPrompt = prompt
    .replace(/@\[agent:[^\]]+\]/g, "")
    .replace(/@\[skill:[^\]]+\]/g, "")
    .replace(/@\[tool:[^\]]+\]/g, "")
    .trim()

  // Transform file mentions to readable paths for the agent
  // @[file:local:path] -> path (relative to project)
  // @[file:external:/abs/path] -> /abs/path (absolute)
  cleanedPrompt = cleanedPrompt
    .replace(/@\[file:local:([^\]]+)\]/g, "$1")
    .replace(/@\[file:external:([^\]]+)\]/g, "$1")
    .replace(/@\[folder:local:([^\]]+)\]/g, "$1")
    .replace(/@\[folder:external:([^\]]+)\]/g, "$1")

  // Add usage hints for mentioned MCP servers or individual tools
  // Names are already validated to contain only safe characters
  if (toolMentions.length > 0) {
    const toolHints = toolMentions
      .map((t) => {
        if (t.startsWith("mcp__")) {
          // Individual tool mention (from MCP widget): "Use the mcp__server__tool tool"
          return `Use the ${t} tool for this request.`
        }
        // Server mention (from @ dropdown): "Use tools from the X MCP server"
        return `Use tools from the ${t} MCP server for this request.`
      })
      .join(" ")
    cleanedPrompt = `${toolHints}\n\n${cleanedPrompt}`
  }

  return {
    cleanedPrompt,
    agentMentions,
    skillMentions,
    fileMentions,
    folderMentions,
    toolMentions,
  }
}

/**
 * Encode token as base64 for DB storage.
 * No safeStorage — it ties encryption to the app's code signature,
 * so every unsigned rebuild produces a different key and old tokens
 * become permanently undecryptable.
 */
function encryptToken(token: string): string {
  return Buffer.from(token).toString("base64")
}

function decryptToken(encrypted: string): string {
  try {
    return Buffer.from(encrypted, "base64").toString("utf-8")
  } catch (error) {
    console.error("[decryptToken] Failed to decode:", error)
    return ""
  }
}

/**
 * Validate that a decoded token looks like a real Claude OAuth access token.
 * Tokens stored with the old safeStorage.encryptString() scheme decode as garbage
 * UTF-8 (binary ciphertext re-interpreted as text) which is truthy but unusable.
 * Checking the well-known prefix guards against silently using garbage credentials.
 */
function isValidOAuthToken(token: string): boolean {
  return token.startsWith("sk-ant-")
}

/**
 * Track which account ID is currently being used for the active session.
 * Used to mark the correct account as rate-limited when we detect 429 errors.
 */
let currentAccountId: string | null = null

/**
 * Get the account ID currently in use (for marking as rate-limited on 429)
 */
export function getCurrentAccountId(): string | null {
  return currentAccountId
}

/**
 * Select an available (non-rate-limited) account for the next Claude request.
 * Priority order:
 * 1. Pinned account (forceAccountOverride=true) - even if rate-limited
 * 2. Manually selected account (activeAccountId) - if not rate-limited
 * 3. Fair rotation through all accounts ordered by lastUsedAt
 * Returns account ID or null if all accounts are rate-limited.
 */
function selectAvailableAccount(): string | null {
  try {
    const db = getDatabase()

    // Get settings and accounts in one place
    const settings = db
      .select()
      .from(anthropicSettings)
      .where(eq(anthropicSettings.id, "singleton"))
      .get()

    // Priority 1: Check if user has forced an account override (pin feature)
    if (settings?.forceAccountOverride && settings.activeAccountId) {
      const account = db
        .select()
        .from(anthropicAccounts)
        .where(eq(anthropicAccounts.id, settings.activeAccountId))
        .get()

      if (account) {
        // Honor forced account (even if rate-limited)
        console.log(`[claude-auth-rotation] Using pinned account ${account.id} (${account.displayName || account.email})`)
        return settings.activeAccountId
      } else {
        // Forced account was deleted - disable override and fall through
        console.warn("[claude-auth-rotation] Pinned account deleted, disabling override")
        db.update(anthropicSettings)
          .set({ forceAccountOverride: false })
          .where(eq(anthropicSettings.id, "singleton"))
          .run()
      }
    }

    // Priority 2: Check if user has manually selected an account (not pinned)
    if (settings?.activeAccountId && !settings.forceAccountOverride) {
      const activeAccount = db
        .select()
        .from(anthropicAccounts)
        .where(eq(anthropicAccounts.id, settings.activeAccountId))
        .get()

      if (activeAccount) {
        // Use manually selected account if not rate-limited
        if (!isAccountRateLimited(activeAccount.id)) {
          console.log(`[claude-auth-rotation] Using manually selected account ${activeAccount.id} (${activeAccount.displayName || activeAccount.email})`)

          // Update lastUsedAt
          db.update(anthropicAccounts)
            .set({ lastUsedAt: new Date() })
            .where(eq(anthropicAccounts.id, activeAccount.id))
            .run()

          return activeAccount.id
        } else {
          console.warn(`[claude-auth-rotation] Manually selected account ${activeAccount.id} is rate-limited, falling back to rotation`)
        }
      } else {
        // Selected account was deleted - clear activeAccountId
        console.warn("[claude-auth-rotation] Manually selected account deleted, clearing selection")
        db.update(anthropicSettings)
          .set({ activeAccountId: null })
          .where(eq(anthropicSettings.id, "singleton"))
          .run()
      }
    }

    // Priority 3: Fair rotation logic (oldest lastUsedAt first)
    const accounts = db
      .select()
      .from(anthropicAccounts)
      .orderBy(anthropicAccounts.lastUsedAt)
      .all()

    if (accounts.length === 0) {
      console.log("[claude-auth-rotation] No accounts found")
      return null
    }

    // Find first non-rate-limited account
    for (const account of accounts) {
      if (!isAccountRateLimited(account.id)) {
        // Update lastUsedAt to track rotation
        db.update(anthropicAccounts)
          .set({ lastUsedAt: new Date() })
          .where(eq(anthropicAccounts.id, account.id))
          .run()

        console.log(`[claude-auth-rotation] Selected account via rotation ${account.id} (${account.displayName || account.email || "unnamed"})`)
        return account.id
      }
    }

    // All accounts are rate-limited
    console.warn("[claude-auth-rotation] All accounts are rate-limited")
    return null
  } catch (error) {
    console.error("[claude-auth-rotation] Error selecting account:", error)
    return null
  }
}

/**
 * Get Claude Code OAuth token from local SQLite
 * Uses multi-account system with automatic rotation (skips rate-limited accounts)
 * Falls back to legacy table if no multi-account setup exists
 * Returns null if not connected or all accounts are rate-limited
 */
function getClaudeCodeToken(): string | null {
  try {
    const db = getDatabase()

    // Select an available (non-rate-limited) account
    const selectedAccountId = selectAvailableAccount()

    if (selectedAccountId) {
      const account = db
        .select()
        .from(anthropicAccounts)
        .where(eq(anthropicAccounts.id, selectedAccountId))
        .get()

      if (account?.oauthToken) {
        const token = decryptToken(account.oauthToken)
        if (isValidOAuthToken(token)) {
          currentAccountId = selectedAccountId
          console.log(`[claude-auth] token=oauth accountId=${selectedAccountId}`)
          return token
        }
        // Token invalid: either undecryptable (different unsigned build) or
        // was encoded with old safeStorage (garbage UTF-8 after base64 decode).
        console.warn(`[claude-auth] token=oauth accountId=${selectedAccountId} INVALID — skipping`)
      }
    }

    // Fallback to legacy table
    const cred = db
      .select()
      .from(claudeCodeCredentials)
      .where(eq(claudeCodeCredentials.id, "default"))
      .get()

    if (!cred?.oauthToken) {
      console.log("[claude-auth] no credentials found")
      return null
    }

    const legacyToken = decryptToken(cred.oauthToken)
    if (!isValidOAuthToken(legacyToken)) {
      console.warn("[claude-auth] token=oauth(legacy) INVALID (undecryptable or safeStorage garbage) — returning null")
      return null
    }
    console.log("[claude-auth] token=oauth(legacy)")
    return legacyToken
  } catch (error) {
    console.error("[claude-auth] Error getting Claude Code token:", error)
    return null
  }
}

/**
 * Get the currently active Anthropic account ID from DB settings.
 */
function getCurrentActiveAccountId(): string | null {
  // Return the account ID currently in use (set by selectAvailableAccount)
  // This may differ from anthropicSettings.activeAccountId due to rotation
  return currentAccountId
}


/**
 * In-memory cache for refreshed tokens to avoid refreshing on every message.
 * TTL: 45 minutes (Claude OAuth tokens typically expire after ~1 hour).
 */
let tokenRefreshCache: { token: string; refreshedAt: number } | null = null
const TOKEN_REFRESH_TTL_MS = 45 * 60 * 1000 // 45 minutes

// FIX: Invalidate Claude OAuth token cache after OS sleep/wake.
// After 8+ hours of sleep, the cached token is likely expired. Without this,
// the user's first message after wake would use a stale cached token and fail
// with an unhelpful auth error.
powerMonitor.on("resume", () => {
  if (tokenRefreshCache) {
    console.log("[claude-auth] OS resume detected — invalidating token cache")
    tokenRefreshCache = null
  }
})

/**
 * Update the stored access token (and optionally refresh token) in the DB
 * after a successful token refresh.
 */
function updateStoredAccessToken(newAccessToken: string, newRefreshToken?: string, expiresAt?: Date): void {
  try {
    const db = getDatabase()
    const encrypted = encryptToken(newAccessToken)
    const encryptedRefresh = newRefreshToken ? encryptToken(newRefreshToken) : undefined

    // Update the currently selected account (may differ from activeAccountId due to rotation)
    if (currentAccountId) {
      const updateData: Record<string, unknown> = { oauthToken: encrypted }
      if (encryptedRefresh) {
        updateData.refreshToken = encryptedRefresh
      }
      if (expiresAt) {
        updateData.tokenExpiresAt = expiresAt
      }
      db.update(anthropicAccounts)
        .set(updateData)
        .where(eq(anthropicAccounts.id, currentAccountId))
        .run()
    }

    // Also update legacy table
    const legacyCred = db
      .select()
      .from(claudeCodeCredentials)
      .where(eq(claudeCodeCredentials.id, "default"))
      .get()
    if (legacyCred) {
      db.update(claudeCodeCredentials)
        .set({ oauthToken: encrypted })
        .where(eq(claudeCodeCredentials.id, "default"))
        .run()
    }

    // No decryption cache to clear (safeStorage removed)
    console.log("[claude-auth] Stored tokens updated after refresh")
  } catch (error) {
    console.error("[claude-auth] Failed to update stored tokens:", error)
  }
}

/**
 * Get a fresh Claude Code OAuth token, auto-refreshing if expired.
 * Uses in-memory cache with 45-min TTL to avoid refreshing on every message.
 * Falls back to stored token if refresh fails.
 *
 * Concurrent callers share a single in-flight refresh promise to avoid
 * double-refresh races that can invalidate single-use refresh tokens.
 */
let _refreshInFlight: Promise<string | null> | null = null

export async function getClaudeCodeTokenFresh(): Promise<string | null> {
  // Check in-memory cache first
  if (tokenRefreshCache && Date.now() - tokenRefreshCache.refreshedAt < TOKEN_REFRESH_TTL_MS) {
    return tokenRefreshCache.token
  }

  // Get the stored token and its expiry from the DB (no keychain prompt)
  const storedToken = getClaudeCodeToken()
  const dbTokenExpiry = getStoredTokenExpiry()
  const appRefreshTokenExists = !!getStoredRefreshToken()
  // When tokenExpiresAt is null (CLI auth, markAsAuthenticated, or initial OAuth
  // without expiry), treat the token as NOT expired. Defaulting to expired was
  // causing every session to fall through to the keychain/refresh path, triggering
  // repeated macOS keychain password prompts and auth-error modals.
  const dbTokenExpired = dbTokenExpiry !== null ? isTokenExpired(dbTokenExpiry) : false

  console.log(`[claude-auth-fresh] storedToken=${storedToken ? `${storedToken.slice(0, 8)}...` : "null"} dbTokenExpiry=${dbTokenExpiry} dbTokenExpired=${dbTokenExpired} hasRefreshToken=${appRefreshTokenExists}`)

  // If the DB token is fresh, use it immediately without touching the keychain.
  // This avoids the macOS keychain password prompt on every new build.
  if (storedToken && !dbTokenExpired) {
    tokenRefreshCache = { token: storedToken, refreshedAt: Date.now() }
    return storedToken
  }

  // DB token is absent or expired — now check app refresh token before keychain
  const appRefreshToken = getStoredRefreshToken()
  console.log(`[claude-auth-fresh] appRefreshToken=${appRefreshToken ? "present" : "null"} storedToken=${storedToken ? "present" : "null"}`)

  if (appRefreshToken) {
    if (_refreshInFlight) return _refreshInFlight

    _refreshInFlight = (async () => {
      try {
        console.log("[claude-auth-fresh] Attempting token refresh via app refresh token...")
        const refreshed = await refreshClaudeToken(appRefreshToken)
        console.log(`[claude-auth-fresh] Token refreshed successfully, new token=${refreshed.accessToken.slice(0, 8)}... expiresIn=${refreshed.expiresAt ? Math.round((refreshed.expiresAt - Date.now()) / 1000) + "s" : "none"}`)
        const expiresAt = refreshed.expiresAt ? new Date(refreshed.expiresAt) : undefined
        updateStoredAccessToken(refreshed.accessToken, refreshed.refreshToken, expiresAt)
        tokenRefreshCache = { token: refreshed.accessToken, refreshedAt: Date.now() }
        return refreshed.accessToken
      } catch (e) {
        console.error("[claude-auth-fresh] Token refresh FAILED:", e instanceof Error ? e.message : e)
        tokenRefreshCache = null
        // Fall through to keychain below
        return null
      } finally {
        _refreshInFlight = null
      }
    })()

    const refreshed = await _refreshInFlight
    if (refreshed) return refreshed
  }

  // Last resort: read from system keychain (triggers macOS password prompt if not granted)
  const keychainCreds = getExistingClaudeCredentials()
  const keychainExpired = keychainCreds ? isTokenExpired(keychainCreds.expiresAt) : true

  if (keychainCreds?.accessToken && !keychainExpired) {
    tokenRefreshCache = { token: keychainCreds.accessToken, refreshedAt: Date.now() }
    return keychainCreds.accessToken
  }

  // Try refreshing with keychain refresh token
  const keychainRefreshToken = keychainCreds?.refreshToken
  if (keychainRefreshToken) {
    if (_refreshInFlight) return _refreshInFlight

    _refreshInFlight = (async () => {
      try {
        const refreshed = await refreshClaudeToken(keychainRefreshToken)
        console.log("[claude-auth] Token refreshed via keychain refresh token")
        const expiresAt = refreshed.expiresAt ? new Date(refreshed.expiresAt) : undefined
        updateStoredAccessToken(refreshed.accessToken, refreshed.refreshToken, expiresAt)
        tokenRefreshCache = { token: refreshed.accessToken, refreshedAt: Date.now() }
        return refreshed.accessToken
      } catch (e) {
        console.log("[claude-auth] Keychain token refresh failed, using stored token:", e)
        tokenRefreshCache = null
        return storedToken ?? keychainCreds?.accessToken ?? null
      } finally {
        _refreshInFlight = null
      }
    })()

    return _refreshInFlight
  }

  // Fall back to whatever we have
  const fallback = storedToken ?? keychainCreds?.accessToken ?? null
  const fallbackExpiry = storedToken ? dbTokenExpiry : keychainCreds?.expiresAt
  if (fallback && !isTokenExpired(fallbackExpiry ?? undefined)) {
    tokenRefreshCache = { token: fallback, refreshedAt: Date.now() }
  } else if (fallback) {
    // FIX: Log a clear warning when returning an expired token with no way to refresh.
    // This helps diagnose auth failures instead of silently sending a stale token
    // that results in a confusing "Run 'claude login'" error.
    console.warn(
      `[claude-auth-fresh] WARNING: Returning expired token (no refresh token available). ` +
      `Token expired at ${fallbackExpiry ? new Date(fallbackExpiry).toISOString() : "unknown"}. ` +
      `User will likely see an auth error.`
    )
  }
  return fallback
}

// Dynamic import for ESM module - CACHED to avoid re-importing on every message
let cachedClaudeQuery:
  | typeof import("@anthropic-ai/claude-agent-sdk").query
  | null = null
const getClaudeQuery = async () => {
  if (cachedClaudeQuery) {
    return cachedClaudeQuery
  }
  const sdk = await import("@anthropic-ai/claude-agent-sdk")
  cachedClaudeQuery = sdk.query
  return cachedClaudeQuery
}

// Active sessions for cancellation (onAbort handles stash + abort + restore)
// Active sessions for cancellation (with window tracking to prevent cross-window interference)
const activeSessions = new Map<
  string,
  { abortController: AbortController; windowId: number | null }
>()

// Track session completion promises for graceful shutdown
const sessionCompletionPromises = new Map<string, Promise<void>>()

/** Register a session completion promise for graceful shutdown tracking */
export function registerSessionCompletion(subChatId: string, promise: Promise<void>): void {
  sessionCompletionPromises.set(subChatId, promise)
  promise.finally(() => sessionCompletionPromises.delete(subChatId))
}

/** Maximum number of concurrent Claude agent sessions */
const MAX_CONCURRENT_AGENTS = 5

/** Maximum messages to keep per sub-chat (prevents memory bloat with long conversations) */
const MAX_MESSAGES_PER_CHAT = 500

/**
 * Prune message history to prevent unbounded growth
 * Keeps only the latest MAX_MESSAGES_PER_CHAT messages
 */
function pruneMessageHistory(messages: any[], subChatId: string): any[] {
  if (messages.length <= MAX_MESSAGES_PER_CHAT) {
    return messages
  }
  const pruneCount = messages.length - MAX_MESSAGES_PER_CHAT
  console.log(
    `[claude] Pruning ${pruneCount} old messages from sub-chat ${subChatId} (${messages.length} -> ${MAX_MESSAGES_PER_CHAT})`,
  )
  return messages.slice(-MAX_MESSAGES_PER_CHAT)
}

/** Check if there are any active Claude streaming sessions */
export function hasActiveClaudeSessions(): boolean {
  return activeSessions.size > 0
}

/**
 * Abort all active Claude sessions and wait for their cleanup to complete
 * @param windowId Optional - if provided, only abort sessions from this window
 */
export async function abortAllClaudeSessions(windowId?: number): Promise<void> {
  // Capture completion promises BEFORE aborting (abort triggers the catch blocks)
  const pendingCompletions: Promise<void>[] = []

  for (const [subChatId, session] of activeSessions) {
    // If windowId filter is provided, only abort sessions from that window
    if (windowId !== undefined && session.windowId !== windowId) {
      continue
    }

    console.log(
      `[claude] Aborting session ${subChatId} from window ${session.windowId || "unknown"}`,
    )
    session.abortController.abort()

    // Capture the completion promise for this session
    const promise = sessionCompletionPromises.get(subChatId)
    if (promise) {
      pendingCompletions.push(promise)
    }

    activeSessions.delete(subChatId)
  }

  // Wait for all session async functions to finish their catch/finally blocks
  // This ensures flushPendingWrite() calls from abort handlers complete
  if (pendingCompletions.length > 0) {
    console.log(
      `[claude] Waiting for ${pendingCompletions.length} session(s) to finish cleanup...`,
    )
    const cleanupStart = Date.now()
    const results = await Promise.allSettled(pendingCompletions)

    const cleanupDuration = Date.now() - cleanupStart
    const failedCount = results.filter((r) => r.status === "rejected").length

    if (failedCount > 0) {
      console.warn(
        `[claude] ${failedCount} session(s) failed during cleanup (took ${cleanupDuration}ms)`,
      )
    } else if (cleanupDuration > 5000) {
      console.warn(
        `[claude] All sessions cleaned up but took unusually long (${cleanupDuration}ms) - possible subprocess leak`,
      )
    } else {
      console.log(`[claude] All sessions cleaned up (${cleanupDuration}ms)`)
    }
  }

  // Flush any remaining debounced writes
  flushAllPendingWrites()
}

// In-memory cache of working MCP server names (resets on app restart)
// Key: "scope::serverName" where scope is "__global__" or projectPath
// Value: true if working (has tools), false if failed
export const workingMcpServers = new Map<string, boolean>()

// Helper to build scoped cache key
const GLOBAL_SCOPE = "__global__"
function mcpCacheKey(scope: string | null, serverName: string): string {
  return `${scope ?? GLOBAL_SCOPE}::${serverName}`
}

// Cache for symlinks (track which subChatIds have already set up symlinks)
const symlinksCreated = new Set<string>()

// Cache for MCP config (avoid re-reading ~/.claude.json on every message)
const mcpConfigCache = new Map<
  string,
  {
    config: Record<string, any> | undefined
    mtime: number
  }
>()

// Cache for .mcp.json files (avoid re-reading on every message)
const projectMcpJsonCache = new Map<
  string,
  {
    servers: Record<string, McpServerConfig>
    mtime: number
  }
>()

// Cache for AGENTS.md (avoid re-reading on every message)
const agentsMdCache = new Map<
  string,
  {
    content: string
    mtime: number
  }
>()

/** Evict oldest entries from a Map when it exceeds maxSize */
function trimMap<K, V>(map: Map<K, V>, maxSize: number): void {
  if (map.size <= maxSize) return
  const toDelete = map.size - maxSize
  let i = 0
  for (const key of map.keys()) {
    if (i++ >= toDelete) break
    map.delete(key)
  }
}

// TTL cache for the fully merged MCP server config (avoid re-running all merge logic on every message)
// Keys by project path. Invalidated after 30s or on explicit refresh.
const MCP_MERGE_TTL_MS = 30_000
const mergedMcpCache = new Map<
  string,
  {
    allServers: Record<string, McpServerConfig>
    projectServers: Record<string, McpServerConfig>
    timestamp: number
  }
>()

/**
 * Read .mcp.json with mtime-based caching
 */
async function readProjectMcpJsonCached(
  projectPath: string
): Promise<Record<string, McpServerConfig>> {
  try {
    const mcpJsonPath = path.join(projectPath, ".mcp.json")
    const stats = await fs.stat(mcpJsonPath).catch(() => null)
    if (!stats) return {}

    const cached = projectMcpJsonCache.get(mcpJsonPath)
    if (cached && cached.mtime === stats.mtimeMs) {
      return cached.servers
    }

    const servers = await readProjectMcpJson(projectPath)
    projectMcpJsonCache.set(mcpJsonPath, {
      servers,
      mtime: stats.mtimeMs,
    })
    trimMap(projectMcpJsonCache, 50)
    return servers
  } catch {
    return {}
  }
}

/**
 * Read AGENTS.md with mtime-based caching
 * Prevents re-reading and re-injecting on every message
 */
async function readAgentsMdCached(cwd: string): Promise<string> {
  try {
    const agentsMdPath = path.join(cwd, "AGENTS.md")
    const stats = await fs.stat(agentsMdPath).catch(() => null)
    if (!stats) return ""

    const cached = agentsMdCache.get(agentsMdPath)
    if (cached && cached.mtime === stats.mtimeMs) {
      return cached.content
    }

    const content = await fs.readFile(agentsMdPath, "utf-8")
    if (!content.trim()) return ""

    agentsMdCache.set(agentsMdPath, {
      content,
      mtime: stats.mtimeMs,
    })
    trimMap(agentsMdCache, 50)
    return content
  } catch {
    return ""
  }
}

const pendingToolApprovals = new Map<
  string,
  {
    subChatId: string
    resolve: (decision: {
      approved: boolean
      message?: string
      updatedInput?: unknown
    }) => void
  }
>()

const PLAN_MODE_BLOCKED_TOOLS = new Set(["Bash", "NotebookEdit"])

const clearPendingApprovals = (message: string, subChatId?: string) => {
  for (const [toolUseId, pending] of pendingToolApprovals) {
    if (subChatId && pending.subChatId !== subChatId) continue
    pending.resolve({ approved: false, message })
    pendingToolApprovals.delete(toolUseId)
  }
}

// Image attachment schema
const imageAttachmentSchema = z.object({
  base64Data: z.string(),
  mediaType: z.string(), // e.g. "image/png", "image/jpeg"
  filename: z.string().optional(),
})

export type ImageAttachment = z.infer<typeof imageAttachmentSchema>

/**
 * Clear all performance caches (for testing/debugging)
 */
export function clearClaudeCaches() {
  cachedClaudeQuery = null
  symlinksCreated.clear()
  mcpConfigCache.clear()
  projectMcpJsonCache.clear()
  agentsMdCache.clear()
  mergedMcpCache.clear()
  tokenRefreshCache = null
  console.log("[claude] All caches cleared")
}

/**
 * Determine server status based on config
 * - If authType is "none" -> "connected" (no auth required)
 * - If has Authorization header -> "connected" (OAuth completed, SDK can use it)
 * - If has _oauth but no headers -> "needs-auth" (legacy config, needs re-auth to migrate)
 * - If HTTP server (has URL) with explicit authType -> "needs-auth"
 * - HTTP server without authType -> "connected" (assume public)
 * - Local stdio server -> "connected"
 */
function getServerStatusFromConfig(serverConfig: McpServerConfig): string {
  const headers = serverConfig.headers as Record<string, string> | undefined
  const { _oauth: oauth, authType } = serverConfig

  // If authType is explicitly "none", no auth required
  if (authType === "none") {
    return "connected"
  }

  // If has Authorization header, it's ready for SDK to use
  if (headers?.Authorization) {
    return "connected"
  }

  // If has _oauth but no headers, this is a legacy config that needs re-auth
  // (old format that SDK can't use)
  if (oauth?.accessToken && !headers?.Authorization) {
    return "needs-auth"
  }

  // If HTTP server with explicit authType (oauth/bearer), needs auth
  if (serverConfig.url && ["oauth", "bearer"].includes(authType ?? "")) {
    return "needs-auth"
  }

  // HTTP server without authType - assume no auth required (public endpoint)
  // Local stdio server - also connected
  return "connected"
}

const MCP_FETCH_TIMEOUT_MS = 40_000

/**
 * Fetch tools from an MCP server (HTTP or stdio transport)
 * Times out after MCP_FETCH_TIMEOUT_MS seconds to prevent slow MCPs from blocking the cache update
 */
async function fetchToolsForServer(
  serverConfig: McpServerConfig,
): Promise<McpToolInfo[]> {
  const timeoutPromise = new Promise<McpToolInfo[]>((_, reject) =>
    setTimeout(() => reject(new Error("Timeout")), MCP_FETCH_TIMEOUT_MS),
  )

  const fetchPromise = (async () => {
    // HTTP transport
    if (serverConfig.url) {
      const headers = serverConfig.headers as Record<string, string> | undefined
      try {
        return await fetchMcpTools(serverConfig.url, headers)
      } catch {
        return []
      }
    }

    // Stdio transport
    const command = (serverConfig as any).command as string | undefined
    if (command) {
      try {
        return await fetchMcpToolsStdio({
          command,
          args: (serverConfig as any).args,
          env: (serverConfig as any).env,
        })
      } catch {
        return []
      }
    }

    return []
  })()

  try {
    return await Promise.race([fetchPromise, timeoutPromise])
  } catch {
    return []
  }
}

/**
 * Handler for getAllMcpConfig - exported so it can be called on app startup
 */
export async function getAllMcpConfigHandler() {
  try {
    const totalStart = Date.now()

    // Clear cache before repopulating
    workingMcpServers.clear()

    const config = await readClaudeConfig()

    const convertServers = async (
      servers: Record<string, McpServerConfig> | undefined,
      scope: string | null,
    ) => {
      if (!servers) return []

      const results = await Promise.all(
        Object.entries(servers).map(async ([name, serverConfig]) => {
          const configObj = serverConfig as Record<string, unknown>
          let status = getServerStatusFromConfig(serverConfig)
          const headers = serverConfig.headers as
            | Record<string, string>
            | undefined

          let tools: McpToolInfo[] = []
          let needsAuth = false

          try {
            tools = await fetchToolsForServer(serverConfig)
          } catch (error) {
            console.error(`[MCP] Failed to fetch tools for ${name}:`, error)
          }

          const cacheKey = mcpCacheKey(scope, name)
          if (tools.length > 0) {
            status = "connected"
            workingMcpServers.set(cacheKey, true)
          } else {
            workingMcpServers.set(cacheKey, false)
            if (serverConfig.url) {
              try {
                const baseUrl = getMcpBaseUrl(serverConfig.url)
                const metadata = await fetchOAuthMetadata(baseUrl)
                needsAuth = !!metadata && !!metadata.authorization_endpoint
              } catch {
                // If probe fails, assume no auth needed
              }
            } else if (
              serverConfig.authType === "oauth" ||
              serverConfig.authType === "bearer"
            ) {
              needsAuth = true
            }

            if (needsAuth && !headers?.Authorization) {
              status = "needs-auth"
            } else {
              // No tools and doesn't need auth - server failed to connect or has no tools
              status = "failed"
            }
          }

          return { name, status, tools, needsAuth, config: configObj }
        }),
      )

      return results
    }

    // Build list of all groups to process with timing
    const groupTasks: Array<{
      groupName: string
      projectPath: string | null
      promise: Promise<{
        mcpServers: Array<{
          name: string
          status: string
          tools: McpToolInfo[]
          needsAuth: boolean
          config: Record<string, unknown>
        }>
        duration: number
      }>
    }> = []

    // Read ~/.claude/.claude.json once for reuse across global + project merging
    let claudeDirConfig: ClaudeConfig = {}
    try {
      claudeDirConfig = await readClaudeDirConfig()
    } catch { /* ignore */ }

    // Global MCPs (merged from ~/.claude.json + ~/.claude/.claude.json + ~/.claude/mcp.json)
    const mergedGlobalServers = await getMergedGlobalMcpServers(config, claudeDirConfig)
    if (Object.keys(mergedGlobalServers).length > 0) {
      groupTasks.push({
        groupName: "Global",
        projectPath: null,
        promise: (async () => {
          const start = Date.now()
          const freshServers = await ensureMcpTokensFresh(
            mergedGlobalServers,
            GLOBAL_MCP_PATH,
          )
          const mcpServers = await convertServers(freshServers, null) // null = global scope
          return { mcpServers, duration: Date.now() - start }
        })(),
      })
    } else {
      groupTasks.push({
        groupName: "Global",
        projectPath: null,
        promise: Promise.resolve({ mcpServers: [], duration: 0 }),
      })
    }

    // Project MCPs — only scan projects that are open in 2Code (DB projects),
    // not every project Claude CLI has ever seen in ~/.claude.json.
    // Scanning all projects causes 30s+ timeouts from stale stdio MCP servers.
    const allProjectPaths = new Set<string>()
    try {
      const db = getDatabase()
      const dbProjects = db.select({ path: projectsTable.path }).from(projectsTable).all()
      for (const proj of dbProjects) {
        if (proj.path) allProjectPaths.add(proj.path)
      }
    } catch (dbErr) {
      console.error("[MCP] DB project discovery error:", dbErr)
    }

    for (const projectPath of allProjectPaths) {
      const mergedProjectServers = await getMergedLocalProjectMcpServers(projectPath, config, claudeDirConfig)

      // Also read .mcp.json from project root
      const projectMcpJsonServers = await readProjectMcpJsonCached(projectPath)

      // Merge: per-project config servers override .mcp.json
      const allProjectServers = { ...projectMcpJsonServers, ...mergedProjectServers }

      if (Object.keys(allProjectServers).length > 0) {
        const groupName = path.basename(projectPath) || projectPath
        groupTasks.push({
          groupName,
          projectPath,
          promise: (async () => {
            const start = Date.now()
            const freshServers = await ensureMcpTokensFresh(
              allProjectServers,
              projectPath,
            )
            const mcpServers = await convertServers(freshServers, projectPath)
            return { mcpServers, duration: Date.now() - start }
          })(),
        })
      }
    }

    // Process all groups in parallel
    const results = await Promise.all(groupTasks.map((t) => t.promise))

    // Build groups with timing info
    const groupsWithTiming = groupTasks.map((task, i) => ({
      groupName: task.groupName,
      projectPath: task.projectPath,
      mcpServers: results[i].mcpServers,
      duration: results[i].duration,
    }))

    // Log performance (sorted by duration DESC)
    const totalDuration = Date.now() - totalStart
    const workingCount = [...workingMcpServers.values()].filter((v) => v).length
    const sortedByDuration = [...groupsWithTiming].sort(
      (a, b) => b.duration - a.duration,
    )

    console.log(
      `[MCP] Cache updated in ${totalDuration}ms. Working: ${workingCount}/${workingMcpServers.size}`,
    )
    for (const g of sortedByDuration) {
      if (g.mcpServers.length > 0) {
        console.log(
          `[MCP]   ${g.groupName}: ${g.duration}ms (${g.mcpServers.length} servers)`,
        )
      }
    }

    // Return groups without timing info
    const groups = groupsWithTiming.map(
      ({ groupName, projectPath, mcpServers }) => ({
        groupName,
        projectPath,
        mcpServers,
      }),
    )

    // Plugin MCPs (from installed plugins)
    const [enabledPluginSources, pluginMcpConfigs, approvedServers] =
      await Promise.all([
        getEnabledPlugins(),
        discoverPluginMcpServers(),
        getApprovedPluginMcpServers(),
      ])

    for (const pluginConfig of pluginMcpConfigs) {
      // Only show MCP servers from enabled plugins
      if (!enabledPluginSources.includes(pluginConfig.pluginSource)) continue

      const globalServerNames = Object.keys(mergedGlobalServers)
      if (Object.keys(pluginConfig.mcpServers).length > 0) {
        const pluginMcpServers = (
          await Promise.all(
            Object.entries(pluginConfig.mcpServers).map(
              async ([name, serverConfig]) => {
                // Skip servers that have been promoted to ~/.claude.json (e.g., after OAuth)
                if (globalServerNames.includes(name)) return null

                const configObj = serverConfig as Record<string, unknown>
                const identifier = `${pluginConfig.pluginSource}:${name}`
                const isApproved = approvedServers.includes(identifier)

                if (!isApproved) {
                  return {
                    name,
                    status: "pending-approval",
                    tools: [] as McpToolInfo[],
                    needsAuth: false,
                    config: configObj,
                    isApproved,
                  }
                }

                // Try to get status and tools for approved servers
                let status = getServerStatusFromConfig(serverConfig)
                const headers = serverConfig.headers as
                  | Record<string, string>
                  | undefined
                let tools: McpToolInfo[] = []
                let needsAuth = false

                try {
                  tools = await fetchToolsForServer(serverConfig)
                } catch (error) {
                  console.error(
                    `[MCP] Failed to fetch tools for plugin ${name}:`,
                    error,
                  )
                }

                if (tools.length > 0) {
                  status = "connected"
                } else {
                  // Same OAuth detection logic as regular MCP servers
                  if (serverConfig.url) {
                    try {
                      const baseUrl = getMcpBaseUrl(serverConfig.url)
                      const metadata = await fetchOAuthMetadata(baseUrl)
                      needsAuth =
                        !!metadata && !!metadata.authorization_endpoint
                    } catch {
                      // If probe fails, assume no auth needed
                    }
                  } else if (
                    serverConfig.authType === "oauth" ||
                    serverConfig.authType === "bearer"
                  ) {
                    needsAuth = true
                  }

                  if (needsAuth && !headers?.Authorization) {
                    status = "needs-auth"
                  } else {
                    status = "failed"
                  }
                }

                return {
                  name,
                  status,
                  tools,
                  needsAuth,
                  config: configObj,
                  isApproved,
                }
              },
            ),
          )
        ).filter((s): s is NonNullable<typeof s> => s !== null)

        groups.push({
          groupName: `Plugin: ${pluginConfig.pluginSource}`,
          projectPath: null,
          mcpServers: pluginMcpServers,
        })
      }
    }

    return { groups }
  } catch (error) {
    console.error("[getAllMcpConfig] Error:", error)
    return { groups: [], error: String(error) }
  }
}

// ============ USAGE API HELPERS ============

/** Read the token expiry (ms epoch) for the active account from the app DB */
function getStoredTokenExpiry(): number | null {
  try {
    const db = getDatabase()
    // Use the currently selected account (may differ from activeAccountId due to rotation)
    if (!currentAccountId) return null
    const account = db.select().from(anthropicAccounts).where(eq(anthropicAccounts.id, currentAccountId)).get()
    return account?.tokenExpiresAt?.getTime() ?? null
  } catch (error) {
    console.error("[claude-auth] Failed to read token expiry:", error)
    return null
  }
}

/** Read the encrypted refresh token for the currently selected account from the app DB */
function getStoredRefreshToken(): string | null {
  try {
    const db = getDatabase()
    // Use the currently selected account (may differ from activeAccountId due to rotation)
    if (!currentAccountId) return null
    const account = db.select().from(anthropicAccounts).where(eq(anthropicAccounts.id, currentAccountId)).get()
    if (!account?.refreshToken) return null
    return Buffer.from(account.refreshToken, "base64").toString("utf-8")
  } catch (error) {
    console.error("[claude-auth] Failed to decrypt refresh token:", error)
    return null
  }
}

const USAGE_CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutes
const usageCache: { data: unknown; fetchedAt: number } = { data: null, fetchedAt: 0 }

type UsageSuccess = {
  fiveHour: { utilization: number; resetsAt: string } | null
  sevenDay: { utilization: number; resetsAt: string } | null
}
type UsageError = { error: "not_authenticated" | "rate_limited" | "fetch_failed" }
type UsageResult = UsageSuccess | UsageError

async function callUsageApi(token: string): Promise<{ status: number; data?: unknown; errorBody?: string }> {
  const response = await fetch("https://api.anthropic.com/api/oauth/usage", {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "anthropic-beta": "oauth-2025-04-20",
      Accept: "application/json",
    },
  })
  if (!response.ok) {
    let errorBody = ""
    try { errorBody = await response.text() } catch { /* ignore */ }
    console.log(`[usage] API returned ${response.status}: ${errorBody}`)
    return { status: response.status, errorBody }
  }
  return { status: response.status, data: await response.json() }
}

function parseUsageResponse(data: unknown): UsageSuccess {
  const d = data as {
    five_hour?: { utilization: number; resets_at: string }
    seven_day?: { utilization: number; resets_at: string }
  }
  return {
    fiveHour: d.five_hour
      ? { utilization: d.five_hour.utilization, resetsAt: d.five_hour.resets_at }
      : null,
    sevenDay: d.seven_day
      ? { utilization: d.seven_day.utilization, resetsAt: d.seven_day.resets_at }
      : null,
  }
}

async function fetchUsageWithRetry(
  accessToken: string,
  refreshToken?: string,
): Promise<UsageResult> {
  try {
    const first = await callUsageApi(accessToken)

    if (first.data) return parseUsageResponse(first.data)

    // 401 without a refresh token means we can't recover — not authenticated
    if (first.status === 401 && !refreshToken) return { error: "not_authenticated" }

    // On 401 or 429, try refreshing (rate limits are per-access-token)
    if ((first.status === 401 || first.status === 429) && refreshToken) {
      try {
        console.log("[usage] Attempting token refresh after", first.status)
        const refreshed = await refreshClaudeToken(refreshToken)
        const retry = await callUsageApi(refreshed.accessToken)
        if (retry.data) return parseUsageResponse(retry.data)
        if (retry.status === 401) return { error: "not_authenticated" }
        if (retry.status === 429) return { error: "rate_limited" }
      } catch (e) {
        console.log("[usage] Token refresh failed:", e)
        if (first.status === 401) return { error: "not_authenticated" }
      }
    }

    if (first.status === 429) return { error: "rate_limited" }
    return { error: "fetch_failed" }
  } catch (e) {
    console.log("[usage] Fetch error:", e)
    return { error: "fetch_failed" }
  }
}

export const claudeRouter = router({
  /**
   * Stream chat with Claude - single subscription handles everything
   */
  chat: publicProcedure
    .input(
      z.object({
        subChatId: z.string(),
        chatId: z.string(),
        prompt: z.string(),
        cwd: z.string(),
        projectPath: z.string().optional(), // Original project path for MCP config lookup
        mode: z.enum(["plan", "agent"]).default("agent"),
        sessionId: z.string().optional(),
        model: z.string().optional(),
        customConfig: z
          .object({
            model: z.string().min(1),
            token: z.string().min(1),
            baseUrl: z.string().min(1),
          })
          .optional(),
        thinkingConfig: z
          .discriminatedUnion("type", [
            z.object({ type: z.literal("adaptive") }),
            z.object({
              type: z.literal("enabled"),
              budgetTokens: z.number(),
            }),
            z.object({ type: z.literal("disabled") }),
          ])
          .optional(),
        maxThinkingTokens: z.number().optional(), // Deprecated — kept for backwards compat
        effort: z.enum(["low", "medium", "high"]).optional(),
        images: z.array(imageAttachmentSchema).optional(), // Image attachments
        historyEnabled: z.boolean().optional(),
        offlineModeEnabled: z.boolean().optional(), // Whether offline mode (Ollama) is enabled in settings
        enableTasks: z.boolean().optional(), // Enable task management tools (TodoWrite, Task agents)
        browserAccessEnabled: z.boolean().optional(), // Inject browser MCP for web browsing
      }),
    )
    .subscription(({ input }) => {
      return observable<UIMessageChunk>((emit) => {
        // Enforce concurrent agent cap (don't count re-sends for the same subChat)
        if (
          !activeSessions.has(input.subChatId) &&
          activeSessions.size >= MAX_CONCURRENT_AGENTS
        ) {
          emit.next({
            type: "error",
            error: `Too many concurrent agent sessions (max ${MAX_CONCURRENT_AGENTS}). Please wait for an existing session to finish or cancel one.`,
          } as UIMessageChunk)
          emit.complete()
          return
        }

        // Abort any existing session for this subChatId before starting a new one
        // This prevents race conditions if two messages are sent in quick succession
        const existingSession = activeSessions.get(input.subChatId)
        if (existingSession) {
          existingSession.abortController.abort()
        }

        // Get window ID for cross-window session tracking
        // This prevents a crash in window A from aborting sessions in window B
        const windowId = (() => {
          try {
            const window = BrowserWindow.getFocusedWindow()
            return window?.id || null
          } catch {
            return null
          }
        })()

        const abortController = new AbortController()
        const streamId = crypto.randomUUID()
        activeSessions.set(input.subChatId, { abortController, windowId })

        // Stream debug logging
        const subId = input.subChatId.slice(-8) // Short ID for logs
        const streamStart = Date.now()
        let chunkCount = 0
        let lastChunkType = ""
        // Shared sessionId for cleanup to save on abort
        let currentSessionId: string | null = null
        console.log(
          `[SD] M:START sub=${subId} stream=${streamId.slice(-8)} mode=${input.mode}`,
        )

        // Track if observable is still active (not unsubscribed)
        let isObservableActive = true

        // Helper to safely emit (no-op if already unsubscribed)
        // Accepts both individual chunks and batch messages to reduce IPC overhead.
        const safeEmit = (chunk: BatchedUIMessageChunk) => {
          if (!isObservableActive) return false
          try {
            emit.next(chunk)
            return true
          } catch {
            isObservableActive = false
            return false
          }
        }

        // Batch streaming chunks to reduce IPC overhead (~60fps instead of per-token).
        // Critical chunks (errors, finish, interactive prompts) bypass batching.
        const chunkBatcher = new ChunkBatcher((batchedChunk) => {
          safeEmit(batchedChunk)
        })

        // Helper to safely complete (no-op if already closed)
        const safeComplete = () => {
          try {
            emit.complete()
          } catch {
            // Already completed or closed
          }
        }

        // Helper to emit error to frontend
        const emitError = (error: unknown, context: string) => {
          const errorMessage =
            error instanceof Error ? error.message : String(error)
          const errorStack = error instanceof Error ? error.stack : undefined

          console.error(`[claude] ${context}:`, errorMessage)
          if (errorStack) console.error("[claude] Stack:", errorStack)

          // Send detailed error to frontend (safely)
          safeEmit({
            type: "error",
            errorText: `${context}: ${errorMessage}`,
            // Include extra debug info
            ...(process.env.NODE_ENV !== "production" && {
              debugInfo: {
                context,
                cwd: input.cwd,
                mode: input.mode,
                PATH: process.env.PATH?.slice(0, 200),
              },
            }),
          } as UIMessageChunk)
        }

        const sessionPromise = (async () => {
          try {
            const db = getDatabase()

            // 1. Get existing messages from DB
            const existing = db
              .select()
              .from(subChats)
              .where(eq(subChats.id, input.subChatId))
              .get()
            let existingMessages: any[] = []
            try {
              existingMessages = JSON.parse(existing?.messages || "[]")
            } catch (parseErr) {
              console.error("[claude] Corrupted messages JSON in sub-chat", input.subChatId, "- resetting to empty:", parseErr)
            }
            const existingSessionId = existing?.sessionId || null

            // Get resumeSessionAt UUID only if shouldResume flag was set (by rollbackToMessage)
            // or shouldForkResume flag was set (by forkSubChat)
            const lastAssistantMsg = [...existingMessages]
              .reverse()
              .find((m: any) => m.role === "assistant")
            const resumeAtUuid = lastAssistantMsg?.metadata?.shouldResume
              ? lastAssistantMsg?.metadata?.sdkMessageUuid || null
              : null
            const shouldForkResume =
              lastAssistantMsg?.metadata?.shouldForkResume === true
            const forkResumeAtUuid = shouldForkResume
              ? lastAssistantMsg?.metadata?.sdkMessageUuid || null
              : null
            const historyEnabled = input.historyEnabled === true

            // Clear shouldForkResume flag after reading (consumed once) and persist to DB
            if (shouldForkResume) {
              for (const m of existingMessages) {
                if (m.metadata?.shouldForkResume) {
                  delete m.metadata.shouldForkResume
                }
              }
              db.update(subChats)
                .set({ messages: JSON.stringify(existingMessages) })
                .where(eq(subChats.id, input.subChatId))
                .run()
            }

            // Check if last message is already this user message (avoid duplicate)
            const lastMsg = existingMessages[existingMessages.length - 1]
            const lastMsgText = lastMsg?.parts?.find(
              (p: any) => p.type === "text",
            )?.text
            const isDuplicate =
              lastMsg?.role === "user" && lastMsgText === input.prompt

            // 2. Create user message and save BEFORE streaming (skip if duplicate)
            let userMessage: any
            let messagesToSave: any[]

            if (isDuplicate) {
              userMessage = lastMsg
              messagesToSave = existingMessages
            } else {
              const parts: any[] = [{ type: "text", text: input.prompt }]
              if (input.images && input.images.length > 0) {
                for (const img of input.images) {
                  parts.push({
                    type: "data-image",
                    data: {
                      base64Data: img.base64Data,
                      mediaType: img.mediaType,
                      filename: img.filename,
                    },
                  })
                }
              }
              userMessage = {
                id: crypto.randomUUID(),
                role: "user",
                parts,
              }
              messagesToSave = pruneMessageHistory(
                [...existingMessages, userMessage],
                input.subChatId,
              )

              // Debounced write: user message + streamId will be persisted within 100ms.
              // The stream takes longer to start, and the final save will flush anyway.
              scheduleDebouncedWrite(input.subChatId, {
                messages: JSON.stringify(messagesToSave),
                streamId,
                updatedAt: new Date(),
              })
            }

            // 2.5. AUTO-FALLBACK: Check internet and switch to Ollama if offline
            // Only check if offline mode is enabled in settings
            // Use async version that auto-refreshes expired tokens
            let claudeCodeToken = await getClaudeCodeTokenFresh()
            const offlineResult = await checkOfflineFallback(
              input.customConfig,
              claudeCodeToken,
              undefined, // selectedOllamaModel - will be read from customConfig if present
              input.offlineModeEnabled ?? false, // Pass offline mode setting
            )

            if (offlineResult.error) {
              emitError(
                new Error(offlineResult.error),
                "Offline mode unavailable",
              )
              safeEmit({ type: "finish" } as UIMessageChunk)
              safeComplete()
              return
            }

            // Use offline config if available
            const finalCustomConfig = offlineResult.config || input.customConfig
            const isUsingOllama = offlineResult.isUsingOllama

            // Track connection method for analytics
            // Offline status is shown in sidebar, no need to emit message here
            // (emitting text-delta without text-start breaks UI text rendering)

            // 3. Get Claude SDK
            let claudeQuery
            try {
              claudeQuery = await getClaudeQuery()
            } catch (sdkError) {
              emitError(sdkError, "Failed to load Claude SDK")
              console.log(
                `[SD] M:END sub=${subId} reason=sdk_load_error n=${chunkCount}`,
              )
              safeEmit({ type: "finish" } as UIMessageChunk)
              safeComplete()
              return
            }

            // Guard: if a newer sendMessage fired for the same subChatId while we were
            // awaiting the SDK import, our AbortController was already aborted by that
            // newer invocation. Bail out silently — the newer session will handle it.
            if (abortController.signal.aborted) {
              console.log(
                `[SD] M:END sub=${subId} reason=superseded_by_newer_session`,
              )
              safeComplete()
              return
            }

            const resolvedModel = finalCustomConfig?.model || input.model

            const transform = createTransformer({
              emitSdkMessageUuid: historyEnabled,
              isUsingOllama,
              model: resolvedModel,
            })

            // 4. Setup accumulation state
            const parts: any[] = []
            let currentText = ""
            let metadata: any = {}

            // Capture stderr from Claude process for debugging
            const stderrLines: string[] = []

            // Parse mentions from prompt (agents, skills, files, folders)
            const { cleanedPrompt, agentMentions, skillMentions } =
              parseMentions(input.prompt)

            // Build agents option for SDK (proper registration via options.agents)
            const agentsOption = await buildAgentsOption(
              agentMentions,
              input.cwd,
            )

            // Log if agents were mentioned
            if (agentMentions.length > 0) {
              console.log(
                `[claude] Registering agents via SDK:`,
                Object.keys(agentsOption),
              )
            }

            // Log if skills were mentioned
            if (skillMentions.length > 0) {
              console.log(`[claude] Skills mentioned:`, skillMentions)
            }

            // Build final prompt with skill instructions if needed
            let finalPrompt = cleanedPrompt

            // Handle empty prompt when only mentions are present
            if (!finalPrompt.trim()) {
              if (agentMentions.length > 0 && skillMentions.length > 0) {
                finalPrompt = `Use the ${agentMentions.join(", ")} agent(s) and invoke the "${skillMentions.join('", "')}" skill(s) using the Skill tool for this task.`
              } else if (agentMentions.length > 0) {
                finalPrompt = `Use the ${agentMentions.join(", ")} agent(s) for this task.`
              } else if (skillMentions.length > 0) {
                finalPrompt = `Invoke the "${skillMentions.join('", "')}" skill(s) using the Skill tool for this task.`
              }
            } else if (skillMentions.length > 0) {
              // Append skill instruction to existing prompt
              finalPrompt = `${finalPrompt}\n\nUse the "${skillMentions.join('", "')}" skill(s) for this task.`
            }

            // Build prompt: if there are images, create an AsyncIterable<SDKUserMessage>
            // Otherwise use simple string prompt
            let prompt: string | AsyncIterable<any> = finalPrompt

            if (input.images && input.images.length > 0) {
              // Create message content array with images first, then text
              const messageContent: any[] = [
                ...input.images.map((img) => ({
                  type: "image" as const,
                  source: {
                    type: "base64" as const,
                    media_type: img.mediaType,
                    data: img.base64Data,
                  },
                })),
              ]

              // Add text if present
              if (finalPrompt.trim()) {
                messageContent.push({
                  type: "text" as const,
                  text: finalPrompt,
                })
              }

              // Create an async generator that yields a single SDKUserMessage
              async function* createPromptWithImages() {
                yield {
                  type: "user" as const,
                  message: {
                    role: "user" as const,
                    content: messageContent,
                  },
                  parent_tool_use_id: null,
                }
              }

              prompt = createPromptWithImages()
            }

            // Build full environment for Claude SDK (includes HOME, PATH, etc.)
            // Normalize OpenRouter base URL: ensure it ends with /v1 so the SDK hits the correct endpoint.
            // Some users may have saved "https://openrouter.ai/api" (missing /v1) from an older onboarding flow.
            const normalizeBaseUrl = (url: string) => {
              if (url.includes("openrouter.ai") && !url.endsWith("/v1")) {
                return url.replace(/\/?$/, "") + "/v1"
              }
              return url
            }
            // Detect if we're using a non-Anthropic endpoint (OpenRouter, Ollama, other custom providers)
            // These providers don't support Claude-specific params like `effort` and `thinking`
            const isNonAnthropicEndpoint = Boolean(
              finalCustomConfig?.baseUrl &&
              !finalCustomConfig.baseUrl.includes("api.anthropic.com")
            )

            const claudeEnv = buildClaudeEnv({
              ...(finalCustomConfig && {
                customEnv: {
                  // ANTHROPIC_AUTH_TOKEN sends Authorization: Bearer header — accepted by
                  // OpenRouter, Ollama, and other OpenAI-compatible providers.
                  ANTHROPIC_AUTH_TOKEN: finalCustomConfig.token,
                  ANTHROPIC_BASE_URL: normalizeBaseUrl(finalCustomConfig.baseUrl),
                  // Strip ANTHROPIC_API_KEY to prevent the SDK from using a stale Claude
                  // API key against a non-Anthropic endpoint.
                  ANTHROPIC_API_KEY: "",
                  // The CLI uses slot-based env vars to select models, not the SDK `model` param.
                  // Set all slots to the user's chosen model so the CLI uses it regardless of
                  // which internal slot it picks for the task.
                  ...(finalCustomConfig.model && {
                    ANTHROPIC_DEFAULT_OPUS_MODEL: finalCustomConfig.model,
                    ANTHROPIC_DEFAULT_SONNET_MODEL: finalCustomConfig.model,
                    ANTHROPIC_DEFAULT_HAIKU_MODEL: finalCustomConfig.model,
                    CLAUDE_CODE_SUBAGENT_MODEL: finalCustomConfig.model,
                  }),
                  // Disable Claude-specific beta headers (prompt-caching, interleaved-thinking, etc.)
                  // OpenRouter and other third-party providers reject requests that contain
                  // unknown anthropic-beta headers, causing invalid_request errors.
                  ...(isNonAnthropicEndpoint && {
                    CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1",
                  }),
                },
              }),
              enableTasks: input.enableTasks ?? true,
            })

            // Debug logging in dev
            if (process.env.NODE_ENV !== "production") {
              logClaudeEnv(claudeEnv, `[${input.subChatId}] `)
            }

            // Create isolated config directory per subChat to prevent session contamination
            // The Claude binary stores sessions in ~/.claude/ based on cwd, which causes
            // cross-chat contamination when multiple chats use the same project folder
            // For Ollama: use chatId instead of subChatId so all messages in the same chat share history
            const isolatedConfigDir = path.join(
              app.getPath("userData"),
              "claude-sessions",
              isUsingOllama ? input.chatId : input.subChatId,
            )

            // MCP servers to pass to SDK (read from ~/.claude.json)
            let mcpServersForSdk: Record<string, any> | undefined

            // Ensure isolated config dir exists and symlink selected ~/.claude/ assets
            // This is needed because SDK looks for these under $CLAUDE_CONFIG_DIR/
            // OPTIMIZATION: Only create symlinks once per subChatId (cached)
            try {
              await fs.mkdir(isolatedConfigDir, { recursive: true })

              // Only create symlinks if not already created for this config dir
              const cacheKey = isUsingOllama ? input.chatId : input.subChatId
              if (!symlinksCreated.has(cacheKey)) {
                const homeClaudeDir = path.join(os.homedir(), ".claude")
                const symlinkType =
                  process.platform === "win32" ? "junction" : "dir"

                const skillsSource = path.join(homeClaudeDir, "skills")
                const skillsTarget = path.join(isolatedConfigDir, "skills")
                const commandsSource = path.join(homeClaudeDir, "commands")
                const commandsTarget = path.join(isolatedConfigDir, "commands")
                const agentsSource = path.join(homeClaudeDir, "agents")
                const agentsTarget = path.join(isolatedConfigDir, "agents")
                const pluginsSource = path.join(homeClaudeDir, "plugins")
                const pluginsTarget = path.join(isolatedConfigDir, "plugins")
                const settingsSource = path.join(homeClaudeDir, "settings.json")
                const settingsTarget = path.join(
                  isolatedConfigDir,
                  "settings.json",
                )

                let symlinkSetupComplete = true
                let symlinkSetupHadErrors = false

                const ensureSymlink = async (
                  sourcePath: string,
                  targetPath: string,
                  label: string,
                  targetKind: "dir" | "file",
                ) => {
                  try {
                    const sourceExists = await fs
                      .stat(sourcePath)
                      .then(() => true)
                      .catch(() => false)
                    const targetExists = await fs
                      .lstat(targetPath)
                      .then(() => true)
                      .catch(() => false)

                    if (sourceExists && !targetExists) {
                      if (targetKind === "dir") {
                        await fs.symlink(sourcePath, targetPath, symlinkType)
                      } else {
                        await fs.symlink(sourcePath, targetPath)
                      }
                    }

                    // Keep rechecking on next request when source is not created yet.
                    if (!sourceExists && !targetExists) {
                      symlinkSetupComplete = false
                    }
                  } catch (symlinkErr) {
                    symlinkSetupComplete = false
                    symlinkSetupHadErrors = true
                    console.warn(
                      `[claude] Failed to symlink ${label}:`,
                      (symlinkErr as Error).message,
                    )
                  }
                }

                await Promise.all([
                  ensureSymlink(skillsSource, skillsTarget, "skills directory", "dir"),
                  ensureSymlink(commandsSource, commandsTarget, "commands directory", "dir"),
                  ensureSymlink(agentsSource, agentsTarget, "agents directory", "dir"),
                  ensureSymlink(pluginsSource, pluginsTarget, "plugins directory", "dir"),
                  ensureSymlink(settingsSource, settingsTarget, "settings.json", "file"),
                ])

                if (symlinkSetupComplete) {
                  symlinksCreated.add(cacheKey)
                } else if (symlinkSetupHadErrors) {
                  console.warn(
                    "[claude] Symlink setup incomplete, will retry on next request",
                  )
                }
              }

              // Read MCP servers from all sources for the original project path
              // These will be passed directly to the SDK via options.mcpServers
              // Sources: ~/.claude.json, ~/.claude/.claude.json, ~/.claude/mcp.json, .mcp.json
              // OPTIMIZATION: Cache configs by file mtime to avoid re-parsing on every message
              const claudeJsonSource = path.join(os.homedir(), ".claude.json")
              try {
                const stats = await fs.stat(claudeJsonSource).catch(() => null)
                const currentMtime = stats?.mtimeMs ?? 0
                const cached = mcpConfigCache.get(claudeJsonSource)
                const lookupPath = input.projectPath || input.cwd

                // Get or refresh cached config
                let claudeConfig: any
                if (cached && cached.mtime === currentMtime && currentMtime > 0) {
                  claudeConfig = cached.config
                } else if (stats) {
                  claudeConfig = JSON.parse(
                    await fs.readFile(claudeJsonSource, "utf-8"),
                  )
                  mcpConfigCache.set(claudeJsonSource, {
                    config: claudeConfig,
                    mtime: currentMtime,
                  })
                  trimMap(mcpConfigCache, 50)
                } else {
                  claudeConfig = {}
                }

                // Merged MCP config — TTL-cached per project path to avoid redundant I/O on every message
                const cachedMerge = mergedMcpCache.get(lookupPath)
                let allServers: Record<string, McpServerConfig>
                let projectServers: Record<string, McpServerConfig>

                if (
                  cachedMerge &&
                  Date.now() - cachedMerge.timestamp < MCP_MERGE_TTL_MS
                ) {
                  // Cache hit: skip file reads, readClaudeDirConfig, plugin discovery, DB query
                  allServers = cachedMerge.allServers
                  projectServers = cachedMerge.projectServers
                } else {
                  // Full merge: read ~/.claude/.claude.json, global + project + plugin servers
                  let chatClaudeDirConfig: ClaudeConfig = {}
                  try {
                    chatClaudeDirConfig = await readClaudeDirConfig()
                  } catch { /* ignore */ }

                  const globalServers = await getMergedGlobalMcpServers(claudeConfig, chatClaudeDirConfig)
                  const projectConfigServers = await getMergedLocalProjectMcpServers(lookupPath, claudeConfig, chatClaudeDirConfig)
                  const projectMcpJsonServers = await readProjectMcpJsonCached(lookupPath)
                  projectServers = { ...projectMcpJsonServers, ...projectConfigServers }

                  const [
                    enabledPluginSources,
                    pluginMcpConfigs,
                    approvedServers,
                  ] = await Promise.all([
                    getEnabledPlugins(),
                    discoverPluginMcpServers(),
                    getApprovedPluginMcpServers(),
                  ])

                  const pluginServers: Record<string, McpServerConfig> = {}
                  for (const pConfig of pluginMcpConfigs) {
                    if (enabledPluginSources.includes(pConfig.pluginSource)) {
                      for (const [name, serverConfig] of Object.entries(
                        pConfig.mcpServers,
                      )) {
                        if (!globalServers[name] && !projectServers[name]) {
                          const identifier = `${pConfig.pluginSource}:${name}`
                          if (approvedServers.includes(identifier)) {
                            pluginServers[name] = serverConfig
                          }
                        }
                      }
                    }
                  }

                  // Priority: project > global > plugin
                  allServers = {
                    ...pluginServers,
                    ...globalServers,
                    ...projectServers,
                  }

                  mergedMcpCache.set(lookupPath, { allServers, projectServers, timestamp: Date.now() })
                  trimMap(mergedMcpCache, 50)
                }

                // Filter to only working MCPs using scoped cache keys
                if (workingMcpServers.size > 0) {
                  const filtered: Record<string, any> = {}
                  // Resolve worktree path to original project path to match cache keys
                  const resolvedProjectPath =
                    resolveProjectPathFromWorktree(lookupPath) || lookupPath
                  for (const [name, srvConfig] of Object.entries(allServers)) {
                    // Use resolved project scope if server is from project, otherwise global
                    const scope =
                      name in projectServers ? resolvedProjectPath : null
                    const cacheKey = mcpCacheKey(scope, name)
                    // Include server if it's marked working, or if it's not in cache at all
                    // (plugin servers won't be in the cache yet)
                    if (
                      workingMcpServers.get(cacheKey) === true ||
                      !workingMcpServers.has(cacheKey)
                    ) {
                      filtered[name] = srvConfig
                    }
                  }
                  mcpServersForSdk = filtered
                  const skipped =
                    Object.keys(allServers).length -
                    Object.keys(filtered).length
                  if (skipped > 0) {
                    console.log(
                      `[claude] Filtered out ${skipped} non-working MCP(s)`,
                    )
                  }
                } else {
                  mcpServersForSdk = allServers
                }
              } catch (configErr) {
                console.error(`[claude] Failed to read MCP config:`, configErr)
              }
            } catch (mkdirErr) {
              console.error(
                `[claude] Failed to setup isolated config dir:`,
                mkdirErr,
              )
            }

            // Inject browser MCP when toggle is enabled
            if (input.browserAccessEnabled) {
              const browserPath = findBrowserExecutable()
              mcpServersForSdk = {
                ...(mcpServersForSdk ?? {}),
                _browser: {
                  command: "npx",
                  args: ["-y", "@modelcontextprotocol/server-puppeteer"],
                  ...(browserPath ? { env: { PUPPETEER_EXECUTABLE_PATH: browserPath } } : {}),
                },
              }
              console.log(
                `[claude] Browser MCP enabled${browserPath ? ` (executable: ${browserPath})` : " (bundled Chromium)"}`,
              )
            }

            // Check if a custom base URL is configured in the shell environment
            // (independent of finalCustomConfig which comes from the UI settings).
            // ANTHROPIC_API_KEY is always stripped, so only BASE_URL matters here.
            const hasExistingApiConfig = !!claudeEnv.ANTHROPIC_BASE_URL

            if (hasExistingApiConfig) {
              console.log(
                `[claude] Shell has ANTHROPIC_BASE_URL: ${claudeEnv.ANTHROPIC_BASE_URL}`,
              )
            }

            // Account rotation is now handled automatically in selectAvailableAccount()
            // which is called by getClaudeCodeToken() / getClaudeCodeTokenFresh()

            // Build final env with CLAUDE_CODE_OAUTH_TOKEN for direct inference.
            //
            // AUTH MECHANISM (reverse-engineered from CLI binary v2.1.45):
            //
            // The CLI's pB() function reads OAuth tokens from three sources in order:
            //   1. CLAUDE_CODE_OAUTH_TOKEN env var (hardcodes scopes to ["user:inference"])
            //   2. CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR (same hardcoded scopes)
            //   3. .credentials.json file (uses scopes from file)
            //
            // When CLAUDE_CODE_OAUTH_TOKEN is set:
            //   - pB() returns { accessToken, scopes: ["user:inference"], ... }
            //   - O_() returns true (because Vw(scopes) finds "user:inference")
            //   - The Anthropic SDK client is created with:
            //       { apiKey: null, authToken: accessToken }
            //   - The SDK sends Authorization: Bearer <token> directly
            //   - NO create_api_key call is ever made
            //
            // This is vastly simpler than .credentials.json because:
            //   - Scopes are hardcoded by the CLI itself (no format mismatch risk)
            //   - No file I/O needed
            //   - No refresh token handling needed (2Code handles refresh separately)
            //   - Bypasses the entire credential storage system
            //
            // IMPORTANT: ANTHROPIC_AUTH_TOKEN must NOT be in the env because it
            // makes KN() return false, which disables the OAuth path entirely.
            // ANTHROPIC_API_KEY must also not be set (already stripped in env.ts).
            const finalEnv: Record<string, string> = {
              ...claudeEnv,
              CLAUDE_CONFIG_DIR: isolatedConfigDir,
            }

            // Pass OAuth token via CLAUDE_CODE_OAUTH_TOKEN env var for direct inference.
            // Only for the native Anthropic path -- custom configs (OpenRouter/Ollama)
            // already inject their token via customEnv in buildClaudeEnv above.
            if (!finalCustomConfig && claudeCodeToken) {
              finalEnv.CLAUDE_CODE_OAUTH_TOKEN = claudeCodeToken
              console.log(`[claude-auth] Set CLAUDE_CODE_OAUTH_TOKEN env var for direct inference (token: ${claudeCodeToken.slice(0, 10)}...)`)
            }

            // Log auth method being used (single line)
            const authMethod = finalEnv.ANTHROPIC_API_KEY ? "api-key"
              : finalEnv.CLAUDE_CODE_OAUTH_TOKEN ? "oauth-env-var"
              : "keychain/default"
            console.log(
              `[claude-auth] method=${authMethod} customApiConfig=${hasExistingApiConfig} baseUrl=${finalEnv.ANTHROPIC_BASE_URL || "(default)"}`,
            )

            // Get bundled Claude binary path
            const claudeBinaryPath = getBundledClaudeBinaryPath()

            const resumeSessionId =
              input.sessionId || existingSessionId || undefined

            // Session resume tracing (single line)
            console.log(
              `[claude] session: subChat=${input.subChatId} cwd=${input.cwd} resume=${resumeSessionId || "none"} resumeAtUuid=${resumeAtUuid || "none"} fork=${shouldForkResume}`,
            )

            console.log(
              `[SD] Query options - cwd: ${input.cwd}, projectPath: ${input.projectPath || "(not set)"}, mcpServers: ${mcpServersForSdk ? Object.keys(mcpServersForSdk).join(", ") : "(none)"}`,
            )
            if (finalCustomConfig) {
              const redactedConfig = {
                ...finalCustomConfig,
                token: `${finalCustomConfig.token.slice(0, 6)}...`,
              }
              if (isUsingOllama) {
                console.log(
                  `[Ollama] Using offline mode - Model: ${finalCustomConfig.model}, Base URL: ${finalCustomConfig.baseUrl}`,
                )
              } else {
                console.log(
                  `[claude] Custom config: ${JSON.stringify(redactedConfig)}`,
                )
              }
            }

            // DEBUG: If using Ollama, test if it's actually responding
            if (isUsingOllama && finalCustomConfig) {
              console.log("[Ollama Debug] Testing Ollama connectivity...")
              try {
                const testResponse = await fetch(
                  `${finalCustomConfig.baseUrl}/api/tags`,
                  {
                    signal: AbortSignal.timeout(2000),
                  },
                )
                if (testResponse.ok) {
                  const data = await testResponse.json()
                  const models = data.models?.map((m: any) => m.name) || []
                  console.log(
                    "[Ollama Debug] Ollama is responding. Available models:",
                    models,
                  )

                  if (!models.includes(finalCustomConfig.model)) {
                    console.error(
                      `[Ollama Debug] WARNING: Model "${finalCustomConfig.model}" not found in Ollama!`,
                    )
                    console.error(`[Ollama Debug] Available models:`, models)
                    console.error(
                      `[Ollama Debug] This will likely cause the stream to hang or fail silently.`,
                    )
                  } else {
                    console.log(
                      `[Ollama Debug] ✓ Model "${finalCustomConfig.model}" is available`,
                    )
                  }
                } else {
                  console.error(
                    "[Ollama Debug] Ollama returned error:",
                    testResponse.status,
                  )
                }
              } catch (err) {
                console.error(
                  "[Ollama Debug] Failed to connect to Ollama:",
                  err,
                )
              }
            }

            // Skip MCP servers entirely in offline mode (Ollama) - they slow down initialization by 60+ seconds
            // Otherwise pass all MCP servers - the SDK will handle connection
            let mcpServersFiltered: Record<string, any> | undefined

            if (isUsingOllama) {
              console.log(
                "[Ollama] Skipping MCP servers to speed up initialization",
              )
              mcpServersFiltered = undefined
            } else {
              // Ensure MCP tokens are fresh (refresh if within 5 min of expiry)
              if (
                mcpServersForSdk &&
                Object.keys(mcpServersForSdk).length > 0
              ) {
                const lookupPath = input.projectPath || input.cwd
                mcpServersFiltered = await ensureMcpTokensFresh(
                  mcpServersForSdk,
                  lookupPath,
                )
              } else {
                mcpServersFiltered = mcpServersForSdk
              }
            }

            // Log Ollama configuration (single line, no token data)
            if (isUsingOllama) {
              console.log(
                `[Ollama] model=${resolvedModel} baseUrl=${finalEnv.ANTHROPIC_BASE_URL} hasAuthToken=${!!finalEnv.ANTHROPIC_AUTH_TOKEN} resume=${resumeSessionId || "none"}`,
              )
            }

            // Read AGENTS.md from project root if it exists (cached to avoid re-reading on every message)
            const agentsMdContent = await readAgentsMdCached(input.cwd)

            // Load workspace section guards (disabled sections block Edit/Write)
            let disabledSections: import("../../../../shared/section-types").WorkspaceSection[] = []
            try {
              const { getOrDetectSections } = await import("../../sections/sections-config")
              const sectionsCwd = input.projectPath || input.cwd
              const sectionsConfig = await getOrDetectSections(sectionsCwd)
              disabledSections = sectionsConfig.sections.filter((s) => !s.enabled)
              if (disabledSections.length > 0) {
                console.log(
                  `[claude] Section guards: ${disabledSections.length} disabled (${disabledSections.map((s) => s.name).join(", ")})`,
                )
              }
            } catch (err) {
              console.warn("[claude] Failed to load sections config:", err)
            }

            // For Ollama: embed context AND history directly in prompt
            // Ollama doesn't have server-side sessions, so we must include full history
            let finalQueryPrompt: string | AsyncIterable<any> = prompt
            if (isUsingOllama && typeof prompt === "string") {
              // Format conversation history from existingMessages (excluding current message)
              // IMPORTANT: Include tool calls info so model knows what files were read/edited
              let historyText = ""
              if (existingMessages.length > 0) {
                const historyParts: string[] = []
                for (const msg of existingMessages) {
                  if (msg.role === "user") {
                    // Extract text from user message parts
                    const textParts =
                      msg.parts
                        ?.filter((p: any) => p.type === "text")
                        .map((p: any) => p.text) || []
                    if (textParts.length > 0) {
                      historyParts.push(`User: ${textParts.join("\n")}`)
                    }
                  } else if (msg.role === "assistant") {
                    // Extract text AND tool calls from assistant message parts
                    const parts = msg.parts || []
                    const textParts: string[] = []
                    const toolSummaries: string[] = []

                    for (const p of parts) {
                      if (p.type === "text" && p.text) {
                        textParts.push(p.text)
                      } else if (
                        p.type === "tool_use" ||
                        p.type === "tool-use"
                      ) {
                        // Include brief tool call info - this is critical for context!
                        const toolName = p.name || p.tool || "unknown"
                        const toolInput = p.input || {}
                        // Extract key info based on tool type
                        let toolInfo = `[Used ${toolName}`
                        if (
                          toolName === "Read" &&
                          (toolInput.file_path || toolInput.file)
                        ) {
                          toolInfo += `: ${toolInput.file_path || toolInput.file}`
                        } else if (toolName === "Edit" && toolInput.file_path) {
                          toolInfo += `: ${toolInput.file_path}`
                        } else if (
                          toolName === "Write" &&
                          toolInput.file_path
                        ) {
                          toolInfo += `: ${toolInput.file_path}`
                        } else if (toolName === "Glob" && toolInput.pattern) {
                          toolInfo += `: ${toolInput.pattern}`
                        } else if (toolName === "Grep" && toolInput.pattern) {
                          toolInfo += `: "${toolInput.pattern}"`
                        } else if (toolName === "Bash" && toolInput.command) {
                          const cmd = String(toolInput.command).slice(0, 50)
                          toolInfo += `: ${cmd}${toolInput.command.length > 50 ? "..." : ""}`
                        }
                        toolInfo += "]"
                        toolSummaries.push(toolInfo)
                      }
                    }

                    // Combine text and tool summaries
                    let assistantContent = ""
                    if (textParts.length > 0) {
                      assistantContent = textParts.join("\n")
                    }
                    if (toolSummaries.length > 0) {
                      if (assistantContent) {
                        assistantContent += "\n" + toolSummaries.join(" ")
                      } else {
                        assistantContent = toolSummaries.join(" ")
                      }
                    }
                    if (assistantContent) {
                      historyParts.push(`Assistant: ${assistantContent}`)
                    }
                  }
                }
                if (historyParts.length > 0) {
                  // Limit history to last ~10000 chars to avoid context overflow
                  let history = historyParts.join("\n\n")
                  if (history.length > 10000) {
                    history =
                      "...(earlier messages truncated)...\n\n" +
                      history.slice(-10000)
                  }
                  historyText = `[CONVERSATION HISTORY]
${history}
[/CONVERSATION HISTORY]

`
                  console.log(
                    `[Ollama] Added ${historyParts.length} messages to history (${history.length} chars)`,
                  )
                }
              }

              const ollamaContext = `[CONTEXT]
You are a coding assistant in OFFLINE mode (Ollama model: ${resolvedModel || "unknown"}).
Project: ${input.projectPath || input.cwd}
Working directory: ${input.cwd}

IMPORTANT: When using tools, use these EXACT parameter names:
- Read: use "file_path" (not "file")
- Write: use "file_path" and "content"
- Edit: use "file_path", "old_string", "new_string"
- Glob: use "pattern" (e.g. "**/*.ts") and optionally "path"
- Grep: use "pattern" and optionally "path"
- Bash: use "command"

When asked about the project, use Glob to find files and Read to examine them.
Be concise and helpful.
[/CONTEXT]

${historyText}[CURRENT REQUEST]
${prompt}
[/CURRENT REQUEST]`
              finalQueryPrompt = ollamaContext
              console.log("[Ollama] Context prefix added to prompt")
            }

            // System prompt config - use preset for both Claude and Ollama
            // If AGENTS.md exists, append its content to the system prompt
            // Build system prompt appendix
            let systemAppend = ""
            if (agentsMdContent) {
              if (isUsingOllama) {
                // Ollama has no prompt caching — truncate to first 500 chars to save tokens
                const truncated = agentsMdContent.slice(0, 500)
                const isTruncated = agentsMdContent.length > 500
                systemAppend += `\n\n# AGENTS.md (summary)\n${truncated}${isTruncated ? "\n...(truncated)" : ""}`
              } else if (!isNonAnthropicEndpoint) {
                // Anthropic API: include full AGENTS.md (gets cached after first turn)
                systemAppend += `\n\n# AGENTS.md\nThe following are the project's AGENTS.md instructions:\n\n${agentsMdContent}`
              }
              // Non-Anthropic, non-Ollama (e.g. OpenRouter): skip AGENTS.md — no caching benefit
            }
            if (disabledSections.length > 0) {
              const sectionList = disabledSections
                .map((s) => `- ${s.name} (${s.patterns.join(", ")})`)
                .join("\n")
              systemAppend += `\n\n# Section Guards\nThe following codebase sections are DISABLED. Do NOT read, modify, or create files in these areas:\n${sectionList}\nFocus your work on the enabled sections only.`
            }
            const systemPromptConfig = systemAppend
              ? {
                  type: "preset" as const,
                  preset: "claude_code" as const,
                  append: systemAppend,
                }
              : {
                  type: "preset" as const,
                  preset: "claude_code" as const,
                }

            const queryOptions = {
              prompt: finalQueryPrompt,
              options: {
                abortController, // Must be inside options!
                cwd: input.cwd,
                systemPrompt: systemPromptConfig,
                // Register mentioned agents with SDK via options.agents (skip for Ollama - not supported)
                ...(!isUsingOllama &&
                  Object.keys(agentsOption).length > 0 && {
                    agents: agentsOption,
                  }),
                // Pass filtered MCP servers (only working/unknown ones, skip failed/needs-auth)
                ...(mcpServersFiltered &&
                  Object.keys(mcpServersFiltered).length > 0 && {
                    mcpServers: mcpServersFiltered,
                  }),
                env: finalEnv,
                permissionMode:
                  input.mode === "plan"
                    ? ("plan" as const)
                    : ("bypassPermissions" as const),
                ...(input.mode !== "plan" && {
                  allowDangerouslySkipPermissions: true,
                }),
                includePartialMessages: true,
                // Load skills from project and user directories (skip for Ollama - not supported)
                ...(!isUsingOllama && {
                  settingSources: ["project" as const, "user" as const],
                }),
                canUseTool: async (
                  toolName: string,
                  toolInput: Record<string, unknown>,
                  options: { toolUseID: string },
                ) => {
                  // Fix common parameter mistakes from Ollama models
                  // Local models often use slightly wrong parameter names
                  if (isUsingOllama) {
                    // Read: "file" -> "file_path"
                    if (
                      toolName === "Read" &&
                      toolInput.file &&
                      !toolInput.file_path
                    ) {
                      toolInput.file_path = toolInput.file
                      delete toolInput.file
                      console.log("[Ollama] Fixed Read tool: file -> file_path")
                    }
                    // Write: "file" -> "file_path", "content" is usually correct
                    if (
                      toolName === "Write" &&
                      toolInput.file &&
                      !toolInput.file_path
                    ) {
                      toolInput.file_path = toolInput.file
                      delete toolInput.file
                      console.log(
                        "[Ollama] Fixed Write tool: file -> file_path",
                      )
                    }
                    // Edit: "file" -> "file_path"
                    if (
                      toolName === "Edit" &&
                      toolInput.file &&
                      !toolInput.file_path
                    ) {
                      toolInput.file_path = toolInput.file
                      delete toolInput.file
                      console.log("[Ollama] Fixed Edit tool: file -> file_path")
                    }
                    // Glob: "path" might be passed as "directory" or "dir"
                    if (toolName === "Glob") {
                      if (toolInput.directory && !toolInput.path) {
                        toolInput.path = toolInput.directory
                        delete toolInput.directory
                        console.log(
                          "[Ollama] Fixed Glob tool: directory -> path",
                        )
                      }
                      if (toolInput.dir && !toolInput.path) {
                        toolInput.path = toolInput.dir
                        delete toolInput.dir
                        console.log("[Ollama] Fixed Glob tool: dir -> path")
                      }
                    }
                    // Grep: "query" -> "pattern", "directory" -> "path"
                    if (toolName === "Grep") {
                      if (toolInput.query && !toolInput.pattern) {
                        toolInput.pattern = toolInput.query
                        delete toolInput.query
                        console.log(
                          "[Ollama] Fixed Grep tool: query -> pattern",
                        )
                      }
                      if (toolInput.directory && !toolInput.path) {
                        toolInput.path = toolInput.directory
                        delete toolInput.directory
                        console.log(
                          "[Ollama] Fixed Grep tool: directory -> path",
                        )
                      }
                    }
                    // Bash: "cmd" -> "command"
                    if (
                      toolName === "Bash" &&
                      toolInput.cmd &&
                      !toolInput.command
                    ) {
                      toolInput.command = toolInput.cmd
                      delete toolInput.cmd
                      console.log("[Ollama] Fixed Bash tool: cmd -> command")
                    }
                  }

                  if (input.mode === "plan") {
                    if (toolName === "Edit" || toolName === "Write") {
                      const filePath =
                        typeof toolInput.file_path === "string"
                          ? toolInput.file_path
                          : ""
                      if (!/\.md$/i.test(filePath)) {
                        return {
                          behavior: "deny",
                          message:
                            'Only ".md" files can be modified in plan mode.',
                        }
                      }
                    } else if (toolName == "ExitPlanMode") {
                      return {
                        behavior: "deny",
                        message: `IMPORTANT: DONT IMPLEMENT THE PLAN UNTIL THE EXPLIT COMMAND. THE PLAN WAS **ONLY** PRESENTED TO USER, FINISH CURRENT MESSAGE AS SOON AS POSSIBLE`,
                      }
                    } else if (PLAN_MODE_BLOCKED_TOOLS.has(toolName)) {
                      return {
                        behavior: "deny",
                        message: `Tool "${toolName}" blocked in plan mode.`,
                      }
                    }
                  }

                  // Section guards: block Edit/Write to files in disabled sections
                  if (
                    disabledSections.length > 0 &&
                    (toolName === "Edit" || toolName === "Write")
                  ) {
                    const filePath =
                      typeof toolInput.file_path === "string"
                        ? toolInput.file_path
                        : ""
                    if (filePath) {
                      const { getBlockedSection } = await import(
                        "../../sections/match-section"
                      )
                      const cwd = input.cwd
                      const relativePath = filePath.startsWith(cwd)
                        ? filePath.slice(cwd.length).replace(/^\//, "")
                        : filePath
                      const blocked = getBlockedSection(
                        relativePath,
                        disabledSections,
                      )
                      if (blocked) {
                        return {
                          behavior: "deny",
                          message: `File "${relativePath}" is in the "${blocked.name}" section which is currently disabled. Enable it in Settings > Sections to allow modifications.`,
                        }
                      }
                    }
                  }

                  if (toolName === "AskUserQuestion") {
                    const { toolUseID } = options
                    // Emit to UI (safely in case observer is closed)
                    safeEmit({
                      type: "ask-user-question",
                      toolUseId: toolUseID,
                      questions: (toolInput as any).questions,
                    } as UIMessageChunk)

                    // Wait for response (60s timeout)
                    const response = await new Promise<{
                      approved: boolean
                      message?: string
                      updatedInput?: unknown
                    }>((resolve) => {
                      const timeoutId = setTimeout(() => {
                        pendingToolApprovals.delete(toolUseID)
                        // Emit chunk to notify UI that the question has timed out
                        // This ensures the pending question dialog is cleared
                        safeEmit({
                          type: "ask-user-question-timeout",
                          toolUseId: toolUseID,
                        } as UIMessageChunk)
                        resolve({ approved: false, message: "Timed out" })
                      }, 60000)

                      pendingToolApprovals.set(toolUseID, {
                        subChatId: input.subChatId,
                        resolve: (d) => {
                          clearTimeout(timeoutId)
                          resolve(d)
                        },
                      })
                    })

                    // Find the tool part in accumulated parts
                    const askToolPart = parts.find(
                      (p) =>
                        p.toolCallId === toolUseID &&
                        p.type === "tool-AskUserQuestion",
                    )

                    if (!response.approved) {
                      // Update the tool part with error result for skipped/denied
                      const errorMessage = response.message || "Skipped"
                      if (askToolPart) {
                        askToolPart.result = errorMessage
                        askToolPart.state = "result"
                      }
                      // Emit result to frontend so it updates in real-time
                      safeEmit({
                        type: "ask-user-question-result",
                        toolUseId: toolUseID,
                        result: errorMessage,
                      } as UIMessageChunk)
                      return {
                        behavior: "deny",
                        message: errorMessage,
                      }
                    }

                    // Update the tool part with answers result for approved
                    const answers = (response.updatedInput as any)?.answers
                    const answerResult = { answers }
                    if (askToolPart) {
                      askToolPart.result = answerResult
                      askToolPart.state = "result"
                    }
                    // Emit result to frontend so it updates in real-time
                    safeEmit({
                      type: "ask-user-question-result",
                      toolUseId: toolUseID,
                      result: answerResult,
                    } as UIMessageChunk)
                    return {
                      behavior: "allow",
                      updatedInput: response.updatedInput,
                    }
                  }
                  return {
                    behavior: "allow",
                    updatedInput: toolInput,
                  }
                },
                stderr: (data: string) => {
                  if (stderrLines.length < 200) stderrLines.push(data)
                  if (isUsingOllama) {
                    console.error("[Ollama stderr]", data)
                  } else {
                    console.error("[claude stderr]", data)
                  }
                },
                // Use bundled binary
                pathToClaudeCodeExecutable: claudeBinaryPath,
                // Session handling: For Ollama, use resume with session ID to maintain history
                // For Claude API, use resume with rollback/fork support
                ...(resumeSessionId && {
                  resume: resumeSessionId,
                  // Fork support - resume at specific point and create new session
                  ...(shouldForkResume && forkResumeAtUuid && !isUsingOllama
                    ? {
                        resumeSessionAt: forkResumeAtUuid,
                        forkSession: true,
                      }
                    : // Rollback support - resume at specific message UUID (from DB)
                      resumeAtUuid && !isUsingOllama
                      ? { resumeSessionAt: resumeAtUuid }
                      : { continue: true }),
                }),
                // For first message in chat (no session ID yet), use continue mode
                ...(!resumeSessionId && { continue: true }),
                ...(resolvedModel && { model: resolvedModel }),
                // fallbackModel: "claude-opus-4-5-20251101",
                // Thinking config and effort are Anthropic-only features.
                // Don't send them to OpenRouter or other non-Anthropic endpoints — they cause invalid_request errors.
                ...(!isNonAnthropicEndpoint && !isUsingOllama && input.thinkingConfig
                  ? { thinking: input.thinkingConfig }
                  : !isNonAnthropicEndpoint && !isUsingOllama && input.maxThinkingTokens
                    ? { maxThinkingTokens: input.maxThinkingTokens }
                    : {}),
                // Effort level (controls reasoning depth) — Anthropic-only, skip for OpenRouter/Ollama
                ...(!isNonAnthropicEndpoint && !isUsingOllama && input.effort ? { effort: input.effort } : {}),
              },
            }

            // Auto-retry for transient API errors (e.g., false-positive USAGE_POLICY_VIOLATION)
            const MAX_POLICY_RETRIES = 2
            let policyRetryCount = 0
            let policyRetryNeeded = false
            // Auto-retry on auth failure after token refresh (once)
            let authRetryAttempted = false
            let authRetryNeeded = false
            // Auto-retry on OpenRouter transient rate limits (free-tier models are frequently rate-limited)
            const MAX_OPENROUTER_RATE_LIMIT_RETRIES = 3
            let openRouterRateLimitRetryCount = 0
            let openRouterRateLimitRetryNeeded = false
            let messageCount = 0
            let pendingFinishChunk: UIMessageChunk | null = null

            // eslint-disable-next-line no-constant-condition
            while (true) {
              policyRetryNeeded = false
              authRetryNeeded = false
              openRouterRateLimitRetryNeeded = false
              messageCount = 0
              pendingFinishChunk = null

              // Guard: if aborted during async setup (env build, symlinks, etc.) bail silently
              if (abortController.signal.aborted) {
                console.log(
                  `[SD] M:END sub=${subId} reason=aborted_before_query`,
                )
                safeComplete()
                return
              }

              // 5. Run Claude SDK
              let stream
              try {
                console.log(`[SD] M:SPAWN_SUBPROCESS sub=${subId}`)
                stream = claudeQuery(queryOptions)
                console.log(`[SD] M:SUBPROCESS_STARTED sub=${subId}`)
              } catch (queryError) {
                // If the signal was aborted, this is expected — bail silently
                if (abortController.signal.aborted) {
                  console.log(
                    `[SD] M:END sub=${subId} reason=aborted_during_query_start`,
                  )
                  safeComplete()
                  return
                }
                console.error(
                  "[CLAUDE] ✗ Failed to create SDK query:",
                  queryError,
                )
                emitError(queryError, "Failed to start Claude query")
                console.log(
                  `[SD] M:END sub=${subId} reason=query_error n=${chunkCount}`,
                )
                safeEmit({ type: "finish" } as UIMessageChunk)
                safeComplete()
                return
              }

              let lastError: Error | null = null
              let firstMessageReceived = false
              // Track last assistant message UUID for rollback support
              // Only assigned to metadata AFTER the stream completes (not during generation)
              let lastAssistantUuid: string | null = null
              const streamIterationStart = Date.now()

              // Plan mode: track ExitPlanMode to stop after plan is complete
              let exitPlanModeToolCallId: string | null = null

              if (isUsingOllama) {
                console.log(`[Ollama] ===== STARTING STREAM ITERATION =====`)
                console.log(`[Ollama] Model: ${finalCustomConfig?.model}`)
                console.log(`[Ollama] Base URL: ${finalCustomConfig?.baseUrl}`)
                console.log(
                  `[Ollama] Prompt: "${typeof input.prompt === "string" ? input.prompt.slice(0, 100) : "N/A"}..."`,
                )
                console.log(`[Ollama] CWD: ${input.cwd}`)
              }

              try {
                for await (const msg of stream) {
                  if (abortController.signal.aborted) {
                    if (isUsingOllama)
                      console.log(`[Ollama] Stream aborted by user`)
                    break
                  }

                  messageCount++

                  // Extra logging for Ollama to diagnose issues
                  if (isUsingOllama) {
                    const msgAnyPreview = msg as any
                    console.log(`[Ollama] ===== MESSAGE #${messageCount} =====`)
                    console.log(`[Ollama] Type: ${msgAnyPreview.type}`)
                    console.log(
                      `[Ollama] Subtype: ${msgAnyPreview.subtype || "none"}`,
                    )
                    if (msgAnyPreview.event) {
                      console.log(
                        `[Ollama] Event: ${msgAnyPreview.event.type}`,
                        {
                          delta_type: msgAnyPreview.event.delta?.type,
                          content_block_type:
                            msgAnyPreview.event.content_block?.type,
                        },
                      )
                    }
                    if (msgAnyPreview.message?.content) {
                      console.log(
                        `[Ollama] Message content blocks:`,
                        msgAnyPreview.message.content.length,
                      )
                      msgAnyPreview.message.content.forEach(
                        (block: any, idx: number) => {
                          console.log(
                            `[Ollama]   Block ${idx}: type=${block.type}, text_length=${block.text?.length || 0}`,
                          )
                        },
                      )
                    }
                  }

                  // Warn if SDK initialization is slow (MCP delay)
                  if (!firstMessageReceived) {
                    firstMessageReceived = true
                    const timeToFirstMessage = Date.now() - streamIterationStart
                    if (isUsingOllama) {
                      console.log(
                        `[Ollama] Time to first message: ${timeToFirstMessage}ms`,
                      )
                    }
                    if (timeToFirstMessage > 5000) {
                      console.warn(
                        `[claude] SDK initialization took ${(timeToFirstMessage / 1000).toFixed(1)}s (MCP servers loading?)`,
                      )
                    }
                  }

                  // Log raw message for debugging
                  logRawClaudeMessage(input.chatId, msg)

                  // Check for error messages from SDK (error can be embedded in message payload!)
                  const msgAny = msg as any
                  if (msgAny.type === "error" || msgAny.error) {
                    // Extract detailed error text from message content if available
                    // This is where the actual error description lives (e.g., "API Error: Claude Code is unable to respond...")
                    const messageText = msgAny.message?.content?.[0]?.text
                    const sdkError =
                      messageText ||
                      msgAny.error ||
                      msgAny.message ||
                      "Unknown SDK error"
                    lastError = new Error(sdkError)

                    // Detailed SDK error logging in main process
                    console.error(
                      `[CLAUDE SDK ERROR] ========================================`,
                    )
                    console.error(`[CLAUDE SDK ERROR] Raw error: ${sdkError}`)
                    console.error(
                      `[CLAUDE SDK ERROR] Message type: ${msgAny.type}`,
                    )
                    console.error(
                      `[CLAUDE SDK ERROR] SubChat ID: ${input.subChatId}`,
                    )
                    console.error(`[CLAUDE SDK ERROR] Chat ID: ${input.chatId}`)
                    console.error(`[CLAUDE SDK ERROR] CWD: ${input.cwd}`)
                    console.error(`[CLAUDE SDK ERROR] Mode: ${input.mode}`)
                    console.error(
                      `[CLAUDE SDK ERROR] Session ID: ${msgAny.session_id || "none"}`,
                    )
                    console.error(
                      `[CLAUDE SDK ERROR] Has custom config: ${!!finalCustomConfig}`,
                    )
                    console.error(
                      `[CLAUDE SDK ERROR] Is using Ollama: ${isUsingOllama}`,
                    )
                    console.error(
                      `[CLAUDE SDK ERROR] Model: ${resolvedModel || "default"}`,
                    )
                    console.error(
                      `[CLAUDE SDK ERROR] Has OAuth token: ${!!claudeCodeToken}`,
                    )
                    console.error(
                      `[CLAUDE SDK ERROR] MCP servers: ${mcpServersFiltered ? Object.keys(mcpServersFiltered).join(", ") : "none"}`,
                    )
                    console.error(
                      `[CLAUDE SDK ERROR] Full message:`,
                      JSON.stringify(msgAny, null, 2),
                    )
                    console.error(
                      `[CLAUDE SDK ERROR] ========================================`,
                    )

                    // Categorize SDK-level errors
                    // Use the raw error code (e.g., "invalid_request") for category matching
                    const rawErrorCode = msgAny.error || ""
                    let errorCategory = "SDK_ERROR"
                    // Default errorContext to the full error text (which may include detailed message)
                    let errorContext = sdkError
                    const isOpenRouter = finalCustomConfig?.baseUrl?.includes("openrouter.ai")

                    if (
                      rawErrorCode === "authentication_failed" ||
                      sdkError.includes("authentication")
                    ) {
                      // Show OAuth reconnect only when OAuth auth is actually in use.
                      // If API-key auth is active, treat as API auth failure instead.
                      const isApiKeyAuthMode = Boolean(
                        finalCustomConfig || hasExistingApiConfig,
                      )
                      if (isApiKeyAuthMode) {
                        errorCategory = "AUTH_FAILURE"
                        errorContext = isOpenRouter
                          ? "OpenRouter authentication failed - check your API key in Settings → Models"
                          : "Authentication failed - check your API key"
                      } else {
                        errorCategory = "AUTH_FAILED_SDK"
                        errorContext =
                          "Authentication failed - not logged into Claude Code CLI"
                      }
                    } else if (
                      String(sdkError).includes("invalid_token") ||
                      String(sdkError).includes("Invalid access token")
                    ) {
                      errorCategory = "MCP_INVALID_TOKEN"
                      errorContext = "Invalid access token. Update MCP settings"
                    } else if (
                      rawErrorCode === "invalid_api_key" ||
                      sdkError.includes("api_key")
                    ) {
                      errorCategory = "INVALID_API_KEY_SDK"
                      errorContext = isOpenRouter
                        ? "Invalid OpenRouter API key - update it in Settings → Models"
                        : sdkError
                    } else if (
                      rawErrorCode === "rate_limit_exceeded" ||
                      sdkError.includes("rate")
                    ) {
                      errorCategory = "RATE_LIMIT_SDK"
                      errorContext = "Session limit reached"
                    } else if (
                      rawErrorCode === "overloaded" ||
                      sdkError.includes("overload")
                    ) {
                      errorCategory = "OVERLOADED_SDK"
                      errorContext = "Claude is overloaded, try again later"
                    } else if (
                      rawErrorCode === "invalid_request" &&
                      isOpenRouter &&
                      (sdkError.includes("rate-limited") || sdkError.includes("temporarily") ||
                        sdkError.includes("rate limit") || sdkError.includes("overloaded") ||
                        sdkError.includes("upstream"))
                    ) {
                      // OpenRouter: transient upstream rate limit — retryable with backoff
                      errorCategory = "OPENROUTER_RATE_LIMIT"
                      errorContext = "OpenRouter model is rate-limited. Retrying automatically... (free-tier models have limited capacity)"
                    } else if (
                      rawErrorCode === "invalid_request" &&
                      isOpenRouter &&
                      (sdkError.includes("model") || sdkError.includes("selected model"))
                    ) {
                      // OpenRouter: model not found or no access — hard failure, don't retry.
                      errorCategory = "OPENROUTER_MODEL_ERROR"
                      errorContext = sdkError
                    } else if (
                      rawErrorCode === "invalid_request" ||
                      sdkError.includes("Usage Policy") ||
                      sdkError.includes("violate")
                    ) {
                      errorCategory = "USAGE_POLICY_VIOLATION"
                    }

                    // Auto-switch to alternate Anthropic account on rate limit (no mid-stream retry)
                    if (
                      errorCategory === "RATE_LIMIT_SDK" &&
                      !isOpenRouter &&
                      !hasExistingApiConfig
                    ) {
                      const accountId = getCurrentActiveAccountId()
                      if (accountId) {
                        markAccountRateLimited(accountId)
                        console.log(`[claude] Marked account ${accountId} as rate-limited`)
                      }

                      // Clear token cache so next request re-selects available account
                      tokenRefreshCache = null

                      // Check if another account is available
                      const db = getDatabase()
                      const allAccounts = db.select().from(anthropicAccounts).all()
                      const hasAlternate = allAccounts.some(
                        (acc) => acc.id !== accountId && !isAccountRateLimited(acc.id)
                      )

                      if (hasAlternate) {
                        safeEmit({
                          type: "retry-notification",
                          message: "Rate limit reached. Another account will be used automatically — start a new chat to continue.",
                        } as UIMessageChunk)
                        errorContext = "Rate limit reached. Another account will be used automatically — start a new chat to continue."
                        console.log(`[claude] Rate limit on ${accountId} - alternate account available for next session`)
                      } else {
                        errorContext = "All connected accounts have reached their rate limit. Please wait and try again later."
                        console.log(`[claude] All accounts are rate-limited`)
                      }
                      // Falls through to normal error emit — session ends, no retry
                    }

                    // Auto-retry on false-positive policy violations (gateway-level rejections)
                    if (
                      errorCategory === "USAGE_POLICY_VIOLATION" &&
                      policyRetryCount < MAX_POLICY_RETRIES &&
                      !abortController.signal.aborted
                    ) {
                      policyRetryCount++
                      policyRetryNeeded = true
                      console.log(
                        `[claude] USAGE_POLICY_VIOLATION - silent retry (attempt ${policyRetryCount}/${MAX_POLICY_RETRIES})`,
                      )
                      break // break for-await loop to retry
                    }

                    // Auto-retry on OpenRouter transient rate limits with exponential backoff
                    // Free-tier OpenRouter models are frequently rate-limited; a short delay usually resolves it.
                    if (
                      errorCategory === "OPENROUTER_RATE_LIMIT" &&
                      openRouterRateLimitRetryCount < MAX_OPENROUTER_RATE_LIMIT_RETRIES &&
                      !abortController.signal.aborted
                    ) {
                      openRouterRateLimitRetryCount++
                      openRouterRateLimitRetryNeeded = true
                      const backoffMs = openRouterRateLimitRetryCount * 5000 // 5s, 10s, 15s
                      console.log(
                        `[claude] OpenRouter rate limit - backing off ${backoffMs}ms then retrying (attempt ${openRouterRateLimitRetryCount}/${MAX_OPENROUTER_RATE_LIMIT_RETRIES})`,
                      )
                      await new Promise((resolve) => setTimeout(resolve, backoffMs))
                      break // break for-await loop to retry
                    }

                    // On auth failure, try refreshing token and retrying once before showing modal
                    if (errorCategory === "AUTH_FAILED_SDK" && !authRetryAttempted) {
                      // Invalidate cache so refresh is forced
                      tokenRefreshCache = null
                      const refreshedToken = await getClaudeCodeTokenFresh()
                      if (refreshedToken && refreshedToken !== claudeCodeToken) {
                        authRetryAttempted = true
                        authRetryNeeded = true
                        // Update CLAUDE_CODE_OAUTH_TOKEN env var for retry
                        // (the subprocess env is rebuilt on next iteration)
                        if (!hasExistingApiConfig) {
                          finalEnv.CLAUDE_CODE_OAUTH_TOKEN = refreshedToken
                        }
                        console.log("[claude] Auth failed but token refreshed - retrying")
                        break // break for-await loop to retry
                      }
                    }

                    // Emit auth-error for authentication failures, regular error otherwise
                    if (errorCategory === "AUTH_FAILED_SDK") {
                      safeEmit({
                        type: "auth-error",
                        errorText: errorContext,
                      } as UIMessageChunk)
                    } else {
                      safeEmit({
                        type: "error",
                        errorText: errorContext,
                        debugInfo: {
                          category: errorCategory,
                          rawErrorCode,
                          sessionId: msgAny.session_id,
                          messageId: msgAny.message?.id,
                        },
                      } as UIMessageChunk)
                    }

                    console.log(
                      `[SD] M:END sub=${subId} reason=sdk_error cat=${errorCategory} n=${chunkCount}`,
                    )
                    console.error(`[SD] SDK Error details:`, {
                      errorCategory,
                      errorContext: errorContext.slice(0, 200), // Truncate for log readability
                      rawErrorCode,
                      sessionId: msgAny.session_id,
                      messageId: msgAny.message?.id,
                      fullMessage: JSON.stringify(msgAny, null, 2),
                    })
                    safeEmit({ type: "finish" } as UIMessageChunk)
                    safeComplete()
                    return
                  }

                  // Track sessionId for rollback support (available on all messages)
                  if (msgAny.session_id) {
                    metadata.sessionId = msgAny.session_id
                    currentSessionId = msgAny.session_id // Share with cleanup
                  }

                  // Track UUID from assistant messages for resumeSessionAt
                  if (msgAny.type === "assistant" && msgAny.uuid) {
                    lastAssistantUuid = msgAny.uuid
                  }

                  // When result arrives, assign the last assistant UUID to metadata
                  // It will be emitted as part of the merged message-metadata chunk below
                  if (
                    msgAny.type === "result" &&
                    historyEnabled &&
                    lastAssistantUuid &&
                    !abortController.signal.aborted
                  ) {
                    metadata.sdkMessageUuid = lastAssistantUuid
                  }

                  // Debug: Log system messages from SDK
                  if (msgAny.type === "system") {
                    // Full log to see all fields including MCP errors
                    console.log(
                      `[SD] SYSTEM message: subtype=${msgAny.subtype}`,
                      JSON.stringify(
                        {
                          cwd: msgAny.cwd,
                          mcp_servers: msgAny.mcp_servers,
                          tools: msgAny.tools,
                          plugins: msgAny.plugins,
                          permissionMode: msgAny.permissionMode,
                        },
                        null,
                        2,
                      ),
                    )
                  }

                  // Transform and emit + accumulate
                  for (const chunk of transform(msg)) {
                    chunkCount++
                    lastChunkType = chunk.type

                    // For message-metadata, inject sdkMessageUuid before emitting
                    // so the frontend receives the full merged metadata in one chunk
                    if (
                      chunk.type === "message-metadata" &&
                      metadata.sdkMessageUuid
                    ) {
                      chunk.messageMetadata = {
                        ...chunk.messageMetadata,
                        sdkMessageUuid: metadata.sdkMessageUuid,
                      }
                    }

                    // IMPORTANT: Defer the protocol "finish" chunk until after DB persistence.
                    // If we emit finish early, the UI can send the next user message before
                    // this assistant message is written, and the next save overwrites it.
                    if (chunk.type === "finish") {
                      pendingFinishChunk = chunk
                      continue
                    }

                    // Use chunkBatcher to reduce IPC overhead (batches at ~60fps).
                    // Critical chunks (errors, interactive prompts) are emitted immediately.
                    if (!chunkBatcher.write(chunk)) {
                      // Batcher disposed (session ending), break out of loop
                      console.log(
                        `[SD] M:EMIT_CLOSED sub=${subId} type=${chunk.type} n=${chunkCount}`,
                      )
                      break
                    }

                    // Accumulate based on chunk type
                    switch (chunk.type) {
                      case "text-delta":
                        currentText += chunk.delta
                        break
                      case "text-end":
                        if (currentText.trim()) {
                          parts.push({ type: "text", text: currentText })
                          currentText = ""
                        }
                        break
                      case "tool-input-available":
                        // DEBUG: Log tool calls
                        console.log(
                          `[SD] M:TOOL_CALL sub=${subId} toolName="${chunk.toolName}" mode=${input.mode} callId=${chunk.toolCallId}`,
                        )

                        // Track ExitPlanMode toolCallId so we can stop when it completes
                        if (
                          input.mode === "plan" &&
                          chunk.toolName === "ExitPlanMode"
                        ) {
                          console.log(
                            `[SD] M:PLAN_TOOL_DETECTED sub=${subId} callId=${chunk.toolCallId}`,
                          )
                          exitPlanModeToolCallId = chunk.toolCallId
                        }

                        parts.push({
                          type: `tool-${chunk.toolName}`,
                          toolCallId: chunk.toolCallId,
                          toolName: chunk.toolName,
                          input: chunk.input,
                          state: "call",
                          startedAt: Date.now(),
                        })
                        break
                      case "tool-output-available":
                        const toolPart = parts.find(
                          (p) =>
                            p.type?.startsWith("tool-") &&
                            p.toolCallId === chunk.toolCallId,
                        )
                        if (toolPart) {
                          toolPart.result = chunk.output
                          toolPart.output = chunk.output // Backwards compatibility for the UI that relies on output field
                          toolPart.state = "result"

                          // Notify renderer about file changes for Write/Edit tools
                          if (
                            toolPart.type === "tool-Write" ||
                            toolPart.type === "tool-Edit"
                          ) {
                            const filePath = toolPart.input?.file_path
                            if (filePath) {
                              const windows = BrowserWindow.getAllWindows()
                              for (const win of windows) {
                                if (win.isDestroyed()) continue
                                win.webContents.send("file-changed", {
                                  filePath,
                                  type: toolPart.type,
                                  subChatId: input.subChatId,
                                })
                              }
                            }
                          }
                        }
                        break
                      case "message-metadata":
                        metadata = { ...metadata, ...chunk.messageMetadata }
                        break
                    }
                  }
                  // Break from stream loop if observer closed (user clicked Stop)
                  if (!isObservableActive) {
                    console.log(`[SD] M:OBSERVER_CLOSED_STREAM sub=${subId}`)
                    break
                  }
                }

                // Stream iteration complete - subprocess should cleanup automatically via AbortSignal
                console.log(
                  `[SD] M:STREAM_COMPLETE sub=${subId} msgs=${messageCount} aborted=${abortController.signal.aborted}`,
                )

                // Warn if stream yielded no messages (offline mode issue)
                const streamDuration = Date.now() - streamIterationStart
                if (isUsingOllama) {
                  console.log(`[Ollama] ===== STREAM COMPLETED =====`)
                  console.log(`[Ollama] Total messages: ${messageCount}`)
                  console.log(`[Ollama] Duration: ${streamDuration}ms`)
                  console.log(`[Ollama] Chunks emitted: ${chunkCount}`)
                }

                if (messageCount === 0) {
                  console.error(
                    `[claude] Stream yielded no messages - model not responding`,
                  )
                  if (isUsingOllama) {
                    console.error(`[Ollama] ===== DIAGNOSIS =====`)
                    console.error(
                      `[Ollama] Problem: Stream completed but NO messages received from SDK`,
                    )
                    console.error(`[Ollama] This usually means:`)
                    console.error(
                      `[Ollama]   1. Ollama doesn't support Anthropic Messages API format (/v1/messages)`,
                    )
                    console.error(
                      `[Ollama]   2. Model failed to start generating (check Ollama logs: ollama logs)`,
                    )
                    console.error(
                      `[Ollama]   3. Network issue between Claude SDK and Ollama`,
                    )
                    console.error(`[Ollama] ===== NEXT STEPS =====`)
                    console.error(
                      `[Ollama]   1. Check if model works: curl http://localhost:11434/api/generate -d '{"model":"${finalCustomConfig?.model}","prompt":"test"}'`,
                    )
                    console.error(
                      `[Ollama]   2. Check Ollama version supports Messages API`,
                    )
                    console.error(
                      `[Ollama]   3. Try using a proxy that converts Anthropic API → Ollama format`,
                    )
                  }
                } else if (messageCount === 1 && isUsingOllama) {
                  console.warn(
                    `[Ollama] Only received 1 message (likely just init). No actual content generated.`,
                  )
                }
              } catch (streamError) {
                // This catches errors during streaming (like process exit)
                const err = streamError as Error
                const stderrOutput = stderrLines.join("\n")

                if (isUsingOllama) {
                  console.error(`[Ollama] ===== STREAM ERROR =====`)
                  console.error(`[Ollama] Error message: ${err.message}`)
                  console.error(`[Ollama] Error stack:`, err.stack)
                  console.error(
                    `[Ollama] Messages received before error: ${messageCount}`,
                  )
                  if (stderrOutput) {
                    console.error(
                      `[Ollama] Claude binary stderr:`,
                      stderrOutput,
                    )
                  }
                }

                // Build detailed error message with category
                let errorContext = "Claude streaming error"
                let errorCategory = "UNKNOWN"

                // Check for session-not-found error in stderr
                const isSessionNotFound = stderrOutput?.includes(
                  "No conversation found with session ID",
                )

                if (isSessionNotFound) {
                  // Clear the invalid session ID from database so next attempt starts fresh
                  console.log(
                    `[claude] Session not found - clearing invalid sessionId from database`,
                  )
                  db.update(subChats)
                    .set({ sessionId: null })
                    .where(eq(subChats.id, input.subChatId))
                    .run()

                  errorContext = "Previous session expired. Please try again."
                  errorCategory = "SESSION_EXPIRED"
                } else if (
                  stderrOutput?.includes("CPU lacks AVX support") ||
                  stderrOutput?.includes("bun-darwin-x64-baseline")
                ) {
                  errorContext =
                    "Your CPU does not support AVX instructions required by the bundled runtime. Please update 2Code to the latest version for improved compatibility, or contact support."
                  errorCategory = "CPU_INCOMPATIBLE"
                } else if (err.message?.includes("exited with code")) {
                  errorContext = "Claude Code process crashed"
                  errorCategory = "PROCESS_CRASH"
                } else if (err.message?.includes("ENOENT")) {
                  errorContext = "Required executable not found in PATH"
                  errorCategory = "EXECUTABLE_NOT_FOUND"
                } else if (
                  err.message?.includes("authentication") ||
                  err.message?.includes("401")
                ) {
                  errorContext = "Authentication failed - check your API key"
                  errorCategory = "AUTH_FAILURE"
                } else if (
                  err.message?.includes("invalid_api_key") ||
                  err.message?.includes("Invalid API Key") ||
                  stderrOutput?.includes("invalid_api_key")
                ) {
                  errorContext = "Invalid API key"
                  errorCategory = "INVALID_API_KEY"
                } else if (
                  err.message?.includes("rate_limit") ||
                  err.message?.includes("429") ||
                  stderrOutput?.includes("rate_limit") ||
                  stderrOutput?.includes("429") ||
                  stderrOutput?.includes("rate limit")
                ) {
                  errorContext = "Session limit reached"
                  errorCategory = "RATE_LIMIT"

                  // Mark account as rate-limited if using native Anthropic auth
                  if (!isOpenRouter && !hasExistingApiConfig) {
                    const accountId = getCurrentActiveAccountId()
                    if (accountId) {
                      markAccountRateLimited(accountId)
                      console.log(`[claude] Marked account ${accountId} as rate-limited (from catch block)`)
                    }
                  }
                } else if (
                  err.message?.includes("network") ||
                  err.message?.includes("ECONNREFUSED") ||
                  err.message?.includes("fetch failed")
                ) {
                  errorContext = "Network error - check your connection"
                  errorCategory = "NETWORK_ERROR"
                }


                // Send error with stderr output to frontend (only if not aborted by user)
                if (!abortController.signal.aborted) {
                  safeEmit({
                    type: "error",
                    errorText: stderrOutput
                      ? `${errorContext}: ${err.message}\n\nProcess output:\n${stderrOutput}`
                      : `${errorContext}: ${err.message}`,
                    debugInfo: {
                      context: errorContext,
                      category: errorCategory,
                      cwd: input.cwd,
                      mode: input.mode,
                      stderr: stderrOutput || "(no stderr captured)",
                    },
                  } as UIMessageChunk)
                }

                // ALWAYS save accumulated parts before returning (even on abort/error)
                console.log(
                  `[SD] M:CATCH_SAVE sub=${subId} aborted=${abortController.signal.aborted} parts=${parts.length}`,
                )
                if (currentText.trim()) {
                  parts.push({ type: "text", text: currentText })
                }
                if (parts.length > 0) {
                  const assistantMessage = {
                    id: crypto.randomUUID(),
                    role: "assistant",
                    parts,
                    metadata,
                  }
                  const finalMessages = pruneMessageHistory(
                    [...messagesToSave, assistantMessage],
                    input.subChatId,
                  )
                  // Flush immediately: session is ending, data must be persisted now
                  flushPendingWrite(input.subChatId, {
                    messages: JSON.stringify(finalMessages),
                    sessionId: metadata.sessionId,
                    streamId: null,
                    updatedAt: new Date(),
                  }, input.chatId)

                  // Create snapshot stash for rollback support (on error)
                  if (historyEnabled && metadata.sdkMessageUuid && input.cwd) {
                    await createRollbackStash(
                      input.cwd,
                      metadata.sdkMessageUuid,
                    )
                  }
                }

                console.log(
                  `[SD] M:END sub=${subId} reason=stream_error cat=${errorCategory} n=${chunkCount} last=${lastChunkType}`,
                )
                safeEmit({ type: "finish" } as UIMessageChunk)
                safeComplete()
                return
              }

              // Retry if auth failed and token was refreshed
              if (authRetryNeeded) {
                authRetryNeeded = false
                console.log("[claude] Auth retry - restarting stream with refreshed token")
                continue
              }

              // Retry if policy violation detected (transient false positive)
              // Escalating delay: 3s first retry, 6s second retry
              if (policyRetryNeeded) {
                const delayMs = policyRetryCount <= 1 ? 3000 : 6000
                console.log(
                  `[claude] Policy retry ${policyRetryCount}/${MAX_POLICY_RETRIES} - waiting ${delayMs / 1000}s`,
                )
                await new Promise((resolve) => setTimeout(resolve, delayMs))
                continue
              }

              // Retry if OpenRouter rate-limited (backoff already applied in error handler)
              if (openRouterRateLimitRetryNeeded) {
                console.log(
                  `[claude] OpenRouter rate limit retry ${openRouterRateLimitRetryCount}/${MAX_OPENROUTER_RATE_LIMIT_RETRIES} - restarting stream`,
                )
                continue
              }

              break
            } // end policyRetryLoop

            // 6. Check if we got any response
            if (messageCount === 0 && !abortController.signal.aborted) {
              emitError(
                new Error("No response received from Claude"),
                "Empty response",
              )
              console.log(
                `[SD] M:END sub=${subId} reason=no_response n=${chunkCount}`,
              )
              safeEmit({ type: "finish" } as UIMessageChunk)
              safeComplete()
              return
            }

            // 7. Save final messages to DB
            // ALWAYS save accumulated parts, even on abort (so user sees partial responses after reload)
            console.log(
              `[SD] M:SAVE sub=${subId} aborted=${abortController.signal.aborted} parts=${parts.length}`,
            )

            // Flush any remaining text
            if (currentText.trim()) {
              parts.push({ type: "text", text: currentText })
            }

            const savedSessionId = metadata.sessionId

            if (parts.length > 0) {
              const assistantMessage = {
                id: crypto.randomUUID(),
                role: "assistant",
                parts,
                metadata,
              }

              const finalMessages = pruneMessageHistory(
                [...messagesToSave, assistantMessage],
                input.subChatId,
              )

              // Flush immediately: session is ending, data must be persisted now
              flushPendingWrite(input.subChatId, {
                messages: JSON.stringify(finalMessages),
                sessionId: savedSessionId,
                streamId: null,
                updatedAt: new Date(),
              }, input.chatId)
            } else {
              // No assistant response - just clear streamId
              flushPendingWrite(input.subChatId, {
                sessionId: savedSessionId,
                streamId: null,
                updatedAt: new Date(),
              }, input.chatId)
            }

            // Create snapshot stash for rollback support
            if (historyEnabled && metadata.sdkMessageUuid && input.cwd) {
              await createRollbackStash(input.cwd, metadata.sdkMessageUuid)
            }

            const duration = ((Date.now() - streamStart) / 1000).toFixed(1)
            console.log(
              `[SD] M:END sub=${subId} reason=ok n=${chunkCount} last=${lastChunkType} t=${duration}s`,
            )
            // Flush any remaining batched chunks before emitting finish
            chunkBatcher.dispose()
            if (pendingFinishChunk) {
              safeEmit(pendingFinishChunk)
            } else {
              // Keep protocol invariant for consumers that wait for finish.
              safeEmit({ type: "finish" } as UIMessageChunk)
            }
            safeComplete()
          } catch (error) {
            const duration = ((Date.now() - streamStart) / 1000).toFixed(1)
            console.log(
              `[SD] M:END sub=${subId} reason=unexpected_error n=${chunkCount} t=${duration}s`,
            )
            chunkBatcher.dispose()
            emitError(error, "Unexpected error")
            safeEmit({ type: "finish" } as UIMessageChunk)
            safeComplete()
          } finally {
            activeSessions.delete(input.subChatId)
          }
        })()

        // Track session completion for graceful shutdown
        registerSessionCompletion(input.subChatId, sessionPromise)

        // Cleanup on unsubscribe
        return () => {
          console.log(
            `[SD] M:CLEANUP sub=${subId} sessionId=${currentSessionId || "none"}`,
          )
          chunkBatcher.dispose() // Flush remaining batched chunks before teardown
          isObservableActive = false // Prevent emit after unsubscribe
          abortController.abort()
          activeSessions.delete(input.subChatId)
          clearPendingApprovals("Session ended.", input.subChatId)

          // Clear streamId since we're no longer streaming.
          // sessionId is NOT saved here — the save block in the async function
          // handles it (saves on normal completion, clears on abort). This avoids
          // a redundant DB write that the cancel mutation would then overwrite.
          const db = getDatabase()
          db.update(subChats)
            .set({ streamId: null })
            .where(eq(subChats.id, input.subChatId))
            .run()
        }
      })
    }),

  /**
   * Get MCP servers configuration for a project
   * This allows showing MCP servers in UI before starting a chat session
   * NOTE: Does NOT fetch OAuth metadata here - that's done lazily when user clicks Auth
   */
  getMcpConfig: publicProcedure
    .input(z.object({ projectPath: z.string() }))
    .query(async ({ input }) => {
      try {
        const config = await readClaudeConfig()
        const dirConfig = await readClaudeDirConfig()

        // Merged global servers from all user-level sources
        const globalServers = await getMergedGlobalMcpServers(config, dirConfig)

        // Per-project servers from config files
        const projectConfigServers = await getMergedLocalProjectMcpServers(input.projectPath, config, dirConfig)

        // .mcp.json from project root
        const projectMcpJsonServers = await readProjectMcpJsonCached(input.projectPath)

        // Merge: project config > .mcp.json > global
        const merged = {
          ...globalServers,
          ...projectMcpJsonServers,
          ...projectConfigServers,
        }

        // Add plugin MCP servers (enabled + approved only)
        const [enabledPluginSources, pluginMcpConfigs, approvedServers] =
          await Promise.all([
            getEnabledPlugins(),
            discoverPluginMcpServers(),
            getApprovedPluginMcpServers(),
          ])

        for (const pluginConfig of pluginMcpConfigs) {
          if (!enabledPluginSources.includes(pluginConfig.pluginSource))
            continue
          for (const [name, serverConfig] of Object.entries(
            pluginConfig.mcpServers,
          )) {
            if (!merged[name]) {
              const identifier = `${pluginConfig.pluginSource}:${name}`
              if (approvedServers.includes(identifier)) {
                merged[name] = serverConfig
              }
            }
          }
        }

        // Convert to array format - determine status from config (no caching)
        const mcpServers = Object.entries(merged).map(
          ([name, serverConfig]) => {
            const configObj = serverConfig as Record<string, unknown>
            const status = getServerStatusFromConfig(configObj)
            const hasUrl = !!configObj.url

            return {
              name,
              status,
              config: { ...configObj, _hasUrl: hasUrl },
            }
          },
        )

        return { mcpServers, projectPath: input.projectPath }
      } catch (error) {
        console.error("[getMcpConfig] Error reading config:", error)
        return {
          mcpServers: [],
          projectPath: input.projectPath,
          error: String(error),
        }
      }
    }),

  /**
   * Get ALL MCP servers configuration (global + all projects)
   * Returns grouped data for display in settings
   * Also populates the workingMcpServers cache
   */
  getAllMcpConfig: publicProcedure.query(getAllMcpConfigHandler),

  refreshMcpConfig: publicProcedure.mutation(() => {
    workingMcpServers.clear()
    mcpConfigCache.clear()
    projectMcpJsonCache.clear()
    agentsMdCache.clear()
    mergedMcpCache.clear()
    return { success: true }
  }),

  /**
   * Cancel active session
   */
  cancel: publicProcedure
    .input(z.object({ subChatId: z.string() }))
    .mutation(({ input }) => {
      const session = activeSessions.get(input.subChatId)
      if (session) {
        session.abortController.abort()
        activeSessions.delete(input.subChatId)
        clearPendingApprovals("Session cancelled.", input.subChatId)
      }

      return { cancelled: !!session }
    }),

  /**
   * Check if session is active
   */
  isActive: publicProcedure
    .input(z.object({ subChatId: z.string() }))
    .query(({ input }) => activeSessions.has(input.subChatId)),
  respondToolApproval: publicProcedure
    .input(
      z.object({
        toolUseId: z.string(),
        approved: z.boolean(),
        message: z.string().optional(),
        updatedInput: z.unknown().optional(),
      }),
    )
    .mutation(({ input }) => {
      const pending = pendingToolApprovals.get(input.toolUseId)
      if (!pending) {
        return { ok: false }
      }
      pending.resolve({
        approved: input.approved,
        message: input.message,
        updatedInput: input.updatedInput,
      })
      pendingToolApprovals.delete(input.toolUseId)
      return { ok: true }
    }),

  /**
   * Start MCP OAuth flow for a server
   * Fetches OAuth metadata internally when needed
   */
  startMcpOAuth: publicProcedure
    .input(
      z.object({
        serverName: z.string(),
        projectPath: z.string(),
      }),
    )
    .mutation(async ({ input }) => {
      return startMcpOAuth(input.serverName, input.projectPath)
    }),

  /**
   * Get MCP auth status for a server
   */
  getMcpAuthStatus: publicProcedure
    .input(
      z.object({
        serverName: z.string(),
        projectPath: z.string(),
      }),
    )
    .query(async ({ input }) => {
      return getMcpAuthStatus(input.serverName, input.projectPath)
    }),

  addMcpServer: publicProcedure
    .input(
      z.object({
        name: z
          .string()
          .min(1)
          .regex(
            /^[a-zA-Z0-9_-]+$/,
            "Name must contain only letters, numbers, underscores, and hyphens",
          ),
        scope: z.enum(["global", "project"]),
        projectPath: z.string().optional(),
        transport: z.enum(["stdio", "http"]),
        command: z.string().optional(),
        args: z.array(z.string()).optional(),
        env: z.record(z.string()).optional(),
        url: z.string().url().optional(),
        authType: z.enum(["none", "oauth", "bearer"]).optional(),
        bearerToken: z.string().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const serverName = input.name.trim()

      if (input.transport === "stdio" && !input.command?.trim()) {
        throw new Error("Command is required for stdio servers")
      }
      if (input.transport === "http" && !input.url?.trim()) {
        throw new Error("URL is required for HTTP servers")
      }
      if (input.scope === "project" && !input.projectPath) {
        throw new Error("Project path required for project-scoped servers")
      }

      const serverConfig: McpServerConfig = {}
      if (input.transport === "stdio") {
        serverConfig.command = input.command!.trim()
        if (input.args && input.args.length > 0) {
          serverConfig.args = input.args
        }
        if (input.env && Object.keys(input.env).length > 0) {
          serverConfig.env = input.env
        }
      } else {
        serverConfig.url = input.url!.trim()
        if (input.authType) {
          serverConfig.authType = input.authType
        }
        if (input.bearerToken) {
          serverConfig.headers = {
            Authorization: `Bearer ${input.bearerToken}`,
          }
        }
      }

      // Check existence before writing
      const existingConfig = await readClaudeConfig()
      const projectPath = input.projectPath
      if (input.scope === "project" && projectPath) {
        if (existingConfig.projects?.[projectPath]?.mcpServers?.[serverName]) {
          throw new Error(
            `Server "${serverName}" already exists in this project`,
          )
        }
      } else {
        if (existingConfig.mcpServers?.[serverName]) {
          throw new Error(`Server "${serverName}" already exists`)
        }
      }

      const config = updateMcpServerConfig(
        existingConfig,
        input.scope === "project" ? (projectPath ?? null) : null,
        serverName,
        serverConfig,
      )
      await writeClaudeConfig(config)

      return { success: true, name: serverName }
    }),

  updateMcpServer: publicProcedure
    .input(
      z.object({
        name: z.string(),
        scope: z.enum(["global", "project"]),
        projectPath: z.string().optional(),
        newName: z
          .string()
          .regex(/^[a-zA-Z0-9_-]+$/)
          .optional(),
        command: z.string().optional(),
        args: z.array(z.string()).optional(),
        env: z.record(z.string()).optional(),
        url: z.string().url().optional(),
        authType: z.enum(["none", "oauth", "bearer"]).optional(),
        bearerToken: z.string().optional(),
        disabled: z.boolean().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const config = await readClaudeConfig()
      const projectPath =
        input.scope === "project" ? input.projectPath : undefined

      // Check server exists
      let servers: Record<string, McpServerConfig> | undefined
      if (projectPath) {
        servers = config.projects?.[projectPath]?.mcpServers
      } else {
        servers = config.mcpServers
      }
      if (!servers?.[input.name]) {
        throw new Error(`Server "${input.name}" not found`)
      }

      const existing = servers[input.name]

      // Handle rename: create new, remove old
      if (input.newName && input.newName !== input.name) {
        if (servers[input.newName]) {
          throw new Error(`Server "${input.newName}" already exists`)
        }
        const updated = removeMcpServerConfig(
          config,
          projectPath ?? null,
          input.name,
        )
        const finalConfig = updateMcpServerConfig(
          updated,
          projectPath ?? null,
          input.newName,
          existing,
        )
        await writeClaudeConfig(finalConfig)
        return { success: true, name: input.newName }
      }

      // Build update object from provided fields
      const update: Partial<McpServerConfig> = {}
      if (input.command !== undefined) update.command = input.command
      if (input.args !== undefined) update.args = input.args
      if (input.env !== undefined) update.env = input.env
      if (input.url !== undefined) update.url = input.url
      if (input.disabled !== undefined) update.disabled = input.disabled

      // Handle bearer token
      if (input.bearerToken) {
        update.authType = "bearer"
        update.headers = { Authorization: `Bearer ${input.bearerToken}` }
      }

      // Handle authType changes
      if (input.authType) {
        update.authType = input.authType
        if (input.authType === "none") {
          // Clear auth-related fields
          update.headers = undefined
          update._oauth = undefined
        }
      }

      const merged = { ...existing, ...update }
      const updatedConfig = updateMcpServerConfig(
        config,
        projectPath ?? null,
        input.name,
        merged,
      )
      await writeClaudeConfig(updatedConfig)

      return { success: true, name: input.name }
    }),

  removeMcpServer: publicProcedure
    .input(
      z.object({
        name: z.string(),
        scope: z.enum(["global", "project"]),
        projectPath: z.string().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const config = await readClaudeConfig()
      const projectPath =
        input.scope === "project" ? input.projectPath : undefined

      // Check server exists
      let servers: Record<string, McpServerConfig> | undefined
      if (projectPath) {
        servers = config.projects?.[projectPath]?.mcpServers
      } else {
        servers = config.mcpServers
      }
      if (!servers?.[input.name]) {
        throw new Error(`Server "${input.name}" not found`)
      }

      const updated = removeMcpServerConfig(
        config,
        projectPath ?? null,
        input.name,
      )
      await writeClaudeConfig(updated)

      return { success: true }
    }),

  setMcpBearerToken: publicProcedure
    .input(
      z.object({
        name: z.string(),
        scope: z.enum(["global", "project"]),
        projectPath: z.string().optional(),
        token: z.string(),
      }),
    )
    .mutation(async ({ input }) => {
      const config = await readClaudeConfig()
      const projectPath =
        input.scope === "project" ? input.projectPath : undefined

      // Check server exists
      let servers: Record<string, McpServerConfig> | undefined
      if (projectPath) {
        servers = config.projects?.[projectPath]?.mcpServers
      } else {
        servers = config.mcpServers
      }
      if (!servers?.[input.name]) {
        throw new Error(`Server "${input.name}" not found`)
      }

      const existing = servers[input.name]
      const updated: McpServerConfig = {
        ...existing,
        authType: "bearer",
        headers: { Authorization: `Bearer ${input.token}` },
      }

      const updatedConfig = updateMcpServerConfig(
        config,
        projectPath ?? null,
        input.name,
        updated,
      )
      await writeClaudeConfig(updatedConfig)

      return { success: true }
    }),

  getPendingPluginMcpApprovals: publicProcedure
    .input(z.object({ projectPath: z.string().optional() }))
    .query(async ({ input }) => {
      const [enabledPluginSources, pluginMcpConfigs, approvedServers] =
        await Promise.all([
          getEnabledPlugins(),
          discoverPluginMcpServers(),
          getApprovedPluginMcpServers(),
        ])

      // Read global/project servers from all sources for conflict check
      const config = await readClaudeConfig()
      const dirConfig = await readClaudeDirConfig()
      const globalServers = await getMergedGlobalMcpServers(config, dirConfig)
      let projectServers: Record<string, McpServerConfig> = {}
      if (input.projectPath) {
        const projectConfigServers = await getMergedLocalProjectMcpServers(input.projectPath, config, dirConfig)
        const projectMcpJsonServers = await readProjectMcpJsonCached(input.projectPath)
        projectServers = { ...projectMcpJsonServers, ...projectConfigServers }
      }

      const pending: Array<{
        pluginSource: string
        serverName: string
        identifier: string
        config: Record<string, unknown>
      }> = []

      for (const pluginConfig of pluginMcpConfigs) {
        if (!enabledPluginSources.includes(pluginConfig.pluginSource)) continue

        for (const [name, serverConfig] of Object.entries(
          pluginConfig.mcpServers,
        )) {
          const identifier = `${pluginConfig.pluginSource}:${name}`
          if (
            !approvedServers.includes(identifier) &&
            !globalServers[name] &&
            !projectServers[name]
          ) {
            pending.push({
              pluginSource: pluginConfig.pluginSource,
              serverName: name,
              identifier,
              config: serverConfig as Record<string, unknown>,
            })
          }
        }
      }

      return { pending }
    }),

  /**
   * Fetch Claude subscription usage from Anthropic API
   * Returns utilization percentages for 5-hour and 7-day windows
   *
   * Uses server-side cache (5 min) to avoid aggressive rate limiting on the
   * /api/oauth/usage endpoint. On 401/429, attempts token refresh (keychain
   * creds have refresh tokens) since rate limits are per-access-token.
   */
  getUsage: publicProcedure.query(async () => {
    // Return cached response if fresh (5 min TTL for success, 1 min for rate limits)
    if (usageCache.data && Date.now() - usageCache.fetchedAt < USAGE_CACHE_TTL_MS) {
      return usageCache.data
    }
    if (usageCache.data && "error" in usageCache.data && usageCache.data.error === "rate_limited" && Date.now() - usageCache.fetchedAt < 60_000) {
      return usageCache.data
    }

    // Resolve token: prefer app DB first (avoids macOS keychain password prompt),
    // fall back to keychain only if DB has no token.
    const appToken = getClaudeCodeToken()
    const appRefreshToken = getStoredRefreshToken()
    const dbTokenExpiry = getStoredTokenExpiry()
    const dbTokenExpired = dbTokenExpiry !== null ? isTokenExpired(dbTokenExpiry) : false

    let accessToken: string | null = appToken
    let refreshToken: string | undefined = appRefreshToken ?? undefined

    // Only read keychain if DB has no token
    let keychainCreds: ReturnType<typeof getExistingClaudeCredentials> = null
    if (!accessToken) {
      keychainCreds = getExistingClaudeCredentials()
      accessToken = keychainCreds?.accessToken ?? null
      refreshToken = refreshToken ?? keychainCreds?.refreshToken ?? undefined
    }

    if (!accessToken) {
      return { error: "not_authenticated" as const }
    }

    const tokenSource = appToken ? "app-db" : "keychain"
    const tokenScopes = keychainCreds?.scopes ?? []
    console.log(`[usage] token source=${tokenSource} scopes=[${tokenScopes.join(",")}] hasRefresh=${!!refreshToken}`)

    // If DB token is expired, proactively refresh before calling
    if (dbTokenExpired && refreshToken) {
      try {
        const refreshed = await refreshClaudeToken(refreshToken)
        accessToken = refreshed.accessToken
        const expiresAt = refreshed.expiresAt ? new Date(refreshed.expiresAt) : undefined
        updateStoredAccessToken(refreshed.accessToken, refreshed.refreshToken, expiresAt)
        console.log("[usage] Proactively refreshed expired token")
      } catch {
        // Continue with current token — it might still work
      }
    }

    const result = await fetchUsageWithRetry(accessToken, refreshToken)
    // Cache both success and rate_limited responses to avoid hammer hits
    if (!("error" in result) || result.error === "rate_limited") {
      usageCache.data = result
      usageCache.fetchedAt = Date.now()
    }
    return result
  }),
})
