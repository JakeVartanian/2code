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
  {
    id: "api-contract-change",
    category: "risk",
    severity: "warning",
    extensions: [".ts", ".tsx", ".js", ".jsx"],
    pattern: /export\s+(?:function|const|class|interface|type|enum)\s+\w+/,
    title: "Exported API surface changed",
    description: "An exported function, type, or class was modified. Consumers of this export may need updates.",
    confidence: 70,
  },
  {
    id: "error-swallowing",
    category: "bug",
    severity: "warning",
    extensions: [".ts", ".tsx", ".js", ".jsx"],
    pattern: /catch\s*\([^)]*\)\s*\{\s*\}/,
    title: "Empty catch block swallows errors",
    description: "An empty catch block silently swallows errors, making failures invisible. At minimum log the error.",
    confidence: 75,
  },
  // ─── Design heuristics ──────────────────────────────────────────────────
  {
    id: "hardcoded-color",
    category: "design",
    severity: "warning",
    extensions: [".css", ".scss", ".tsx", ".jsx"],
    pattern: /(?:color|background|border|fill|stroke)\s*:\s*#[0-9a-fA-F]{3,8}(?!\s*\*\/)/,
    title: "Hardcoded color value — consider using a design token",
    description: "A hex color value is hardcoded in styles instead of using a CSS variable or theme token. This makes it harder to maintain consistent branding.",
    confidence: 60,
  },
  {
    id: "hardcoded-font-size",
    category: "design",
    severity: "info",
    extensions: [".css", ".scss", ".tsx", ".jsx"],
    pattern: /font-size:\s*\d+px|text-\[\d+px\]/,
    title: "Hardcoded font size — consider using a type scale",
    description: "A pixel font size is hardcoded instead of using a type scale token or Tailwind preset. Consistent typography improves brand coherence.",
    confidence: 55,
  },
  {
    id: "new-ui-component",
    category: "next-step",
    severity: "info",
    extensions: [".tsx", ".jsx"],
    pattern: /export\s+(?:default\s+)?function\s+\w+(?:Page|Screen|Modal|Dialog|Card|Widget|Panel)/,
    title: "New UI component detected",
    description: "A new UI component was added. Consider reviewing it against the project's design system and brand guidelines.",
    confidence: 65,
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

    // .pen file change → design-relevant event (can't read content — binary/encrypted)
    if (file.ext === ".pen") {
      results.push({
        category: "next-step",
        severity: "info",
        title: `Design file modified: ${file.path}`,
        description: "A Pencil design file was changed. Review it in the Design tab for brand consistency and token alignment.",
        confidence: 70,
        triggerFiles: [file.path],
        triggerEvent: "file-change",
      })
      continue
    }

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

// ============ DOC DRIFT DETECTION ============

export interface DocDriftResult {
  file: string
  staleReferences: string[]
}

/**
 * Check if CLAUDE.md or README.md reference file paths that no longer exist.
 * Free filesystem check — only runs when these files are in the changed set.
 */
export function checkDocDrift(
  changedPaths: string[],
  projectPath: string,
): DocDriftResult[] {
  const results: DocDriftResult[] = []
  const docFiles = changedPaths.filter(p =>
    /^(CLAUDE\.md|README\.md|readme\.md)$/i.test(p.split("/").pop() ?? ""),
  )

  for (const docFile of docFiles) {
    const fullPath = join(projectPath, docFile)
    if (!existsSync(fullPath)) continue

    try {
      const content = readFileSync(fullPath, "utf-8")
      const staleRefs: string[] = []

      // Extract file path references (src/..., lib/..., etc.)
      const pathRefs = content.match(/(?:src|lib|packages|app|components|features|utils)\/[\w\-./]+\.\w+/g) ?? []
      for (const ref of new Set(pathRefs)) {
        const refPath = join(projectPath, ref)
        if (!existsSync(refPath)) {
          staleRefs.push(ref)
        }
      }

      // Extract directory references
      const dirRefs = content.match(/(?:src|lib|packages|app)\/[\w\-./]+\//g) ?? []
      for (const ref of new Set(dirRefs)) {
        const refPath = join(projectPath, ref.replace(/\/$/, ""))
        if (!existsSync(refPath)) {
          staleRefs.push(ref)
        }
      }

      if (staleRefs.length > 0) {
        results.push({ file: docFile, staleReferences: [...new Set(staleRefs)] })
      }
    } catch { /* non-critical */ }
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
