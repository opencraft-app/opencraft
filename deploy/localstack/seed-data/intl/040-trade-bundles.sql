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
    'bundle_launch_01',
    'p_lighthouse',
    'sp_lighthouse_lightvela_bundle_intl',
    1059132,
    JSON_ARRAY(
      JSON_OBJECT('scene', 'purchase', 'category', 2025255),
      JSON_OBJECT('scene', 'renew', 'category', 2025256),
      JSON_OBJECT('scene', 'modify', 'category', 2025257)
    ),
    JSON_OBJECT(
      'sv_lighthouse_lv_bw_intl_launch_mc_01', 1,
      'sv_lighthouse_lv_compute_intl_launch_mc_med4_01', 1,
      'sv_lighthouse_lv_disk_intl_launch_mc_50gb', 1,
      'sv_lighthouse_lv_slot_intl_launch_mc_01', 1
    ),
    JSON_ARRAY(),
    UTC_TIMESTAMP(),
    UTC_TIMESTAMP()
  ),
  (
    'bundle_cruise_01',
    'p_lighthouse',
    'sp_lighthouse_lightvela_bundle_intl',
    1059132,
    JSON_ARRAY(
      JSON_OBJECT('scene', 'purchase', 'category', 2025255),
      JSON_OBJECT('scene', 'renew', 'category', 2025256),
      JSON_OBJECT('scene', 'modify', 'category', 2025257)
    ),
    JSON_OBJECT(
      'sv_lighthouse_lv_bw_intl_cruise_mc_01', 1,
      'sv_lighthouse_lv_compute_intl_cruise_mc_lg8_01', 1,
      'sv_lighthouse_lv_disk_intl_cruise_mc_80gb', 1,
      'sv_lighthouse_lv_slot_intl_cruise_mc_01', 1
    ),
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
