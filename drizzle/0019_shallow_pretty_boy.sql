CREATE TABLE `session_file_activity` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`file_path` text NOT NULL,
	`timestamp` integer,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `session_file_activity_project_file_idx` ON `session_file_activity` (`project_id`,`file_path`,`timestamp`);