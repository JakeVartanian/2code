import { safeStorage } from "electron"
import { z } from "zod"
import { publicProcedure, router } from "../index"

// Keys we manage in safeStorage
const ALLOWED_KEYS = ["openRouterKey", "openaiKey", "customClaudeConfig"] as const
type AllowedKey = (typeof ALLOWED_KEYS)[number]

function storageKey(key: AllowedKey): string {
  return `secureStore:${key}`
}

function encryptValue(value: string): string {
  if (!safeStorage.isEncryptionAvailable()) {
    console.warn("[SecureStore] Encryption not available, skipping write for key security")
    return ""
  }
  return safeStorage.encryptString(value).toString("base64")
}

function decryptValue(encrypted: string): string | null {
  if (!safeStorage.isEncryptionAvailable()) return null
  try {
    return safeStorage.decryptString(Buffer.from(encrypted, "base64"))
  } catch {
    return null
  }
}

// In-memory store backed by safeStorage (electron-store-like, but encrypted)
const store = new Map<string, string>()

function readFromStore(key: AllowedKey): string | null {
  const memVal = store.get(storageKey(key))
  if (memVal !== undefined) return memVal || null
  return null
}

function writeToStore(key: AllowedKey, value: string): void {
  if (value) {
    const encrypted = encryptValue(value)
    if (encrypted) store.set(storageKey(key), encrypted)
  } else {
    store.delete(storageKey(key))
  }
}

// Initialize: load persisted encrypted values from electron-settings-like JSON file
// We use a simple approach: keep encrypted values in a JSON file in userData
import { app } from "electron"
import { join } from "node:path"
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs"

function getStorePath(): string {
  return join(app.getPath("userData"), "secure-store.dat")
}

function loadFromDisk(): void {
  const path = getStorePath()
  if (!existsSync(path)) return
  try {
    const raw = readFileSync(path, "utf-8")
    const data = JSON.parse(raw) as Record<string, string>
    for (const [k, v] of Object.entries(data)) {
      store.set(k, v)
    }
  } catch {
    // corrupted — start fresh
  }
}

function saveToDisk(): void {
  const path = getStorePath()
  const dir = join(path, "..")
  mkdirSync(dir, { recursive: true })
  const data: Record<string, string> = {}
  for (const [k, v] of store) {
    data[k] = v
  }
  writeFileSync(path, JSON.stringify(data), { mode: 0o600 })
}

// Load on module init
loadFromDisk()

export const secureStoreRouter = router({
  /** Read all API keys at once (for startup hydration) */
  getApiKeys: publicProcedure.query(() => {
    const get = (key: AllowedKey): string => {
      const encrypted = readFromStore(key)
      if (!encrypted) return ""
      return decryptValue(encrypted) ?? ""
    }

    let customClaudeConfig: { model: string; token: string; baseUrl: string } | null = null
    try {
      const raw = get("customClaudeConfig")
      if (raw) customClaudeConfig = JSON.parse(raw)
    } catch {
      customClaudeConfig = null
    }

    return {
      openRouterKey: get("openRouterKey"),
      openaiKey: get("openaiKey"),
      customClaudeConfig,
    }
  }),

  /** Write a single API key */
  setApiKey: publicProcedure
    .input(
      z.object({
        key: z.enum(ALLOWED_KEYS),
        value: z.string(),
      }),
    )
    .mutation(({ input }) => {
      writeToStore(input.key, input.value)
      saveToDisk()
      return { success: true }
    }),

  /** Write customClaudeConfig (JSON object) */
  setCustomClaudeConfig: publicProcedure
    .input(
      z.object({
        model: z.string(),
        token: z.string(),
        baseUrl: z.string(),
      }),
    )
    .mutation(({ input }) => {
      writeToStore("customClaudeConfig", JSON.stringify(input))
      saveToDisk()
      return { success: true }
    }),

  /** Check if encryption is available on this platform */
  isEncryptionAvailable: publicProcedure.query(() => ({
    available: safeStorage.isEncryptionAvailable(),
  })),
})
