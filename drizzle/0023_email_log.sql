CREATE TABLE `email_log` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`invoice_id` text NOT NULL,
	`kind` text NOT NULL,
	`trigger` text NOT NULL,
	`to` text NOT NULL,
	`cc` text NOT NULL,
	`bcc` text NOT NULL,
	`subject` text NOT NULL,
	`body` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`reason` text,
	`file_id` text,
	`invoice_revision` integer NOT NULL,
	`planned_for` text,
	`automation` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`message_id` text,
	`created_at` integer NOT NULL,
	`sent_at` integer,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`invoice_id`) REFERENCES `invoice`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`file_id`) REFERENCES `file`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `email_log_user_invoice_created_idx` ON `email_log` (`user_id`,`invoice_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `email_log_running_idx` ON `email_log` (`invoice_id`,`kind`) WHERE "email_log"."status" IN ('queued', 'sending');