-- 回滚到 v1 配额值（含 daily_deploy_limit）
UPDATE `bundle` SET `static_site_quota` = JSON_OBJECT(
    'max_sites', 1,
    'monthly_traffic_bytes', 1073741824,
    'storage_bytes', 52428800,
    'max_artifact_size', 10485760,
    'max_files', 500,
    'daily_deploy_limit', 5
) WHERE `bundle_type` = 'free';

UPDATE `bundle` SET `static_site_quota` = JSON_OBJECT(
    'max_sites', 3,
    'monthly_traffic_bytes', 5368709120,
    'storage_bytes', 209715200,
    'max_artifact_size', 20971520,
    'max_files', 500,
    'daily_deploy_limit', 10
) WHERE `bundle_type` = 'general';

UPDATE `bundle` SET `static_site_quota` = JSON_OBJECT(
    'max_sites', 10,
    'monthly_traffic_bytes', 21474836480,
    'storage_bytes', 524288000,
    'max_artifact_size', 52428800,
    'max_files', 500,
    'daily_deploy_limit', 20
) WHERE `bundle_type` = 'ai';
