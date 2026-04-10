/**
 * Workspace section types — shared between main and renderer.
 */

export interface WorkspaceSection {
  /** Unique slug, e.g. "frontend", "backend", "contracts" */
  id: string
  /** Display name, e.g. "Frontend" */
  name: string
  /** Glob patterns, e.g. ["src/renderer/**", "public/**"] */
  patterns: string[]
  /** Whether Claude can modify files in this section */
  enabled: boolean
  /** Optional UI accent color (Tailwind class or hex) */
  color?: string
  /** Optional lucide icon name */
  icon?: string
}

export interface SectionsConfig {
  version: 1
  sections: WorkspaceSection[]
  /** Whether this config was auto-generated (not yet saved by user) */
  autoDetected?: boolean
}
