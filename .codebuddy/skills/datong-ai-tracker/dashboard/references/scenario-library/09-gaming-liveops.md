# 游戏与 LiveOps 场景

## 1. 场景定义

适用于手游、小游戏、在线游戏、F2P 产品、广告 / IAP 混合变现游戏。核心目标通常是获取玩家、留住玩家、推动转化，并维持游戏经济与内容消耗平衡。

## 2. 仓库命中信号

- 实体：`player`、`level`、`mission`、`item`、`currency`、`iap`、`ad`、`event_pass`、`guild`
- 行为：install、session_start、level_start / complete、iap_purchase_success、ad_watch、event_enter
- 页面 / 模块：关卡页、商店、背包、活动页、充值页

## 3. North Star 候选

优先候选：**D7 / D30 retained players**；备选：ARPDAU、周活跃高价值玩家数。

## 4. 默认优先推荐指标（含口径与埋点）

### 4.1 核心结果指标

| 指标 | 类型 | 何时推荐 | 建议口径 | 需要的埋点 / 数据 | 关键属性 / 常见切片 |
|---|---|---|---|---|---|
| DAU / WAU / MAU | 核心结果 | 最基础活跃分析 | 统计窗口内发生 `session_start` 的去重玩家数 | `session_start` | `player_id`、`country`、`platform`、`version` |
| D1 / D7 / D30 留存 | 核心结果 | 有安装或首登 cohort | 安装 / 首登 cohort 中，在第 1 / 7 / 30 天再次 `session_start` 的去重玩家数 ÷ cohort 玩家数 | `install` / `first_open` + `session_start` | cohort 起点要固定 |
| 付费转化率 | 核心结果 | 有 IAP | 至少一次 IAP 的去重玩家数 ÷ 活跃玩家数 | `iap_purchase_success` + `session_start` | 若纯广告变现则不主推 |
| ARPDAU | 核心结果 | 有收入和 DAU | 当日总收入 ÷ 当日 DAU | 收入表 / `iap_purchase_success` / ad revenue + DAU | 要统一收入口径 |
| ARPPU | 核心结果 | 有付费玩家 | 当日总 IAP 收入 ÷ 当日付费玩家数 | `iap_purchase_success` | 适合付费深度分析 |
| LTV（如 D30 LTV） | 核心结果 | 有收入和 cohort 历史 | cohort 在安装后 30 天累计收入 ÷ cohort 安装玩家数 | `install` / `first_open` + 收入数据 | 必须固定观察窗 |
| IAP / 广告收入 | 核心结果 | 有对应变现模型 | 统计周期内 IAP 收入或广告收入总和 | `iap_purchase_success` / ad revenue | 建议区分收入来源 |

### 4.2 诊断 / 护栏指标

| 指标 | 类型 | 何时推荐 | 建议口径 | 需要的埋点 / 数据 | 关键属性 / 常见切片 |
|---|---|---|---|---|---|
| Session 次数 / 时长 | 诊断 | 需要看粘性 | 人均 session 次数；总游戏时长 ÷ 活跃玩家数 | `session_start` + `session_end` | 注意剔除异常驻留 |
| 关卡通过率 | 诊断 | 有关卡流程 | 完成某关卡的玩家数 ÷ 开始该关卡的玩家数 | `level_start` + `level_complete` | `level_id`、尝试次数、失败原因 |
| 新手引导完成率 | 诊断 | 首日流失明显 | 完成 tutorial 最后一步的玩家数 ÷ 开始 tutorial 的玩家数 | `tutorial_step` / `tutorial_complete` | 建议分步记录 |
| 活动参与率 | 诊断 | LiveOps 重要 | 参与活动的去重玩家数 ÷ 活跃玩家数 | `liveops_event_enter` / `event_complete` + DAU | `event_id`、国家、版本 |
| 虚拟货币净变化 | 护栏 | 有经济系统 | `currency_source` 金额 - `currency_sink` 金额 | `currency_source` + `currency_sink` | `currency_type`、`reason` |
| 崩溃率 | 护栏 | 体验质量关键 | 发生 `crash_event` 的去重玩家数 ÷ 活跃玩家数 | `crash_event` + DAU | 建议同时看 crash-free users |

## 5. 不要乱推

- 没有 IAP，不要推 ARPPU。
- 没有收入历史，不要装作已经有 LTV。
- 不要只看 DAU，必须同时看留存与变现。
