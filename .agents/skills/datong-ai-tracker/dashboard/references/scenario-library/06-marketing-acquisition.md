# 市场投放与增长营销场景

## 1. 场景定义

适用于以渠道、活动、广告、落地页、归因、注册/线索/首购获取为核心的增长营销分析。重点是判断花出去的钱是否带来了高质量转化与后续价值。

## 2. 仓库命中信号

- 归因字段：`utm_source`、`utm_medium`、`utm_campaign`、`channel`、`campaign_id`、`creative_id`
- 落地页：campaign landing、signup landing、promo page
- 行为：点击、到达、注册、激活、留资、首购

## 3. North Star 候选

优先候选：**高质量转化数（激活注册 / 合格线索 / 首购用户）**；备选：CAC / CPL / CPA、ROAS（成本与收入归因齐全时）。

## 4. 默认优先推荐指标（含口径与埋点）

### 4.1 核心结果指标

| 指标 | 类型 | 何时推荐 | 建议口径 | 需要的埋点 / 数据 | 关键属性 / 常见切片 |
|---|---|---|---|---|---|
| 渠道访问量 / 会话数 | 核心结果 | 有来源字段 | 统计周期内按 `channel/campaign` 归因的 session 数 | `session_start` / `landing_page_view` | `utm_*`、`channel`、`campaign_id`、`creative_id` |
| CTR | 核心结果 | 有广告曝光与点击 | `ad_click` 次数 ÷ `ad_impression` 次数 | `ad_impression` + `ad_click` 或广告平台回传 | 平台口径和站内口径需统一 |
| 落地页转化率 | 核心结果 | 落地页是主转化点 | 完成目标动作的去重用户数 ÷ 落地页访客数 | `landing_page_view` + `conversion_event` | 目标动作可为注册、留资、首购 |
| 注册数 / 线索数 / 首购数 | 核心结果 | 有明确主目标 | 统计期内完成目标事件的去重用户数 | `sign_up_success` / `lead_submit` / `purchase_success` | 只选一个主目标作为核心 |
| CAC / CPL / CPA | 核心结果 | 有花费数据 | `spend` ÷ 获客数（客户/线索/行动数） | 广告成本表 + 目标转化事件 | 没有 spend 不要算 |
| 激活率 / 合格率 | 核心结果 | 转化后质量差异大 | 获客用户中在 X 天内激活 / 合格的用户数 ÷ 获客用户数 | `sign_up_success` / `lead_submit` + `activation_event` / `qualified_event` | 适合衡量渠道质量 |
| ROAS | 核心结果 | 有收入归因 | 归因收入 ÷ 广告花费 | 花费表 + 收入表 / `purchase_success` | 需固定归因窗口 |

### 4.2 诊断 / 护栏指标

| 指标 | 类型 | 何时推荐 | 建议口径 | 需要的埋点 / 数据 | 关键属性 / 常见切片 |
|---|---|---|---|---|---|
| 渠道到注册漏斗 | 诊断 | 注册是主目标 | 注册用户数 ÷ 渠道访客数；也可拆点击→落地→注册 | `session_start` / `landing_page_view` + `sign_up_success` | 分母需固定 |
| 渠道到激活漏斗 | 诊断 | 激活才算有效 | 激活用户数 ÷ 注册用户数（按渠道切） | `sign_up_success` + `activation_event` | 可识别“低质注册渠道” |
| 跳出率 | 诊断 | 需要评估落地页质量 | 仅访问 1 页且无 engagement 的 session 数 ÷ 总 session 数 | `session_start` + `page_view` + `engaged_event` | Web 更适用 |
| 创意素材表现 | 诊断 | 创意维度可用 | 各 creative 的点击、转化、CAC / ROAS | `creative_id` + 曝光/点击/转化/花费 | 素材是最小分析单元 |
| 渠道留存率 | 诊断 | 关心长期质量 | 某渠道新增用户中在第 7 / 30 天仍活跃的用户数 ÷ 该渠道新增用户数 | `sign_up_success` + 活跃事件 + 归因字段 | 判断渠道长期价值 |
| 低质线索率 | 护栏 | 线索型业务 | 不合格线索数 ÷ 总线索数 | `lead_submit` + `lead_disqualified` / CRM feedback | 需销售反馈闭环 |

## 5. 不要乱推

- 没有 `utm/channel` 体系，不要主推渠道比较。
- 没有成本表，不要推 CAC / CPL / CPA / ROAS。
- 不能只看注册量，要优先看激活、合格线索、首购等高质量转化。
