CREATE TABLE `recurring_invoice` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`customer_id` text,
	`document` text NOT NULL,
	`frequency` text NOT NULL,
	`every` integer DEFAULT 1 NOT NULL,
	`issue_rule` text NOT NULL,
	`issue_day` integer,
	`starts_on` text NOT NULL,
	`ends_on` text,
	`max_count` integer,
	`period_offset` integer DEFAULT 0 NOT NULL,
	`mode` text DEFAULT 'draft' NOT NULL,
	`notify_days_before` integer,
	`status` text DEFAULT 'active' NOT NULL,
	`cursor_date` text NOT NULL,
	`send_confirmed_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`customer_id`) REFERENCES `customer`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `recurring_invoice_user_idx` ON `recurring_invoice` (`user_id`,`status`);--> statement-breakpoint
CREATE TABLE `recurring_run` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`recurring_id` text NOT NULL,
	`period_key` text NOT NULL,
	`planned_date` text NOT NULL,
	`period_from` text NOT NULL,
	`period_to` text NOT NULL,
	`status` text NOT NULL,
	`invoice_id` text,
	`reason` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`recurring_id`) REFERENCES `recurring_invoice`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`invoice_id`) REFERENCES `invoice`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `recurring_run_period_idx` ON `recurring_run` (`recurring_id`,`period_key`);--> statement-breakpoint
CREATE INDEX `recurring_run_user_idx` ON `recurring_run` (`user_id`);--> statement-breakpoint
CREATE INDEX `recurring_run_invoice_idx` ON `recurring_run` (`invoice_id`);--> statement-breakpoint
ALTER TABLE `invoice` ADD `recurring_id` text REFERENCES recurring_invoice(id) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `invoice` ADD `period_from` text;--> statement-breakpoint
ALTER TABLE `invoice` ADD `period_to` text;--> statement-breakpoint
CREATE INDEX `invoice_recurring_idx` ON `invoice` (`recurring_id`);