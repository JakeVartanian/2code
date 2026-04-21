/**
 * Ambient provider abstraction — handles API calls to Anthropic or OpenRouter.
 * Selects the right endpoint, model ID, request format, and auth based on available credentials.
 */

import type { AmbientProviderInfo, AmbientProviderType } from "./types"

export interface AmbientProviderCallResult {
  text: string
  inputTokens: number
  outputTokens: number
}

export interface AmbientProvider {
  type: AmbientProviderType
  info: AmbientProviderInfo

  callHaiku(system: string, user: string): Promise<AmbientProviderCallResult>
  callSonnet(system: string, user: string): Promise<AmbientProviderCallResult>
}

// ============ ANTHROPIC PROVIDER ============

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages"
const ANTHROPIC_VERSION = "2023-06-01"
const HAIKU_MODEL = "claude-haiku-4-5-20251001"
const SONNET_MODEL = "claude-sonnet-4-5-20250929"

class AnthropicProvider implements AmbientProvider {
  type: AmbientProviderType = "anthropic"
  info: AmbientProviderInfo = {
    type: "anthropic",
    supportsHaiku: true,
    supportsSonnet: true,
  }

  constructor(private token: string) {}

  async callHaiku(system: string, user: string): Promise<AmbientProviderCallResult> {
    return this.call(HAIKU_MODEL, system, user, 1024)
  }

  async callSonnet(system: string, user: string): Promise<AmbientProviderCallResult> {
    return this.call(SONNET_MODEL, system, user, 4096)
  }

  private async call(
    model: string,
    system: string,
    user: string,
    maxTokens: number,
  ): Promise<AmbientProviderCallResult> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 120_000)

    try {
      const response = await fetch(ANTHROPIC_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.token}`,
          "anthropic-version": ANTHROPIC_VERSION,
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          system,
          messages: [{ role: "user", content: user }],
        }),
        signal: controller.signal,
      })

      if (!response.ok) {
        const errText = await response.text().catch(() => "")
        throw new Error(`Anthropic API ${response.status}: ${errText.slice(0, 200)}`)
      }

      const result = (await response.json()) as {
        content?: Array<{ type: string; text?: string }>
        usage?: { input_tokens?: number; output_tokens?: number }
      }

      return {
        text: result.content?.[0]?.text ?? "",
        inputTokens: result.usage?.input_tokens ?? 0,
        outputTokens: result.usage?.output_tokens ?? 0,
      }
    } finally {
      clearTimeout(timeout)
    }
  }
}

// ============ OPENROUTER PROVIDER ============

const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions"
const OR_HAIKU_MODEL = "anthropic/claude-haiku-4-5"
const OR_SONNET_MODEL = "anthropic/claude-sonnet-4-5"

class OpenRouterProvider implements AmbientProvider {
  type: AmbientProviderType = "openrouter"
  info: AmbientProviderInfo

  constructor(private apiKey: string, freeOnly: boolean = false) {
    this.info = {
      type: "openrouter",
      supportsHaiku: true,
      supportsSonnet: !freeOnly, // No free Sonnet available
    }
  }

  async callHaiku(system: string, user: string): Promise<AmbientProviderCallResult> {
    return this.call(OR_HAIKU_MODEL, system, user, 1024)
  }

  async callSonnet(system: string, user: string): Promise<AmbientProviderCallResult> {
    if (!this.info.supportsSonnet) {
      throw new Error("Sonnet not available on free-only OpenRouter plan")
    }
    return this.call(OR_SONNET_MODEL, system, user, 4096)
  }

  private async call(
    model: string,
    system: string,
    user: string,
    maxTokens: number,
  ): Promise<AmbientProviderCallResult> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 120_000)

    try {
      const response = await fetch(OPENROUTER_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
          "HTTP-Referer": "https://2code.dev",
          "X-Title": "2Code Ambient Agent",
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
        }),
        signal: controller.signal,
      })

      if (!response.ok) {
        const errText = await response.text().catch(() => "")
        throw new Error(`OpenRouter API ${response.status}: ${errText.slice(0, 200)}`)
      }

      const result = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>
        usage?: { prompt_tokens?: number; completion_tokens?: number }
      }

      return {
        text: result.choices?.[0]?.message?.content ?? "",
        inputTokens: result.usage?.prompt_tokens ?? 0,
        outputTokens: result.usage?.completion_tokens ?? 0,
      }
    } finally {
      clearTimeout(timeout)
    }
  }
}

// ============ PROVIDER RESOLUTION ============

/**
 * Create the appropriate ambient provider based on available credentials.
 * Resolution order: Anthropic OAuth → OpenRouter → null (Tier 0 only)
 */
export async function createAmbientProvider(
  getAnthropicToken: () => Promise<string | null>,
  openRouterKey: string | null,
  openRouterFreeOnly: boolean = false,
): Promise<AmbientProvider | null> {
  // Try Anthropic first
  const anthropicToken = await getAnthropicToken()
  if (anthropicToken) {
    return new AnthropicProvider(anthropicToken)
  }

  // Try OpenRouter
  if (openRouterKey) {
    return new OpenRouterProvider(openRouterKey, openRouterFreeOnly)
  }

  // No provider available — ambient agent runs Tier 0 only
  return null
}
