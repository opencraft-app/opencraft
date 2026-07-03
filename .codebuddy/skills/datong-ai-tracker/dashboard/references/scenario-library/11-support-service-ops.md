# 客服与服务运营场景

## 1. 场景定义

适用于客服中心、工单系统、售后服务、支持团队运营。关注点通常是响应够不够快、问题是否真正解决、积压是否健康、客户是否满意。

## 2. 仓库命中信号

- 实体：`ticket`、`case`、`conversation`、`agent`、`queue`、`sla`
- 行为：创建工单、首次回复、转派、解决、重开、关闭、满意度评价
- 页面：工单列表、SLA 面板、客服绩效页、知识库页

## 3. North Star 候选

优先候选：**SLA 内解决率**；备选：已解决工单数、CSAT（有满意度反馈时）。

## 4. 默认优先推荐指标（含口径与埋点）

### 4.1 核心结果指标

| 指标 | 类型 | 何时推荐 | 建议口径 | 需要的埋点 / 数据 | 关键属性 / 常见切片 |
|---|---|---|---|---|---|
| 工单量 / 会话量 | 核心结果 | 最基础服务规模 | 统计周期内新建工单或新建会话数 | `ticket_created` / 工单表 | `ticket_id`、`channel`、`priority`、`category`、`queue` |
| 首响时长 FRT | 核心结果 | 有首次回复时间 | 从 `ticket_created` 到 `first_reply_sent` 的中位数分钟数 | `ticket_created` + `first_reply_sent` | 建议同时看 median + P90 |
| 解决时长 | 核心结果 | 有 resolved 状态 | 从 `ticket_created` 到 `ticket_resolved` 的中位数小时数 | `ticket_created` + `ticket_resolved` | 按优先级 / 队列切分 |
| Backlog / 未解决工单数 | 核心结果 | 关注积压 | 统计期末 `status in (open,pending)` 的工单数 | 工单表状态快照 | 适合按队列 / 优先级看 |
| SLA 达成率 | 核心结果 | 有 SLA 规则 | 在 SLA 响应 / 解决时限内完成的工单数 ÷ 有 SLA 约束的工单数 | SLA 表 + `first_reply_sent` / `ticket_resolved` | 区分响应 SLA 和解决 SLA |
| CSAT | 核心结果 | 已有满意度调查 | 正向评价数 ÷ 有效评价数，或平均满意度分数 | `csat_submitted` / survey 表 | 先固定“正向”阈值 |
| 重开率 | 核心结果 | 关心一次解决质量 | `ticket_reopened` 工单数 ÷ 已解决工单数 | `ticket_reopened` + `ticket_resolved` | 反映闭环质量 |

### 4.2 诊断 / 护栏指标

| 指标 | 类型 | 何时推荐 | 建议口径 | 需要的埋点 / 数据 | 关键属性 / 常见切片 |
|---|---|---|---|---|---|
| 联系原因分布 | 诊断 | 要找热点问题 | 某问题类型工单数 ÷ 总工单数 | 工单分类字段 | `category` / `reason_code` |
| 渠道占比 | 诊断 | 多渠道服务 | 某渠道工单数 ÷ 总工单数 | 工单表 / `channel` | email / chat / phone / web |
| Agent 处理效率 | 诊断 | 有人效分析需求 | 已解决工单数 ÷ agent 在线小时数；若无工时数据，则看人均处理工单数 | 工单表 + agent 工时 / 登录时长 | 没有工时时不要伪装成工时效率 |
| 长时间未处理工单占比 | 护栏 | 积压风险 | aging 超阈值的 open ticket 数 ÷ open ticket 数 | 工单快照 + `updated_at` | 按优先级设置阈值 |
| 升级 / 投诉率 | 护栏 | 服务风险控制 | 升级或投诉工单数 ÷ 总工单数 | `ticket_escalated` / `complaint_created` + 工单表 | 适合与 CSAT 配套 |
| 自助解决率 / deflection rate | 护栏 | 有知识库 / 机器人 | 在帮助中心 / 机器人完成自助解决的会话数 ÷ 总求助会话数 | `help_view` / `bot_resolved` / `ticket_created` | 无 help/bot 数据不要硬推 |

## 5. 不要乱推

- 没有工单状态流转时，不要硬推 FRT、解决时长、SLA。
- 没有满意度反馈时，不要强推 CSAT。
- 不能只看工单量，必须配效率与质量。
