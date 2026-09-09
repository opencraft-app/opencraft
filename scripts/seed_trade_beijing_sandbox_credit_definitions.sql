-- Run against the beijing-sandbox Trade database after Trade migrations.
INSERT INTO trade_credit_definition (
    product_id,
    product_code,
    sub_product_code,
    pid,
    category_ids,
    sv_list,
    product_info,
    created_time,
    updated_time
) VALUES
    ('credit_1000', 'p_lighthouse', 'sp_lighthouse_lv_credit_pkg', 1060881, '[{"scene":"purchase","category":2025868}]', '{"sv_lighthouse_lv_credit_pkg_1000":1}', '[]', UTC_TIMESTAMP(), UTC_TIMESTAMP()),
    ('credit_2000', 'p_lighthouse', 'sp_lighthouse_lv_credit_pkg', 1060881, '[{"scene":"purchase","category":2025868}]', '{"sv_lighthouse_lv_credit_pkg_2000":1}', '[]', UTC_TIMESTAMP(), UTC_TIMESTAMP()),
    ('credit_4000', 'p_lighthouse', 'sp_lighthouse_lv_credit_pkg', 1060881, '[{"scene":"purchase","category":2025868}]', '{"sv_lighthouse_lv_credit_pkg_4000":1}', '[]', UTC_TIMESTAMP(), UTC_TIMESTAMP()),
    ('credit_8000', 'p_lighthouse', 'sp_lighthouse_lv_credit_pkg', 1060881, '[{"scene":"purchase","category":2025868}]', '{"sv_lighthouse_lv_credit_pkg_8000":1}', '[]', UTC_TIMESTAMP(), UTC_TIMESTAMP()),
    ('credit_12000', 'p_lighthouse', 'sp_lighthouse_lv_credit_pkg', 1060881, '[{"scene":"purchase","category":2025868}]', '{"sv_lighthouse_lv_credit_pkg_12000":1}', '[]', UTC_TIMESTAMP(), UTC_TIMESTAMP())
ON DUPLICATE KEY UPDATE
    product_code = VALUES(product_code),
    sub_product_code = VALUES(sub_product_code),
    pid = VALUES(pid),
    category_ids = VALUES(category_ids),
    sv_list = VALUES(sv_list),
    product_info = VALUES(product_info),
    updated_time = UTC_TIMESTAMP();
