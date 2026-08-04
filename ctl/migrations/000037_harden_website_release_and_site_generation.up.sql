ALTER TABLE `website_sites`
    ADD COLUMN `operation_generation` BIGINT NOT NULL DEFAULT 1 COMMENT 'fencing generation for asynchronous website operations';

ALTER TABLE `website_releases`
    ADD UNIQUE KEY `uk_site_version` (`site_id`, `version`);
