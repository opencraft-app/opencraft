USE trade;

INSERT INTO trade_bundle_definition (
  bundle_id, product_code, sub_product_code, pid, category_ids,
  sv_list, product_info, created_time, updated_time
) VALUES
  (
    'bundle_launch_01', 'p_lighthouse', 'sp_lighthouse_lightvela_mc', 1059119,
    JSON_ARRAY(
      JSON_OBJECT('scene', 'purchase', 'category', 2025046),
      JSON_OBJECT('scene', 'renew', 'category', 2025047),
      JSON_OBJECT('scene', 'modify', 'category', 2025048)
    ),
    JSON_OBJECT(
      'sv_lighthouse_lv_compute_launch_mc_med4_01', 1,
      'sv_lighthouse_lv_disk_launch_mc_50gb', 1,
      'sv_lighthouse_lv_bw_launch_mc_01', 1,
      'sv_lighthouse_lv_slot_launch_mc_01', 1
    ),
    JSON_ARRAY(), UTC_TIMESTAMP(), UTC_TIMESTAMP()
  ),
  (
    'bundle_cruise_01', 'p_lighthouse', 'sp_lighthouse_lightvela_mc', 1059119,
    JSON_ARRAY(
      JSON_OBJECT('scene', 'purchase', 'category', 2025046),
      JSON_OBJECT('scene', 'renew', 'category', 2025047),
      JSON_OBJECT('scene', 'modify', 'category', 2025048)
    ),
    JSON_OBJECT(
      'sv_lighthouse_lv_compute_cruise_mc_lg8_01', 1,
      'sv_lighthouse_lv_disk_cruise_mc_80gb', 1,
      'sv_lighthouse_lv_bw_cruise_mc_01', 1,
      'sv_lighthouse_lv_slot_cruise_mc_01', 1
    ),
    JSON_ARRAY(), UTC_TIMESTAMP(), UTC_TIMESTAMP()
  ),
  (
    'bundle_launch_ai_01', 'p_lighthouse', 'sp_lighthouse_lightvela_ai_mc', 1060103,
    JSON_ARRAY(
      JSON_OBJECT('scene', 'purchase', 'category', 2025273),
      JSON_OBJECT('scene', 'renew', 'category', 2025274),
      JSON_OBJECT('scene', 'modify', 'category', 2025275)
    ),
    JSON_OBJECT(
      'sv_lighthouse_lv_ai_bw_launch_mc_01', 1,
      'sv_lighthouse_lv_ai_slot_launch_mc_01', 1,
      'sv_lighthouse_lv_ai_credit_launch_mc_01', 1,
      'sv_lighthouse_lv_ai_disk_launch_mc_50gb_01', 1,
      'sv_lighthouse_lv_ai_compute_launch_mc_med4_01', 1
    ),
    JSON_ARRAY(), UTC_TIMESTAMP(), UTC_TIMESTAMP()
  ),
  (
    'bundle_cruise_ai_01', 'p_lighthouse', 'sp_lighthouse_lightvela_ai_mc', 1060103,
    JSON_ARRAY(
      JSON_OBJECT('scene', 'purchase', 'category', 2025273),
      JSON_OBJECT('scene', 'renew', 'category', 2025274),
      JSON_OBJECT('scene', 'modify', 'category', 2025275)
    ),
    JSON_OBJECT(
      'sv_lighthouse_lv_ai_bw_cruise_mc_01', 1,
      'sv_lighthouse_lv_ai_slot_cruise_mc_01', 1,
      'sv_lighthouse_lv_ai_credit_cruise_mc_01', 1,
      'sv_lighthouse_lv_ai_disk_cruise_mc_80gb_01', 1,
      'sv_lighthouse_lv_ai_compute_cruise_mc_lg8_01', 1
    ),
    JSON_ARRAY(), UTC_TIMESTAMP(), UTC_TIMESTAMP()
  )
ON DUPLICATE KEY UPDATE
  product_code=VALUES(product_code), sub_product_code=VALUES(sub_product_code),
  pid=VALUES(pid), category_ids=VALUES(category_ids), sv_list=VALUES(sv_list),
  product_info=VALUES(product_info), updated_time=UTC_TIMESTAMP();
