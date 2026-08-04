-- v2: 更新套餐建站配额
-- 启航(free): 1站点, 10GB流量, 5GB存储, 20MB制品, 500文件
-- 巡游(general): 3站点, 25GB流量, 20GB存储, 50MB制品, 500文件
-- AI套餐(ai): 10站点, 20GB流量, 500MB存储, 50MB制品, 500文件
-- 去掉 daily_deploy_limit（一期不限制日部署次数）

-- 启航(free)套餐
UPDATE `bundle` SET `static_site_quota` = JSON_OBJECT(
    'max_sites', 1,
    'monthly_traffic_bytes', 10737418240,
    'storage_bytes', 5368709120,
    'max_artifact_size', 20971520,
    'max_files', 500
) WHERE `bundle_type` = 'free' AND `static_site_quota` IS NOT NULL;

-- 巡游(general)套餐
UPDATE `bundle` SET `static_site_quota` = JSON_OBJECT(
    'max_sites', 3,
    'monthly_traffic_bytes', 26843545600,
    'storage_bytes', 21474836480,
    'max_artifact_size', 52428800,
    'max_files', 500
) WHERE `bundle_type` = 'general' AND `static_site_quota` IS NOT NULL;

-- AI套餐
UPDATE `bundle` SET `static_site_quota` = JSON_OBJECT(
    'max_sites', 10,
    'monthly_traffic_bytes', 21474836480,
    'storage_bytes', 524288000,
    'max_artifact_size', 52428800,
    'max_files', 500
) WHERE `bundle_type` = 'ai' AND `static_site_quota` IS NOT NULL;
