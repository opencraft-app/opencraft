USE ai_gateway;

INSERT INTO plans (
  id,
  name,
  monthly_tokens,
  rate_limits,
  allowed_models,
  price_cents,
  token_multipliers,
  is_active,
  created_at,
  period_value,
  period_unit
) VALUES
  (
    '00000000-0000-4000-8000-000000000001', -- local paid plan
    'Local Pro',
    1000000,
    JSON_OBJECT(),
    JSON_ARRAY(),
    0,
    JSON_OBJECT(),
    1,
    UTC_TIMESTAMP(3),
    1,
    'months'
  ),
  (
    '535ffe59-ddef-4a15-8033-8de4f7651a00', -- Beijing testing Launch AI plan
    'Launch AI',
    45000000,
    JSON_OBJECT(),
    JSON_ARRAY(),
    0,
    JSON_OBJECT(),
    1,
    UTC_TIMESTAMP(3),
    1,
    'months'
  ),
  (
    '62870d82-9311-4436-86ba-f95866d550e9', -- Beijing testing Cruise AI plan
    'Cruise AI',
    100000000,
    JSON_OBJECT(),
    JSON_ARRAY(),
    0,
    JSON_OBJECT(),
    1,
    UTC_TIMESTAMP(3),
    1,
    'months'
  ),
  (
    '00000000-0000-4000-8000-000000000004', -- International testing Launch AI plan
    'Launch AI',
    1000000,
    JSON_OBJECT(),
    JSON_ARRAY(),
    9900,
    JSON_OBJECT(),
    1,
    UTC_TIMESTAMP(3),
    1,
    'months'
  ),
  (
    '00000000-0000-4000-8000-000000000005', -- International testing Cruise AI plan
    'Cruise AI',
    5000000,
    JSON_OBJECT(),
    JSON_ARRAY(),
    29900,
    JSON_OBJECT(),
    1,
    UTC_TIMESTAMP(3),
    1,
    'months'
  )
ON DUPLICATE KEY UPDATE
  name = VALUES(name),
  monthly_tokens = VALUES(monthly_tokens),
  rate_limits = VALUES(rate_limits),
  allowed_models = VALUES(allowed_models),
  price_cents = VALUES(price_cents),
  token_multipliers = VALUES(token_multipliers),
  is_active = VALUES(is_active),
  period_value = VALUES(period_value),
  period_unit = VALUES(period_unit);
