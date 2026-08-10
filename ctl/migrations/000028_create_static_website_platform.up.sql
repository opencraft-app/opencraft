-- One-time production migration for the final COS-backed static website schema.
--
-- Production starts at schema version 27 and has never received the website
-- tables. Test-only intermediate migrations were intentionally squashed into
-- this final state. User quota rows are NOT pre-created here: CTL lazily creates
-- WEBSITE_STATIC_SITE rows when a user first invokes the website capability.

ALTER TABLE `bundle`
    ADD COLUMN `static_site_quota` JSON NULL
        COMMENT 'static website quota template: max_sites, monthly_traffic_bytes, storage_bytes, max_artifact_size, max_files'
        AFTER `features`;

-- Product-owned bundle quota values are intentionally not seeded yet. Before
-- the first production execution, add the final free/general/ai UPDATEs here
-- so schema creation and final quota templates still land in this one migration.
-- Do not reuse the temporary 10 GiB / 25 GiB values from test validation.

CREATE TABLE `website_sites` (
    `id`                   BIGINT       NOT NULL AUTO_INCREMENT,
    `site_id`              VARCHAR(64)  NOT NULL COMMENT 'business site id: ws-xxxxxxxx',
    `user_id`              VARCHAR(64)  NOT NULL,
    `pass_id`              VARCHAR(64)  NOT NULL COMMENT 'pass active when the site was created',
    `bundle_id`            VARCHAR(64)  NOT NULL COMMENT 'bundle active when the site was created',
    `name`                 VARCHAR(128) NOT NULL DEFAULT '' COMMENT 'site name',
    `idempotency_key`      VARCHAR(64)  DEFAULT NULL COMMENT 'unique create key within one user',
    `status`               VARCHAR(32)  NOT NULL DEFAULT 'creating'
        COMMENT 'creating/active/suspended/blocked/deleting/deleted',
    `cloud_path`           VARCHAR(512) NOT NULL DEFAULT '' COMMENT 'COS object prefix',
    `public_url`           VARCHAR(512) NOT NULL DEFAULT '' COMMENT 'public site URL assigned by Vela',
    `operation_generation` BIGINT       NOT NULL DEFAULT 1 COMMENT 'fencing generation for asynchronous operations',
    `storage_bytes`        BIGINT       NOT NULL DEFAULT 0 COMMENT 'current COS bytes under sites/ and _artifacts/',
    `created_time`         DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_time`         DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    `deleted_time`         DATETIME     NULL,
    PRIMARY KEY (`id`),
    UNIQUE KEY `uk_site_id` (`site_id`),
    UNIQUE KEY `uk_user_idempotency` (`user_id`, `idempotency_key`),
    KEY `idx_user_id` (`user_id`),
    KEY `idx_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE `website_releases` (
    `id`            BIGINT        NOT NULL AUTO_INCREMENT,
    `release_id`    VARCHAR(64)   NOT NULL COMMENT 'business release id: wr-xxxxxxxx',
    `site_id`       VARCHAR(64)   NOT NULL,
    `user_id`       VARCHAR(64)   NOT NULL,
    `version`       INT           NOT NULL DEFAULT 1 COMMENT 'monotonic version within one site',
    `status`        VARCHAR(32)   NOT NULL DEFAULT 'pending'
        COMMENT 'pending/uploading/deploying/active/superseded/failed/rolled_back',
    `artifact_hash` VARCHAR(128)  NOT NULL DEFAULT '' COMMENT 'artifact SHA-256',
    `artifact_size` BIGINT        NOT NULL DEFAULT 0 COMMENT 'artifact size in bytes',
    `file_count`    INT           NOT NULL DEFAULT 0,
    `error_message` VARCHAR(1024) NOT NULL DEFAULT '',
    `created_time`  DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_time`  DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    UNIQUE KEY `uk_release_id` (`release_id`),
    UNIQUE KEY `uk_site_version` (`site_id`, `version`),
    KEY `idx_site_id` (`site_id`),
    KEY `idx_user_id` (`user_id`),
    KEY `idx_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE `website_operations` (
    `id`               BIGINT        NOT NULL AUTO_INCREMENT,
    `operation_id`     VARCHAR(64)   NOT NULL COMMENT 'business operation id: wo-xxxxxxxx',
    `site_id`          VARCHAR(64)   NOT NULL,
    `release_id`       VARCHAR(64)   NOT NULL DEFAULT '',
    `user_id`          VARCHAR(64)   NOT NULL,
    `operation_type`   VARCHAR(32)   NOT NULL COMMENT 'create/deploy/delete/suspend/resume',
    `status`           VARCHAR(32)   NOT NULL DEFAULT 'created' COMMENT 'created/running/success/failed/dead',
    `error_message`    VARCHAR(2048) NOT NULL DEFAULT '',
    `lease_token`      VARCHAR(64)   NOT NULL DEFAULT '' COMMENT 'worker ownership token',
    `lease_expires_at` DATETIME      NULL COMMENT 'worker ownership expiration',
    `next_retry_at`    DATETIME      NULL COMMENT 'next eligible durable retry',
    `attempt`          INT           NOT NULL DEFAULT 0 COMMENT 'number of successful claims',
    `site_generation`  BIGINT        NOT NULL DEFAULT 1 COMMENT 'site generation captured when operation was created',
    `created_time`     DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_time`     DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    UNIQUE KEY `uk_operation_id` (`operation_id`),
    KEY `idx_site_id` (`site_id`),
    KEY `idx_user_id` (`user_id`),
    KEY `idx_status` (`status`),
    KEY `idx_status_lease_expires_at` (`status`, `lease_expires_at`),
    KEY `idx_status_next_retry_at` (`status`, `next_retry_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE `website_usage_daily` (
    `id`            BIGINT      NOT NULL AUTO_INCREMENT,
    `site_id`       VARCHAR(64) NOT NULL,
    `user_id`       VARCHAR(64) NOT NULL,
    `usage_date`    DATE        NOT NULL COMMENT 'usage date in product reporting timezone',
    `traffic_bytes` BIGINT      NOT NULL DEFAULT 0 COMMENT 'daily transferred bytes',
    `request_count` BIGINT      NOT NULL DEFAULT 0 COMMENT 'daily request count',
    `created_time`  DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_time`  DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    UNIQUE KEY `uk_site_date` (`site_id`, `usage_date`),
    KEY `idx_user_date` (`user_id`, `usage_date`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
