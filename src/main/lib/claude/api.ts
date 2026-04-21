/**
 * Shared utility for making direct Anthropic API calls with proper OAuth handling.
 *
 * The Anthropic Messages API does NOT accept OAuth tokens via raw
 * `Authorization: Bearer <token>` headers. The official SDK handles OAuth
 * internally (via the `authToken` option), so all direct API calls must go
 * through it instead of raw fetch().
 */

import Anthropic from "@anthropic-ai/sdk"

let cachedClient: { client: Anthropic; token: string } | null = null

/**
 * Get an Anthropic SDK client configured with the given OAuth token.
 * Caches the client and reuses it when the token hasn't changed.
 */
function getClient(token: string): Anthropic {
  if (cachedClient && cachedClient.token === token) {
    return cachedClient.client
  }
  const client = new Anthropic({ authToken: token })
  cachedClient = { client, token }
  return client
}

export interface AnthropicCallOptions {
  token: string
  model: string
  system: string
  userMessage: string
  maxTokens: number
  timeoutMs?: number
  signal?: AbortSignal
}

export interface AnthropicCallResult {
  text: string
  inputTokens: number
  outputTokens: number
}

/**
 * Make a one-shot Anthropic API call using the SDK (handles OAuth properly).
 * This replaces all raw fetch() calls to api.anthropic.com/v1/messages.
 */
export async function callAnthropic(opts: AnthropicCallOptions): Promise<AnthropicCallResult> {
  const client = getClient(opts.token)

  const controller = new AbortController()
  const timeout = opts.timeoutMs
    ? setTimeout(() => controller.abort(), opts.timeoutMs)
    : null

  // If an external signal is provided, chain it
  if (opts.signal) {
    opts.signal.addEventListener("abort", () => controller.abort(), { once: true })
  }

  try {
    const result = await client.messages.create(
      {
        model: opts.model,
        max_tokens: opts.maxTokens,
        system: opts.system,
        messages: [{ role: "user", content: opts.userMessage }],
      },
      { signal: controller.signal },
    )

    const text = result.content[0]?.type === "text" ? result.content[0].text : ""

    return {
      text,
      inputTokens: result.usage?.input_tokens ?? 0,
      outputTokens: result.usage?.output_tokens ?? 0,
    }
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}
