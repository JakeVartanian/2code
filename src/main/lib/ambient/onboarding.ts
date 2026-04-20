/**
 * Rapid onboarding scan — builds initial project brain for new projects.
 * Analyzes file tree, config files, git history, and README to bootstrap
 * 5-10 foundational memories in ALWAYS/NEVER/Applies-to directive format.
 *
 * Cost: ~$0.05 (one Sonnet call)
 * Time: ~30 seconds
 */

import { existsSync, readFileSync, readdirSync, statSync } from "fs"
import { join, extname } from "path"
import { execSync } from "child_process"
import type { AmbientProvider } from "./provider"

export interface OnboardingResult {
  memoriesCreated: number
  sources: string[]
  durationMs: number
}

interface ProjectSignals {
  fileTree: string
  packageJson: string | null
  tsconfig: string | null
  readme: string | null
  gitLog: string | null
  eslintConfig: string | null
  ciWorkflows: string[]
  testPatterns: string[]
  entryPoints: string[]
}

const ONBOARDING_SYSTEM_PROMPT = `You are analyzing a software project to create foundational knowledge memories. Your output will be injected into AI coding sessions so Claude automatically follows this project's patterns.

Write 5-10 memories in this EXACT JSON format:
[
  {
    "category": "architecture|convention|deployment|debugging|preference|gotcha",
    "title": "Short descriptive title (max 80 chars)",
    "content": "ALWAYS: [pattern to follow]\\nNEVER: [anti-pattern to avoid]\\nApplies to: [file globs or areas]",
    "linkedFiles": ["path/to/relevant/file.ts"]
  }
]

Guidelines:
- Focus on project-specific patterns, NOT general programming facts
- Use ALWAYS/NEVER/Applies-to format so the knowledge is actionable as instructions
- Categories: "architecture" for system design, "convention" for code style, "deployment" for build/CI, "gotcha" for pitfalls
- Include file paths that demonstrate the pattern
- Be specific to THIS project (reference actual file names, frameworks, patterns you observe)`

/**
 * Run a rapid onboarding scan on a new project.
 * Returns the number of memories created.
 */
export async function runOnboardingScan(
  projectId: string,
  projectPath: string,
  provider: AmbientProvider,
  writeMemory: (memory: { category: string; title: string; content: string; linkedFiles: string[] }) => void,
): Promise<OnboardingResult> {
  const start = Date.now()
  const sources: string[] = []

  // Gather project signals (all local, free)
  const signals = gatherProjectSignals(projectPath)

  if (signals.packageJson) sources.push("package.json")
  if (signals.tsconfig) sources.push("tsconfig")
  if (signals.readme) sources.push("README")
  if (signals.gitLog) sources.push("git-history")
  if (signals.eslintConfig) sources.push("eslint")
  if (signals.ciWorkflows.length > 0) sources.push("CI")

  // Build user prompt from signals
  const userPrompt = buildOnboardingPrompt(signals)

  // One Sonnet call to synthesize everything
  let memoriesCreated = 0
  try {
    const result = await provider.callSonnet(ONBOARDING_SYSTEM_PROMPT, userPrompt)

    // Parse memories from response
    const memories = parseMemories(result.text)

    for (const memory of memories) {
      writeMemory(memory)
      memoriesCreated++
    }
  } catch (err) {
    console.error("[Ambient] Onboarding scan failed:", err)
  }

  return {
    memoriesCreated,
    sources,
    durationMs: Date.now() - start,
  }
}

function gatherProjectSignals(projectPath: string): ProjectSignals {
  return {
    fileTree: getShallowFileTree(projectPath, 3),
    packageJson: readIfExists(join(projectPath, "package.json"), 2000),
    tsconfig: readIfExists(join(projectPath, "tsconfig.json"), 1000),
    readme: readIfExists(join(projectPath, "README.md"), 2000),
    gitLog: getGitLog(projectPath, 30),
    eslintConfig: readIfExists(join(projectPath, ".eslintrc.json"), 500)
      ?? readIfExists(join(projectPath, ".eslintrc.js"), 500)
      ?? readIfExists(join(projectPath, "eslint.config.js"), 500),
    ciWorkflows: getCIWorkflows(projectPath),
    testPatterns: detectTestPatterns(projectPath),
    entryPoints: detectEntryPoints(projectPath),
  }
}

function buildOnboardingPrompt(signals: ProjectSignals): string {
  let prompt = "# Project Analysis\n\n"

  prompt += "## File Structure (3 levels)\n```\n" + signals.fileTree + "\n```\n\n"

  if (signals.packageJson) {
    prompt += "## package.json\n```json\n" + signals.packageJson + "\n```\n\n"
  }

  if (signals.tsconfig) {
    prompt += "## tsconfig.json\n```json\n" + signals.tsconfig + "\n```\n\n"
  }

  if (signals.readme) {
    prompt += "## README.md (truncated)\n" + signals.readme + "\n\n"
  }

  if (signals.gitLog) {
    prompt += "## Recent git history (30 commits)\n```\n" + signals.gitLog + "\n```\n\n"
  }

  if (signals.eslintConfig) {
    prompt += "## Lint config\n```\n" + signals.eslintConfig + "\n```\n\n"
  }

  if (signals.ciWorkflows.length > 0) {
    prompt += "## CI Workflows\n" + signals.ciWorkflows.join("\n---\n") + "\n\n"
  }

  if (signals.testPatterns.length > 0) {
    prompt += "## Test patterns detected\n" + signals.testPatterns.join(", ") + "\n\n"
  }

  if (signals.entryPoints.length > 0) {
    prompt += "## Entry points\n" + signals.entryPoints.join(", ") + "\n\n"
  }

  // Cap total prompt size to prevent excessive token usage
  if (prompt.length > 15000) {
    prompt = prompt.slice(0, 15000) + "\n\n[...analysis truncated for token budget]"
  }

  return prompt
}

function parseMemories(text: string): Array<{ category: string; title: string; content: string; linkedFiles: string[] }> {
  try {
    const jsonMatch = text.match(/\[[\s\S]*\]/)
    if (!jsonMatch) return []

    const parsed = JSON.parse(jsonMatch[0])
    if (!Array.isArray(parsed)) return []

    const validCategories = new Set(["architecture", "convention", "deployment", "debugging", "preference", "gotcha"])

    return parsed
      .filter((m: any) => m.title && m.content && validCategories.has(m.category))
      .slice(0, 10) // Max 10 memories
      .map((m: any) => ({
        category: m.category,
        title: String(m.title).slice(0, 100),
        content: String(m.content),
        linkedFiles: Array.isArray(m.linkedFiles) ? m.linkedFiles.filter((f: any) => typeof f === "string") : [],
      }))
  } catch {
    console.warn("[Ambient] Failed to parse onboarding memories")
    return []
  }
}

// ============ UTILITY FUNCTIONS ============

function readIfExists(path: string, maxChars?: number): string | null {
  if (!existsSync(path)) return null
  try {
    let content = readFileSync(path, "utf-8")
    if (maxChars && content.length > maxChars) {
      content = content.slice(0, maxChars) + "\n[...truncated]"
    }
    return content
  } catch {
    return null
  }
}

function getShallowFileTree(dir: string, maxDepth: number, prefix = "", depth = 0): string {
  if (depth >= maxDepth) return ""

  const SKIP = new Set(["node_modules", ".git", "dist", "build", ".next", "coverage", "__pycache__", "vendor", ".cache"])
  const lines: string[] = []

  try {
    const entries = readdirSync(dir).sort().slice(0, 100) // Cap width to prevent massive trees
    for (const entry of entries) {
      if (SKIP.has(entry)) continue
      if (entry.startsWith(".") && depth === 0 && entry !== ".github") continue

      const fullPath = join(dir, entry)
      try {
        const stat = statSync(fullPath)
        if (stat.isDirectory()) {
          lines.push(`${prefix}${entry}/`)
          const subtree = getShallowFileTree(fullPath, maxDepth, prefix + "  ", depth + 1)
          if (subtree) lines.push(subtree)
        } else {
          lines.push(`${prefix}${entry}`)
        }
      } catch { continue }
    }
  } catch { /* unreadable dir */ }

  return lines.join("\n")
}

function getGitLog(projectPath: string, count: number): string | null {
  try {
    return execSync(
      `git log --oneline --no-decorate -${count}`,
      { cwd: projectPath, encoding: "utf-8", timeout: 5000 }
    ).trim()
  } catch {
    return null
  }
}

function getCIWorkflows(projectPath: string): string[] {
  const workflowDir = join(projectPath, ".github", "workflows")
  if (!existsSync(workflowDir)) return []

  try {
    return readdirSync(workflowDir)
      .filter(f => f.endsWith(".yml") || f.endsWith(".yaml"))
      .slice(0, 3) // Max 3 workflows
      .map(f => {
        const content = readIfExists(join(workflowDir, f), 500)
        return content ? `### ${f}\n${content}` : ""
      })
      .filter(Boolean)
  } catch {
    return []
  }
}

function detectTestPatterns(projectPath: string): string[] {
  const patterns: string[] = []

  // Check for common test directories/patterns
  if (existsSync(join(projectPath, "__tests__"))) patterns.push("__tests__/ directory")
  if (existsSync(join(projectPath, "tests"))) patterns.push("tests/ directory")
  if (existsSync(join(projectPath, "test"))) patterns.push("test/ directory")
  if (existsSync(join(projectPath, "jest.config.ts")) || existsSync(join(projectPath, "jest.config.js"))) patterns.push("Jest")
  if (existsSync(join(projectPath, "vitest.config.ts"))) patterns.push("Vitest")
  if (existsSync(join(projectPath, "playwright.config.ts"))) patterns.push("Playwright")

  return patterns
}

function detectEntryPoints(projectPath: string): string[] {
  const candidates = [
    "src/index.ts", "src/main.ts", "src/app.ts",
    "src/main/index.ts", "src/renderer/App.tsx",
    "index.ts", "main.ts", "app.ts",
    "src/index.js", "src/main.js",
  ]

  return candidates.filter(f => existsSync(join(projectPath, f)))
}
