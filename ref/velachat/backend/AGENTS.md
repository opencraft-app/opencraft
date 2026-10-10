# AGENTS.md — Chatserver 工程约束

本文件适用于整个 `chatserver` 仓库。所有人工开发者和 Coding Agent 都必须遵守。

## 核心原则

本项目采用：

> 严格契约内核 + 可替换行为外壳。

数据库与领域模型负责长期事实，OpenAPI 负责跨端边界，业务行为通过测试驱动快速迭代。
Vibe Coding 只适用于可替换、可验证的行为实现，不适用于不可逆的模型、迁移和协议决策。

稳定性优先级从高到低为：

1. 数据库、领域模型、ShardKey 与持久数据格式；
2. OpenAPI、身份域、错误语义与并发协议；
3. 应用服务、Worker、第三方适配器和界面行为。

下层实现可以重构或替换，但不得绕过上层契约。

## 产品对象语义

> Server 管“谁一起工作”，Project 管“做什么”，Computer 管“在哪里运行”，Codex TUI
> 只是打开 Project 的方式。

- `Server` 是成员、Agent、权限与聊天协作的共同边界。
- `Project` 是稳定的工作对象；更换 Computer、目录或 Codex 进程不得改变 Project 身份。
- `Computer` 是执行资源。Project 通过显式执行绑定选择 Computer 与项目目录，协作所有权与机器执行权必须分别授权。
- Codex TUI、PTY、TAT Session 和 WebSocket 都是可替换或一次性的执行方式，不得成为 Project 的身份或平台长期事实。
- 用户产品语言不得再引入一个与 Server、Project 竞争的 `Workspace` 实体。内部可以使用 workspace、root URI、execution binding 等实现术语，但普通 Human 界面只表达 Server、Project、Computer、运行位置与“打开 Codex”。

## 事实源

当前机器可读事实源按以下优先级解释：

1. `platform/v1/model-contract.yaml`：领域类别、逻辑引用、生命周期、删除/保留策略和路由语义；
2. `internal/ent/schema/`：字段、类型和索引；
3. `internal/database/physicalschema/`：物理主键、ShardKey 和 TDSQL 约束；
4. `migrations/` 与 `migrations/released.lock.json`：已发布数据库历史；
5. `platform/v1/openapi.yaml` 与 `platform/v1/computer-bootstrap.openapi.yaml`：外部 HTTP 契约；
6. `platform/v1/releases/`：已经发布的 OpenAPI 不可变基线；
7. `platform/v1/02`–`10`：当前中文解释性规格。

Markdown 不能覆盖机器契约。历史设计文档只能解释当时决策，不能作为当前实现依据。

## 数据库与领域模型

- 新增或修改业务实体前，必须先判断它是 `authority`、`projection`、`registry` 还是 `ledger`。
- 每张业务表必须具有全局唯一业务 ID 和明确的 ShardKey；二者不能依靠数据库自增主键表达。
- ShardKey、跨分片方向、不可变路由字段和逻辑引用必须进入 `model-contract.yaml`。
- TDSQL 查询必须显式携带路由键。不得以初期数据量小为理由引入广播查询。
- 数据库不使用业务外键。新增逻辑引用时，必须同时增加分区路由的一致性扫描规则。
- 权威数据、投影数据和腾讯云资源映射必须分开建模，不能用一个状态字段混合表达。
- 持久 JSON 必须通过 `internal/persistedjson` 的已注册版本化 Codec 读写；不得直接保存临时 DTO JSON。
- SQLite 是正式单机模式，不是简化版测试替身；Schema 和语义必须与 TDSQL 保持一致。
- 已发布 Migration 只能追加，禁止修改、删除或重命名。不得通过同时更新 SQL 和摘要绕过发布锁。
- Schema 变更必须同步 Ent、物理规格、SQLite/TDSQL Migration、模型契约和相关扫描器。

## OpenAPI-first

- 外部接口变更必须先修改 OpenAPI 和契约测试，再生成代码，最后实现业务行为。
- 不得手工修改 `oapi-codegen` 或 `openapi-typescript` 生成文件。
- 新增列表接口时，必须明确是否分页。使用 `cursor` 时，响应必须是包含 `items` 和
  `nextCursor` 的 page envelope，并使用稳定 keyset，不允许 offset 冒充 cursor。
- Cursor 必须绑定 operation、过滤条件和排序元组；Cursor 不承担鉴权职责。
- 需要乐观并发控制的资源统一使用 `X-Resource-Revision`，不得重新引入伪 `If-Match` 数字语义。
- Human、Runtime、Computer、Enrollment、Callback 和 Public 必须属于明确且互斥的身份域。
- Human 业务路径使用 `/servers/**`、`/me/**`；Runtime 使用 `/runtime/**`；Computer 使用
  `/computer/**` 及独立 bootstrap surface。不得为了复用 Handler 扩大认证面。
- 应用错误码必须静态、稳定并进入 OpenAPI 的 `x-error-code-registry`；禁止动态拼接错误码。
- 已发布 OpenAPI 必须保持向后兼容。破坏性修改需要新的正式版本和明确迁移方案，不能修改旧 baseline。
- 修改 OpenAPI 后必须同步 Go 生成物、客户端契约、客户端类型和嵌入 Web 静态产物。

## 行为实现与 TDD

- 应用服务、Worker、重试策略、第三方适配和界面行为采用 RED → GREEN → REFACTOR。
- 先写能够因缺失目标行为而失败的最小测试，确认 RED 后再写生产实现。
- 修复缺陷时必须先增加回归测试；不能只修改实现后补一个永远不会失败的测试。
- 测试应验证公开行为、事务结果和稳定协议，避免绑定私有函数或偶然控制流。
- 行为实现必须保持可替换。只要模型和 OpenAPI 不变，允许重构或重写内部实现。
- 不为假设中的未来需求提前增加服务拆分、分布式事务、第二套聊天数据库或自研实时协议。
- 幂等、事务边界、Revision CAS、Outbox、Operation 和跨分片补偿属于正确性机制，不能以
  “后续再补”或普通 happy-path 测试代替。

## 平台责任边界

- 腾讯云 IM 负责聊天消息、群组、会话和实时聊天正确性；平台不建立第二套聊天消息库。
- 平台数据库负责 Server、Member、Agent、Computer、Task、Reminder、权限、资源映射和业务正确性。
- 两边只通过稳定资源映射和消息引用连接，不复制聊天正文作为平台权威数据。
- TAT 负责 Computer 的机器执行与终端通道；平台只负责授权、编排、状态投影和审计引用。
- Agent Runtime 负责实际智能行为；Human、Computer 与 Agent Runtime 身份不能互相冒用。

## 禁止的捷径

- 禁止先改数据库或 Handler，最后再补 OpenAPI。
- 禁止改写已发布 Migration 或 OpenAPI snapshot。
- 禁止新增逻辑引用却不增加一致性扫描规则。
- 禁止持久化无 `schemaVersion` 的新 JSON 数据。
- 禁止裸数组分页响应、无绑定 cursor、动态错误码和模糊认证方案。
- 禁止把腾讯云底层概念、密钥、Region、TAT 注册材料泄露到普通 Human 产品 DTO。
- 禁止把真实 token、SecretId、SecretKey、UserSig、Computer credential 或迁移令牌写入源码、
  fixture、日志和提交。

## 完成标准

涉及数据库模型或 OpenAPI 的工作，在交付前至少运行：

```text
go test ./...
go vet ./...
go test -race ./...
./scripts/check-generated.sh
./scripts/check-migration-release.sh
./scripts/check-openapi-compatibility.sh
go run ./cmd/migrationgen --dialect tdsql --verify
./scripts/scan-secrets.sh .
```

数据库变更还必须在全新临时 SQLite 数据库上通过 `migrate → status → verify`。

客户端契约受影响时，还必须执行 client-core 的生成、测试、类型检查和构建，并运行受影响
客户端的测试。任何未通过项都必须明确记录，不能把部分成功描述为完整验收。

## 工程判断准则

遇到设计分歧时，依次判断：

1. 这是长期事实，还是可替换行为？
2. 修改后是否需要迁移已有数据？
3. 是否会影响其他客户端或身份域？
4. 是否改变 ShardKey、幂等、事务或一致性边界？
5. 能否由机器契约、生成器或门禁自动证明？

长期事实必须先设计和审查；可替换行为优先用最小实现和测试验证。
