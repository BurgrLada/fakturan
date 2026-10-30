-- Rows of purged accounts stay changeable only while audit_purge names them; NULL owners and
-- instance-scoped rows never match, so the instance record of a deletion survives (AUD-010).
CREATE TRIGGER `audit_log_no_update` BEFORE UPDATE ON `audit_log`
WHEN NOT EXISTS (SELECT 1 FROM `audit_purge` WHERE `owner_id` = OLD.`owner_id` AND OLD.`scope` = 'user')
BEGIN
	SELECT RAISE(ABORT, 'audit_log je append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `audit_log_no_delete` BEFORE DELETE ON `audit_log`
WHEN NOT EXISTS (SELECT 1 FROM `audit_purge` WHERE `owner_id` = OLD.`owner_id` AND OLD.`scope` = 'user')
BEGIN
	SELECT RAISE(ABORT, 'audit_log je append-only');
END;
--> statement-breakpoint
-- INSERT OR REPLACE removes the conflicting row without firing delete triggers.
CREATE TRIGGER `audit_log_no_replace` BEFORE INSERT ON `audit_log`
WHEN EXISTS (SELECT 1 FROM `audit_log` WHERE `id` = NEW.`id`)
BEGIN
	SELECT RAISE(ABORT, 'audit_log je append-only');
END;
