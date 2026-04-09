import { router, publicProcedure } from "../index"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import { exec } from "child_process"
import { promisify } from "util"
import type { Dirent } from "fs"
import matter from "gray-matter"
import { z } from "zod"
import { resolveDirentType } from "../../fs/dirent"
import {
  discoverInstalledPlugins,
  getPluginComponentPaths,
  discoverPluginMcpServers,
  clearPluginCache,
  writeInstalledPluginsJson,
  type InstalledPluginsJson,
} from "../../plugins"
import { getEnabledPlugins, invalidateEnabledPluginsCache } from "./claude-settings"

const execAsync = promisify(exec)

interface PluginComponent {
  name: string
  description?: string
}

interface PluginWithComponents {
  name: string
  version: string
  description?: string
  path: string
  source: string // e.g., "ccsetup:ccsetup"
  marketplace: string
  category?: string
  homepage?: string
  tags?: string[]
  isDisabled: boolean
  components: {
    commands: PluginComponent[]
    skills: PluginComponent[]
    agents: PluginComponent[]
    mcpServers: string[]
  }
}

/**
 * Validate entry name for security (prevent path traversal)
 */
function isValidEntryName(name: string): boolean {
  return !name.includes("..") && !name.includes("/") && !name.includes("\\")
}

/**
 * Scan commands directory and return component info
 */
async function scanPluginCommands(dir: string): Promise<PluginComponent[]> {
  const components: PluginComponent[] = []

  try {
    await fs.access(dir)
  } catch {
    return components
  }

  try {
    const entries = await fs.readdir(dir, { withFileTypes: true })

    for (const entry of entries) {
      if (!isValidEntryName(entry.name)) continue

      const fullPath = path.join(dir, entry.name)
      const { isDirectory, isFile } = await resolveDirentType(dir, entry)

      if (isDirectory) {
        // Recursively scan nested directories for namespaced commands
        const nested = await scanPluginCommands(fullPath)
        components.push(...nested)
      } else if (isFile && entry.name.endsWith(".md")) {
        try {
          const content = await fs.readFile(fullPath, "utf-8")
          const { data } = matter(content)
          const baseName = entry.name.replace(/\.md$/, "")
          components.push({
            name: typeof data.name === "string" ? data.name : baseName,
            description:
              typeof data.description === "string" ? data.description : undefined,
          })
        } catch {
          // Skip files that can't be read
        }
      }
    }
  } catch {
    // Directory read failed
  }

  return components
}

/**
 * Scan skills directory and return component info
 */
async function scanPluginSkills(dir: string): Promise<PluginComponent[]> {
  const components: PluginComponent[] = []

  try {
    await fs.access(dir)
  } catch {
    return components
  }

  try {
    const entries = await fs.readdir(dir, { withFileTypes: true })

    for (const entry of entries) {
      if (!isValidEntryName(entry.name)) continue

      const { isDirectory } = await resolveDirentType(dir, entry)
      if (!isDirectory) continue

      const skillMdPath = path.join(dir, entry.name, "SKILL.md")
      try {
        const content = await fs.readFile(skillMdPath, "utf-8")
        const { data } = matter(content)
        components.push({
          name: typeof data.name === "string" ? data.name : entry.name,
          description:
            typeof data.description === "string" ? data.description : undefined,
        })
      } catch {
        // Skill directory doesn't have SKILL.md - skip
      }
    }
  } catch {
    // Directory read failed
  }

  return components
}

/**
 * Scan agents directory and return component info
 */
async function scanPluginAgents(dir: string): Promise<PluginComponent[]> {
  const components: PluginComponent[] = []

  try {
    await fs.access(dir)
  } catch {
    return components
  }

  try {
    const entries = await fs.readdir(dir, { withFileTypes: true })

    for (const entry of entries) {
      if (!entry.name.endsWith(".md") || !isValidEntryName(entry.name)) continue

      const { isFile } = await resolveDirentType(dir, entry)
      if (!isFile) continue

      const fullPath = path.join(dir, entry.name)
      try {
        const content = await fs.readFile(fullPath, "utf-8")
        const { data } = matter(content)
        const baseName = entry.name.replace(/\.md$/, "")
        components.push({
          name: typeof data.name === "string" ? data.name : baseName,
          description:
            typeof data.description === "string" ? data.description : undefined,
        })
      } catch {
        // Skip files that can't be read
      }
    }
  } catch {
    // Directory read failed
  }

  return components
}

export const pluginsRouter = router({
  /**
   * List all installed plugins with their components and disabled status
   */
  list: publicProcedure.query(async (): Promise<PluginWithComponents[]> => {
    const [installedPlugins, enabledPlugins, mcpConfigs] = await Promise.all([
      discoverInstalledPlugins(),
      getEnabledPlugins(),
      discoverPluginMcpServers(),
    ])

    // Build a map of plugin source -> MCP server names
    const pluginMcpMap = new Map<string, string[]>()
    for (const config of mcpConfigs) {
      pluginMcpMap.set(config.pluginSource, Object.keys(config.mcpServers))
    }

    // Scan components for each plugin in parallel
    const pluginsWithComponents = await Promise.all(
      installedPlugins.map(async (plugin) => {
        const paths = getPluginComponentPaths(plugin)

        const [commands, skills, agents] = await Promise.all([
          scanPluginCommands(paths.commands),
          scanPluginSkills(paths.skills),
          scanPluginAgents(paths.agents),
        ])

        return {
          name: plugin.name,
          version: plugin.version,
          description: plugin.description,
          path: plugin.path,
          source: plugin.source,
          marketplace: plugin.marketplace,
          category: plugin.category,
          homepage: plugin.homepage,
          tags: plugin.tags,
          isDisabled: !enabledPlugins.includes(plugin.source),
          components: {
            commands,
            skills,
            agents,
            mcpServers: pluginMcpMap.get(plugin.source) || [],
          },
        }
      })
    )

    return pluginsWithComponents
  }),

  /**
   * Clear plugin cache (forces re-scan on next list)
   */
  clearCache: publicProcedure.mutation(async () => {
    clearPluginCache()
    return { success: true }
  }),

  /**
   * List all available plugins from marketplaces (installed + not installed)
   * Returns each plugin with isInstalled and isEnabled flags
   */
  listMarketplace: publicProcedure.query(async () => {
    const marketplacesDir = path.join(os.homedir(), ".claude", "plugins", "marketplaces")
    const [enabledPlugins, installedPlugins] = await Promise.all([
      getEnabledPlugins(),
      discoverInstalledPlugins(),
    ])
    const installedSources = new Set(installedPlugins.map((p) => p.source))

    const results: Array<{
      name: string
      description?: string
      category?: string
      homepage?: string
      tags?: string[]
      source: string
      marketplace: string
      sourceType: "path" | "url" | "git-subdir"
      isInstalled: boolean
      isEnabled: boolean
    }> = []

    let marketplaces: Dirent[]
    try {
      marketplaces = await fs.readdir(marketplacesDir, { withFileTypes: true })
    } catch {
      return results
    }

    for (const marketplace of marketplaces) {
      if (marketplace.name.startsWith(".")) continue
      const stat = await fs.stat(path.join(marketplacesDir, marketplace.name)).catch(() => null)
      if (!stat?.isDirectory()) continue

      const marketplaceJsonPath = path.join(marketplacesDir, marketplace.name, ".claude-plugin", "marketplace.json")
      try {
        const content = await fs.readFile(marketplaceJsonPath, "utf-8")
        const marketplaceJson = JSON.parse(content)
        if (!Array.isArray(marketplaceJson.plugins)) continue

        for (const plugin of marketplaceJson.plugins) {
          if (!plugin.name) continue
          const source = `${marketplaceJson.name}:${plugin.name}`
          const srcObj = plugin.source
          const sourceType: "path" | "url" | "git-subdir" =
            typeof srcObj === "string"
              ? "path"
              : srcObj?.source === "git-subdir"
              ? "git-subdir"
              : "url"

          results.push({
            name: plugin.name,
            description: plugin.description,
            category: plugin.category,
            homepage: plugin.homepage,
            tags: plugin.tags,
            source,
            marketplace: marketplaceJson.name,
            sourceType,
            isInstalled: installedSources.has(source),
            isEnabled: enabledPlugins.includes(source),
          })
        }
      } catch {
        // skip
      }
    }

    return results
  }),

  /**
   * Install a plugin from marketplace by source identifier (e.g., "claude-plugins-official:superpowers")
   * For URL-based plugins: clones the git repo to the cache directory
   * For path-based plugins: already installed (just enable)
   * After install, adds to enabledPlugins in settings.json
   */
  install: publicProcedure
    .input(z.object({ source: z.string() }))
    .mutation(async ({ input }) => {
      const colonIdx = input.source.indexOf(":")
      if (colonIdx === -1) throw new Error("Invalid source format, expected 'marketplace:plugin-name'")
      const marketplaceName = input.source.slice(0, colonIdx)
      const pluginName = input.source.slice(colonIdx + 1)

      const marketplacesDir = path.join(os.homedir(), ".claude", "plugins", "marketplaces")
      const marketplaceJsonPath = path.join(marketplacesDir, marketplaceName, ".claude-plugin", "marketplace.json")

      // Find the plugin definition in marketplace
      let marketplaceJson: { name: string; plugins: Array<{ name: string; source: unknown; description?: string; version?: string }> }
      try {
        const content = await fs.readFile(marketplaceJsonPath, "utf-8")
        marketplaceJson = JSON.parse(content)
      } catch {
        throw new Error(`Marketplace not found: ${marketplaceName}`)
      }

      const pluginDef = marketplaceJson.plugins.find((p) => p.name === pluginName)
      if (!pluginDef) throw new Error(`Plugin not found: ${pluginName} in ${marketplaceName}`)

      const src = pluginDef.source as Record<string, string> | string

      // Path-based plugins are already on disk — just enable them
      if (typeof src === "string") {
        const settings = await readSettings()
        const enabledPlugins: string[] = Array.isArray(settings.enabledPlugins) ? settings.enabledPlugins as string[] : []
        if (!enabledPlugins.includes(input.source)) {
          enabledPlugins.push(input.source)
          settings.enabledPlugins = enabledPlugins
          await writeSettings(settings)
          invalidateEnabledPluginsCache()
        }
        clearPluginCache()
        return { success: true, installPath: path.join(marketplacesDir, marketplaceName, src) }
      }

      // URL-based plugin — git clone into cache
      const srcObj = src as { source: string; url?: string; path?: string; ref?: string; sha?: string }
      if (!srcObj.url) throw new Error(`Plugin has no URL: ${pluginName}`)

      const cacheBase = path.join(os.homedir(), ".claude", "plugins", "cache", marketplaceName, pluginName)
      await fs.mkdir(cacheBase, { recursive: true })

      // Clone to a temp directory first to get the commit sha
      const tempDir = path.join(cacheBase, "_tmp_install")
      try {
        await fs.rm(tempDir, { recursive: true, force: true })
      } catch { /* ignore */ }

      // Determine the git URL
      let gitUrl = srcObj.url
      // For git-subdir sources the url may be a GitHub shorthand (owner/repo)
      if (!gitUrl.startsWith("http") && !gitUrl.startsWith("git@") && gitUrl.includes("/")) {
        gitUrl = `https://github.com/${gitUrl}.git`
      }

      const branch = srcObj.ref || "main"
      try {
        await execAsync(`git clone --depth 1 --branch ${branch} ${gitUrl} "${tempDir}"`)
      } catch {
        // Fallback: clone without branch
        await execAsync(`git clone --depth 1 ${gitUrl} "${tempDir}"`)
      }

      // Get the commit sha
      let sha = "latest"
      try {
        const { stdout } = await execAsync(`git -C "${tempDir}" rev-parse HEAD`)
        sha = stdout.trim()
      } catch { /* use fallback */ }

      // For git-subdir, the actual content is in a subdirectory
      let finalDir: string
      if (srcObj.source === "git-subdir" && srcObj.path) {
        finalDir = path.join(cacheBase, sha)
        const subDir = path.join(tempDir, srcObj.path)
        await fs.cp(subDir, finalDir, { recursive: true })
        await fs.rm(tempDir, { recursive: true, force: true })
      } else {
        // Move the temp clone to the final sha-named directory
        finalDir = path.join(cacheBase, sha)
        await fs.rename(tempDir, finalDir)
      }

      // Update installed_plugins.json
      const pluginKey = `${pluginName}@${marketplaceName}`
      const now = new Date().toISOString()
      let installedJson: { version: number; plugins: Record<string, Array<{ scope: string; installPath: string; version: string; installedAt: string; lastUpdated: string; gitCommitSha?: string }>> }
      try {
        const existingPath = path.join(os.homedir(), ".claude", "plugins", "installed_plugins.json")
        installedJson = JSON.parse(await fs.readFile(existingPath, "utf-8"))
      } catch {
        installedJson = { version: 2, plugins: {} }
      }
      installedJson.plugins[pluginKey] = [{
        scope: "user",
        installPath: finalDir,
        version: sha.slice(0, 7),
        installedAt: now,
        lastUpdated: now,
        gitCommitSha: sha,
      }]
      await writeInstalledPluginsJson(installedJson as InstalledPluginsJson)

      // Add to enabledPlugins in settings.json
      const settings = await readSettings()
      const enabledPlugins: string[] = Array.isArray(settings.enabledPlugins) ? settings.enabledPlugins as string[] : []
      if (!enabledPlugins.includes(input.source)) {
        enabledPlugins.push(input.source)
        settings.enabledPlugins = enabledPlugins
        await writeSettings(settings)
        invalidateEnabledPluginsCache()
      }

      clearPluginCache()
      return { success: true, installPath: finalDir }
    }),
})

// Helper functions for settings read/write (reuse logic without importing circular deps)
async function readSettings(): Promise<Record<string, unknown>> {
  const settingsPath = path.join(os.homedir(), ".claude", "settings.json")
  try {
    return JSON.parse(await fs.readFile(settingsPath, "utf-8"))
  } catch {
    return {}
  }
}

async function writeSettings(settings: Record<string, unknown>): Promise<void> {
  const settingsPath = path.join(os.homedir(), ".claude", "settings.json")
  await fs.mkdir(path.dirname(settingsPath), { recursive: true })
  await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2), "utf-8")
}
