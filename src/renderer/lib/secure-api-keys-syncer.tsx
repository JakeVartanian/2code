import { useAtom } from "jotai"
import { useEffect, useRef } from "react"
import { trpc } from "./trpc"
import {
  customClaudeConfigAtom,
  openaiApiKeyAtom,
  openRouterApiKeyAtom,
} from "./atoms"
import type { CustomClaudeConfig } from "./atoms"

/**
 * Syncs API keys between safeStorage (main process) and Jotai atoms (renderer).
 *
 * On mount: loads keys from safeStorage via tRPC and sets atoms.
 *           Also migrates any leftover plaintext keys from localStorage.
 * On change: saves updated values back to safeStorage via tRPC.
 *
 * Render-invisible — returns null.
 */
export function SecureApiKeysSyncer() {
  const [openRouterKey, setOpenRouterKey] = useAtom(openRouterApiKeyAtom)
  const [openaiKey, setOpenaiKey] = useAtom(openaiApiKeyAtom)
  const [customConfig, setCustomConfig] = useAtom(customClaudeConfigAtom)

  const saveApiKey = trpc.secureStore.setApiKey.useMutation()
  const saveCustomConfig = trpc.secureStore.setCustomClaudeConfig.useMutation()
  const { data: stored } = trpc.secureStore.getApiKeys.useQuery()

  // Track whether we've done the initial hydration
  const hydrated = useRef(false)

  // --- HYDRATE from safeStorage on first load ---
  useEffect(() => {
    if (!stored || hydrated.current) return
    hydrated.current = true

    // Prefer safeStorage value; fall back to localStorage for migration
    const resolvedOpenRouter =
      stored.openRouterKey ||
      localStorage.getItem("agents:openrouter-api-key")?.replace(/^"|"$/g, "") ||
      ""

    const resolvedOpenai =
      stored.openaiKey ||
      localStorage.getItem("agents:openai-api-key")?.replace(/^"|"$/g, "") ||
      ""

    let resolvedCustom: CustomClaudeConfig = stored.customClaudeConfig ?? { model: "", token: "", baseUrl: "" }
    if (!stored.customClaudeConfig) {
      try {
        const raw = localStorage.getItem("agents:claude-custom-config")
        if (raw) resolvedCustom = JSON.parse(raw)
      } catch {
        // ignore malformed data
      }
    }

    if (resolvedOpenRouter) setOpenRouterKey(resolvedOpenRouter)
    if (resolvedOpenai) setOpenaiKey(resolvedOpenai)
    if (resolvedCustom.model || resolvedCustom.token || resolvedCustom.baseUrl) {
      setCustomConfig(resolvedCustom)
    }

    // Persist any migrated values to safeStorage
    if (resolvedOpenRouter && !stored.openRouterKey)
      saveApiKey.mutate({ key: "openRouterKey", value: resolvedOpenRouter })
    if (resolvedOpenai && !stored.openaiKey)
      saveApiKey.mutate({ key: "openaiKey", value: resolvedOpenai })
    if ((resolvedCustom.model || resolvedCustom.token) && !stored.customClaudeConfig)
      saveCustomConfig.mutate(resolvedCustom)

    // Clear plaintext values from localStorage
    localStorage.removeItem("agents:openrouter-api-key")
    localStorage.removeItem("agents:openai-api-key")
    localStorage.removeItem("agents:claude-custom-config")
  }, [stored]) // eslint-disable-line react-hooks/exhaustive-deps

  // --- SAVE openRouterKey changes to safeStorage ---
  const prevOpenRouter = useRef<string | null>(null)
  useEffect(() => {
    if (!hydrated.current) return
    if (prevOpenRouter.current === null) {
      prevOpenRouter.current = openRouterKey
      return
    }
    if (prevOpenRouter.current === openRouterKey) return
    prevOpenRouter.current = openRouterKey
    saveApiKey.mutate({ key: "openRouterKey", value: openRouterKey })
  }, [openRouterKey]) // eslint-disable-line react-hooks/exhaustive-deps

  // --- SAVE openaiKey changes to safeStorage ---
  const prevOpenai = useRef<string | null>(null)
  useEffect(() => {
    if (!hydrated.current) return
    if (prevOpenai.current === null) {
      prevOpenai.current = openaiKey
      return
    }
    if (prevOpenai.current === openaiKey) return
    prevOpenai.current = openaiKey
    saveApiKey.mutate({ key: "openaiKey", value: openaiKey })
  }, [openaiKey]) // eslint-disable-line react-hooks/exhaustive-deps

  // --- SAVE customConfig changes to safeStorage ---
  const prevCustom = useRef<CustomClaudeConfig | null>(null)
  useEffect(() => {
    if (!hydrated.current) return
    if (prevCustom.current === null) {
      prevCustom.current = customConfig
      return
    }
    const prevStr = JSON.stringify(prevCustom.current)
    const currStr = JSON.stringify(customConfig)
    if (prevStr === currStr) return
    prevCustom.current = customConfig
    saveCustomConfig.mutate(customConfig)
  }, [customConfig]) // eslint-disable-line react-hooks/exhaustive-deps

  return null
}
