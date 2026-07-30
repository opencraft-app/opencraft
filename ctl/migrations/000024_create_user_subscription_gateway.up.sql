-- 记录用户当前 AI 订阅所在网关。
--
-- 用途：
--   - 新开通订阅写入 llm_gateway；
--   - 存量兼容探测到 ai-gateway 订阅时写入 ai_gateway；
--   - 后续确认没有 gateway='ai_gateway' 的用户后，可下线旧 ai-gateway 服务。
CREATE TABLE IF NOT EXISTS `user_subscription_gateway` (
    `id`              BIGINT       NOT NULL AUTO_INCREMENT,
    `user_id`         VARCHAR(128) NOT NULL                    COMMENT '业务用户 ID',
    `gateway`         VARCHAR(32)  NOT NULL                    COMMENT '订阅所在网关：ai_gateway / llm_gateway',
    `subscription_id` VARCHAR(128) NOT NULL DEFAULT ''         COMMENT '最近观察到的订阅 ID',
    `plan_id`         VARCHAR(128) NOT NULL DEFAULT ''         COMMENT '最近观察到的 Plan ID',
    `source`          VARCHAR(32)  NOT NULL DEFAULT ''         COMMENT '写入来源：apply_subscription / detect_active_subscription / manual',
    `last_observed_at` DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '最近确认该用户订阅归属的时间',
    `created_time`    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_time`    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    UNIQUE KEY `uk_user_subscription_gateway_user_id` (`user_id`),
    KEY `idx_user_subscription_gateway_gateway` (`gateway`),
    KEY `idx_user_subscription_gateway_updated_time` (`updated_time`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
