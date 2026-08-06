-- 把各套餐的月流量额度抬到实际不可达的量级：1 TiB。
--
-- 背景：这一期第一次真正给 monthly_traffic_bytes 装上执行器——站点网关会在
-- 当月用量超额时对该站点返回 403 且不回源。而计量本身有约 90 秒的收敛延迟
-- （网关每分钟上报 + 站点元信息 30 秒缓存），多副本还各自计数，所以它是
-- 滥用防护的闸，不是精确计量。
--
-- 一期的目标是「有闸但不误伤」：阈值先设成正常用户碰不到的值，先把链路跑熟，
-- 之后再按真实用量分布下调。原值 10 GiB（启航）/ 25 GiB（巡游、AI）对一个
-- 分享给几百人看的静态页面来说是有可能撞到的，撞到就是误伤。
--
-- 这个数字对产品可见（GET /v1/websites/capability 的 monthly_traffic_bytes），
-- 调整前需要产品确认。
--
-- 用 JSON_SET 只改这一个键，不用 JSON_OBJECT 整体重写：000036 / 000042 已经
-- 给不同 bundle_type 定过各自的站点数与存储额度，整体重写会把它们一起抹平。
UPDATE `bundle`
SET `static_site_quota` = JSON_SET(`static_site_quota`, '$.monthly_traffic_bytes', 1099511627776)
WHERE `static_site_quota` IS NOT NULL;
