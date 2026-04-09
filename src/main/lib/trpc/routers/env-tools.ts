/**
 * Environment Tools tRPC router
 * Checks which CLI tools and API keys are available in the shell environment
 * and optionally in the project's .env files.
 * Values are never returned — only presence/absence is reported.
 */

import fs from "node:fs"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { z } from "zod"
import { publicProcedure, router } from "../index"
import { getClaudeShellEnvironment } from "../../claude/env"
import { isWindows } from "../../platform"

const execFileAsync = promisify(execFile)

// ---------------------------------------------------------------------------
// Tool + key definitions
// ---------------------------------------------------------------------------

interface CliToolDef {
  name: string
  key: string
  binary: string
  hint?: string
}

interface ApiKeyDef {
  name: string
  key: string
  envVars: string[]
  description?: string
}

const CLI_TOOLS: CliToolDef[] = [
  { name: "Wrangler", key: "wrangler", binary: "wrangler", hint: "npm install -g wrangler" },
  { name: "GitHub CLI", key: "gh", binary: "gh", hint: "brew install gh" },
  { name: "Git", key: "git", binary: "git" },
  { name: "Bun", key: "bun", binary: "bun", hint: "curl -fsSL https://bun.sh/install | bash" },
  { name: "Node.js", key: "node", binary: "node", hint: "https://nodejs.org" },
  { name: "Deno", key: "deno", binary: "deno", hint: "curl -fsSL https://deno.land/install.sh | sh" },
  { name: "pnpm", key: "pnpm", binary: "pnpm", hint: "npm install -g pnpm" },
  { name: "Docker", key: "docker", binary: "docker", hint: "https://docker.com" },
  { name: "AWS CLI", key: "aws", binary: "aws", hint: "brew install awscli" },
  { name: "Google Cloud", key: "gcloud", binary: "gcloud", hint: "brew install google-cloud-sdk" },
  { name: "Azure CLI", key: "az", binary: "az", hint: "brew install azure-cli" },
  { name: "Terraform", key: "terraform", binary: "terraform", hint: "brew install terraform" },
  { name: "kubectl", key: "kubectl", binary: "kubectl", hint: "brew install kubectl" },
  { name: "Sentry CLI", key: "sentry-cli", binary: "sentry-cli", hint: "brew install getsentry/tools/sentry-cli" },
  { name: "Fly.io", key: "flyctl", binary: "flyctl", hint: "brew install flyctl" },
  { name: "Railway", key: "railway", binary: "railway", hint: "npm install -g @railway/cli" },
  { name: "Vercel", key: "vercel", binary: "vercel", hint: "npm install -g vercel" },
  { name: "Netlify", key: "netlify", binary: "netlify", hint: "npm install -g netlify-cli" },
]

const API_KEYS: ApiKeyDef[] = [
  { name: "Anthropic", key: "anthropic", envVars: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"] },
  { name: "OpenAI", key: "openai", envVars: ["OPENAI_API_KEY"] },
  { name: "OpenRouter", key: "openrouter", envVars: ["OPENROUTER_API_KEY"] },
  { name: "Cloudflare", key: "cloudflare", envVars: ["CLOUDFLARE_API_TOKEN", "CF_API_TOKEN"] },
  { name: "GitHub Token", key: "github-token", envVars: ["GITHUB_TOKEN", "GH_TOKEN"] },
  { name: "Sentry", key: "sentry", envVars: ["SENTRY_AUTH_TOKEN", "SENTRY_DSN"] },
  { name: "Vercel", key: "vercel-token", envVars: ["VERCEL_TOKEN"] },
  { name: "Netlify", key: "netlify-token", envVars: ["NETLIFY_AUTH_TOKEN"] },
  { name: "AWS", key: "aws", envVars: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"] },
  { name: "Google Cloud", key: "gcloud", envVars: ["GOOGLE_APPLICATION_CREDENTIALS", "GCLOUD_PROJECT", "GOOGLE_CLOUD_PROJECT"] },
  { name: "Stripe", key: "stripe", envVars: ["STRIPE_SECRET_KEY", "STRIPE_API_KEY"] },
  { name: "Supabase", key: "supabase", envVars: ["SUPABASE_SERVICE_KEY", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"] },
  { name: "Railway", key: "railway-token", envVars: ["RAILWAY_TOKEN"] },
  { name: "Fly.io", key: "fly", envVars: ["FLY_API_TOKEN"] },
  { name: "Resend", key: "resend", envVars: ["RESEND_API_KEY"] },
  { name: "Postmark", key: "postmark", envVars: ["POSTMARK_API_TOKEN", "POSTMARK_SERVER_API_TOKEN"] },
  { name: "SendGrid", key: "sendgrid", envVars: ["SENDGRID_API_KEY"] },
  { name: "Twilio", key: "twilio", envVars: ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN"] },
  { name: "Database URL", key: "database-url", envVars: ["DATABASE_URL"] },
  { name: "Redis", key: "redis", envVars: ["REDIS_URL"] },
  { name: "Algolia", key: "algolia", envVars: ["ALGOLIA_ADMIN_API_KEY", "ALGOLIA_API_KEY"] },
]

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Check if a CLI binary exists on PATH using `which` / `where` (non-blocking) */
async function isBinaryPresent(binary: string, shellEnv: Record<string, string>): Promise<boolean> {
  try {
    const whichCmd = isWindows() ? "where" : "which"
    await execFileAsync(whichCmd, [binary], { env: shellEnv, timeout: 3000 })
    return true
  } catch {
    return false
  }
}

/**
 * Parse a .env file without evaluating it.
 * Returns a set of key names that have a non-empty value.
 * Handles comments, quoted values, and blank lines safely.
 */
function parseEnvFile(filePath: string): Set<string> {
  const keys = new Set<string>()
  try {
    const content = fs.readFileSync(filePath, "utf8")
    for (const rawLine of content.split("\n")) {
      const line = rawLine.trim()
      // Skip comments and blank lines
      if (!line || line.startsWith("#")) continue
      const eqIdx = line.indexOf("=")
      if (eqIdx <= 0) continue
      // Strip optional `export ` prefix (common in many .env files)
      const key = line.substring(0, eqIdx).trim().replace(/^export\s+/, "")
      const rawValue = line.substring(eqIdx + 1).trim()
      // Strip surrounding quotes
      const value = rawValue.replace(/^(['"`])(.*)\1$/, "$2").trim()
      if (key && value) {
        keys.add(key)
      }
    }
  } catch {
    // File doesn't exist or isn't readable — that's fine
  }
  return keys
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const envToolsRouter = router({
  check: publicProcedure
    .input(
      z.object({
        projectPath: z
          .string()
          .optional()
          .refine((p) => !p || path.isAbsolute(p), { message: "projectPath must be absolute" }),
      })
    )
    .query(async ({ input }) => {
      // Load shell env (cached after first call)
      const shellEnv = getClaudeShellEnvironment()

      // Parse project .env files (no shell eval)
      const projectEnvKeys = new Set<string>()
      if (input.projectPath) {
        for (const file of [".env", ".env.local"]) {
          const envPath = path.join(input.projectPath, file)
          for (const key of parseEnvFile(envPath)) {
            projectEnvKeys.add(key)
          }
        }
      }

      // Check CLI tools (run in parallel)
      const cliTools = await Promise.all(
        CLI_TOOLS.map(async (tool) => ({
          name: tool.name,
          key: tool.key,
          present: isBinaryPresent(tool.binary, shellEnv),
          hint: tool.hint,
        }))
      )

      // Check API keys (synchronous env var lookups)
      const apiKeys = API_KEYS.map((apiKey) => {
        // Check shell env first
        const shellMatch = apiKey.envVars.find(
          (v) => shellEnv[v] && shellEnv[v].trim().length > 0
        )
        if (shellMatch) {
          return { name: apiKey.name, key: apiKey.key, present: true, source: "shell" as const }
        }

        // Check project .env files
        const projectMatch = apiKey.envVars.find((v) => projectEnvKeys.has(v))
        if (projectMatch) {
          return { name: apiKey.name, key: apiKey.key, present: true, source: "project-env" as const }
        }

        return { name: apiKey.name, key: apiKey.key, present: false, source: null }
      })

      return { cliTools, apiKeys }
    }),
})
