import { index, primaryKey, sqliteTable, text, integer } from "drizzle-orm/sqlite-core"
import { relations } from "drizzle-orm"
import { createId } from "../utils"

// ============ PROJECTS ============
export const projects = sqliteTable("projects", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => createId()),
  name: text("name").notNull(),
  path: text("path").notNull().unique(),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(
    () => new Date(),
  ),
  updatedAt: integer("updated_at", { mode: "timestamp" }).$defaultFn(
    () => new Date(),
  ),
  // Git remote info (extracted from local .git)
  gitRemoteUrl: text("git_remote_url"),
  gitProvider: text("git_provider"), // "github" | "gitlab" | "bitbucket" | null
  gitOwner: text("git_owner"),
  gitRepo: text("git_repo"),
  // Custom project icon (absolute path to local image file)
  iconPath: text("icon_path"),
  // System architecture map (JSON-serialized SystemZone[])
  systemMap: text("system_map"),
  systemMapBuiltAt: integer("system_map_built_at", { mode: "timestamp" }),
  // Ambient agent auto-start (persists across restarts)
  ambientEnabled: integer("ambient_enabled", { mode: "boolean" }).notNull().$default(() => true),
  // Last weekly synthesis timestamp (persists across restarts)
  lastSynthesisAt: integer("last_synthesis_at", { mode: "timestamp" }),
})

export const projectsRelations = relations(projects, ({ many }) => ({
  chats: many(chats),
}))

// ============ CHATS ============
export const chats = sqliteTable("chats", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => createId()),
  name: text("name"),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(
    () => new Date(),
  ),
  updatedAt: integer("updated_at", { mode: "timestamp" }).$defaultFn(
    () => new Date(),
  ),
  archivedAt: integer("archived_at", { mode: "timestamp" }),
  // Worktree fields (for git isolation per chat)
  worktreePath: text("worktree_path"),
  branch: text("branch"),
  baseBranch: text("base_branch"),
  // PR tracking fields
  prUrl: text("pr_url"),
  prNumber: integer("pr_number"),
}, (table) => [
  index("chats_worktree_path_idx").on(table.worktreePath),
  index("chats_project_id_idx").on(table.projectId),
])

export const chatsRelations = relations(chats, ({ one, many }) => ({
  project: one(projects, {
    fields: [chats.projectId],
    references: [projects.id],
  }),
  subChats: many(subChats),
}))

// ============ SUB-CHATS ============
export const subChats = sqliteTable("sub_chats", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => createId()),
  name: text("name"),
  chatId: text("chat_id")
    .notNull()
    .references(() => chats.id, { onDelete: "cascade" }),
  sessionId: text("session_id"), // Claude SDK session ID for resume
  streamId: text("stream_id"), // Track in-progress streams
  mode: text("mode").notNull().default("agent"), // "plan" | "agent" | "orchestrator" | "system-map"
  messages: text("messages").notNull().default("[]"), // JSON array
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(
    () => new Date(),
  ),
  updatedAt: integer("updated_at", { mode: "timestamp" }).$defaultFn(
    () => new Date(),
  ),
}, (table) => [
  index("sub_chats_chat_id_idx").on(table.chatId),
])

export const subChatsRelations = relations(subChats, ({ one }) => ({
  chat: one(chats, {
    fields: [subChats.chatId],
    references: [chats.id],
  }),
}))

// ============ CLAUDE CODE CREDENTIALS ============
// Stores encrypted OAuth token for Claude Code integration
// DEPRECATED: Use anthropicAccounts for multi-account support
export const claudeCodeCredentials = sqliteTable("claude_code_credentials", {
  id: text("id").primaryKey().default("default"), // Single row, always "default"
  oauthToken: text("oauth_token").notNull(), // Encrypted with safeStorage
  connectedAt: integer("connected_at", { mode: "timestamp" }).$defaultFn(
    () => new Date(),
  ),
  userId: text("user_id"), // Desktop auth user ID (for reference)
})

// ============ ANTHROPIC ACCOUNTS (Multi-account support) ============
// Stores multiple Anthropic OAuth accounts for quick switching
export const anthropicAccounts = sqliteTable("anthropic_accounts", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => createId()),
  email: text("email"), // User's email from OAuth (if available)
  displayName: text("display_name"), // User-editable label
  oauthToken: text("oauth_token").notNull(), // Encrypted with safeStorage
  refreshToken: text("refresh_token"), // Encrypted refresh token (nullable for legacy records)
  tokenExpiresAt: integer("token_expires_at", { mode: "timestamp" }), // OAuth access token expiry
  connectedAt: integer("connected_at", { mode: "timestamp" }).$defaultFn(
    () => new Date(),
  ),
  lastUsedAt: integer("last_used_at", { mode: "timestamp" }),
  desktopUserId: text("desktop_user_id"), // Reference to local user
})

// Tracks which Anthropic account is currently active
export const anthropicSettings = sqliteTable("anthropic_settings", {
  id: text("id").primaryKey().default("singleton"), // Single row
  activeAccountId: text("active_account_id"), // References anthropicAccounts.id
  forceAccountOverride: integer("force_account_override", { mode: "boolean" }).$default(() => false),
  updatedAt: integer("updated_at", { mode: "timestamp" }).$defaultFn(
    () => new Date(),
  ),
})

// ============ PROJECT MEMORIES ============
// Persistent project knowledge base — auto-captured + manually curated
export const projectMemories = sqliteTable("project_memories", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => createId()),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  category: text("category").notNull(), // "architecture" | "convention" | "deployment" | "debugging" | "preference" | "gotcha"
  title: text("title").notNull(),
  content: text("content").notNull(),
  source: text("source").notNull().default("auto"), // "auto" | "manual" | "command" | "suggested"
  sourceSubChatId: text("source_sub_chat_id"),
  relevanceScore: integer("relevance_score").notNull().default(50), // 0-100
  accessCount: integer("access_count").notNull().default(0),
  lastAccessedAt: integer("last_accessed_at", { mode: "timestamp" }),
  validatedAt: integer("validated_at", { mode: "timestamp" }),
  isStale: integer("is_stale", { mode: "boolean" }).$default(() => false),
  linkedFiles: text("linked_files"), // JSON array of file paths
  isArchived: integer("is_archived", { mode: "boolean" }).$default(() => false),
  // Consolidation fields
  consolidatedFrom: text("consolidated_from"), // JSON array of source memory IDs
  validationCount: integer("validation_count").notNull().default(0), // times confirmed by overlapping extractions
  // Memory cycling fields
  state: text("state").notNull().default("active"), // "active" | "cold" | "dead" | "absorbed"
  injectionCount: integer("injection_count").notNull().default(0),
  utilityCount: integer("utility_count").notNull().default(0),
  lastUtilityAt: integer("last_utility_at", { mode: "timestamp" }),
  archivedAt: integer("archived_at", { mode: "timestamp" }),
  reactivatedAt: integer("reactivated_at", { mode: "timestamp" }),
  trimCooldownUntil: integer("trim_cooldown_until", { mode: "timestamp" }),
  isProbationary: integer("is_probationary", { mode: "boolean" }).$default(() => false),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(
    () => new Date(),
  ),
  updatedAt: integer("updated_at", { mode: "timestamp" }).$defaultFn(
    () => new Date(),
  ),
}, (table) => [
  index("project_memories_project_id_idx").on(table.projectId),
  index("project_memories_category_idx").on(table.category),
  index("project_memories_relevance_idx").on(table.relevanceScore),
  index("project_memories_state_idx").on(table.state),
])

export const projectMemoriesRelations = relations(projectMemories, ({ one }) => ({
  project: one(projects, {
    fields: [projectMemories.projectId],
    references: [projects.id],
  }),
}))

// ============ ORCHESTRATION RUNS ============
// Top-level orchestration session — tracks goal, plan, and overall status
export const orchestrationRuns = sqliteTable("orchestration_runs", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => createId()),
  chatId: text("chat_id")
    .notNull()
    .references(() => chats.id, { onDelete: "cascade" }),
  controllerSubChatId: text("controller_sub_chat_id")
    .references(() => subChats.id),
  userGoal: text("user_goal").notNull(),
  decomposedPlan: text("decomposed_plan").notNull(), // JSON structured plan
  status: text("status").notNull().default("planning"), // planning | running | paused | validating | completed | failed | cancelled
  summary: text("summary"),
  errorMessage: text("error_message"),
  preOrchestrationCommit: text("pre_orchestration_commit"), // git rev-parse HEAD bookmark for rollback
  startedAt: integer("started_at", { mode: "timestamp" }),
  completedAt: integer("completed_at", { mode: "timestamp" }),
  updatedAt: integer("updated_at", { mode: "timestamp" }).$defaultFn(
    () => new Date(),
  ),
}, (table) => [
  index("orchestration_runs_chat_id_idx").on(table.chatId),
  index("orchestration_runs_status_idx").on(table.status),
])

export const orchestrationRunsRelations = relations(orchestrationRuns, ({ one, many }) => ({
  chat: one(chats, {
    fields: [orchestrationRuns.chatId],
    references: [chats.id],
  }),
  controllerSubChat: one(subChats, {
    fields: [orchestrationRuns.controllerSubChatId],
    references: [subChats.id],
  }),
  tasks: many(orchestrationTasks),
}))

// ============ ORCHESTRATION TASKS ============
// Individual task within an orchestration run — maps to a worker tab
export const orchestrationTasks = sqliteTable("orchestration_tasks", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => createId()),
  runId: text("run_id")
    .notNull()
    .references(() => orchestrationRuns.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description").notNull(),
  systemPromptAppend: text("system_prompt_append"),
  mode: text("mode").notNull().default("agent"), // "plan" | "agent"
  subChatId: text("sub_chat_id")
    .references(() => subChats.id),
  status: text("status").notNull().default("pending"), // pending | blocked | queued | running | validating | completed | failed | skipped | stuck
  sortOrder: integer("sort_order").notNull().default(0),
  dependsOn: text("depends_on"), // JSON array of task IDs
  autonomy: text("autonomy").notNull().default("auto"), // "auto" | "review" | "supervised" | "plan-only"
  allowedPaths: text("allowed_paths"), // JSON array of glob patterns for scope control
  resultSummary: text("result_summary"),
  resultValidation: text("result_validation"),
  validatedByTaskId: text("validated_by_task_id"),
  startedAt: integer("started_at", { mode: "timestamp" }),
  completedAt: integer("completed_at", { mode: "timestamp" }),
}, (table) => [
  index("orchestration_tasks_run_id_idx").on(table.runId),
  index("orchestration_tasks_status_idx").on(table.status),
])

export const orchestrationTasksRelations = relations(orchestrationTasks, ({ one }) => ({
  run: one(orchestrationRuns, {
    fields: [orchestrationTasks.runId],
    references: [orchestrationRuns.id],
  }),
  subChat: one(subChats, {
    fields: [orchestrationTasks.subChatId],
    references: [subChats.id],
  }),
}))

// ============ AUDIT RUNS ============
// Tracks each audit execution with aggregate results
export const auditRuns = sqliteTable("audit_runs", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => createId()),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  profileId: text("profile_id"), // FK to auditProfiles (nullable for ad-hoc audits)
  trigger: text("trigger").notNull(), // "manual-zone" | "manual-all" | "on-commit" | "scheduled" | "skill"
  status: text("status").notNull().default("running"), // "running" | "completed" | "failed" | "cancelled"
  totalFindings: integer("total_findings").notNull().default(0),
  errorCount: integer("error_count").notNull().default(0),
  warningCount: integer("warning_count").notNull().default(0),
  infoCount: integer("info_count").notNull().default(0),
  overallScore: integer("overall_score").notNull().default(0), // 0-100 density-normalized
  durationMs: integer("duration_ms").notNull().default(0),
  initiatedBy: text("initiated_by").notNull().default("user"), // "user" | "ambient" | "skill" | "schedule"
  partialErrors: text("partial_errors"), // JSON array of {zoneId, error}
  startedAt: integer("started_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
  completedAt: integer("completed_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
}, (table) => [
  index("audit_runs_project_id_idx").on(table.projectId),
  index("audit_runs_project_status_idx").on(table.projectId, table.status),
  index("audit_runs_project_created_idx").on(table.projectId, table.createdAt),
])

export const auditRunsRelations = relations(auditRuns, ({ one, many }) => ({
  project: one(projects, {
    fields: [auditRuns.projectId],
    references: [projects.id],
  }),
  zones: many(auditRunZones),
  findings: many(auditFindings),
}))

// ============ AUDIT RUN ZONES (junction) ============
// Maps runs to zones for efficient per-zone querying and trend lookups
export const auditRunZones = sqliteTable("audit_run_zones", {
  runId: text("run_id")
    .notNull()
    .references(() => auditRuns.id, { onDelete: "cascade" }),
  zoneId: text("zone_id").notNull(),
  zoneName: text("zone_name").notNull(), // Denormalized — survives zone regen
  zoneScore: integer("zone_score").notNull().default(0), // 0-100
}, (table) => [
  primaryKey({ columns: [table.runId, table.zoneId] }),
  index("audit_run_zones_zone_run_idx").on(table.zoneId, table.runId),
])

export const auditRunZonesRelations = relations(auditRunZones, ({ one }) => ({
  run: one(auditRuns, {
    fields: [auditRunZones.runId],
    references: [auditRuns.id],
  }),
}))

// ============ AUDIT PROFILES ============
// Reusable audit configurations — AI-generated or user-designed
export const auditProfiles = sqliteTable("audit_profiles", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => createId()),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  zoneIds: text("zone_ids"), // JSON array of zone IDs; null = all zones
  zoneNames: text("zone_names"), // JSON array of names — fuzzy fallback if IDs change
  categories: text("categories").notNull().default('["bug","security","performance","test-gap","dead-code","dependency"]'), // JSON
  severityThreshold: text("severity_threshold").notNull().default("info"), // "info" | "warning" | "error"
  customPromptAppend: text("custom_prompt_append").notNull().default(""),
  schedule: text("schedule").notNull().default("manual"), // "manual" | "on-commit" | "daily"
  isAutoGenerated: integer("is_auto_generated", { mode: "boolean" }).$default(() => false),
  nextScheduledAt: integer("next_scheduled_at", { mode: "timestamp" }),
  lastUsedAt: integer("last_used_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
}, (table) => [
  index("audit_profiles_project_id_idx").on(table.projectId),
])

export const auditProfilesRelations = relations(auditProfiles, ({ one }) => ({
  project: one(projects, {
    fields: [auditProfiles.projectId],
    references: [projects.id],
  }),
}))

// ============ AUDIT FINDINGS ============
// Individual findings from audit runs — persist until explicitly resolved/dismissed
export const auditFindings = sqliteTable("audit_findings", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => createId()),
  runId: text("run_id")
    .notNull()
    .references(() => auditRuns.id, { onDelete: "cascade" }),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  suggestionId: text("suggestion_id"), // Links to ambientSuggestions for backward compat
  zoneId: text("zone_id").notNull(),
  zoneName: text("zone_name").notNull(), // Denormalized — survives zone regen
  category: text("category").notNull(),
  severity: text("severity").notNull(),
  title: text("title").notNull(),
  description: text("description").notNull(),
  confidence: integer("confidence").notNull().default(50),
  affectedFiles: text("affected_files"), // JSON array of file paths
  suggestedPrompt: text("suggested_prompt"),
  status: text("status").notNull().default("open"), // "open" | "resolved" | "dismissed" | "wont-fix"
  dismissReason: text("dismiss_reason"), // "not-relevant" | "already-handled" | "wrong"
  resolvedSubChatId: text("resolved_sub_chat_id")
    .references(() => subChats.id),
  orchestrationTaskId: text("orchestration_task_id"), // Links to orchestration task resolving this
  resolvedAt: integer("resolved_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
}, (table) => [
  index("audit_findings_project_status_idx").on(table.projectId, table.status),
  index("audit_findings_run_id_idx").on(table.runId),
  index("audit_findings_zone_id_idx").on(table.zoneId),
])

export const auditFindingsRelations = relations(auditFindings, ({ one }) => ({
  run: one(auditRuns, {
    fields: [auditFindings.runId],
    references: [auditRuns.id],
  }),
  project: one(projects, {
    fields: [auditFindings.projectId],
    references: [projects.id],
  }),
  resolvedSubChat: one(subChats, {
    fields: [auditFindings.resolvedSubChatId],
    references: [subChats.id],
  }),
}))

// ============ AMBIENT SUGGESTIONS ============
// Suggestions surfaced by the ambient background agent
export const ambientSuggestions = sqliteTable("ambient_suggestions", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => createId()),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  category: text("category").notNull(), // "bug" | "security" | "performance" | "test-gap" | "dead-code" | "dependency"
  severity: text("severity").notNull(), // "info" | "warning" | "error"
  title: text("title").notNull(),
  description: text("description").notNull(), // Markdown
  triggerEvent: text("trigger_event").notNull(), // "file-change" | "commit" | "branch-switch" | "ci-failure"
  triggerFiles: text("trigger_files"), // JSON array of file paths
  analysisModel: text("analysis_model"), // "heuristic" | "haiku" | "sonnet"
  status: text("status").notNull().default("pending"), // "pending" | "dismissed" | "approved" | "snoozed" | "expired"
  snoozedUntil: integer("snoozed_until", { mode: "timestamp" }),
  confidence: integer("confidence").notNull().default(50), // 0-100
  suggestedPrompt: text("suggested_prompt"), // Pre-filled prompt for agent tab
  draftOrchestrationPlan: text("draft_orchestration_plan"), // JSON orchestration plan
  resolvedSubChatId: text("resolved_sub_chat_id")
    .references(() => subChats.id),
  auditRunId: text("audit_run_id"), // Links to auditRuns when created by an audit (nullable)
  dismissReason: text("dismiss_reason"), // "not-relevant" | "already-handled" | "wrong" | "suppress-type"
  firstViewedAt: integer("first_viewed_at", { mode: "timestamp" }),
  tokensUsed: integer("tokens_used").default(0),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(
    () => new Date(),
  ),
  dismissedAt: integer("dismissed_at", { mode: "timestamp" }),
  approvedAt: integer("approved_at", { mode: "timestamp" }),
}, (table) => [
  index("ambient_suggestions_project_status_idx").on(table.projectId, table.status),
  index("ambient_suggestions_created_at_idx").on(table.createdAt),
])

export const ambientSuggestionsRelations = relations(ambientSuggestions, ({ one }) => ({
  project: one(projects, {
    fields: [ambientSuggestions.projectId],
    references: [projects.id],
  }),
  resolvedSubChat: one(subChats, {
    fields: [ambientSuggestions.resolvedSubChatId],
    references: [subChats.id],
  }),
}))

// ============ AMBIENT BUDGET ============
// Daily token budget tracking for the ambient agent (resets per day)
export const ambientBudget = sqliteTable("ambient_budget", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => createId()),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  date: text("date").notNull(), // "YYYY-MM-DD" for daily reset
  haikuInputTokens: integer("haiku_input_tokens").notNull().default(0),
  haikuOutputTokens: integer("haiku_output_tokens").notNull().default(0),
  haikuCalls: integer("haiku_calls").notNull().default(0),
  sonnetInputTokens: integer("sonnet_input_tokens").notNull().default(0),
  sonnetOutputTokens: integer("sonnet_output_tokens").notNull().default(0),
  sonnetCalls: integer("sonnet_calls").notNull().default(0),
  totalCostCents: integer("total_cost_cents").notNull().default(0), // Quick budget check
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(
    () => new Date(),
  ),
  updatedAt: integer("updated_at", { mode: "timestamp" }).$defaultFn(
    () => new Date(),
  ),
}, (table) => [
  index("ambient_budget_project_date_idx").on(table.projectId, table.date),
])

export const ambientBudgetRelations = relations(ambientBudget, ({ one }) => ({
  project: one(projects, {
    fields: [ambientBudget.projectId],
    references: [projects.id],
  }),
}))

// ============ MAINTENANCE ACTIONS ============
// GAAD maintenance actions requiring user approval (system map refresh, memory writes, audits, etc.)
export const maintenanceActions = sqliteTable("maintenance_actions", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => createId()),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  type: text("type").notNull(), // "refresh-system-map" | "update-memory" | "run-zone-audit" | "refresh-docs" | "archive-stale-memory"
  title: text("title").notNull(),
  description: text("description").notNull(),
  details: text("details"), // JSON — type-specific payload (e.g., which files are uncovered, which zone is stale)
  status: text("status").notNull().default("pending"), // "pending" | "approved" | "denied" | "completed" | "failed"
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(
    () => new Date(),
  ),
  completedAt: integer("completed_at", { mode: "timestamp" }),
}, (table) => [
  index("maintenance_actions_project_status_idx").on(table.projectId, table.status),
])

export const maintenanceActionsRelations = relations(maintenanceActions, ({ one }) => ({
  project: one(projects, {
    fields: [maintenanceActions.projectId],
    references: [projects.id],
  }),
}))

// ============ SESSION FILE ACTIVITY ============
// Tracks which files are modified per session for cross-session churn detection
export const sessionFileActivity = sqliteTable("session_file_activity", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => createId()),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  filePath: text("file_path").notNull(),
  timestamp: integer("timestamp", { mode: "timestamp" }).$defaultFn(
    () => new Date(),
  ),
}, (table) => [
  index("session_file_activity_project_file_idx").on(table.projectId, table.filePath, table.timestamp),
])

// ============ AMBIENT FEEDBACK ============
// Per-category feedback weights — learned from user dismissals/approvals
export const ambientFeedback = sqliteTable("ambient_feedback", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => createId()),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  category: text("category").notNull(), // Same categories as ambientSuggestions
  weight: integer("weight").notNull().default(100), // Current weight × 100 (100 = 1.0, 75 = 0.75)
  isSuppressed: integer("is_suppressed", { mode: "boolean" }).$default(() => false),
  totalDismissals: integer("total_dismissals").notNull().default(0),
  totalApprovals: integer("total_approvals").notNull().default(0),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(
    () => new Date(),
  ),
  updatedAt: integer("updated_at", { mode: "timestamp" }).$defaultFn(
    () => new Date(),
  ),
}, (table) => [
  index("ambient_feedback_project_category_idx").on(table.projectId, table.category),
])

export const ambientFeedbackRelations = relations(ambientFeedback, ({ one }) => ({
  project: one(projects, {
    fields: [ambientFeedback.projectId],
    references: [projects.id],
  }),
}))

// ============ TYPE EXPORTS ============
export type Project = typeof projects.$inferSelect
export type NewProject = typeof projects.$inferInsert
export type Chat = typeof chats.$inferSelect
export type NewChat = typeof chats.$inferInsert
export type SubChat = typeof subChats.$inferSelect
export type NewSubChat = typeof subChats.$inferInsert
export type ClaudeCodeCredential = typeof claudeCodeCredentials.$inferSelect
export type NewClaudeCodeCredential = typeof claudeCodeCredentials.$inferInsert
export type AnthropicAccount = typeof anthropicAccounts.$inferSelect
export type NewAnthropicAccount = typeof anthropicAccounts.$inferInsert
export type AnthropicSettings = typeof anthropicSettings.$inferSelect
export type ProjectMemory = typeof projectMemories.$inferSelect
export type NewProjectMemory = typeof projectMemories.$inferInsert
export type OrchestrationRun = typeof orchestrationRuns.$inferSelect
export type NewOrchestrationRun = typeof orchestrationRuns.$inferInsert
export type OrchestrationTask = typeof orchestrationTasks.$inferSelect
export type NewOrchestrationTask = typeof orchestrationTasks.$inferInsert
export type AmbientSuggestion = typeof ambientSuggestions.$inferSelect
export type NewAmbientSuggestion = typeof ambientSuggestions.$inferInsert
export type AmbientBudgetRecord = typeof ambientBudget.$inferSelect
export type NewAmbientBudgetRecord = typeof ambientBudget.$inferInsert
export type AmbientFeedbackRecord = typeof ambientFeedback.$inferSelect
export type NewAmbientFeedbackRecord = typeof ambientFeedback.$inferInsert
export type AuditRun = typeof auditRuns.$inferSelect
export type NewAuditRun = typeof auditRuns.$inferInsert
export type AuditRunZone = typeof auditRunZones.$inferSelect
export type NewAuditRunZone = typeof auditRunZones.$inferInsert
export type AuditProfile = typeof auditProfiles.$inferSelect
export type NewAuditProfile = typeof auditProfiles.$inferInsert
export type AuditFinding = typeof auditFindings.$inferSelect
export type NewAuditFinding = typeof auditFindings.$inferInsert
