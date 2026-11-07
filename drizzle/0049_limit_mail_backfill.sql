-- limit_mail_sent from the jobs planned before it existed, so no threshold already handled is sent
-- again after this release. A threshold implies the lower ones, as the planner records them.
INSERT OR IGNORE INTO `limit_mail_sent` (`id`, `user_id`, `year`, `threshold`, `created_at`)
WITH `planned` AS (
  SELECT `user_id`,
    CAST(json_extract(`payload`, '$.period') AS INTEGER) AS `year`,
    CAST(json_extract(`payload`, '$.threshold') AS TEXT) AS `threshold`,
    `created_at`
  FROM `job`
  WHERE `kind` = 'user.report' AND `key` LIKE 'limit:%' AND `user_id` IS NOT NULL
    AND json_extract(`payload`, '$.report') = 'limit'
    AND CAST(json_extract(`payload`, '$.threshold') AS TEXT) IN ('80', '95', 'over')
),
`steps` (`threshold`, `rank`) AS (VALUES ('80', 1), ('95', 2), ('over', 3))
SELECT lower(hex(randomblob(16))), `planned`.`user_id`, `planned`.`year`, `lower`.`threshold`,
  min(`planned`.`created_at`)
FROM `planned`
JOIN `steps` AS `own` ON `own`.`threshold` = `planned`.`threshold`
JOIN `steps` AS `lower` ON `lower`.`rank` <= `own`.`rank`
GROUP BY `planned`.`user_id`, `planned`.`year`, `lower`.`threshold`;
