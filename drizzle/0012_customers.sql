CREATE TABLE `customer` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`street` text DEFAULT '' NOT NULL,
	`city` text DEFAULT '' NOT NULL,
	`zip` text DEFAULT '' NOT NULL,
	`country` text DEFAULT 'Česká republika' NOT NULL,
	`ico` text DEFAULT '' NOT NULL,
	`dic` text DEFAULT '' NOT NULL,
	`email` text DEFAULT '' NOT NULL,
	`extra_emails` text DEFAULT '[]' NOT NULL,
	`phone` text DEFAULT '' NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`due_days` integer,
	`language` text,
	`currency` text,
	`design_id` text,
	`reminders_enabled` integer,
	`vat_verified_at` integer,
	`vat_valid` integer,
	`archived_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `customer_user_idx` ON `customer` (`user_id`,`name`);--> statement-breakpoint
CREATE INDEX `customer_ico_idx` ON `customer` (`user_id`,`ico`);