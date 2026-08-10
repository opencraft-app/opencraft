-- Custom domain binding for static websites.
--
-- Random subdomains (e.g. ws-abc.lightvela.ai) are resolved by string
-- truncation in site-gateway's hostroute — no DB lookup needed. Custom
-- domains (e.g. blog.example.com) cannot be derived from the host string,
-- so a mapping table is required.
--
-- The table maps a globally-unique domain to a site_id. site-gateway
-- queries this table when the root-domain resolver misses; on a hit it
-- reuses the same site status / quota / blockage check path as random
-- subdomains — no special-casing downstream.

CREATE TABLE `website_custom_domains` (
    `id`           BIGINT       NOT NULL AUTO_INCREMENT,
    `domain`       VARCHAR(253) NOT NULL COMMENT 'normalized: lowercase, no trailing dot, no port',
    `site_id`      VARCHAR(64)  NOT NULL COMMENT 'bound site: ws-xxxxxxxx',
    `user_id`      VARCHAR(64)  NOT NULL,
    `created_time` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_time` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    UNIQUE KEY `uk_domain` (`domain`),
    KEY `idx_site_id` (`site_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
