-- Destructive rollback for a production migration that has not accepted user data.
-- Once websites exist, restore from a database snapshot instead of running this down migration.

DROP TABLE IF EXISTS `website_usage_daily`;
DROP TABLE IF EXISTS `website_operations`;
DROP TABLE IF EXISTS `website_releases`;
DROP TABLE IF EXISTS `website_sites`;
DROP TABLE IF EXISTS `website_custom_domains`;

ALTER TABLE `bundle` DROP COLUMN `static_site_quota`;
