-- trade 服务初始化迁移：建立 jifei 协议层流水三张表。
-- 表结构来源：/root/project/mono/.tmp/trade-purchase-flow-design.md
--   - §7.3.4 trade_order            jifei 协议层订单流水（状态机 + 反向回填 resource_id）
--   - §7.3.5 trade_flow             jifei 协议长事务流水（Q61 抢占式幂等 + Q62 仅 create_resource 一类 flow_type）
--   - §7.3.6 trade_bundle_definition bundle 下单元数据（Q25 拍板，与 ctl bundle 通过 bundle_id 弱关联）
--
-- 设计稿拍板锚点：
--   - Q41 / Q42 / Q43 / Q44 / Q45 / Q46 / Q47 / Q48 / Q49 / Q50：trade_order 字段裁剪原则
--   - Q49 / Q62                     ：trade_flow.flow_type 收敛为仅 create_resource 一类
--   - Q61                           ：trade_flow.status 三态状态机 + idx_status_created_time reconcile 索引
--   - Q40                           ：trade_bundle_definition.category_ids 多场景 JSON 数组

-- ----------------------------------------------------------------------------
-- 1. trade_order：jifei 协议层订单流水
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS trade_order (
    id               BIGINT       PRIMARY KEY AUTO_INCREMENT,
    big_order_id     VARCHAR(64)  NOT NULL                COMMENT 'jifei 大订单号；常态与 deal_name 1:1，未来批量下单 1:N',
    deal_name        VARCHAR(64)  NOT NULL UNIQUE         COMMENT 'jifei 子订单号',
    external_user_id VARCHAR(64)  NOT NULL                COMMENT 'lightclaw 用户 ID',
    uin              VARCHAR(32)  NOT NULL                COMMENT 'shadow binding.uin',
    app_id           VARCHAR(32)  NOT NULL                COMMENT 'shadow binding.app_id',
    sub_product_code VARCHAR(64)  NOT NULL                COMMENT 'jifei 子商品编码（来源 trade_bundle_definition.sub_product_code，下单时反查写入）',
    bundle_id        VARCHAR(64)  NOT NULL                COMMENT '与 ctl bundle 表 bundle_id 一致',
    period           INT          NOT NULL                COMMENT '购买时长数值（与 jifei goodsDetail.timeSpan 一一对应；Q37/Q45）',
    time_unit        VARCHAR(8)   NOT NULL                COMMENT '购买时长单位 m/y（与 jifei goodsDetail.timeUnit 对应；Q37/Q45）',
    goods_num        INT          NOT NULL DEFAULT 1      COMMENT 'Q41：本期 Lighthouse 始终 = 1，DEFAULT 兜底批量扩展',
    region_id        INT          NOT NULL                COMMENT 'Q41：jifei regionId；变更地域改 trade 配置即可',
    pay_mode         TINYINT      NOT NULL DEFAULT 1      COMMENT 'Q42：jifei payMode（0 后付 / 1 预付 / 2 RI），本期固定 1',
    goods_detail     JSON         DEFAULT NULL            COMMENT 'jifei goodsDetail 透传快照（不做字段级别索引）',
    pay_url          VARCHAR(512) DEFAULT NULL            COMMENT 'jifei 生成的支付页 url',
    status           VARCHAR(32)  NOT NULL                COMMENT '状态机：created / pending_pay / paid_pending_provision / provisioned / payment_failed / provision_failed',
    resource_type    VARCHAR(16)  NOT NULL DEFAULT 'pass' COMMENT '资源类型：本期恒为 pass；预留扩展',
    resource_id      VARCHAR(64)  DEFAULT NULL            COMMENT 'createResource 完成后由 ctl 反向回填的资源 ID（resource_type=pass 时即 pass_id）',
    expire_time      DATETIME     NOT NULL                COMMENT '支付订单失效时间',
    created_time     DATETIME     NOT NULL,
    updated_time     DATETIME     NOT NULL,
    KEY idx_user (external_user_id, status),
    KEY idx_status_expire (status, expire_time),
    KEY idx_resource (resource_type, resource_id),
    KEY idx_big_order (big_order_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='jifei 协议层订单流水（trade 服务私有表）';

-- ----------------------------------------------------------------------------
-- 2. trade_flow：jifei 协议长事务流水（Q61 抢占式幂等 + Q62 仅 create_resource）
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS trade_flow (
    id            BIGINT       NOT NULL AUTO_INCREMENT PRIMARY KEY,
    deal_name     VARCHAR(64)  NOT NULL                COMMENT 'jifei dealName（Q56 反查兜底键）',
    flow_type     VARCHAR(32)  NOT NULL                COMMENT 'Q62 收敛：本期仅 create_resource 一类（check_create 不写本表）',
    app_id        VARCHAR(32)  NOT NULL                COMMENT 'jifei 多租户隔离键',
    status        VARCHAR(16)  NOT NULL DEFAULT 'in_progress' COMMENT 'Q61 状态机：in_progress=占位中 / completed=链路成功 / failed=链路永久失败（Q56 A 类退款）',
    request_body  JSON         DEFAULT NULL            COMMENT 'jifei 回调原始请求 PDF framework 双层 JSON',
    response_body JSON         DEFAULT NULL            COMMENT 'completed 时存出参；failed 时存退款响应（returnCode=352014）；in_progress 时为 NULL',
    created_time  DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_time  DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    UNIQUE KEY uk_deal_flow_app (deal_name, flow_type, app_id) COMMENT 'Q61 抢占式幂等核心约束',
    KEY idx_status_created_time (status, created_time)         COMMENT 'Q61 reconcile 扫描索引（status=in_progress AND created_time < NOW()-30min）'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='jifei 协议长事务流水（trade 服务私有表）';

-- ----------------------------------------------------------------------------
-- 3. trade_bundle_definition：bundle 下单元数据（Q25 拍板）
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS trade_bundle_definition (
    id                  BIGINT       PRIMARY KEY AUTO_INCREMENT,
    bundle_id           VARCHAR(64)  NOT NULL UNIQUE     COMMENT '与 ctl bundle 表 bundle_id 一致（运营约定，跨库无 FK）',
    product_code        VARCHAR(32)  NOT NULL            COMMENT 'jifei 商品编码，如 p_lighthouse',
    sub_product_code    VARCHAR(64)  NOT NULL            COMMENT 'jifei 子商品编码',
    pid                 VARCHAR(32)  NOT NULL            COMMENT 'jifei 协议层 pid',
    category_ids        JSON         NOT NULL            COMMENT 'Q40：[{"scene":"purchase","category":"..."},{"scene":"renew","category":"..."}]，本期至少含 purchase',
    sv_list             JSON         NOT NULL            COMMENT '子产品规格 SV 配置（JSON 对象，运营录入 key 不带 sv_ 前缀；trade 询价/下单时展平为 goodsDetail.sv_*；空对象 {} 合法）',
    product_info        JSON         NOT NULL            COMMENT '商品信息列表（JSON 数组，trade 直接透传到 goodsDetail.productInfo）',
    created_time        DATETIME     NOT NULL,
    updated_time        DATETIME     NOT NULL,
    KEY idx_sub_product (sub_product_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='bundle 下单元数据（trade 服务私有表，Q25 拍板）';
