/**
 * Maps file paths to human-readable descriptions and detects critical files.
 * Pure utility — no React dependencies.
 */

export interface FileDescription {
  /** e.g., "Modified the main chat component" */
  humanReadable: string
  /** Whether this file warrants red highlighting */
  isCritical: boolean
  /** e.g., "Database schema change" — shown as tooltip */
  criticalReason?: string
}

// ─── Critical file patterns ────────────────────────────────────────────────

interface CriticalPattern {
  test: (path: string) => boolean
  reason: string
}

const CRITICAL_PATTERNS: CriticalPattern[] = [
  // Package / dependency files
  { test: (p) => /^package\.json$/.test(basename(p)), reason: "Dependency changes" },
  { test: (p) => /^(bun\.lockb|package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/.test(basename(p)), reason: "Lock file changed" },
  // Environment / secrets
  { test: (p) => /\.env($|\.)/.test(basename(p)), reason: "Environment config" },
  { test: (p) => /secret|credential/i.test(p), reason: "Security-sensitive file" },
  // Database
  { test: (p) => p.includes("db/schema"), reason: "Database schema change" },
  { test: (p) => /^drizzle\//.test(p), reason: "Database migration" },
  { test: (p) => /^prisma\//.test(p), reason: "Database schema" },
  // Build / config
  { test: (p) => /^(electron\.vite|vite|webpack|rollup|esbuild)\.config/.test(basename(p)), reason: "Build configuration" },
  { test: (p) => /^tsconfig/.test(basename(p)), reason: "TypeScript configuration" },
  { test: (p) => /^tailwind\.config/.test(basename(p)), reason: "Tailwind configuration" },
  // Auth / security
  { test: (p) => /auth[-.]/.test(basename(p)), reason: "Authentication logic" },
  { test: (p) => p.includes("claude-token"), reason: "Token handling" },
  // Scripts
  { test: (p) => /^scripts\//.test(p), reason: "Build/deploy script" },
  // AI instruction files
  { test: (p) => /^(CLAUDE|AGENTS|CURSOR)\.md$/i.test(basename(p)), reason: "AI instruction file" },
  { test: (p) => /^\.(cursorrules|clinerules)$/.test(basename(p)), reason: "AI instruction file" },
  // Smart contracts
  { test: (p) => /\.(sol|vy)$/.test(p), reason: "Smart contract" },
  { test: (p) => /^(hardhat|foundry|truffle)\.config/.test(basename(p)), reason: "Contract build config" },
  // CI/CD
  { test: (p) => /^\.(github|circleci|gitlab)\//.test(p), reason: "CI/CD pipeline" },
  { test: (p) => /^Dockerfile$/.test(basename(p)), reason: "Container configuration" },
  { test: (p) => /^docker-compose/.test(basename(p)), reason: "Container orchestration" },
]

// ─── Human-readable description rules ──────────────────────────────────────

interface DescriptionRule {
  test: (path: string) => boolean
  label: string | ((path: string) => string)
}

const EXACT_NAME_DESCRIPTIONS: Record<string, string> = {
  "package.json": "package dependencies",
  "package-lock.json": "npm lock file",
  "bun.lockb": "bun lock file",
  "yarn.lock": "yarn lock file",
  "pnpm-lock.yaml": "pnpm lock file",
  "tsconfig.json": "TypeScript config",
  "tailwind.config.ts": "Tailwind config",
  "tailwind.config.js": "Tailwind config",
  "postcss.config.js": "PostCSS config",
  "postcss.config.cjs": "PostCSS config",
  ".gitignore": "git ignore rules",
  ".eslintrc": "ESLint config",
  ".eslintrc.js": "ESLint config",
  ".prettierrc": "Prettier config",
  "README.md": "project readme",
  "CLAUDE.md": "Claude AI instructions",
  "AGENTS.md": "agents instructions",
  "Dockerfile": "Docker container config",
  "docker-compose.yml": "Docker Compose config",
  "docker-compose.yaml": "Docker Compose config",
  ".env": "environment variables",
  ".env.local": "local environment variables",
  ".env.production": "production environment variables",
  ".env.development": "development environment variables",
}

const DIRECTORY_DESCRIPTIONS: DescriptionRule[] = [
  // Renderer / frontend
  { test: (p) => p.includes("renderer/components/ui/"), label: "UI component" },
  { test: (p) => p.includes("renderer/components/"), label: "shared component" },
  { test: (p) => p.includes("renderer/features/"), label: (p) => {
    const match = p.match(/features\/([^/]+)/)
    return match ? `${match[1]} feature` : "feature module"
  }},
  { test: (p) => p.includes("renderer/lib/"), label: "frontend utility" },
  { test: (p) => p.includes("renderer/"), label: "frontend module" },
  // Main process / backend
  { test: (p) => p.includes("main/lib/db/schema"), label: "database schema" },
  { test: (p) => p.includes("main/lib/db/"), label: "database module" },
  { test: (p) => p.includes("main/lib/trpc/routers/"), label: "API route" },
  { test: (p) => p.includes("main/lib/trpc/"), label: "API infrastructure" },
  { test: (p) => p.includes("main/lib/sections/"), label: "sections module" },
  { test: (p) => p.includes("main/lib/git/"), label: "git operations" },
  { test: (p) => p.includes("main/lib/claude/"), label: "Claude integration" },
  { test: (p) => p.includes("main/lib/"), label: "backend utility" },
  { test: (p) => p.includes("main/"), label: "backend module" },
  // Preload
  { test: (p) => p.includes("preload/"), label: "IPC bridge" },
  // Shared
  { test: (p) => p.includes("shared/"), label: "shared type" },
  // Tests
  { test: (p) => /\.(test|spec)\.(ts|tsx|js|jsx)$/.test(p), label: "test file" },
  { test: (p) => /^(tests|__tests__)\//.test(p), label: "test file" },
  // Drizzle migrations
  { test: (p) => /^drizzle\//.test(p), label: "database migration" },
  // Scripts
  { test: (p) => /^scripts\//.test(p), label: "build/deploy script" },
  // Docs
  { test: (p) => /^docs\//.test(p), label: "documentation" },
  // Smart contracts
  { test: (p) => /^contracts\//.test(p), label: "smart contract" },
  { test: (p) => /^abi\//.test(p), label: "contract ABI" },
  // CI/CD
  { test: (p) => /^\.(github|circleci|gitlab)\//.test(p), label: "CI/CD config" },
  // Config files
  { test: (p) => /\.config\.(ts|js|mjs|cjs)$/.test(p), label: "config file" },
]

// ─── Extension fallback ────────────────────────────────────────────────────

const EXTENSION_LABELS: Record<string, string> = {
  ".tsx": "React component",
  ".jsx": "React component",
  ".ts": "TypeScript module",
  ".js": "JavaScript module",
  ".css": "stylesheet",
  ".scss": "stylesheet",
  ".html": "HTML page",
  ".json": "JSON data",
  ".yaml": "YAML config",
  ".yml": "YAML config",
  ".md": "documentation",
  ".sql": "SQL query",
  ".sol": "Solidity contract",
  ".vy": "Vyper contract",
  ".py": "Python module",
  ".rs": "Rust module",
  ".go": "Go module",
  ".sh": "shell script",
  ".svg": "SVG image",
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function basename(p: string): string {
  const idx = p.lastIndexOf("/")
  return idx === -1 ? p : p.slice(idx + 1)
}

function extension(p: string): string {
  const name = basename(p)
  const idx = name.lastIndexOf(".")
  return idx <= 0 ? "" : name.slice(idx)
}

/** Derive a short, human-friendly name from the filename (strip extension, un-kebab). */
function friendlyName(p: string): string {
  const name = basename(p)
  const ext = extension(p)
  const bare = ext ? name.slice(0, -ext.length) : name
  // "active-chat" -> "active chat", "AuthManager" -> "AuthManager"
  return bare.replace(/[-_]/g, " ")
}

function actionVerb(additions: number, deletions: number): string {
  if (additions > 0 && deletions === 0) return "Added"
  if (deletions > 0 && additions === 0) return "Removed"
  return "Modified"
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Generate a human-readable description and critical flag for a file path.
 *
 * @param displayPath Relative path (e.g., "src/renderer/features/agents/main/active-chat.tsx")
 * @param additions   Lines added
 * @param deletions   Lines removed
 */
export function describeFile(
  displayPath: string,
  additions: number,
  deletions: number,
): FileDescription {
  const verb = actionVerb(additions, deletions)
  const name = basename(displayPath)

  // 1. Check exact filename matches
  const exactLabel = EXACT_NAME_DESCRIPTIONS[name]
  if (exactLabel) {
    return {
      humanReadable: `${verb} ${exactLabel}`,
      ...checkCritical(displayPath),
    }
  }

  // 2. Check directory-based context
  for (const rule of DIRECTORY_DESCRIPTIONS) {
    if (rule.test(displayPath)) {
      const label = typeof rule.label === "function" ? rule.label(displayPath) : rule.label
      const friendly = friendlyName(displayPath)
      return {
        humanReadable: `${verb} ${label}: ${friendly}`,
        ...checkCritical(displayPath),
      }
    }
  }

  // 3. Extension-based fallback
  const ext = extension(displayPath)
  const extLabel = EXTENSION_LABELS[ext]
  if (extLabel) {
    const friendly = friendlyName(displayPath)
    return {
      humanReadable: `${verb} ${extLabel}: ${friendly}`,
      ...checkCritical(displayPath),
    }
  }

  // 4. Last resort
  return {
    humanReadable: `${verb} ${friendlyName(displayPath)}`,
    ...checkCritical(displayPath),
  }
}

function checkCritical(displayPath: string): { isCritical: boolean; criticalReason?: string } {
  for (const pattern of CRITICAL_PATTERNS) {
    if (pattern.test(displayPath)) {
      return { isCritical: true, criticalReason: pattern.reason }
    }
  }
  return { isCritical: false }
}
