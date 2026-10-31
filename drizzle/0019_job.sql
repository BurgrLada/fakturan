CREATE TABLE `job` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text,
	`kind` text NOT NULL,
	`key` text NOT NULL,
	`payload` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`run_at` integer NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer NOT NULL,
	`locked_by` text,
	`reason` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `job_key_unique` ON `job` (`key`);--> statement-breakpoint
CREATE INDEX `job_status_run_at_idx` ON `job` (`status`,`run_at`);--> statement-breakpoint
CREATE TABLE `scheduler_state` (
	`id` integer PRIMARY KEY NOT NULL,
	`holder` text,
	`lease_until` integer,
	`started_at` integer,
	`last_tick_at` integer,
	`last_ok_at` integer,
	`last_backup_at` integer,
	`last_backup_try_at` integer
);
