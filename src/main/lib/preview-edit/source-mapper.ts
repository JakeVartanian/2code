import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { readFile, writeFile } from "node:fs/promises"
import { extname } from "node:path"

const execFileAsync = promisify(execFile)

const SOURCE_EXTENSIONS = [
  "tsx", "ts", "jsx", "js", "html", "vue", "svelte", "mdx", "md", "astro",
]

const EXCLUDE_DIRS = [
  "node_modules", ".git", "dist", "build", ".next", ".nuxt", ".svelte-kit",
  "__pycache__", ".turbo", ".vercel",
]

export interface SearchMatch {
  filePath: string
  lineNumber: number
  lineContent: string
}

/**
 * Run grep with fixed-strings against project source files.
 */
async function grepProject(
  projectPath: string,
  searchText: string,
): Promise<SearchMatch[]> {
  if (!searchText.trim()) return []

  const includeArgs = SOURCE_EXTENSIONS.flatMap((ext) => [
    "--include", `*.${ext}`,
  ])
  const excludeArgs = EXCLUDE_DIRS.flatMap((dir) => [
    "--exclude-dir", dir,
  ])

  try {
    const { stdout } = await execFileAsync("grep", [
      "-rn",
      "--fixed-strings",
      ...includeArgs,
      ...excludeArgs,
      searchText,
      projectPath,
    ], { timeout: 10000, maxBuffer: 1024 * 1024 })

    const matches: SearchMatch[] = []
    for (const line of stdout.split("\n")) {
      if (!line.trim()) continue
      const firstColon = line.indexOf(":")
      if (firstColon === -1) continue
      const secondColon = line.indexOf(":", firstColon + 1)
      if (secondColon === -1) continue

      const filePath = line.slice(0, firstColon)
      const lineNumber = parseInt(line.slice(firstColon + 1, secondColon), 10)
      const lineContent = line.slice(secondColon + 1)

      if (!isNaN(lineNumber)) {
        matches.push({ filePath, lineNumber, lineContent })
      }
    }
    return matches
  } catch (err: any) {
    if (err.code === 1) return []
    throw err
  }
}

/**
 * Extract short, unique search fragments from text.
 * Splits on newlines and common separators, returns the most
 * likely-unique fragments (longer is better, avoids common words).
 */
function extractSearchFragments(text: string): string[] {
  // Split by newlines first — each line is a potential search target
  const lines = text.split(/\n/).map((l) => l.trim()).filter((l) => l.length > 0)

  const fragments: string[] = []

  for (const line of lines) {
    // If line is short enough for grep, use it directly
    if (line.length >= 8 && line.length <= 200) {
      fragments.push(line)
    } else if (line.length > 200) {
      // Split long lines by sentence boundaries
      const sentences = line.split(/(?<=[.!?])\s+/)
      for (const s of sentences) {
        const trimmed = s.trim()
        if (trimmed.length >= 8 && trimmed.length <= 200) {
          fragments.push(trimmed)
        } else if (trimmed.length > 200) {
          // Take first 120 chars
          fragments.push(trimmed.slice(0, 120))
        }
      }
    }
  }

  // If we got nothing, try the first 80 chars of the whole text
  if (fragments.length === 0 && text.length >= 8) {
    fragments.push(text.slice(0, 80).trim())
  }

  return fragments
}

/**
 * Search for text in project source files.
 *
 * Strategy:
 * 1. Try exact match with the full text (for short edits)
 * 2. If full text is long or not found, search with shorter unique fragments
 * 3. Intersect fragment matches to find the most likely file
 */
export async function searchTextInProject(
  projectPath: string,
  searchText: string,
): Promise<SearchMatch[]> {
  if (!searchText.trim()) return []

  // For short text (single line, < 200 chars), try exact grep
  const isShort = !searchText.includes("\n") && searchText.length <= 200
  if (isShort) {
    const matches = await grepProject(projectPath, searchText)
    if (matches.length > 0) return matches
  }

  // For long/multi-line text, search with fragments
  const fragments = extractSearchFragments(searchText)
  if (fragments.length === 0) return []

  // Search with the first (most unique) fragment
  const primaryResults = await grepProject(projectPath, fragments[0])
  if (primaryResults.length === 0 && fragments.length > 1) {
    // Try next fragment
    return await grepProject(projectPath, fragments[1])
  }

  // If multiple results, try to narrow down with additional fragments
  if (primaryResults.length > 1 && fragments.length > 1) {
    // Check which files also contain the second fragment
    const secondResults = await grepProject(projectPath, fragments[1])
    const secondFiles = new Set(secondResults.map((m) => m.filePath))
    const narrowed = primaryResults.filter((m) => secondFiles.has(m.filePath))
    if (narrowed.length > 0) return narrowed
  }

  return primaryResults
}

/**
 * Replace text on a specific line of a file.
 * If oldText isn't found on the exact line, searches nearby lines (±3).
 */
export async function replaceTextInFile(
  filePath: string,
  lineNumber: number,
  oldText: string,
  newText: string,
): Promise<boolean> {
  const content = await readFile(filePath, "utf-8")
  const lines = content.split("\n")

  // Line numbers are 1-based
  const idx = lineNumber - 1

  // Try exact line first
  if (idx >= 0 && idx < lines.length && lines[idx].includes(oldText)) {
    lines[idx] = lines[idx].replace(oldText, newText)
    await writeFile(filePath, lines.join("\n"), "utf-8")
    return true
  }

  // Search nearby lines (±3) in case line numbers shifted
  for (let offset = 1; offset <= 3; offset++) {
    for (const delta of [-offset, offset]) {
      const checkIdx = idx + delta
      if (checkIdx >= 0 && checkIdx < lines.length && lines[checkIdx].includes(oldText)) {
        lines[checkIdx] = lines[checkIdx].replace(oldText, newText)
        await writeFile(filePath, lines.join("\n"), "utf-8")
        return true
      }
    }
  }

  return false
}

/**
 * Convert HTML formatting tags to the appropriate source format
 * based on the target file extension.
 */
export function convertHtmlToSourceFormat(html: string, filePath: string): string {
  const ext = extname(filePath).toLowerCase()

  if (ext === ".md" || ext === ".mdx") {
    return htmlToMarkdown(html)
  }

  // For JSX/TSX/HTML/Vue/Svelte — keep HTML tags as-is
  return html
}

function htmlToMarkdown(html: string): string {
  let result = html

  // <strong> / <b> → **text**
  result = result.replace(/<(?:strong|b)>(.*?)<\/(?:strong|b)>/gi, "**$1**")

  // <em> / <i> → *text*
  result = result.replace(/<(?:em|i)>(.*?)<\/(?:em|i)>/gi, "*$1*")

  // <a href="url">text</a> → [text](url)
  result = result.replace(
    /<a\s+href=["'](.*?)["']>(.*?)<\/a>/gi,
    "[$2]($1)",
  )

  // Strip remaining tags
  result = result.replace(/<[^>]+>/g, "")

  return result
}
