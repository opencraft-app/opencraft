# 权益模板与 Set 下发设计

## 目标

LLMGateway 是 Plan 定义与下发状态的真源。运营端或其他控制面通过正式 API 定义
周期、额度等订阅权益，LLMGateway 将其保存为不可变模板，并异步同步为每个 new-api
Set 内的 subscription plan。用户准入和订阅发放只使用已经下发成功的模板，不在用户
请求链路临时创建 new-api plan。

本期只实现权益模板的存储、同步、准入门禁和中文运营页面。模型范围、限流和倍率由
new-api 承接，不进入 LLMGateway Plan 模型。

## 数据模型

### `llmgateway_plans`

平台级权益模板：

- `id`：稳定 Plan ID。调用方可显式指定；省略时由 LLMGateway 生成。
- `name`：运营名称。
- `monthly_tokens`：new-api subscription 的总额度。
- `period_value`、`period_unit`：有效周期。
- `is_active`：是否允许新发放。
- `fingerprint`：上述业务字段的规范化指纹，用于不可变校验。
- `created_at`、`updated_at`。

同一 ID、同一内容重复写入是幂等成功；同一 ID、不同内容返回 HTTP 409。权益发生
变化时必须创建新的 Plan ID，不引入 revision。

### `llmgateway_set_plans`

每个 Set 的下发状态：

- 联合主键：`plan_id + set_id`。
- `upstream_plan_id`：对应 new-api Set 内的整数 plan ID。
- `status`：`pending`、`syncing`、`ready`、`error`。
- `attempts`、`last_error`、`synced_at`、`created_at`、`updated_at`。

旧表 `llmgateway_plan_mappings` 不迁移，并在 schema bootstrap 时删除。北京压测产生的
`load-*` Plan 不导入新表。

### 周期变体

一个业务 Plan 可以显式允许多个购买周期，但 new-api subscription plan 的周期固定，
因此每个非默认周期必须物化为独立的 upstream plan：

- `llmgateway_plan_periods` 保存业务 Plan 允许的非默认周期，联合主键为
  `plan_id + period_value + period_unit`。
- `llmgateway_set_plan_periods` 保存每个周期变体在各 Set 的 upstream plan ID 和同步状态，
  联合主键为 `plan_id + period_value + period_unit + set_id`。
- 默认周期继续使用 `llmgateway_set_plans`，保持现有数据和接口兼容。
- 周期单位只允许 `days`、`months`、`years`，别名在写入时规范化。

## 同步与准入

1. Plan 写入后，为所有 active Set 创建或保持 `pending` 下发记录。
2. 独立 worker 周期性扫描非 `ready` 记录，调用 new-api 管理 API 创建 subscription
   plan，成功后保存 `upstream_plan_id` 并置为 `ready`。
3. 新 Set bootstrap 必须同步全部 active Plan；全部 ready 后 Plan checker 才通过。
4. 用户订阅发放只选择目标 Plan 已 ready 的 active Set。已有绑定的 Set 缺少 ready
   记录时返回 `PLAN_NOT_READY`，不得在请求内补建。
5. 同步失败保留错误并由 worker 重试；运营页可看到每个模板在各 Set 的下发状态。
6. 非默认周期必须先登记并在目标 Set 同步为 `ready`；Set 准入同时检查默认 Plan 和
   全部已登记周期，用户订阅请求不会临时创建 upstream plan。

## API 与运营页面

- `GET /api/plans`：列出权益模板及下发摘要。
- `POST /api/plans`：定义不可变权益模板。`id` 可省略；响应返回服务端最终保存的完整
  Plan。显式 `id` 的相同请求幂等成功，同 ID 不同内容返回 409。
- `GET /api/plans/{id}`：读取权益模板。
- `GET /api/plans/{id}/sets`：读取该模板的 Set 下发状态。
- `GET /api/plans/{id}/periods`：读取允许的非默认周期。
- `POST /api/plans/{id}/periods`：登记一个非默认周期并为所有 active Set 排队下发。
- `GET /api/plans/{id}/periods/sets`：读取周期变体在各 Set 的下发状态。
- `POST /api/plans/{id}/sync`：把指定或全部 active Set 标记为待同步，交给 worker。

管理台“订阅权益”页面支持新增模板和复制已有模板，并使用“权益模板”“集群下发”
“待下发”“已就绪”“失败”等运营语言，不暴露 materialization、mapping 等实现词。
管理台不是 Plan 的真源，只是上述 API 的一个客户端。

## 明确不做

- 不保存 CTL Bundle 与 Plan 的绑定关系。
- 不保存 `allowed_models`、`rate_limits`、`token_multipliers`。
- 不修改 new-api 源码，不直接写 new-api 数据库。
- 不在用户准入/订阅请求中同步 Plan。
- 不保留旧 `llmgateway_plan_mappings` 或压测 `load-*` 数据。
- 本期只实现基础权益模板下发；积分包、钱包充值和一次性额度发放不在当前范围，也不在
  本文中预设后续实现路径。
