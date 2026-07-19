# Plan 多周期物化设计

## 背景

CTL 会把实际购买周期传给 LLMGateway，例如同一个业务 Plan 既可能购买一个月，也可能
购买 14 天。new-api 的 subscription plan 周期是固定字段，创建用户订阅时只接收
upstream plan ID，不能对单次订阅覆盖周期。因此一个 upstream plan 不能正确承载同一
业务 Plan 的多个周期。

## 决策

LLMGateway 使用一对多物化：

`(business plan ID, period value, normalized period unit, set ID) -> upstream plan ID`

业务 Plan 的默认周期保持现有映射。运营方通过控制面显式登记非默认周期；后台 worker
为每个 active Set 创建或复用带稳定 marker 的 new-api plan。只有映射达到 `ready` 后，
对应周期的订阅才能发放。

## 请求链路

1. CTL 继续传业务 `plan_id` 和实际 `period_value`、`period_unit`，无需修改协议。
2. LLMGateway 规范化周期并解析目标映射。
3. 默认周期读取 `llmgateway_set_plans`；非默认周期读取
   `llmgateway_set_plan_periods`。
4. 映射不存在时拒绝请求；映射未 ready 时返回 `PLAN_NOT_READY`。
5. 发放成功后，对外订阅仍返回业务 Plan ID，不暴露 upstream plan ID。

## 同步与安全边界

- 周期变体只能通过管理面登记，不从用户购买请求自动创建。
- 支持 `days`、`months`、`years`；未知单位直接拒绝，避免被 new-api 当成月。
- worker 使用 `llmgateway plan:<plan-id>:<value>:<unit>` marker 幂等复用 upstream plan。
- 新 Set 初始化和周期登记都会排队同步全部必要映射。
- Set admission 要求所有 active Plan 的默认映射及已登记周期映射均 ready。
- 同步错误保留并由 worker 重试，控制面可查询每个 Set 的状态。

## 上线操作

代码上线后，仅对确实支持 14 天购买的业务 Plan 调用：

```http
POST /api/plans/{plan_id}/periods
Content-Type: application/json

{"period_value":14,"period_unit":"days"}
```

随后通过 `GET /api/plans/{plan_id}/periods/sets` 确认所有 active Set 均为 `ready`，再开放
该周期的购买流量。没有登记周期的 Plan 继续只支持默认周期，不影响 ai-gateway 路径。
