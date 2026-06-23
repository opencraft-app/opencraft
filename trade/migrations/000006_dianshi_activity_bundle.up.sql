-- 000006 dianshi-activity-bundle 数据模型（设计稿 .tmp/dianshi-activity-bundle-design.md §3）
--
-- 1) 新增 trade_bundle_activity：标记哪些 bundle 是点石活动 bundle + 关联点石 activity_id / act_id / secret_key
-- 2) 新增 trade_user_activity_participation：用户已领取活动事实表，由 createResource 路径同事务写入
-- 3) ALTER trade_order：新增 source 列，区分 jifei / dianshi 来源
-- 4) seed：启航 01 (bundle_launch_01) + 启航 AI 01 (bundle_launch_ai_01) 两条活动映射，
--    activity_id=164273735574009（点石「启航活动」大 ID，由用户在 §11 Q0 给出），
--    secret_key 留 NULL（未开鉴权时下单不带 check_sum；如运营在点石后台开启鉴权，
--    需要 UPDATE 这两行的 secret_key 为对应字符串值）。
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
                  COMMENT '点石商品大 ID（启航01=1862147936410255 / 启航AI01=1862105749386679）',
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

-- seed：bundle_launch_01 + bundle_launch_ai_01 两条活动映射；
-- activity_id 与 act_id 由用户在 §11 Q0 给出。
-- secret_key 当前留 NULL（如点石后台对该 activity_id 开启鉴权，需 UPDATE 此值）。
-- INSERT IGNORE 兜底：若同环境此前已 seed 过，二次 apply 不报错。
INSERT IGNORE INTO trade_bundle_activity (bundle_id, activity_id, act_id, secret_key, active) VALUES
    ('bundle_launch_01',    164273735574009, 1862147936410255, NULL, 1),
    ('bundle_launch_ai_01', 164273735574009, 1862105749386679, NULL, 1);
