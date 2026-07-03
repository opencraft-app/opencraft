# 金融理财与支付场景

## 1. 场景定义

适用于支付、转账、钱包、理财、数字银行、借贷流程的产品。核心目标通常是让用户完成合规开户 / 绑定资金账户，尽快完成首笔资金动作，并长期稳定复用。

## 2. 仓库命中信号

- 实体：`kyc`、`bank_account`、`card`、`wallet`、`deposit`、`withdrawal`、`transfer`、`payment`、`risk`
- 行为：注册、身份认证、绑卡/绑银行、充值、转账、支付、风控审核
- 页面：开户页、身份认证页、绑卡页、支付页、交易记录页

## 3. North Star 候选

优先候选：**月活跃交易用户数**；备选：首笔成功交易用户数、交易总额 / 支付总额。

## 4. 默认优先推荐指标（含口径与埋点）

### 4.1 核心结果指标

| 指标 | 类型 | 何时推荐 | 建议口径 | 需要的埋点 / 数据 | 关键属性 / 常见切片 |
|---|---|---|---|---|---|
| 注册用户数 | 核心结果 | 有注册行为 | 统计周期内完成 `sign_up_success` 的去重用户数 | `sign_up_success` | `user_id`、`channel`、`country`、`device` |
| KYC 完成率 | 核心结果 | 有身份认证流程 | 完成 `kyc_approved` 的去重用户数 ÷ 注册用户数 | `sign_up_success` + `kyc_submitted` / `kyc_approved` | 建议区分提交率与审批通过率 |
| 绑卡 / 绑银行成功率 | 核心结果 | 需要资金账户连接 | 成功完成 `bank_link_success` / `card_link_success` 的用户数 ÷ 发起绑定的用户数 | `bank_link_start` / `card_link_start` + success | 保留失败原因 |
| 首笔成功交易转化率 | 核心结果 | 激活依赖首笔交易 | 发生首笔 `transaction_success` 的用户数 ÷ KYC 完成用户数（或绑定成功用户数，需固定） | `transaction_success` + onboarding 上一步事件 | 分母不要频繁变 |
| 交易总额 / 支付总额 | 核心结果 | 交易规模是经营目标 | 统计周期内成功交易金额求和 | `transaction_success` / 交易流水表 | `transaction_id`、`amount`、`currency`、`payment_method` |
| 成功交易用户数 | 核心结果 | 需要用户级规模 | 统计周期内成功交易的去重用户数 | `transaction_success` | 可区分首笔 / 复用用户 |
| 月活跃交易用户数 | 核心结果 | 看长期复用 | 月内至少成功交易一次的去重用户数 | `transaction_success` | 适合看长期健康 |
| 人均交易频次 | 核心结果 | 价值体现在复用 | 交易总笔数 ÷ 成功交易用户数 | `transaction_success` | 可按支付方式和客群拆分 |

### 4.2 诊断 / 护栏指标

| 指标 | 类型 | 何时推荐 | 建议口径 | 需要的埋点 / 数据 | 关键属性 / 常见切片 |
|---|---|---|---|---|---|
| Onboarding 漏斗转化率 | 诊断 | 开户流程长 | 注册 → KYC → 绑定 → 首笔交易，各步完成用户数 ÷ 上一步完成用户数 | 各步骤事件 | 每步都要保留失败原因 |
| 首笔交易耗时 | 诊断 | 关心激活效率 | 从注册成功到首笔 `transaction_success` 的中位数耗时 | `sign_up_success` + `transaction_success` | 建议看 median + P75 |
| 交易成功率 | 诊断 | 交易体验关键 | `transaction_success` 次数 ÷ (`transaction_success` + `transaction_failed`) 次数 | `transaction_success` + `transaction_failed` | 按支付方式、银行、地区拆分 |
| 交易失败率 | 护栏 | 有失败码体系 | `transaction_failed` 次数 ÷ 发起交易次数 | `transaction_initiated` + `transaction_failed` | 与成功率互补 |
| 退款 / 拒付率 | 护栏 | 支付业务常见 | `refund_success` 或 `chargeback` 金额 ÷ 成功交易金额（或按笔数） | 交易表 + 退款 / 拒付表 | 金额口径更适合支付 |
| 欺诈命中率 | 护栏 | 有风控能力 | 风控命中的交易数 ÷ 总发起交易数 | `risk_blocked` / risk table + `transaction_initiated` | 需区分命中与误杀 |

## 5. 不要乱推

- 没有 KYC / 绑定流程时，不要强推该类 onboarding 漏斗。
- 没有资金动作，不要推交易频次 / 交易总额。
- 不能只看交易额，必须配成功率和失败原因。
