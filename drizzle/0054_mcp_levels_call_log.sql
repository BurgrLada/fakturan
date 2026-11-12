CREATE TABLE `mcp_call_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`owner_id` text NOT NULL,
	`at` integer NOT NULL,
	`client_id` text NOT NULL,
	`client_name` text NOT NULL,
	`tool` text NOT NULL,
	`outcome` text NOT NULL,
	`reason` text,
	`required_level` text,
	`request_id` text NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `mcp_call_log_owner_at` ON `mcp_call_log` (`owner_id`,`at`);--> statement-breakpoint
ALTER TABLE `mcp_settings` ADD `level` text DEFAULT 'read' NOT NULL;--> statement-breakpoint
ALTER TABLE `mcp_settings` ADD `log_calls` integer DEFAULT true NOT NULL;--> statement-breakpoint
-- MCP-055: an assistant that could create drafts keeps that; every other one starts at read.
UPDATE `mcp_settings` SET `level` = CASE WHEN `can_create` = 1 THEN 'drafts' ELSE 'read' END;