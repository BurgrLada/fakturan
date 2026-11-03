CREATE TABLE `dashboard` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`is_default` integer DEFAULT false NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `dashboard_user_idx` ON `dashboard` (`user_id`,`position`);--> statement-breakpoint
CREATE UNIQUE INDEX `dashboard_default_idx` ON `dashboard` (`user_id`) WHERE is_default = 1;--> statement-breakpoint
CREATE TABLE `dashboard_widget` (
	`id` text PRIMARY KEY NOT NULL,
	`dashboard_id` text NOT NULL,
	`user_id` text NOT NULL,
	`config` text NOT NULL,
	`x` integer NOT NULL,
	`y` integer NOT NULL,
	`w` integer NOT NULL,
	`h` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`dashboard_id`) REFERENCES `dashboard`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `dashboard_widget_user_idx` ON `dashboard_widget` (`user_id`);--> statement-breakpoint
CREATE INDEX `dashboard_widget_dashboard_idx` ON `dashboard_widget` (`dashboard_id`,`user_id`);