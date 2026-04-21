/**
 * Brain backfill — "Build Brain" for existing projects.
 *
 * Multi-pass deep analysis that reads source files, git history, schema,
 * configs, and project structure to build a comprehensive memory bank.
 *
 * Passes:
 *   1. Architecture & Components — directory structure, key files, data model
 *   2. Git Evolution — commit history patterns, feature timeline, contributors
 *   3. Code Patterns & Conventions — sampled source files, naming, state mgmt
 *   4. Integrations & APIs — router files, provider configs, external deps
 *   5. Bugs, Gotchas & Active Work — fix commits, crash patterns, recent focus
 *   6. Philosophy & Principles — team values, decision patterns, build culture
 *   7. Quality & Technical Debt — TODOs, inconsistencies, gaps, code smells
 *   8. Opportunities & Forward Direction — strategic improvements, next steps
 *
 * Cost: ~$0.40-0.60 (8 Sonnet calls)
 * Time: ~3-5 minutes
 * Idempotent: safe to run multiple times (dedup prevents duplicates).
 */

import { existsSync, readFileSync, readdirSync, statSync } from "fs"
import { join, extname, relative } from "path"
import { execSync } from "child_process"
import { eq, and } from "drizzle-orm"
import { getDatabase } from "../db"
import { projectMemories } from "../db/schema"
import { createId } from "../db/utils"
import type { AmbientProvider } from "./provider"

export interface BackfillResult {
  memoriesCreated: number
  memoriesUpdated: number
  sources: string[]
  durationMs: number
}

// ============ SYSTEM PROMPTS PER PASS ============

const MEMORY_FORMAT_INSTRUCTIONS = `Output ONLY a JSON array. Each memory object:
{
  "category": "architecture|convention|deployment|debugging|preference|gotcha",
  "title": "Short descriptive title (max 80 chars, NO [CLAUDE.md] prefix)",
  "content": "Detailed explanation. Use ALWAYS:/NEVER:/Applies-to: format where appropriate. Be specific — reference actual file names, function names, patterns.",
  "linkedFiles": ["path/to/file.ts"]
}

Rules:
- Be SPECIFIC to THIS project. Reference actual file names, variable names, patterns.
- Each memory should teach something a new developer needs to know.
- Don't repeat general programming knowledge — only project-specific insights.
- Content should be 2-5 sentences, detailed enough to be actionable.
- linkedFiles should reference real files that demonstrate the pattern.`

const PASS_PROMPTS: Record<string, string> = {
  architecture: `You are analyzing a software project's architecture and components to create foundational knowledge memories. This is the MOST IMPORTANT pass — create a comprehensive map of every major piece.

Focus on:
- EVERY major module, feature, and component — what it does and where it lives
- The full directory structure rationale — why things are organized this way
- Data model and database schema (every table, relationships, what they represent)
- How all the pieces connect to each other (data flow, imports, IPC, events)
- Entry points and how the app boots up end-to-end
- State management approach — what tools, where state lives, how it flows
- Component hierarchy and feature boundaries
- Smart contracts, APIs, or other domain-specific systems and their paths
- Key abstractions and design patterns used throughout
- Where a new developer would need to look first vs what they can ignore

Create one memory per major component/module so the brain has a complete map.
Generate 20-30 memories covering the FULL architectural landscape.

${MEMORY_FORMAT_INSTRUCTIONS}`,

  evolution: `You are analyzing a software project's git history to understand its evolution, development patterns, and team dynamics.

Focus on:
- Major milestones and feature launches (from commit messages)
- How the project has evolved over time (what was built first, what came later)
- Active areas of development (what's being worked on recently)
- Development velocity and patterns (feature cycles, refactoring waves)
- Key contributors and their focus areas
- Version history and release patterns

Generate 15-25 memories about the project's history and trajectory.

${MEMORY_FORMAT_INSTRUCTIONS}`,

  conventions: `You are analyzing source code files to identify coding conventions, patterns, and style decisions specific to this project.

Focus on:
- Naming conventions (files, variables, functions, components)
- File organization patterns (where things go, how features are structured)
- State management patterns (which tools, how state flows)
- Component patterns (how UI components are built, what primitives are used)
- Error handling patterns
- Import organization and module boundaries
- Testing patterns (if any tests exist)
- TypeScript usage patterns (strict vs loose, type organization)

Generate 15-25 memories about coding patterns and conventions.

${MEMORY_FORMAT_INSTRUCTIONS}`,

  integrations: `You are analyzing a project's external integrations, API surfaces, and third-party dependencies.

Focus on:
- API endpoints and router structure (what the backend exposes)
- Authentication and authorization flow
- External service integrations (APIs, databases, cloud services)
- Build system and tooling (bundler, package manager, scripts)
- Key dependencies and why they're used
- IPC/communication patterns between processes
- Configuration management and environment handling

Generate 15-25 memories about integrations and infrastructure.

${MEMORY_FORMAT_INSTRUCTIONS}`,

  debugging: `You are analyzing a project's bug history, crash patterns, and known gotchas to help future developers avoid pitfalls.

Focus on:
- Common bug patterns visible from fix commits
- Areas of the codebase that are fragile or frequently fixed
- Race conditions, timing issues, or concurrency problems
- Known gotchas or "watch out for this" situations
- Error handling gaps or edge cases
- Performance-sensitive areas
- What areas require careful testing
- Recent bugs and their root causes

Generate 15-25 memories about pitfalls, debugging tips, and gotchas.

${MEMORY_FORMAT_INSTRUCTIONS}`,

  philosophy: `You are analyzing a software project to understand its building philosophy, principles, and decision-making patterns. Study the CLAUDE.md, README, commit messages, and code structure to extract the team's values and approach.

Focus on:
- Core building principles — what does this team prioritize? (speed vs correctness, DX vs performance, simplicity vs flexibility)
- Decision-making patterns — when faced with trade-offs, which way do they lean? (visible from commit patterns and code choices)
- Code ownership philosophy — is it one person's vision or collaborative? How do they handle contributions?
- Quality standards — what level of polish is expected? Do they ship fast and fix later, or get it right first?
- Communication style — how are commits written? What do PR descriptions look like? Is there documentation culture?
- Design values — minimalism vs feature-richness? User-first vs developer-first?
- What the CLAUDE.md reveals about how they want AI assistants to behave — this IS the team's philosophy codified
- Release philosophy — how often, how carefully, what's the process?
- How they handle scope — do they gold-plate or stay minimal? Evidence from commit patterns.

Generate 10-20 memories that capture how this team THINKS and BUILDS.

${MEMORY_FORMAT_INSTRUCTIONS}`,

  quality: `You are a senior code reviewer analyzing a project for technical debt, quality gaps, and areas that need improvement. Be honest and constructive — the goal is to help the team see their blind spots.

Focus on:
- Code duplication — are there repeated patterns that should be abstracted?
- Inconsistencies — different approaches to the same problem in different parts of the codebase
- Dead code or unused exports — things that exist but serve no purpose
- TODO/FIXME/HACK comments — what's been deferred and why?
- Missing error handling — where could things blow up silently?
- Missing tests — which critical paths have no test coverage?
- Over-engineering — areas that are more complex than they need to be
- Under-engineering — areas that are too simple for what they need to handle
- Type safety gaps — any usage, implicit any, or loose typing
- State management inconsistencies — mixing patterns unnecessarily
- Performance concerns — unnecessary re-renders, memory leaks, N+1 queries
- Security concerns — exposed credentials, injection risks, missing validation
- Dependency risks — outdated deps, abandoned packages, version conflicts

Be specific. Name files, functions, patterns. Don't be generic — be a tough but fair reviewer.
Generate 15-25 memories about quality issues and technical debt.

${MEMORY_FORMAT_INSTRUCTIONS}`,

  opportunities: `You are a technical strategist analyzing a project to identify its most impactful improvement opportunities. You've seen the architecture, the history, the conventions, and the quality gaps. Now synthesize it all into forward-looking recommendations.

Focus on:
- What's the NEXT logical evolution of this codebase? What patterns are emerging that should be completed?
- Where are the biggest leverage points — small changes that would have outsized impact?
- What architectural improvements would pay dividends? (e.g., extracting a service, adding a cache layer, unifying state management)
- What conventions should be standardized that currently aren't?
- What testing strategy would give the most confidence with least effort?
- What refactoring would make the codebase significantly easier to work with?
- What dependencies should be updated, replaced, or removed?
- What documentation is missing that would save hours of onboarding time?
- Performance optimizations that are low-hanging fruit
- Developer experience improvements (better error messages, faster builds, easier debugging)
- What features or capabilities are partially built but not finished?
- Where is the team's approach diverging from best practices in ways that will cost them later?

Think like a CTO doing a quarterly architecture review. Be specific and actionable.
Generate 15-25 memories about opportunities and strategic improvements.

${MEMORY_FORMAT_INSTRUCTIONS}`,
}

// ============ MAIN BRAIN BUILD ============

/**
 * Full brain build — multi-pass deep analysis of the entire project.
 */
export async function buildBrain(
  projectId: string,
  projectPath: string,
  provider: AmbientProvider,
): Promise<BackfillResult> {
  const start = Date.now()
  const sources: string[] = []
  let created = 0
  let updated = 0

  const writeMemory = (memory: { category: string; title: string; content: string; linkedFiles: string[] }) => {
    const wasCreated = writeMemoryDeduped(projectId, memory)
    if (wasCreated) created++
    else updated++
  }

  // Phase 0: Import CLAUDE.md sections directly (free, local)
  const claudeMdCreated = importClaudeMd(projectId, projectPath)
  if (claudeMdCreated > 0) {
    created += claudeMdCreated
    sources.push("CLAUDE.md")
  }

  // Phase 0b: Git coupling analysis (free, local)
  const gitCreated = analyzeGitCoupling(projectId, projectPath)
  if (gitCreated > 0) {
    created += gitCreated
    sources.push("git-coupling")
  }

  // Gather all signals once (reused across passes)
  const signals = gatherDeepSignals(projectPath)

  // Pass 1: Architecture & Components
  try {
    const archContext = buildArchitectureContext(signals)
    const archMemories = await callForMemories(provider, PASS_PROMPTS.architecture, archContext)
    archMemories.forEach(writeMemory)
    sources.push("architecture-scan")
  } catch (err) {
    console.error("[Brain] Architecture pass failed:", err)
  }

  // Pass 2: Git Evolution & History
  try {
    const evoContext = buildEvolutionContext(signals)
    const evoMemories = await callForMemories(provider, PASS_PROMPTS.evolution, evoContext)
    evoMemories.forEach(writeMemory)
    sources.push("git-evolution")
  } catch (err) {
    console.error("[Brain] Evolution pass failed:", err)
  }

  // Pass 3: Code Patterns & Conventions
  try {
    const convContext = buildConventionsContext(signals)
    const convMemories = await callForMemories(provider, PASS_PROMPTS.conventions, convContext)
    convMemories.forEach(writeMemory)
    sources.push("code-conventions")
  } catch (err) {
    console.error("[Brain] Conventions pass failed:", err)
  }

  // Pass 4: Integrations & APIs
  try {
    const intContext = buildIntegrationsContext(signals)
    const intMemories = await callForMemories(provider, PASS_PROMPTS.integrations, intContext)
    intMemories.forEach(writeMemory)
    sources.push("integrations")
  } catch (err) {
    console.error("[Brain] Integrations pass failed:", err)
  }

  // Pass 5: Bugs, Gotchas & Active Work
  try {
    const debugContext = buildDebuggingContext(signals)
    const debugMemories = await callForMemories(provider, PASS_PROMPTS.debugging, debugContext)
    debugMemories.forEach(writeMemory)
    sources.push("debugging-gotchas")
  } catch (err) {
    console.error("[Brain] Debugging pass failed:", err)
  }

  // Pass 6: Philosophy & Principles
  try {
    const philContext = buildPhilosophyContext(signals)
    const philMemories = await callForMemories(provider, PASS_PROMPTS.philosophy, philContext)
    philMemories.forEach(writeMemory)
    sources.push("philosophy")
  } catch (err) {
    console.error("[Brain] Philosophy pass failed:", err)
  }

  // Pass 7: Quality & Technical Debt
  try {
    const qualContext = buildQualityContext(signals)
    const qualMemories = await callForMemories(provider, PASS_PROMPTS.quality, qualContext)
    qualMemories.forEach(writeMemory)
    sources.push("quality-debt")
  } catch (err) {
    console.error("[Brain] Quality pass failed:", err)
  }

  // Pass 8: Opportunities & Forward Direction
  try {
    const oppContext = buildOpportunitiesContext(signals)
    const oppMemories = await callForMemories(provider, PASS_PROMPTS.opportunities, oppContext)
    oppMemories.forEach(writeMemory)
    sources.push("opportunities")
  } catch (err) {
    console.error("[Brain] Opportunities pass failed:", err)
  }

  return {
    memoriesCreated: created,
    memoriesUpdated: updated,
    sources: [...new Set(sources)],
    durationMs: Date.now() - start,
  }
}

/**
 * Incremental brain refresh — only looks at activity since last refresh.
 */
export async function refreshBrain(
  projectId: string,
  projectPath: string,
  provider: AmbientProvider,
): Promise<BackfillResult> {
  return buildBrain(projectId, projectPath, provider)
}

/**
 * Get brain status for a project.
 */
export function getBrainStatus(projectId: string): {
  memoryCount: number
  autoMemoryCount: number
  lastBuilt: Date | null
  categories: Record<string, number>
} {
  const db = getDatabase()

  const memories = db.select()
    .from(projectMemories)
    .where(and(
      eq(projectMemories.projectId, projectId),
      eq(projectMemories.isArchived, false),
    ))
    .all()

  const autoMemories = memories.filter(m => m.source === "auto")

  const categories: Record<string, number> = {}
  for (const m of memories) {
    categories[m.category] = (categories[m.category] ?? 0) + 1
  }

  const lastAuto = autoMemories
    .map(m => m.createdAt)
    .filter(Boolean)
    .sort((a, b) => (b?.getTime() ?? 0) - (a?.getTime() ?? 0))[0]

  return {
    memoryCount: memories.length,
    autoMemoryCount: autoMemories.length,
    lastBuilt: lastAuto ?? null,
    categories,
  }
}

// ============ DEEP SIGNAL GATHERING ============

interface DeepSignals {
  // Structure
  fileTree: string
  directoryTree: string
  sourceFileCount: number
  totalFileList: string[]

  // Config
  packageJson: string | null
  tsconfig: string | null
  readme: string | null
  claudeMd: string | null
  eslintConfig: string | null

  // Git
  gitLogFull: string | null        // All commits (oneline)
  gitLogDetailed: string | null    // Recent with file stats
  gitLogByArea: string | null      // Commits grouped by changed directories
  gitContributors: string | null
  gitBranches: string | null
  gitTags: string | null
  gitFixCommits: string | null     // Bug fix commits
  gitFeatureCommits: string | null // Feature commits
  gitHotspots: string | null       // Most modified files
  gitRecentDiffs: string | null    // Actual diffs from recent commits

  // Source samples
  sampledFiles: Map<string, string> // path -> content (key files)

  // Build/CI
  ciWorkflows: string[]
  buildScripts: string | null

  // Schema/Data
  schemaFiles: string[]

  // Quality signals
  todoComments: string | null       // TODO/FIXME/HACK comments found in code
  gitRefactorCommits: string | null // Refactoring commits
  gitRevertCommits: string | null   // Reverts (indicates mistakes/instability)
}

function gatherDeepSignals(projectPath: string): DeepSignals {
  const allFiles = getAllSourceFiles(projectPath)

  return {
    fileTree: getShallowFileTree(projectPath, 4),
    directoryTree: getDirectoryTree(projectPath),
    sourceFileCount: allFiles.length,
    totalFileList: allFiles,

    packageJson: readIfExists(join(projectPath, "package.json"), 4000),
    tsconfig: readIfExists(join(projectPath, "tsconfig.json"), 2000),
    readme: readIfExists(join(projectPath, "README.md"), 4000),
    claudeMd: readIfExists(join(projectPath, "CLAUDE.md"), 6000),
    eslintConfig: readIfExists(join(projectPath, ".eslintrc.json"), 500)
      ?? readIfExists(join(projectPath, "eslint.config.js"), 500),

    gitLogFull: gitCmd(projectPath, "git log --oneline --no-decorate -200"),
    gitLogDetailed: gitCmd(projectPath, 'git log --no-decorate --stat=80 --format="--- %h %s (%an, %ar)" -30'),
    gitLogByArea: gitCmd(projectPath, 'git log --no-decorate --name-only --format="--- %h %s" -100'),
    gitContributors: gitCmd(projectPath, 'git shortlog -sn --all --no-merges'),
    gitBranches: gitCmd(projectPath, 'git branch -a --format="%(refname:short) %(committerdate:relative)"'),
    gitTags: gitCmd(projectPath, 'git tag --sort=-creatordate -l | head -20'),
    gitFixCommits: gitCmd(projectPath, 'git log --oneline --no-decorate --grep="fix\\|bug\\|crash\\|broken\\|revert\\|hotfix" -i -40'),
    gitFeatureCommits: gitCmd(projectPath, 'git log --oneline --no-decorate --grep="feat\\|add\\|implement\\|new\\|support" -i -40'),
    gitHotspots: gitCmd(projectPath, "git log --name-only --pretty=format: -200 | grep -v '^$' | sort | uniq -c | sort -rn | head -30"),
    gitRecentDiffs: gitCmd(projectPath, 'git log --no-decorate -p --stat=80 -5 -- "*.ts" "*.tsx" | head -500'),

    sampledFiles: sampleKeyFiles(projectPath, allFiles),

    ciWorkflows: getCIWorkflows(projectPath),
    buildScripts: extractBuildScripts(projectPath),

    schemaFiles: findSchemaFiles(projectPath, allFiles),

    todoComments: gitCmd(projectPath, 'grep -rn "TODO\\|FIXME\\|HACK\\|XXX\\|WORKAROUND\\|DEPRECATED" --include="*.ts" --include="*.tsx" --include="*.js" . | grep -v node_modules | grep -v ".git/" | head -40'),
    gitRefactorCommits: gitCmd(projectPath, 'git log --oneline --no-decorate --grep="refactor\\|cleanup\\|clean up\\|reorganize\\|restructure\\|simplify" -i -20'),
    gitRevertCommits: gitCmd(projectPath, 'git log --oneline --no-decorate --grep="revert\\|rollback\\|undo" -i -15'),
  }
}

// ============ CONTEXT BUILDERS (per pass) ============

function buildArchitectureContext(s: DeepSignals): string {
  let ctx = "# Project Architecture Analysis\n\n"

  ctx += `## Source Files: ${s.sourceFileCount} total\n\n`
  ctx += `## Directory Structure\n\`\`\`\n${s.directoryTree}\n\`\`\`\n\n`
  ctx += `## File Tree (4 levels)\n\`\`\`\n${s.fileTree.slice(0, 4000)}\n\`\`\`\n\n`

  if (s.packageJson) ctx += `## package.json\n\`\`\`json\n${s.packageJson}\n\`\`\`\n\n`
  if (s.tsconfig) ctx += `## tsconfig.json\n\`\`\`json\n${s.tsconfig}\n\`\`\`\n\n`

  // Include schema/data model files
  for (const schemaPath of s.schemaFiles.slice(0, 3)) {
    const content = s.sampledFiles.get(schemaPath)
    if (content) ctx += `## Schema: ${schemaPath}\n\`\`\`typescript\n${content}\n\`\`\`\n\n`
  }

  // Include key entry points and structural files
  const structuralKeywords = ["index.ts", "main.ts", "app.ts", "App.tsx", "router", "schema"]
  for (const [path, content] of s.sampledFiles) {
    if (structuralKeywords.some(k => path.includes(k)) && !s.schemaFiles.includes(path)) {
      ctx += `## ${path}\n\`\`\`typescript\n${content.slice(0, 2000)}\n\`\`\`\n\n`
    }
    if (ctx.length > 20000) break
  }

  if (s.readme) ctx += `## README.md\n${s.readme.slice(0, 2000)}\n\n`

  return ctx.slice(0, 25000)
}

function buildEvolutionContext(s: DeepSignals): string {
  let ctx = "# Project Evolution Analysis\n\n"

  if (s.gitLogFull) ctx += `## Full Commit History (last 200)\n\`\`\`\n${s.gitLogFull.slice(0, 6000)}\n\`\`\`\n\n`
  if (s.gitContributors) ctx += `## Contributors\n\`\`\`\n${s.gitContributors}\n\`\`\`\n\n`
  if (s.gitTags) ctx += `## Version Tags\n\`\`\`\n${s.gitTags}\n\`\`\`\n\n`
  if (s.gitBranches) ctx += `## Branches\n\`\`\`\n${s.gitBranches.slice(0, 2000)}\n\`\`\`\n\n`
  if (s.gitFeatureCommits) ctx += `## Feature Commits\n\`\`\`\n${s.gitFeatureCommits}\n\`\`\`\n\n`
  if (s.gitLogDetailed) ctx += `## Recent Commits (detailed)\n\`\`\`\n${s.gitLogDetailed.slice(0, 5000)}\n\`\`\`\n\n`
  if (s.gitHotspots) ctx += `## File Hotspots (most changed)\n\`\`\`\n${s.gitHotspots}\n\`\`\`\n\n`

  return ctx.slice(0, 25000)
}

function buildConventionsContext(s: DeepSignals): string {
  let ctx = "# Code Conventions Analysis\n\n"

  ctx += `## File naming samples\n`
  const samplePaths = s.totalFileList.slice(0, 80).join("\n")
  ctx += `\`\`\`\n${samplePaths}\n\`\`\`\n\n`

  // Include diverse source file samples
  let sampledCount = 0
  for (const [path, content] of s.sampledFiles) {
    if (sampledCount >= 12) break
    // Skip schema files (covered in architecture pass)
    if (s.schemaFiles.includes(path)) continue
    ctx += `## ${path}\n\`\`\`typescript\n${content.slice(0, 1500)}\n\`\`\`\n\n`
    sampledCount++
    if (ctx.length > 22000) break
  }

  if (s.eslintConfig) ctx += `## ESLint Config\n\`\`\`\n${s.eslintConfig}\n\`\`\`\n\n`

  return ctx.slice(0, 25000)
}

function buildIntegrationsContext(s: DeepSignals): string {
  let ctx = "# Integrations & API Analysis\n\n"

  if (s.packageJson) {
    ctx += `## Dependencies (package.json)\n\`\`\`json\n${s.packageJson}\n\`\`\`\n\n`
  }

  // Include router/API files
  const apiKeywords = ["router", "api", "trpc", "handler", "middleware", "provider", "auth", "client"]
  let apiCount = 0
  for (const [path, content] of s.sampledFiles) {
    if (apiCount >= 10) break
    if (apiKeywords.some(k => path.toLowerCase().includes(k))) {
      ctx += `## ${path}\n\`\`\`typescript\n${content.slice(0, 2000)}\n\`\`\`\n\n`
      apiCount++
    }
    if (ctx.length > 22000) break
  }

  if (s.ciWorkflows.length > 0) {
    ctx += `## CI/CD Workflows\n${s.ciWorkflows.join("\n---\n")}\n\n`
  }

  if (s.buildScripts) {
    ctx += `## Build Scripts\n\`\`\`json\n${s.buildScripts}\n\`\`\`\n\n`
  }

  return ctx.slice(0, 25000)
}

function buildDebuggingContext(s: DeepSignals): string {
  let ctx = "# Bug Patterns & Gotchas Analysis\n\n"

  if (s.gitFixCommits) ctx += `## Bug Fix Commits (last 40)\n\`\`\`\n${s.gitFixCommits}\n\`\`\`\n\n`
  if (s.gitHotspots) ctx += `## File Hotspots (frequently changed = potentially fragile)\n\`\`\`\n${s.gitHotspots}\n\`\`\`\n\n`
  if (s.gitRecentDiffs) ctx += `## Recent Diffs (actual code changes)\n\`\`\`\n${s.gitRecentDiffs}\n\`\`\`\n\n`

  // Include crash/error handling files
  const debugKeywords = ["crash", "error", "recovery", "debug", "log", "exception", "stash", "rollback"]
  let debugCount = 0
  for (const [path, content] of s.sampledFiles) {
    if (debugCount >= 6) break
    if (debugKeywords.some(k => path.toLowerCase().includes(k))) {
      ctx += `## ${path}\n\`\`\`typescript\n${content.slice(0, 2000)}\n\`\`\`\n\n`
      debugCount++
    }
    if (ctx.length > 22000) break
  }

  if (s.claudeMd) {
    // Extract gotcha/debugging sections from CLAUDE.md
    const gotchaSection = s.claudeMd.match(/##.*(?:gotcha|debug|caveat|important|warning)[\s\S]*?(?=\n## |\n$)/gi)
    if (gotchaSection) {
      ctx += `## CLAUDE.md Gotchas\n${gotchaSection.join("\n\n").slice(0, 3000)}\n\n`
    }
  }

  return ctx.slice(0, 25000)
}

function buildPhilosophyContext(s: DeepSignals): string {
  let ctx = "# Project Philosophy & Principles Analysis\n\n"

  // CLAUDE.md is the primary source — it IS the team's codified philosophy
  if (s.claudeMd) ctx += `## CLAUDE.md (team's AI instructions = their values codified)\n${s.claudeMd.slice(0, 6000)}\n\n`
  if (s.readme) ctx += `## README.md\n${s.readme.slice(0, 3000)}\n\n`

  // Commit message patterns reveal priorities
  if (s.gitLogFull) ctx += `## Commit History (patterns reveal priorities)\n\`\`\`\n${s.gitLogFull.slice(0, 4000)}\n\`\`\`\n\n`
  if (s.gitContributors) ctx += `## Contributors\n\`\`\`\n${s.gitContributors}\n\`\`\`\n\n`
  if (s.gitFeatureCommits) ctx += `## Feature Commits (what they build)\n\`\`\`\n${s.gitFeatureCommits}\n\`\`\`\n\n`
  if (s.gitFixCommits) ctx += `## Fix Commits (what they care about fixing)\n\`\`\`\n${s.gitFixCommits}\n\`\`\`\n\n`
  if (s.gitRefactorCommits) ctx += `## Refactoring Commits (what they clean up)\n\`\`\`\n${s.gitRefactorCommits}\n\`\`\`\n\n`
  if (s.buildScripts) ctx += `## Build Scripts (process reveals values)\n\`\`\`json\n${s.buildScripts}\n\`\`\`\n\n`

  return ctx.slice(0, 25000)
}

function buildQualityContext(s: DeepSignals): string {
  let ctx = "# Code Quality & Technical Debt Analysis\n\n"

  // TODO/FIXME/HACK comments are explicit debt markers
  if (s.todoComments) ctx += `## TODO/FIXME/HACK Comments Found\n\`\`\`\n${s.todoComments}\n\`\`\`\n\n`

  // Reverts indicate instability
  if (s.gitRevertCommits) ctx += `## Revert Commits (instability indicators)\n\`\`\`\n${s.gitRevertCommits}\n\`\`\`\n\n`

  // Hotspots = frequently changed = potentially fragile
  if (s.gitHotspots) ctx += `## File Hotspots (churn = potential fragility)\n\`\`\`\n${s.gitHotspots}\n\`\`\`\n\n`

  // Fix commits show where bugs cluster
  if (s.gitFixCommits) ctx += `## Bug Fix Pattern (where bugs cluster)\n\`\`\`\n${s.gitFixCommits}\n\`\`\`\n\n`

  // Recent diffs show current code quality
  if (s.gitRecentDiffs) ctx += `## Recent Code Changes (quality of recent work)\n\`\`\`\n${s.gitRecentDiffs}\n\`\`\`\n\n`

  // Sample diverse files to spot inconsistencies
  let fileCount = 0
  for (const [path, content] of s.sampledFiles) {
    if (fileCount >= 10) break
    ctx += `## ${path}\n\`\`\`typescript\n${content.slice(0, 1500)}\n\`\`\`\n\n`
    fileCount++
    if (ctx.length > 22000) break
  }

  return ctx.slice(0, 25000)
}

function buildOpportunitiesContext(s: DeepSignals): string {
  let ctx = "# Strategic Opportunities Analysis\n\n"
  ctx += "You have already analyzed this project's architecture, evolution, conventions, integrations, debugging patterns, philosophy, and quality. Now synthesize ALL of that into forward-looking recommendations.\n\n"

  // Give a high-level overview so the model has context
  ctx += `## Project Scale: ${s.sourceFileCount} source files\n\n`
  ctx += `## Directory Structure\n\`\`\`\n${s.directoryTree}\n\`\`\`\n\n`

  if (s.packageJson) {
    // Just deps section for strategic analysis
    try {
      const pkg = JSON.parse(s.packageJson)
      const deps = { ...pkg.dependencies, ...pkg.devDependencies }
      ctx += `## Dependencies (${Object.keys(deps).length} total)\n\`\`\`json\n${JSON.stringify(deps, null, 2).slice(0, 3000)}\n\`\`\`\n\n`
    } catch { /* ignore */ }
  }

  if (s.todoComments) ctx += `## Outstanding TODOs\n\`\`\`\n${s.todoComments}\n\`\`\`\n\n`
  if (s.gitLogFull) ctx += `## Full History (trajectory)\n\`\`\`\n${s.gitLogFull.slice(0, 3000)}\n\`\`\`\n\n`
  if (s.gitHotspots) ctx += `## Hotspots\n\`\`\`\n${s.gitHotspots}\n\`\`\`\n\n`
  if (s.gitRefactorCommits) ctx += `## Past Refactoring\n\`\`\`\n${s.gitRefactorCommits}\n\`\`\`\n\n`

  // Include CLAUDE.md for understanding stated goals vs reality
  if (s.claudeMd) ctx += `## CLAUDE.md (stated goals)\n${s.claudeMd.slice(0, 3000)}\n\n`

  return ctx.slice(0, 25000)
}

// ============ API CALL ============

async function callForMemories(
  provider: AmbientProvider,
  systemPrompt: string,
  userContent: string,
): Promise<Array<{ category: string; title: string; content: string; linkedFiles: string[] }>> {
  const result = await provider.callSonnet(systemPrompt, userContent)
  return parseMemories(result.text)
}

function parseMemories(text: string): Array<{ category: string; title: string; content: string; linkedFiles: string[] }> {
  try {
    const jsonMatch = text.match(/\[[\s\S]*\]/)
    if (!jsonMatch) return []

    const parsed = JSON.parse(jsonMatch[0])
    if (!Array.isArray(parsed)) return []

    const validCategories = new Set(["architecture", "convention", "deployment", "debugging", "preference", "gotcha"])

    return parsed
      .filter((m: any) => m.title && m.content && validCategories.has(m.category))
      .slice(0, 25)
      .map((m: any) => ({
        category: m.category,
        title: String(m.title).slice(0, 100),
        content: String(m.content),
        linkedFiles: Array.isArray(m.linkedFiles) ? m.linkedFiles.filter((f: any) => typeof f === "string") : [],
      }))
  } catch {
    console.warn("[Brain] Failed to parse memories from AI response")
    return []
  }
}

// ============ FILE SAMPLING ============

/**
 * Sample key files from the project — prioritizes structural/important files.
 * Returns a map of path -> content (truncated).
 */
function sampleKeyFiles(projectPath: string, allFiles: string[]): Map<string, string> {
  const sampled = new Map<string, string>()
  const maxFileSize = 3000

  // Priority 1: Schema, config, and structural files
  const highPriority = [
    "schema", "index.ts", "router", "trpc", "main.ts", "app.ts", "App.tsx",
    "auth", "provider", "store", "atom", "types", "config",
    "crash", "error", "recovery", "middleware",
  ]

  // Priority 2: Feature entry points
  const medPriority = [
    "component", "hook", "util", "lib", "helper", "service",
  ]

  // Collect high-priority files first
  for (const kw of highPriority) {
    for (const file of allFiles) {
      if (sampled.size >= 40) break
      if (file.toLowerCase().includes(kw) && !sampled.has(file)) {
        const content = readIfExists(join(projectPath, file), maxFileSize)
        if (content && content.length > 50) {
          sampled.set(file, content)
        }
      }
    }
  }

  // Fill remaining with medium-priority
  for (const kw of medPriority) {
    for (const file of allFiles) {
      if (sampled.size >= 50) break
      if (file.toLowerCase().includes(kw) && !sampled.has(file)) {
        const content = readIfExists(join(projectPath, file), maxFileSize)
        if (content && content.length > 50) {
          sampled.set(file, content)
        }
      }
    }
  }

  return sampled
}

/**
 * Get all source files in the project (ts, tsx, js, jsx, py, rs, go, etc.)
 */
function getAllSourceFiles(projectPath: string): string[] {
  const sourceExts = new Set([".ts", ".tsx", ".js", ".jsx", ".py", ".rs", ".go", ".java", ".rb", ".swift", ".kt"])
  const skipDirs = new Set(["node_modules", ".git", "dist", "build", ".next", "coverage", "__pycache__", "vendor", ".cache", "out", ".turbo"])
  const files: string[] = []

  function walk(dir: string, depth: number) {
    if (depth > 8) return
    try {
      const entries = readdirSync(dir)
      for (const entry of entries) {
        if (skipDirs.has(entry)) continue
        if (entry.startsWith(".") && depth === 0) continue

        const fullPath = join(dir, entry)
        try {
          const stat = statSync(fullPath)
          if (stat.isDirectory()) {
            walk(fullPath, depth + 1)
          } else if (sourceExts.has(extname(entry))) {
            files.push(relative(projectPath, fullPath))
          }
        } catch { continue }
      }
    } catch { /* unreadable dir */ }
  }

  walk(projectPath, 0)
  return files.sort()
}

/**
 * Find schema/data model files.
 */
function findSchemaFiles(projectPath: string, allFiles: string[]): string[] {
  return allFiles.filter(f =>
    f.toLowerCase().includes("schema") ||
    f.toLowerCase().includes("model") ||
    f.toLowerCase().includes("migration") ||
    f.toLowerCase().includes("drizzle") ||
    f.toLowerCase().includes("prisma"),
  ).slice(0, 5)
}

// ============ GIT UTILITIES ============

function gitCmd(projectPath: string, cmd: string): string | null {
  try {
    const result = execSync(cmd, {
      cwd: projectPath,
      encoding: "utf-8",
      timeout: 8000,
      maxBuffer: 1024 * 512,
    }).trim()
    return result || null
  } catch {
    return null
  }
}

// ============ FILE UTILITIES ============

function readIfExists(path: string, maxChars?: number): string | null {
  if (!existsSync(path)) return null
  try {
    let content = readFileSync(path, "utf-8")
    if (maxChars && content.length > maxChars) {
      content = content.slice(0, maxChars) + "\n[...truncated]"
    }
    return content
  } catch {
    return null
  }
}

function getShallowFileTree(dir: string, maxDepth: number, prefix = "", depth = 0): string {
  if (depth >= maxDepth) return ""

  const SKIP = new Set(["node_modules", ".git", "dist", "build", ".next", "coverage", "__pycache__", "vendor", ".cache", "out"])
  const lines: string[] = []

  try {
    const entries = readdirSync(dir).sort().slice(0, 80)
    for (const entry of entries) {
      if (SKIP.has(entry)) continue
      if (entry.startsWith(".") && depth === 0 && entry !== ".github") continue

      const fullPath = join(dir, entry)
      try {
        const stat = statSync(fullPath)
        if (stat.isDirectory()) {
          lines.push(`${prefix}${entry}/`)
          const subtree = getShallowFileTree(fullPath, maxDepth, prefix + "  ", depth + 1)
          if (subtree) lines.push(subtree)
        } else {
          lines.push(`${prefix}${entry}`)
        }
      } catch { continue }
    }
  } catch { /* unreadable dir */ }

  return lines.join("\n")
}

function getDirectoryTree(projectPath: string): string {
  try {
    const result = execSync(
      "find . -type d -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/dist/*' -not -path '*/out/*' -not -path '*/build/*' -not -path '*/.next/*' -not -path '*/.cache/*' | sort | head -60",
      { cwd: projectPath, encoding: "utf-8", timeout: 5000 },
    ).trim()
    return result
  } catch {
    return ""
  }
}

function getCIWorkflows(projectPath: string): string[] {
  const workflowDir = join(projectPath, ".github", "workflows")
  if (!existsSync(workflowDir)) return []

  try {
    return readdirSync(workflowDir)
      .filter(f => f.endsWith(".yml") || f.endsWith(".yaml"))
      .slice(0, 3)
      .map(f => {
        const content = readIfExists(join(workflowDir, f), 1000)
        return content ? `### ${f}\n${content}` : ""
      })
      .filter(Boolean)
  } catch {
    return []
  }
}

function extractBuildScripts(projectPath: string): string | null {
  const pkg = readIfExists(join(projectPath, "package.json"))
  if (!pkg) return null

  try {
    const parsed = JSON.parse(pkg)
    if (parsed.scripts) {
      return JSON.stringify(parsed.scripts, null, 2)
    }
  } catch { /* ignore */ }

  return null
}

// ============ CLAUDE.MD IMPORT ============

function importClaudeMd(projectId: string, projectPath: string): number {
  const claudeMdPath = join(projectPath, "CLAUDE.md")
  if (!existsSync(claudeMdPath)) return 0

  let content: string
  try {
    content = readFileSync(claudeMdPath, "utf-8")
  } catch {
    return 0
  }

  const sections = content.split(/^## /m).slice(1)
  let created = 0

  for (const section of sections.slice(0, 15)) {
    const lines = section.split("\n")
    const title = lines[0]?.trim()
    if (!title) continue

    const body = lines.slice(1).join("\n").trim()
    if (body.length < 20) continue

    const category = detectCategory(title, body)

    const wasCreated = writeMemoryDeduped(projectId, {
      category,
      title: `[CLAUDE.md] ${title}`.slice(0, 100),
      content: body.slice(0, 1000),
      linkedFiles: ["CLAUDE.md"],
    })

    if (wasCreated) created++
  }

  return created
}

// ============ GIT COUPLING ============

function analyzeGitCoupling(projectId: string, projectPath: string): number {
  let gitLog: string
  try {
    gitLog = execSync(
      'git log --name-only --pretty=format:"---" -150',
      { cwd: projectPath, encoding: "utf-8", timeout: 10000 },
    )
  } catch {
    return 0
  }

  const commits = gitLog.split("---").filter(Boolean)
  const pairCounts = new Map<string, number>()

  for (const commit of commits) {
    const files = commit.trim().split("\n").filter(f => f.trim() && !f.includes("node_modules"))
    if (files.length < 2 || files.length > 20) continue

    for (let i = 0; i < files.length; i++) {
      for (let j = i + 1; j < files.length; j++) {
        const pair = [files[i].trim(), files[j].trim()].sort().join(" <-> ")
        pairCounts.set(pair, (pairCounts.get(pair) ?? 0) + 1)
      }
    }
  }

  const strongPairs = [...pairCounts.entries()]
    .filter(([, count]) => count >= 4)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)

  let created = 0
  for (const [pair, count] of strongPairs) {
    const [fileA, fileB] = pair.split(" <-> ")
    const wasCreated = writeMemoryDeduped(projectId, {
      category: "architecture",
      title: `Coupled files: ${shortName(fileA)} + ${shortName(fileB)}`,
      content: `ALWAYS: When modifying ${fileA}, check if ${fileB} also needs changes.\nThese files changed together in ${count} of the last 150 commits, indicating tight coupling.\nApplies to: ${fileA}, ${fileB}`,
      linkedFiles: [fileA, fileB],
    })
    if (wasCreated) created++
  }

  return created
}

function shortName(filePath: string): string {
  const parts = filePath.split("/")
  return parts[parts.length - 1] ?? filePath
}

function detectCategory(title: string, body: string): string {
  const text = (title + " " + body).toLowerCase()
  if (/architect|structur|schema|database|api|route|component|module/.test(text)) return "architecture"
  if (/deploy|build|ci|cd|release|docker|server|production/.test(text)) return "deployment"
  if (/debug|fix|bug|error|crash|issue|problem/.test(text)) return "debugging"
  if (/convention|style|naming|pattern|format|lint/.test(text)) return "convention"
  if (/gotcha|caveat|warning|careful|watch out|pitfall/.test(text)) return "gotcha"
  if (/prefer|always|never|use|avoid|default/.test(text)) return "preference"
  return "architecture"
}

// ============ MEMORY WRITE ============

function writeMemoryDeduped(
  projectId: string,
  memory: { category: string; title: string; content: string; linkedFiles: string[] },
): boolean {
  const db = getDatabase()

  const existing = db.select({ id: projectMemories.id })
    .from(projectMemories)
    .where(and(
      eq(projectMemories.projectId, projectId),
      eq(projectMemories.title, memory.title),
    ))
    .get()

  if (existing) return false

  db.insert(projectMemories)
    .values({
      id: createId(),
      projectId,
      category: memory.category,
      title: memory.title,
      content: memory.content,
      source: "auto",
      linkedFiles: JSON.stringify(memory.linkedFiles),
      relevanceScore: 60,
    })
    .run()

  return true
}
