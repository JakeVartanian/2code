/**
 * Prompt templates for the orchestration system.
 * Used by decomposition, supervision, worker instructions, and result aggregation.
 */

// ============================================================================
// Prompt Safety — sanitize user-controlled text before injection
// ============================================================================

/**
 * Sanitize text to prevent prompt boundary manipulation.
 * Replaces XML-like closing/opening tags that match our prompt boundaries
 * so injected content cannot break out of its designated section.
 */
function sanitize(text: string): string {
  // Replace XML-like tags that could close our prompt sections
  // e.g., </goal>, <goal>, </orchestrator_task>, etc.
  return text.replace(/<\/?[a-z_-]+>/gi, (match) => `[${match.slice(1, -1)}]`)
}

// ============================================================================
// Decomposition Prompt
// ============================================================================

export const DECOMPOSITION_SYSTEM_PROMPT = `You are an expert software architect decomposing a developer's goal into parallel tasks for multiple AI coding agents.

You MUST respond with ONLY valid JSON matching the schema below. No markdown, no explanation outside the JSON.

<output_schema>
{
  "reasoning": "string — Why this decomposition approach was chosen",
  "tasks": [
    {
      "name": "string — Short task name (will be used as tab title, max 60 chars)",
      "description": "string — Full task description with specific instructions for the worker agent",
      "allowedPaths": ["string — Glob patterns of files this task may create/modify"],
      "readOnlyPaths": ["string — Files task may read but not write"],
      "dependsOn": ["string — Task names this depends on (must match other task names exactly)"],
      "acceptanceCriteria": ["string — Checkable 'done' conditions"],
      "estimatedComplexity": "low | medium | high",
      "mode": "agent | plan"
    }
  ],
  "fileConflicts": [
    {
      "file": "string — File path with potential conflicts",
      "tasks": ["string — Task names that touch this file"],
      "resolution": "serialize | integration-task"
    }
  ]
}
</output_schema>

<rules>
1. FILE OWNERSHIP: Every writable file must be assigned to exactly ONE task. No two parallel tasks should modify the same file.
2. VERTICAL SLICING: Prefer giving each task a complete, self-contained feature slice (implementation + related tests) rather than splitting by layer (all models, then all routes, then all tests).
3. SHARED FILES: Files that multiple features need to modify (barrel exports like index.ts, config registrations, route registrations) should go in a final "Integration" task that depends on all feature tasks.
4. PARALLELISM: Only create parallel tasks for substantial, independent work. If tasks would take <15 minutes for a single agent, keep them sequential or merge them.
5. MAX TASKS: Maximum 8 tasks per decomposition. Prefer fewer, larger tasks over many tiny ones.
6. DEPENDENCIES: Use dependsOn to serialize tasks that would conflict. A task can depend on multiple tasks.
7. MODE: Use "agent" for tasks that write code. Use "plan" only for analysis/research tasks.
8. DESCRIPTION QUALITY: Each task description must be detailed enough for an agent to work independently without seeing other tasks' descriptions. Include specific file paths, function signatures, and expected behavior.
9. ACCEPTANCE CRITERIA: Each criterion should be objectively verifiable (e.g., "TypeScript compiles without errors", "GET /api/users returns 200", NOT vague like "code is clean").
10. INTEGRATION TASK: If multiple tasks need to modify shared files (barrel exports, config, package.json), include a final task named "Integration" that depends on all other tasks and handles these shared modifications.
</rules>`

export function buildDecompositionUserPrompt(input: {
  userGoal: string
  fileTree: string
  recentGitLog: string
  projectMemories: string
}): string {
  return `<goal>${sanitize(input.userGoal)}</goal>

<project_file_tree>
${sanitize(input.fileTree)}
</project_file_tree>

<recent_git_history>
${sanitize(input.recentGitLog)}
</recent_git_history>

<project_context>
${sanitize(input.projectMemories || "No project memories available.")}
</project_context>

Decompose this goal into parallel tasks. Remember: respond with ONLY valid JSON.`
}

// ============================================================================
// Worker System Prompt Append
// ============================================================================

export function buildWorkerSystemPrompt(input: {
  taskName: string
  taskDescription: string
  acceptanceCriteria: string[]
  allowedPaths: string[]
  readOnlyPaths: string[]
  dependencyResults: Array<{ taskName: string; resultSummary: string }>
}): string {
  const parts: string[] = []

  parts.push(`<orchestrator_task>
You are a worker agent executing a specific task within an orchestrated plan.

TASK: ${sanitize(input.taskName)}

DESCRIPTION:
${sanitize(input.taskDescription)}

ACCEPTANCE CRITERIA:
${input.acceptanceCriteria.map((c, i) => `${i + 1}. ${sanitize(c)}`).join("\n")}
</orchestrator_task>`)

  if (input.allowedPaths.length > 0) {
    parts.push(`<scope_boundaries>
You MAY create or modify files matching these patterns:
${input.allowedPaths.map((p) => `- ${p}`).join("\n")}

${input.readOnlyPaths.length > 0 ? `You MAY read (but NOT modify) these files:\n${input.readOnlyPaths.map((p) => `- ${p}`).join("\n")}` : ""}

Do NOT modify files outside your scope. Other tasks handle their own files.
</scope_boundaries>`)
  }

  if (input.dependencyResults.length > 0) {
    parts.push(`<completed_dependency_context>
The following tasks completed before yours. Use their results as context:
${input.dependencyResults.map((d) => `\n[${sanitize(d.taskName)}]:\n${sanitize(d.resultSummary)}`).join("\n")}
</completed_dependency_context>`)
  }

  parts.push(`<completion_instructions>
When you have finished ALL work for this task, end your final message with a structured completion report in this exact format:

<orchestrator-report>
{"status": "completed", "summary": "Brief description of what was done", "filesModified": ["list/of/files.ts"], "blockers": []}
</orchestrator-report>

If you cannot complete the task, use status "failed" and describe the blocker:
<orchestrator-report>
{"status": "failed", "summary": "What was attempted", "filesModified": [], "blockers": ["Description of what blocked completion"]}
</orchestrator-report>
</completion_instructions>`)

  return parts.join("\n\n")
}

// ============================================================================
// Supervisor Diagnosis Prompt
// ============================================================================

export const SUPERVISOR_DIAGNOSIS_SYSTEM_PROMPT = `You are an orchestration supervisor diagnosing a stuck AI coding agent. Analyze the worker's recent activity and determine the best intervention.

You MUST respond with ONLY valid JSON matching this schema:
{
  "diagnosis": "string — What went wrong",
  "intervention": "retry_with_hint | re_scope | skip | escalate",
  "hint": "string — Guidance message to inject (only for retry_with_hint)",
  "reason": "string — Why this intervention was chosen"
}

Intervention meanings:
- retry_with_hint: Inject a guidance message and let the worker continue
- re_scope: The task scope is wrong — abort and restart with adjusted instructions
- skip: This task cannot be completed — skip it and unblock dependents
- escalate: Human intervention needed — pause the run and notify the user`

export function buildDiagnosisUserPrompt(input: {
  taskDescription: string
  lastMessages: string
  stuckReason: string
}): string {
  return `<task_description>${sanitize(input.taskDescription)}</task_description>

<stuck_signal>${sanitize(input.stuckReason)}</stuck_signal>

<recent_worker_messages>
${sanitize(input.lastMessages)}
</recent_worker_messages>

Diagnose the issue and recommend an intervention. Respond with ONLY valid JSON.`
}

// ============================================================================
// Result Aggregation Prompt
// ============================================================================

export const AGGREGATION_SYSTEM_PROMPT = `You are summarizing the results of a multi-agent orchestration run. Write a clear, concise summary of what was accomplished.

Format your response as a brief markdown summary (2-5 paragraphs). Include:
1. What the original goal was
2. What each task accomplished
3. Any notable issues or partial completions
4. Overall outcome and next steps (if any)

Be concise and factual. Do not add unnecessary praise or filler.`

export function buildAggregationUserPrompt(input: {
  userGoal: string
  taskResults: Array<{
    name: string
    status: string
    resultSummary: string | null
    filesModified?: string[]
  }>
  qualityGateResults?: string
}): string {
  const taskSection = input.taskResults
    .map(
      (t) =>
        `### ${sanitize(t.name)} (${t.status})\n${sanitize(t.resultSummary || "No summary provided.")}${t.filesModified?.length ? `\nFiles: ${t.filesModified.join(", ")}` : ""}`,
    )
    .join("\n\n")

  return `<original_goal>${sanitize(input.userGoal)}</original_goal>

<task_results>
${taskSection}
</task_results>

${input.qualityGateResults ? `<quality_gates>\n${input.qualityGateResults}\n</quality_gates>` : ""}

Write a concise summary of this orchestration run.`
}
