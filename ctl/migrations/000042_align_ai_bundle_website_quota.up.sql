-- 对齐 AI 套餐的建站配额与巡游(general)一致
-- 决策来源：产品确认「ai 型与巡游一致」
--   3 站点 / 20GB 存储 / 25GB 月流量 / 50MB 制品 / 500 文件
-- 修正000036 中 ai 档的不自洽取值（10 站点却只有 500MB 存储）。
--
-- 仅更新已经开通过建站权益的套餐（static_site_quota IS NOT NULL），
-- 未开通的套餐保持 NULL，避免向未审核的套餐误售。

UPDATE `bundle` SET `static_site_quota` = JSON_OBJECT(
    'max_sites', 3,
    'monthly_traffic_bytes', 26843545600,
    'storage_bytes', 21474836480,
    'max_artifact_size', 52428800,
    'max_files', 500
) WHERE `bundle_type` = 'ai' AND `static_site_quota` IS NOT NULL;
