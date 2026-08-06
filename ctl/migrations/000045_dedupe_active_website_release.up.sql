-- 保证每个站点只有一个 active 发布版本
--
-- 此前 CompleteOperation 在部署成功时只把新版本置为 active，没有让旧版本退位，
-- 导致同一站点堆积多条 active 记录。影响：
--   1. 「当前版本」失去唯一性，续费恢复依赖排序兜底才能拿对版本
--   2. 发布历史里多个版本都显示为当前版本
--
-- 这里回填历史数据：每个站点保留 version 最大的 active，其余标记为 superseded。

ALTER TABLE `website_releases`
    MODIFY COLUMN `status` VARCHAR(32) NOT NULL DEFAULT 'pending'
        COMMENT 'pending/uploading/deploying/active/superseded/failed/rolled_back';

UPDATE `website_releases` r
JOIN (
    SELECT `site_id`, MAX(`version`) AS max_version
    FROM `website_releases`
    WHERE `status` = 'active'
    GROUP BY `site_id`
) latest
  ON r.`site_id` = latest.`site_id`
SET r.`status` = 'superseded'
WHERE r.`status` = 'active'
  AND r.`version` < latest.max_version;
