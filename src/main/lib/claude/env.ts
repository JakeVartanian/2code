import { app } from "electron"
import { execSync, execFileSync, execFile } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { stripVTControlCharacters, promisify } from "node:util"
import {
  getDefaultShell,
  isWindows,
  platform
} from "../platform"

const execFileAsync = promisify(execFile)

// Cache the shell environment
let cachedShellEnv: Record<string, string> | null = null

// Promise for async shell env loading (non-blocking startup)
let shellEnvPromise: Promise<Record<string, string>> | null = null

// Delimiter for parsing env output
const DELIMITER = "_CLAUDE_ENV_DELIMITER_"

// Keys stripped from the subprocess environment to prevent interference.
// ANTHROPIC_API_KEY is ALWAYS stripped because the app uses OAuth via
// CLAUDE_CODE_OAUTH_TOKEN env var. A stale ANTHROPIC_API_KEY in the user's
// shell would override the OAuth token and cause auth failures.
// Users with custom API key/proxy configs go through the customEnv path
// in buildClaudeEnv(), which re-injects their key after stripping.
const STRIPPED_ENV_KEYS = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  // ANTHROPIC_AUTH_TOKEN must be stripped because it causes KN() in the CLI
  // to return false, which disables the OAuth/direct-inference path (O_())
  // and forces the CLI into API-key mode (where it looks for a key in the
  // keychain that doesn't exist, since we never called create_api_key).
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  // Strip CLAUDECODE so the child Claude process doesn't detect a nested session
  // and refuse to start. The parent Electron process may have this set if launched
  // from within a Claude Code session (e.g. during development).
  "CLAUDECODE",
]

// Cache the bundled binary path (only compute once)
let cachedBinaryPath: string | null = null
let binaryPathComputed = false

/**
 * Get path to the bundled Claude binary.
 * Returns the path to the native Claude executable bundled with the app.
 * CACHED - only computes path once and logs verbose info on first call.
 */
export function getBundledClaudeBinaryPath(): string {
  // Return cached path if already computed
  if (binaryPathComputed) {
    return cachedBinaryPath!
  }

  const isDev = !app.isPackaged
  const currentPlatform = process.platform
  const arch = process.arch

  // Always log on first call to help debug
  console.log("[claude-binary] ========== BUNDLED BINARY DEBUG ==========")
  console.log("[claude-binary] isDev:", isDev)
  console.log("[claude-binary] platform:", currentPlatform)
  console.log("[claude-binary] arch:", arch)
  console.log("[claude-binary] appPath:", app.getAppPath())

  // In dev: apps/desktop/resources/bin/{platform}-{arch}/claude
  // In production: {resourcesPath}/bin/claude
  const resourcesPath = isDev
    ? path.join(
        app.getAppPath(),
        "resources/bin",
        `${currentPlatform}-${arch}`
      )
    : path.join(process.resourcesPath, "bin")

  console.log("[claude-binary] resourcesPath:", resourcesPath)

  const binaryName = currentPlatform === "win32" ? "claude.exe" : "claude"
  const binaryPath = path.join(resourcesPath, binaryName)

  console.log("[claude-binary] binaryPath:", binaryPath)

  // Check if binary exists
  const exists = fs.existsSync(binaryPath)

  if (!exists) {
    console.error(
      "[claude-binary] WARNING: Binary not found at path:",
      binaryPath
    )
    console.error(
      "[claude-binary] Run 'bun run claude:download' to download it"
    )
  } else {
    const stats = fs.statSync(binaryPath)
    const sizeMB = (stats.size / 1024 / 1024).toFixed(1)
    const isExecutable = (stats.mode & fs.constants.X_OK) !== 0
    console.log("[claude-binary] exists:", exists)
    console.log("[claude-binary] size:", sizeMB, "MB")
    console.log("[claude-binary] isExecutable:", isExecutable)
  }
  console.log("[claude-binary] ============================================")

  // Cache the result
  cachedBinaryPath = binaryPath
  binaryPathComputed = true

  return binaryPath
}

/**
 * Parse environment variables from shell output
 */
function parseEnvOutput(output: string): Record<string, string> {
  const envSection = output.split(DELIMITER)[1]
  if (!envSection) return {}

  const env: Record<string, string> = {}
  for (const line of stripVTControlCharacters(envSection)
    .split("\n")
    .filter(Boolean)) {
    const separatorIndex = line.indexOf("=")
    if (separatorIndex > 0) {
      const key = line.substring(0, separatorIndex)
      const value = line.substring(separatorIndex + 1)
      env[key] = value
    }
  }
  return env
}

/**
 * Strip sensitive keys from environment
 */
function stripSensitiveKeys(env: Record<string, string>): void {
  for (const key of STRIPPED_ENV_KEYS) {
    if (key in env) {
      console.log(`[claude-env] Stripped ${key} from shell environment`)
      delete env[key]
    }
  }
}

/**
 * Async shell environment loading (non-blocking).
 * Called during startup to warm the cache in the background.
 */
async function loadShellEnvironmentAsync(): Promise<Record<string, string>> {
  // Windows: use platform provider (already fast, no shell spawn)
  if (isWindows()) {
    console.log("[claude-env] Windows detected, deriving PATH without shell invocation")
    const env = platform.buildEnvironment()
    stripSensitiveKeys(env)
    console.log(`[claude-env] Built Windows environment with ${Object.keys(env).length} vars`)
    cachedShellEnv = env
    return { ...env }
  }

  // macOS/Linux: spawn interactive login shell asynchronously
  const shell = getDefaultShell()
  const command = `echo -n "${DELIMITER}"; env; echo -n "${DELIMITER}"; exit`

  try {
    const { stdout } = await execFileAsync(shell, ["-ilc", command], {
      encoding: "utf8",
      timeout: 5000,
      env: {
        DISABLE_AUTO_UPDATE: "true",
        HOME: os.homedir(),
        USER: os.userInfo().username,
        SHELL: shell,
      },
    })

    const env = parseEnvOutput(stdout)
    stripSensitiveKeys(env)
    console.log(`[claude-env] Loaded ${Object.keys(env).length} environment variables from shell (async)`)
    cachedShellEnv = env
    return { ...env }
  } catch (error) {
    console.error("[claude-env] Failed to load shell environment:", error)
    const env = platform.buildEnvironment()
    stripSensitiveKeys(env)
    console.log("[claude-env] Using fallback environment from platform provider")
    cachedShellEnv = env
    return { ...env }
  }
}

/**
 * Start loading shell environment in the background.
 * Call this during app startup so the cache is warm before first Claude session.
 */
export function warmupShellEnvironment(): void {
  if (cachedShellEnv !== null || shellEnvPromise !== null) return
  shellEnvPromise = loadShellEnvironmentAsync()
  shellEnvPromise.catch(() => {}) // Prevent unhandled rejection
}

/**
 * Get shell environment, awaiting the async load if in progress.
 * Falls back to synchronous load if warmup wasn't called.
 */
export async function getClaudeShellEnvironmentAsync(): Promise<Record<string, string>> {
  if (cachedShellEnv !== null) return { ...cachedShellEnv }
  if (shellEnvPromise !== null) return { ...(await shellEnvPromise) }
  // Fallback: start async load now
  shellEnvPromise = loadShellEnvironmentAsync()
  return { ...(await shellEnvPromise) }
}

/**
 * Load full shell environment (synchronous, legacy).
 * Prefers cached result from async warmup. Falls back to execSync if not warmed up.
 * Results are cached for the lifetime of the process.
 */
export function getClaudeShellEnvironment(): Record<string, string> {
  if (cachedShellEnv !== null) {
    return { ...cachedShellEnv }
  }

  // Windows: use platform provider to build environment
  if (isWindows()) {
    console.log(
      "[claude-env] Windows detected, deriving PATH without shell invocation"
    )

    // Use platform provider to build environment
    const env = platform.buildEnvironment()

    // Strip sensitive keys
    stripSensitiveKeys(env)

    console.log(
      `[claude-env] Built Windows environment with ${Object.keys(env).length} vars`
    )
    cachedShellEnv = env
    return { ...env }
  }

  // macOS/Linux: spawn interactive login shell to get full environment
  console.log("[claude-env] Shell env not warmed up, falling back to sync load")
  const shell = getDefaultShell()
  const command = `echo -n "${DELIMITER}"; env; echo -n "${DELIMITER}"; exit`

  try {
    const output = execFileSync(shell, ["-ilc", command], {
      encoding: "utf8",
      timeout: 5000,
      env: {
        // Prevent Oh My Zsh from blocking with auto-update prompts
        DISABLE_AUTO_UPDATE: "true",
        // Minimal env to bootstrap the shell
        HOME: os.homedir(),
        USER: os.userInfo().username,
        SHELL: shell,
      },
    })

    const env = parseEnvOutput(output)
    stripSensitiveKeys(env)

    console.log(
      `[claude-env] Loaded ${Object.keys(env).length} environment variables from shell`
    )
    cachedShellEnv = env
    return { ...env }
  } catch (error) {
    console.error("[claude-env] Failed to load shell environment:", error)

    // Fallback: use platform provider
    const env = platform.buildEnvironment()
    stripSensitiveKeys(env)

    console.log("[claude-env] Using fallback environment from platform provider")
    cachedShellEnv = env
    return { ...env }
  }
}

/**
 * Build the complete environment for Claude SDK.
 * Merges shell environment, process.env, and custom overrides.
 */
export function buildClaudeEnv(options?: {
  ghToken?: string
  customEnv?: Record<string, string>
  enableTasks?: boolean
}): Record<string, string> {
  const env: Record<string, string> = {}

  // 1. Start with shell environment (has HOME, full PATH, etc.)
  try {
    Object.assign(env, getClaudeShellEnvironment())
  } catch (error) {
    console.error("[claude-env] Shell env failed, using process.env")
  }

  // 2. Overlay current process.env (preserves Electron-set vars)
  // BUT: Don't overwrite PATH from shell env - Electron's PATH is minimal when launched from Finder
  const shellPath = env.PATH
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value
    }
  }
  // Restore shell PATH if we had one (it contains nvm, homebrew, etc.)
  if (shellPath) {
    env.PATH = shellPath
  }

  // 2b. Apply custom overrides FIRST (before stripping) so they can provide
  // custom API tokens for OpenRouter, Ollama, etc. that override the shell env
  const explicitlySetKeys = new Set<string>()
  if (options?.ghToken) {
    env.GH_TOKEN = options.ghToken
    explicitlySetKeys.add("GH_TOKEN")
  }
  if (options?.customEnv) {
    for (const [key, value] of Object.entries(options.customEnv)) {
      if (value === "") {
        delete env[key]
      } else {
        env[key] = value
        explicitlySetKeys.add(key)
      }
    }
  }

  // 2c. Strip sensitive keys (process.env may have re-added them)
  // ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN from the user's shell would
  // override the OAuth flow. BUT: if customEnv explicitly provided a value,
  // keep it (e.g. ANTHROPIC_AUTH_TOKEN for OpenRouter or ANTHROPIC_API_KEY for custom proxies)
  for (const key of STRIPPED_ENV_KEYS) {
    if (key in env && !explicitlySetKeys.has(key)) {
      console.log(`[claude-env] Stripped ${key} from final environment`)
      delete env[key]
    } else if (key in env && explicitlySetKeys.has(key)) {
      console.log(`[claude-env] Preserved ${key} (explicitly provided via customEnv)`)
    }
  }

  // 3. Ensure critical vars are present using platform provider
  const platformEnv = platform.buildEnvironment()
  if (!env.HOME) env.HOME = platformEnv.HOME
  if (!env.USER) env.USER = platformEnv.USER
  if (!env.TERM) env.TERM = "xterm-256color"
  if (!env.SHELL) env.SHELL = getDefaultShell()

  // Windows-specific: ensure USERPROFILE is set
  if (isWindows() && !env.USERPROFILE) {
    env.USERPROFILE = os.homedir()
  }

  // 5. Enable/disable task management tools based on user preference (default: enabled)
  env.CLAUDE_CODE_ENABLE_TASKS = options?.enableTasks !== false ? "true" : "false"

  return env
}

/**
 * Clear cached shell environment (useful for testing)
 */
export function clearClaudeEnvCache(): void {
  cachedShellEnv = null
}

/**
 * Debug: Log key environment variables
 */
export function logClaudeEnv(
  env: Record<string, string>,
  prefix: string = ""
): void {
  console.log(`${prefix}[claude-env] HOME: ${env.HOME}`)
  console.log(`${prefix}[claude-env] USER: ${env.USER}`)
  console.log(
    `${prefix}[claude-env] PATH includes homebrew: ${env.PATH?.includes("/opt/homebrew")}`
  )
  console.log(
    `${prefix}[claude-env] PATH includes /usr/local/bin: ${env.PATH?.includes("/usr/local/bin")}`
  )
  console.log(
    `${prefix}[claude-env] CLAUDE_CODE_OAUTH_TOKEN: ${env.CLAUDE_CODE_OAUTH_TOKEN ? "set" : "not set"}`
  )
  console.log(
    `${prefix}[claude-env] ANTHROPIC_AUTH_TOKEN: ${env.ANTHROPIC_AUTH_TOKEN ? "set" : "not set"}`
  )
  console.log(
    `${prefix}[claude-env] ANTHROPIC_BASE_URL: ${env.ANTHROPIC_BASE_URL || "(not set)"}`
  )
  console.log(
    `${prefix}[claude-env] ANTHROPIC_DEFAULT_SONNET_MODEL: ${env.ANTHROPIC_DEFAULT_SONNET_MODEL || "(not set)"}`
  )
  console.log(
    `${prefix}[claude-env] CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: ${env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS || "(not set)"}`
  )
}
