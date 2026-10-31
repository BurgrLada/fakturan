CREATE TABLE `bank_notification` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`dedupe_key` text NOT NULL,
	`bank` text NOT NULL,
	`variant` text,
	`status` text NOT NULL,
	`reason` text,
	`auth_result` text NOT NULL,
	`bank_account_id` text,
	`account_masked` text,
	`amount_minor` integer,
	`currency` text,
	`paid_on` text,
	`paid_time` text,
	`variable_symbol` text,
	`constant_symbol` text,
	`counterparty_masked` text,
	`counterparty_name` text,
	`message` text,
	`instruction_id` text,
	`text_masked` text,
	`received_at` integer NOT NULL,
	`purged_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`bank_account_id`) REFERENCES `bank_account`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bank_notification_user_dedupe_idx` ON `bank_notification` (`user_id`,`dedupe_key`);--> statement-breakpoint
CREATE INDEX `bank_notification_user_status_idx` ON `bank_notification` (`user_id`,`status`,`received_at`);--> statement-breakpoint
ALTER TABLE `payment` ADD `notification_id` text REFERENCES bank_notification(id) ON DELETE SET NULL;--> statement-breakpoint
CREATE INDEX `payment_notification_idx` ON `payment` (`notification_id`);--> statement-breakpoint
CREATE INDEX `invoice_user_variable_symbol_idx` ON `invoice` (`user_id`,`variable_symbol`);