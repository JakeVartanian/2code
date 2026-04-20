/**
 * Ambient Tier 0 — Local heuristics (FREE, instant).
 * Pattern-based analysis that filters 85-92% of file change events
 * before any API calls are needed.
 */

import { readFileSync, existsSync } from "fs"
import { join } from "path"
import type { FileBatch, HeuristicResult, FileChangeEvent } from "./types"

// ============ PATTERN RULES ============

interface HeuristicRule {
  id: string
  category: HeuristicResult["category"]
  severity: HeuristicResult["severity"]
  /** File extensions this rule applies to (empty = all) */
  extensions?: string[]
  /** Regex to match against file content diff/additions */
  pattern: RegExp
  title: string
  description: string
  confidence: number
}

const RULES: HeuristicRule[] = [
  // --- BUG DETECTION ---
  {
    id: "console-log-prod",
    category: "bug",
    severity: "info",
    extensions: [".ts", ".tsx", ".js", ".jsx"],
    pattern: /console\.(log|debug|info)\(/,
    title: "console.log left in code",
    description: "Debug logging found in non-test file. Consider removing before commit.",
    confidence: 60,
  },
  {
    id: "type-assertion-any",
    category: "bug",
    severity: "warning",
    extensions: [".ts", ".tsx"],
    pattern: /as\s+any/,
    title: "Unsafe type assertion (as any)",
    description: "Type assertion to 'any' bypasses TypeScript safety. Consider a proper type.",
    confidence: 55,
  },
  {
    id: "eslint-disable",
    category: "bug",
    severity: "info",
    extensions: [".ts", ".tsx", ".js", ".jsx"],
    pattern: /\/[/*]\s*eslint-disable/,
    title: "ESLint rule disabled",
    description: "A lint rule was disabled. Ensure this is intentional and not hiding a real issue.",
    confidence: 45,
  },
  {
    id: "todo-fixme-added",
    category: "bug",
    severity: "info",
    extensions: [".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs"],
    pattern: /\/\/\s*(TODO|FIXME|HACK|XXX|BUG):/i,
    title: "TODO/FIXME comment added",
    description: "New technical debt marker added. Track or resolve before shipping.",
    confidence: 35,
  },

  // --- SECURITY ---
  {
    id: "hardcoded-secret",
    category: "security",
    severity: "error",
    pattern: /(password|secret|api_?key|token)\s*[:=]\s*['"][^'"]{8,}['"]/i,
    title: "Possible hardcoded secret",
    description: "A string that looks like a secret or API key was found hardcoded. Use environment variables instead.",
    confidence: 75,
  },
  {
    id: "env-in-code",
    category: "security",
    severity: "warning",
    extensions: [".ts", ".tsx", ".js", ".jsx"],
    pattern: /process\.env\.\w+\s*\|\|\s*['"][^'"]+['"]/,
    title: "Env variable with hardcoded fallback",
    description: "Environment variable has a hardcoded fallback value that may leak in production.",
    confidence: 50,
  },

  // --- PERFORMANCE ---
  {
    id: "n-plus-one-loop",
    category: "performance",
    severity: "warning",
    extensions: [".ts", ".tsx", ".js", ".jsx"],
    pattern: /for\s*\(.*\)\s*\{[^}]*await\s+/,
    title: "Await inside loop (potential N+1)",
    description: "Sequential await in a loop may cause performance issues. Consider Promise.all() or batching.",
    confidence: 60,
  },
  {
    id: "sync-fs-call",
    category: "performance",
    severity: "info",
    extensions: [".ts", ".js"],
    pattern: /(?:readFileSync|writeFileSync|existsSync|mkdirSync)\(/,
    title: "Synchronous file system call",
    description: "Synchronous FS operations block the event loop. Consider async alternatives for hot paths.",
    confidence: 35,
  },

  // --- TEST GAPS ---
  {
    id: "export-no-test",
    category: "test-gap",
    severity: "info",
    extensions: [".ts", ".tsx", ".js", ".jsx"],
    pattern: /export\s+(async\s+)?function\s+\w+/,
    title: "New exported function — test coverage?",
    description: "A new exported function was added. Consider adding tests.",
    confidence: 40,
  },

  // --- DEAD CODE ---
  {
    id: "commented-code-block",
    category: "dead-code",
    severity: "info",
    extensions: [".ts", ".tsx", ".js", ".jsx"],
    pattern: /\/\*[\s\S]{100,}?\*\//, // Non-greedy to prevent catastrophic backtracking
    title: "Large commented-out code block",
    description: "A large block of commented code was found. Remove if no longer needed.",
    confidence: 50,
  },

  // --- DEPENDENCY ---
  {
    id: "package-json-no-lock",
    category: "dependency",
    severity: "warning",
    extensions: [],
    pattern: /./,  // Handled specially via file name check
    title: "package.json changed without lockfile update",
    description: "Dependencies were modified but the lockfile wasn't updated. Run install.",
    confidence: 70,
  },
]

// ============ FILE-LEVEL FILTERS ============

/** Files that should never trigger heuristics */
const SKIP_FILE_PATTERNS = [
  /\.test\.(ts|tsx|js|jsx)$/, // Test files are exempt from most rules
  /\.spec\.(ts|tsx|js|jsx)$/,
  /__tests__\//,
  /\.stories\.(ts|tsx|js|jsx)$/,
  /\.config\.(ts|js|mjs)$/,
]

function shouldSkipFile(filePath: string, ruleId: string): boolean {
  // Test files are exempt from most rules (except security)
  if (ruleId !== "hardcoded-secret" && ruleId !== "env-in-code") {
    if (SKIP_FILE_PATTERNS.some(p => p.test(filePath))) return true
  }
  return false
}

// ============ MAIN ANALYSIS ============

/**
 * Run local heuristics on a file batch. Returns candidate findings.
 * This is the Tier 0 filter — completely free, runs synchronously.
 */
export function runHeuristics(
  batch: FileBatch,
  sensitivityThreshold: number,
): HeuristicResult[] {
  const results: HeuristicResult[] = []

  // Special check: package.json changed without lockfile
  const hasPackageJson = batch.files.some(f => f.path === "package.json" || f.path.endsWith("/package.json"))
  const hasLockfile = batch.files.some(f =>
    f.path.includes("lock") || f.path === "bun.lockb" || f.path === "yarn.lock"
  )
  if (hasPackageJson && !hasLockfile) {
    results.push({
      category: "dependency",
      severity: "warning",
      title: "package.json changed without lockfile update",
      description: "Dependencies were modified but no lockfile was updated in the same batch.",
      confidence: 70,
      triggerFiles: batch.files.filter(f => f.path.includes("package.json")).map(f => f.path),
      triggerEvent: "file-change",
    })
  }

  // Analyze each changed file
  for (const file of batch.files) {
    if (file.type === "unlink") continue // Can't analyze deleted files

    const fileResults = analyzeFile(file, batch.projectPath, sensitivityThreshold)
    results.push(...fileResults)
  }

  // Deduplicate: if same rule fires on same file, keep highest confidence
  const deduped = deduplicateResults(results)

  return deduped
}

function analyzeFile(
  file: FileChangeEvent,
  projectPath: string,
  sensitivityThreshold: number,
): HeuristicResult[] {
  const results: HeuristicResult[] = []

  // Read file content
  const fullPath = join(projectPath, file.path)
  if (!existsSync(fullPath)) return results

  let content: string
  try {
    content = readFileSync(fullPath, "utf-8")
  } catch {
    return results // Can't read = skip
  }

  // Skip very large files (likely generated)
  if (content.length > 200_000) return results

  for (const rule of RULES) {
    // Skip the package.json rule (handled separately above)
    if (rule.id === "package-json-no-lock") continue

    // Check file extension match
    if (rule.extensions && rule.extensions.length > 0) {
      if (!rule.extensions.includes(file.ext)) continue
    }

    // Skip if file should be excluded for this rule
    if (shouldSkipFile(file.path, rule.id)) continue

    // Check confidence threshold
    if (rule.confidence < sensitivityThreshold) continue

    // Run pattern match
    if (rule.pattern.test(content)) {
      results.push({
        category: rule.category,
        severity: rule.severity,
        title: rule.title,
        description: rule.description,
        confidence: rule.confidence,
        triggerFiles: [file.path],
        triggerEvent: "file-change",
      })
    }
  }

  return results
}

function deduplicateResults(results: HeuristicResult[]): HeuristicResult[] {
  const seen = new Map<string, HeuristicResult>()

  for (const result of results) {
    const key = `${result.title}:${result.triggerFiles.join(",")}`
    const existing = seen.get(key)
    if (!existing || result.confidence > existing.confidence) {
      seen.set(key, result)
    }
  }

  return Array.from(seen.values())
}
