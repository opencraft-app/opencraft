ALTER TABLE `website_releases`
    DROP INDEX `uk_site_version`;

ALTER TABLE `website_sites`
    DROP COLUMN `operation_generation`;
