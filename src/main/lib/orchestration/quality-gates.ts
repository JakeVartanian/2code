/**
 * Quality gates — post-task and post-run validation commands.
 * Runs shell commands in the worktree and reports pass/fail.
 * Uses async exec to avoid blocking the Electron main process.
 */

import { exec } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"

export interface QualityGateResult {
  command: string
  passed: boolean
  output: string
  durationMs: number
}

export interface OrchestratorConfig {
  qualityGates: {
    afterEachTask: string[]
    afterAllTasks: string[]
    timeout: number // seconds
  }
  concurrency: number
  workerTimeout: number // seconds
}

const DEFAULT_CONFIG: OrchestratorConfig = {
  qualityGates: {
    afterEachTask: [],
    afterAllTasks: [],
    timeout: 120,
  },
  concurrency: 4,
  workerTimeout: 900,
}

/**
 * Load orchestrator config from .2code/orchestrator.json if it exists.
 */
export function loadOrchestratorConfig(projectPath: string): OrchestratorConfig {
  const configPath = path.join(projectPath, ".2code", "orchestrator.json")
  if (!existsSync(configPath)) {
    return DEFAULT_CONFIG
  }

  try {
    const raw = readFileSync(configPath, "utf-8")
    const parsed = JSON.parse(raw) as Partial<OrchestratorConfig>
    return {
      qualityGates: {
        afterEachTask: parsed.qualityGates?.afterEachTask ?? DEFAULT_CONFIG.qualityGates.afterEachTask,
        afterAllTasks: parsed.qualityGates?.afterAllTasks ?? DEFAULT_CONFIG.qualityGates.afterAllTasks,
        timeout: Math.min(parsed.qualityGates?.timeout ?? DEFAULT_CONFIG.qualityGates.timeout, 600),
      },
      concurrency: Math.min(Math.max(parsed.concurrency ?? DEFAULT_CONFIG.concurrency, 1), 8),
      workerTimeout: Math.min(parsed.workerTimeout ?? DEFAULT_CONFIG.workerTimeout, 3600),
    }
  } catch {
    console.warn("[quality-gates] Failed to parse .2code/orchestrator.json, using defaults")
    return DEFAULT_CONFIG
  }
}

/**
 * Run a quality gate command in the given working directory (async, non-blocking).
 */
export function runQualityGate(
  command: string,
  cwd: string,
  timeoutSeconds: number = 120,
): Promise<QualityGateResult> {
  const start = Date.now()

  return new Promise((resolve) => {
    const child = exec(
      command,
      {
        cwd,
        timeout: timeoutSeconds * 1000,
        encoding: "utf-8",
        env: { ...process.env },
        maxBuffer: 1024 * 1024, // 1MB output buffer
      },
      (error, stdout, stderr) => {
        if (error) {
          const output = [stdout, stderr, error.message]
            .filter(Boolean)
            .join("\n")
            .slice(-2000)

          resolve({
            command,
            passed: false,
            output,
            durationMs: Date.now() - start,
          })
        } else {
          resolve({
            command,
            passed: true,
            output: (stdout || "").slice(-2000),
            durationMs: Date.now() - start,
          })
        }
      },
    )

    // Safety: kill on timeout (exec's timeout sends SIGTERM but we want to resolve cleanly)
    const safetyTimer = setTimeout(() => {
      child.kill("SIGKILL")
    }, (timeoutSeconds + 5) * 1000)

    child.on("exit", () => clearTimeout(safetyTimer))
  })
}

/**
 * Detect if a TypeScript project and auto-add tsc type check.
 */
export function detectDefaultGates(projectPath: string): string[] {
  const gates: string[] = []

  const tsconfigPath = path.join(projectPath, "tsconfig.json")
  if (existsSync(tsconfigPath)) {
    gates.push("npx tsc --noEmit")
  }

  return gates
}

/**
 * Run after-each-task gates. Returns results for all gates.
 */
export async function runAfterTaskGates(
  projectPath: string,
  config: OrchestratorConfig,
): Promise<QualityGateResult[]> {
  // Combine configured gates with auto-detected defaults
  const gates = config.qualityGates.afterEachTask.length > 0
    ? config.qualityGates.afterEachTask
    : detectDefaultGates(projectPath)

  const results: QualityGateResult[] = []
  for (const cmd of gates) {
    results.push(await runQualityGate(cmd, projectPath, config.qualityGates.timeout))
  }
  return results
}

/**
 * Run after-all-tasks gates. Returns results for all gates.
 */
export async function runAfterAllGates(
  projectPath: string,
  config: OrchestratorConfig,
): Promise<QualityGateResult[]> {
  // Always run auto-detected gates + configured gates
  const autoGates = detectDefaultGates(projectPath)
  const configuredGates = config.qualityGates.afterAllTasks
  const allGates = [...new Set([...autoGates, ...configuredGates])]

  const results: QualityGateResult[] = []
  for (const cmd of allGates) {
    results.push(await runQualityGate(cmd, projectPath, config.qualityGates.timeout))
  }
  return results
}
