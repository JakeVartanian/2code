import { app, BrowserWindow, dialog, Menu, nativeImage, session } from "electron"
import { existsSync, readFileSync, readlinkSync, unlinkSync } from "fs"
import { createServer } from "http"
import { join } from "path"
import { AuthManager, initAuthManager, getAuthManager as getAuthManagerFromModule } from "./auth-manager"
import {
  checkForUpdates,
  downloadUpdate,
  initAutoUpdater,
  setupFocusUpdateCheck,
} from "./lib/auto-updater"
import { closeDatabase, initDatabase, cleanupOrphanedSessionDirs } from "./lib/db"
import { setAppReady } from "./lib/trpc/routers/app"
import {
  getLaunchDirectory,
  isCliInstalled,
  installCli,
  uninstallCli,
  parseLaunchDirectory,
} from "./lib/cli"
import { cleanupGitWatchers } from "./lib/git/watcher"
import { cancelAllPendingOAuth, handleMcpOAuthCallback } from "./lib/mcp-auth"
import { getAllMcpConfigHandler, hasActiveClaudeSessions, abortAllClaudeSessions } from "./lib/trpc/routers/claude"
import {
  createMainWindow,
  createWindow,
  getWindow,
  getAllWindows,
  setIsQuitting,
} from "./windows/main"
import { windowManager } from "./windows/window-manager"

import { IS_DEV, AUTH_SERVER_PORT } from "./constants"

// Deep link protocol (must match package.json build.protocols.schemes)
// Use different protocol in dev to avoid conflicts with production app
const PROTOCOL = IS_DEV ? "2code-dev" : "2code"

// Set dev mode userData path BEFORE requestSingleInstanceLock()
// This ensures dev and prod have separate instance locks
if (IS_DEV) {
  const { join } = require("path")
  const devUserData = join(app.getPath("userData"), "..", "2Code Dev")
  app.setPath("userData", devUserData)
  console.log("[Dev] Using separate userData path:", devUserData)
}

// Increase V8 old-space limit for renderer/main processes to reduce OOM frequency
// under heavy multi-chat workloads. Must be set before app readiness/window creation.
app.commandLine.appendSwitch("js-flags", "--max-old-space-size=8192")


// URL configuration (exported for use in other modules)
// In packaged app, ALWAYS use production URL to prevent localhost leaking into releases
// In dev mode, allow override via MAIN_VITE_API_URL env variable
export function getBaseUrl(): string {
  if (app.isPackaged) {
    return "https://github.com/JakeVartanian/2code"
  }
  return import.meta.env.MAIN_VITE_API_URL || "https://github.com/JakeVartanian/2code"
}

export function getAppUrl(): string {
  return process.env.ELECTRON_RENDERER_URL || "https://github.com/JakeVartanian/2code"
}

// Auth manager singleton (use the one from auth-manager module)
let authManager: AuthManager

export function getAuthManager(): AuthManager {
  // First try to get from module, fallback to local variable for backwards compat
  return getAuthManagerFromModule() || authManager
}

// Handle auth code from deep link (exported for IPC handlers)
export async function handleAuthCode(code: string): Promise<void> {
  console.log("[Auth] Handling auth code:", code.slice(0, 8) + "...")

  try {
    const authData = await authManager.exchangeCode(code)
    console.log("[Auth] Success for user:", authData.user.email)

    // Set desktop token cookie using persist:main partition
    const ses = session.fromPartition("persist:main")
    try {
      // First remove any existing cookie to avoid HttpOnly conflict
      await ses.cookies.remove(getBaseUrl(), "x-desktop-token")
      await ses.cookies.set({
        url: getBaseUrl(),
        name: "x-desktop-token",
        value: authData.token,
        expirationDate: Math.floor(
          new Date(authData.expiresAt).getTime() / 1000,
        ),
        httpOnly: false,
        secure: getBaseUrl().startsWith("https"),
        sameSite: "lax" as const,
      })
      console.log("[Auth] Desktop token cookie set")
    } catch (cookieError) {
      // Cookie setting is optional - auth data is already saved to disk
      console.warn("[Auth] Cookie set failed (non-critical):", cookieError)
    }

    // Notify all windows and reload them to show app
    const windows = getAllWindows()
    for (const win of windows) {
      try {
        if (win.isDestroyed()) continue
        win.webContents.send("auth:success", authData.user)

        // Use stable window ID (main, window-2, etc.) instead of Electron's numeric ID
        const stableId = windowManager.getStableId(win)

        if (process.env.ELECTRON_RENDERER_URL) {
          // Pass window ID via query param for dev mode
          const url = new URL(process.env.ELECTRON_RENDERER_URL)
          url.searchParams.set("windowId", stableId)
          win.loadURL(url.toString())
        } else {
          // Pass window ID via hash for production
          win.loadFile(join(__dirname, "../renderer/index.html"), {
            hash: `windowId=${stableId}`,
          })
        }
      } catch (error) {
        // Window may have been destroyed during iteration
        console.warn("[Auth] Failed to reload window:", error)
      }
    }
    // Focus the first window
    windows[0]?.focus()
  } catch (error) {
    console.error("[Auth] Exchange failed:", error)
    // Broadcast auth error to all windows (not just focused)
    for (const win of getAllWindows()) {
      try {
        if (!win.isDestroyed()) {
          win.webContents.send("auth:error", (error as Error).message)
        }
      } catch {
        // Window destroyed during iteration
      }
    }
  }
}

// Handle deep link
function handleDeepLink(url: string): void {
  console.log("[DeepLink] Received:", url)

  try {
    const parsed = new URL(url)

    // Handle auth callback: 2code://auth?code=xxx
    if (parsed.pathname === "/auth" || parsed.host === "auth") {
      const code = parsed.searchParams.get("code")
      if (code) {
        handleAuthCode(code).catch((err) => console.error("[Auth] handleAuthCode failed:", err))
        return
      }
    }

    // Handle MCP OAuth callback: 2code://mcp-oauth?code=xxx&state=yyy
    if (parsed.pathname === "/mcp-oauth" || parsed.host === "mcp-oauth") {
      const code = parsed.searchParams.get("code")
      const state = parsed.searchParams.get("state")
      if (code && state) {
        handleMcpOAuthCallback(code, state).catch((err) => console.error("[Auth] MCP OAuth callback failed:", err))
        return
      }
    }
  } catch (e) {
    console.error("[DeepLink] Failed to parse:", e)
  }
}

// Register protocol BEFORE app is ready
console.log("[Protocol] ========== PROTOCOL REGISTRATION ==========")
console.log("[Protocol] Protocol:", PROTOCOL)
console.log("[Protocol] Is dev mode (process.defaultApp):", process.defaultApp)
console.log("[Protocol] process.execPath:", process.execPath)
console.log("[Protocol] process.argv:", process.argv)

/**
 * Register the app as the handler for our custom protocol.
 * On macOS, this may not take effect immediately on first install -
 * Launch Services caches protocol handlers and may need time to update.
 */
function registerProtocol(): boolean {
  let success = false

  if (process.defaultApp) {
    // Dev mode: need to pass execPath and script path
    if (process.argv.length >= 2) {
      success = app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [
        process.argv[1]!,
      ])
      console.log(
        `[Protocol] Dev mode registration:`,
        success ? "success" : "failed",
      )
    } else {
      console.warn("[Protocol] Dev mode: insufficient argv for registration")
    }
  } else {
    // Production mode
    success = app.setAsDefaultProtocolClient(PROTOCOL)
    console.log(
      `[Protocol] Production registration:`,
      success ? "success" : "failed",
    )
  }

  return success
}

// Store initial registration result (set in app.whenReady())
let initialRegistration = false

// Verify registration (this checks if OS recognizes us as the handler)
function verifyProtocolRegistration(): void {
  const isDefault = process.defaultApp
    ? app.isDefaultProtocolClient(PROTOCOL, process.execPath, [
        process.argv[1]!,
      ])
    : app.isDefaultProtocolClient(PROTOCOL)

  console.log(`[Protocol] Verification - isDefaultProtocolClient: ${isDefault}`)

  if (!isDefault && initialRegistration) {
    console.warn(
      "[Protocol] Registration returned success but verification failed.",
    )
    console.warn(
      "[Protocol] This is common on first install - macOS Launch Services may need time to update.",
    )
    console.warn("[Protocol] The protocol should work after app restart.")
  }
}

console.log("[Protocol] =============================================")

// Note: app.on("open-url") will be registered in app.whenReady()

// PNG favicon as base64 data URI for auth callback pages (new chip logo)
const FAVICON_PNG_BASE64 = `iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAGYktHRAD/AP8A/6C9p5MAAAAHdElNRQfqBAcFDTn/PDiTAAAAEnRFWHRBdXRob3IAamFja2ZydXRhY2858coVAAAAK3RFWHRDcmVhdGlvbiBUaW1lAFR1ZSwgMDcgQXByIDIwMjYgMDU6MDI6MjcgR01UsWMR9QAAACV0RVh0ZGF0ZTpjcmVhdGUAMjAyNi0wNC0wN1QwNTowODo0NCswMDowMBQBEOsAAAAldEVYdGRhdGU6bW9kaWZ5ADIwMjYtMDQtMDdUMDU6MDg6NDQrMDA6MDBlXKhXAAAAKHRFWHRkYXRlOnRpbWVzdGFtcAAyMDI2LTA0LTA3VDA1OjEzOjU3KzAwOjAw9mW3vAAAAIV0RVh0RGVzY3JpcHRpb24AaHR0cHM6Ly9zLm1qLnJ1bi8xajFaSjA5UHNpMCBtYWtlIHRoaXMgYSBjbGVhbiBsb2dvIHdpdGggbm8gYmFja2dyb3VuZCAtLXYgNyBKb2IgSUQ6IDNkYWMxZmIzLWQxOWMtNGM3Ni04ZjY5LTFlMjZlM2RjNDg1N3rqTRUAAAFrelRYdFhNTDpjb20uYWRvYmUueG1wAAAokW1Ry26DMBC85yss92zMKw8QJKpC2uZAVTWp2quxN8RKeAicQPL1NQRxqOqTxzs7O94JVm3J+AkUSiCVeYgxkiLE39PYjMs1HOXbvYLd/X3P7yfuCbxaToLWb7MyA8VQm53z2m9DzESRgK/v3TPFqKeoU4h/4g+0LipAruEaJtm08mrj5QQFlTj4n9HLIKFRiI9KlT6lTdMYjWMUVUotz/OoaVPbJppB6luuWEvy+qmTeGhEUPNKlkoWOeowS4qL0t/QdTSI6yrftGoc0OFevlaCbjVwtVlNoLZpLohpE9ujff/Q6Ecy3WYshdevbRRiRzBuHRKHCMvjxOXzGVkcZh6xwJ6BI7i7mM7/tkvFzrviUnHY30oYnfCrMZrJoal5IaCm4sGve77SfKoqJnMQz+e0qKQ6ZpLHICTDtNskHVapk6FjNMvJ/ycY84Zc59zoQH8B9PyhVWLLLAQAAAebSURBVFjD7dZZbFxnFQfw//d9d925s8/YYzve4jirm9h1myZRlKVFVWg2qoaqLUmKBJVAIIrCC5WKWsELCIkXAjwgaJBSRRVSBS0FFBKoE6KQxomdxGM7drzN2GN7Ynv2mbt/PJgHmuCaNx7Iefx07zm/e46+ows8iv/3IKs9kLjRh/mZSVBFBKMEhqGDuy58fg3+SByZmQlkc0V4FBkSU+CCgFEX3LFRcjhkScSzzz3/3wN6LvVg546dqOo6FEXB8GACXBeJozEiuFWkx0bAKUPTke38PfIVLh2O4s0PzuF639/pk127+b+l4rbtwLIs2I4NVVFxvfc6du3c+dkAXTdAKUGlWg15vZ7NyeRYZuJO3xoR6JBlZim+YAmuLdOCbbJ7i++PfevLZePHPzoU2diwMTWabAkwZlHd9Ir+2sLeEy9dpKJU1g0zIUvyYrVSQTgS/lQ94UFAqVSEadksGgn/QK84ryVuTv/5/KXU/fpNax+zTW4ujA260cZw2ROJs0K0a9fSL64YckprXTdlREZLhce8fo+fKxpqSy7iE/lvNq0JIuj3nk2mpr8uy5L1YL2HARUDzY31nnd+9cvu0f6UxBa9h6WObZzTdjqQuIxbY1NoCUd5PWVYuHuNmGYZcRG8zb+Zp5ZytGEKYG3NGNGrGPjNZXnnvg68cGBrd0MsoJVNnl0V8MnlCxgO+qITA0N11z4ZR1NgDXl5RiX91I+5Qh7lUgmTl0fINJlAVV8EtQrIra0hw7XD5FU9iKPjAj4sDeDGMxuhLhH8/to4CMk2tMiVloqN1QGkVIBp6V6PIBq+aEMWQih0ZdLCSPoSwhEZ7Xu3QxBEEAAVPY6BwTGkkzrksV64/k0Ifn472q0SJhL/QE1DF8wKxeTQpN/XKEcNi2NVAJdtWMxi/vrwndAEpcn02PPnM0UcOrgLP3njJGKxEAgBwAGXc1zs6cOp7/4UlcVFeE8egOcbe1DTH0PPV/+KbnU9/AE/fIxR2TYk4rgPAeiDB7JEoKqCVi3kn9bTU88hOwOZz+KVY/tRF49AYBSG7sJxAFFgeKKzHfGQB7Zrgvuk5SSSgDwxMaNKyOlVEDBK1IAM2bd6B0zdAmyizBZLSo2kypqoYYrY0DQNAHBvLo+fvd+P5rgPXzuyDQSAyFQI1AvuLH8PYwxMENGpF0EkAZajUoExyWFYHTDycQ9kSZgf6h3LF/wbVCgCqC6CseW3xxay6C2mkaZefEnfBIEw+GkQARoB48sdEEQRTFYxHq1DlGvYMVm5gep0r2uaqwNGPxyHppN7sY691w3cP1x0DbBIHIK8nLwws4TUhSHQ+gjsYxa8goi9vjasD/rQJASXk3o88LRvQKbsQqgNYKCmbvw7p7547/hTv10d8NT3X4BI7LYLN7R47bgBElMhPdkJ2bc8ArOYRTk1DJ3UgTs2FJ8HX9i3FUZjGaHWBgCA4vOi+eA+WKkqZpMpiBprHbptbqZntwxuOPc2vvfW2/8Z8NG7ryOTU0CJubM2km8uTyu5bZQFH/doiEkiAMCxdXAzD1heEO6CygLqX+yAu8DBGpY3ux8OXrQykMwYhmgLss54SzGb6abl4uDEbHHlW3D29Gl4vRSqzN12GVNZj5u/nZ7FjT/dgl5d3qIudwFYMC0dxr9mSsMEwnoK4l0GzE4t4s65BEb7k1iyCpCZ7IKKqih60LlWW3kE3c/sx2LJgZfaQcsw6yzV469SjnR5DuXhNOCqsEczCAsSctkC3jn7B5x8+RACwQgIW+7QZHIWPz/zN/QvmahvZCCqbu2R1PlwuMaura1HX7RuZYCfhSFIXoiWrmazZtBfgPZ4ZAv2mEHQNy8jL9+Gjgy01s1wXR0XLyVw924BDVsPQwrUg3AX1/o+xuTcFBprQlgfi6LeF61Sa8KqZrOBCq1BWCivDDBsCTEUUCgXBae0oFHdQIO3G8RTg3mziHx1Ac5WP7q6NkC0bAi5EuQqh2wXQIoUlWoO8XUqIhvWomXegxbdwUAlxVQx77t2MSHfT/4RnZ9btzLAthX09CchM+dmbyZnxjp2S1en5tDnE7C7aTOS+WEMJHvwtNGCmR37cc/MIru4AL8WQ5dPxvmhiwiZSzgQaMfvFmZA8gUE165hx08dUaXi/IgWCEFziysDmhoL+MsFQJZka7FoUG3mPu4zCZGoB1eFDHRNBYluQkIL8Gq+AiJ5SFSIYq6UxZVshmcJJXqV4aNyEg4xEG4N4eChbqVtTV0j5TWKIIh469snPgV46I/oyLHjkERhy/jU3LuVqtUY8/rx0tH9mlfj1C3YcCwXYo1vTorWD34wXEq0Xy0i3mF328HCRlkww4Io8qplgdsEO549qj/RudV1HWdG140TgsBuKory2Yuoc8durGtrGfz1mfcOUd0KbYzFxY5ab6uLJYnDdB0mQw1Zpkrnps+98dr1H57LYH3uTBfzo1lRvYIDDtNhRCQSbwwp6Ww2p1NKFm7d7k9FI7HVN+HSfBqjeo5z150G59MVw4Ljqje5oMLlDI4rwGUe2IoPiZtXkHvldVinX+0Dcfs4o3C5DdMCiCDCpRIoJaCEoKmxGYLwULlH8Sj+9/FPIkxXDM5Ri08AAAAASUVORK5CYII=`
const FAVICON_DATA_URI = `data:image/png;base64,${FAVICON_PNG_BASE64}`

// Start local HTTP server for auth callbacks
// This catches http://localhost:{AUTH_SERVER_PORT}/auth/callback?code=xxx and /callback (for MCP OAuth)
const server = createServer((req, res) => {
    const url = new URL(req.url || "", `http://localhost:${AUTH_SERVER_PORT}`)

    // Serve favicon
    if (url.pathname === "/favicon.ico" || url.pathname === "/favicon.svg" || url.pathname === "/favicon.png") {
      const faviconBuffer = Buffer.from(FAVICON_PNG_BASE64, "base64")
      res.writeHead(200, { "Content-Type": "image/png", "Content-Length": faviconBuffer.length })
      res.end(faviconBuffer)
      return
    }

    if (url.pathname === "/auth/callback") {
      const code = url.searchParams.get("code")
      console.log(
        "[Auth Server] Received callback with code:",
        code?.slice(0, 8) + "...",
      )

      if (code) {
        // Handle the auth code
        handleAuthCode(code).catch((err) => console.error("[Auth Server] handleAuthCode failed:", err))

        // Send success response and close the browser tab
        res.writeHead(200, { "Content-Type": "text/html" })
        res.end(`<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <link rel="icon" type="image/png" href="${FAVICON_DATA_URI}">
  <title>2Code - Authentication</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    :root {
      --bg: #09090b;
      --text: #fafafa;
      --text-muted: #71717a;
    }
    @media (prefers-color-scheme: light) {
      :root {
        --bg: #ffffff;
        --text: #09090b;
        --text-muted: #71717a;
      }
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      background: var(--bg);
      color: var(--text);
    }
    .container {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 8px;
    }
    .logo {
      width: 24px;
      height: 24px;
      margin-bottom: 8px;
    }
    h1 {
      font-size: 14px;
      font-weight: 500;
      margin-bottom: 4px;
    }
    p {
      font-size: 12px;
      color: var(--text-muted);
    }
  </style>
</head>
<body>
  <div class="container">
    <svg class="logo" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path fill-rule="evenodd" clip-rule="evenodd" d="M14.3333 0C15.2538 0 16 0.746192 16 1.66667V11.8333C16 11.9254 15.9254 12 15.8333 12H10.8333C10.7413 12 10.6667 12.0746 10.6667 12.1667V15.8333C10.6667 15.9254 10.592 16 10.5 16H1.66667C0.746192 16 0 15.2538 0 14.3333V12.1888C0 12.0717 0.0617409 11.9632 0.162081 11.903L6.15043 8.30986C6.28644 8.22833 6.24077 8.02716 6.09507 8.00256L6.06511 8H0.166667C0.0746186 8 0 7.92538 0 7.83333V4.16667C0 4.07462 0.0746193 4 0.166667 4H6.5C6.59205 4 6.66667 3.92538 6.66667 3.83333V0.166667C6.66667 0.0746193 6.74129 0 6.83333 0H14.3333ZM6.83333 4C6.74129 4 6.66667 4.07462 6.66667 4.16667V11.8333C6.66667 11.9254 6.74129 12 6.83333 12H10.5C10.592 12 10.6667 11.9254 10.6667 11.8333V4.16667C10.6667 4.07462 10.592 4 10.5 4H6.83333Z" fill="#0033FF"/>
    </svg>
    <h1>Authentication successful</h1>
    <p>You can close this tab</p>
  </div>
  <script>setTimeout(() => window.close(), 1000)</script>
</body>
</html>`)
      } else {
        res.writeHead(400, { "Content-Type": "text/plain" })
        res.end("Missing code parameter")
      }
    } else if (url.pathname === "/callback") {
      // Shared callback for both MCP OAuth and Claude Code OAuth.
      // Each handler looks up the state in its own in-memory map and ignores unknown states.
      const code = url.searchParams.get("code")
      const state = url.searchParams.get("state")
      const error = url.searchParams.get("error")

      if (error) {
        console.error("[Auth Server] OAuth error:", error)
        res.writeHead(200, { "Content-Type": "text/html" })
        res.end(`<!DOCTYPE html><html><head><title>2Code</title></head><body style="font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;background:#09090b;color:#fafafa"><div style="text-align:center"><h2>Authorization failed</h2><p style="color:#71717a">You can close this tab</p></div></body></html>`)
        return
      }

      console.log(
        "[Auth Server] /callback received, code:",
        code?.slice(0, 8) + "...",
        "state:",
        state?.slice(0, 8) + "...",
      )

      if (code && state) {
        // Try MCP OAuth first (sync map lookup, fire-and-forget)
        handleMcpOAuthCallback(code, state).catch((err) => console.error("[Auth Server] MCP OAuth callback failed:", err))
        // Try Claude Code OAuth (dynamic import to avoid circular dep)
        import("./lib/trpc/routers/claude-code").then(mod => {
          mod.handleClaudeCodeOAuthCallback(code, state).catch(err =>
            console.error("[Auth Server] Claude Code token exchange failed:", err)
          )
        }).catch(err => console.error("[Auth Server] Failed to load claude-code module:", err))

        // Send success page immediately (token exchanges happen async)
        res.writeHead(200, { "Content-Type": "text/html" })
        res.end(`<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <link rel="icon" type="image/png" href="${FAVICON_DATA_URI}">
  <title>2Code - MCP Authentication</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    :root {
      --bg: #09090b;
      --text: #fafafa;
      --text-muted: #71717a;
    }
    @media (prefers-color-scheme: light) {
      :root {
        --bg: #ffffff;
        --text: #09090b;
        --text-muted: #71717a;
      }
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      background: var(--bg);
      color: var(--text);
    }
    .container {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 8px;
    }
    .logo {
      width: 24px;
      height: 24px;
      margin-bottom: 8px;
    }
    h1 {
      font-size: 14px;
      font-weight: 500;
      margin-bottom: 4px;
    }
    p {
      font-size: 12px;
      color: var(--text-muted);
    }
  </style>
</head>
<body>
  <div class="container">
    <svg class="logo" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path fill-rule="evenodd" clip-rule="evenodd" d="M14.3333 0C15.2538 0 16 0.746192 16 1.66667V11.8333C16 11.9254 15.9254 12 15.8333 12H10.8333C10.7413 12 10.6667 12.0746 10.6667 12.1667V15.8333C10.6667 15.9254 10.592 16 10.5 16H1.66667C0.746192 16 0 15.2538 0 14.3333V12.1888C0 12.0717 0.0617409 11.9632 0.162081 11.903L6.15043 8.30986C6.28644 8.22833 6.24077 8.02716 6.09507 8.00256L6.06511 8H0.166667C0.0746186 8 0 7.92538 0 7.83333V4.16667C0 4.07462 0.0746193 4 0.166667 4H6.5C6.59205 4 6.66667 3.92538 6.66667 3.83333V0.166667C6.66667 0.0746193 6.74129 0 6.83333 0H14.3333ZM6.83333 4C6.74129 4 6.66667 4.07462 6.66667 4.16667V11.8333C6.66667 11.9254 6.74129 12 6.83333 12H10.5C10.592 12 10.6667 11.9254 10.6667 11.8333V4.16667C10.6667 4.07462 10.592 4 10.5 4H6.83333Z" fill="#0033FF"/>
    </svg>
    <h1>Authentication successful</h1>
    <p>You can close this tab and return to 2Code</p>
  </div>
  <script>setTimeout(() => window.close(), 1000)</script>
</body>
</html>`)
      } else {
        res.writeHead(400, { "Content-Type": "text/plain" })
        res.end("Missing code or state parameter")
      }
    } else {
      res.writeHead(404, { "Content-Type": "text/plain" })
      res.end("Not found")
    }
  })

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.warn(`[Auth Server] Port ${AUTH_SERVER_PORT} already in use — auth callbacks will use deep links only`)
  } else {
    console.error("[Auth Server] Failed to start:", err)
  }
})

server.listen(AUTH_SERVER_PORT, () => {
  console.log(`[Auth Server] Listening on http://localhost:${AUTH_SERVER_PORT}`)
})

// Clean up stale lock files from crashed instances
// Returns true if locks were cleaned, false otherwise
function cleanupStaleLocks(): boolean {
  const userDataPath = app.getPath("userData")
  const lockPath = join(userDataPath, "SingletonLock")

  if (!existsSync(lockPath)) return false

  try {
    // SingletonLock is a symlink like "hostname-pid"
    const lockTarget = readlinkSync(lockPath)
    const match = lockTarget.match(/-(\d+)$/)
    if (match) {
      const pid = parseInt(match[1], 10)
      try {
        // Check if process is running (signal 0 doesn't kill, just checks)
        process.kill(pid, 0)
        // Process exists, lock is valid
        console.log("[App] Lock held by running process:", pid)
        return false
      } catch {
        // Process doesn't exist, clean up stale locks
        console.log("[App] Cleaning stale locks (pid", pid, "not running)")
        const filesToRemove = ["SingletonLock", "SingletonSocket", "SingletonCookie"]
        for (const file of filesToRemove) {
          const filePath = join(userDataPath, file)
          if (existsSync(filePath)) {
            try {
              unlinkSync(filePath)
            } catch (e) {
              console.warn("[App] Failed to remove", file, e)
            }
          }
        }
        return true
      }
    }
  } catch (e) {
    console.warn("[App] Failed to check lock file:", e)
  }
  return false
}

// Prevent multiple instances
let gotTheLock = app.requestSingleInstanceLock()

if (!gotTheLock) {
  // Maybe stale lock - try cleanup and retry once
  const cleaned = cleanupStaleLocks()
  if (cleaned) {
    gotTheLock = app.requestSingleInstanceLock()
  }
  if (!gotTheLock) {
    app.quit()
  }
}

if (gotTheLock) {
  // Handle second instance launch (also handles deep links on Windows/Linux)
  app.on("second-instance", (_event, commandLine) => {
    // Check for deep link in command line args
    const url = commandLine.find((arg) => arg.startsWith(`${PROTOCOL}://`))
    if (url) {
      handleDeepLink(url)
    }

    // Focus on the first available window
    const windows = getAllWindows()
    if (windows.length > 0) {
      const window = windows[0]!
      if (window.isMinimized()) window.restore()
      window.focus()
    } else {
      // No windows open, create a new one
      createMainWindow()
    }
  })

  // App ready
  app.whenReady().then(async () => {
    // Set dev mode app name (userData path was already set before requestSingleInstanceLock)
    // if (IS_DEV) {
    //   app.name = "Agents Dev"
    // }


    // Register protocol handler (must be after app is ready)
    initialRegistration = registerProtocol()

    // Handle deep link on macOS (app already running)
    app.on("open-url", (event, url) => {
      console.log("[Protocol] open-url event received:", url)
      event.preventDefault()
      handleDeepLink(url)
    })

    // Set app user model ID for Windows (different in dev to avoid taskbar conflicts)
    if (process.platform === "win32") {
      app.setAppUserModelId(IS_DEV ? "dev.jakev.2code.dev" : "dev.jakev.2code")
    }

    console.log(`[App] Starting 2Code${IS_DEV ? " (DEV)" : ""}...`)

    // Verify protocol registration after app is ready
    // This helps diagnose first-install issues where the protocol isn't recognized yet
    verifyProtocolRegistration()

    // Get Claude Code version for About panel
    let claudeCodeVersion = "unknown"
    try {
      const isDev = !app.isPackaged
      const versionPath = isDev
        ? join(app.getAppPath(), "resources/bin/VERSION")
        : join(process.resourcesPath, "bin/VERSION")

      if (existsSync(versionPath)) {
        const versionContent = readFileSync(versionPath, "utf-8")
        claudeCodeVersion = versionContent.split("\n")[0]?.trim() || "unknown"
      }
    } catch (error) {
      console.warn("[App] Failed to read Claude Code version:", error)
    }

    // Set About panel options with Claude Code version
    app.setAboutPanelOptions({
      applicationName: "2Code",
      applicationVersion: app.getVersion(),
      version: `Claude Code ${claudeCodeVersion}`,
      copyright: "Copyright © 2026 jakev",
    })

    // Track update availability for menu
    let updateAvailable = false
    let availableVersion: string | null = null
    // Track devtools unlock state (hidden feature - 5 clicks on Beta tab)
    let devToolsUnlocked = false

    // Menu icons: PNG template for settings (auto light/dark via "Template" suffix),
    // macOS native SF Symbol for terminal
    const settingsMenuIcon = nativeImage.createFromPath(
      join(__dirname, "../../build/settingsTemplate.png")
    )
    const terminalMenuIcon = process.platform === "darwin"
      ? nativeImage.createFromNamedImage("terminal")?.resize({ width: 12, height: 12 })
      : null

    // Function to build and set application menu
    const buildMenu = () => {
      // Show devtools menu item only in dev mode or when unlocked
      const showDevTools = !app.isPackaged || devToolsUnlocked
      const template: Electron.MenuItemConstructorOptions[] = [
        {
          label: app.name,
          submenu: [
            {
              label: "About 2Code",
              click: () => app.showAboutPanel(),
            },
            {
              label: updateAvailable
                ? `Update to v${availableVersion}...`
                : "Check for Updates...",
              click: () => {
                // Send event to renderer to clear dismiss state
                const win = getWindow()
                if (win) {
                  win.webContents.send("update:manual-check")
                }
                // If update is already available, start downloading immediately
                if (updateAvailable) {
                  downloadUpdate()
                } else {
                  checkForUpdates(true)
                }
              },
            },
            { type: "separator" },
            {
              label: "Settings...",
              ...(settingsMenuIcon && { icon: settingsMenuIcon }),
              accelerator: "CmdOrCtrl+,",
              click: () => {
                const win = getWindow()
                if (win) {
                  win.webContents.send("shortcut:open-settings")
                }
              },
            },
            { type: "separator" },
            {
              label: isCliInstalled()
                ? "Uninstall '2code' Command..."
                : "Install '2code' Command in PATH...",
              ...(terminalMenuIcon && { icon: terminalMenuIcon }),
              click: async () => {
                const { dialog } = await import("electron")
                if (isCliInstalled()) {
                  const result = await uninstallCli()
                  if (result.success) {
                    dialog.showMessageBox({
                      type: "info",
                      message: "CLI command uninstalled",
                      detail: "The '2code' command has been removed from your PATH.",
                    })
                    buildMenu()
                  } else {
                    dialog.showErrorBox("Uninstallation Failed", result.error || "Unknown error")
                  }
                } else {
                  const result = await installCli()
                  if (result.success) {
                    dialog.showMessageBox({
                      type: "info",
                      message: "CLI command installed",
                      detail:
                        "You can now use '2code .' in any terminal to open 2Code in that directory.",
                    })
                    buildMenu()
                  } else {
                    dialog.showErrorBox("Installation Failed", result.error || "Unknown error")
                  }
                }
              },
            },
            { type: "separator" },
            { role: "services" },
            { type: "separator" },
            { role: "hide" },
            { role: "hideOthers" },
            { role: "unhide" },
            { type: "separator" },
            {
              label: "Quit",
              accelerator: "CmdOrCtrl+Q",
              click: async () => {
                if (hasActiveClaudeSessions()) {
                  const { dialog } = await import("electron")
                  const { response } = await dialog.showMessageBox({
                    type: "warning",
                    buttons: ["Cancel", "Quit Anyway"],
                    defaultId: 0,
                    cancelId: 0,
                    title: "Active Sessions",
                    message: "There are active agent sessions running.",
                    detail: "Quitting now will interrupt them. Are you sure you want to quit?",
                  })
                  if (response === 1) {
                    abortAllClaudeSessions()
                    setIsQuitting(true)
                    app.quit()
                  }
                } else {
                  app.quit()
                }
              },
            },
          ],
        },
        {
          label: "File",
          submenu: [
            {
              label: "New Chat",
              accelerator: "CmdOrCtrl+N",
              click: () => {
                console.log("[Menu] New Chat clicked (Cmd+N)")
                const win = getWindow()
                if (win) {
                  console.log("[Menu] Sending shortcut:new-agent to renderer")
                  win.webContents.send("shortcut:new-agent")
                } else {
                  console.log("[Menu] No window found!")
                }
              },
            },
            {
              label: "New Window",
              accelerator: "CmdOrCtrl+Shift+N",
              click: () => {
                console.log("[Menu] New Window clicked (Cmd+Shift+N)")
                createWindow()
              },
            },
            { type: "separator" },
            {
              label: "Close Window",
              accelerator: "CmdOrCtrl+W",
              click: () => {
                const win = getWindow()
                if (win) {
                  win.close()
                }
              },
            },
          ],
        },
        {
          label: "Edit",
          submenu: [
            { role: "undo" },
            { role: "redo" },
            { type: "separator" },
            { role: "cut" },
            { role: "copy" },
            { role: "paste" },
            { role: "selectAll" },
          ],
        },
        {
          label: "View",
          submenu: [
            // Cmd+R is disabled to prevent accidental page refresh
            // Cmd+Shift+R reloads but warns if there are active streams
            {
              label: "Force Reload",
              accelerator: "CmdOrCtrl+Shift+R",
              click: () => {
                const win = BrowserWindow.getFocusedWindow()
                if (!win) return
                if (hasActiveClaudeSessions()) {
                  dialog
                    .showMessageBox(win, {
                      type: "warning",
                      buttons: ["Cancel", "Reload Anyway"],
                      defaultId: 0,
                      cancelId: 0,
                      title: "Active Sessions",
                      message: "There are active agent sessions running.",
                      detail:
                        "Reloading will interrupt them. The current progress will be saved. Are you sure you want to reload?",
                    })
                    .then(({ response }) => {
                      if (response === 1) {
                        abortAllClaudeSessions()
                        win.webContents.reloadIgnoringCache()
                      }
                    })
                } else {
                  win.webContents.reloadIgnoringCache()
                }
              },
            },
            // Only show DevTools in dev mode or when unlocked via hidden feature
            ...(showDevTools ? [{ role: "toggleDevTools" as const }] : []),
            { type: "separator" },
            { role: "resetZoom" },
            { role: "zoomIn" },
            { role: "zoomOut" },
            { type: "separator" },
            { role: "togglefullscreen" },
          ],
        },
        {
          label: "Window",
          submenu: [
            { role: "minimize" },
            { role: "zoom" },
            { type: "separator" },
            { role: "front" },
          ],
        },
        {
          role: "help",
          submenu: [
            {
              label: "Learn More",
              click: async () => {
                const { shell } = await import("electron")
                await shell.openExternal("https://github.com/JakeVartanian/2code")
              },
            },
          ],
        },
      ]
      Menu.setApplicationMenu(Menu.buildFromTemplate(template))
    }

    // macOS: Set dock menu (right-click on dock icon)
    if (process.platform === "darwin") {
      const dockMenu = Menu.buildFromTemplate([
        {
          label: "New Window",
          click: () => {
            console.log("[Dock] New Window clicked")
            createWindow()
          },
        },
      ])
      app.dock.setMenu(dockMenu)
    }

    // Set update state and rebuild menu
    const setUpdateAvailable = (available: boolean, version?: string) => {
      updateAvailable = available
      availableVersion = version || null
      buildMenu()
    }

    // Unlock devtools and rebuild menu (called from renderer via IPC)
    const unlockDevTools = () => {
      if (!devToolsUnlocked) {
        devToolsUnlocked = true
        console.log("[App] DevTools unlocked via hidden feature")
        buildMenu()
      }
    }

    // Expose setUpdateAvailable globally for auto-updater
    ;(global as any).__setUpdateAvailable = setUpdateAvailable
    // Expose unlockDevTools globally for IPC handler
    ;(global as any).__unlockDevTools = unlockDevTools

    // Build initial menu
    buildMenu()

    // Initialize auth manager (uses singleton from auth-manager module)
    authManager = initAuthManager(!!process.env.ELECTRON_RENDERER_URL)
    console.log("[App] Auth manager initialized")

    // Set up callback to update cookie when token is refreshed
    authManager.setOnTokenRefresh(async (authData) => {
      console.log("[Auth] Token refreshed, updating cookie...")
      const ses = session.fromPartition("persist:main")
      try {
        await ses.cookies.set({
          url: getBaseUrl(),
          name: "x-desktop-token",
          value: authData.token,
          expirationDate: Math.floor(
            new Date(authData.expiresAt).getTime() / 1000,
          ),
          httpOnly: false,
          secure: getBaseUrl().startsWith("https"),
          sameSite: "lax" as const,
        })
        console.log("[Auth] Desktop token cookie updated after refresh")
      } catch (err) {
        console.error("[Auth] Failed to update cookie:", err)
      }
    })

    // Initialize database
    try {
      initDatabase()
      console.log("[App] Database initialized")
      // Clean up orphaned session directories in background (non-blocking)
      cleanupOrphanedSessionDirs()
    } catch (error) {
      console.error("[App] Failed to initialize database:", error)
    }

    // Create main window
    createMainWindow()

    // Signal renderer that main process is fully initialized
    setAppReady()

    // Initialize auto-updater (production only)
    if (app.isPackaged) {
      await initAutoUpdater(getAllWindows)
      // Setup update check on window focus (instead of periodic interval)
      setupFocusUpdateCheck(getAllWindows)
      // Check for updates 5 seconds after startup (force to bypass interval check)
      setTimeout(() => {
        checkForUpdates(true)
      }, 5000)
    }

    // Warm up MCP cache shortly after startup (background, non-blocking)
    // This populates the cache so all future sessions can use filtered MCP servers
    setTimeout(async () => {
      try {
        await getAllMcpConfigHandler()
      } catch (error) {
        console.error("[App] MCP warmup failed:", error)
      }
    }, 500)

    // Handle directory argument from CLI (e.g., `2code /path/to/project`)
    parseLaunchDirectory()

    // Handle deep link from app launch (Windows/Linux)
    const deepLinkUrl = process.argv.find((arg) =>
      arg.startsWith(`${PROTOCOL}://`),
    )
    if (deepLinkUrl) {
      handleDeepLink(deepLinkUrl)
    }

    // macOS: Re-create window when dock icon is clicked
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createMainWindow()
      }
    })
  })

  // Quit when all windows are closed (except on macOS)
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit()
    }
  })

  // Cleanup before quit — use preventDefault + re-quit to ensure async cleanup completes
  let isCleaningUp = false
  app.on("before-quit", async (event) => {
    if (isCleaningUp) return // Already cleaning up, let the second quit through
    isCleaningUp = true
    event.preventDefault()
    console.log("[App] Shutting down...")
    try {
      abortAllClaudeSessions()
      cancelAllPendingOAuth()
      await cleanupGitWatchers()
      await closeDatabase()
    } catch (error) {
      console.error("[App] Cleanup error:", error)
    }
    app.quit()
  })

  // Handle uncaught exceptions
  process.on("uncaughtException", (error) => {
    console.error("[App] Uncaught exception:", error)
  })

  process.on("unhandledRejection", (reason, promise) => {
    console.error("[App] Unhandled rejection at:", promise, "reason:", reason)
  })
}
