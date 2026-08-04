-- 给现有bundle种子数据插入static_site_quota JSON
-- 按bundle_type分类设置配额：
--   free    → 1站点, 1GB/月流量, 50MB存储, 10MB单次制品, 500文件, 5次/日发布
--   general → 3站点, 5GB/月流量, 200MB存储, 20MB单次制品, 500文件, 10次/日发布
--   ai      → 10站点, 20GB/月流量, 500MB存储, 50MB单次制品, 500文件, 20次/日发布
-- 运营可后续通过管理接口调整具体bundle的配额

-- free套餐
UPDATE `bundle` SET `static_site_quota` = JSON_OBJECT(
    'max_sites', 1,
    'monthly_traffic_bytes', 1073741824,
    'storage_bytes', 52428800,
    'max_artifact_size', 10485760,
    'max_files', 500,
    'daily_deploy_limit', 5
) WHERE `bundle_type` = 'free' AND `static_site_quota` IS NULL;

-- general套餐
UPDATE `bundle` SET `static_site_quota` = JSON_OBJECT(
    'max_sites', 3,
    'monthly_traffic_bytes', 5368709120,
    'storage_bytes', 209715200,
    'max_artifact_size', 20971520,
    'max_files', 500,
    'daily_deploy_limit', 10
) WHERE `bundle_type` = 'general' AND `static_site_quota` IS NULL;

-- ai套餐
UPDATE `bundle` SET `static_site_quota` = JSON_OBJECT(
    'max_sites', 10,
    'monthly_traffic_bytes', 21474836480,
    'storage_bytes', 524288000,
    'max_artifact_size', 52428800,
    'max_files', 500,
    'daily_deploy_limit', 20
) WHERE `bundle_type` = 'ai' AND `static_site_quota` IS NULL;
