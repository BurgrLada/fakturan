DROP INDEX `reminder_sent_automatic_idx`;--> statement-breakpoint
ALTER TABLE `reminder_sent` ADD `offset_days` integer;--> statement-breakpoint
ALTER TABLE `reminder_rule` ADD `active_since` text DEFAULT '' NOT NULL;--> statement-breakpoint
UPDATE `reminder_sent` SET `offset_days` = (SELECT `offset_days` FROM `reminder_rule` WHERE `reminder_rule`.`id` = `reminder_sent`.`stage_key`);--> statement-breakpoint
UPDATE `reminder_rule` SET `active_since` = date(`updated_at` / 1000, 'unixepoch');--> statement-breakpoint
CREATE UNIQUE INDEX `reminder_sent_automatic_idx` ON `reminder_sent` (`invoice_id`,`offset_days`) WHERE "reminder_sent"."trigger" = 'automatic';
