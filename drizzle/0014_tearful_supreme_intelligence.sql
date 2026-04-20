ALTER TABLE `project_memories` ADD `state` text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE `project_memories` ADD `injection_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `project_memories` ADD `utility_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `project_memories` ADD `last_utility_at` integer;--> statement-breakpoint
ALTER TABLE `project_memories` ADD `archived_at` integer;--> statement-breakpoint
ALTER TABLE `project_memories` ADD `reactivated_at` integer;--> statement-breakpoint
ALTER TABLE `project_memories` ADD `trim_cooldown_until` integer;--> statement-breakpoint
ALTER TABLE `project_memories` ADD `is_probationary` integer;--> statement-breakpoint
CREATE INDEX `project_memories_state_idx` ON `project_memories` (`state`);