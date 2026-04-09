import * as fs from "fs/promises"
import type { Dirent } from "fs"
import * as path from "path"
import * as os from "os"
import type { McpServerConfig } from "../claude-config"
import { isDirentDirectory } from "../fs/dirent"

export interface PluginInfo {
  name: string
  version: string
  description?: string
  path: string
  source: string // e.g., "marketplace:plugin-name"
  marketplace: string // e.g., "claude-plugins-official"
  category?: string
  homepage?: string
  tags?: string[]
}

interface MarketplacePlugin {
  name: string
  version?: string
  description?: string
  source: string | { source: string; url: string }
  category?: string
  homepage?: string
  tags?: string[]
}

interface MarketplaceJson {
  name: string
  plugins: MarketplacePlugin[]
}

export interface PluginMcpConfig {
  pluginSource: string // e.g., "ccsetup:ccsetup"
  mcpServers: Record<string, McpServerConfig>
}

interface InstalledPluginEntry {
  scope: string
  installPath: string
  version: string
  installedAt: string
  lastUpdated: string
  gitCommitSha?: string
}

export interface InstalledPluginsJson {
  version: number
  plugins: Record<string, InstalledPluginEntry[]>
}

interface MarketplacePluginSource {
  source: string
  url?: string
  path?: string
  ref?: string
  sha?: string
}

// Cache for plugin discovery results
let pluginCache: { plugins: PluginInfo[]; timestamp: number } | null = null
let mcpCache: { configs: PluginMcpConfig[]; timestamp: number } | null = null
const CACHE_TTL_MS = 30000 // 30 seconds - plugins don't change often during a session

/**
 * Clear plugin caches (for testing/manual invalidation)
 */
export function clearPluginCache() {
  pluginCache = null
  mcpCache = null
}

/**
 * Read the installed_plugins.json file from ~/.claude/plugins/
 */
async function readInstalledPluginsJson(): Promise<InstalledPluginsJson | null> {
  const jsonPath = path.join(os.homedir(), ".claude", "plugins", "installed_plugins.json")
  try {
    const content = await fs.readFile(jsonPath, "utf-8")
    return JSON.parse(content) as InstalledPluginsJson
  } catch {
    return null
  }
}

/**
 * Write the installed_plugins.json file
 */
export async function writeInstalledPluginsJson(data: InstalledPluginsJson): Promise<void> {
  const jsonPath = path.join(os.homedir(), ".claude", "plugins", "installed_plugins.json")
  await fs.mkdir(path.dirname(jsonPath), { recursive: true })
  await fs.writeFile(jsonPath, JSON.stringify(data, null, 2), "utf-8")
}

/**
 * Build a map of marketplace name -> plugin definitions from marketplace.json files
 */
async function buildMarketplacePluginMap(): Promise<Map<string, { marketplaceName: string; plugin: MarketplacePlugin }>> {
  const map = new Map<string, { marketplaceName: string; plugin: MarketplacePlugin }>()
  const marketplacesDir = path.join(os.homedir(), ".claude", "plugins", "marketplaces")

  let marketplaces: Dirent[]
  try {
    marketplaces = await fs.readdir(marketplacesDir, { withFileTypes: true })
  } catch {
    return map
  }

  for (const marketplace of marketplaces) {
    if (marketplace.name.startsWith(".")) continue
    const isDir = await isDirentDirectory(marketplacesDir, marketplace)
    if (!isDir) continue

    const marketplaceJsonPath = path.join(marketplacesDir, marketplace.name, ".claude-plugin", "marketplace.json")
    try {
      const content = await fs.readFile(marketplaceJsonPath, "utf-8")
      const marketplaceJson: MarketplaceJson = JSON.parse(content)
      if (!Array.isArray(marketplaceJson.plugins)) continue

      for (const plugin of marketplaceJson.plugins) {
        const key = `${marketplaceJson.name}:${plugin.name}`
        map.set(key, { marketplaceName: marketplaceJson.name, plugin })
      }
    } catch {
      // skip
    }
  }

  return map
}

/**
 * Discover all installed plugins from:
 * 1. ~/.claude/plugins/marketplaces/ (path-based plugins, local subdirs)
 * 2. ~/.claude/plugins/installed_plugins.json (URL-based plugins cloned to cache)
 *
 * Results are cached for 30 seconds to avoid repeated filesystem scans
 */
export async function discoverInstalledPlugins(): Promise<PluginInfo[]> {
  // Return cached result if still valid
  if (pluginCache && Date.now() - pluginCache.timestamp < CACHE_TTL_MS) {
    return pluginCache.plugins
  }

  const plugins: PluginInfo[] = []
  const discoveredSources = new Set<string>()
  const marketplacesDir = path.join(os.homedir(), ".claude", "plugins", "marketplaces")

  // --- Pass 1: Path-based plugins from marketplace subdirectories ---
  let marketplaces: Dirent[] = []
  try {
    await fs.access(marketplacesDir)
    marketplaces = await fs.readdir(marketplacesDir, { withFileTypes: true })
  } catch {
    // marketplaces dir doesn't exist, skip
  }

  for (const marketplace of marketplaces) {
    if (marketplace.name.startsWith(".")) continue

    const isMarketplaceDir = await isDirentDirectory(marketplacesDir, marketplace)
    if (!isMarketplaceDir) continue

    const marketplacePath = path.join(marketplacesDir, marketplace.name)
    const marketplaceJsonPath = path.join(marketplacePath, ".claude-plugin", "marketplace.json")

    try {
      const content = await fs.readFile(marketplaceJsonPath, "utf-8")
      let marketplaceJson: MarketplaceJson
      try {
        marketplaceJson = JSON.parse(content)
      } catch {
        continue
      }

      if (!Array.isArray(marketplaceJson.plugins)) continue

      for (const plugin of marketplaceJson.plugins) {
        if (!plugin.source) continue
        // Only handle string-path sources here (URL-based handled below)
        const sourcePath = typeof plugin.source === "string" ? plugin.source : null
        if (!sourcePath) continue

        const pluginPath = path.resolve(marketplacePath, sourcePath)
        try {
          const pluginStat = await fs.stat(pluginPath)
          if (!pluginStat.isDirectory()) continue
          const source = `${marketplaceJson.name}:${plugin.name}`
          discoveredSources.add(source)
          plugins.push({
            name: plugin.name,
            version: plugin.version || "0.0.0",
            description: plugin.description,
            path: pluginPath,
            source,
            marketplace: marketplaceJson.name,
            category: plugin.category,
            homepage: plugin.homepage,
            tags: plugin.tags,
          })
        } catch {
          // Plugin directory not found, skip
        }
      }
    } catch {
      // No marketplace.json, skip silently
    }
  }

  // --- Pass 2: URL-based plugins from installed_plugins.json ---
  const installedJson = await readInstalledPluginsJson()
  if (installedJson?.plugins) {
    const marketplaceMap = await buildMarketplacePluginMap()

    for (const [key, entries] of Object.entries(installedJson.plugins)) {
      // Skip if already discovered via path scan
      if (discoveredSources.has(key)) continue

      // Get the most recent install (last entry in array)
      const entry = entries[entries.length - 1]
      if (!entry?.installPath) continue

      // Verify the install directory exists
      try {
        const stat = await fs.stat(entry.installPath)
        if (!stat.isDirectory()) continue
      } catch {
        continue // not installed / path missing
      }

      // Parse marketplace and plugin name from key (e.g., "superpowers@claude-plugins-official")
      const atIdx = key.lastIndexOf("@")
      if (atIdx === -1) continue
      const pluginName = key.slice(0, atIdx)
      const marketplaceName = key.slice(atIdx + 1)
      const canonicalSource = `${marketplaceName}:${pluginName}`

      // Look up metadata from marketplace
      const marketplaceEntry = marketplaceMap.get(canonicalSource)
      const pluginMeta = marketplaceEntry?.plugin

      plugins.push({
        name: pluginName,
        version: entry.gitCommitSha ? entry.gitCommitSha.slice(0, 7) : entry.version || "0.0.0",
        description: pluginMeta?.description,
        path: entry.installPath,
        source: canonicalSource,
        marketplace: marketplaceName,
        category: pluginMeta?.category,
        homepage: pluginMeta?.homepage,
        tags: pluginMeta?.tags,
      })
      discoveredSources.add(canonicalSource)
    }
  }

  pluginCache = { plugins, timestamp: Date.now() }
  return plugins
}

/**
 * Get component paths for a plugin (commands, skills, agents directories)
 */
export function getPluginComponentPaths(plugin: PluginInfo) {
  return {
    commands: path.join(plugin.path, "commands"),
    skills: path.join(plugin.path, "skills"),
    agents: path.join(plugin.path, "agents"),
  }
}

/**
 * Discover MCP server configs from all installed plugins
 * Reads .mcp.json from each plugin directory
 * Results are cached for 30 seconds to avoid repeated filesystem scans
 */
export async function discoverPluginMcpServers(): Promise<PluginMcpConfig[]> {
  // Return cached result if still valid
  if (mcpCache && Date.now() - mcpCache.timestamp < CACHE_TTL_MS) {
    return mcpCache.configs
  }

  const plugins = await discoverInstalledPlugins()
  const configs: PluginMcpConfig[] = []

  for (const plugin of plugins) {
    const mcpJsonPath = path.join(plugin.path, ".mcp.json")
    try {
      const content = await fs.readFile(mcpJsonPath, "utf-8")
      let parsed: Record<string, unknown>
      try {
        parsed = JSON.parse(content)
      } catch {
        continue
      }

      // Support two formats:
      // Format A (flat): { "server-name": { "command": "...", ... } }
      // Format B (nested): { "mcpServers": { "server-name": { ... } } }
      const serversObj =
        parsed.mcpServers &&
        typeof parsed.mcpServers === "object" &&
        !Array.isArray(parsed.mcpServers)
          ? (parsed.mcpServers as Record<string, unknown>)
          : parsed

      const validServers: Record<string, McpServerConfig> = {}
      for (const [name, config] of Object.entries(serversObj)) {
        if (config && typeof config === "object" && !Array.isArray(config)) {
          validServers[name] = config as McpServerConfig
        }
      }

      if (Object.keys(validServers).length > 0) {
        configs.push({
          pluginSource: plugin.source,
          mcpServers: validServers,
        })
      }
    } catch {
      // No .mcp.json file, skip silently (this is expected for most plugins)
    }
  }

  // Cache the result
  mcpCache = { configs, timestamp: Date.now() }
  return configs
}
