-- 新建 history_pass 表（trade-pass-destroy 设计稿 §4.3 落地）
--
-- 拍板依据：.tmp/trade-pass-destroy-design.md §4.3 / §11-A Q6 / §11-F Q24
--
-- 用途：销毁链路终态后保留 pass 历史记录
--   - 销毁主链父 task 收尾步 5b 时，把 pass 表对应行迁移到 history_pass，再 DELETE pass 行
--   - pass 表仅保留 active/isolating/isolated/renewing/deleting/terminating 六态的"在用 pass"
--   - history_pass 表保留所有"已销毁 pass"的最终镜像（含 deleted_time + destroy_reason）
--
-- 字段对偶关系（与 pass 表完全镜像，零类型转换）：
--   - pass_id / user_id / bundle_id / uin / app_id / expired_time / isolated_time
--     / renew_flag / status：完全镜像 pass 表对应列类型，便于 MoveToHistory 直接 INSERT
--   - deleted_time：history 独有，必填，记录 MoveToHistory 调用时刻（销毁完成时刻）
--   - destroy_reason：history 独有，Q24 ✅ 拍板镜像 jifei `para.source` 原值
--     （biz=jifei 控制台 / qn=jifei 定时 / other=其他 / 空串=用户控制台 DeletePass 入口
--     未经 jifei 二次回标的兜底场景）
--
-- 设计稿 §4.3 SQL 与 ctl 仓真实列类型的差异（以 ctl 仓现状为准）：
--   1) uin：设计稿写 VARCHAR(64) → 实际 BIGINT（与 pass 表 / entity.go int64 对齐）
--   2) renew_flag：设计稿写 TINYINT → 实际 VARCHAR(16) DEFAULT 'MANUAL_RENEW'
--      （v4 收敛枚举：MANUAL_RENEW / AUTO_RENEW，与 000018 一致）
--   3) status：设计稿写 VARCHAR(32) → 实际 VARCHAR(16)（与 000019 add_pass_status 一致）
--   4) 时间列：设计稿写 created_at / updated_at → 实际 created_time / updated_time
--      （与 ctl model.BaseEntity / 000014_create_pass.up.sql 一致）
--
-- 索引设计：
--   - uk_history_pass_id (pass_id)：UNIQUE，支撑 MoveToHistory 幂等（同 pass 重复迁移碰冲突视为已迁）
--   - idx_user_id (user_id)：按用户反查历史 pass（管理后台 / 用户中心 ListByUserID）
--   - idx_uin_appid (uin, app_id)：按腾讯云账号反查历史 pass（财务对账 / 数据分析）
--   - idx_deleted_time (deleted_time)：按销毁时刻排序 / 时间窗查询
CREATE TABLE IF NOT EXISTS `history_pass` (
    `id`              BIGINT       NOT NULL AUTO_INCREMENT,
    `pass_id`         VARCHAR(64)  NOT NULL,
    `user_id`         VARCHAR(64)  NOT NULL,
    `bundle_id`       VARCHAR(64)  NOT NULL,
    `uin`             BIGINT       NOT NULL                    COMMENT '腾讯云用户账号（镜像自销毁前的 pass 行）',
    `app_id`          BIGINT       NOT NULL                    COMMENT '腾讯云应用 ID（镜像自销毁前的 pass 行）',
    `expired_time`    DATETIME     NOT NULL                    COMMENT '到期时刻（镜像自销毁前的 pass 行）',
    `isolated_time`   DATETIME     NULL                        COMMENT '隔离时刻（镜像自销毁前的 pass 行；销毁前未隔离则 NULL）',
    `deleted_time`    DATETIME     NOT NULL                    COMMENT '销毁完成时刻（MoveToHistory 调用时刻）',
    `renew_flag`      VARCHAR(16)  NOT NULL DEFAULT 'MANUAL_RENEW' COMMENT '续费标记（镜像自销毁前的 pass 行；MANUAL_RENEW / AUTO_RENEW）',
    `status`          VARCHAR(16)  NOT NULL                    COMMENT '销毁前 pass 的最终 status（active / isolating / isolated / renewing / deleting / terminating）',
    `destroy_reason`  VARCHAR(32)  NOT NULL DEFAULT ''          COMMENT 'Q24 ✅ 拍板：销毁原因，直接镜像 jifei para.source 原值（biz=jifei 控制台 / qn=jifei 定时 / other=其他 / 空串=兜底）',
    `created_time`    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_time`    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    UNIQUE KEY `uk_history_pass_id` (`pass_id`),
    KEY `idx_user_id` (`user_id`),
    KEY `idx_uin_appid` (`uin`, `app_id`),
    KEY `idx_deleted_time` (`deleted_time`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
