/**
 * One-shot Claude API calls via the bundled CLI binary.
 *
 * ╔═══════════════════════════════════════════════════════════════════════╗
 * ║  ALL AI CALLS MUST GO THROUGH THE BUNDLED CLI BINARY.               ║
 * ║  NEVER call the Anthropic SDK or API directly — OAuth tokens only   ║
 * ║  work via CLAUDE_CODE_OAUTH_TOKEN env var → CLI subprocess.         ║
 * ║  Direct API calls with OAuth tokens WILL fail with:                 ║
 * ║  "OAuth authentication is currently not supported."                 ║
 * ╚═══��═══════════════════════════════════════════════════════════════════╝
 *
 * This module provides a simple one-shot interface for background features
 * (ambient agent, memory extraction, orchestration, etc.) that need to make
 * AI calls without a full interactive streaming session.
 */

import { app } from "electron"
import path from "node:path"
import * as fs from "node:fs/promises"
import { buildClaudeEnv, getBundledClaudeBinaryPath } from "./env"
import { getClaudeCodeTokenFresh } from "../trpc/routers/claude"

// Dynamic import cache for the ESM SDK module
let cachedQuery: typeof import("@anthropic-ai/claude-agent-sdk").query | null = null

async function getQuery() {
  if (cachedQuery) return cachedQuery
  const sdk = await import("@anthropic-ai/claude-agent-sdk")
  cachedQuery = sdk.query
  return cachedQuery
}

export interface CallClaudeOptions {
  /** System prompt */
  system: string
  /** User message content */
  userMessage: string
  /** Max output tokens (default 4096) */
  maxTokens?: number
  /** Model tier: "haiku" for cheap/fast, "sonnet" for quality (default: CLI default) */
  model?: "haiku" | "sonnet"
  /** Timeout in milliseconds (default 120_000) */
  timeoutMs?: number
  /** Abort signal for external cancellation */
  signal?: AbortSignal
}

export interface CallClaudeResult {
  text: string
  inputTokens: number
  outputTokens: number
}

/**
 * Make a one-shot Claude call through the bundled CLI binary.
 *
 * Uses the same auth mechanism as interactive chat sessions:
 * OAuth token → CLAUDE_CODE_OAUTH_TOKEN env var → CLI subprocess.
 *
 * The CLI runs in plan mode (read-only) since background features
 * don't need tool execution permissions.
 */
export async function callClaude(opts: CallClaudeOptions): Promise<CallClaudeResult> {
  // 1. Get OAuth token (with 10s timeout to prevent indefinite hangs)
  const token = await Promise.race([
    getClaudeCodeTokenFresh(),
    new Promise<null>((_, reject) =>
      setTimeout(() => reject(new Error("Token fetch timeout (10s)")), 10_000),
    ),
  ])
  if (!token) {
    throw new Error("No OAuth token available — user must connect Claude account in Settings")
  }

  // 2. Get the SDK query function
  const query = await getQuery()

  // 3. Build subprocess environment (same as interactive sessions)
  const claudeEnv = buildClaudeEnv({ enableTasks: false })

  // Create an isolated config dir for background calls
  const isolatedConfigDir = path.join(
    app.getPath("userData"),
    "claude-sessions",
    "_background",
  )
  await fs.mkdir(isolatedConfigDir, { recursive: true })

  const finalEnv: Record<string, string> = {
    ...claudeEnv,
    CLAUDE_CONFIG_DIR: isolatedConfigDir,
    CLAUDE_CODE_OAUTH_TOKEN: token,
  }

  // Map model tier to actual model ID for the SDK `model` option
  const modelMap: Record<string, string> = {
    haiku: "claude-haiku-4-5-20251001",
    sonnet: "claude-sonnet-4-6",
  }
  const modelId = opts.model ? modelMap[opts.model] : undefined

  // 4. User message only — system prompt goes via the systemPrompt option
  const fullPrompt = opts.userMessage

  // 5. Setup abort controller with timeout
  const abortController = new AbortController()
  const timeout = setTimeout(() => abortController.abort(), opts.timeoutMs ?? 120_000)

  if (opts.signal) {
    opts.signal.addEventListener("abort", () => abortController.abort(), { once: true })
  }

  try {
    // 6. Run query through CLI binary — plan mode, no tools needed
    const claudeBinaryPath = getBundledClaudeBinaryPath()
    const stream = query({
      prompt: fullPrompt,
      options: {
        abortController,
        cwd: app.getPath("userData"),
        maxTurns: 1,
        systemPrompt: opts.system,
        model: modelId,
        env: finalEnv,
        permissionMode: "plan" as const,
        pathToClaudeCodeExecutable: claudeBinaryPath,
      },
    })

    // 7. Collect text from assistant messages
    let text = ""
    let inputTokens = 0
    let outputTokens = 0
    let msgCount = 0

    console.log(`[callClaude] Starting stream, model=${modelId || "default"}, timeout=${opts.timeoutMs ?? 120_000}ms`)

    for await (const msg of stream) {
      const m = msg as any
      msgCount++

      // Handle errors from the CLI binary
      if (m.type === "error") {
        const errorText = m.error?.message || m.error || m.message || "Unknown CLI error"
        console.error(`[callClaude] CLI error at msg#${msgCount}: ${typeof errorText === "string" ? errorText : JSON.stringify(errorText)}`)
        throw new Error(`CLI error: ${typeof errorText === "string" ? errorText : JSON.stringify(errorText)}`)
      }

      // Collect text from assistant message content blocks
      if (m.type === "assistant" && m.message?.content) {
        for (const block of m.message.content) {
          if (block.type === "text" && block.text) {
            text += block.text
          }
        }
        // Collect usage from assistant messages
        if (m.message?.usage) {
          inputTokens += m.message.usage.input_tokens ?? 0
          outputTokens += m.message.usage.output_tokens ?? 0
        }
      }

      // Also check for result message type (final summary)
      if (m.type === "result") {
        // Result may have error info
        if (m.is_error) {
          const resultError = m.result || "Query failed"
          console.error(`[callClaude] Query result error: ${resultError}`)
          throw new Error(`Query failed: ${resultError}`)
        }
        // Result may contain additional usage info
        if (m.input_tokens) inputTokens = m.input_tokens
        if (m.output_tokens) outputTokens = m.output_tokens
      }
    }

    console.log(`[callClaude] Stream complete, msgs=${msgCount}, textLen=${text.length}`)

    if (!text.trim()) {
      console.error("[callClaude] No text received from CLI — stream completed with empty response")
      throw new Error("No response received from Claude")
    }

    return { text, inputTokens, outputTokens }
  } finally {
    clearTimeout(timeout)
  }
}

// ─── Legacy re-export for backward compatibility during migration ─────────
// TODO: Remove once all callers are migrated to callClaude
export type AnthropicCallOptions = {
  token: string
  model: string
  system: string
  userMessage: string
  maxTokens: number
  timeoutMs?: number
  signal?: AbortSignal
}

export type AnthropicCallResult = CallClaudeResult

/**
 * @deprecated Use callClaude() instead. This wrapper exists only for backward
 * compatibility during migration. The `token` and `model` params are ignored —
 * all calls go through the CLI binary which handles auth and model selection.
 */
export async function callAnthropic(opts: AnthropicCallOptions): Promise<AnthropicCallResult> {
  return callClaude({
    system: opts.system,
    userMessage: opts.userMessage,
    maxTokens: opts.maxTokens,
    timeoutMs: opts.timeoutMs,
    signal: opts.signal,
  })
}
