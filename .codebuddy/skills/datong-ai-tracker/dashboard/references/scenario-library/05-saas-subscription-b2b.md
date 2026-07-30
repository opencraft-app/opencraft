# SaaS 与订阅 / B2B 产品场景

## 1. 场景定义

适用于以订阅收入、组织/团队使用、seat/plan/billing 为核心的 SaaS、B2B 产品、PLG 产品。重点通常是激活、组织采用、续费/扩容、留存和收入质量。

## 2. 仓库命中信号

- 实体：`workspace`、`organization`、`seat`、`plan`、`trial`、`subscription`、`invoice`、`billing`
- 行为：创建空间、邀请成员、连接数据源、升级套餐、续费、取消、支付失败
- 页面：pricing、billing、workspace、member management、integrations

## 3. North Star 候选

优先候选：**每周完成核心工作流的活跃账号数**；备选：活跃付费账号数、NRR（已具备订阅历史时）。

## 4. 默认优先推荐指标（含口径与埋点）

### 4.1 核心结果指标

| 指标 | 类型 | 何时推荐 | 建议口径 | 需要的埋点 / 数据 | 关键属性 / 常见切片 |
|---|---|---|---|---|---|
| MRR | 核心结果 | 有订阅计费 | 所有活跃订阅在统计期末的月度经常性收入之和；年付需折算到月 | 订阅表 / 账单表 / `subscription_active` | `subscription_id`、`account_id`、`plan`、`billing_period` |
| 新增 MRR | 核心结果 | 有新签订阅 | 统计周期内新签订阅带来的新增月度收入 | `subscription_start` / 订阅变更表 | 与 expansion / churn 口径互斥 |
| 扩容 MRR | 核心结果 | 有升级/增购 | 既有订阅因升级套餐或增加 seat 带来的 MRR 增量 | `plan_upgrade` / `seat_increase` / 订阅 delta | 需要订阅变更历史 |
| 流失 MRR | 核心结果 | 有取消/停付 | 因取消订阅导致的 MRR 损失 | `subscription_cancel` / 订阅 delta | 建议与取消率同看 |
| 活跃付费账号数 | 核心结果 | 订阅状态明确 | 统计期末状态为 active 的付费账号数 | 订阅表 / 账单表 | `account_id`、`plan_status` |
| Trial 转付费率 | 核心结果 | 存在试用流程 | 试用账号中在试用结束前或结束后 X 天内转成付费的账号数 ÷ 试用账号数 | `trial_start` + `subscription_start` | 需固定观察窗 |
| Logo Retention | 核心结果 | 有续费历史 | 期初付费账号 cohort 中，期末仍付费的账号数 ÷ 期初付费账号数 | 账号订阅历史 | 适合按月/季看 |
| Revenue Retention / NRR | 核心结果 | 有 MRR 历史 | 期初 cohort 的期末 MRR ÷ 期初 cohort MRR；NRR 含 expansion，GRR 不含 | 订阅历史 + MRR delta | 需明确 NRR 还是 GRR |

### 4.2 诊断 / 护栏指标

| 指标 | 类型 | 何时推荐 | 建议口径 | 需要的埋点 / 数据 | 关键属性 / 常见切片 |
|---|---|---|---|---|---|
| workspace 激活率 | 诊断 | 组织级 onboarding 明显 | 在 X 天内完成核心 setup 并达成首个成果的 workspace 数 ÷ 新建 workspace 数 | `workspace_create` + `setup_complete` + `first_success` | 核心成果需按产品定义 |
| 首次价值达成时间 TTV | 诊断 | onboarding 很关键 | 从注册成功或创建 workspace 到首次 `first_success` 的中位数耗时 | `sign_up_success` / `workspace_create` + `first_success` | 建议看 median + P75 |
| seat 激活率 | 诊断 | 有 seat 模型 | 至少活跃一次的 seat 数 ÷ 已分配 seat 数 | seat 表 + `member_active` / `core_action` | 无 seat 模型不要推 |
| 关键功能采用率 | 诊断 | 多模块产品 | 使用某功能的去重账号数 ÷ 活跃账号数 | `feature_used` + 活跃账号口径 | `feature_name`、`account_id` |
| 失败支付率 | 护栏 | 有自动扣费 | 失败账单数 ÷ 到期应扣费账单数 | 账单表 / `invoice_payment_failed` | 区分临时失败与最终失败 |
| 取消率 | 护栏 | 存在取消动作 | 统计周期内取消的活跃订阅数 ÷ 期初活跃订阅数 | `subscription_cancel` + 期初 active 订阅 | 建议与流失 MRR 配套 |

## 5. 不要乱推

- 没有订阅 / 账单，不要推 MRR / ARR / NRR。
- 没有 workspace / seat 概念，不要硬推 workspace 激活率、seat 激活率。
- 没有收入变更历史时，不要伪造 expansion / contraction / churn MRR。
