CREATE TABLE `mail_look` (
	`user_id` text PRIMARY KEY NOT NULL,
	`layout` text DEFAULT 'b4' NOT NULL,
	`intro` text,
	`signature` text,
	`logo_mode` text DEFAULT 'supplier' NOT NULL,
	`logo_file_id` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`logo_file_id`) REFERENCES `file`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
ALTER TABLE `email_log` ADD `html_file_id` text REFERENCES file(id) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `email_log` ADD `html_images` text;