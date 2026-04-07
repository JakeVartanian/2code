import { createHash, randomBytes } from "crypto"
import { eq } from "drizzle-orm"
import { safeStorage, shell } from "electron"
import { createServer, type Server } from "http"
import { z } from "zod"
import { getAuthManager } from "../../../index"
import { getClaudeShellEnvironment } from "../../claude"
import { getExistingClaudeToken } from "../../claude-token"
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
  port: number
  server: Server
  // Resolves with the auth code+state string once the callback is received
  codePromise: Promise<string>
  codeResolve: (code: string) => void
  codeReject: (err: Error) => void
  // The manual URL shown as fallback (displayed in the UI)
  manualUrl: string
  // The auto URL opened in the browser (uses localhost redirect)
  autoUrl: string
  // Set to the captured "code#state" string when localhost callback fires
  autoCode: string | null
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
  url.searchParams.append("scope", "user:profile user:inference user:sessions:claude_code user:mcp_servers org:create_api_key")
  url.searchParams.append("code_challenge", params.codeChallenge)
  url.searchParams.append("code_challenge_method", "S256")
  url.searchParams.append("state", params.state)
  return url.toString()
}

/**
 * Start a local HTTP server on a random port to capture the OAuth callback.
 * Returns the port once listening.
 */
function startCallbackServer(
  sessionId: string,
  expectedState: string,
  resolve: (code: string) => void,
  reject: (err: Error) => void
): Promise<{ server: Server; port: number }> {
  return new Promise((res, rej) => {
    const server = createServer((req, reqRes) => {
      try {
        const url = new URL(req.url ?? "/", `http://localhost`)
        if (url.pathname !== "/callback") {
          reqRes.writeHead(404); reqRes.end(); return
        }
        const code = url.searchParams.get("code")
        const state = url.searchParams.get("state")
        const error = url.searchParams.get("error")

        if (error) {
          reqRes.writeHead(200, { "Content-Type": "text/html" })
          reqRes.end("<html><body><h2>Authorization failed. You can close this tab.</h2></body></html>")
          server.close()
          oauthSessions.delete(sessionId)
          reject(new Error(`OAuth error: ${error}`))
          return
        }

        if (!code || state !== expectedState) {
          reqRes.writeHead(400, { "Content-Type": "text/html" })
          reqRes.end("<html><body><h2>Invalid callback. You can close this tab.</h2></body></html>")
          server.close()
          oauthSessions.delete(sessionId)
          reject(new Error("Invalid OAuth callback"))
          return
        }

        // Success — redirect browser to Anthropic's success page
        reqRes.writeHead(302, { Location: "https://platform.claude.com/oauth/code/success?app=claude-code" })
        reqRes.end()
        server.close()
        const captured = `${code}#${state}`
        // Mark the session so pollStatus can report auto-completion
        const sess = oauthSessions.get(sessionId)
        if (sess) sess.autoCode = captured
        resolve(captured)
      } catch (err) {
        reqRes.writeHead(500); reqRes.end()
      }
    })

    // Listen on OS-assigned random port (like the CLI does)
    server.listen(0, "localhost", () => {
      const addr = server.address() as { port: number }
      res({ server, port: addr.port })
    })

    server.on("error", rej)
  })
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
function storeOAuthToken(oauthToken: string, setAsActive = true, refreshToken?: string): string {
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
    for (const [, s] of oauthSessions) {
      try { s.server.close() } catch {}
    }
    oauthSessions.clear()

    const sessionId = base64url(randomBytes(16))
    const codeVerifier = generateCodeVerifier()
    const codeChallenge = generateCodeChallenge(codeVerifier)
    const state = generateState()

    // Start local callback server on a random port (OS-assigned, like the CLI)
    let codeResolve!: (v: string) => void
    let codeReject!: (e: Error) => void
    const codePromise = new Promise<string>((res, rej) => {
      codeResolve = res; codeReject = rej
    })

    const { server, port } = await startCallbackServer(sessionId, state, codeResolve, codeReject)

    const autoUrl   = buildAuthUrl({ codeChallenge, state, redirectUri: `http://localhost:${port}/callback` })
    const manualUrl = buildAuthUrl({ codeChallenge, state, redirectUri: MANUAL_REDIRECT_URI })

    oauthSessions.set(sessionId, { codeVerifier, state, port, server, codePromise, codeResolve, codeReject, manualUrl, autoUrl, autoCode: null, completed: false, exchangeError: null })

    // Auto-cleanup after 15 minutes
    setTimeout(() => {
      const s = oauthSessions.get(sessionId)
      if (s) { try { s.server.close() } catch {}; oauthSessions.delete(sessionId) }
    }, 15 * 60 * 1000)

    // Open the auto URL in the browser (same as CLI's d$($) call)
    console.log("[ClaudeCode] Opening OAuth URL:", autoUrl)
    shell.openExternal(autoUrl).catch(console.error)

    return { sandboxId: sessionId, sandboxUrl: "local", sessionId }
  }),

  /**
   * Poll status — returns the manual fallback URL immediately so the UI can
   * display it. If the localhost callback already fired, auto-exchanges the token
   * and returns state "success" so the UI completes without any user paste.
   */
  pollStatus: publicProcedure
    .input(z.object({ sandboxUrl: z.string(), sessionId: z.string() }))
    .query(async ({ input }) => {
      const session = oauthSessions.get(input.sessionId)
      if (!session) {
        return { state: "error" as const, oauthUrl: null, error: "Session expired. Please try again." }
      }

      // If localhost callback captured the code automatically, exchange it now
      if (session.autoCode) {
        const raw = session.autoCode
        session.autoCode = null // clear immediately to prevent double-exchange
        const hashIdx = raw.indexOf("#")
        if (hashIdx !== -1) {
          const authorizationCode = raw.slice(0, hashIdx)
          const tokenRes = await fetch(ANTHROPIC_TOKEN_ENDPOINT, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              grant_type: "authorization_code",
              code: authorizationCode,
              redirect_uri: `http://localhost:${session.port}/callback`,
              client_id: CLAUDE_CLIENT_ID,
              code_verifier: session.codeVerifier,
              state: session.state,
            }),
          })
          if (tokenRes.ok) {
            const tokenData = await tokenRes.json() as { access_token: string; refresh_token?: string }
            storeOAuthToken(tokenData.access_token, true, tokenData.refresh_token)
            // Mark session as completed so subsequent polls keep returning success
            session.completed = true
            console.log("[ClaudeCode] Token stored via auto localhost callback")
          } else {
            const errText = await tokenRes.text().catch(() => tokenRes.statusText)
            console.error("[ClaudeCode] Auto token exchange failed:", tokenRes.status, errText)
            session.exchangeError = `Token exchange failed (${tokenRes.status}): ${errText}`
          }
        }
      }

      // Keep returning success on subsequent polls after completion
      if (session.completed) {
        return { state: "success" as const, oauthUrl: session.autoUrl, error: null }
      }

      if (session.exchangeError) {
        return { state: "error" as const, oauthUrl: session.autoUrl, error: session.exchangeError }
      }

      // Return the auto URL — "Didn't open?" button re-opens the same localhost-redirect URL
      return { state: "pending" as const, oauthUrl: session.autoUrl, error: null }
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

      // The redirect_uri MUST match what was sent in the auth request.
      // We always open the auto URL (localhost), so always use the localhost redirect_uri.
      const tokenRes = await fetch(ANTHROPIC_TOKEN_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "authorization_code",
          code: authorizationCode,
          redirect_uri: `http://localhost:${session.port}/callback`,
          client_id: CLAUDE_CLIENT_ID,
          code_verifier: session.codeVerifier,
          state: session.state,
        }),
      })

      if (!tokenRes.ok) {
        const errText = await tokenRes.text().catch(() => tokenRes.statusText)
        console.error("[ClaudeCode] Token exchange failed:", tokenRes.status, errText)
        throw new Error(`Token exchange failed (${tokenRes.status}): ${errText}`)
      }

      const tokenData = await tokenRes.json() as { access_token: string; refresh_token?: string }

      try { session.server.close() } catch {}
      oauthSessions.delete(input.sessionId)
      storeOAuthToken(tokenData.access_token, true, tokenData.refresh_token)
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
    const token = getExistingClaudeToken()?.trim()
    if (!token) {
      throw new Error("No existing Claude token found")
    }

    storeOAuthToken(token)
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
