CREATE TABLE `invoice` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`type` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`cancelled_from` text,
	`number` text,
	`variable_symbol` text,
	`variable_symbol_manual` integer DEFAULT false NOT NULL,
	`series_id` text,
	`customer_id` text,
	`customer_name` text DEFAULT '' NOT NULL,
	`bank_account_id` text,
	`issue_date` text,
	`due_date` text,
	`taxable_date` text,
	`language` text NOT NULL,
	`currency` text NOT NULL,
	`exchange_rate_micros` integer,
	`payment_method` text NOT NULL,
	`order_ref` text DEFAULT '' NOT NULL,
	`reference` text DEFAULT '' NOT NULL,
	`text_before` text DEFAULT '' NOT NULL,
	`text_after` text DEFAULT '' NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`discount_kind` text DEFAULT 'none' NOT NULL,
	`discount_value` integer DEFAULT 0 NOT NULL,
	`rounding` text DEFAULT 'none' NOT NULL,
	`subtotal_minor` integer DEFAULT 0 NOT NULL,
	`discount_minor` integer DEFAULT 0 NOT NULL,
	`rounding_minor` integer DEFAULT 0 NOT NULL,
	`total_minor` integer DEFAULT 0 NOT NULL,
	`paid_minor` integer DEFAULT 0 NOT NULL,
	`appearance` text NOT NULL,
	`supplier_snapshot` text,
	`customer_snapshot` text,
	`account_snapshot` text,
	`logo_file_id` text,
	`qr_logo_file_id` text,
	`signature_file_id` text,
	`related_invoice_id` text,
	`external` integer DEFAULT false NOT NULL,
	`search_text` text DEFAULT '' NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`issued_at` integer,
	`sent_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`series_id`) REFERENCES `number_series`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`customer_id`) REFERENCES `customer`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`bank_account_id`) REFERENCES `bank_account`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`logo_file_id`) REFERENCES `file`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`qr_logo_file_id`) REFERENCES `file`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`signature_file_id`) REFERENCES `file`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`related_invoice_id`) REFERENCES `invoice`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invoice_user_number_idx` ON `invoice` (`user_id`,`number`) WHERE number IS NOT NULL;--> statement-breakpoint
CREATE INDEX `invoice_user_status_idx` ON `invoice` (`user_id`,`status`);--> statement-breakpoint
CREATE INDEX `invoice_user_issue_date_idx` ON `invoice` (`user_id`,`issue_date`);--> statement-breakpoint
CREATE INDEX `invoice_user_customer_idx` ON `invoice` (`user_id`,`customer_id`);--> statement-breakpoint
CREATE TABLE `invoice_line` (
	`id` text PRIMARY KEY NOT NULL,
	`invoice_id` text NOT NULL,
	`user_id` text NOT NULL,
	`position` integer NOT NULL,
	`catalog_item_id` text,
	`name` text DEFAULT '' NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`quantity_milli` integer NOT NULL,
	`unit` text DEFAULT '' NOT NULL,
	`unit_price_minor` integer NOT NULL,
	`discount_kind` text DEFAULT 'none' NOT NULL,
	`discount_value` integer DEFAULT 0 NOT NULL,
	`net_minor` integer NOT NULL,
	FOREIGN KEY (`invoice_id`) REFERENCES `invoice`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`catalog_item_id`) REFERENCES `catalog_item`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `invoice_line_invoice_idx` ON `invoice_line` (`invoice_id`,`position`);--> statement-breakpoint
CREATE INDEX `invoice_line_user_idx` ON `invoice_line` (`user_id`);--> statement-breakpoint
CREATE TABLE `invoice_tag` (
	`invoice_id` text NOT NULL,
	`tag_id` text NOT NULL,
	`user_id` text NOT NULL,
	PRIMARY KEY(`invoice_id`, `tag_id`),
	FOREIGN KEY (`invoice_id`) REFERENCES `invoice`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tag_id`) REFERENCES `tag`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `invoice_tag_tag_idx` ON `invoice_tag` (`tag_id`);--> statement-breakpoint
CREATE INDEX `invoice_tag_user_idx` ON `invoice_tag` (`user_id`);--> statement-breakpoint
CREATE TABLE `tag` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`name_key` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tag_user_name_key_idx` ON `tag` (`user_id`,`name_key`);--> statement-breakpoint
ALTER TABLE `preferences` ADD `surface_color` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `preferences` ADD `text_color` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `preferences` ADD `line_color` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `preferences` ADD `logo_position` text DEFAULT 'left' NOT NULL;--> statement-breakpoint
ALTER TABLE `preferences` ADD `rounding` text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE `preferences` ADD `pdf_file_name` text DEFAULT '{cislo}.pdf' NOT NULL;--> statement-breakpoint
ALTER TABLE `preferences` ADD `fx_basis` text DEFAULT 'issue_date' NOT NULL;