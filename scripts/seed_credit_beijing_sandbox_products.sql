-- Run against the beijing-sandbox Credit database after Credit migrations.
INSERT INTO credit_product (
    product_id,
    product_name,
    llm_gateway_plan_id,
    state,
    created_time,
    updated_time
) VALUES
    ('credit_1000', '1000积分', 'plan-B8pecZIB2HMwmmZpfldee8Ice5fCXM0S', 'ONLINE', UTC_TIMESTAMP(), UTC_TIMESTAMP()),
    ('credit_2000', '2000积分', 'plan-iN6wl63Hom2Op6CzN_4a22-xgZitD2Gh', 'ONLINE', UTC_TIMESTAMP(), UTC_TIMESTAMP()),
    ('credit_4000', '4000积分', 'plan-BEaiZmjF6742TpBcrnRpJh0Du5wzEYWN', 'ONLINE', UTC_TIMESTAMP(), UTC_TIMESTAMP()),
    ('credit_8000', '8000积分', 'plan-Brv76Mopp5LI9B6F76lxWKJGuEVTJlL2', 'ONLINE', UTC_TIMESTAMP(), UTC_TIMESTAMP()),
    ('credit_12000', '12000积分', 'plan-Fid0-D4qx9wHyRJImiGzVM2Alhz8adZQ', 'ONLINE', UTC_TIMESTAMP(), UTC_TIMESTAMP())
ON DUPLICATE KEY UPDATE
    product_name = VALUES(product_name),
    llm_gateway_plan_id = VALUES(llm_gateway_plan_id),
    state = VALUES(state),
    updated_time = UTC_TIMESTAMP();
