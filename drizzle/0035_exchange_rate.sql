CREATE TABLE `exchange_rate` (
	`currency` text NOT NULL,
	`list_date` text NOT NULL,
	`rate_micros` integer NOT NULL,
	`fetched_at` integer NOT NULL,
	PRIMARY KEY(`currency`, `list_date`)
);
--> statement-breakpoint
ALTER TABLE `preferences` ADD `fixed_rates` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `invoice` ADD `exchange_rate_source` text;--> statement-breakpoint
ALTER TABLE `invoice` ADD `exchange_rate_date` text;--> statement-breakpoint
ALTER TABLE `payment` ADD `rate_micros` integer;