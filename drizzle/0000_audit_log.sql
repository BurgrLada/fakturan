CREATE TABLE `audit_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` integer NOT NULL,
	`actor_id` text,
	`owner_id` text,
	`source` text NOT NULL,
	`scope` text NOT NULL,
	`action` text NOT NULL,
	`entity` text NOT NULL,
	`entity_id` text,
	`before` text,
	`after` text,
	`ip` text,
	`user_agent` text,
	`request_id` text
);
--> statement-breakpoint
CREATE INDEX `audit_log_owner_at_idx` ON `audit_log` (`owner_id`,`at`);--> statement-breakpoint
CREATE INDEX `audit_log_entity_idx` ON `audit_log` (`entity`,`entity_id`);--> statement-breakpoint
CREATE TABLE `audit_purge` (
	`owner_id` text PRIMARY KEY NOT NULL
);
