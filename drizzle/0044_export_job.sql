CREATE TABLE `export_job` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`format` text NOT NULL,
	`filter` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`progress` integer DEFAULT 0 NOT NULL,
	`progress_total` integer DEFAULT 0 NOT NULL,
	`file_id` text,
	`reason` text,
	`expires_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`file_id`) REFERENCES `file`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `export_job_user_idx` ON `export_job` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `export_job_status_idx` ON `export_job` (`status`,`expires_at`);--> statement-breakpoint
ALTER TABLE `email_log` ADD `attach_isdoc` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `email_log` ADD `isdoc_file_id` text REFERENCES file(id) ON DELETE SET NULL;