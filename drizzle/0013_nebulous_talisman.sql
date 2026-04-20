CREATE TABLE `ambient_budget` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`date` text NOT NULL,
	`haiku_input_tokens` integer DEFAULT 0 NOT NULL,
	`haiku_output_tokens` integer DEFAULT 0 NOT NULL,
	`haiku_calls` integer DEFAULT 0 NOT NULL,
	`sonnet_input_tokens` integer DEFAULT 0 NOT NULL,
	`sonnet_output_tokens` integer DEFAULT 0 NOT NULL,
	`sonnet_calls` integer DEFAULT 0 NOT NULL,
	`total_cost_cents` integer DEFAULT 0 NOT NULL,
	`created_at` integer,
	`updated_at` integer,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ambient_budget_project_date_idx` ON `ambient_budget` (`project_id`,`date`);--> statement-breakpoint
CREATE TABLE `ambient_feedback` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`category` text NOT NULL,
	`weight` integer DEFAULT 100 NOT NULL,
	`is_suppressed` integer,
	`total_dismissals` integer DEFAULT 0 NOT NULL,
	`total_approvals` integer DEFAULT 0 NOT NULL,
	`created_at` integer,
	`updated_at` integer,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ambient_feedback_project_category_idx` ON `ambient_feedback` (`project_id`,`category`);--> statement-breakpoint
CREATE TABLE `ambient_suggestions` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`category` text NOT NULL,
	`severity` text NOT NULL,
	`title` text NOT NULL,
	`description` text NOT NULL,
	`trigger_event` text NOT NULL,
	`trigger_files` text,
	`analysis_model` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`snoozed_until` integer,
	`confidence` integer DEFAULT 50 NOT NULL,
	`suggested_prompt` text,
	`draft_orchestration_plan` text,
	`resolved_sub_chat_id` text,
	`dismiss_reason` text,
	`first_viewed_at` integer,
	`tokens_used` integer DEFAULT 0,
	`created_at` integer,
	`dismissed_at` integer,
	`approved_at` integer,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`resolved_sub_chat_id`) REFERENCES `sub_chats`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `ambient_suggestions_project_status_idx` ON `ambient_suggestions` (`project_id`,`status`);--> statement-breakpoint
CREATE INDEX `ambient_suggestions_created_at_idx` ON `ambient_suggestions` (`created_at`);