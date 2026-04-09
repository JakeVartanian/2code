<!-- OPENSPEC:START -->
# OpenSpec Instructions

These instructions are for AI assistants working in this project.

Always open `@/openspec/AGENTS.md` when the request:
- Mentions planning or proposals (words like proposal, spec, change, plan)
- Introduces new capabilities, breaking changes, architecture shifts, or big performance/security work
- Sounds ambiguous and you need the authoritative spec before coding

Use `@/openspec/AGENTS.md` to learn:
- How to create and apply change proposals
- Spec format and conventions
- Project structure and guidelines

Keep this managed block so 'openspec update' can refresh the instructions.

<!-- OPENSPEC:END -->

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is this?

**2Code** - A local-first Electron desktop app for AI-powered code assistance. Users create chat sessions linked to local project folders, interact with Claude in Plan or Agent mode, and see real-time tool execution (bash, file edits, web search, etc.).

## Commands

```bash
# Development
bun run dev              # Start Electron with hot reload

# Build
bun run build            # Compile app
bun run package          # Package for current platform (dir)
bun run package:mac      # Build macOS (DMG + ZIP)
bun run package:win      # Build Windows (NSIS + portable)
bun run package:linux    # Build Linux (AppImage + DEB)

# Database (Drizzle + SQLite)
bun run db:generate      # Generate migrations from schema
bun run db:push          # Push schema directly (dev only)
```

## Architecture

```
src/
├── main/                    # Electron main process
│   ├── index.ts             # App entry, window lifecycle
│   ├── auth-manager.ts      # OAuth flow, token refresh
│   ├── auth-store.ts        # Encrypted credential storage (safeStorage)
│   ├── windows/main.ts      # Window creation, IPC handlers
│   └── lib/
│       ├── db/              # Drizzle + SQLite
│       │   ├── index.ts     # DB init, auto-migrate on startup
│       │   ├── schema/      # Drizzle table definitions
│       │   └── utils.ts     # ID generation
│       └── trpc/routers/    # tRPC routers (projects, chats, claude)
│
├── preload/                 # IPC bridge (context isolation)
│   └── index.ts             # Exposes desktopApi + tRPC bridge
│
└── renderer/                # React 19 UI
    ├── App.tsx              # Root with providers
    ├── features/
    │   ├── agents/          # Main chat interface
    │   │   ├── main/        # active-chat.tsx, new-chat-form.tsx
    │   │   ├── ui/          # Tool renderers, preview, diff view
    │   │   ├── commands/    # Slash commands (/plan, /agent, /clear)
    │   │   ├── atoms/       # Jotai atoms for agent state
    │   │   └── stores/      # Zustand store for sub-chats
    │   ├── sidebar/         # Chat list, archive, navigation
    │   ├── sub-chats/       # Tab/sidebar sub-chat management
    │   └── layout/          # Main layout with resizable panels
    ├── components/ui/       # Radix UI wrappers (button, dialog, etc.)
    └── lib/
        ├── atoms/           # Global Jotai atoms
        ├── stores/          # Global Zustand stores
        ├── trpc.ts          # Real tRPC client
        └── mock-api.ts      # DEPRECATED - being replaced with real tRPC
```

## Database (Drizzle ORM)

**Location:** `{userData}/data/agents.db` (SQLite)

**Schema:** `src/main/lib/db/schema/index.ts`

```typescript
// Three main tables:
projects    → id, name, path (local folder), timestamps
chats       → id, name, projectId, worktree fields, timestamps
sub_chats   → id, name, chatId, sessionId, mode, messages (JSON)
```

**Auto-migration:** On app start, `initDatabase()` runs migrations from `drizzle/` folder (dev) or `resources/migrations` (packaged).

**Queries:**
```typescript
import { getDatabase, projects, chats } from "../lib/db"
import { eq } from "drizzle-orm"

const db = getDatabase()
const allProjects = db.select().from(projects).all()
const projectChats = db.select().from(chats).where(eq(chats.projectId, id)).all()
```

## Key Patterns

### IPC Communication
- Uses **tRPC** with `trpc-electron` for type-safe main↔renderer communication
- All backend calls go through tRPC routers, not raw IPC
- Preload exposes `window.desktopApi` for native features (window controls, clipboard, notifications)

### State Management
- **Jotai**: UI state (selected chat, sidebar open, preview settings)
- **Zustand**: Sub-chat tabs and pinned state (persisted to localStorage)
- **React Query**: Server state via tRPC (auto-caching, refetch)

### Claude Integration
- Dynamic import of `@anthropic-ai/claude-code` SDK
- Two modes: "plan" (read-only) and "agent" (full permissions)
- Session resume via `sessionId` stored in SubChat
- Message streaming via tRPC subscription (`claude.onMessage`)

## Tech Stack

| Layer | Tech |
|-------|------|
| Desktop | Electron 33.4.5, electron-vite, electron-builder |
| UI | React 19, TypeScript 5.4.5, Tailwind CSS |
| Components | Radix UI, Lucide icons, Motion, Sonner |
| State | Jotai, Zustand, React Query |
| Backend | tRPC, Drizzle ORM, better-sqlite3 |
| AI | @anthropic-ai/claude-code |
| Package Manager | bun |

## File Naming

- Components: PascalCase (`ActiveChat.tsx`, `AgentsSidebar.tsx`)
- Utilities/hooks: camelCase (`useFileUpload.ts`, `formatters.ts`)
- Stores: kebab-case (`sub-chat-store.ts`, `agent-chat-store.ts`)
- Atoms: camelCase with `Atom` suffix (`selectedAgentChatIdAtom`)

## Important Files

- `electron.vite.config.ts` - Build config (main/preload/renderer entries)
- `src/main/lib/db/schema/index.ts` - Drizzle schema (source of truth)
- `src/main/lib/db/index.ts` - DB initialization + auto-migrate
- `src/renderer/features/agents/atoms/index.ts` - Agent UI state atoms
- `src/renderer/features/agents/main/active-chat.tsx` - Main chat component
- `src/main/lib/trpc/routers/claude.ts` - Claude SDK integration
- `src/renderer/features/agents/components/work-mode-selector.tsx` - Worktree vs Local mode selector at chat creation
- `src/main/lib/git/git-operations.ts` - Git mutations (commit, push, createPR, getWorkflowState, etc.) — exposed as `trpc.changes`
- `src/renderer/features/agents/ui/git-workflow/` - GitHub workflow panel components

## Debugging First Install Issues

When testing auth flows or behavior for new users, you need to simulate a fresh install:

```bash
# 1. Clear all app data (auth, database, settings)
rm -rf ~/Library/Application\ Support/2Code\ Dev/

# 2. Reset macOS protocol handler registration (if testing deep links)
/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister -kill -r -domain local -domain system -domain user

# 3. Clear app preferences
defaults delete dev.jakev.2code.dev  # Dev mode
defaults delete dev.jakev.2code      # Production

# 4. Run in dev mode with clean state
cd apps/desktop
bun run dev
```

**Common First-Install Bugs:**
- **OAuth deep link not working**: macOS Launch Services may not immediately recognize protocol handlers on first app launch. User may need to click "Sign in" again after the first attempt.
- **Folder dialog not appearing**: Window focus timing issues on first launch. Fixed by ensuring window focus before showing `dialog.showOpenDialog()`.

**Dev vs Production App:**
- Dev mode uses `2code-dev://` protocol
- Dev mode uses separate userData path (`~/Library/Application Support/2Code Dev/`)
- This prevents conflicts between dev and production installs

## Releasing a New Version

### CDN

- **Bucket:** `2code-releases` on Cloudflare R2 (account: hello@jakevartanian.me)
- **Public URL:** `https://pub-b08cf2e8792d44d0a8f1eeb29d23dac0.r2.dev`
- **Upload tool:** `wrangler` (already authenticated, run `wrangler whoami` to verify)
- **TODO:** When `2code.dev` is registered, add it as a custom domain on the bucket and update `CDN_BASE` in `src/main/lib/auto-updater.ts`

### Prerequisites for Notarization

- Keychain profile: `2code-notarize`
- Create with: `xcrun notarytool store-credentials "2code-notarize" --apple-id YOUR_APPLE_ID --team-id YOUR_TEAM_ID`

### Full Release Process

```bash
# 1. Bump version
npm version patch --no-git-tag-version   # e.g. 0.0.80 → 0.0.81

# 2. Build, sign, package (takes ~5 min)
bun run release    # runs: claude:download + build + package:mac + dist:manifest + upload

# OR step by step:
bun run claude:download          # update bundled Claude CLI binary
bun run build                    # compile TypeScript
bun run package:mac              # build + codesign arm64 & x64 DMGs/ZIPs

# 3. Notarize (submit both DMGs, wait for Apple)
xcrun notarytool submit release/2Code-$VERSION-arm64.dmg --keychain-profile "2code-notarize" --wait
xcrun notarytool submit release/2Code-$VERSION.dmg       --keychain-profile "2code-notarize" --wait

# 4. Staple notarization ticket to DMGs
xcrun stapler staple release/2Code-$VERSION-arm64.dmg
xcrun stapler staple release/2Code-$VERSION.dmg

# 5. Generate latest-mac.yml manifests
bun run dist:manifest

# 6. Upload everything to R2 (ZIPs first, manifests last — manifests trigger auto-updates)
./scripts/upload-release-wrangler.sh

# 7. Generate release notes and create GitHub release
# Run /release-notes in 2Code, then:
gh release create v$VERSION --title "2Code v$VERSION" --notes "..."

# 8. Sync code to public repo
./scripts/sync-to-public.sh
```

### Files Uploaded to CDN

| File | Purpose |
|------|---------|
| `latest-mac.yml` | Manifest for arm64 auto-updates — **upload last** |
| `latest-mac-x64.yml` | Manifest for Intel auto-updates — **upload last** |
| `2Code-{version}-arm64-mac.zip` | Auto-update payload (arm64) |
| `2Code-{version}-mac.zip` | Auto-update payload (Intel) |
| `2Code-{version}-arm64.dmg` | Manual download (arm64) |
| `2Code-{version}.dmg` | Manual download (Intel) |

### Auto-Update Flow

1. App checks `{CDN_BASE}/latest-mac.yml` on startup and when window regains focus (1 min cooldown)
2. If version in manifest > current version, shows "Update Available" banner
3. User clicks Download → downloads ZIP in background
4. User clicks "Restart Now" → installs update and restarts

## Git Worktrees

Each **Chat** (not tab/sub-chat) optionally has an isolated git worktree:

- **Worktree mode** (`useWorktree: true`, the default): creates a `git worktree` on a new branch, fully isolated from other chats. `chats.worktreePath` and `chats.branch` are set.
- **Local/direct mode** (`useWorktree: false`): Claude works directly in the project folder on whatever branch is currently checked out (e.g. `develop`). `chats.worktreePath` and `chats.branch` are null.

**Sub-chats (tabs)** within a chat all share the same worktree — there is no separate worktree per tab.

The user selects mode at chat creation time via `WorkModeSelector` (`src/renderer/features/agents/components/work-mode-selector.tsx`). Options: "Local" (direct) or "Worktree" (isolated).

Key DB fields on the `chats` table: `worktreePath`, `branch`, `baseBranch`, `prUrl`, `prNumber`.

The git router is registered as `trpc.changes` (not `trpc.git`) — see `src/main/lib/trpc/routers/index.ts`.

## Current Status (WIP)

**Done:**
- Drizzle ORM setup with schema (projects, chats, sub_chats)
- Auto-migration on app startup
- tRPC routers structure
- Git worktree per chat (isolation) — see Git Worktrees section above
- Claude Code execution in worktree path

**In Progress:**
- Replacing `mock-api.ts` with real tRPC calls in renderer
- ProjectSelector component (local folder picker)

**Planned:**
- Full feature parity with web app

## Debug Mode

When debugging runtime issues in the renderer or main process, use the structured debug logging system. This avoids asking the user to manually copy-paste console output.

**Start the server:**
```bash
bun packages/debug/src/server.ts &
```

**Instrument renderer code** (no import needed, fails silently):
```js
fetch('http://localhost:7799/log',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({tag:'TAG',msg:'MESSAGE',data:{},ts:Date.now()})}).catch(()=>{});
```

**Read logs:** Read `.debug/logs.ndjson` - each line is a JSON object with `tag`, `msg`, `data`, `ts`.

**Clear logs:** `curl -X DELETE http://localhost:7799/logs`

**Workflow:** Hypothesize → instrument → user reproduces → read logs → fix with evidence → verify → remove instrumentation.

See `packages/debug/INSTRUCTIONS.md` for the full protocol.

## Claude CLI Emulator

2Code bundles and emulates the Claude Code CLI rather than requiring users to have it installed. This section describes how the emulator works, how OpenRouter is wired in, and key pitfalls to avoid.

### What It Is

The app ships a pre-built Claude CLI binary inside `resources/bin/` (platform + arch sub-directory in dev, flat `resources/bin/` in production). At runtime the Electron main process executes this binary as a subprocess via the `@anthropic-ai/claude-agent-sdk` query API, which streams JSON messages back over stdio.

**Key files:**
- `src/main/lib/claude/env.ts` — binary path resolution (`getBundledClaudeBinaryPath`), shell env building (`buildClaudeEnv`), env key stripping
- `src/main/lib/claude/transform.ts` — converts raw SDK message chunks into `UIMessageChunk` objects for the renderer
- `src/main/lib/claude/types.ts` — shared message/metadata types
- `src/main/lib/trpc/routers/claude.ts` — the main tRPC router that spawns/streams Claude sessions
- `src/main/lib/claude-token.ts` — reads OAuth tokens from the OS keychain (macOS Keychain, Windows Credential Manager, Linux Secret Service) to reuse an existing Claude CLI login

### Binary Download

Binaries are not committed to the repo. Download them before running in dev:

```bash
bun run claude:download   # downloads platform binary into resources/bin/{platform}-{arch}/claude
```

**Dev path:** `resources/bin/{platform}-{arch}/claude`
**Production path:** `{resourcesPath}/bin/claude` (flat, single arch)

If the binary is missing, `getBundledClaudeBinaryPath()` logs a `WARNING` and returns the expected path anyway — the subprocess will fail at spawn time with a clear error.

### Auth Flow

Token priority (highest to lowest):

1. **Multi-account system** — active account record from `anthropicAccounts` table in SQLite, decrypted with Electron `safeStorage`.
2. **Legacy table** — `claudeCodeCredentials` row with `id = "default"`.
3. **System keychain** — `claude-token.ts` reads `Claude Code-credentials` from macOS Keychain / Windows Credential Manager / Linux Secret Service, so users who already have `claude` CLI installed and logged in don't need to authenticate again.
4. **`ANTHROPIC_AUTH_TOKEN` env var** — can be set explicitly if none of the above exist.

In dev mode `ANTHROPIC_API_KEY` is stripped from the environment so the OAuth token is used even if the developer's shell has an API key set (prevents accidentally bypassing the auth flow).

### Environment Handling

`buildClaudeEnv()` (in `env.ts`) constructs the subprocess environment:

1. Loads the full login-shell environment (captures `nvm`, Homebrew, `PATH`, etc.)
2. Overlays `process.env` but restores the richer shell `PATH`
3. Strips dangerous keys: `OPENAI_API_KEY`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `CLAUDECODE` (prevents nested-session detection)
4. In dev: also strips `ANTHROPIC_API_KEY` (forces OAuth flow)
5. Sets `CLAUDE_CODE_ENTRYPOINT=sdk-ts` and `CLAUDE_CODE_ENABLE_TASKS`

Windows uses `platform.buildEnvironment()` instead of spawning a login shell.

### OpenRouter Integration

OpenRouter allows running alternative models (GPT-4o, Gemini, Llama, etc.) through the same Claude-compatible API surface.

**Where it lives (renderer-side):**
- `src/renderer/lib/atoms/index.ts` — `openRouterApiKeyAtom` and `openRouterFreeOnlyAtom` (persisted to `localStorage`)
- `src/renderer/components/dialogs/settings-tabs/agents-models-tab.tsx` — UI for entering the key, toggling free-only filter, and listing discovered models

**How to wire an OpenRouter key into a Claude session:**

The OpenRouter API is OpenAI-compatible. To route Claude SDK calls through OpenRouter you must supply:
```
ANTHROPIC_BASE_URL=https://openrouter.ai/api/v1
ANTHROPIC_API_KEY=<openrouter-key>
```
Pass these as `customEnv` in `buildClaudeEnv()`:

```typescript
buildClaudeEnv({
  customEnv: {
    ANTHROPIC_BASE_URL: "https://openrouter.ai/api/v1",
    ANTHROPIC_API_KEY: openRouterKey,
  },
})
```

> **Important:** `ANTHROPIC_API_KEY` is normally stripped in dev mode. When OpenRouter is active you must pass the key through `customEnv` (step 4 of the env build), which runs after the strip step and therefore wins.

**Model selection:** The renderer fetches available models from `https://openrouter.ai/api/v1/models` using the stored key. Free models are identified by `pricing.prompt === "0"`. The selected model ID must be forwarded to the Claude SDK call as the `model` option so the subprocess uses it.

**Free-only filter:** `openRouterFreeOnlyAtom` gates the model list in the UI; when `true`, only models with zero prompt cost are shown.

### Fetching OpenRouter Models

```typescript
const res = await fetch("https://openrouter.ai/api/v1/models", {
  headers: { Authorization: `Bearer ${openRouterKey}` },
})
const { data } = await res.json()
const models = data.map((m) => ({
  id: m.id,
  name: m.name,
  isFree: m.pricing?.prompt === "0",
}))
```

### Session Lifecycle

```
renderer → tRPC mutation (claude.sendMessage)
         → spawns Claude subprocess with env + model
         → streams UIMessageChunks via tRPC subscription (claude.onMessage)
         → on abort: createRollbackStash() then AbortController.abort()
         → session removed from activeSessions map
```

Sessions are keyed by `subChatId` in the `activeSessions` Map. `hasActiveClaudeSessions()` and `abortAllClaudeSessions()` are called at app quit to cleanly tear down in-flight streams.

### 2Code CLI (`2code .`)

Separate from the Claude CLI emulator, 2Code ships its own shell command so users can open the app from a terminal:

```bash
2code .            # open current directory as a project
2code /path/to/project
```

**Files:** `src/main/lib/cli.ts`, platform implementations in `src/main/lib/platform/`

The CLI script is bundled at `resources/cli/` and installed/uninstalled via `installCli()` / `uninstallCli()`. On macOS/Linux it places a shell script in `/usr/local/bin`. On Windows it uses the Windows Scripting Host or PowerShell shim.

`parseLaunchDirectory()` is called at startup to capture a directory argument from `process.argv`, stored and consumed once via `getLaunchDirectory()` in the window-creation flow.

### Gotchas

| Issue | Resolution |
|-------|-----------|
| Binary not found | Run `bun run claude:download` |
| OAuth token ignored in dev | `ANTHROPIC_API_KEY` is stripped; ensure OAuth connection via Settings → Claude Code |
| OpenRouter key stripped | Pass via `customEnv`, not shell env |
| Nested session detection | `CLAUDECODE` env key is always stripped from the child process |
| Shell env stale after nvm/brew changes | Call `clearClaudeEnvCache()` and restart the app |
| Windows PATH missing tools | Platform provider (`darwin.ts` / `windows.ts`) builds PATH without spawning a shell |
