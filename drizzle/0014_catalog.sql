CREATE TABLE `catalog_item` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`unit` text NOT NULL,
	`price_minor` integer NOT NULL,
	`currency` text NOT NULL,
	`category` text DEFAULT '' NOT NULL,
	`tags` text DEFAULT '[]' NOT NULL,
	`search_text` text DEFAULT '' NOT NULL,
	`use_count` integer DEFAULT 0 NOT NULL,
	`archived_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `catalog_item_user_idx` ON `catalog_item` (`user_id`,`name`);--> statement-breakpoint
CREATE INDEX `catalog_item_usage_idx` ON `catalog_item` (`user_id`,`use_count`);--> statement-breakpoint
CREATE TABLE `unit` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`position` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `unit_user_name_idx` ON `unit` (`user_id`,`name`);