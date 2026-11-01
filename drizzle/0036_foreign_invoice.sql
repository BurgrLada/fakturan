ALTER TABLE `supplier` ADD `reverse_charge_cs` text DEFAULT 'Daň odvede zákazník (přenesení daňové povinnosti, čl. 196 směrnice 2006/112/ES).' NOT NULL;--> statement-breakpoint
ALTER TABLE `supplier` ADD `reverse_charge_en` text DEFAULT 'Reverse charge: VAT to be accounted for by the customer (Article 196 of Directive 2006/112/EC).' NOT NULL;--> statement-breakpoint
ALTER TABLE `invoice` ADD `foreign` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `invoice` ADD `clause` text DEFAULT '' NOT NULL;