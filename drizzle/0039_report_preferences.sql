ALTER TABLE `preferences` ADD `turnover_vat_limit_minor` integer;--> statement-breakpoint
ALTER TABLE `preferences` ADD `turnover_flat_limit_minor` integer;--> statement-breakpoint
ALTER TABLE `preferences` ADD `turnover_basis` text DEFAULT 'taxable' NOT NULL;