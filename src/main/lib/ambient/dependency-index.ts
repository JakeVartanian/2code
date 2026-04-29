/**
 * Lightweight import/consumer index for cross-file context.
 * Built lazily from observed file changes — no full-tree scans on startup.
 * Provides getConsumers(path) and getImports(path) for enriching GAAD analysis.
 */

import { readFileSync, existsSync, readdirSync, statSync } from "fs"
import { join, relative, extname } from "path"

const IMPORT_PATTERN = /(?:import\s+.*?\s+from\s+['"]([^'"]+)['"]|require\s*\(\s*['"]([^'"]+)['"]\s*\))/g
const SKIP_DIRS = new Set(["node_modules", "dist", ".next", "build", "coverage", ".git", ".2code"])
const INDEX_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"])
const MAX_LINES_TO_READ = 30
const REBUILD_INTERVAL = 60 * 60 * 1000 // 60 minutes — incremental reindexFiles handles changes between rebuilds

export class DependencyIndex {
  private importedBy: Map<string, Set<string>> = new Map() // file → set of files that import it
  private imports: Map<string, Set<string>> = new Map()    // file → set of files it imports
  private projectPath: string
  private lastFullBuild = 0
  private isBuilt = false

  constructor(projectPath: string) {
    this.projectPath = projectPath
  }

  /**
   * Ensure the index is built. Lazy — first call scans src/, subsequent calls are no-ops
   * unless REBUILD_INTERVAL has elapsed.
   */
  ensureBuilt(): void {
    const now = Date.now()
    if (this.isBuilt && now - this.lastFullBuild < REBUILD_INTERVAL) return

    this.importedBy.clear()
    this.imports.clear()
    this.scanDirectory("src")
    this.lastFullBuild = now
    this.isBuilt = true
  }

  /**
   * Re-index specific files (called when git monitor detects changes).
   * Much cheaper than a full rebuild — only re-reads the changed files.
   */
  reindexFiles(filePaths: string[]): void {
    if (!this.isBuilt) {
      this.ensureBuilt()
      return
    }

    for (const filePath of filePaths) {
      const ext = extname(filePath).toLowerCase()
      if (!INDEX_EXTENSIONS.has(ext)) continue

      // Remove old entries for this file
      const oldImports = this.imports.get(filePath)
      if (oldImports) {
        for (const imp of oldImports) {
          this.importedBy.get(imp)?.delete(filePath)
        }
      }
      this.imports.delete(filePath)

      // Re-read and index
      this.indexFile(filePath)
    }
  }

  /**
   * Get files that import the given file.
   */
  getConsumers(filePath: string): string[] {
    this.ensureBuilt()
    const normalized = this.normalizePath(filePath)
    return [...(this.importedBy.get(normalized) ?? [])]
  }

  /**
   * Get files that the given file imports.
   */
  getImports(filePath: string): string[] {
    this.ensureBuilt()
    const normalized = this.normalizePath(filePath)
    return [...(this.imports.get(normalized) ?? [])]
  }

  /**
   * Build compact context string for a set of changed files.
   * Shows imports, consumers, and flags export signature changes.
   */
  buildContext(changedFiles: string[], diffContent?: string): string {
    this.ensureBuilt()
    const lines: string[] = []

    for (const file of changedFiles.slice(0, 6)) {
      const normalized = this.normalizePath(file)
      const fileImports = this.getImports(normalized)
      const consumers = this.getConsumers(normalized)

      if (fileImports.length === 0 && consumers.length === 0) continue

      if (fileImports.length > 0) {
        lines.push(`${normalized} imports: ${fileImports.slice(0, 5).join(", ")}`)
      }
      if (consumers.length > 0) {
        lines.push(`${normalized} consumed by: ${consumers.slice(0, 5).join(", ")}`)
      }
    }

    // Flag export changes if diff content is available
    if (diffContent && /^\+\s*export\s+/m.test(diffContent)) {
      const exportFiles = changedFiles.filter(f => {
        const consumers = this.getConsumers(this.normalizePath(f))
        return consumers.length > 0
      })
      if (exportFiles.length > 0) {
        lines.push(`\u26a0 Export signature changed in ${exportFiles.join(", ")} \u2014 consumers may need updates`)
      }
    }

    return lines.slice(0, 10).join("\n")
  }

  private scanDirectory(dirRelative: string): void {
    const dirFull = join(this.projectPath, dirRelative)
    if (!existsSync(dirFull)) return

    try {
      const entries = readdirSync(dirFull, { withFileTypes: true })
      for (const entry of entries) {
        if (SKIP_DIRS.has(entry.name)) continue

        const relPath = join(dirRelative, entry.name)
        if (entry.isDirectory()) {
          this.scanDirectory(relPath)
        } else if (entry.isFile() && INDEX_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
          this.indexFile(relPath)
        }
      }
    } catch { /* permission errors, etc. */ }
  }

  private indexFile(filePath: string): void {
    const fullPath = join(this.projectPath, filePath)
    if (!existsSync(fullPath)) return

    try {
      const stat = statSync(fullPath)
      if (stat.size > 100_000) return // Skip large files

      const content = readFileSync(fullPath, "utf-8")
      // Only read first N lines for import statements
      const lines = content.split("\n").slice(0, MAX_LINES_TO_READ).join("\n")

      const normalized = this.normalizePath(filePath)
      const fileImports = new Set<string>()

      let match: RegExpExecArray | null
      const pattern = new RegExp(IMPORT_PATTERN.source, "g")
      while ((match = pattern.exec(lines)) !== null) {
        const importPath = match[1] || match[2]
        if (!importPath || importPath.startsWith(".") === false) continue // Skip node_modules imports

        const resolved = this.resolveImport(importPath, filePath)
        if (resolved) {
          fileImports.add(resolved)
          // Update importedBy map
          if (!this.importedBy.has(resolved)) {
            this.importedBy.set(resolved, new Set())
          }
          this.importedBy.get(resolved)!.add(normalized)
        }
      }

      if (fileImports.size > 0) {
        this.imports.set(normalized, fileImports)
      }
    } catch { /* non-critical */ }
  }

  /**
   * Resolve a relative import path to a project-relative file path.
   * Handles common patterns: ./foo, ../bar, index files, extension omission.
   */
  private resolveImport(importPath: string, fromFile: string): string | null {
    const fromDir = fromFile.split("/").slice(0, -1).join("/")
    const candidates: string[] = []

    // Build candidate paths
    const resolved = join(fromDir, importPath)
    const extensions = [".ts", ".tsx", ".js", ".jsx"]

    // Direct match (already has extension)
    if (extname(importPath)) {
      candidates.push(resolved)
    } else {
      // Try with extensions
      for (const ext of extensions) {
        candidates.push(resolved + ext)
      }
      // Try as directory with index
      for (const ext of extensions) {
        candidates.push(join(resolved, "index" + ext))
      }
    }

    for (const candidate of candidates) {
      const normalized = this.normalizePath(candidate)
      const fullPath = join(this.projectPath, normalized)
      if (existsSync(fullPath)) {
        return normalized
      }
    }

    return null
  }

  private normalizePath(p: string): string {
    return p.replace(/^\.\//, "").replace(/^\//, "").replace(/\\/g, "/")
  }
}
