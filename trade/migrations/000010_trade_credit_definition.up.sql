CREATE TABLE IF NOT EXISTS trade_credit_definition (
    id                  BIGINT       PRIMARY KEY AUTO_INCREMENT,
    product_id          VARCHAR(64)  NOT NULL UNIQUE     COMMENT '与 credit.credit_product.product_id 一致（运营约定，跨库无 FK）',
    product_code        VARCHAR(32)  NOT NULL            COMMENT 'jifei 商品编码',
    sub_product_code    VARCHAR(64)  NOT NULL            COMMENT 'jifei 子商品编码',
    pid                 BIGINT       NOT NULL            COMMENT 'jifei 协议层 pid',
    category_ids        JSON         NOT NULL            COMMENT '[{"scene":"purchase","category":<int>},{"scene":"renew","category":<int>}, ...]。category 是 jifei goodsCategoryId int',
    sv_list             JSON         NOT NULL            COMMENT '子产品规格 SV 配置（JSON 对象），key 必须已带 sv_ 前缀，value 是 int；trade 询价/下单时直接透传到 goodsDetail.sv_*',
    product_info        JSON         NOT NULL            COMMENT '商品信息列表（JSON 数组，trade 直接透传到 goodsDetail.productInfo；空数组 [] 合法）',
    created_time        DATETIME     NOT NULL,
    updated_time        DATETIME     NOT NULL,
    KEY idx_sub_product (product_code, sub_product_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='credit product 下单元数据（trade 服务私有表）';
