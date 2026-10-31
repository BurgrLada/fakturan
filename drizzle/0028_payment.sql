CREATE TABLE `payment` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`invoice_id` text NOT NULL,
	`kind` text NOT NULL,
	`paid_on` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`currency` text NOT NULL,
	`credited_minor` integer NOT NULL,
	`method` text NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`source` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`invoice_id`) REFERENCES `invoice`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `payment_user_invoice_idx` ON `payment` (`user_id`,`invoice_id`);--> statement-breakpoint
CREATE INDEX `payment_user_paid_on_idx` ON `payment` (`user_id`,`paid_on`);