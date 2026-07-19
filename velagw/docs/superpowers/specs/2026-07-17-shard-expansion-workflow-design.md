# Shard 扩容工作流设计

## 目标

Shard 是一组可被多个 Set 复用的 MySQL 与 Redis 资源。运营控制台不再直接手工创建 Shard 事实，而是提交一个可追踪、可恢复的扩容意图。真实 Shard 只由 LLMFleet/set-manager 投影产生，避免地址写错或资源尚未创建时被误认为可用。

一期不在 LLMGateway Pod 内执行 Terraform，也不保存腾讯云密钥。Terraform、Kubernetes Secret 和 LLMFleet 变更由外部自动化或 Agent 执行，LLMGateway 负责记录意图、接收非敏感执行结果、观察真实投影并完成验证闭环。

## 角色边界

- 运营控制台：提交扩容意图、查看阶段和下一步、重试或取消。
- LLMGateway control：提供 API，持久化意图和执行结果。
- LLMGateway worker：按 lease 串行推进状态，观察 set-manager 投影，不直接购买云资源。
- Terraform/Agent：创建 MySQL、Redis，写 Kubernetes Secret，并把 Shard 追加到 LLMFleet。
- set-manager：读取 LLMFleet，将 MySQL、Redis 和容量事实投影到 LLMGateway。
- 验证执行器：通过正常 Set provision 路径创建或选择一个 Set，完成数据库、Redis 和流量冒烟，然后回填结果。

## 状态机

```text
requested
  -> waiting_infrastructure
  -> infrastructure_ready
  -> waiting_fleet_projection
  -> verifying
  -> ready

任一非终态 -> error -> retry_status
任一未 ready 状态 -> cancelled
```

- `requested`：意图已持久化。
- `waiting_infrastructure`：等待外部 Terraform/Agent 创建资源。
- `infrastructure_ready`：已记录非敏感资源结果。
- `waiting_fleet_projection`：等待 Secret 和 LLMFleet 更新被 set-manager 投影。
- `verifying`：真实 Shard 已出现，等待正常路径的冒烟验证。
- `ready`：资源、投影和冒烟均通过，可加入容量策略。
- `error`：记录失败步骤、错误和可恢复状态。
- `cancelled`：停止工作流；不自动销毁已创建的云资源。

worker 的推进必须幂等。状态只前进，不根据前端轮询触发副作用。`ready` 只表示扩容 Playbook 完成；容量策略是否使用该 Shard 仍由 LLMFleet/自动扩容配置决定。

## 数据模型

`llmgateway_shard_expansions` 保存：

- `id`、`idempotency_key`、显示名称和目标 Shard ID。
- 期望容量：`max_sets`、Redis DB 半开区间 `[redis_db_start, redis_db_limit)`、SQL 连接预算。
- 当前状态、重试状态、失败步骤、最后错误、下一步提示。
- 外部执行结果：MySQL endpoint、Redis endpoint、Secret 名称、Terraform run URL；不保存密码和云密钥。
- Fleet 投影时间、验证结果与证据、创建和更新时间。

同一个 `idempotency_key` 重放相同请求返回原记录；请求内容不同则返回冲突。

真实 `llmgateway_shards` 投影补充 Redis endpoint、Redis DB 区间和 Secret 名称。Shard 详情同时展示 MySQL 逻辑连接预算，以及 Redis DB 已分配/可用数量；每个 Set 展示自己的 database name 与 Redis DB。

## API

- `GET /api/admin/shard-expansions`：列出扩容流程。
- `POST /api/admin/shard-expansions`：提交扩容意图。
- `GET /api/admin/shard-expansions/{id}`：查看详情。
- `POST /api/admin/shard-expansions/{id}/infrastructure`：外部自动化回填非敏感资源结果。
- `POST /api/admin/shard-expansions/{id}/verification`：回填冒烟验证结果。
- `POST /api/admin/shard-expansions/{id}/retry`：从记录的重试状态继续。
- `POST /api/admin/shard-expansions/{id}/cancel`：停止未完成流程。

面向运营的 `POST /api/admin/shards` 返回 `405`，防止绕过流程。set-manager 使用的内部 Shard 投影接口继续保留写能力。

## worker 协调

增加 `reconcile_shard_expansions` 后台任务，复用现有 MySQL job lease：

1. 将 `requested` 推进到 `waiting_infrastructure`。
2. 将已回填资源的流程推进到 `waiting_fleet_projection`。
3. 在真实 Shard 投影存在且 MySQL/Redis endpoint、Redis DB 区间匹配时推进到 `verifying`。
4. 验证回填成功后推进到 `ready`；失败则进入 `error` 并保留 `retry_status=verifying`。

单次只处理有界批量，避免 Shard 工作流阻塞其他 worker job。全局 job lease 防止多 worker 重复推进；状态更新仍须验证当前状态，保证重试安全。

## 管理界面

Shard 页面分为两部分：

1. 真实资源：只读展示已经进入 LLMFleet 的 Shard，分开显示 MySQL、Redis、连接水位和 Redis DB 水位。
2. 扩容流程：表单只收集目标名称、容量和 Redis DB 区间；提交后展示“准备资源、接入集群、验证服务、已可用”四阶段进度、下一步和错误处理入口。

界面不要求运营人员直接填写数据库密码、Redis 密码或云密钥，也不把原始状态名作为主文案。

## 安全与失败语义

- 云密钥、数据库密码和 Redis 密码只存在于 Terraform/Kubernetes Secret。
- 回填 API 只能接收 endpoint、Secret 名称和执行链接等非敏感元数据。
- LLMFleet 投影不匹配时绝不进入验证阶段，也绝不参与自动分配。
- 取消只停止编排，不猜测是否应销毁云资源；清理使用独立 Playbook。
- 验证失败不会删除资源，可在修复后重试。

## 测试

- 单元测试覆盖幂等创建、冲突、合法状态推进、投影不匹配、验证失败/重试和取消。
- MySQL 测试覆盖扩容记录往返、状态条件更新和 Redis 投影字段迁移。
- HTTP 测试覆盖鉴权、API shape、非法动作，以及运营 Shard 写接口只读化。
- set-manager 测试覆盖 MySQL/Redis 投影完整性。
- 前端测试覆盖扩容表单、四阶段进度、错误和重试，以及 Shard Redis 水位。
- compose E2E 使用假的 Terraform 回填和真实 LLMFleet 投影，验证流程不会产生幽灵 Shard。
