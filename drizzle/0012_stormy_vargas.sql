CREATE TABLE `orchestration_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`chat_id` text NOT NULL,
	`controller_sub_chat_id` text,
	`user_goal` text NOT NULL,
	`decomposed_plan` text NOT NULL,
	`status` text DEFAULT 'planning' NOT NULL,
	`summary` text,
	`error_message` text,
	`pre_orchestration_commit` text,
	`started_at` integer,
	`completed_at` integer,
	`updated_at` integer,
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`controller_sub_chat_id`) REFERENCES `sub_chats`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `orchestration_runs_chat_id_idx` ON `orchestration_runs` (`chat_id`);--> statement-breakpoint
CREATE INDEX `orchestration_runs_status_idx` ON `orchestration_runs` (`status`);--> statement-breakpoint
CREATE TABLE `orchestration_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`system_prompt_append` text,
	`mode` text DEFAULT 'agent' NOT NULL,
	`sub_chat_id` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`depends_on` text,
	`autonomy` text DEFAULT 'auto' NOT NULL,
	`allowed_paths` text,
	`result_summary` text,
	`result_validation` text,
	`validated_by_task_id` text,
	`started_at` integer,
	`completed_at` integer,
	FOREIGN KEY (`run_id`) REFERENCES `orchestration_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`sub_chat_id`) REFERENCES `sub_chats`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `orchestration_tasks_run_id_idx` ON `orchestration_tasks` (`run_id`);--> statement-breakpoint
CREATE INDEX `orchestration_tasks_status_idx` ON `orchestration_tasks` (`status`);--> statement-breakpoint
CREATE TABLE `project_memories` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`category` text NOT NULL,
	`title` text NOT NULL,
	`content` text NOT NULL,
	`source` text DEFAULT 'auto' NOT NULL,
	`source_sub_chat_id` text,
	`relevance_score` integer DEFAULT 50 NOT NULL,
	`access_count` integer DEFAULT 0 NOT NULL,
	`last_accessed_at` integer,
	`validated_at` integer,
	`is_stale` integer,
	`linked_files` text,
	`is_archived` integer,
	`created_at` integer,
	`updated_at` integer,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `project_memories_project_id_idx` ON `project_memories` (`project_id`);--> statement-breakpoint
CREATE INDEX `project_memories_category_idx` ON `project_memories` (`category`);--> statement-breakpoint
CREATE INDEX `project_memories_relevance_idx` ON `project_memories` (`relevance_score`);