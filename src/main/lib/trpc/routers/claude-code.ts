import { createHash, randomBytes } from "node:crypto"
import { eq } from "drizzle-orm"
import { safeStorage, shell } from "electron"
import { z } from "zod"
import { getAuthManager } from "../../../index"
import { AUTH_SERVER_PORT } from "../../../constants"
import { getClaudeShellEnvironment } from "../../claude"
import { getExistingClaudeCredentials, getExistingClaudeToken } from "../../claude-token"
import {
  anthropicAccounts,
  anthropicSettings,
  claudeCodeCredentials,
  getDatabase,
} from "../../db"
import { createId } from "../../db/utils"
import { publicProcedure, router } from "../index"

// ── Claude Code PKCE OAuth constants ─────────────────────────────────────────
// Mirrors the exact flow from the Claude CLI binary (claude login).

const ANTHROPIC_AUTH_ENDPOINT = "https://claude.ai/oauth/authorize"
const ANTHROPIC_TOKEN_ENDPOINT = "https://platform.claude.com/v1/oauth/token"
const CLAUDE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
// Manual fallback redirect — shown to user if automatic localhost capture fails.
const MANUAL_REDIRECT_URI = "https://platform.claude.com/oauth/code/callback"

// In-memory session store (keyed by sessionId)
interface OAuthSession {
  codeVerifier: string
  state: string
  // The redirect URI used in the auth URL (must match in token exchange)
  redirectUri: string
  // The manual URL shown as fallback (displayed in the UI)
  manualUrl: string
  // The auto URL opened in the browser (uses localhost redirect)
  autoUrl: string
  // Set true after successful token exchange so polls keep returning "success"
  completed: boolean
  // Set if token exchange failed
  exchangeError: string | null
}

const oauthSessions = new Map<string, OAuthSession>()

// Matches the Claude CLI's base64url exactly (no padding)
function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
}

function generateCodeVerifier(): string {
  return base64url(randomBytes(32))
}

function generateCodeChallenge(verifier: string): string {
  return base64url(createHash("sha256").update(verifier).digest())
}

function generateState(): string {
  return base64url(randomBytes(32))
}

function buildAuthUrl(params: {
  codeChallenge: string
  state: string
  redirectUri: string
}): string {
  const url = new URL(ANTHROPIC_AUTH_ENDPOINT)
  url.searchParams.append("code", "true")
  url.searchParams.append("client_id", CLAUDE_CLIENT_ID)
  url.searchParams.append("response_type", "code")
  url.searchParams.append("redirect_uri", params.redirectUri)
  // Scopes matching the claude login flow (tR9 from CLI binary)
  // Note: org:create_api_key is included for non-claude.ai console users but may be ignored by claude.ai
  url.searchParams.append("scope", "user:profile user:inference user:sessions:claude_code user:mcp_servers")
  url.searchParams.append("code_challenge", params.codeChallenge)
  url.searchParams.append("code_challenge_method", "S256")
  url.searchParams.append("state", params.state)
  return url.toString()
}

/**
 * Handle OAuth callback received on the main auth server (fixed port).
 * Finds the matching session by state, exchanges the code for a token, and stores it.
 * Exported for use from the auth server in index.ts.
 */
export async function handleClaudeCodeOAuthCallback(code: string, state: string): Promise<void> {
  // Find session by state
  let matchedSession: OAuthSession | null = null
  for (const [, session] of oauthSessions) {
    if (session.state === state) {
      matchedSession = session
      break
    }
  }

  if (!matchedSession) {
    console.error("[ClaudeCode] No matching OAuth session for state:", state.slice(0, 8) + "...")
    return
  }

  console.log("[ClaudeCode] Callback received on auth server, exchanging token...")

  try {
    const tokenRes = await fetch(ANTHROPIC_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: matchedSession.redirectUri,
        client_id: CLAUDE_CLIENT_ID,
        code_verifier: matchedSession.codeVerifier,
        state: matchedSession.state,
      }).toString(),
    })

    if (!tokenRes.ok) {
      const errText = await tokenRes.text().catch(() => tokenRes.statusText)
      console.error("[ClaudeCode] Token exchange failed:", tokenRes.status, errText)
      matchedSession.exchangeError = `Token exchange failed (${tokenRes.status}): ${errText}`
      return
    }

    const tokenData = await tokenRes.json() as { access_token: string; refresh_token?: string; expires_in?: number }
    const expiresAt = tokenData.expires_in ? new Date(Date.now() + tokenData.expires_in * 1000) : undefined
    storeOAuthToken(tokenData.access_token, true, tokenData.refresh_token, expiresAt)
    matchedSession.completed = true
    console.log("[ClaudeCode] Token stored via auth server callback")
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error)
    console.error("[ClaudeCode] Token exchange error:", errMsg)
    matchedSession.exchangeError = `Token exchange failed: ${errMsg}`
  }
}

/**
 * Get desktop auth token for server API calls
 */
async function getDesktopToken(): Promise<string | null> {
  const authManager = getAuthManager()
  return authManager.getValidToken()
}

/**
 * Encrypt token using Electron's safeStorage
 */
function encryptToken(token: string): string {
  if (!safeStorage.isEncryptionAvailable()) {
    console.warn("[ClaudeCode] Encryption not available, storing as base64")
    return Buffer.from(token).toString("base64")
  }
  return safeStorage.encryptString(token).toString("base64")
}

/**
 * Decrypt token using Electron's safeStorage
 */
function decryptToken(encrypted: string): string {
  try {
    if (!safeStorage.isEncryptionAvailable()) {
      return Buffer.from(encrypted, "base64").toString("utf-8")
    }
    const buffer = Buffer.from(encrypted, "base64")
    return safeStorage.decryptString(buffer)
  } catch (error) {
    console.error("[decryptToken] Failed to decrypt:", error)
    return ""
  }
}

/**
 * Store OAuth token - now uses multi-account system
 * If setAsActive is true, also sets this account as active
 */
function storeOAuthToken(oauthToken: string, setAsActive = true, refreshToken?: string, expiresAt?: Date): string {
  const authManager = getAuthManager()
  const user = authManager.getUser()

  const encryptedToken = encryptToken(oauthToken)
  const encryptedRefresh = refreshToken ? encryptToken(refreshToken) : null
  const db = getDatabase()
  const newId = createId()

  // Store in new multi-account table
  db.insert(anthropicAccounts)
    .values({
      id: newId,
      oauthToken: encryptedToken,
      refreshToken: encryptedRefresh,
      tokenExpiresAt: expiresAt ?? null,
      displayName: "Anthropic Account",
      connectedAt: new Date(),
      desktopUserId: user?.id ?? null,
    })
    .run()

  if (setAsActive) {
    // Set as active account
    db.insert(anthropicSettings)
      .values({
        id: "singleton",
        activeAccountId: newId,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: anthropicSettings.id,
        set: {
          activeAccountId: newId,
          updatedAt: new Date(),
        },
      })
      .run()
  }

  // Also update legacy table for backward compatibility
  db.delete(claudeCodeCredentials)
    .where(eq(claudeCodeCredentials.id, "default"))
    .run()

  db.insert(claudeCodeCredentials)
    .values({
      id: "default",
      oauthToken: encryptedToken,
      connectedAt: new Date(),
      userId: user?.id ?? null,
    })
    .run()

  return newId
}

/**
 * Claude Code OAuth router for desktop
 * Uses server only for sandbox creation, stores token locally
 */
export const claudeCodeRouter = router({
  /**
   * Check if user has existing CLI config (API key or proxy)
   * If true, user can skip OAuth onboarding
   * Based on PR #29 by @sa4hnd
   */
  hasExistingCliConfig: publicProcedure.query(() => {
    const shellEnv = getClaudeShellEnvironment()
    const hasConfig = !!(shellEnv.ANTHROPIC_API_KEY || shellEnv.ANTHROPIC_AUTH_TOKEN || shellEnv.ANTHROPIC_BASE_URL)
    return {
      hasConfig,
      hasApiKey: !!(shellEnv.ANTHROPIC_API_KEY || shellEnv.ANTHROPIC_AUTH_TOKEN),
      baseUrl: shellEnv.ANTHROPIC_BASE_URL || null,
    }
  }),

  /**
   * Check if user has Claude Code connected (local check)
   * Now uses multi-account system - checks for active account
   */
  getIntegration: publicProcedure.query(() => {
    const db = getDatabase()

    // First try multi-account system
    const settings = db
      .select()
      .from(anthropicSettings)
      .where(eq(anthropicSettings.id, "singleton"))
      .get()

    if (settings?.activeAccountId) {
      const account = db
        .select()
        .from(anthropicAccounts)
        .where(eq(anthropicAccounts.id, settings.activeAccountId))
        .get()

      if (account) {
        return {
          isConnected: true,
          connectedAt: account.connectedAt?.toISOString() ?? null,
          accountId: account.id,
          displayName: account.displayName,
        }
      }
    }

    // Fallback to legacy table
    const cred = db
      .select()
      .from(claudeCodeCredentials)
      .where(eq(claudeCodeCredentials.id, "default"))
      .get()

    return {
      isConnected: !!cred?.oauthToken,
      connectedAt: cred?.connectedAt?.toISOString() ?? null,
      accountId: null,
      displayName: null,
    }
  }),

  /**
   * Start Claude Code PKCE OAuth flow — mirrors `claude login` exactly.
   *
   * The CLI opens TWO URLs:
   *   - autoUrl  (redirect_uri = http://localhost:PORT/callback) → opened in browser
   *   - manualUrl (redirect_uri = https://platform.claude.com/oauth/code/callback) → shown as fallback
   *
   * We do the same: start a local callback server, open the auto URL in the browser,
   * and return the manual URL to the UI as a fallback if the browser doesn't redirect.
   */
  startAuth: publicProcedure.mutation(async () => {
    // Clean up any previous session
    oauthSessions.clear()

    const sessionId = base64url(randomBytes(16))
    const codeVerifier = generateCodeVerifier()
    const codeChallenge = generateCodeChallenge(codeVerifier)
    const state = generateState()

    // Use the existing auth server's fixed port with the /callback path.
    // The Claude Code OAuth client whitelists http://localhost:*/callback (any port, path must be /callback).
    // The /callback route is shared with MCP OAuth — each handler ignores states it doesn't own.
    const redirectUri = `http://localhost:${AUTH_SERVER_PORT}/callback`
    const autoUrl   = buildAuthUrl({ codeChallenge, state, redirectUri })
    const manualUrl = buildAuthUrl({ codeChallenge, state, redirectUri: MANUAL_REDIRECT_URI })

    oauthSessions.set(sessionId, { codeVerifier, state, redirectUri, manualUrl, autoUrl, completed: false, exchangeError: null })

    // Auto-cleanup after 15 minutes (only if not completed)
    setTimeout(() => {
      const s = oauthSessions.get(sessionId)
      if (s && !s.completed) { oauthSessions.delete(sessionId) }
    }, 15 * 60 * 1000)

    // Open the auto URL in the browser
    console.log("[ClaudeCode] Opening OAuth URL:", autoUrl)
    console.log("[ClaudeCode] Redirect URI:", redirectUri)
    shell.openExternal(autoUrl).catch(console.error)

    return { sandboxId: sessionId, sandboxUrl: "local", sessionId, autoUrl, manualUrl }
  }),

  /**
   * Poll status — checks if the auth server callback has completed the token exchange.
   * Token exchange now happens immediately in handleClaudeCodeOAuthCallback (called
   * by the auth server in index.ts), so this just reports the result.
   */
  pollStatus: publicProcedure
    .input(z.object({ sandboxUrl: z.string(), sessionId: z.string() }))
    .query(({ input }) => {
      const session = oauthSessions.get(input.sessionId)
      if (!session) {
        return { state: "error" as const, oauthUrl: null, error: "Session expired. Please try again." }
      }

      if (session.completed) {
        return { state: "success" as const, oauthUrl: session.autoUrl, error: null }
      }

      if (session.exchangeError) {
        return { state: "error" as const, oauthUrl: session.autoUrl, error: session.exchangeError }
      }

      return { state: "pending" as const, oauthUrl: session.autoUrl, manualUrl: session.manualUrl, error: null }
    }),

  /**
   * Submit OAuth code — handles both paths:
   *  1. Automatic: localhost server captured code → codePromise already resolved
   *  2. Manual fallback: user pastes "authCode#state" from the callback page
   *
   * Exchanges the auth code for an access token using PKCE and stores it.
   */
  submitCode: publicProcedure
    .input(z.object({ sandboxUrl: z.string(), sessionId: z.string(), code: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const session = oauthSessions.get(input.sessionId)
      if (!session) {
        throw new Error("Session expired. Please restart the authentication flow.")
      }

      // Parse "authCode#state" — works for both auto (localhost) and manual paste
      const raw = input.code.trim()
      const hashIdx = raw.indexOf("#")
      if (hashIdx === -1) {
        throw new Error("Invalid code — copy the full code from the browser (it contains a # character).")
      }
      const authorizationCode = raw.slice(0, hashIdx)
      const stateFromCode = raw.slice(hashIdx + 1)

      // FIX: validate state parameter to prevent CSRF attacks
      if (stateFromCode !== session.state) {
        throw new Error("State mismatch — this authentication code may have been tampered with. Please try again.")
      }

      // The redirect_uri MUST match what was sent in the auth request.
      // Try the auto redirect_uri first, then fall back to manual redirect_uri
      // (in case the user got the code from the manual URL fallback).
      type TokenResponse = { access_token: string; refresh_token?: string; expires_in?: number }
      let tokenData: TokenResponse | null = null

      const tokenRes = await fetch(ANTHROPIC_TOKEN_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: authorizationCode,
          redirect_uri: session.redirectUri,
          client_id: CLAUDE_CLIENT_ID,
          code_verifier: session.codeVerifier,
          state: session.state,
        }).toString(),
      })

      if (tokenRes.ok) {
        tokenData = await tokenRes.json() as TokenResponse
      } else {
        // Auto redirect_uri failed — retry with manual redirect_uri
        const tokenRes2 = await fetch(ANTHROPIC_TOKEN_ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            code: authorizationCode,
            redirect_uri: MANUAL_REDIRECT_URI,
            client_id: CLAUDE_CLIENT_ID,
            code_verifier: session.codeVerifier,
            state: session.state,
          }).toString(),
        })
        if (tokenRes2.ok) {
          tokenData = await tokenRes2.json() as TokenResponse
        } else {
          const errText = await tokenRes2.text().catch(() => tokenRes2.statusText)
          console.error("[ClaudeCode] Token exchange failed (both redirect URIs):", tokenRes.status, errText)
          if (tokenRes2.status === 400) {
            throw new Error("Authentication code expired or already used. Please try again.")
          } else if (tokenRes2.status === 401) {
            throw new Error("Authentication rejected. Please try again.")
          }
          throw new Error(`Token exchange failed. Please try again.`)
        }
      }

      oauthSessions.delete(input.sessionId)
      const expiresAt = tokenData.expires_in ? new Date(Date.now() + tokenData.expires_in * 1000) : undefined
      storeOAuthToken(tokenData.access_token, true, tokenData.refresh_token, expiresAt)
      console.log("[ClaudeCode] OAuth token stored")
      return { success: true }
    }),

  /**
   * Import an existing OAuth token from the local machine
   */
  importToken: publicProcedure
    .input(
      z.object({
        token: z.string().min(1),
      })
    )
    .mutation(async ({ input }) => {
      const oauthToken = input.token.trim()

      storeOAuthToken(oauthToken)

      console.log("[ClaudeCode] Token imported locally")
      return { success: true }
    }),

  /**
   * Check for existing Claude token in system credentials
   */
  getSystemToken: publicProcedure.query(() => {
    const token = getExistingClaudeToken()?.trim() ?? null
    return { token }
  }),

  /**
   * Import Claude token from system credentials
   */
  importSystemToken: publicProcedure.mutation(() => {
    // FIX: use getExistingClaudeCredentials() to preserve refresh token
    const creds = getExistingClaudeCredentials()
    if (!creds?.accessToken) {
      throw new Error("No existing Claude token found")
    }

    storeOAuthToken(creds.accessToken.trim(), true, creds.refreshToken)
    console.log("[ClaudeCode] Token imported from system")
    return { success: true }
  }),

  /**
   * Get decrypted OAuth token (local)
   * Now uses multi-account system - gets token from active account
   */
  getToken: publicProcedure.query(() => {
    const db = getDatabase()

    // First try multi-account system
    const settings = db
      .select()
      .from(anthropicSettings)
      .where(eq(anthropicSettings.id, "singleton"))
      .get()

    if (settings?.activeAccountId) {
      const account = db
        .select()
        .from(anthropicAccounts)
        .where(eq(anthropicAccounts.id, settings.activeAccountId))
        .get()

      if (account) {
        try {
          const token = decryptToken(account.oauthToken)
          return { token, error: null }
        } catch (error) {
          console.error("[ClaudeCode] Decrypt error:", error)
          return { token: null, error: "Failed to decrypt token" }
        }
      }
    }

    // Fallback to legacy table
    const cred = db
      .select()
      .from(claudeCodeCredentials)
      .where(eq(claudeCodeCredentials.id, "default"))
      .get()

    if (!cred?.oauthToken) {
      return { token: null, error: "Not connected" }
    }

    try {
      const token = decryptToken(cred.oauthToken)
      return { token, error: null }
    } catch (error) {
      console.error("[ClaudeCode] Decrypt error:", error)
      return { token: null, error: "Failed to decrypt token" }
    }
  }),

  /**
   * Disconnect - delete active account from multi-account system
   */
  disconnect: publicProcedure.mutation(() => {
    const db = getDatabase()

    // Get active account
    const settings = db
      .select()
      .from(anthropicSettings)
      .where(eq(anthropicSettings.id, "singleton"))
      .get()

    if (settings?.activeAccountId) {
      // Remove active account
      db.delete(anthropicAccounts)
        .where(eq(anthropicAccounts.id, settings.activeAccountId))
        .run()

      // Try to set another account as active
      const firstRemaining = db.select().from(anthropicAccounts).limit(1).get()

      if (firstRemaining) {
        db.update(anthropicSettings)
          .set({
            activeAccountId: firstRemaining.id,
            updatedAt: new Date(),
          })
          .where(eq(anthropicSettings.id, "singleton"))
          .run()
      } else {
        db.update(anthropicSettings)
          .set({
            activeAccountId: null,
            updatedAt: new Date(),
          })
          .where(eq(anthropicSettings.id, "singleton"))
          .run()
      }
    }

    // Also clear legacy table
    db.delete(claudeCodeCredentials)
      .where(eq(claudeCodeCredentials.id, "default"))
      .run()

    console.log("[ClaudeCode] Disconnected")
    return { success: true }
  }),

  /**
   * Open OAuth URL in browser
   */
  openOAuthUrl: publicProcedure
    .input(z.string())
    .mutation(async ({ input: url }) => {
      await shell.openExternal(url)
      return { success: true }
    }),
})
