CREATE TABLE `reminder_rule` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`position` integer NOT NULL,
	`offset_days` integer NOT NULL,
	`texts` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reminder_rule_user_offset_idx` ON `reminder_rule` (`user_id`,`offset_days`);--> statement-breakpoint
CREATE TABLE `reminder_sent` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`invoice_id` text NOT NULL,
	`stage_key` text NOT NULL,
	`trigger` text NOT NULL,
	`email_log_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`invoice_id`) REFERENCES `invoice`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`email_log_id`) REFERENCES `email_log`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reminder_sent_automatic_idx` ON `reminder_sent` (`invoice_id`,`stage_key`) WHERE "reminder_sent"."trigger" = 'automatic';--> statement-breakpoint
CREATE INDEX `reminder_sent_user_invoice_idx` ON `reminder_sent` (`user_id`,`invoice_id`);--> statement-breakpoint
ALTER TABLE `invoice` ADD `reminders_off` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `invoice` ADD `reminders_snooze_until` text;--> statement-breakpoint
ALTER TABLE `invoice` ADD `reminders_partial` integer DEFAULT false NOT NULL;