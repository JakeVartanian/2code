import type { BuiltinCommandAction, SlashCommandOption } from "./types"

/**
 * Prompt texts for prompt-based slash commands
 */
export const COMMAND_PROMPTS: Partial<
  Record<BuiltinCommandAction["type"], string>
> = {
  review:
    "Review the code in context: flag bugs, quality issues, and improvements. Be concise.",
  "pr-comments":
    "Generate PR review comments for the changes in context. Be specific and concise.",
  "release-notes":
    "Generate concise release notes for the changes in this codebase.",
  "security-review":
    "Security audit the code in context. List vulnerabilities and fixes. Be concise.",
  commit:
    "Commit staged changes only. Do not modify or stage any other files.",
  "worktree-setup": `Analyze this project and create .2code/worktree.json with setup commands.

Rules:
- Use only "setup-worktree" key
- Use project's package manager (check bun.lockb, pnpm-lock.yaml, yarn.lock, package-lock.json)
- Copy real env files (.env, .env.local, etc.) using $ROOT_WORKTREE_PATH — NOT example files
- Skip build steps unless required to run the project

Output .2code/worktree.json only.`,
}

/**
 * Check if a command is a prompt-based command
 */
export function isPromptCommand(
  type: BuiltinCommandAction["type"],
): type is "review" | "pr-comments" | "release-notes" | "security-review" | "commit" | "worktree-setup" {
  return type in COMMAND_PROMPTS
}

/** Commands that are passed through as-is to the Claude CLI (native CLI commands) */
export const CLI_PASSTHROUGH_COMMANDS = new Set(["usage", "doctor", "config", "memory", "mcp"])

/**
 * Built-in slash commands that are handled client-side
 */
export const BUILTIN_SLASH_COMMANDS: SlashCommandOption[] = [
  {
    id: "builtin:clear",
    name: "clear",
    command: "/clear",
    description: "Start a new conversation (creates new sub-chat)",
    category: "builtin",
  },
  {
    id: "builtin:plan",
    name: "plan",
    command: "/plan",
    description: "Switch to Plan mode (creates plan before making changes)",
    category: "builtin",
  },
  {
    id: "builtin:agent",
    name: "agent",
    command: "/agent",
    description: "Switch to Agent mode (applies changes directly)",
    category: "builtin",
  },
  {
    id: "builtin:compact",
    name: "compact",
    command: "/compact",
    description: "Compact conversation context to reduce token usage",
    category: "builtin",
  },
  {
    id: "builtin:usage",
    name: "usage",
    command: "/usage",
    description: "Show Claude Code usage and session statistics",
    category: "builtin",
  },
  {
    id: "builtin:doctor",
    name: "doctor",
    command: "/doctor",
    description: "Check Claude Code installation health",
    category: "builtin",
  },
  {
    id: "builtin:config",
    name: "config",
    command: "/config",
    description: "View or edit Claude Code configuration",
    category: "builtin",
  },
  {
    id: "builtin:memory",
    name: "memory",
    command: "/memory",
    description: "Edit Claude's memory (CLAUDE.md files)",
    category: "builtin",
  },
  {
    id: "builtin:mcp",
    name: "mcp",
    command: "/mcp",
    description: "Manage MCP server connections",
    category: "builtin",
  },
  // Prompt-based commands
  {
    id: "builtin:review",
    name: "review",
    command: "/review",
    description: "Ask agent to review your code",
    category: "builtin",
  },
  {
    id: "builtin:pr-comments",
    name: "pr-comments",
    command: "/pr-comments",
    description: "Ask agent to generate PR review comments",
    category: "builtin",
  },
  {
    id: "builtin:release-notes",
    name: "release-notes",
    command: "/release-notes",
    description: "Ask agent to generate release notes",
    category: "builtin",
  },
  {
    id: "builtin:security-review",
    name: "security-review",
    command: "/security-review",
    description: "Ask agent to perform a security audit",
    category: "builtin",
  },
  {
    id: "builtin:commit",
    name: "commit",
    command: "/commit",
    description: "Commit staged changes carefully without touching anything else",
    category: "builtin",
  },
  {
    id: "builtin:worktree-setup",
    name: "worktree-setup",
    command: "/worktree-setup",
    description: "Generate worktree setup config with AI",
    category: "builtin",
  },
]

/**
 * Filter builtin commands by search text
 */
export function filterBuiltinCommands(
  searchText: string,
): SlashCommandOption[] {
  if (!searchText) return BUILTIN_SLASH_COMMANDS

  const query = searchText.toLowerCase()
  return BUILTIN_SLASH_COMMANDS.filter(
    (cmd) =>
      cmd.name.toLowerCase().includes(query) ||
      cmd.description.toLowerCase().includes(query),
  )
}
