CREATE TABLE `email_template` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`language` text NOT NULL,
	`subject` text NOT NULL,
	`body` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `email_template_user_kind_language_idx` ON `email_template` (`user_id`,`kind`,`language`);