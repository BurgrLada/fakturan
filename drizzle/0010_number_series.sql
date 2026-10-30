CREATE TABLE `number_series` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`document_type` text NOT NULL,
	`template` text NOT NULL,
	`reset` text NOT NULL,
	`is_default` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `number_series_user_idx` ON `number_series` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `number_series_default_idx` ON `number_series` (`user_id`,`document_type`) WHERE is_default = 1;--> statement-breakpoint
CREATE TABLE `number_series_counter` (
	`series_id` text NOT NULL,
	`period_key` text NOT NULL,
	`user_id` text NOT NULL,
	`next` integer NOT NULL,
	`highest` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`series_id`, `period_key`),
	FOREIGN KEY (`series_id`) REFERENCES `number_series`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `number_series_counter_user_idx` ON `number_series_counter` (`user_id`);