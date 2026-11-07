ALTER TABLE `automation_settings` ADD `period_summary` text DEFAULT 'off' NOT NULL;--> statement-breakpoint
ALTER TABLE `automation_settings` ADD `tax_reminder` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `automation_settings` ADD `limit_mail` integer DEFAULT false NOT NULL;