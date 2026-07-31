-- 回滚：清空所有bundle的static_site_quota
UPDATE `bundle` SET `static_site_quota` = NULL WHERE `static_site_quota` IS NOT NULL;
