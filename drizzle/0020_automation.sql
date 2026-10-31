CREATE TABLE `automation_settings` (
	`user_id` text PRIMARY KEY NOT NULL,
	`recurring_send` integer DEFAULT false NOT NULL,
	`reminders` integer DEFAULT false NOT NULL,
	`payment_receipt` integer DEFAULT false NOT NULL,
	`advance_invoice` integer DEFAULT false NOT NULL,
	`paused` integer DEFAULT false NOT NULL,
	`reminders_open_since` text,
	`send_time` text DEFAULT '09:00' NOT NULL,
	`daily_digest` integer DEFAULT false NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `notification` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`dedupe_key` text NOT NULL,
	`params` text NOT NULL,
	`entity_type` text,
	`entity_id` text,
	`read_at` integer,
	`resolved_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notification_user_dedupe_idx` ON `notification` (`user_id`,`dedupe_key`);--> statement-breakpoint
CREATE INDEX `notification_user_read_idx` ON `notification` (`user_id`,`read_at`,`created_at`);