/**
 * Auto-detect workspace sections by scanning project directory structure.
 */

import * as fs from "node:fs/promises"
import * as path from "node:path"
import type { WorkspaceSection, SectionsConfig } from "../../../shared/section-types"

// ─── Detection rules ───────────────────────────────────────────────────────

interface DetectionRule {
  id: string
  name: string
  icon: string
  color: string
  /** Directories or files whose presence triggers this section */
  indicators: string[]
  /** Glob patterns to assign to the section */
  patterns: string[]
}

const DETECTION_RULES: DetectionRule[] = [
  {
    id: "frontend",
    name: "Frontend",
    icon: "Monitor",
    color: "text-blue-500",
    indicators: [
      "src/renderer",
      "src/client",
      "src/app",
      "app",
      "pages",
      "components",
      "public",
    ],
    patterns: [
      "src/renderer/**",
      "src/client/**",
      "src/app/**",
      "app/**",
      "pages/**",
      "components/**",
      "public/**",
    ],
  },
  {
    id: "backend",
    name: "Backend",
    icon: "Server",
    color: "text-green-500",
    indicators: [
      "src/main",
      "src/server",
      "server",
      "api",
    ],
    patterns: [
      "src/main/**",
      "src/server/**",
      "server/**",
      "api/**",
    ],
  },
  {
    id: "preload",
    name: "Preload",
    icon: "Plug",
    color: "text-purple-500",
    indicators: ["src/preload"],
    patterns: ["src/preload/**"],
  },
  {
    id: "api",
    name: "API Routes",
    icon: "Route",
    color: "text-orange-500",
    indicators: [
      "src/main/lib/trpc",
      "src/server/api",
      "api/routes",
      "routes",
    ],
    patterns: [
      "src/main/lib/trpc/**",
      "src/server/api/**",
      "api/routes/**",
      "routes/**",
    ],
  },
  {
    id: "contracts",
    name: "Smart Contracts",
    icon: "FileCode",
    color: "text-yellow-500",
    indicators: [
      "contracts",
      "hardhat.config.ts",
      "hardhat.config.js",
      "foundry.toml",
      "truffle-config.js",
    ],
    patterns: ["contracts/**", "test/contracts/**"],
  },
  {
    id: "abi",
    name: "ABI",
    icon: "Braces",
    color: "text-amber-500",
    indicators: ["abi", "abis", "artifacts/contracts"],
    patterns: ["abi/**", "abis/**", "artifacts/**"],
  },
  {
    id: "database",
    name: "Database",
    icon: "Database",
    color: "text-cyan-500",
    indicators: [
      "drizzle",
      "prisma",
      "migrations",
      "src/main/lib/db",
      "src/server/db",
      "db",
    ],
    patterns: [
      "drizzle/**",
      "prisma/**",
      "migrations/**",
      "src/main/lib/db/**",
      "src/server/db/**",
      "db/**",
    ],
  },
  {
    id: "shared",
    name: "Shared",
    icon: "Share2",
    color: "text-indigo-500",
    indicators: ["src/shared", "shared", "lib/shared"],
    patterns: ["src/shared/**", "shared/**", "lib/shared/**"],
  },
  {
    id: "scripts",
    name: "Scripts",
    icon: "Terminal",
    color: "text-gray-500",
    indicators: ["scripts", "tools", "bin"],
    patterns: ["scripts/**", "tools/**", "bin/**"],
  },
  {
    id: "tests",
    name: "Tests",
    icon: "TestTube2",
    color: "text-emerald-500",
    indicators: ["tests", "__tests__", "test", "spec"],
    patterns: [
      "tests/**",
      "__tests__/**",
      "test/**",
      "spec/**",
      "**/*.test.*",
      "**/*.spec.*",
    ],
  },
  {
    id: "docs",
    name: "Documentation",
    icon: "BookOpen",
    color: "text-teal-500",
    indicators: ["docs", "documentation"],
    patterns: ["docs/**", "documentation/**", "*.md"],
  },
  {
    id: "config",
    name: "Config",
    icon: "Settings",
    color: "text-slate-500",
    indicators: [], // Always detected — we check for root config files
    patterns: [
      "*.config.*",
      "tsconfig*",
      ".eslintrc*",
      ".prettierrc*",
      ".env*",
      "package.json",
    ],
  },
  {
    id: "cicd",
    name: "CI/CD",
    icon: "GitBranch",
    color: "text-pink-500",
    indicators: [".github", ".circleci", ".gitlab-ci.yml"],
    patterns: [".github/**", ".circleci/**", ".gitlab-ci.yml"],
  },
]

// ─── Detection logic ───────────────────────────────────────────────────────

/**
 * Scan the project directory (top 2 levels) and return detected sections.
 * All sections default to enabled.
 */
export async function detectSections(projectPath: string): Promise<SectionsConfig> {
  // Collect existing entries (directories and files) at top 2 levels
  const entries = new Set<string>()

  try {
    const topLevel = await fs.readdir(projectPath, { withFileTypes: true })
    for (const entry of topLevel) {
      entries.add(entry.name)
      // Scan one level deeper for directories
      if (entry.isDirectory() && !entry.name.startsWith(".") || entry.name === ".github" || entry.name === ".circleci") {
        try {
          const secondLevel = await fs.readdir(path.join(projectPath, entry.name), { withFileTypes: true })
          for (const sub of secondLevel) {
            entries.add(`${entry.name}/${sub.name}`)
            // One more level for deeply nested patterns like src/main/lib/db
            if (sub.isDirectory()) {
              try {
                const thirdLevel = await fs.readdir(path.join(projectPath, entry.name, sub.name), { withFileTypes: true })
                for (const deep of thirdLevel) {
                  entries.add(`${entry.name}/${sub.name}/${deep.name}`)
                }
              } catch {
                // Permission denied or similar — skip
              }
            }
          }
        } catch {
          // Permission denied or similar — skip
        }
      }
    }
  } catch (err) {
    console.error(`[sections] Failed to scan project directory: ${err}`)
    return { version: 1, sections: [], autoDetected: true }
  }

  const sections: WorkspaceSection[] = []

  for (const rule of DETECTION_RULES) {
    // Config section is always included if there are any config files at root
    if (rule.id === "config") {
      const hasConfigFiles = [...entries].some(
        (e) =>
          e.endsWith(".config.ts") ||
          e.endsWith(".config.js") ||
          e.endsWith(".config.mjs") ||
          e.startsWith("tsconfig") ||
          e === "package.json" ||
          e.startsWith(".env"),
      )
      if (hasConfigFiles) {
        sections.push({
          id: rule.id,
          name: rule.name,
          patterns: rule.patterns,
          enabled: true,
          icon: rule.icon,
          color: rule.color,
        })
      }
      continue
    }

    // Check if any indicator is present
    const matched = rule.indicators.some((indicator) => entries.has(indicator))
    if (matched) {
      // Only include patterns whose base directory actually exists
      const validPatterns = rule.patterns.filter((pattern) => {
        const base = pattern.split("/")[0]
        return entries.has(base) || entries.has(base.replace("**", ""))
      })
      if (validPatterns.length > 0) {
        sections.push({
          id: rule.id,
          name: rule.name,
          patterns: validPatterns,
          enabled: true,
          icon: rule.icon,
          color: rule.color,
        })
      }
    }
  }

  return { version: 1, sections, autoDetected: true }
}
