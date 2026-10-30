CREATE TABLE `bank_account` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`currency` text NOT NULL,
	`number` text DEFAULT '' NOT NULL,
	`bank_code` text DEFAULT '' NOT NULL,
	`iban` text NOT NULL,
	`swift` text DEFAULT '' NOT NULL,
	`is_default` integer DEFAULT false NOT NULL,
	`hidden` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `bank_account_user_idx` ON `bank_account` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `bank_account_default_idx` ON `bank_account` (`user_id`,`currency`) WHERE is_default = 1;