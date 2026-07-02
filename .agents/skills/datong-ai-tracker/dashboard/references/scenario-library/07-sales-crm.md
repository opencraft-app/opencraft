# 销售线索与 CRM 场景

## 1. 场景定义

适用于线索获取、销售跟进、商机推进、合同成交、续约预测等 CRM / 销售运营场景。重点是线索质量、漏斗推进、赢单效率和预测准确度。

## 2. 仓库命中信号

- 实体：`lead`、`contact`、`account`、`opportunity`、`deal`、`pipeline`、`owner`
- 行为：创建线索、分配、触达、demo、转 MQL/SQL、推进阶段、赢单/丢单
- 页面：pipeline board、deal detail、forecast、sales dashboard

## 3. North Star 候选

优先候选：**赢单收入 / 成交金额**；备选：合格 pipeline 金额、赢单数 / 新增成交客户数。

## 4. 默认优先推荐指标（含口径与埋点）

### 4.1 核心结果指标

| 指标 | 类型 | 何时推荐 | 建议口径 | 需要的埋点 / 数据 | 关键属性 / 常见切片 |
|---|---|---|---|---|---|
| 线索数 | 核心结果 | 有 lead 创建 | 统计周期内新建 lead 数 | `lead_created` 或 CRM lead 表 | `lead_id`、`source`、`owner`、`industry` |
| MQL / SQL 数 | 核心结果 | 有资格判定规则 | 统计周期内被标记为 MQL / SQL 的 lead 数 | `lead_status_changed` / lead scoring 表 | 没有评分规则不要推 |
| Pipeline 金额 | 核心结果 | 有商机金额与阶段 | 统计期末 open opportunity / deal 的金额总和 | opportunity / deal 表 + stage 状态 | weighted pipeline 可单列 |
| Win Rate | 核心结果 | 有赢单/丢单状态 | 赢单数 ÷ 已关闭商机数（won + lost） | `deal_closed_won` + `deal_closed_lost` | 不要用赢单 / 全部商机冒充 win rate |
| 成交金额 | 核心结果 | 有合同或赢单金额 | 统计周期内 `deal_closed_won` 金额求和 | `deal_closed_won` / contract 表 | `deal_amount`、`owner`、`product_line` |
| 平均销售周期 | 核心结果 | 有阶段时间戳 | 从 `opportunity_created` 到 `deal_closed_won` 的中位数天数 | opportunity / deal stage history | 建议看 median + P75 |
| 平均客单价 | 核心结果 | 有赢单金额和单量 | 成交金额 ÷ 赢单数 | `deal_closed_won` | 按 owner / 产品线 / 行业切片 |

### 4.2 诊断 / 护栏指标

| 指标 | 类型 | 何时推荐 | 建议口径 | 需要的埋点 / 数据 | 关键属性 / 常见切片 |
|---|---|---|---|---|---|
| 各阶段转化率 | 诊断 | 有标准销售阶段 | 进入下阶段的商机数 ÷ 进入当前阶段的商机数 | `deal_stage_changed` | `stage_id`、`changed_at` |
| Demo 预约率 | 诊断 | demo 是关键动作 | `demo_booked` 线索数 ÷ 合格 lead 数（或线索数，需固定） | `demo_booked` + lead/opportunity 表 | 适合 demo 驱动销售 |
| Demo 到商机转化率 | 诊断 | 预约 demo 后还要筛选 | 生成 opportunity 的 demo 线索数 ÷ demo 预约线索数 | `demo_booked` + `opportunity_created` | 需能关联 lead_id / account_id |
| 首响时长 | 诊断 | 线索响应速度重要 | 从 `lead_created` 到首次销售触达的中位数分钟/小时数 | `lead_created` + `first_sales_touch` | 建议同时做 SLA 命中 |
| 陈旧商机占比 | 护栏 | 销售周期长 | 阶段停留超过阈值的 open 商机数 ÷ open 商机数 | stage aging 数据 / `deal_stage_changed` | 需按 stage 设 aging 阈值 |
| 丢单原因分布 | 护栏 | 要找主要流失原因 | 各类 `lost_reason` 的 lost deal 数 ÷ 总 lost deal 数 | `deal_closed_lost` + `lost_reason` | 适合与 win rate 一起分析 |

## 5. 不要乱推

- 没有标准阶段定义时，不要假装能算可靠的 win rate 和阶段转化率。
- 没有金额字段时，不要硬推 pipeline 金额、客单价。
- 不要把产品活跃指标直接混进销售看板主视图。
