-- 回滚到 000036 中的 ai 档取值
UPDATE `bundle` SET `static_site_quota` = JSON_OBJECT(
    'max_sites', 10,
    'monthly_traffic_bytes', 21474836480,
    'storage_bytes', 524288000,
    'max_artifact_size', 52428800,
    'max_files', 500
) WHERE `bundle_type` = 'ai' AND `static_site_quota` IS NOT NULL;
