CREATE TEMP TABLE `__inspection_job_kind_guard` (`invalid_count` integer CHECK (`invalid_count` = 0));--> statement-breakpoint
INSERT INTO `__inspection_job_kind_guard`
SELECT count(*)
FROM `jobs`
LEFT JOIN `assets`
  ON `assets`.`id` = json_extract(`jobs`.`payload`, '$.assetId')
 AND `assets`.`organization_id` = `jobs`.`organization_id`
 AND `assets`.`project_id` = `jobs`.`project_id`
WHERE `jobs`.`type` = 'media.inspect'
  AND (`assets`.`id` IS NULL OR `assets`.`media_kind` NOT IN ('image', 'video', 'document'));--> statement-breakpoint
DROP TABLE `__inspection_job_kind_guard`;--> statement-breakpoint
UPDATE `jobs`
SET `type` = 'media.inspect.' || (
  SELECT `assets`.`media_kind`
  FROM `assets`
  WHERE `assets`.`id` = json_extract(`jobs`.`payload`, '$.assetId')
    AND `assets`.`organization_id` = `jobs`.`organization_id`
    AND `assets`.`project_id` = `jobs`.`project_id`
)
WHERE `type` = 'media.inspect';
