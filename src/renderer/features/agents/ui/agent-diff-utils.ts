import { atomWithStorage } from "jotai/utils"

export type DiffViewMode = "unified" | "split"

export type ParsedDiffFile = {
  key: string
  oldPath: string
  newPath: string
  diffText: string
  isBinary: boolean
  additions: number
  deletions: number
  isValid?: boolean
  fileLang?: string | null
  isNewFile?: boolean
  isDeletedFile?: boolean
}

export const diffViewModeAtom = atomWithStorage<DiffViewMode>(
  "agents-diff:view-mode-v2",
  "unified",
)

const validateDiffHunk = (
  diffText: string,
): { valid: boolean; reason?: string } => {
  if (!diffText || diffText.trim().length === 0) {
    return { valid: false, reason: "empty diff" }
  }

  const lines = diffText.split("\n")
  const hunkHeaderRegex = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/

  const minusLineIdx = lines.findIndex((l) => l.startsWith("--- "))
  const plusLineIdx = lines.findIndex((l) => l.startsWith("+++ "))

  if (minusLineIdx === -1 || plusLineIdx === -1) {
    return { valid: false, reason: `missing header lines` }
  }

  if (plusLineIdx <= minusLineIdx) {
    return { valid: false, reason: `header order wrong` }
  }

  if (
    diffText.includes("new mode") ||
    diffText.includes("old mode") ||
    diffText.includes("rename from") ||
    diffText.includes("rename to") ||
    diffText.includes("Binary files")
  ) {
    return { valid: true }
  }

  let hasHunk = false
  for (let i = plusLineIdx + 1; i < lines.length; i++) {
    if (hunkHeaderRegex.test(lines[i]!)) {
      hasHunk = true
      break
    }
  }

  if (!hasHunk) {
    return { valid: false, reason: "no hunk headers found" }
  }

  return { valid: true }
}

export const splitUnifiedDiffByFile = (diffText: string): ParsedDiffFile[] => {
  const normalized = diffText.replace(/\r\n/g, "\n")
  const lines = normalized.split("\n")

  const blocks: string[] = []
  let current: string[] = []

  const pushCurrent = () => {
    const text = current.join("\n").trim()
    if (
      text &&
      (text.startsWith("diff --git ") ||
        text.startsWith("--- ") ||
        text.startsWith("+++ ") ||
        text.startsWith("Binary files ") ||
        text.includes("\n+++ ") ||
        text.includes("\nBinary files "))
    ) {
      blocks.push(text)
    }
    current = []
  }

  for (const line of lines) {
    if (line.startsWith("diff --git ") && current.length > 0) {
      pushCurrent()
    }
    current.push(line)
  }
  pushCurrent()

  return blocks.map((blockText, index) => {
    const blockLines = blockText.split("\n")
    let oldPath = ""
    let newPath = ""
    let isBinary = false
    let additions = 0
    let deletions = 0

    for (const line of blockLines) {
      if (line.startsWith("diff --git ")) {
        const match = line.match(/^diff --git a\/(.+) b\/(.+)$/)
        if (match) {
          if (!oldPath) oldPath = match[1]!
          if (!newPath) newPath = match[2]!
        }
      }

      if (line.startsWith("Binary files ") && line.endsWith(" differ")) {
        isBinary = true
      }

      if (line.startsWith("--- ")) {
        const raw = line.slice(4).trim()
        oldPath = raw.startsWith("a/") ? raw.slice(2) : raw
      }

      if (line.startsWith("+++ ")) {
        const raw = line.slice(4).trim()
        newPath = raw.startsWith("b/") ? raw.slice(2) : raw
      }

      if (line.startsWith("+") && !line.startsWith("+++ ")) {
        additions += 1
      } else if (line.startsWith("-") && !line.startsWith("--- ")) {
        deletions += 1
      }
    }

    const key = oldPath || newPath ? `${oldPath}->${newPath}` : `file-${index}`
    const validation = isBinary ? { valid: true } : validateDiffHunk(blockText)
    const isValid = validation.valid

    return {
      key,
      oldPath,
      newPath,
      diffText: blockText,
      isBinary,
      additions,
      deletions,
      isValid,
    }
  })
}
