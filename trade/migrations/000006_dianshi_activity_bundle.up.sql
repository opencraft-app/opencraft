-- 000006 dianshi-activity-bundle 数据模型（设计稿 .tmp/dianshi-activity-bundle-design.md §3）
--
-- 1) 新增 trade_bundle_activity：标记哪些 bundle 是点石活动 bundle + 关联点石 activity_id / act_id / secret_key
-- 2) 新增 trade_user_activity_participation：用户已领取活动事实表，由 createResource 路径同事务写入
-- 3) ALTER trade_order：新增 source 列，区分 jifei / dianshi 来源
--
-- 本 migration 不再内置 seed：trade_bundle_activity 的 (bundle_id, activity_id, act_id, secret_key)
-- 映射与点石后台实际注册强耦合，用户不同环境实际值不同，由运营手工 INSERT。
--
-- 跨服务发布纪律：trade 内部 schema 改动，ctl 零改动；按 [memory:nvhrnk4c] dependency_gate
-- 不会被触发，本 commit 与 trade migration 同 service 一并发布。

CREATE TABLE IF NOT EXISTS trade_bundle_activity (
    id            BIGINT       PRIMARY KEY AUTO_INCREMENT,
    bundle_id     VARCHAR(64)  NOT NULL UNIQUE
                  COMMENT '与 trade_bundle_definition.bundle_id 同源（运营约定，跨表无 FK）',
    activity_id   BIGINT       NOT NULL
                  COMMENT '点石活动大 ID（如 164273735574009）',
    act_id        BIGINT       NOT NULL
                  COMMENT '点石商品大 ID（运营从点石后台拿到的 act_id，与 bundle_id 在同一 activity 下一一对应）',
    secret_key    VARCHAR(128) NULL DEFAULT NULL
                  COMMENT '点石活动签名密钥（per-activity 维度）；NULL=未开鉴权，下单 check_sum 留空。同一 activity_id 多行 secret_key 应一致（运营约定）',
    active        TINYINT(1)   NOT NULL DEFAULT 1
                  COMMENT '1=活动生效 / 0=活动下线（运营按需切换）',
    created_time  DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_time  DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    KEY idx_activity (activity_id, active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='bundle ↔ 点石活动映射（trade 内部表，设计稿 §3.1）';

CREATE TABLE IF NOT EXISTS trade_user_activity_participation (
    id               BIGINT       PRIMARY KEY AUTO_INCREMENT,
    uin              VARCHAR(32)  NOT NULL
                     COMMENT '腾讯云 uin（shadow 反查回填后的真实身份键，与 trade_order.uin 同源）',
    app_id           VARCHAR(32)  NOT NULL
                     COMMENT '腾讯云 appId（审计用，非唯一约束键）',
    external_user_id VARCHAR(64)  NOT NULL
                     COMMENT '业务 user_id（ctl 透传的 externalUserId；冗余存储便于排障）',
    activity_id      BIGINT       NOT NULL
                     COMMENT '点石活动大 ID',
    bundle_id        VARCHAR(64)  NOT NULL
                     COMMENT '实际购买的活动 bundle',
    act_id           BIGINT       NOT NULL
                     COMMENT '点石商品大 ID',
    deal_name        VARCHAR(64)  NOT NULL
                     COMMENT '点石返 data.deal_names[0]，与 trade_order.deal_name / ctl.pass.order_id 串联',
    big_deal_no      VARCHAR(64)  NOT NULL
                     COMMENT '点石返 data.big_deal_no（点石内部大单号，排障用）',
    created_time     DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    UNIQUE KEY uk_uin_activity (uin, activity_id)
                     COMMENT '完整性保险：每 uin 每活动至多一条；并发抑制实际由 ctl.pass 唯一键负责，本约束仅在异常重复路径下兜底',
    KEY idx_external_user (external_user_id, activity_id)
                     COMMENT '便于按业务 user_id 排障'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='用户活动领取记录（设计稿 §3.2）';

ALTER TABLE trade_order
    ADD COLUMN source VARCHAR(16) NOT NULL DEFAULT 'jifei'
    COMMENT '订单来源：jifei / dianshi（设计稿 §3.3）';

-- 本 migration 不写 trade_bundle_activity seed：bundle_id / activity_id / act_id / secret_key 的具体值
-- 与点石后台实际注册状态强绑，且不同环境（联调 / 预发布 / 现网）取值不同，
-- 由运营在部署后手工 INSERT（参考列名：bundle_id, activity_id, act_id, secret_key, active）。
