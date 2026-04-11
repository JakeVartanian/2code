#!/usr/bin/env node
/**
 * Pre-package check: ensure Claude CLI binary exists for the current platform.
 * Fails fast with a clear message instead of shipping a broken app.
 */
import { existsSync } from "node:fs"
import { join } from "node:path"

const platform = process.platform
const arch = process.arch
const binaryDir = join("resources", "bin", `${platform}-${arch}`)
const binaryPath = join(binaryDir, "claude")

if (!existsSync(binaryPath)) {
  console.error(`\n  ERROR: Claude CLI binary not found at ${binaryPath}`)
  console.error(`  Run "bun run claude:download" before packaging.\n`)
  process.exit(1)
}

console.log(`  Claude CLI binary found: ${binaryPath}`)
