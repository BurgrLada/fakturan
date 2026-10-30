CREATE TABLE `invoice_version` (
	`id` text PRIMARY KEY NOT NULL,
	`invoice_id` text NOT NULL,
	`user_id` text NOT NULL,
	`version_no` integer NOT NULL,
	`document` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`invoice_id`) REFERENCES `invoice`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invoice_version_invoice_no_idx` ON `invoice_version` (`invoice_id`,`version_no`);--> statement-breakpoint
CREATE INDEX `invoice_version_user_idx` ON `invoice_version` (`user_id`);