import { z } from "zod"
import { router, publicProcedure } from "../index"
import * as fs from "fs/promises"
import * as path from "path"
import * as os from "os"
import {
  parseAgentMd,
  generateAgentMd,
  scanAgentsDirectory,
  VALID_AGENT_MODELS,
  type FileAgent,
} from "./agent-utils"
import { discoverInstalledPlugins, getPluginComponentPaths } from "../../plugins"
import { getEnabledPlugins } from "./claude-settings"
import { getClaudeCodeTokenFresh } from "./claude"

// Shared procedure for listing agents
const listAgentsProcedure = publicProcedure
  .input(
    z
      .object({
        cwd: z.string().optional(),
      })
      .optional(),
  )
  .query(async ({ input }) => {
    const userAgentsDir = path.join(os.homedir(), ".claude", "agents")
    const userAgentsPromise = scanAgentsDirectory(userAgentsDir, "user")

    let projectAgentsPromise = Promise.resolve<FileAgent[]>([])
    if (input?.cwd) {
      const projectAgentsDir = path.join(input.cwd, ".claude", "agents")
      projectAgentsPromise = scanAgentsDirectory(projectAgentsDir, "project", input.cwd)
    }

    // Discover plugin agents
    const [enabledPluginSources, installedPlugins] = await Promise.all([
      getEnabledPlugins(),
      discoverInstalledPlugins(),
    ])
    const enabledPlugins = installedPlugins.filter(
      (p) => enabledPluginSources.includes(p.source),
    )
    const pluginAgentsPromises = enabledPlugins.map(async (plugin) => {
      const paths = getPluginComponentPaths(plugin)
      try {
        const agents = await scanAgentsDirectory(paths.agents, "plugin")
        return agents.map((agent) => ({ ...agent, pluginName: plugin.source }))
      } catch {
        return []
      }
    })

    // Scan all directories in parallel
    const [userAgents, projectAgents, ...pluginAgentsArrays] =
      await Promise.all([
        userAgentsPromise,
        projectAgentsPromise,
        ...pluginAgentsPromises,
      ])
    const pluginAgents = pluginAgentsArrays.flat()

    return [...projectAgents, ...userAgents, ...pluginAgents]
  })

export const agentsRouter = router({
  /**
   * List all agents from filesystem
   * - User agents: ~/.claude/agents/
   * - Project agents: .claude/agents/ (relative to cwd)
   */
  list: listAgentsProcedure,

  /**
   * Alias for list - used by @ mention
   */
  listEnabled: listAgentsProcedure,

  /**
   * Get single agent by name
   */
  get: publicProcedure
    .input(z.object({ name: z.string(), cwd: z.string().optional() }))
    .query(async ({ input }) => {
      const locations = [
        {
          dir: path.join(os.homedir(), ".claude", "agents"),
          source: "user" as const,
        },
        ...(input.cwd
          ? [
              {
                dir: path.join(input.cwd, ".claude", "agents"),
                source: "project" as const,
              },
            ]
          : []),
      ]

      for (const { dir, source } of locations) {
        const agentPath = path.join(dir, `${input.name}.md`)
        try {
          const content = await fs.readFile(agentPath, "utf-8")
          const parsed = parseAgentMd(content, `${input.name}.md`)
          return {
            ...parsed,
            source,
            path: agentPath,
          }
        } catch {
          continue
        }
      }

      // Search in plugin directories
      const [enabledPluginSources, installedPlugins] = await Promise.all([
        getEnabledPlugins(),
        discoverInstalledPlugins(),
      ])
      const enabledPlugins = installedPlugins.filter(
        (p) => enabledPluginSources.includes(p.source),
      )
      for (const plugin of enabledPlugins) {
        const paths = getPluginComponentPaths(plugin)
        const agentPath = path.join(paths.agents, `${input.name}.md`)
        try {
          const content = await fs.readFile(agentPath, "utf-8")
          const parsed = parseAgentMd(content, `${input.name}.md`)
          return {
            ...parsed,
            source: "plugin" as const,
            pluginName: plugin.source,
            path: agentPath,
          }
        } catch {
          continue
        }
      }
      return null
    }),

  /**
   * Create a new agent
   */
  create: publicProcedure
    .input(
      z.object({
        name: z.string(),
        description: z.string(),
        prompt: z.string(),
        tools: z.array(z.string()).optional(),
        disallowedTools: z.array(z.string()).optional(),
        model: z.enum(VALID_AGENT_MODELS).optional(),
        source: z.enum(["user", "project"]),
        cwd: z.string().optional(),
      })
    )
    .mutation(async ({ input }) => {
      // Validate name (kebab-case, no special chars)
      const safeName = input.name.toLowerCase().replace(/[^a-z0-9-]/g, "-")
      if (!safeName || safeName.includes("..")) {
        throw new Error("Invalid agent name")
      }

      // Determine target directory
      let targetDir: string
      if (input.source === "project") {
        if (!input.cwd) {
          throw new Error("Project path (cwd) required for project agents")
        }
        targetDir = path.join(input.cwd, ".claude", "agents")
      } else {
        targetDir = path.join(os.homedir(), ".claude", "agents")
      }

      // Ensure directory exists
      await fs.mkdir(targetDir, { recursive: true })

      const agentPath = path.join(targetDir, `${safeName}.md`)

      // Check if already exists
      try {
        await fs.access(agentPath)
        throw new Error(`Agent "${safeName}" already exists`)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          throw err
        }
      }

      // Generate and write file
      const content = generateAgentMd({
        name: safeName,
        description: input.description,
        prompt: input.prompt,
        tools: input.tools,
        disallowedTools: input.disallowedTools,
        model: input.model,
      })

      await fs.writeFile(agentPath, content, "utf-8")

      return {
        name: safeName,
        path: agentPath,
        source: input.source,
      }
    }),

  /**
   * Update an existing agent
   */
  update: publicProcedure
    .input(
      z.object({
        originalName: z.string(),
        name: z.string(),
        description: z.string(),
        prompt: z.string(),
        tools: z.array(z.string()).optional(),
        disallowedTools: z.array(z.string()).optional(),
        model: z.enum(VALID_AGENT_MODELS).optional(),
        source: z.enum(["user", "project"]),
        cwd: z.string().optional(),
      })
    )
    .mutation(async ({ input }) => {
      // Validate names
      const safeOriginalName = input.originalName.toLowerCase().replace(/[^a-z0-9-]/g, "-")
      const safeName = input.name.toLowerCase().replace(/[^a-z0-9-]/g, "-")
      if (!safeOriginalName || !safeName || safeName.includes("..")) {
        throw new Error("Invalid agent name")
      }

      // Determine target directory
      let targetDir: string
      if (input.source === "project") {
        if (!input.cwd) {
          throw new Error("Project path (cwd) required for project agents")
        }
        targetDir = path.join(input.cwd, ".claude", "agents")
      } else {
        targetDir = path.join(os.homedir(), ".claude", "agents")
      }

      const originalPath = path.join(targetDir, `${safeOriginalName}.md`)
      const newPath = path.join(targetDir, `${safeName}.md`)

      // Check original exists
      try {
        await fs.access(originalPath)
      } catch {
        throw new Error(`Agent "${safeOriginalName}" not found`)
      }

      // If renaming, check new name doesn't exist
      if (safeOriginalName !== safeName) {
        try {
          await fs.access(newPath)
          throw new Error(`Agent "${safeName}" already exists`)
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
            throw err
          }
        }
      }

      // Generate and write file
      const content = generateAgentMd({
        name: safeName,
        description: input.description,
        prompt: input.prompt,
        tools: input.tools,
        disallowedTools: input.disallowedTools,
        model: input.model,
      })

      // Delete old file if renaming
      if (safeOriginalName !== safeName) {
        await fs.unlink(originalPath)
      }

      await fs.writeFile(newPath, content, "utf-8")

      return {
        name: safeName,
        path: newPath,
        source: input.source,
      }
    }),

  /**
   * Delete an agent
   */
  delete: publicProcedure
    .input(
      z.object({
        name: z.string(),
        source: z.enum(["user", "project"]),
        cwd: z.string().optional(),
      })
    )
    .mutation(async ({ input }) => {
      const safeName = input.name.toLowerCase().replace(/[^a-z0-9-]/g, "-")
      if (!safeName || safeName.includes("..")) {
        throw new Error("Invalid agent name")
      }

      let targetDir: string
      if (input.source === "project") {
        if (!input.cwd) {
          throw new Error("Project path (cwd) required for project agents")
        }
        targetDir = path.join(input.cwd, ".claude", "agents")
      } else {
        targetDir = path.join(os.homedir(), ".claude", "agents")
      }

      const agentPath = path.join(targetDir, `${safeName}.md`)

      await fs.unlink(agentPath)

      return { deleted: true }
    }),

  /**
   * Generate an agent definition from a natural language description using Claude Sonnet
   */
  generateFromDescription: publicProcedure
    .input(
      z.object({
        description: z.string().min(10),
      })
    )
    .mutation(async ({ input }) => {
      const token = await getClaudeCodeTokenFresh()
      if (!token) {
        throw new Error("Not authenticated with Claude. Please sign in first.")
      }

      const systemPrompt = `You are an expert at creating Claude subagent definitions. When given a description of what a subagent should do, generate a complete, thorough agent definition.

Respond with ONLY a valid JSON object (no markdown fences, no explanation) with these fields:
- "name": string — kebab-case identifier, descriptive, max 30 chars (e.g. "security-reviewer", "api-designer")
- "description": string — one concise sentence, max 100 chars
- "prompt": string — a thorough, detailed system prompt (200-600 words) that covers:
  1. The agent's specific role, expertise, and domain knowledge
  2. How it should approach tasks step-by-step
  3. What it should focus on and prioritize
  4. What it should avoid or not do
  5. Expected output format and quality standards
  6. Any relevant best practices or frameworks it should apply
- "model": "sonnet" | "opus" | "haiku" — choose based on task complexity ("opus" for deep analysis/architecture, "sonnet" for general coding tasks, "haiku" for simple/fast tasks)

Make the system prompt specific and actionable, not generic. Include concrete examples of the kind of analysis or output the agent should produce.`

      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-5-20250514",
          max_tokens: 2048,
          system: systemPrompt,
          messages: [
            {
              role: "user",
              content: `Create a subagent for: ${input.description}`,
            },
          ],
        }),
      })

      if (!response.ok) {
        const errorText = await response.text().catch(() => "")
        throw new Error(
          `Claude API error (${response.status}): ${errorText.slice(0, 200)}`
        )
      }

      const data = (await response.json()) as {
        content: Array<{ type: string; text: string }>
      }
      const text = data.content[0]?.text ?? ""

      // Extract JSON from the response
      const jsonMatch = text.match(/\{[\s\S]*\}/)
      if (!jsonMatch) {
        throw new Error("Failed to parse agent definition from AI response")
      }

      let parsed: {
        name: string
        description: string
        prompt: string
        model?: string
      }
      try {
        parsed = JSON.parse(jsonMatch[0])
      } catch {
        throw new Error("AI returned invalid JSON for agent definition")
      }

      if (!parsed.name || !parsed.prompt) {
        throw new Error("AI response missing required fields (name, prompt)")
      }

      return {
        name: parsed.name,
        description: parsed.description || "",
        prompt: parsed.prompt,
        model: VALID_AGENT_MODELS.includes(parsed.model as any)
          ? (parsed.model as (typeof VALID_AGENT_MODELS)[number])
          : undefined,
      }
    }),

  /**
   * Fetch available models from OpenRouter API (main process, bypasses CSP)
   */
  fetchOpenRouterModels: publicProcedure
    .input(z.object({ apiKey: z.string() }))
    .mutation(async ({ input }) => {
      console.log("[agents-router] fetchOpenRouterModels called, key present:", !!input.apiKey)
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 15_000)
      let res: Response
      try {
        res = await fetch("https://openrouter.ai/api/v1/models", {
          headers: { Authorization: `Bearer ${input.apiKey}` },
          signal: controller.signal,
        })
      } catch (err: any) {
        clearTimeout(timeout)
        if (err?.name === "AbortError") {
          throw new Error("Request timed out — OpenRouter did not respond in time")
        }
        throw new Error(`Failed to reach OpenRouter: ${err?.message || "network error"}`)
      }
      clearTimeout(timeout)
      console.log("[agents-router] OpenRouter API response status:", res.status)
      if (!res.ok) {
        console.error("[agents-router] OpenRouter API error:", res.status)
        if (res.status === 401) throw new Error("Invalid API key")
        if (res.status === 429) throw new Error("Rate limited — try again shortly")
        if (res.status >= 500) throw new Error("OpenRouter is temporarily unavailable")
        throw new Error(`OpenRouter API error: ${res.status}`)
      }
      const data = (await res.json()) as {
        data: { id: string; name: string; pricing?: { prompt: string }; supported_parameters?: string[] }[]
      }
      console.log("[agents-router] OpenRouter API returned", data.data.length, "models")
      // Claude Code requires tool_use (bash, file read/write, etc.).
      // Exclude models that explicitly declare supported_parameters without "tools" —
      // those are confirmed incompatible (e.g. Gemma). Models with no supported_parameters
      // declaration are kept (benefit of the doubt — they may work).
      const models = data.data
        .filter((m) => {
          const params = m.supported_parameters
          return !params || params.includes("tools")
        })
        .map((m) => ({
          id: m.id,
          name: m.name,
          isFree: m.pricing?.prompt === "0" || m.id.endsWith(":free"),
        }))
      console.log(`[agents-router] Returning ${models.length} / ${data.data.length} models (tool-capable or unknown)`)
      console.log("[agents-router] Returning", models.length, "models to client")
      return models
    }),
})
