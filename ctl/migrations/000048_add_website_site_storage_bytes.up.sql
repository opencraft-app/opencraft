-- 站点当前占用的存储字节数。
--
-- 放在 website_sites 而不是 website_usage_daily：存储用量是「当前状态」而不是
-- 时间序列。在「文件永久保留」的模型下它只在发布成功和删除之后变化，按天存一份
-- 快照既没有额外信息量，也会让「用了多少」需要先确定该看哪一天。
--
-- 由 website-deployer 在每次发布成功 / 删除之后回填：它本来就在列 key，
-- 顺手把 sites/{siteID}/ 与 _artifacts/{siteID}/ 的对象大小加总，成本极低。
ALTER TABLE `website_sites`
    ADD COLUMN `storage_bytes` BIGINT NOT NULL DEFAULT 0
        COMMENT '站点当前占用的 COS 字节数(sites/ + _artifacts/)，由 deployer 在发布/删除后回填';
