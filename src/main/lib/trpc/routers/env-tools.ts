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
import { getClaudeShellEnvironmentAsync } from "../../claude/env"
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
  /** Package name prefixes to look for in package.json dependencies */
  packages?: string[]
  /** Config files whose presence indicates the service is used */
  configFiles?: string[]
  /** Directory names whose presence indicates the service is used */
  configDirs?: string[]
  description?: string
  /** Dashboard URL where the user can get/manage the API key */
  setupUrl?: string
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
  { name: "Hardhat", key: "hardhat", binary: "hardhat", hint: "npm install -g hardhat" },
  { name: "Slither", key: "slither", binary: "slither", hint: "pip install slither-analyzer" },
  { name: "Mythril", key: "mythril", binary: "myth", hint: "pip install mythril" },
]

const API_KEYS: ApiKeyDef[] = [
  { name: "Anthropic", key: "anthropic", envVars: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"], packages: ["@anthropic-ai/", "anthropic"], setupUrl: "https://console.anthropic.com/settings/keys" },
  { name: "OpenAI", key: "openai", envVars: ["OPENAI_API_KEY"], packages: ["openai"], setupUrl: "https://platform.openai.com/api-keys" },
  { name: "OpenRouter", key: "openrouter", envVars: ["OPENROUTER_API_KEY"], setupUrl: "https://openrouter.ai/keys" },
  { name: "Cloudflare", key: "cloudflare", envVars: ["CLOUDFLARE_API_TOKEN", "CF_API_TOKEN"], packages: ["@cloudflare/"], configFiles: ["wrangler.toml", "wrangler.json", "wrangler.jsonc"], setupUrl: "https://dash.cloudflare.com/profile/api-tokens" },
  { name: "GitHub Token", key: "github-token", envVars: ["GITHUB_TOKEN", "GH_TOKEN"], configDirs: [".github"], setupUrl: "https://github.com/settings/tokens" },
  { name: "Sentry", key: "sentry", envVars: ["SENTRY_AUTH_TOKEN", "SENTRY_DSN"], packages: ["@sentry/"], configFiles: [".sentryclirc"], setupUrl: "https://sentry.io/settings/auth-tokens/" },
  { name: "Vercel", key: "vercel-token", envVars: ["VERCEL_TOKEN"], packages: ["@vercel/"], configFiles: ["vercel.json"], setupUrl: "https://vercel.com/account/tokens" },
  { name: "Netlify", key: "netlify-token", envVars: ["NETLIFY_AUTH_TOKEN"], configFiles: ["netlify.toml"], setupUrl: "https://app.netlify.com/user/applications#personal-access-tokens" },
  { name: "AWS", key: "aws", envVars: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"], packages: ["aws-sdk", "@aws-sdk/"], setupUrl: "https://console.aws.amazon.com/iam/home#/security_credentials" },
  { name: "Google Cloud", key: "gcloud", envVars: ["GOOGLE_APPLICATION_CREDENTIALS", "GCLOUD_PROJECT", "GOOGLE_CLOUD_PROJECT"], packages: ["@google-cloud/", "firebase", "firebase-admin"], setupUrl: "https://console.cloud.google.com/apis/credentials" },
  { name: "Stripe", key: "stripe", envVars: ["STRIPE_SECRET_KEY", "STRIPE_API_KEY"], packages: ["stripe", "@stripe/"], setupUrl: "https://dashboard.stripe.com/apikeys" },
  { name: "Supabase", key: "supabase", envVars: ["SUPABASE_SERVICE_KEY", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"], packages: ["@supabase/"], configDirs: ["supabase"], setupUrl: "https://supabase.com/dashboard" },
  { name: "Railway", key: "railway-token", envVars: ["RAILWAY_TOKEN"], configFiles: ["railway.json", "railway.toml"], setupUrl: "https://railway.com/account/tokens" },
  { name: "Fly.io", key: "fly", envVars: ["FLY_API_TOKEN"], configFiles: ["fly.toml"], setupUrl: "https://fly.io/user/personal_access_tokens" },
  { name: "Resend", key: "resend", envVars: ["RESEND_API_KEY"], packages: ["resend"], setupUrl: "https://resend.com/api-keys" },
  { name: "Postmark", key: "postmark", envVars: ["POSTMARK_API_TOKEN", "POSTMARK_SERVER_API_TOKEN"], packages: ["postmark"], setupUrl: "https://account.postmarkapp.com/api_tokens" },
  { name: "SendGrid", key: "sendgrid", envVars: ["SENDGRID_API_KEY"], packages: ["@sendgrid/"], setupUrl: "https://app.sendgrid.com/settings/api_keys" },
  { name: "Twilio", key: "twilio", envVars: ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN"], packages: ["twilio"], setupUrl: "https://console.twilio.com" },
  { name: "Database URL", key: "database-url", envVars: ["DATABASE_URL"], packages: ["prisma", "@prisma/client", "drizzle-orm", "knex", "sequelize", "typeorm"], configFiles: ["prisma/schema.prisma"] },
  { name: "Redis", key: "redis", envVars: ["REDIS_URL"], packages: ["redis", "ioredis", "bullmq"] },
  { name: "Algolia", key: "algolia", envVars: ["ALGOLIA_ADMIN_API_KEY", "ALGOLIA_API_KEY"], packages: ["algoliasearch", "@algolia/"], setupUrl: "https://dashboard.algolia.com/account/api-keys/" },
  { name: "Hardhat", key: "hardhat", envVars: ["HARDHAT_NETWORK"], packages: ["hardhat", "@nomicfoundation/hardhat-toolbox"], configFiles: ["hardhat.config.ts", "hardhat.config.js"] },
  { name: "Foundry", key: "foundry", envVars: ["FOUNDRY_PROFILE"], configFiles: ["foundry.toml"], configDirs: ["lib/forge-std"] },
  { name: "Alchemy", key: "alchemy", envVars: ["ALCHEMY_API_KEY", "ALCHEMY_URL"], packages: ["alchemy-sdk", "@alch/alchemy-sdk"], setupUrl: "https://dashboard.alchemy.com/" },
  { name: "Infura", key: "infura", envVars: ["INFURA_API_KEY", "INFURA_PROJECT_ID"], packages: ["@infura/sdk"], setupUrl: "https://app.infura.io/dashboard" },
  { name: "Etherscan", key: "etherscan", envVars: ["ETHERSCAN_API_KEY"], packages: ["@nomicfoundation/hardhat-verify"], setupUrl: "https://etherscan.io/myapikey" },
]

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Check if a CLI binary exists on PATH using `which` / `where` (non-blocking) */
async function isBinaryPresent(binary: string, shellEnv: Record<string, string>): Promise<boolean> {
  try {
    const whichCmd = isWindows() ? "where" : "which"
    await execFileAsync(whichCmd, [binary], { env: shellEnv, timeout: 1500 })
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

/**
 * Detect which services a project uses by checking package.json deps,
 * config files/dirs, and CLAUDE.md mentions.
 */
function detectProjectServices(projectPath: string): Set<string> {
  const detected = new Set<string>()

  // Read package.json dependencies
  let allDeps: string[] = []
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(projectPath, "package.json"), "utf8"))
    allDeps = Object.keys({
      ...pkg.dependencies,
      ...pkg.devDependencies,
      ...pkg.peerDependencies,
    })
  } catch {
    // No package.json or invalid — skip
  }

  // Read CLAUDE.md content for keyword matching
  let claudeMd = ""
  try {
    claudeMd = fs.readFileSync(path.join(projectPath, "CLAUDE.md"), "utf8").toLowerCase()
  } catch {
    // No CLAUDE.md — skip
  }

  for (const apiKey of API_KEYS) {
    // Check package.json dependencies
    if (apiKey.packages?.length) {
      const found = apiKey.packages.some((pkg) =>
        pkg.endsWith("/")
          ? allDeps.some((dep) => dep.startsWith(pkg) || dep === pkg.slice(0, -1))
          : allDeps.includes(pkg)
      )
      if (found) {
        detected.add(apiKey.key)
        continue
      }
    }

    // Check config files
    if (apiKey.configFiles?.length) {
      const found = apiKey.configFiles.some((f) => {
        try {
          fs.accessSync(path.join(projectPath, f), fs.constants.F_OK)
          return true
        } catch {
          return false
        }
      })
      if (found) {
        detected.add(apiKey.key)
        continue
      }
    }

    // Check config directories
    if (apiKey.configDirs?.length) {
      const found = apiKey.configDirs.some((d) => {
        try {
          const stat = fs.statSync(path.join(projectPath, d))
          return stat.isDirectory()
        } catch {
          return false
        }
      })
      if (found) {
        detected.add(apiKey.key)
        continue
      }
    }

    // Check CLAUDE.md mentions (case-insensitive, whole word-ish)
    if (claudeMd) {
      const name = apiKey.name.toLowerCase()
      if (claudeMd.includes(name)) {
        detected.add(apiKey.key)
      }
    }
  }

  return detected
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
      // Load shell env with a 3s timeout fallback to process.env.
      // On first call (cache cold), spawning a login shell can take several seconds.
      const shellEnvFallback = Object.fromEntries(
        Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined)
      )
      const shellEnv = await Promise.race([
        getClaudeShellEnvironmentAsync(),
        new Promise<Record<string, string>>((resolve) => setTimeout(() => resolve(shellEnvFallback), 3000)),
      ])

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

      // Detect services used by the project (package.json, config files, CLAUDE.md)
      const projectDetected = input.projectPath
        ? detectProjectServices(input.projectPath)
        : new Set<string>()

      // Check CLI tools (run in parallel, 1.5s timeout per binary)
      const cliTools = await Promise.all(
        CLI_TOOLS.map(async (tool) => ({
          name: tool.name,
          key: tool.key,
          present: await isBinaryPresent(tool.binary, shellEnv),
          hint: tool.hint,
        }))
      )

      // Check API keys (synchronous env var lookups)
      const apiKeys = API_KEYS.map((apiKey) => {
        const detected = projectDetected.has(apiKey.key)
        const base = {
          name: apiKey.name,
          key: apiKey.key,
          detected,
          envVars: apiKey.envVars,
          setupUrl: apiKey.setupUrl ?? null,
        }

        // Check shell env first
        const shellMatch = apiKey.envVars.find(
          (v) => shellEnv[v] && shellEnv[v].trim().length > 0
        )
        if (shellMatch) {
          return { ...base, present: true, source: "shell" as const }
        }

        // Check project .env files
        const projectMatch = apiKey.envVars.find((v) => projectEnvKeys.has(v))
        if (projectMatch) {
          return { ...base, present: true, source: "project-env" as const }
        }

        return { ...base, present: false, source: null }
      })

      return { cliTools, apiKeys }
    }),
})
