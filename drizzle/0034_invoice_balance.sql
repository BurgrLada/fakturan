ALTER TABLE `invoice` ADD `credits_minor` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `invoice` ADD `advance_minor` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `invoice` ADD `superseded_at` integer;--> statement-breakpoint
ALTER TABLE `invoice` ADD `related_snapshot` text;--> statement-breakpoint
CREATE INDEX `invoice_user_related_idx` ON `invoice` (`user_id`,`related_invoice_id`);