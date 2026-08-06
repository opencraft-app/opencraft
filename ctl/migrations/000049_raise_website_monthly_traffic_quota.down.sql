-- 回滚到 000036 / 000042 定下的按套餐类型区分的月流量额度。
-- 启航(free) 10 GiB；巡游(general) 与 AI(ai) 均为 25 GiB。

UPDATE `bundle`
SET `static_site_quota` = JSON_SET(`static_site_quota`, '$.monthly_traffic_bytes', 10737418240)
WHERE `static_site_quota` IS NOT NULL AND `bundle_type` = 'free';

UPDATE `bundle`
SET `static_site_quota` = JSON_SET(`static_site_quota`, '$.monthly_traffic_bytes', 26843545600)
WHERE `static_site_quota` IS NOT NULL AND `bundle_type` IN ('general', 'ai');
