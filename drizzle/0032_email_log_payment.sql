DROP INDEX `email_log_running_idx`;--> statement-breakpoint
ALTER TABLE `email_log` ADD `payment_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `email_log_running_idx` ON `email_log` (`invoice_id`,`kind`,coalesce(`payment_id`, '')) WHERE "email_log"."status" IN ('queued', 'sending');