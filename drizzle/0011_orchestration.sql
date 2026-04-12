CREATE TABLE `orchestration_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`chat_id` text NOT NULL,
	`sub_chat_id` text,
	`goal` text NOT NULL,
	`status` text DEFAULT 'planning' NOT NULL,
	`task_graph` text,
	`memory_context` text,
	`checkpoint` text,
	`total_cost_usd` integer DEFAULT 0,
	`created_at` integer,
	`updated_at` integer,
	`completed_at` integer,
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `orchestration_runs_chat_id_idx` ON `orchestration_runs` (`chat_id`);
--> statement-breakpoint
CREATE INDEX `orchestration_runs_sub_chat_id_idx` ON `orchestration_runs` (`sub_chat_id`);
--> statement-breakpoint
CREATE TABLE `orchestration_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`worker_type` text NOT NULL,
	`description` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`depends_on` text DEFAULT '[]',
	`memory_files` text DEFAULT '[]',
	`result` text,
	`error` text,
	`started_at` integer,
	`completed_at` integer,
	FOREIGN KEY (`run_id`) REFERENCES `orchestration_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `orchestration_tasks_run_id_idx` ON `orchestration_tasks` (`run_id`);
