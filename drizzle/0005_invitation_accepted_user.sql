ALTER TABLE `invitation` ADD `accepted_user_id` text;
--> statement-breakpoint
DROP TRIGGER `audit_log_no_delete`;
--> statement-breakpoint
-- While audit_purge names an account, all rows it owns are deletable in any scope; ownerless rows,
-- including the closing record of the deletion, never match (AUD-010).
CREATE TRIGGER `audit_log_no_delete` BEFORE DELETE ON `audit_log`
WHEN NOT EXISTS (SELECT 1 FROM `audit_purge` WHERE `owner_id` = OLD.`owner_id`)
BEGIN
	SELECT RAISE(ABORT, 'audit_log je append-only');
END;
