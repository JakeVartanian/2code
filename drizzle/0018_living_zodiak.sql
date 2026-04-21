CREATE TABLE `audit_findings` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`project_id` text NOT NULL,
	`suggestion_id` text,
	`zone_id` text NOT NULL,
	`zone_name` text NOT NULL,
	`category` text NOT NULL,
	`severity` text NOT NULL,
	`title` text NOT NULL,
	`description` text NOT NULL,
	`confidence` integer DEFAULT 50 NOT NULL,
	`affected_files` text,
	`suggested_prompt` text,
	`status` text DEFAULT 'open' NOT NULL,
	`dismiss_reason` text,
	`resolved_sub_chat_id` text,
	`orchestration_task_id` text,
	`resolved_at` integer,
	`created_at` integer,
	FOREIGN KEY (`run_id`) REFERENCES `audit_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`resolved_sub_chat_id`) REFERENCES `sub_chats`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `audit_findings_project_status_idx` ON `audit_findings` (`project_id`,`status`);--> statement-breakpoint
CREATE INDEX `audit_findings_run_id_idx` ON `audit_findings` (`run_id`);--> statement-breakpoint
CREATE INDEX `audit_findings_zone_id_idx` ON `audit_findings` (`zone_id`);--> statement-breakpoint
CREATE TABLE `audit_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`zone_ids` text,
	`zone_names` text,
	`categories` text DEFAULT '["bug","security","performance","test-gap","dead-code","dependency"]' NOT NULL,
	`severity_threshold` text DEFAULT 'info' NOT NULL,
	`custom_prompt_append` text DEFAULT '' NOT NULL,
	`schedule` text DEFAULT 'manual' NOT NULL,
	`is_auto_generated` integer,
	`next_scheduled_at` integer,
	`last_used_at` integer,
	`created_at` integer,
	`updated_at` integer,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `audit_profiles_project_id_idx` ON `audit_profiles` (`project_id`);--> statement-breakpoint
CREATE TABLE `audit_run_zones` (
	`run_id` text NOT NULL,
	`zone_id` text NOT NULL,
	`zone_name` text NOT NULL,
	`zone_score` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`run_id`, `zone_id`),
	FOREIGN KEY (`run_id`) REFERENCES `audit_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `audit_run_zones_zone_run_idx` ON `audit_run_zones` (`zone_id`,`run_id`);--> statement-breakpoint
CREATE TABLE `audit_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`profile_id` text,
	`trigger` text NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`total_findings` integer DEFAULT 0 NOT NULL,
	`error_count` integer DEFAULT 0 NOT NULL,
	`warning_count` integer DEFAULT 0 NOT NULL,
	`info_count` integer DEFAULT 0 NOT NULL,
	`overall_score` integer DEFAULT 0 NOT NULL,
	`duration_ms` integer DEFAULT 0 NOT NULL,
	`initiated_by` text DEFAULT 'user' NOT NULL,
	`partial_errors` text,
	`started_at` integer,
	`completed_at` integer,
	`created_at` integer,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `audit_runs_project_id_idx` ON `audit_runs` (`project_id`);--> statement-breakpoint
CREATE INDEX `audit_runs_project_status_idx` ON `audit_runs` (`project_id`,`status`);--> statement-breakpoint
CREATE INDEX `audit_runs_project_created_idx` ON `audit_runs` (`project_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `ambient_suggestions` ADD `audit_run_id` text;