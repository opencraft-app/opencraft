-- 精确撤销 scripts/seed_trade_modify_scene_category.sql 追加的 Modify CategoryID。
-- 仅用于测试环境，且只适用于执行 seed 前对应行没有 scene='modify' 的情况。
-- 若同一行已有多个 modify scene，本脚本拒绝自动删除，避免误删历史运营数据。

SET @modify_category_cn_general = 2025048;
SET @modify_category_cn_ai = 2025275;
SET @modify_category_intl_general = 2025257;
SET @modify_category_intl_ai = 2025272;

START TRANSACTION;

UPDATE trade_bundle_definition
SET category_ids = JSON_REMOVE(
        category_ids,
        REPLACE(
          JSON_UNQUOTE(JSON_SEARCH(category_ids, 'one', 'modify', NULL, '$[*].scene')),
          '.scene',
          ''
        )
    ),
    updated_time = NOW()
WHERE sub_product_code = 'sp_lighthouse_lightvela_mc'
  AND bundle_id IN ('bundle_launch_01', 'bundle_cruise_01', 'bundle_voyage_01')
  AND JSON_TYPE(JSON_SEARCH(category_ids, 'all', 'modify', NULL, '$[*].scene')) = 'STRING'
  AND JSON_CONTAINS(category_ids, JSON_OBJECT(
        'scene', 'modify', 'category', @modify_category_cn_general
      ));

UPDATE trade_bundle_definition
SET category_ids = JSON_REMOVE(
        category_ids,
        REPLACE(
          JSON_UNQUOTE(JSON_SEARCH(category_ids, 'one', 'modify', NULL, '$[*].scene')),
          '.scene',
          ''
        )
    ),
    updated_time = NOW()
WHERE sub_product_code = 'sp_lighthouse_lightvela_ai_mc'
  AND bundle_id IN ('bundle_launch_ai_01', 'bundle_cruise_ai_01', 'bundle_voyage_ai_01')
  AND JSON_TYPE(JSON_SEARCH(category_ids, 'all', 'modify', NULL, '$[*].scene')) = 'STRING'
  AND JSON_CONTAINS(category_ids, JSON_OBJECT(
        'scene', 'modify', 'category', @modify_category_cn_ai
      ));

UPDATE trade_bundle_definition
SET category_ids = JSON_REMOVE(
        category_ids,
        REPLACE(
          JSON_UNQUOTE(JSON_SEARCH(category_ids, 'one', 'modify', NULL, '$[*].scene')),
          '.scene',
          ''
        )
    ),
    updated_time = NOW()
WHERE sub_product_code = 'sp_lighthouse_lightvela_bundle_intl'
  AND bundle_id IN ('bundle_launch_01', 'bundle_cruise_01', 'bundle_voyage_01')
  AND JSON_TYPE(JSON_SEARCH(category_ids, 'all', 'modify', NULL, '$[*].scene')) = 'STRING'
  AND JSON_CONTAINS(category_ids, JSON_OBJECT(
        'scene', 'modify', 'category', @modify_category_intl_general
      ));

UPDATE trade_bundle_definition
SET category_ids = JSON_REMOVE(
        category_ids,
        REPLACE(
          JSON_UNQUOTE(JSON_SEARCH(category_ids, 'one', 'modify', NULL, '$[*].scene')),
          '.scene',
          ''
        )
    ),
    updated_time = NOW()
WHERE sub_product_code = 'sp_lighthouse_lightvela_ai_intl'
  AND bundle_id IN ('bundle_launch_ai_01', 'bundle_cruise_ai_01', 'bundle_voyage_ai_01')
  AND JSON_TYPE(JSON_SEARCH(category_ids, 'all', 'modify', NULL, '$[*].scene')) = 'STRING'
  AND JSON_CONTAINS(category_ids, JSON_OBJECT(
        'scene', 'modify', 'category', @modify_category_intl_ai
      ));

COMMIT;

-- 期望：本次 seed 对应的 exact_modify_rows 全部为 0。若仍非 0，通常是该行
-- 存在重复 modify scene，脚本已安全跳过，需要先人工核对 JSON 后再处理。
WITH expected AS (
    SELECT 'sp_lighthouse_lightvela_mc' AS sub_product_code, @modify_category_cn_general AS category
    UNION ALL SELECT 'sp_lighthouse_lightvela_ai_mc', @modify_category_cn_ai
    UNION ALL SELECT 'sp_lighthouse_lightvela_bundle_intl', @modify_category_intl_general
    UNION ALL SELECT 'sp_lighthouse_lightvela_ai_intl', @modify_category_intl_ai
)
SELECT
    e.sub_product_code,
    COALESCE(SUM(JSON_CONTAINS(
      d.category_ids,
      JSON_OBJECT('scene', 'modify', 'category', e.category)
    )), 0) AS exact_modify_rows
FROM expected e
LEFT JOIN trade_bundle_definition d
  ON d.sub_product_code = e.sub_product_code
GROUP BY e.sub_product_code
ORDER BY e.sub_product_code;
