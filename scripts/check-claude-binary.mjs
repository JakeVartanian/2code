#!/usr/bin/env node
/**
 * Pre-package check: ensure Claude CLI binaries exist for all required platforms.
 * On macOS, checks both arm64 and x64 since `electron-builder --mac` builds both.
 * Fails fast with a clear message instead of shipping a broken app.
 */
import { existsSync } from "node:fs"
import { join } from "node:path"

const platform = process.platform

// On macOS, electron-builder --mac builds both arm64 and x64
const archsToCheck =
  platform === "darwin" ? ["arm64", "x64"] : [process.arch]

let allFound = true

for (const arch of archsToCheck) {
  const binaryDir = join("resources", "bin", `${platform}-${arch}`)
  const binaryPath = join(binaryDir, "claude")

  if (!existsSync(binaryPath)) {
    console.error(`\n  ERROR: Claude CLI binary not found at ${binaryPath}`)
    console.error(`  Run "bun run claude:download:all" before packaging.\n`)
    allFound = false
  } else {
    console.log(`  Claude CLI binary found: ${binaryPath}`)
  }
}

if (!allFound) {
  process.exit(1)
}
