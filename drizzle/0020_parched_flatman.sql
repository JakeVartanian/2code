ALTER TABLE `project_memories` ADD `consolidated_from` text;--> statement-breakpoint
ALTER TABLE `project_memories` ADD `validation_count` integer DEFAULT 0 NOT NULL;