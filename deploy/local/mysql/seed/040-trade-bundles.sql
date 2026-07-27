USE trade;

INSERT INTO trade_bundle_definition (
  bundle_id,
  product_code,
  sub_product_code,
  pid,
  category_ids,
  sv_list,
  product_info,
  created_time,
  updated_time
) VALUES
  (
    'bundle_free_trial_local',
    'p_lighthouse',
    'sp_lighthouse_local_trial',
    1000000,
    JSON_ARRAY(JSON_OBJECT('scene', 'purchase', 'category', 100059)),
    JSON_OBJECT('sv_lighthouse_agent_quota', 1),
    JSON_ARRAY(),
    UTC_TIMESTAMP(),
    UTC_TIMESTAMP()
  ),
  (
    'bundle_general_local',
    'p_lighthouse',
    'sp_lighthouse_local_standard',
    1000001,
    JSON_ARRAY(JSON_OBJECT('scene', 'purchase', 'category', 100059)),
    JSON_OBJECT('sv_lighthouse_agent_quota', 3),
    JSON_ARRAY(),
    UTC_TIMESTAMP(),
    UTC_TIMESTAMP()
  )
ON DUPLICATE KEY UPDATE
  product_code = VALUES(product_code),
  sub_product_code = VALUES(sub_product_code),
  pid = VALUES(pid),
  category_ids = VALUES(category_ids),
  sv_list = VALUES(sv_list),
  product_info = VALUES(product_info),
  updated_time = UTC_TIMESTAMP();
