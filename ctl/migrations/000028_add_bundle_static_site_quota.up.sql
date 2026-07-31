-- 套餐新增静态建站配额字段
-- 存储JSON格式的配额配置，如 {"max_sites":1,"monthly_traffic_bytes":1073741824,...}
-- 默认 NULL = 不包含建站权益
ALTER TABLE `bundle`
    ADD COLUMN `static_site_quota` JSON NULL COMMENT '静态建站配额JSON：{max_sites,monthly_traffic_bytes,storage_bytes,max_artifact_size,max_files,daily_deploy_limit}' AFTER `features`;
