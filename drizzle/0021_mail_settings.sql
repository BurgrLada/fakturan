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
