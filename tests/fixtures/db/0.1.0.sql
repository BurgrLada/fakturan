PRAGMA foreign_keys = OFF;
BEGIN;
CREATE TABLE "__drizzle_migrations" (
				id SERIAL PRIMARY KEY,
				hash text NOT NULL,
				created_at numeric
			);
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
CREATE TABLE `audit_purge` (
	`owner_id` text PRIMARY KEY NOT NULL
);
CREATE TABLE `account` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`user_id` text NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`id_token` text,
	`access_token_expires_at` integer,
	`refresh_token_expires_at` integer,
	`scope` text,
	`password` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
CREATE TABLE `instance_meta` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
CREATE TABLE `session` (
	`id` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL,
	`token` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`user_id` text NOT NULL,
	`impersonated_by` text,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
CREATE TABLE `user` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`email_verified` integer DEFAULT false NOT NULL,
	`image` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`role` text DEFAULT 'user' NOT NULL,
	`banned` integer DEFAULT false,
	`ban_reason` text,
	`ban_expires` integer
, `theme` text DEFAULT 'system' NOT NULL);
CREATE TABLE `verification` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
CREATE TABLE `invitation` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`token_hash` text NOT NULL,
	`role` text NOT NULL,
	`invited_by` text,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`accepted_at` integer,
	`revoked_at` integer, `accepted_user_id` text,
	FOREIGN KEY (`invited_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
CREATE TABLE `rate_limit` (
	`key` text PRIMARY KEY NOT NULL,
	`window_start` integer NOT NULL,
	`count` integer NOT NULL
, `denied` integer DEFAULT false NOT NULL);
CREATE TABLE `file` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`mime_type` text NOT NULL,
	`name` text NOT NULL,
	`size` integer NOT NULL,
	`created_at` integer NOT NULL, `import_batch_id` text REFERENCES import_batch(id) ON DELETE CASCADE,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
CREATE TABLE `supplier` (
	`user_id` text PRIMARY KEY NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`street` text DEFAULT '' NOT NULL,
	`city` text DEFAULT '' NOT NULL,
	`zip` text DEFAULT '' NOT NULL,
	`country` text DEFAULT 'Česká republika' NOT NULL,
	`ico` text DEFAULT '' NOT NULL,
	`dic` text DEFAULT '' NOT NULL,
	`email` text DEFAULT '' NOT NULL,
	`phone` text DEFAULT '' NOT NULL,
	`web` text DEFAULT '' NOT NULL,
	`registry_note` text DEFAULT '' NOT NULL,
	`contact_person` text DEFAULT '' NOT NULL,
	`vat_identified` integer DEFAULT false NOT NULL,
	`footer_text` text DEFAULT '' NOT NULL,
	`not_vat_payer_cs` text DEFAULT 'Nejsem plátce DPH.' NOT NULL,
	`not_vat_payer_en` text DEFAULT 'I am not a VAT payer.' NOT NULL,
	`logo_file_id` text,
	`qr_logo_file_id` text,
	`signature_file_id` text,
	`updated_at` integer NOT NULL, `reverse_charge_cs` text DEFAULT 'Daň odvede zákazník (přenesení daňové povinnosti, čl. 196 směrnice 2006/112/ES).' NOT NULL, `reverse_charge_en` text DEFAULT 'Reverse charge: VAT to be accounted for by the customer (Article 196 of Directive 2006/112/EC).' NOT NULL, `advance_note_cs` text DEFAULT 'Toto není daňový doklad.' NOT NULL, `advance_note_en` text DEFAULT 'This is not a tax document.' NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`logo_file_id`) REFERENCES `file`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`qr_logo_file_id`) REFERENCES `file`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`signature_file_id`) REFERENCES `file`(`id`) ON UPDATE no action ON DELETE set null
);
CREATE TABLE `bank_account` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`currency` text NOT NULL,
	`number` text DEFAULT '' NOT NULL,
	`bank_code` text DEFAULT '' NOT NULL,
	`iban` text NOT NULL,
	`swift` text DEFAULT '' NOT NULL,
	`is_default` integer DEFAULT false NOT NULL,
	`hidden` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
CREATE TABLE `number_series` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`document_type` text NOT NULL,
	`template` text NOT NULL,
	`reset` text NOT NULL,
	`is_default` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
CREATE TABLE `number_series_counter` (
	`series_id` text NOT NULL,
	`period_key` text NOT NULL,
	`user_id` text NOT NULL,
	`next` integer NOT NULL,
	`highest` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`series_id`, `period_key`),
	FOREIGN KEY (`series_id`) REFERENCES `number_series`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
CREATE TABLE `preferences` (
	`user_id` text PRIMARY KEY NOT NULL,
	`due_days` integer DEFAULT 14 NOT NULL,
	`language` text DEFAULT 'cs' NOT NULL,
	`currency` text DEFAULT 'CZK' NOT NULL,
	`design_id` text DEFAULT 'cisty' NOT NULL,
	`accent_color` text DEFAULT '' NOT NULL,
	`payment_method` text DEFAULT 'transfer' NOT NULL,
	`unit` text DEFAULT 'ks' NOT NULL,
	`show_logo` integer DEFAULT true NOT NULL,
	`show_qr` integer DEFAULT true NOT NULL,
	`show_qr_logo` integer DEFAULT false NOT NULL,
	`show_signature` integer DEFAULT false NOT NULL,
	`show_duzp` integer DEFAULT false NOT NULL,
	`text_before` text DEFAULT '' NOT NULL,
	`text_after` text DEFAULT '' NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`issue_date_mode` text DEFAULT 'today' NOT NULL,
	`date_format` text DEFAULT 'd. M. yyyy' NOT NULL,
	`variable_symbol_format` text DEFAULT 'digits' NOT NULL,
	`onboarding_completed_at` integer,
	`updated_at` integer NOT NULL, `surface_color` text DEFAULT '' NOT NULL, `text_color` text DEFAULT '' NOT NULL, `line_color` text DEFAULT '' NOT NULL, `logo_position` text DEFAULT 'left' NOT NULL, `rounding` text DEFAULT 'none' NOT NULL, `pdf_file_name` text DEFAULT '{cislo}.pdf' NOT NULL, `fx_basis` text DEFAULT 'issue_date' NOT NULL, `fixed_rates` text DEFAULT '{}' NOT NULL, `advance_final_mode` text DEFAULT 'draft' NOT NULL, `turnover_vat_limit_minor` integer, `turnover_flat_limit_minor` integer, `turnover_basis` text DEFAULT 'taxable' NOT NULL, `turnover_vat_watch` integer DEFAULT true NOT NULL, `turnover_flat_watch` integer DEFAULT true NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
CREATE TABLE `customer` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`street` text DEFAULT '' NOT NULL,
	`city` text DEFAULT '' NOT NULL,
	`zip` text DEFAULT '' NOT NULL,
	`country` text DEFAULT 'Česká republika' NOT NULL,
	`ico` text DEFAULT '' NOT NULL,
	`dic` text DEFAULT '' NOT NULL,
	`email` text DEFAULT '' NOT NULL,
	`extra_emails` text DEFAULT '[]' NOT NULL,
	`phone` text DEFAULT '' NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`due_days` integer,
	`language` text,
	`currency` text,
	`design_id` text,
	`reminders_enabled` integer,
	`vat_verified_at` integer,
	`vat_valid` integer,
	`archived_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL, `search_text` text DEFAULT '' NOT NULL, `import_batch_id` text REFERENCES import_batch(id),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
CREATE TABLE `catalog_item` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`unit` text NOT NULL,
	`price_minor` integer NOT NULL,
	`currency` text NOT NULL,
	`category` text DEFAULT '' NOT NULL,
	`tags` text DEFAULT '[]' NOT NULL,
	`search_text` text DEFAULT '' NOT NULL,
	`use_count` integer DEFAULT 0 NOT NULL,
	`archived_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL, `import_batch_id` text REFERENCES import_batch(id),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
CREATE TABLE `unit` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`position` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
CREATE TABLE `invoice` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`type` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`cancelled_from` text,
	`number` text,
	`variable_symbol` text,
	`variable_symbol_manual` integer DEFAULT false NOT NULL,
	`series_id` text,
	`customer_id` text,
	`customer_name` text DEFAULT '' NOT NULL,
	`bank_account_id` text,
	`issue_date` text,
	`due_date` text,
	`taxable_date` text,
	`language` text NOT NULL,
	`currency` text NOT NULL,
	`exchange_rate_micros` integer,
	`payment_method` text NOT NULL,
	`order_ref` text DEFAULT '' NOT NULL,
	`reference` text DEFAULT '' NOT NULL,
	`text_before` text DEFAULT '' NOT NULL,
	`text_after` text DEFAULT '' NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`discount_kind` text DEFAULT 'none' NOT NULL,
	`discount_value` integer DEFAULT 0 NOT NULL,
	`rounding` text DEFAULT 'none' NOT NULL,
	`subtotal_minor` integer DEFAULT 0 NOT NULL,
	`discount_minor` integer DEFAULT 0 NOT NULL,
	`rounding_minor` integer DEFAULT 0 NOT NULL,
	`total_minor` integer DEFAULT 0 NOT NULL,
	`paid_minor` integer DEFAULT 0 NOT NULL,
	`appearance` text NOT NULL,
	`supplier_snapshot` text,
	`customer_snapshot` text,
	`account_snapshot` text,
	`logo_file_id` text,
	`qr_logo_file_id` text,
	`signature_file_id` text,
	`related_invoice_id` text,
	`external` integer DEFAULT false NOT NULL,
	`search_text` text DEFAULT '' NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`issued_at` integer,
	`sent_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL, `date_format` text, `recurring_id` text REFERENCES recurring_invoice(id) ON DELETE SET NULL, `period_from` text, `period_to` text, `reminders_off` integer DEFAULT false NOT NULL, `reminders_snooze_until` text, `reminders_partial` integer DEFAULT false NOT NULL, `credits_minor` integer DEFAULT 0 NOT NULL, `advance_minor` integer DEFAULT 0 NOT NULL, `superseded_at` integer, `related_snapshot` text, `exchange_rate_source` text, `exchange_rate_date` text, `foreign` integer DEFAULT false NOT NULL, `clause` text DEFAULT '' NOT NULL, `import_batch_id` text REFERENCES import_batch(id), `import_uuid` text, `source_system` text, `import_pdf_file_id` text REFERENCES file(id) ON DELETE SET NULL, `import_payment_code` text,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`series_id`) REFERENCES `number_series`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`customer_id`) REFERENCES `customer`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`bank_account_id`) REFERENCES `bank_account`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`logo_file_id`) REFERENCES `file`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`qr_logo_file_id`) REFERENCES `file`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`signature_file_id`) REFERENCES `file`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`related_invoice_id`) REFERENCES `invoice`(`id`) ON UPDATE no action ON DELETE no action
);
CREATE TABLE `invoice_line` (
	`id` text PRIMARY KEY NOT NULL,
	`invoice_id` text NOT NULL,
	`user_id` text NOT NULL,
	`position` integer NOT NULL,
	`catalog_item_id` text,
	`name` text DEFAULT '' NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`quantity_milli` integer NOT NULL,
	`unit` text DEFAULT '' NOT NULL,
	`unit_price_minor` integer NOT NULL,
	`discount_kind` text DEFAULT 'none' NOT NULL,
	`discount_value` integer DEFAULT 0 NOT NULL,
	`net_minor` integer NOT NULL,
	FOREIGN KEY (`invoice_id`) REFERENCES `invoice`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`catalog_item_id`) REFERENCES `catalog_item`(`id`) ON UPDATE no action ON DELETE set null
);
CREATE TABLE `invoice_tag` (
	`invoice_id` text NOT NULL,
	`tag_id` text NOT NULL,
	`user_id` text NOT NULL,
	PRIMARY KEY(`invoice_id`, `tag_id`),
	FOREIGN KEY (`invoice_id`) REFERENCES `invoice`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tag_id`) REFERENCES `tag`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
CREATE TABLE `tag` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`name_key` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
CREATE TABLE `invoice_version` (
	`id` text PRIMARY KEY NOT NULL,
	`invoice_id` text NOT NULL,
	`user_id` text NOT NULL,
	`version_no` integer NOT NULL,
	`document` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`invoice_id`) REFERENCES `invoice`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
CREATE TABLE `invoice_template` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`customer_id` text,
	`document` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`customer_id`) REFERENCES `customer`(`id`) ON UPDATE no action ON DELETE set null
);
CREATE TABLE `job` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text,
	`kind` text NOT NULL,
	`key` text NOT NULL,
	`payload` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`run_at` integer NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer NOT NULL,
	`locked_by` text,
	`reason` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
CREATE TABLE `scheduler_state` (
	`id` integer PRIMARY KEY NOT NULL,
	`holder` text,
	`lease_until` integer,
	`started_at` integer,
	`last_tick_at` integer,
	`last_ok_at` integer,
	`last_backup_at` integer,
	`last_backup_try_at` integer
);
CREATE TABLE `automation_settings` (
	`user_id` text PRIMARY KEY NOT NULL,
	`recurring_send` integer DEFAULT false NOT NULL,
	`reminders` integer DEFAULT false NOT NULL,
	`payment_receipt` integer DEFAULT false NOT NULL,
	`advance_invoice` integer DEFAULT false NOT NULL,
	`paused` integer DEFAULT false NOT NULL,
	`reminders_open_since` text,
	`send_time` text DEFAULT '09:00' NOT NULL,
	`daily_digest` integer DEFAULT false NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
CREATE TABLE `notification` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`dedupe_key` text NOT NULL,
	`params` text NOT NULL,
	`entity_type` text,
	`entity_id` text,
	`read_at` integer,
	`resolved_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
CREATE TABLE `mail_settings` (
	`user_id` text PRIMARY KEY NOT NULL,
	`smtp_host` text,
	`smtp_port` integer,
	`smtp_user` text,
	`smtp_password_enc` text,
	`from_email` text,
	`sender_name` text,
	`reply_to` text,
	`cc` text DEFAULT '[]' NOT NULL,
	`bcc` text DEFAULT '[]' NOT NULL,
	`verified_at` integer,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
CREATE TABLE `email_template` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`language` text NOT NULL,
	`subject` text NOT NULL,
	`body` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
CREATE TABLE `email_log` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`invoice_id` text NOT NULL,
	`kind` text NOT NULL,
	`trigger` text NOT NULL,
	`to` text NOT NULL,
	`cc` text NOT NULL,
	`bcc` text NOT NULL,
	`subject` text NOT NULL,
	`body` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`reason` text,
	`file_id` text,
	`invoice_revision` integer NOT NULL,
	`planned_for` text,
	`automation` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`message_id` text,
	`created_at` integer NOT NULL,
	`sent_at` integer,
	`updated_at` integer NOT NULL, `stage_key` text, `acknowledged_at` integer, `payment_id` text, `receipt_print` text, `attach_isdoc` integer DEFAULT false NOT NULL, `isdoc_file_id` text REFERENCES file(id) ON DELETE SET NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`invoice_id`) REFERENCES `invoice`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`file_id`) REFERENCES `file`(`id`) ON UPDATE no action ON DELETE set null
);
CREATE TABLE `recurring_invoice` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`customer_id` text,
	`document` text NOT NULL,
	`frequency` text NOT NULL,
	`every` integer DEFAULT 1 NOT NULL,
	`issue_rule` text NOT NULL,
	`issue_day` integer,
	`starts_on` text NOT NULL,
	`ends_on` text,
	`max_count` integer,
	`period_offset` integer DEFAULT 0 NOT NULL,
	`mode` text DEFAULT 'draft' NOT NULL,
	`notify_days_before` integer,
	`status` text DEFAULT 'active' NOT NULL,
	`cursor_date` text NOT NULL,
	`send_confirmed_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`customer_id`) REFERENCES `customer`(`id`) ON UPDATE no action ON DELETE set null
);
CREATE TABLE `recurring_run` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`recurring_id` text NOT NULL,
	`period_key` text NOT NULL,
	`planned_date` text NOT NULL,
	`period_from` text NOT NULL,
	`period_to` text NOT NULL,
	`status` text NOT NULL,
	`invoice_id` text,
	`reason` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`recurring_id`) REFERENCES `recurring_invoice`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`invoice_id`) REFERENCES `invoice`(`id`) ON UPDATE no action ON DELETE set null
);
CREATE TABLE `reminder_rule` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`position` integer NOT NULL,
	`offset_days` integer NOT NULL,
	`texts` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL, `active_since` text DEFAULT '' NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
CREATE TABLE `reminder_sent` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`invoice_id` text NOT NULL,
	`stage_key` text NOT NULL,
	`trigger` text NOT NULL,
	`email_log_id` text,
	`created_at` integer NOT NULL, `offset_days` integer,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`invoice_id`) REFERENCES `invoice`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`email_log_id`) REFERENCES `email_log`(`id`) ON UPDATE no action ON DELETE set null
);
CREATE TABLE `payment` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`invoice_id` text NOT NULL,
	`kind` text NOT NULL,
	`paid_on` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`currency` text NOT NULL,
	`credited_minor` integer NOT NULL,
	`method` text NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`source` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL, `notification_id` text REFERENCES bank_notification(id) ON DELETE SET NULL, `rate_micros` integer, `date_estimated` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`invoice_id`) REFERENCES `invoice`(`id`) ON UPDATE no action ON DELETE no action
);
CREATE TABLE `bank_mailbox` (
	`user_id` text PRIMARY KEY NOT NULL,
	`host` text NOT NULL,
	`port` integer NOT NULL,
	`tls` text NOT NULL,
	`username` text NOT NULL,
	`password_enc` text NOT NULL,
	`folder` text DEFAULT 'INBOX' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`require_confirmation` integer DEFAULT true NOT NULL,
	`uid_validity` integer,
	`last_uid` integer,
	`first_read_at` integer,
	`last_check_at` integer,
	`last_success_at` integer,
	`last_notice_at` integer,
	`failure_code` text,
	`failures` integer DEFAULT 0 NOT NULL,
	`verified_at` integer,
	`updated_at` integer NOT NULL, `auth_serv_id` text,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
CREATE TABLE `bank_notification` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`dedupe_key` text NOT NULL,
	`bank` text NOT NULL,
	`variant` text,
	`status` text NOT NULL,
	`reason` text,
	`auth_result` text NOT NULL,
	`bank_account_id` text,
	`account_masked` text,
	`amount_minor` integer,
	`currency` text,
	`paid_on` text,
	`paid_time` text,
	`variable_symbol` text,
	`constant_symbol` text,
	`counterparty_masked` text,
	`counterparty_name` text,
	`message` text,
	`instruction_id` text,
	`text_masked` text,
	`received_at` integer NOT NULL,
	`purged_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`bank_account_id`) REFERENCES `bank_account`(`id`) ON UPDATE no action ON DELETE set null
);
CREATE TABLE `exchange_rate` (
	`currency` text NOT NULL,
	`list_date` text NOT NULL,
	`rate_micros` integer NOT NULL,
	`fetched_at` integer NOT NULL,
	PRIMARY KEY(`currency`, `list_date`)
);
CREATE TABLE `dashboard` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`is_default` integer DEFAULT false NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
CREATE TABLE `dashboard_widget` (
	`id` text PRIMARY KEY NOT NULL,
	`dashboard_id` text NOT NULL,
	`user_id` text NOT NULL,
	`config` text NOT NULL,
	`x` integer NOT NULL,
	`y` integer NOT NULL,
	`w` integer NOT NULL,
	`h` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`dashboard_id`) REFERENCES `dashboard`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
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
CREATE TABLE `export_job` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`format` text NOT NULL,
	`filter` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`progress` integer DEFAULT 0 NOT NULL,
	`progress_total` integer DEFAULT 0 NOT NULL,
	`file_id` text,
	`reason` text,
	`expires_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`file_id`) REFERENCES `file`(`id`) ON UPDATE no action ON DELETE set null
);
INSERT INTO "__drizzle_migrations" ("id", "hash", "created_at") VALUES (NULL, '00197a16eda3c0f602ab4742d84b0106d458ace28711d2b11290cc2b8f98a0d4', 1793353957764);
INSERT INTO "__drizzle_migrations" ("id", "hash", "created_at") VALUES (NULL, 'f8d123175dc1666715134d5e53f4596fe304ec1fe12ef9b41e481efaacd7e82d', 1793353958411);
INSERT INTO "__drizzle_migrations" ("id", "hash", "created_at") VALUES (NULL, 'f6c836a2d3b38a64fc6d02d074bba8cf6b0c90ead54ad5c24604155aace4de1b', 1793354777894);
INSERT INTO "__drizzle_migrations" ("id", "hash", "created_at") VALUES (NULL, '5df197c5254b4733620f5f43ff3245b45e21b52e62429ee5d01a4684b9642fac', 1793356043425);
INSERT INTO "__drizzle_migrations" ("id", "hash", "created_at") VALUES (NULL, 'd03876232a313407a333755c670531f6eacfc66f0a33eed9fb0f859298559ac1', 1793356375361);
INSERT INTO "__drizzle_migrations" ("id", "hash", "created_at") VALUES (NULL, '8184f2757f567df62e234abfdc33c8df65b19efad758b2583ada0974e22a77f9', 1793357550300);
INSERT INTO "__drizzle_migrations" ("id", "hash", "created_at") VALUES (NULL, '427a4927a23cdc3101bc9ea4096a181c08fcf8e06f0166f77954f1d97b52e7e6', 1793362455819);
INSERT INTO "__drizzle_migrations" ("id", "hash", "created_at") VALUES (NULL, '110a69a053765fa5fa20283781639f27fcdae986474102b47a4b53f0987d4722', 1793362873586);
INSERT INTO "__drizzle_migrations" ("id", "hash", "created_at") VALUES (NULL, '95acecf883b9baa137453b0fe15bd6f49956e926dca456045e97f1bcc488e950', 1793363427034);
INSERT INTO "__drizzle_migrations" ("id", "hash", "created_at") VALUES (NULL, 'f773672d5dc191646cda82c5a9df5c161e4fd326c4cc56ff18c7fe7ec8eac654', 1793363997633);
INSERT INTO "__drizzle_migrations" ("id", "hash", "created_at") VALUES (NULL, '6968db19e4caa433854e98665bf18f1956ca1b60b65df48d4d4a03414e8064c2', 1793364772364);
INSERT INTO "__drizzle_migrations" ("id", "hash", "created_at") VALUES (NULL, '36edca4d74d9965e9b71f6b1ffe8b0fceb216559b18f8fafe1461bf23d81f76a', 1793365619209);
INSERT INTO "__drizzle_migrations" ("id", "hash", "created_at") VALUES (NULL, '7ba5bcfbba0ea8702ccad8a1febf7b3deb22132a1dde375d549f66ada66827ca', 1793366173725);
INSERT INTO "__drizzle_migrations" ("id", "hash", "created_at") VALUES (NULL, '00ea9ee3b5b146353d2c80939f1d8df4d3f8b62cbfd34dadd2190989e1223525', 1793366738933);
INSERT INTO "__drizzle_migrations" ("id", "hash", "created_at") VALUES (NULL, '09a1172879cbbbcf6e417c6b2efb2b0b642f7ba2515b3a4b09044b980799c80e', 1793367057669);
INSERT INTO "__drizzle_migrations" ("id", "hash", "created_at") VALUES (NULL, 'd81c5ccd22cfe9a8e98998785860bd4edf32de2f61f171dbd4da5de8dc65ae4e', 1793380202747);
INSERT INTO "__drizzle_migrations" ("id", "hash", "created_at") VALUES (NULL, '69c5b44773bfd1cbe612752ce05b8fcc18103a939dde49f81670034d390bc152', 1793387538263);
INSERT INTO "__drizzle_migrations" ("id", "hash", "created_at") VALUES (NULL, 'f25e801b8bcd26e2b203ca79b951d8ecff376e6dc5c0c05a047e924e9ced1b41', 1793388092808);
INSERT INTO "__drizzle_migrations" ("id", "hash", "created_at") VALUES (NULL, '27b8d7768a3c23a6fc4ca913794e198b97920a16d29d8d5fe298787834633237', 1793440282425);
INSERT INTO "__drizzle_migrations" ("id", "hash", "created_at") VALUES (NULL, '393496c310753505775bb3a871cc23d4a191a9833c5afdf96e8ab371f5f39a6d', 1793446902250);
INSERT INTO "__drizzle_migrations" ("id", "hash", "created_at") VALUES (NULL, '7bc7a8e0acc9baf99abcb9197405640740173edf9e6f481737ce04f4ef078440', 1793448315388);
INSERT INTO "__drizzle_migrations" ("id", "hash", "created_at") VALUES (NULL, 'ce9ffb52829fade5ba6be82678f9f9026c8e3728c4f3d32f82c65ead84dddf4e', 1793449897005);
INSERT INTO "__drizzle_migrations" ("id", "hash", "created_at") VALUES (NULL, '7a2f2fe7105c962b82a1ca966eeb48a08d5ab0e145ad9d7719ed0a63ad4b5b1b', 1793451631904);
INSERT INTO "__drizzle_migrations" ("id", "hash", "created_at") VALUES (NULL, '0b236ed2e2ca6eaa538f01c91f5e2c383e34cc7cae1d52df05e9dcb98ae506ae', 1793452714029);
INSERT INTO "__drizzle_migrations" ("id", "hash", "created_at") VALUES (NULL, 'd555e1877c7d221b020dd94996eb60e2fa62cd29de1d76e14b73453f999b3798', 1793462303370);
INSERT INTO "__drizzle_migrations" ("id", "hash", "created_at") VALUES (NULL, 'fd8fe83a785d4ca7854497ac73a789bb45cc127c54a0fd6aba9395cb08e578ce', 1793466329478);
INSERT INTO "__drizzle_migrations" ("id", "hash", "created_at") VALUES (NULL, 'a714878384c2879aeed8fd32a21b9e2eaa6b68cd98f3a7ca0aff54cd5e7bd8fb', 1793468493295);
INSERT INTO "__drizzle_migrations" ("id", "hash", "created_at") VALUES (NULL, 'a12c8c11091c74991b413cf68f33fa72a8c4df922d81135a772389120974e863', 1793473634567);
INSERT INTO "__drizzle_migrations" ("id", "hash", "created_at") VALUES (NULL, '3d9c0517c0eec56389ebda9db8d59fda6009bedf013d19a42bfc83a06fcae899', 1793475391994);
INSERT INTO "__drizzle_migrations" ("id", "hash", "created_at") VALUES (NULL, '745d36f2d23d5670c00b2c47240c9f1502390b74570eabdacf6e95031255ee97', 1793482878153);
INSERT INTO "__drizzle_migrations" ("id", "hash", "created_at") VALUES (NULL, 'a1defcc1f826c4c31601927f2eed362aafce8fefb7279f6d92e50cc48bed2fed', 1793484175213);
INSERT INTO "__drizzle_migrations" ("id", "hash", "created_at") VALUES (NULL, '994d828770cb293fe1eaa6c67ce871b705810fa3a8248b0800b1f171b0b6687c', 1793488387191);
INSERT INTO "__drizzle_migrations" ("id", "hash", "created_at") VALUES (NULL, '3368fd7da469a450ef10eefef039cde2e7361afa838790d6c15e09029ca63807', 1793490602312);
INSERT INTO "__drizzle_migrations" ("id", "hash", "created_at") VALUES (NULL, 'd651b43384880a8f65215e6ea3bdd8d9be926aced4bd79bdd081638a960168e7', 1793495058646);
INSERT INTO "__drizzle_migrations" ("id", "hash", "created_at") VALUES (NULL, '32ee9e9119d1522a06a02d7bb1e0a98f3a331b819038c84a7bf5dd6a373cefc8', 1793500577800);
INSERT INTO "__drizzle_migrations" ("id", "hash", "created_at") VALUES (NULL, '4423b6d5de9b5c57812f0f0ab37104ed089bd0237990397cba7d14670b7eaef0', 1793504913183);
INSERT INTO "__drizzle_migrations" ("id", "hash", "created_at") VALUES (NULL, 'f3a4799f7e22c668ad85dd317011614b721ed968dfea0046d5b310b1817065f0', 1793510361923);
INSERT INTO "__drizzle_migrations" ("id", "hash", "created_at") VALUES (NULL, '0eddfcfe923146643ee7bb995f0d52407e4bee0d81715c31e2063db3ca459153', 1793512686084);
INSERT INTO "__drizzle_migrations" ("id", "hash", "created_at") VALUES (NULL, 'e56b161c7104aff0540f490d45b1450876e299b50e3eec7b166305549b4c5604', 1793517360841);
INSERT INTO "__drizzle_migrations" ("id", "hash", "created_at") VALUES (NULL, '028a3ee07a7a96575b6ad93dee89ed94a60dd6fb65769bf8b3767b7020c5978d', 1793647207021);
INSERT INTO "__drizzle_migrations" ("id", "hash", "created_at") VALUES (NULL, '12d93613b46c19213b2b53e52e84fdc91e31169c07fdf059291b05e0dc7239f6', 1793656276759);
INSERT INTO "__drizzle_migrations" ("id", "hash", "created_at") VALUES (NULL, 'd0b4b658874d37d4498f1ac669e75eab7e0b15c3ab60ccd9bb4e5bd8a2e76755', 1793705174187);
INSERT INTO "__drizzle_migrations" ("id", "hash", "created_at") VALUES (NULL, '83d3c9337e3a49ea25df6ebb6328f2b924764e85ed8fb5b121ad229c8e0a9d61', 1793711517952);
INSERT INTO "__drizzle_migrations" ("id", "hash", "created_at") VALUES (NULL, '9bef599e812b1f2b476bc6354aa1478db4d83242be9d9e2da073f33e9a93b40f', 1793713988848);
INSERT INTO "__drizzle_migrations" ("id", "hash", "created_at") VALUES (NULL, '6e896d35b8be1bae9cce135775c386ca003a117e5331e6026d765c81c8474d96', 1793968428955);
INSERT INTO "__drizzle_migrations" ("id", "hash", "created_at") VALUES (NULL, '1ed1db1e339719ecacaf2150e41930d5f4c29003f2f56c6bb56697871e47cd53', 1793972995373);
INSERT INTO "audit_log" ("id", "at", "actor_id", "owner_id", "source", "scope", "action", "entity", "entity_id", "before", "after", "ip", "user_agent", "request_id") VALUES (1, 1774000800000, 'm-8e44b3d8-e6cf-41d0-ba67-f1ded3930e86', 'm-8e44b3d8-e6cf-41d0-ba67-f1ded3930e86', 'web', 'user', 'number_series.ensure_defaults', 'number_series', NULL, NULL, '{"created":["invoice","advance","credit_note"]}', NULL, NULL, NULL);
INSERT INTO "audit_log" ("id", "at", "actor_id", "owner_id", "source", "scope", "action", "entity", "entity_id", "before", "after", "ip", "user_agent", "request_id") VALUES (2, 1774000800000, 'm-8e44b3d8-e6cf-41d0-ba67-f1ded3930e86', 'm-8e44b3d8-e6cf-41d0-ba67-f1ded3930e86', 'web', 'user', 'supplier.save', 'supplier', 'm-8e44b3d8-e6cf-41d0-ba67-f1ded3930e86', NULL, '{"name":"Jan Novák","street":"Dlouhá 1","city":"Praha","zip":"110 00","country":"Česká republika","ico":"27082440","dic":"","email":"","phone":"","web":"","registryNote":"","contactPerson":"","vatIdentified":false,"footerText":"","notVatPayerCs":"Nejsem plátce DPH.","notVatPayerEn":"I am not a VAT payer.","reverseChargeCs":"Daň odvede zákazník (přenesení daňové povinnosti, čl. 196 směrnice 2006/112/ES).","reverseChargeEn":"Reverse charge: VAT to be accounted for by the customer (Article 196 of Directive 2006/112/EC).","advanceNoteCs":"Toto není daňový doklad.","advanceNoteEn":"This is not a tax document."}', NULL, NULL, NULL);
INSERT INTO "audit_log" ("id", "at", "actor_id", "owner_id", "source", "scope", "action", "entity", "entity_id", "before", "after", "ip", "user_agent", "request_id") VALUES (3, 1774000800000, 'm-8e44b3d8-e6cf-41d0-ba67-f1ded3930e86', 'm-8e44b3d8-e6cf-41d0-ba67-f1ded3930e86', 'web', 'user', 'bank_account.save', 'bank_account', '2f0cc0a7-e89c-4179-b25e-fc0ecadedc75', NULL, '{"name":"Účet","currency":"CZK","number":"19-2000145399","bankCode":"0800","iban":"CZ6508000000192000145399","swift":""}', NULL, NULL, NULL);
INSERT INTO "audit_log" ("id", "at", "actor_id", "owner_id", "source", "scope", "action", "entity", "entity_id", "before", "after", "ip", "user_agent", "request_id") VALUES (4, 1774000800000, 'm-8e44b3d8-e6cf-41d0-ba67-f1ded3930e86', 'm-8e44b3d8-e6cf-41d0-ba67-f1ded3930e86', 'web', 'user', 'dashboard.create', 'dashboard', '40732ef3-7bc8-4204-b733-84b1d3577088', NULL, '{"name":"Přehled","isDefault":true,"widgets":9}', NULL, NULL, NULL);
INSERT INTO "audit_log" ("id", "at", "actor_id", "owner_id", "source", "scope", "action", "entity", "entity_id", "before", "after", "ip", "user_agent", "request_id") VALUES (5, 1774000800000, 'm-8e44b3d8-e6cf-41d0-ba67-f1ded3930e86', 'm-8e44b3d8-e6cf-41d0-ba67-f1ded3930e86', 'web', 'user', 'customer.save', 'customer', '93052413-1a4a-4ac6-aa27-5a37d6782023', NULL, '{"id":"93052413-1a4a-4ac6-aa27-5a37d6782023","name":"Alfa s.r.o.","street":"Krátká 2","city":"Brno","zip":"602 00","country":"Česká republika","ico":"","dic":"","email":"alfa@example.cz","extraEmails":[],"phone":"","note":"","dueDays":null,"language":null,"currency":null,"designId":null,"remindersEnabled":null,"vatVerifiedAt":null,"vatValid":null,"archivedAt":null,"importBatchId":null}', NULL, NULL, NULL);
INSERT INTO "audit_log" ("id", "at", "actor_id", "owner_id", "source", "scope", "action", "entity", "entity_id", "before", "after", "ip", "user_agent", "request_id") VALUES (6, 1774000800000, 'm-8e44b3d8-e6cf-41d0-ba67-f1ded3930e86', 'm-8e44b3d8-e6cf-41d0-ba67-f1ded3930e86', 'web', 'user', 'invoice.save', 'invoice', 'dfbea43e-8b7f-4228-9a65-16d550bfbae2', NULL, '{"id":"dfbea43e-8b7f-4228-9a65-16d550bfbae2","type":"invoice","status":"draft","cancelledFrom":null,"number":null,"variableSymbol":null,"variableSymbolManual":false,"seriesId":"de8558bb-4099-4fc3-8900-d39a543b20a8","customerId":"93052413-1a4a-4ac6-aa27-5a37d6782023","customerName":"Alfa s.r.o.","bankAccountId":"2f0cc0a7-e89c-4179-b25e-fc0ecadedc75","issueDate":"2026-03-20","dueDate":"2026-04-03","taxableDate":null,"language":"cs","currency":"CZK","exchangeRateMicros":null,"exchangeRateSource":null,"exchangeRateDate":null,"foreign":false,"clause":"","paymentMethod":"transfer","orderRef":"","reference":"","textBefore":"","textAfter":"","note":"","discountKind":"none","discountValue":0,"rounding":"none","subtotalMinor":300000,"discountMinor":0,"roundingMinor":0,"totalMinor":300000,"paidMinor":0,"creditsMinor":0,"advanceMinor":0,"supersededAt":null,"appearance":{"designId":"cisty","colors":{"accent":"","surface":"","text":"","line":""},"logoPosition":"left","showLogo":true,"showQr":true,"showQrLogo":false,"showSignature":false,"showDuzp":false},"supplierSnapshot":null,"customerSnapshot":null,"accountSnapshot":null,"dateFormat":null,"logoFileId":null,"qrLogoFileId":null,"signatureFileId":null,"relatedInvoiceId":null,"relatedSnapshot":null,"external":false,"importBatchId":null,"importUuid":null,"importPaymentCode":null,"sourceSystem":null,"importPdfFileId":null,"recurringId":null,"periodFrom":null,"periodTo":null,"remindersOff":false,"remindersSnoozeUntil":null,"remindersPartial":false,"revision":1,"issuedAt":null,"sentAt":null,"lineCount":1,"lines":{"changed":[],"added":[{"position":0,"catalogItemId":null,"name":"Konzultace","description":"","quantityMilli":2000,"unit":"hod.","unitPriceMinor":150000,"discountKind":"none","discountValue":0,"netMinor":300000}],"moved":[]}}', NULL, NULL, NULL);
INSERT INTO "audit_log" ("id", "at", "actor_id", "owner_id", "source", "scope", "action", "entity", "entity_id", "before", "after", "ip", "user_agent", "request_id") VALUES (7, 1774000800000, 'm-8e44b3d8-e6cf-41d0-ba67-f1ded3930e86', 'm-8e44b3d8-e6cf-41d0-ba67-f1ded3930e86', 'web', 'user', 'invoice.issue', 'invoice', 'dfbea43e-8b7f-4228-9a65-16d550bfbae2', '{"id":"dfbea43e-8b7f-4228-9a65-16d550bfbae2","type":"invoice","status":"draft","cancelledFrom":null,"number":null,"variableSymbol":null,"variableSymbolManual":false,"seriesId":"de8558bb-4099-4fc3-8900-d39a543b20a8","customerId":"93052413-1a4a-4ac6-aa27-5a37d6782023","customerName":"Alfa s.r.o.","bankAccountId":"2f0cc0a7-e89c-4179-b25e-fc0ecadedc75","issueDate":"2026-03-20","dueDate":"2026-04-03","taxableDate":null,"language":"cs","currency":"CZK","exchangeRateMicros":null,"exchangeRateSource":null,"exchangeRateDate":null,"foreign":false,"clause":"","paymentMethod":"transfer","orderRef":"","reference":"","textBefore":"","textAfter":"","note":"","discountKind":"none","discountValue":0,"rounding":"none","subtotalMinor":300000,"discountMinor":0,"roundingMinor":0,"totalMinor":300000,"paidMinor":0,"creditsMinor":0,"advanceMinor":0,"supersededAt":null,"appearance":{"designId":"cisty","colors":{"accent":"","surface":"","text":"","line":""},"logoPosition":"left","showLogo":true,"showQr":true,"showQrLogo":false,"showSignature":false,"showDuzp":false},"supplierSnapshot":null,"customerSnapshot":null,"accountSnapshot":null,"dateFormat":null,"logoFileId":null,"qrLogoFileId":null,"signatureFileId":null,"relatedInvoiceId":null,"relatedSnapshot":null,"external":false,"importBatchId":null,"importUuid":null,"importPaymentCode":null,"sourceSystem":null,"importPdfFileId":null,"recurringId":null,"periodFrom":null,"periodTo":null,"remindersOff":false,"remindersSnoozeUntil":null,"remindersPartial":false,"revision":1,"issuedAt":null,"sentAt":null,"lineCount":1}', '{"id":"dfbea43e-8b7f-4228-9a65-16d550bfbae2","type":"invoice","status":"issued","cancelledFrom":null,"number":"2026-001","variableSymbol":"2026001","variableSymbolManual":false,"seriesId":"de8558bb-4099-4fc3-8900-d39a543b20a8","customerId":"93052413-1a4a-4ac6-aa27-5a37d6782023","customerName":"Alfa s.r.o.","bankAccountId":"2f0cc0a7-e89c-4179-b25e-fc0ecadedc75","issueDate":"2026-03-20","dueDate":"2026-04-03","taxableDate":null,"language":"cs","currency":"CZK","exchangeRateMicros":null,"exchangeRateSource":null,"exchangeRateDate":null,"foreign":false,"clause":"","paymentMethod":"transfer","orderRef":"","reference":"","textBefore":"","textAfter":"","note":"","discountKind":"none","discountValue":0,"rounding":"none","subtotalMinor":300000,"discountMinor":0,"roundingMinor":0,"totalMinor":300000,"paidMinor":0,"creditsMinor":0,"advanceMinor":0,"supersededAt":null,"appearance":{"designId":"cisty","colors":{"accent":"","surface":"","text":"","line":""},"logoPosition":"left","showLogo":true,"showQr":true,"showQrLogo":false,"showSignature":false,"showDuzp":false},"supplierSnapshot":{"name":"Jan Novák","street":"Dlouhá 1","city":"Praha","zip":"110 00","country":"Česká republika","ico":"27082440","dic":"","email":"","phone":"","web":"","registryNote":"","contactPerson":"","vatIdentified":false,"footerText":"","notVatPayerCs":"Nejsem plátce DPH.","notVatPayerEn":"I am not a VAT payer.","advanceNoteCs":"Toto není daňový doklad.","advanceNoteEn":"This is not a tax document."},"customerSnapshot":{"name":"Alfa s.r.o.","street":"Krátká 2","city":"Brno","zip":"602 00","country":"Česká republika","ico":"","dic":"","email":"alfa@example.cz","phone":""},"accountSnapshot":{"name":"Účet","currency":"CZK","number":"19-2000145399","bankCode":"0800","iban":"CZ6508000000192000145399","swift":""},"dateFormat":"d. M. yyyy","logoFileId":null,"qrLogoFileId":null,"signatureFileId":null,"relatedInvoiceId":null,"relatedSnapshot":null,"external":false,"importBatchId":null,"importUuid":null,"importPaymentCode":null,"sourceSystem":null,"importPdfFileId":null,"recurringId":null,"periodFrom":null,"periodTo":null,"remindersOff":false,"remindersSnoozeUntil":null,"remindersPartial":false,"revision":2,"issuedAt":"2026-03-20T10:00:00.000Z","sentAt":null,"lineCount":1}', NULL, NULL, NULL);
INSERT INTO "audit_log" ("id", "at", "actor_id", "owner_id", "source", "scope", "action", "entity", "entity_id", "before", "after", "ip", "user_agent", "request_id") VALUES (8, 1774000800000, 'm-8e44b3d8-e6cf-41d0-ba67-f1ded3930e86', 'm-8e44b3d8-e6cf-41d0-ba67-f1ded3930e86', 'web', 'user', 'payment.create', 'payment', 'f5d7e8a3-a0ac-466f-908c-ce0043f04f0b', '{"invoiceId":"dfbea43e-8b7f-4228-9a65-16d550bfbae2","status":"issued"}', '{"invoiceId":"dfbea43e-8b7f-4228-9a65-16d550bfbae2","kind":"payment","source":"manual","paidOn":"2026-03-20","amountMinor":100000,"creditedMinor":100000,"currency":"CZK","method":"transfer","status":"partially_paid"}', NULL, NULL, NULL);
INSERT INTO "audit_log" ("id", "at", "actor_id", "owner_id", "source", "scope", "action", "entity", "entity_id", "before", "after", "ip", "user_agent", "request_id") VALUES (9, 1774000800000, 'm-8e44b3d8-e6cf-41d0-ba67-f1ded3930e86', 'm-8e44b3d8-e6cf-41d0-ba67-f1ded3930e86', 'web', 'user', 'invoice.save', 'invoice', '65c177bd-1cda-4a61-aadd-0746b375d82e', NULL, '{"id":"65c177bd-1cda-4a61-aadd-0746b375d82e","type":"invoice","status":"draft","cancelledFrom":null,"number":null,"variableSymbol":null,"variableSymbolManual":false,"seriesId":"de8558bb-4099-4fc3-8900-d39a543b20a8","customerId":"93052413-1a4a-4ac6-aa27-5a37d6782023","customerName":"Alfa s.r.o.","bankAccountId":"2f0cc0a7-e89c-4179-b25e-fc0ecadedc75","issueDate":"2026-03-20","dueDate":"2026-04-03","taxableDate":null,"language":"cs","currency":"CZK","exchangeRateMicros":null,"exchangeRateSource":null,"exchangeRateDate":null,"foreign":false,"clause":"","paymentMethod":"transfer","orderRef":"","reference":"","textBefore":"","textAfter":"","note":"","discountKind":"none","discountValue":0,"rounding":"none","subtotalMinor":300000,"discountMinor":0,"roundingMinor":0,"totalMinor":300000,"paidMinor":0,"creditsMinor":0,"advanceMinor":0,"supersededAt":null,"appearance":{"designId":"cisty","colors":{"accent":"","surface":"","text":"","line":""},"logoPosition":"left","showLogo":true,"showQr":true,"showQrLogo":false,"showSignature":false,"showDuzp":false},"supplierSnapshot":null,"customerSnapshot":null,"accountSnapshot":null,"dateFormat":null,"logoFileId":null,"qrLogoFileId":null,"signatureFileId":null,"relatedInvoiceId":null,"relatedSnapshot":null,"external":false,"importBatchId":null,"importUuid":null,"importPaymentCode":null,"sourceSystem":null,"importPdfFileId":null,"recurringId":null,"periodFrom":null,"periodTo":null,"remindersOff":false,"remindersSnoozeUntil":null,"remindersPartial":false,"revision":1,"issuedAt":null,"sentAt":null,"lineCount":1,"lines":{"changed":[],"added":[{"position":0,"catalogItemId":null,"name":"Konzultace","description":"","quantityMilli":2000,"unit":"hod.","unitPriceMinor":150000,"discountKind":"none","discountValue":0,"netMinor":300000}],"moved":[]}}', NULL, NULL, NULL);
INSERT INTO "audit_log" ("id", "at", "actor_id", "owner_id", "source", "scope", "action", "entity", "entity_id", "before", "after", "ip", "user_agent", "request_id") VALUES (10, 1774000800000, 'm-8e44b3d8-e6cf-41d0-ba67-f1ded3930e86', 'm-8e44b3d8-e6cf-41d0-ba67-f1ded3930e86', 'web', 'user', 'invoice.issue', 'invoice', '65c177bd-1cda-4a61-aadd-0746b375d82e', '{"id":"65c177bd-1cda-4a61-aadd-0746b375d82e","type":"invoice","status":"draft","cancelledFrom":null,"number":null,"variableSymbol":null,"variableSymbolManual":false,"seriesId":"de8558bb-4099-4fc3-8900-d39a543b20a8","customerId":"93052413-1a4a-4ac6-aa27-5a37d6782023","customerName":"Alfa s.r.o.","bankAccountId":"2f0cc0a7-e89c-4179-b25e-fc0ecadedc75","issueDate":"2026-03-20","dueDate":"2026-04-03","taxableDate":null,"language":"cs","currency":"CZK","exchangeRateMicros":null,"exchangeRateSource":null,"exchangeRateDate":null,"foreign":false,"clause":"","paymentMethod":"transfer","orderRef":"","reference":"","textBefore":"","textAfter":"","note":"","discountKind":"none","discountValue":0,"rounding":"none","subtotalMinor":300000,"discountMinor":0,"roundingMinor":0,"totalMinor":300000,"paidMinor":0,"creditsMinor":0,"advanceMinor":0,"supersededAt":null,"appearance":{"designId":"cisty","colors":{"accent":"","surface":"","text":"","line":""},"logoPosition":"left","showLogo":true,"showQr":true,"showQrLogo":false,"showSignature":false,"showDuzp":false},"supplierSnapshot":null,"customerSnapshot":null,"accountSnapshot":null,"dateFormat":null,"logoFileId":null,"qrLogoFileId":null,"signatureFileId":null,"relatedInvoiceId":null,"relatedSnapshot":null,"external":false,"importBatchId":null,"importUuid":null,"importPaymentCode":null,"sourceSystem":null,"importPdfFileId":null,"recurringId":null,"periodFrom":null,"periodTo":null,"remindersOff":false,"remindersSnoozeUntil":null,"remindersPartial":false,"revision":1,"issuedAt":null,"sentAt":null,"lineCount":1}', '{"id":"65c177bd-1cda-4a61-aadd-0746b375d82e","type":"invoice","status":"issued","cancelledFrom":null,"number":"2026-002","variableSymbol":"2026002","variableSymbolManual":false,"seriesId":"de8558bb-4099-4fc3-8900-d39a543b20a8","customerId":"93052413-1a4a-4ac6-aa27-5a37d6782023","customerName":"Alfa s.r.o.","bankAccountId":"2f0cc0a7-e89c-4179-b25e-fc0ecadedc75","issueDate":"2026-03-20","dueDate":"2026-04-03","taxableDate":null,"language":"cs","currency":"CZK","exchangeRateMicros":null,"exchangeRateSource":null,"exchangeRateDate":null,"foreign":false,"clause":"","paymentMethod":"transfer","orderRef":"","reference":"","textBefore":"","textAfter":"","note":"","discountKind":"none","discountValue":0,"rounding":"none","subtotalMinor":300000,"discountMinor":0,"roundingMinor":0,"totalMinor":300000,"paidMinor":0,"creditsMinor":0,"advanceMinor":0,"supersededAt":null,"appearance":{"designId":"cisty","colors":{"accent":"","surface":"","text":"","line":""},"logoPosition":"left","showLogo":true,"showQr":true,"showQrLogo":false,"showSignature":false,"showDuzp":false},"supplierSnapshot":{"name":"Jan Novák","street":"Dlouhá 1","city":"Praha","zip":"110 00","country":"Česká republika","ico":"27082440","dic":"","email":"","phone":"","web":"","registryNote":"","contactPerson":"","vatIdentified":false,"footerText":"","notVatPayerCs":"Nejsem plátce DPH.","notVatPayerEn":"I am not a VAT payer.","advanceNoteCs":"Toto není daňový doklad.","advanceNoteEn":"This is not a tax document."},"customerSnapshot":{"name":"Alfa s.r.o.","street":"Krátká 2","city":"Brno","zip":"602 00","country":"Česká republika","ico":"","dic":"","email":"alfa@example.cz","phone":""},"accountSnapshot":{"name":"Účet","currency":"CZK","number":"19-2000145399","bankCode":"0800","iban":"CZ6508000000192000145399","swift":""},"dateFormat":"d. M. yyyy","logoFileId":null,"qrLogoFileId":null,"signatureFileId":null,"relatedInvoiceId":null,"relatedSnapshot":null,"external":false,"importBatchId":null,"importUuid":null,"importPaymentCode":null,"sourceSystem":null,"importPdfFileId":null,"recurringId":null,"periodFrom":null,"periodTo":null,"remindersOff":false,"remindersSnoozeUntil":null,"remindersPartial":false,"revision":2,"issuedAt":"2026-03-20T10:00:00.000Z","sentAt":null,"lineCount":1}', NULL, NULL, NULL);
INSERT INTO "audit_log" ("id", "at", "actor_id", "owner_id", "source", "scope", "action", "entity", "entity_id", "before", "after", "ip", "user_agent", "request_id") VALUES (11, 1774000800000, 'm-8e44b3d8-e6cf-41d0-ba67-f1ded3930e86', 'm-8e44b3d8-e6cf-41d0-ba67-f1ded3930e86', 'web', 'user', 'invoice.credit_note', 'invoice', '9f4c6cd7-8b94-44e1-ad08-40213b316c36', NULL, '{"id":"9f4c6cd7-8b94-44e1-ad08-40213b316c36","type":"credit_note","status":"draft","cancelledFrom":null,"number":null,"variableSymbol":null,"variableSymbolManual":false,"seriesId":"d6f20c95-2d50-4a08-bc47-87a417dcd992","customerId":"93052413-1a4a-4ac6-aa27-5a37d6782023","customerName":"Alfa s.r.o.","bankAccountId":"2f0cc0a7-e89c-4179-b25e-fc0ecadedc75","issueDate":"2026-03-20","dueDate":"2026-03-20","taxableDate":null,"language":"cs","currency":"CZK","exchangeRateMicros":null,"exchangeRateSource":null,"exchangeRateDate":null,"foreign":false,"clause":"","paymentMethod":"transfer","orderRef":"","reference":"","textBefore":"","textAfter":"","note":"","discountKind":"none","discountValue":0,"rounding":"none","subtotalMinor":-300000,"discountMinor":0,"roundingMinor":0,"totalMinor":-300000,"paidMinor":0,"creditsMinor":0,"advanceMinor":0,"supersededAt":null,"appearance":{"designId":"cisty","colors":{"accent":"","surface":"","text":"","line":""},"logoPosition":"left","showLogo":true,"showQr":true,"showQrLogo":false,"showSignature":false,"showDuzp":false},"supplierSnapshot":null,"customerSnapshot":null,"accountSnapshot":null,"dateFormat":null,"logoFileId":null,"qrLogoFileId":null,"signatureFileId":null,"relatedInvoiceId":"65c177bd-1cda-4a61-aadd-0746b375d82e","relatedSnapshot":null,"external":false,"importBatchId":null,"importUuid":null,"importPaymentCode":null,"sourceSystem":null,"importPdfFileId":null,"recurringId":null,"periodFrom":null,"periodTo":null,"remindersOff":false,"remindersSnoozeUntil":null,"remindersPartial":false,"revision":1,"issuedAt":null,"sentAt":null,"lineCount":1,"lines":[{"position":0,"catalogItemId":null,"name":"Konzultace","description":"","quantityMilli":2000,"unit":"hod.","unitPriceMinor":-150000,"discountKind":"none","discountValue":0,"netMinor":-300000}]}', NULL, NULL, NULL);
INSERT INTO "audit_log" ("id", "at", "actor_id", "owner_id", "source", "scope", "action", "entity", "entity_id", "before", "after", "ip", "user_agent", "request_id") VALUES (12, 1774000800000, 'm-8e44b3d8-e6cf-41d0-ba67-f1ded3930e86', 'm-8e44b3d8-e6cf-41d0-ba67-f1ded3930e86', 'web', 'user', 'invoice_template.save', 'invoice_template', '18e0f192-9f94-4584-8e2c-125cd1feed45', NULL, '{"name":"Paušál","customerId":"93052413-1a4a-4ac6-aa27-5a37d6782023","document":{"type":"invoice","bankAccountId":"2f0cc0a7-e89c-4179-b25e-fc0ecadedc75","dueDays":14,"language":"cs","currency":"CZK","paymentMethod":"transfer","orderRef":"","reference":"","textBefore":"","textAfter":"","note":"","discountKind":"none","discountValue":0,"rounding":"none","appearance":{"designId":"cisty","colors":{"accent":"","surface":"","text":"","line":""},"logoPosition":"left","showLogo":true,"showQr":true,"showQrLogo":false,"showSignature":false,"showDuzp":false},"foreign":false,"clause":"","lines":[]}}', NULL, NULL, NULL);
INSERT INTO "audit_log" ("id", "at", "actor_id", "owner_id", "source", "scope", "action", "entity", "entity_id", "before", "after", "ip", "user_agent", "request_id") VALUES (13, 1774000800000, 'm-8e44b3d8-e6cf-41d0-ba67-f1ded3930e86', 'm-8e44b3d8-e6cf-41d0-ba67-f1ded3930e86', 'web', 'user', 'recurring.save', 'recurring_invoice', 'b82c198f-6f5f-4f33-a530-10d666637299', NULL, '{"name":"Správa webu","customerId":"93052413-1a4a-4ac6-aa27-5a37d6782023","document":{"type":"invoice","bankAccountId":null,"dueDays":14,"language":"cs","currency":"CZK","paymentMethod":"transfer","orderRef":"","reference":"","textBefore":"Fakturujeme {{mesic_nazev}} {{rok}}","textAfter":"","note":"","discountKind":"none","discountValue":0,"rounding":"none","appearance":{"designId":"cisty","colors":{"accent":"","surface":"","text":"","line":""},"logoPosition":"left","showLogo":true,"showQr":true,"showQrLogo":false,"showSignature":false,"showDuzp":false},"foreign":false,"clause":"","lines":[{"catalogItemId":null,"name":"Správa za {{mesic}}/{{rok}}","description":"","quantityMilli":1000,"unit":"ks","unitPriceMinor":100000,"discountKind":"none","discountValue":0}]},"mode":"draft","notifyDaysBefore":null,"frequency":"monthly","every":1,"issueRule":"day","issueDay":10,"startsOn":"2026-03-01","endsOn":null,"maxCount":null,"periodOffset":0,"sendConfirmedAt":null}', NULL, NULL, NULL);
INSERT INTO "audit_log" ("id", "at", "actor_id", "owner_id", "source", "scope", "action", "entity", "entity_id", "before", "after", "ip", "user_agent", "request_id") VALUES (14, 1774000800000, 'm-8e44b3d8-e6cf-41d0-ba67-f1ded3930e86', 'm-8e44b3d8-e6cf-41d0-ba67-f1ded3930e86', 'web', 'user', 'reminder_rule.save', 'reminder_rule', '578de3ae-4e3f-43f0-90fa-bd05bd3e71af', NULL, '{"offsetDays":7,"texts":null}', NULL, NULL, NULL);
INSERT INTO "user" ("id", "name", "email", "email_verified", "image", "created_at", "updated_at", "role", "banned", "ban_reason", "ban_expires", "theme") VALUES ('m-8e44b3d8-e6cf-41d0-ba67-f1ded3930e86', 'm-8e44b3d8-e6cf-41d0-ba67-f1ded3930e86', 'm-8e44b3d8-e6cf-41d0-ba67-f1ded3930e86@example.cz', 0, NULL, 1774000800000, 1774000800000, 'user', 0, NULL, NULL, 'system');
INSERT INTO "rate_limit" ("key", "window_start", "count", "denied") VALUES ('mailSaveUser:m-8e44b3d8-e6cf-41d0-ba67-f1ded3930e86', 1774000800000, 1, 0);
INSERT INTO "supplier" ("user_id", "name", "street", "city", "zip", "country", "ico", "dic", "email", "phone", "web", "registry_note", "contact_person", "vat_identified", "footer_text", "not_vat_payer_cs", "not_vat_payer_en", "logo_file_id", "qr_logo_file_id", "signature_file_id", "updated_at", "reverse_charge_cs", "reverse_charge_en", "advance_note_cs", "advance_note_en") VALUES ('m-8e44b3d8-e6cf-41d0-ba67-f1ded3930e86', 'Jan Novák', 'Dlouhá 1', 'Praha', '110 00', 'Česká republika', '27082440', '', '', '', '', '', '', 0, '', 'Nejsem plátce DPH.', 'I am not a VAT payer.', NULL, NULL, NULL, 1774000800000, 'Daň odvede zákazník (přenesení daňové povinnosti, čl. 196 směrnice 2006/112/ES).', 'Reverse charge: VAT to be accounted for by the customer (Article 196 of Directive 2006/112/EC).', 'Toto není daňový doklad.', 'This is not a tax document.');
INSERT INTO "bank_account" ("id", "user_id", "name", "currency", "number", "bank_code", "iban", "swift", "is_default", "hidden", "created_at", "updated_at") VALUES ('2f0cc0a7-e89c-4179-b25e-fc0ecadedc75', 'm-8e44b3d8-e6cf-41d0-ba67-f1ded3930e86', 'Účet', 'CZK', '19-2000145399', '0800', 'CZ6508000000192000145399', '', 1, 0, 1774000800000, 1774000800000);
INSERT INTO "number_series" ("id", "user_id", "name", "document_type", "template", "reset", "is_default", "created_at", "updated_at") VALUES ('de8558bb-4099-4fc3-8900-d39a543b20a8', 'm-8e44b3d8-e6cf-41d0-ba67-f1ded3930e86', 'Faktura', 'invoice', '{RRRR}-{NNN}', 'yearly', 1, 1774000800000, 1774000800000);
INSERT INTO "number_series" ("id", "user_id", "name", "document_type", "template", "reset", "is_default", "created_at", "updated_at") VALUES ('ede5d182-0f92-4d36-b8a1-f61936b9ea81', 'm-8e44b3d8-e6cf-41d0-ba67-f1ded3930e86', 'Zálohová faktura', 'advance', 'Z{RRRR}-{NNN}', 'yearly', 1, 1774000800000, 1774000800000);
INSERT INTO "number_series" ("id", "user_id", "name", "document_type", "template", "reset", "is_default", "created_at", "updated_at") VALUES ('d6f20c95-2d50-4a08-bc47-87a417dcd992', 'm-8e44b3d8-e6cf-41d0-ba67-f1ded3930e86', 'Opravná faktura', 'credit_note', 'D{RRRR}-{NNN}', 'yearly', 1, 1774000800000, 1774000800000);
INSERT INTO "number_series_counter" ("series_id", "period_key", "user_id", "next", "highest") VALUES ('de8558bb-4099-4fc3-8900-d39a543b20a8', '2026', 'm-8e44b3d8-e6cf-41d0-ba67-f1ded3930e86', 3, 2);
INSERT INTO "customer" ("id", "user_id", "name", "street", "city", "zip", "country", "ico", "dic", "email", "extra_emails", "phone", "note", "due_days", "language", "currency", "design_id", "reminders_enabled", "vat_verified_at", "vat_valid", "archived_at", "created_at", "updated_at", "search_text", "import_batch_id") VALUES ('93052413-1a4a-4ac6-aa27-5a37d6782023', 'm-8e44b3d8-e6cf-41d0-ba67-f1ded3930e86', 'Alfa s.r.o.', 'Krátká 2', 'Brno', '602 00', 'Česká republika', '', '', 'alfa@example.cz', '[]', '', '', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 1774000800000, 1774000800000, 'alfa s.r.o.


alfa@example.cz', NULL);
INSERT INTO "invoice" ("id", "user_id", "type", "status", "cancelled_from", "number", "variable_symbol", "variable_symbol_manual", "series_id", "customer_id", "customer_name", "bank_account_id", "issue_date", "due_date", "taxable_date", "language", "currency", "exchange_rate_micros", "payment_method", "order_ref", "reference", "text_before", "text_after", "note", "discount_kind", "discount_value", "rounding", "subtotal_minor", "discount_minor", "rounding_minor", "total_minor", "paid_minor", "appearance", "supplier_snapshot", "customer_snapshot", "account_snapshot", "logo_file_id", "qr_logo_file_id", "signature_file_id", "related_invoice_id", "external", "search_text", "revision", "issued_at", "sent_at", "created_at", "updated_at", "date_format", "recurring_id", "period_from", "period_to", "reminders_off", "reminders_snooze_until", "reminders_partial", "credits_minor", "advance_minor", "superseded_at", "related_snapshot", "exchange_rate_source", "exchange_rate_date", "foreign", "clause", "import_batch_id", "import_uuid", "source_system", "import_pdf_file_id", "import_payment_code") VALUES ('dfbea43e-8b7f-4228-9a65-16d550bfbae2', 'm-8e44b3d8-e6cf-41d0-ba67-f1ded3930e86', 'invoice', 'partially_paid', NULL, '2026-001', '2026001', 0, 'de8558bb-4099-4fc3-8900-d39a543b20a8', '93052413-1a4a-4ac6-aa27-5a37d6782023', 'Alfa s.r.o.', '2f0cc0a7-e89c-4179-b25e-fc0ecadedc75', '2026-03-20', '2026-04-03', NULL, 'cs', 'CZK', NULL, 'transfer', '', '', '', '', '', 'none', 0, 'none', 300000, 0, 0, 300000, 100000, '{"designId":"cisty","colors":{"accent":"","surface":"","text":"","line":""},"logoPosition":"left","showLogo":true,"showQr":true,"showQrLogo":false,"showSignature":false,"showDuzp":false}', '{"name":"Jan Novák","street":"Dlouhá 1","city":"Praha","zip":"110 00","country":"Česká republika","ico":"27082440","dic":"","email":"","phone":"","web":"","registryNote":"","contactPerson":"","vatIdentified":false,"footerText":"","notVatPayerCs":"Nejsem plátce DPH.","notVatPayerEn":"I am not a VAT payer.","advanceNoteCs":"Toto není daňový doklad.","advanceNoteEn":"This is not a tax document."}', '{"name":"Alfa s.r.o.","street":"Krátká 2","city":"Brno","zip":"602 00","country":"Česká republika","ico":"","dic":"","email":"alfa@example.cz","phone":""}', '{"name":"Účet","currency":"CZK","number":"19-2000145399","bankCode":"0800","iban":"CZ6508000000192000145399","swift":""}', NULL, NULL, NULL, NULL, 0, '2026-001
alfa s.r.o.
konzultace', 3, 1774000800000, NULL, 1774000800000, 1774000800000, 'd. M. yyyy', NULL, NULL, NULL, 0, NULL, 0, 0, 0, NULL, NULL, NULL, NULL, 0, '', NULL, NULL, NULL, NULL, NULL);
INSERT INTO "invoice" ("id", "user_id", "type", "status", "cancelled_from", "number", "variable_symbol", "variable_symbol_manual", "series_id", "customer_id", "customer_name", "bank_account_id", "issue_date", "due_date", "taxable_date", "language", "currency", "exchange_rate_micros", "payment_method", "order_ref", "reference", "text_before", "text_after", "note", "discount_kind", "discount_value", "rounding", "subtotal_minor", "discount_minor", "rounding_minor", "total_minor", "paid_minor", "appearance", "supplier_snapshot", "customer_snapshot", "account_snapshot", "logo_file_id", "qr_logo_file_id", "signature_file_id", "related_invoice_id", "external", "search_text", "revision", "issued_at", "sent_at", "created_at", "updated_at", "date_format", "recurring_id", "period_from", "period_to", "reminders_off", "reminders_snooze_until", "reminders_partial", "credits_minor", "advance_minor", "superseded_at", "related_snapshot", "exchange_rate_source", "exchange_rate_date", "foreign", "clause", "import_batch_id", "import_uuid", "source_system", "import_pdf_file_id", "import_payment_code") VALUES ('65c177bd-1cda-4a61-aadd-0746b375d82e', 'm-8e44b3d8-e6cf-41d0-ba67-f1ded3930e86', 'invoice', 'issued', NULL, '2026-002', '2026002', 0, 'de8558bb-4099-4fc3-8900-d39a543b20a8', '93052413-1a4a-4ac6-aa27-5a37d6782023', 'Alfa s.r.o.', '2f0cc0a7-e89c-4179-b25e-fc0ecadedc75', '2026-03-20', '2026-04-03', NULL, 'cs', 'CZK', NULL, 'transfer', '', '', '', '', '', 'none', 0, 'none', 300000, 0, 0, 300000, 0, '{"designId":"cisty","colors":{"accent":"","surface":"","text":"","line":""},"logoPosition":"left","showLogo":true,"showQr":true,"showQrLogo":false,"showSignature":false,"showDuzp":false}', '{"name":"Jan Novák","street":"Dlouhá 1","city":"Praha","zip":"110 00","country":"Česká republika","ico":"27082440","dic":"","email":"","phone":"","web":"","registryNote":"","contactPerson":"","vatIdentified":false,"footerText":"","notVatPayerCs":"Nejsem plátce DPH.","notVatPayerEn":"I am not a VAT payer.","advanceNoteCs":"Toto není daňový doklad.","advanceNoteEn":"This is not a tax document."}', '{"name":"Alfa s.r.o.","street":"Krátká 2","city":"Brno","zip":"602 00","country":"Česká republika","ico":"","dic":"","email":"alfa@example.cz","phone":""}', '{"name":"Účet","currency":"CZK","number":"19-2000145399","bankCode":"0800","iban":"CZ6508000000192000145399","swift":""}', NULL, NULL, NULL, NULL, 0, '2026-002
alfa s.r.o.
konzultace', 2, 1774000800000, NULL, 1774000800000, 1774000800000, 'd. M. yyyy', NULL, NULL, NULL, 0, NULL, 0, 0, 0, NULL, NULL, NULL, NULL, 0, '', NULL, NULL, NULL, NULL, NULL);
INSERT INTO "invoice" ("id", "user_id", "type", "status", "cancelled_from", "number", "variable_symbol", "variable_symbol_manual", "series_id", "customer_id", "customer_name", "bank_account_id", "issue_date", "due_date", "taxable_date", "language", "currency", "exchange_rate_micros", "payment_method", "order_ref", "reference", "text_before", "text_after", "note", "discount_kind", "discount_value", "rounding", "subtotal_minor", "discount_minor", "rounding_minor", "total_minor", "paid_minor", "appearance", "supplier_snapshot", "customer_snapshot", "account_snapshot", "logo_file_id", "qr_logo_file_id", "signature_file_id", "related_invoice_id", "external", "search_text", "revision", "issued_at", "sent_at", "created_at", "updated_at", "date_format", "recurring_id", "period_from", "period_to", "reminders_off", "reminders_snooze_until", "reminders_partial", "credits_minor", "advance_minor", "superseded_at", "related_snapshot", "exchange_rate_source", "exchange_rate_date", "foreign", "clause", "import_batch_id", "import_uuid", "source_system", "import_pdf_file_id", "import_payment_code") VALUES ('9f4c6cd7-8b94-44e1-ad08-40213b316c36', 'm-8e44b3d8-e6cf-41d0-ba67-f1ded3930e86', 'credit_note', 'draft', NULL, NULL, NULL, 0, 'd6f20c95-2d50-4a08-bc47-87a417dcd992', '93052413-1a4a-4ac6-aa27-5a37d6782023', 'Alfa s.r.o.', '2f0cc0a7-e89c-4179-b25e-fc0ecadedc75', '2026-03-20', '2026-03-20', NULL, 'cs', 'CZK', NULL, 'transfer', '', '', '', '', '', 'none', 0, 'none', -300000, 0, 0, -300000, 0, '{"designId":"cisty","colors":{"accent":"","surface":"","text":"","line":""},"logoPosition":"left","showLogo":true,"showQr":true,"showQrLogo":false,"showSignature":false,"showDuzp":false}', NULL, NULL, NULL, NULL, NULL, NULL, '65c177bd-1cda-4a61-aadd-0746b375d82e', 0, '
alfa s.r.o.
konzultace', 1, NULL, NULL, 1774000800000, 1774000800000, NULL, NULL, NULL, NULL, 0, NULL, 0, 0, 0, NULL, NULL, NULL, NULL, 0, '', NULL, NULL, NULL, NULL, NULL);
INSERT INTO "invoice_line" ("id", "invoice_id", "user_id", "position", "catalog_item_id", "name", "description", "quantity_milli", "unit", "unit_price_minor", "discount_kind", "discount_value", "net_minor") VALUES ('25cfe31a-7f3b-428c-a35a-fceeb5725376', 'dfbea43e-8b7f-4228-9a65-16d550bfbae2', 'm-8e44b3d8-e6cf-41d0-ba67-f1ded3930e86', 0, NULL, 'Konzultace', '', 2000, 'hod.', 150000, 'none', 0, 300000);
INSERT INTO "invoice_line" ("id", "invoice_id", "user_id", "position", "catalog_item_id", "name", "description", "quantity_milli", "unit", "unit_price_minor", "discount_kind", "discount_value", "net_minor") VALUES ('74bcf478-2449-4acd-936e-612fa132bd03', '65c177bd-1cda-4a61-aadd-0746b375d82e', 'm-8e44b3d8-e6cf-41d0-ba67-f1ded3930e86', 0, NULL, 'Konzultace', '', 2000, 'hod.', 150000, 'none', 0, 300000);
INSERT INTO "invoice_line" ("id", "invoice_id", "user_id", "position", "catalog_item_id", "name", "description", "quantity_milli", "unit", "unit_price_minor", "discount_kind", "discount_value", "net_minor") VALUES ('197bbccb-a669-4062-9647-52b19063eefc', '9f4c6cd7-8b94-44e1-ad08-40213b316c36', 'm-8e44b3d8-e6cf-41d0-ba67-f1ded3930e86', 0, NULL, 'Konzultace', '', 2000, 'hod.', -150000, 'none', 0, -300000);
INSERT INTO "invoice_template" ("id", "user_id", "name", "customer_id", "document", "created_at", "updated_at") VALUES ('18e0f192-9f94-4584-8e2c-125cd1feed45', 'm-8e44b3d8-e6cf-41d0-ba67-f1ded3930e86', 'Paušál', '93052413-1a4a-4ac6-aa27-5a37d6782023', '{"type":"invoice","bankAccountId":"2f0cc0a7-e89c-4179-b25e-fc0ecadedc75","dueDays":14,"language":"cs","currency":"CZK","paymentMethod":"transfer","orderRef":"","reference":"","textBefore":"","textAfter":"","note":"","discountKind":"none","discountValue":0,"rounding":"none","appearance":{"designId":"cisty","colors":{"accent":"","surface":"","text":"","line":""},"logoPosition":"left","showLogo":true,"showQr":true,"showQrLogo":false,"showSignature":false,"showDuzp":false},"foreign":false,"clause":"","lines":[]}', 1774000800000, 1774000800000);
INSERT INTO "recurring_invoice" ("id", "user_id", "name", "customer_id", "document", "frequency", "every", "issue_rule", "issue_day", "starts_on", "ends_on", "max_count", "period_offset", "mode", "notify_days_before", "status", "cursor_date", "send_confirmed_at", "created_at", "updated_at") VALUES ('b82c198f-6f5f-4f33-a530-10d666637299', 'm-8e44b3d8-e6cf-41d0-ba67-f1ded3930e86', 'Správa webu', '93052413-1a4a-4ac6-aa27-5a37d6782023', '{"type":"invoice","bankAccountId":null,"dueDays":14,"language":"cs","currency":"CZK","paymentMethod":"transfer","orderRef":"","reference":"","textBefore":"Fakturujeme {{mesic_nazev}} {{rok}}","textAfter":"","note":"","discountKind":"none","discountValue":0,"rounding":"none","appearance":{"designId":"cisty","colors":{"accent":"","surface":"","text":"","line":""},"logoPosition":"left","showLogo":true,"showQr":true,"showQrLogo":false,"showSignature":false,"showDuzp":false},"foreign":false,"clause":"","lines":[{"catalogItemId":null,"name":"Správa za {{mesic}}/{{rok}}","description":"","quantityMilli":1000,"unit":"ks","unitPriceMinor":100000,"discountKind":"none","discountValue":0}]}', 'monthly', 1, 'day', 10, '2026-03-01', NULL, NULL, 0, 'draft', NULL, 'active', '2026-03-19', NULL, 1774000800000, 1774000800000);
INSERT INTO "reminder_rule" ("id", "user_id", "position", "offset_days", "texts", "created_at", "updated_at", "active_since") VALUES ('578de3ae-4e3f-43f0-90fa-bd05bd3e71af', 'm-8e44b3d8-e6cf-41d0-ba67-f1ded3930e86', 0, 7, NULL, 1774000800000, 1774000800000, '2026-03-20');
INSERT INTO "payment" ("id", "user_id", "invoice_id", "kind", "paid_on", "amount_minor", "currency", "credited_minor", "method", "note", "source", "created_at", "updated_at", "notification_id", "rate_micros", "date_estimated") VALUES ('f5d7e8a3-a0ac-466f-908c-ce0043f04f0b', 'm-8e44b3d8-e6cf-41d0-ba67-f1ded3930e86', 'dfbea43e-8b7f-4228-9a65-16d550bfbae2', 'payment', '2026-03-20', 100000, 'CZK', 100000, 'transfer', '', 'manual', 1774000800000, 1774000800000, NULL, 1000000, 0);
INSERT INTO "dashboard" ("id", "user_id", "name", "is_default", "position", "revision", "created_at", "updated_at") VALUES ('40732ef3-7bc8-4204-b733-84b1d3577088', 'm-8e44b3d8-e6cf-41d0-ba67-f1ded3930e86', 'Přehled', 1, 0, 1, 1774000800000, 1774000800000);
INSERT INTO "dashboard_widget" ("id", "dashboard_id", "user_id", "config", "x", "y", "w", "h", "created_at", "updated_at") VALUES ('f6e21f8b-c6b7-4498-9f29-f5d206a0628b', '40732ef3-7bc8-4204-b733-84b1d3577088', 'm-8e44b3d8-e6cf-41d0-ba67-f1ded3930e86', '{"v":1,"kind":"query","title":"Fakturováno letos","color":"chart-1","format":"auto","source":"invoices","metric":"sum","measure":"invoiced","period":"this_year","display":"number"}', 0, 0, 3, 2, 1774000800000, 1774000800000);
INSERT INTO "dashboard_widget" ("id", "dashboard_id", "user_id", "config", "x", "y", "w", "h", "created_at", "updated_at") VALUES ('a5d67c31-62df-4b5f-b542-d5650394eeaf', '40732ef3-7bc8-4204-b733-84b1d3577088', 'm-8e44b3d8-e6cf-41d0-ba67-f1ded3930e86', '{"v":1,"kind":"query","title":"Uhrazeno letos","color":"chart-1","format":"auto","source":"payments","metric":"sum","period":"this_year","display":"number"}', 3, 0, 3, 2, 1774000800000, 1774000800000);
INSERT INTO "dashboard_widget" ("id", "dashboard_id", "user_id", "config", "x", "y", "w", "h", "created_at", "updated_at") VALUES ('76cb0a8c-b334-42c1-9965-03fafb27a5e8', '40732ef3-7bc8-4204-b733-84b1d3577088', 'm-8e44b3d8-e6cf-41d0-ba67-f1ded3930e86', '{"v":1,"kind":"query","title":"Pohledávky","color":"chart-1","format":"auto","source":"invoices","metric":"sum","measure":"outstanding","display":"number"}', 6, 0, 3, 2, 1774000800000, 1774000800000);
INSERT INTO "dashboard_widget" ("id", "dashboard_id", "user_id", "config", "x", "y", "w", "h", "created_at", "updated_at") VALUES ('fc06f8c5-17e5-4009-90ca-120de9e5304b', '40732ef3-7bc8-4204-b733-84b1d3577088', 'm-8e44b3d8-e6cf-41d0-ba67-f1ded3930e86', '{"v":1,"kind":"query","title":"Po splatnosti","color":"chart-4","format":"auto","source":"invoices","metric":"sum","measure":"overdue","display":"number"}', 9, 0, 3, 2, 1774000800000, 1774000800000);
INSERT INTO "dashboard_widget" ("id", "dashboard_id", "user_id", "config", "x", "y", "w", "h", "created_at", "updated_at") VALUES ('746264ec-37e9-428f-87f8-2bcbcb0c6096', '40732ef3-7bc8-4204-b733-84b1d3577088', 'm-8e44b3d8-e6cf-41d0-ba67-f1ded3930e86', '{"v":1,"kind":"system","systemId":"due_alerts","title":"Nejbližší splatnosti","color":"chart-1","format":"auto","rows":5}', 0, 2, 4, 4, 1774000800000, 1774000800000);
INSERT INTO "dashboard_widget" ("id", "dashboard_id", "user_id", "config", "x", "y", "w", "h", "created_at", "updated_at") VALUES ('8691a370-29da-4182-ac14-3008c17bf492', '40732ef3-7bc8-4204-b733-84b1d3577088', 'm-8e44b3d8-e6cf-41d0-ba67-f1ded3930e86', '{"v":1,"kind":"query","title":"Top zákazníci","color":"chart-1","format":"auto","source":"invoices","metric":"sum","measure":"invoiced","groupBy":"customer","period":"this_year","topN":5,"display":"table"}', 4, 2, 4, 4, 1774000800000, 1774000800000);
INSERT INTO "dashboard_widget" ("id", "dashboard_id", "user_id", "config", "x", "y", "w", "h", "created_at", "updated_at") VALUES ('48fc5b3a-9944-45c0-8d90-fd85b21c21c7', '40732ef3-7bc8-4204-b733-84b1d3577088', 'm-8e44b3d8-e6cf-41d0-ba67-f1ded3930e86', '{"v":1,"kind":"query","title":"Průměrná doba úhrady","color":"chart-1","format":"auto","source":"invoices","metric":"days_to_pay","period":"last_12_months","display":"number"}', 8, 2, 3, 2, 1774000800000, 1774000800000);
INSERT INTO "dashboard_widget" ("id", "dashboard_id", "user_id", "config", "x", "y", "w", "h", "created_at", "updated_at") VALUES ('a9158aa5-5fe1-4def-90ee-c4f586a1df27', '40732ef3-7bc8-4204-b733-84b1d3577088', 'm-8e44b3d8-e6cf-41d0-ba67-f1ded3930e86', '{"v":1,"kind":"query","title":"Tržby po měsících","color":"chart-1","format":"auto","source":"invoices","metric":"sum","measure":"invoiced","groupBy":"month","period":"last_12_months","display":"bar"}', 0, 6, 6, 4, 1774000800000, 1774000800000);
INSERT INTO "dashboard_widget" ("id", "dashboard_id", "user_id", "config", "x", "y", "w", "h", "created_at", "updated_at") VALUES ('df882f18-c46c-42db-aec3-e9f7e19c4034', '40732ef3-7bc8-4204-b733-84b1d3577088', 'm-8e44b3d8-e6cf-41d0-ba67-f1ded3930e86', '{"v":1,"kind":"query","title":"Meziroční porovnání","color":"chart-1","format":"auto","source":"invoices","metric":"sum","measure":"invoiced","groupBy":"month","period":"this_year","compare":"year","display":"bar"}', 6, 6, 6, 4, 1774000800000, 1774000800000);
INSERT INTO "sqlite_sequence" ("name", "seq") VALUES ('audit_log', 14);
CREATE INDEX `audit_log_owner_at_idx` ON `audit_log` (`owner_id`,`at`);
CREATE INDEX `audit_log_entity_idx` ON `audit_log` (`entity`,`entity_id`);
CREATE TRIGGER `audit_log_no_update` BEFORE UPDATE ON `audit_log`
BEGIN
	SELECT RAISE(ABORT, 'audit_log je append-only');
END;
CREATE TRIGGER `audit_log_no_replace` BEFORE INSERT ON `audit_log`
WHEN EXISTS (SELECT 1 FROM `audit_log` WHERE `id` = NEW.`id`)
BEGIN
	SELECT RAISE(ABORT, 'audit_log je append-only');
END;
CREATE INDEX `account_user_idx` ON `account` (`user_id`);
CREATE UNIQUE INDEX `session_token_unique` ON `session` (`token`);
CREATE INDEX `session_user_idx` ON `session` (`user_id`);
CREATE UNIQUE INDEX `user_email_unique` ON `user` (`email`);
CREATE INDEX `verification_identifier_idx` ON `verification` (`identifier`);
CREATE UNIQUE INDEX `invitation_token_hash_unique` ON `invitation` (`token_hash`);
CREATE INDEX `invitation_email_idx` ON `invitation` (`email`);
CREATE INDEX `rate_limit_window_idx` ON `rate_limit` (`window_start`);
CREATE TRIGGER `audit_log_no_delete` BEFORE DELETE ON `audit_log`
WHEN NOT EXISTS (SELECT 1 FROM `audit_purge` WHERE `owner_id` = OLD.`owner_id`)
BEGIN
	SELECT RAISE(ABORT, 'audit_log je append-only');
END;
CREATE INDEX `file_user_idx` ON `file` (`user_id`);
CREATE INDEX `bank_account_user_idx` ON `bank_account` (`user_id`);
CREATE UNIQUE INDEX `bank_account_default_idx` ON `bank_account` (`user_id`,`currency`) WHERE is_default = 1;
CREATE INDEX `number_series_user_idx` ON `number_series` (`user_id`);
CREATE UNIQUE INDEX `number_series_default_idx` ON `number_series` (`user_id`,`document_type`) WHERE is_default = 1;
CREATE INDEX `number_series_counter_user_idx` ON `number_series_counter` (`user_id`);
CREATE INDEX `customer_user_idx` ON `customer` (`user_id`,`name`);
CREATE INDEX `customer_ico_idx` ON `customer` (`user_id`,`ico`);
CREATE INDEX `catalog_item_user_idx` ON `catalog_item` (`user_id`,`name`);
CREATE INDEX `catalog_item_usage_idx` ON `catalog_item` (`user_id`,`use_count`);
CREATE UNIQUE INDEX `unit_user_name_idx` ON `unit` (`user_id`,`name`);
CREATE UNIQUE INDEX `invoice_user_number_idx` ON `invoice` (`user_id`,`number`) WHERE number IS NOT NULL;
CREATE INDEX `invoice_user_status_idx` ON `invoice` (`user_id`,`status`);
CREATE INDEX `invoice_user_issue_date_idx` ON `invoice` (`user_id`,`issue_date`);
CREATE INDEX `invoice_user_customer_idx` ON `invoice` (`user_id`,`customer_id`);
CREATE INDEX `invoice_line_invoice_idx` ON `invoice_line` (`invoice_id`,`position`);
CREATE INDEX `invoice_line_user_idx` ON `invoice_line` (`user_id`);
CREATE INDEX `invoice_tag_tag_idx` ON `invoice_tag` (`tag_id`);
CREATE INDEX `invoice_tag_user_idx` ON `invoice_tag` (`user_id`);
CREATE UNIQUE INDEX `tag_user_name_key_idx` ON `tag` (`user_id`,`name_key`);
CREATE UNIQUE INDEX `invoice_version_invoice_no_idx` ON `invoice_version` (`invoice_id`,`version_no`);
CREATE INDEX `invoice_version_user_idx` ON `invoice_version` (`user_id`);
CREATE INDEX `invoice_template_user_idx` ON `invoice_template` (`user_id`,`name`);
CREATE UNIQUE INDEX `job_key_unique` ON `job` (`key`);
CREATE INDEX `job_status_run_at_idx` ON `job` (`status`,`run_at`);
CREATE INDEX `job_user_idx` ON `job` (`user_id`);
CREATE UNIQUE INDEX `notification_user_dedupe_idx` ON `notification` (`user_id`,`dedupe_key`);
CREATE INDEX `notification_user_read_idx` ON `notification` (`user_id`,`read_at`,`created_at`);
CREATE UNIQUE INDEX `email_template_user_kind_language_idx` ON `email_template` (`user_id`,`kind`,`language`);
CREATE INDEX `email_log_user_invoice_created_idx` ON `email_log` (`user_id`,`invoice_id`,`created_at`);
CREATE INDEX `recurring_invoice_user_idx` ON `recurring_invoice` (`user_id`,`status`);
CREATE UNIQUE INDEX `recurring_run_period_idx` ON `recurring_run` (`recurring_id`,`period_key`);
CREATE INDEX `recurring_run_user_idx` ON `recurring_run` (`user_id`);
CREATE INDEX `recurring_run_invoice_idx` ON `recurring_run` (`invoice_id`);
CREATE INDEX `invoice_recurring_idx` ON `invoice` (`recurring_id`);
CREATE UNIQUE INDEX `reminder_rule_user_offset_idx` ON `reminder_rule` (`user_id`,`offset_days`);
CREATE INDEX `reminder_sent_user_invoice_idx` ON `reminder_sent` (`user_id`,`invoice_id`);
CREATE UNIQUE INDEX `reminder_sent_automatic_idx` ON `reminder_sent` (`invoice_id`,`offset_days`) WHERE "reminder_sent"."trigger" = 'automatic';
CREATE INDEX `payment_user_invoice_idx` ON `payment` (`user_id`,`invoice_id`);
CREATE INDEX `payment_user_paid_on_idx` ON `payment` (`user_id`,`paid_on`);
CREATE UNIQUE INDEX `bank_notification_user_dedupe_idx` ON `bank_notification` (`user_id`,`dedupe_key`);
CREATE INDEX `bank_notification_user_status_idx` ON `bank_notification` (`user_id`,`status`,`received_at`);
CREATE INDEX `payment_notification_idx` ON `payment` (`notification_id`);
CREATE INDEX `invoice_user_variable_symbol_idx` ON `invoice` (`user_id`,`variable_symbol`);
CREATE UNIQUE INDEX `email_log_running_idx` ON `email_log` (`invoice_id`,`kind`,coalesce(`payment_id`, '')) WHERE "email_log"."status" IN ('queued', 'sending');
CREATE INDEX `invoice_user_related_idx` ON `invoice` (`user_id`,`related_invoice_id`);
CREATE UNIQUE INDEX `invoice_final_of_advance_idx` ON `invoice` (`related_invoice_id`) WHERE type = 'invoice' AND related_invoice_id IS NOT NULL AND status <> 'cancelled';
CREATE INDEX `dashboard_user_idx` ON `dashboard` (`user_id`,`position`);
CREATE UNIQUE INDEX `dashboard_default_idx` ON `dashboard` (`user_id`) WHERE is_default = 1;
CREATE INDEX `dashboard_widget_user_idx` ON `dashboard_widget` (`user_id`);
CREATE INDEX `dashboard_widget_dashboard_idx` ON `dashboard_widget` (`dashboard_id`,`user_id`);
CREATE INDEX `import_batch_user_idx` ON `import_batch` (`user_id`,`created_at`);
CREATE INDEX `import_batch_status_idx` ON `import_batch` (`status`,`updated_at`);
CREATE UNIQUE INDEX `mapping_preset_user_name_idx` ON `mapping_preset` (`user_id`,`target`,`name`);
CREATE INDEX `file_import_batch_idx` ON `file` (`import_batch_id`);
CREATE UNIQUE INDEX `invoice_user_import_uuid_idx` ON `invoice` (`user_id`,`import_uuid`) WHERE import_uuid IS NOT NULL;
CREATE INDEX `invoice_import_batch_idx` ON `invoice` (`import_batch_id`);
CREATE INDEX `export_job_user_idx` ON `export_job` (`user_id`,`created_at`);
CREATE INDEX `export_job_status_idx` ON `export_job` (`status`,`expires_at`);
COMMIT;
