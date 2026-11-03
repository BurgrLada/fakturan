CREATE TABLE `import_batch` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`status` text DEFAULT 'uploading' NOT NULL,
	`target` text,
	`source_system` text,
	`mapping` text,
	`uploaded_bytes` integer DEFAULT 0 NOT NULL,
	`progress` integer DEFAULT 0 NOT NULL,
	`progress_total` integer DEFAULT 0 NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`summary` text,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`committed_at` integer,
	`undone_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `import_batch_user_idx` ON `import_batch` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `import_batch_status_idx` ON `import_batch` (`status`,`updated_at`);--> statement-breakpoint
CREATE TABLE `mapping_preset` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`target` text NOT NULL,
	`mapping` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mapping_preset_user_name_idx` ON `mapping_preset` (`user_id`,`target`,`name`);--> statement-breakpoint
ALTER TABLE `file` ADD `import_batch_id` text REFERENCES import_batch(id) ON DELETE CASCADE;--> statement-breakpoint
CREATE INDEX `file_import_batch_idx` ON `file` (`import_batch_id`);--> statement-breakpoint
ALTER TABLE `customer` ADD `import_batch_id` text REFERENCES import_batch(id);--> statement-breakpoint
ALTER TABLE `catalog_item` ADD `import_batch_id` text REFERENCES import_batch(id);--> statement-breakpoint
ALTER TABLE `invoice` ADD `import_batch_id` text REFERENCES import_batch(id);--> statement-breakpoint
ALTER TABLE `invoice` ADD `import_uuid` text;--> statement-breakpoint
ALTER TABLE `invoice` ADD `source_system` text;--> statement-breakpoint
CREATE UNIQUE INDEX `invoice_user_import_uuid_idx` ON `invoice` (`user_id`,`import_uuid`) WHERE import_uuid IS NOT NULL;--> statement-breakpoint
CREATE INDEX `invoice_import_batch_idx` ON `invoice` (`import_batch_id`);--> statement-breakpoint
ALTER TABLE `payment` ADD `date_estimated` integer DEFAULT false NOT NULL;