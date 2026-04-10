/**
 * Read/write workspace sections config from {projectPath}/.2code/sections.json
 */

import * as fs from "node:fs/promises"
import * as path from "node:path"
import type { SectionsConfig } from "../../../shared/section-types"
import { detectSections } from "./detect-sections"

const CONFIG_DIR = ".2code"
const CONFIG_FILE = "sections.json"

function configPath(projectPath: string): string {
  return path.join(projectPath, CONFIG_DIR, CONFIG_FILE)
}

/**
 * Read the saved sections config from the project directory.
 * Returns null if no config file exists.
 */
export async function readSectionsConfig(
  projectPath: string,
): Promise<SectionsConfig | null> {
  try {
    const raw = await fs.readFile(configPath(projectPath), "utf-8")
    const parsed = JSON.parse(raw) as SectionsConfig
    // Basic validation
    if (parsed.version === 1 && Array.isArray(parsed.sections)) {
      return parsed
    }
    console.warn("[sections] Invalid config format, ignoring")
    return null
  } catch {
    // File doesn't exist or can't be read
    return null
  }
}

/**
 * Write sections config to the project directory.
 * Creates .2code/ directory if it doesn't exist.
 */
export async function writeSectionsConfig(
  projectPath: string,
  config: SectionsConfig,
): Promise<void> {
  const dir = path.join(projectPath, CONFIG_DIR)
  await fs.mkdir(dir, { recursive: true })
  // Remove autoDetected flag when saving (user has explicitly saved)
  const toWrite: SectionsConfig = { ...config, autoDetected: false }
  await fs.writeFile(configPath(projectPath), JSON.stringify(toWrite, null, 2), "utf-8")
}

/**
 * Load saved config, or auto-detect if none exists.
 * Auto-detected configs are NOT written to disk — user must explicitly save.
 */
export async function getOrDetectSections(
  projectPath: string,
): Promise<SectionsConfig> {
  const saved = await readSectionsConfig(projectPath)
  if (saved) return saved
  return detectSections(projectPath)
}
