-- 合并同一用户重复的建站配额行
--
-- 旧版 ensureQuotaInitialized 用 (user_id, resource_name, bundle_id) 查询既有配额行。
-- resource_key 里存的是初始化时的 bundle_id，用户换套餐后当前 bundle_id 与之不一致，
-- 于是查询必然落空、走到「首次初始化」分支再插一行：
-- 用户每换一次套餐就会多一行 WEBSITE_STATIC_SITE 配额。
--
-- 多行会让席位统计和归还失真（按 user_id + resource_name 归还时一次归还多个席位）。
-- 代码已改为按 (user_id, resource_name) 定位既有行并改写 resource_key，
-- 这里清理历史遗留：每个用户只保留 id 最小的一行。
--
-- 保留行的额度按「该用户当前实际占用的站点数」重算，避免直接沿用某一行的脏值。
--
-- 两表的 user_id 排序规则不一致，直接 JOIN 会报 ERROR 1267：
--   000003 建 user_resource_quota 时显式 pin 了 utf8mb4_unicode_ci；
--   000029 建 website_sites 时只写了 DEFAULT CHARSET=utf8mb4、没写 COLLATE，
--   因此它跟随所在库的默认排序规则，逐环境可能不同（北京实测为 utf8mb4_0900_ai_ci）。
-- 故在关联条件上显式指定 COLLATE，使本迁移不依赖目标库的默认排序规则。

UPDATE `user_resource_quota` q
JOIN (
    SELECT
        MIN(`id`) AS keep_id,
        `user_id`,
        MAX(`resource_quota_total`) AS total
    FROM `user_resource_quota`
    WHERE `resource_name` = 'WEBSITE_STATIC_SITE'
    GROUP BY `user_id`
    HAVING COUNT(*) > 1
) dup ON q.`id` = dup.keep_id
LEFT JOIN (
    SELECT `user_id`, COUNT(*) AS used
    FROM `website_sites`
    WHERE `deleted_time` IS NULL
      AND `status` IN ('creating', 'active', 'suspended', 'deleting')
    GROUP BY `user_id`
) u ON u.`user_id` COLLATE utf8mb4_unicode_ci = q.`user_id`
SET q.`resource_quota_total` = dup.total,
    q.`resource_quota_available` = GREATEST(dup.total - COALESCE(u.used, 0), 0);

DELETE q FROM `user_resource_quota` q
JOIN (
    SELECT MIN(`id`) AS keep_id, `user_id`
    FROM `user_resource_quota`
    WHERE `resource_name` = 'WEBSITE_STATIC_SITE'
    GROUP BY `user_id`
) keep ON keep.`user_id` = q.`user_id`
WHERE q.`resource_name` = 'WEBSITE_STATIC_SITE'
  AND q.`id` <> keep.keep_id;
