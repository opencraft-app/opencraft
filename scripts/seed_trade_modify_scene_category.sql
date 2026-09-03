-- 同 SP 变配（启航 → 巡游 / 启航 AI → 巡游 AI）所需的 trade 侧接入配置。
-- 需求：TAPD 1010132091137784162 §3 / §4.1 / §7.1
--
-- 作用范围：
--   - 只写 trade.trade_bundle_definition.category_ids，补齐 scene='modify' 的 categoryId。
--   - 不动 sv_list / pid / sub_product_code：变配复用与新购、续费同一套 SP/PID/SV，
--     改这些列会让已售出的订单和线上定价对不上。
--   - 不动 ctl.bundle、ai_gateway.plans、pass、quota。
--
-- 为什么必须补这一项：
--   trade 的变配询价/下单在目标套餐上取 scene='modify' 的 categoryId，缺失时 fail-closed
--   （报 category_ids[scene=modify] missing）而不是回落到 purchase 的 categoryId——
--   用错 categoryId 会让计费按新购口径计价，用户付错钱。
--
-- 四个 SP（§3）都要各自配置，不能跨站/跨 SP 复用，也不能按连续编号猜：
--
--   | 站点/类型 | subProductCode                       | PID     |
--   |---|---|---|
--   | 国内通用  | sp_lighthouse_lightvela_mc           | 1059119 |
--   | 国内 AI   | sp_lighthouse_lightvela_ai_mc        | 1060103 |
--   | 国际通用  | sp_lighthouse_lightvela_bundle_intl  | 1059132 |
--   | 国际 AI   | sp_lighthouse_lightvela_ai_intl      | 1060119 |
--
-- 国内、国际是两套独立部署、两个 trade DB。本脚本在**每个站点各跑一次**：
-- 按 sub_product_code 匹配，跑在哪个库就只会命中该库里存在的那两个 SP。
--
-- 用法：
--   1. 从计费接入单（https://xy.tcb.woa.com/xy/app/prod/access/accesslist）取到该 SP 的
--      Modify CategoryID，填进下面对应的 SET。
--   2. 未拿到值的 SP 保持 NULL —— 对应 UPDATE 会整条跳过，不会写入猜测值。
--   3. 跑完看末尾 SELECT，确认目标套餐已有 modify scene。
--   4. `seed_status` 必须是 READY；`modify_scene_count` 必须全部为 1。
--
-- 精确回滚：仅在本脚本原先没有 modify scene、且需要撤销本次 seed 时执行
-- `scripts/rollback_trade_modify_scene_category.sql`。回滚脚本只删除 scene/category
-- 同时匹配的单条记录；遇到重复 scene 会拒绝自动删除并留给人工核对。
--
-- 取值来源（2026-09-02 在计费接入平台逐单实测回读，非推算）：
-- 变配 categoryId 由接入单「新增计费能力 → 变配」变更单提交测试环境后由平台自动生成，
-- 在该变更单的「联调测试信息表 → category id」列读出。四个 SP 对应的变更单编号：
--
--   | 站点/类型 | 接入单 | 变更单编号            | 新购    | 续费    | 变配    |
--   |---|---|---|---|---|---|
--   | 国内通用  | 23472 | 2095070107168092162 | 2025046 | 2025047 | 2025048 |
--   | 国内 AI   | 23585 | 2095076030343729153 | 2025273 | 2025274 | 2025275 |
--   | 国际通用  | 23563 | 2095076989500862466 | 2025255 | 2025256 | 2025257 |
--   | 国际 AI   | 23584 | 2095077899558703106 | 2025270 | 2025271 | 2025272 |
--
-- 四个值恰好都等于该 SP 的「续费 + 1」，但这只是平台按接入单内部顺序发号的结果，
-- 不是可依赖的规律：新增 SP 时仍必须回读接入单，不得按编号推算。
--
-- 注意：以上变更单目前只发布到**测试/预发环境**，现网尚未发布（平台「将变更发布至现网」
-- 步骤未执行，且预付费规则需过财管审批）。故本脚本当前只可用于测试环境；
-- 现网执行前需确认对应变更单已发布至现网。

-- ---------------------------------------------------------------------------
-- 各 SP 的 Modify CategoryID（均已从接入单回读确认）。NULL = 尚未从接入单确认。
-- ---------------------------------------------------------------------------
SET @modify_category_cn_general = 2025048;
SET @modify_category_cn_ai      = 2025275;
SET @modify_category_intl_general = 2025257;
SET @modify_category_intl_ai      = 2025272;

-- purchase / renew 的既有 categoryId 保持原样，只追加 modify 一项。
-- 这里用 JSON_ARRAY_APPEND 而不是整列重写：重写需要把 purchase/renew 的值也抄一遍，
-- 抄错就会把新购和续费一起打坏，而那两条链路是现网在跑的。

START TRANSACTION;

-- 国内通用：启航 / 巡游 / 远航。
-- 源套餐也要补：询价与下单只读目标套餐的 categoryId，但 checkModify 回调会拿源套餐
-- 对账 pid 与 SP，保持三个 scene 齐全可以避免后续加降配时再改一遍运营数据。
UPDATE trade_bundle_definition
SET category_ids = JSON_ARRAY_APPEND(
        category_ids, '$',
        JSON_OBJECT('scene', 'modify', 'category', @modify_category_cn_general)
    ),
    updated_time = NOW()
WHERE @modify_category_cn_general IS NOT NULL
  AND sub_product_code = 'sp_lighthouse_lightvela_mc'
  AND bundle_id IN ('bundle_launch_01', 'bundle_cruise_01', 'bundle_voyage_01')
  -- 幂等：已经有 modify 的行不再追加，否则重复执行会堆出多条同 scene 记录，
  -- 而读取侧取第一条命中——等于把 categoryId 的取值变成插入顺序的函数。
  AND JSON_SEARCH(category_ids, 'one', 'modify', NULL, '$[*].scene') IS NULL;

-- 国内 AI：启航 AI / 巡游 AI / 远航 AI。
UPDATE trade_bundle_definition
SET category_ids = JSON_ARRAY_APPEND(
        category_ids, '$',
        JSON_OBJECT('scene', 'modify', 'category', @modify_category_cn_ai)
    ),
    updated_time = NOW()
WHERE @modify_category_cn_ai IS NOT NULL
  AND sub_product_code = 'sp_lighthouse_lightvela_ai_mc'
  AND bundle_id IN ('bundle_launch_ai_01', 'bundle_cruise_ai_01', 'bundle_voyage_ai_01')
  AND JSON_SEARCH(category_ids, 'one', 'modify', NULL, '$[*].scene') IS NULL;

-- 国际通用：bundle_id 与国内相同，SP / PID / CategoryID / SV 各站独立（§3）。
UPDATE trade_bundle_definition
SET category_ids = JSON_ARRAY_APPEND(
        category_ids, '$',
        JSON_OBJECT('scene', 'modify', 'category', @modify_category_intl_general)
    ),
    updated_time = NOW()
WHERE @modify_category_intl_general IS NOT NULL
  AND sub_product_code = 'sp_lighthouse_lightvela_bundle_intl'
  AND bundle_id IN ('bundle_launch_01', 'bundle_cruise_01', 'bundle_voyage_01')
  AND JSON_SEARCH(category_ids, 'one', 'modify', NULL, '$[*].scene') IS NULL;

-- 国际 AI。
UPDATE trade_bundle_definition
SET category_ids = JSON_ARRAY_APPEND(
        category_ids, '$',
        JSON_OBJECT('scene', 'modify', 'category', @modify_category_intl_ai)
    ),
    updated_time = NOW()
WHERE @modify_category_intl_ai IS NOT NULL
  AND sub_product_code = 'sp_lighthouse_lightvela_ai_intl'
  AND bundle_id IN ('bundle_launch_ai_01', 'bundle_cruise_ai_01', 'bundle_voyage_ai_01')
  AND JSON_SEARCH(category_ids, 'one', 'modify', NULL, '$[*].scene') IS NULL;

COMMIT;

-- 核对：每个套餐现在有哪些 scene。
-- 目标套餐（bundle_cruise_01 / bundle_cruise_ai_01）缺 modify 的那一行，就是变配在
-- 该 SP 上 fail-closed 的原因；拿到接入单的值后回到顶部 SET 再跑一次。
SELECT
    bundle_id,
    sub_product_code,
    pid,
    JSON_EXTRACT(category_ids, '$[*].scene')    AS scenes,
    JSON_EXTRACT(category_ids, '$[*].category') AS categories,
    CASE
      WHEN JSON_SEARCH(category_ids, 'all', 'modify', NULL, '$[*].scene') IS NULL THEN 0
      ELSE JSON_LENGTH(JSON_SEARCH(category_ids, 'all', 'modify', NULL, '$[*].scene'))
    END AS modify_scene_count
FROM trade_bundle_definition
WHERE bundle_id IN (
    'bundle_launch_01',
    'bundle_cruise_01',
    'bundle_voyage_01',
    'bundle_launch_ai_01',
    'bundle_cruise_ai_01',
    'bundle_voyage_ai_01'
)
ORDER BY sub_product_code, bundle_id;

-- 门禁汇总：目标 SP 在当前站点不存在时为 NOT_PRESENT_IN_THIS_SITE；一旦存在，
-- 必须恰好 3 个套餐、3 个精确 CategoryID、且每行只有一个 modify scene。
WITH expected AS (
    SELECT 'sp_lighthouse_lightvela_mc' AS sub_product_code, @modify_category_cn_general AS category
    UNION ALL SELECT 'sp_lighthouse_lightvela_ai_mc', @modify_category_cn_ai
    UNION ALL SELECT 'sp_lighthouse_lightvela_bundle_intl', @modify_category_intl_general
    UNION ALL SELECT 'sp_lighthouse_lightvela_ai_intl', @modify_category_intl_ai
), actual AS (
    SELECT
        e.sub_product_code,
        e.category,
        COUNT(d.bundle_id) AS matched_rows,
        COALESCE(SUM(JSON_CONTAINS(
            d.category_ids,
            JSON_OBJECT('scene', 'modify', 'category', e.category)
        )), 0) AS exact_modify_rows,
        COALESCE(SUM(CASE
            WHEN JSON_TYPE(JSON_SEARCH(d.category_ids, 'all', 'modify', NULL, '$[*].scene')) = 'ARRAY'
            THEN 1 ELSE 0 END), 0) AS duplicate_modify_rows
    FROM expected e
    LEFT JOIN trade_bundle_definition d
      ON d.sub_product_code = e.sub_product_code
     AND d.bundle_id IN (
        'bundle_launch_01', 'bundle_cruise_01', 'bundle_voyage_01',
        'bundle_launch_ai_01', 'bundle_cruise_ai_01', 'bundle_voyage_ai_01'
     )
    GROUP BY e.sub_product_code, e.category
)
SELECT
    sub_product_code,
    category AS expected_modify_category,
    matched_rows,
    exact_modify_rows,
    duplicate_modify_rows,
    CASE
      WHEN matched_rows = 0 THEN 'NOT_PRESENT_IN_THIS_SITE'
      WHEN matched_rows = 3 AND exact_modify_rows = 3 AND duplicate_modify_rows = 0 THEN 'READY'
      ELSE 'ERROR_CHECK_ROWS_OR_DUPLICATES'
    END AS seed_status
FROM actual
ORDER BY sub_product_code;
