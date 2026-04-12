# 2Code

A local-first desktop app for AI-powered code assistance. Fork of [1Code](https://github.com/21st-dev/1code) by 21st.dev.

Run Claude Code locally with a visual UI, git worktree isolation, and real-time tool execution.

## Highlights

- **Visual UI** - Cursor-like desktop app with diff previews and real-time tool execution
- **Git Worktree Isolation** - Each chat runs in its own isolated worktree
- **Custom Models & Providers (BYOK)** - Bring your own API keys, OpenRouter support
- **Built-in Git Client** - Visual staging, diffs, PR creation, push to GitHub
- **Integrated Terminal** - Sidebar or bottom panel with Cmd+J toggle
- **File Viewer** - File preview with Cmd+P search and image viewer
- **Model Selector** - Switch between models and providers
- **Chat Forking** - Fork a sub-chat from any assistant message
- **Message Queue** - Queue prompts while an agent is working
- **Voice Input** - Hold-to-talk dictation
- **Plan Mode** - Structured plans with markdown preview
- **Extended Thinking** - Enabled by default with visual UX
- **Cross Platform** - macOS, Windows, Linux

## Features

### Run coding agents the right way

Run agents locally, in worktrees, in background - without touching main branch.

![Worktree Demo](assets/worktree.gif)

- **Git Worktree Isolation** - Each chat session runs in its own isolated worktree
- **Local-first** - All code stays on your machine
- **Branch Safety** - Never accidentally commit to main branch

---

### UI that respects your code

Cursor-like UI with diff previews, built-in git client, and the ability to see changes before they land.

![UI Demo](assets/cursor-ui.gif)

- **Diff Previews** - See exactly what changes the agent is making in real-time
- **Built-in Git Client** - Stage, commit, push to GitHub, and manage branches
- **Git Activity Badges** - See git operations directly on agent messages
- **Rollback** - Roll back changes from any user message bubble
- **Real-time Tool Execution** - See bash commands, file edits, and web searches as they happen
- **File Viewer** - File preview with Cmd+P search, syntax highlighting, and image viewer
- **Chat Forking** - Fork a sub-chat from any assistant message to explore alternatives
- **File Mentions** - Reference files directly in chat with @ mentions
- **Message Queue** - Queue up prompts while an agent is working

---

### Plan mode that actually helps you think

The agent asks clarifying questions, builds structured plans, and shows clean markdown preview - all before execution.

![Plan Mode Demo](assets/plan-mode.gif)

- **Clarifying Questions** - The agent asks what it needs to know before starting
- **Structured Plans** - See step-by-step breakdown of what will happen
- **Clean Markdown Preview** - Review plans in readable format
- **Review Before Execution** - Approve or modify the plan before the agent acts
- **Extended Thinking** - Enabled by default with visual thinking gradient

## Installation

### Build from source

Prerequisites: [Bun](https://bun.sh), Python 3.11+, Xcode Command Line Tools (macOS)

```bash
git clone https://github.com/JakeVartanian/2code.git
cd 2code
bun install
bun run claude:download   # Download Claude CLI binary (required)
bun run build
bun run package:mac       # or package:win, package:linux
```

> **Note:** The `claude:download` step downloads the required Claude CLI binary. If you skip it, the app will build but agent functionality will not work.
>
> **Python note:** Python 3.11 is recommended for native module rebuilds. On Python 3.12+, make sure `setuptools` is installed (`pip install setuptools`).

## Development

```bash
bun install
bun run claude:download   # First time only
bun run dev               # Start with hot reload
```

## Tech Stack

| Layer | Tech |
|-------|------|
| Desktop | Electron, electron-vite, electron-builder |
| UI | React 19, TypeScript, Tailwind CSS |
| Components | Radix UI, Lucide icons, Motion |
| State | Jotai, Zustand, React Query |
| Backend | tRPC, Drizzle ORM, better-sqlite3 |
| AI | @anthropic-ai/claude-code |
| Package Manager | Bun |

## Attribution

2Code is a fork of [1Code](https://github.com/21st-dev/1code) by [21st.dev](https://21st.dev). The original project is licensed under Apache 2.0.

## License

Apache License 2.0 - see [LICENSE](LICENSE) for details.
