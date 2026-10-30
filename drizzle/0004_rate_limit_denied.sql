ALTER TABLE `rate_limit` ADD `denied` integer DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX `rate_limit_window_idx` ON `rate_limit` (`window_start`);