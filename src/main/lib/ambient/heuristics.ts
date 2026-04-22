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
  {
    id: "hardcoded-secret",
    category: "security",
    severity: "error",
    pattern: /(password|secret|api_?key|token)\s*[:=]\s*['"][^'"]{8,}['"]/i,
    title: "Possible hardcoded secret",
    description: "A string that looks like a secret or API key was found hardcoded. Use environment variables instead.",
    confidence: 85,
  },
  {
    id: "merge-conflict-marker",
    category: "bug",
    severity: "error",
    pattern: /^[<>=]{7}\s/m,
    title: "Merge conflict markers in source",
    description: "Unresolved merge conflict markers (<<<<<<, =======, >>>>>>>) found in file. These will cause syntax errors.",
    confidence: 95,
  },
  {
    id: "env-file-tracked",
    category: "security",
    severity: "error",
    extensions: [".env"],
    pattern: /\S/, // Any non-empty .env file
    title: ".env file may be tracked by git",
    description: "An .env file with content was detected in changes. Ensure it is in .gitignore to prevent secrets from being committed.",
    confidence: 80,
  },
  {
    id: "debugger-statement",
    category: "bug",
    severity: "warning",
    extensions: [".ts", ".tsx", ".js", ".jsx"],
    pattern: /^\s*debugger\s*;?\s*$/m,
    title: "Debugger statement left in code",
    description: "A `debugger` statement was found. This will pause execution in browsers and should be removed before shipping.",
    confidence: 90,
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
