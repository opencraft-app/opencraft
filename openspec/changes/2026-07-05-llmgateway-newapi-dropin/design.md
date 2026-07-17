# Design: LLMGateway new-api drop-in old ai-gateway

## 架构

LLMGateway 分为三个逻辑面：

1. **控制面**：set、tenant、plan、key、channel、migration、subscription facade。
2. **流量面**：OpenAI-compatible `/v1/*` key route proxy。
3. **嵌入面**：管理台中的 new-api 原生 console 嵌入运行态。

当前实现可以同进程运行。生产 SHOULD 拆成 control pod 和 traffic pod，共享 MySQL 和 Redis key-route cache。

## 数据模型

LLMGateway 本地状态只保存平台层映射：

- `llmgateway_sets`
- `llmgateway_tenants`
- `llmgateway_user_bindings`
- `llmgateway_api_key_bindings`
- `llmgateway_plan_mappings`
- `llmgateway_user_assignments`: 迁移期兼容投影，写入时同步 Tenant 主表；Tenant 是路由真源。
- `llmgateway_user_bindings`: 外部用户到目标 Set/new-api 用户的绑定，包含 `allocated/user_ready/token_ready/failed` provisioning 状态和最近失败原因。
- `llmgateway_subscription_period_overlays`
- `llmgateway_subscription_idempotencies`
- `llmgateway_channel_specs`
- `llmgateway_channel_sync_states`
- `llmgateway_tenant_observations`: 最近一次运营观测投影，只用于列表展示和排障，不作为租户库存来源。

new-api 保持 LLM 权益和扣费真源。LLMGateway 不保存完整 quota ledger。

## 受控资源视图

LLMGateway 提供 Resource Admin，但只面向 LLMGateway 自有状态表，定位是运营排障和低频维护，不是任意数据库管理台。

设计规则：

1. 资源列表由服务端白名单定义，不允许客户端传表名或列名拼 SQL。
2. 每个资源定义包含固定列、主键、可编辑性、敏感字段和 action。
3. 密钥字段在读面统一脱敏，不能通过资源接口回显明文。
4. PATCH 只改 `editable=true` 字段；Tenant 路由、Tenant 禁用、Set bootstrap 等状态机变化走 action。
5. MySQL 实现只使用内置 resource spec 生成查询；内存实现用于单元测试和本地 MVP。

当前资源白名单覆盖 `tenants`、`sets`、`user_bindings`、`api_key_bindings`、`plan_mappings`、`channel_specs`、`channel_sync_states`、`tenant_observations` 和 `subscription_period_overlays`。

## 订阅权益映射

platform plan 通过 `PlanMapping` 映射到每个 Set 的 new-api subscription plan id。新购调用目标 Set 的 new-api admin subscription API 创建 user subscription；现有 ctl `RenewPass` 仍沿用独立的异步 `ExtendSubscription` 周期对齐状态机。若后续把续费切换为新增 subscription，必须同时定义退费时新增额度的回滚语义。

new-api 的多个 active subscription 是额度叠加的正常状态，LLMGateway 不再在新建订阅后废弃旧订阅。订阅发放只在本层维护薄幂等记录：调用方传入 `idempotency_key` 时，它同时作为主键和未来 HASH 分片键；付费/续费使用 `trade:<deal_name>`，试用使用 `trial:<user_id>:<bundle_id>`。同 Key 同参数成功后直接重放结果，同 Key 不同参数返回冲突；调用 new-api 后结果不确定时标记 `unknown`，不在 LLMGateway 内自动重放或对账，订单补偿仍由 trade 或独立中间件负责。兼容期允许旧调用方省略 Key，此时不做去重，每次请求都视为独立发放。

这不是 old ai-gateway subscription id 的严格 1:1 复刻，但满足业务可观测诉求：用户有无权益、当前 plan、剩余额度、period_end、key 是否可用。

如后续发现外部系统强依赖稳定 subscription id，LLMGateway 可以增加 facade subscription id 映射，而不改变 new-api。

## Key 路由

外部 key 由 LLMGateway 生成，保存为平台 key binding。上游 new-api token 只作为目标 Set 的调用凭证，建议 unlimited quota。实际扣费由 new-api subscription/wallet billing session 承担。

traffic proxy 热路径：

1. 解析 Authorization。
2. 查 L1/Redis/MySQL key route。
3. 命中则替换 upstream key 并反代目标 Set。
4. 未命中且配置 old backend，则 fallback old ai-gateway。
5. old miss 使用 negative cache。

## Channel 同步

LLMGateway 保存 OpenAI-compatible channel desired state。保存操作只写本地状态并把目标 Set 标记 pending。

同步逻辑：

1. 读取目标 Set remote channel。
2. 计算 remote fingerprint。
3. 若不存在则 create channel，并立即 update channel 刷新 new-api channel cache。
4. 若存在且 drift，默认只标记 drift。
5. 显式 force 才覆盖远端。

## 失败处理

- new-api Set bootstrap 失败：Set 保持未 setup 或 error，不影响其他 Set。
- migration 中途失败：不写 assignment，用户继续 old。
- Tenant 不变量：`backend=new` 必须有 `set_id`；`disabled/deleted` Tenant 不能控制面写入，也不能通过 `/v1/*` 路由。
- channel 部分 Set 同步失败：返回每 Set 状态，不回滚已成功 Set。
- traffic Set 不可用：返回 upstream 错误或按后续策略降级，不跨 Set 猜测重路由同一用户 key。
- old fallback 不可用：返回明确 502/错误信息，并记录 error type。

## 测试策略

- 单元测试覆盖 store、assignment、subscription、credit、key route、channel sync。
- HTTP 测试覆盖每个控制面 API 的 auth 和 response shape。
- Compose E2E 覆盖两 Set、MySQL/Redis、old fallback、migration、subscription 生命周期、channel sync、真实 chat completions probe。
- docs-site contract test 约束 OpenAPI 暴露面。
