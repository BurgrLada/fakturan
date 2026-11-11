CREATE TABLE `mcp_settings` (
	`user_id` text PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`can_read` integer DEFAULT true NOT NULL,
	`can_create` integer DEFAULT false NOT NULL,
	`can_edit` integer DEFAULT false NOT NULL,
	`can_issue` integer DEFAULT false NOT NULL,
	`can_send` integer DEFAULT false NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `audit_log` ADD `client_id` text;--> statement-breakpoint
ALTER TABLE `audit_log` ADD `client_name` text;--> statement-breakpoint
ALTER TABLE `oauth_consent` ADD `last_used_at` integer;