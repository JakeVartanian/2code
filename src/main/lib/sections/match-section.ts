/**
 * Check if a file path matches a disabled workspace section.
 * Uses simple glob matching (no external deps).
 */

import type { WorkspaceSection } from "../../../shared/section-types"

/**
 * Returns the first disabled section that matches the given relative file path,
 * or null if the file is not in any disabled section.
 */
export function getBlockedSection(
  relativePath: string,
  disabledSections: WorkspaceSection[],
): WorkspaceSection | null {
  for (const section of disabledSections) {
    for (const pattern of section.patterns) {
      if (matchGlob(pattern, relativePath)) {
        return section
      }
    }
  }
  return null
}

/**
 * Minimal glob matcher supporting:
 * - `**` (matches any number of path segments)
 * - `*` (matches any characters within a single segment)
 * - Literal path matching
 *
 * This avoids pulling in picomatch/micromatch as a dependency.
 */
function matchGlob(pattern: string, filePath: string): boolean {
  // Normalize
  const p = pattern.replace(/\\/g, "/")
  const f = filePath.replace(/\\/g, "/")

  // Convert glob pattern to regex
  let regex = "^"
  let i = 0
  while (i < p.length) {
    if (p[i] === "*" && p[i + 1] === "*") {
      // ** matches any number of path segments
      if (p[i + 2] === "/") {
        regex += "(?:.*/)?"
        i += 3
      } else {
        regex += ".*"
        i += 2
      }
    } else if (p[i] === "*") {
      // * matches anything except /
      regex += "[^/]*"
      i++
    } else if (p[i] === "?") {
      regex += "[^/]"
      i++
    } else if (p[i] === ".") {
      regex += "\\."
      i++
    } else {
      regex += p[i]
      i++
    }
  }
  regex += "$"

  try {
    return new RegExp(regex).test(f)
  } catch {
    return false
  }
}
