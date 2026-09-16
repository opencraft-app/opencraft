# Collaboration 服务文档

`collaboration` 是 LightVela 的 Server、Member、Channel、Task、Reminder 与腾讯云 IM
资源映射控制面。HTTP 机器契约以 `platform/v1/openapi.yaml` 为准，领域和分片契约以
`platform/v1/model-contract.yaml` 为准。

## 权威入口

- 领域类别、生命周期、路由语义：`collaboration/platform/v1/model-contract.yaml`。
- Human、Runtime 与 Computer HTTP 契约：`collaboration/platform/v1/openapi.yaml` 和
  `collaboration/platform/v1/computer-bootstrap.openapi.yaml`。
- 数据字段、索引和物理分片：`collaboration/internal/ent/schema/`、
  `collaboration/internal/database/physicalschema/`。
- 已发布数据库历史：`collaboration/migrations/` 与
  `collaboration/migrations/released.lock.json`。
- 当前工程约束和命令：`collaboration/AGENTS.md`。

## 关键边界

- Human 身份权威属于 `user/auth`；本服务只映射已验证的 LightVela subject。
- 腾讯云 IM 保存普通消息、历史和未读；本服务不建立第二套聊天消息库。
- CTL 拥有真实托管实例生命周期；本服务只维护 Server 与 Computer 的业务绑定。
- Runtime、Computer 和 Human 身份域互斥，凭证不可混用。

## 当前迁移状态

迁入基线仍含旧本地登录与外部 Computer/TAT 代码。启用
`--lightvela-gateway-token-file` 时，本地注册/登录路由已关闭且 Human JIT 映射不创建
AuthSession；其余旧 Computer surface 仍待通过后续契约版本完整退役。

## 数据库部署边界

Collaboration 复用 mono2 现有的普通数据库服务，不申请或管理新的数据库实例。部署时为本服务
创建独立逻辑 database/schema、独立数据库账号和独立 DSN；Migration Job 与 API/Worker 使用
同一 Collaboration DSN。本服务不得与 CTL、`user/auth` 混表或执行跨库 JOIN，也不得把聊天正文
复制进平台数据库。

普通 MySQL 8 使用显式 `mysql` 驱动；TDSQL Proxy 继续使用 `tdsql`，SQLite 使用 `sqlite`，
不根据 DSN 猜测或退回其他方言。MySQL 是正式单实例模式：领域类别、全局业务 ID、逻辑
ShardKey/显式路由、复合主键、索引和路由字符语义保持不变，不执行 Proxy topology/allsets
或要求 MySQL 声明物理 `shardkey`。表集合、字段、默认值、主键和索引仍严格审计。

MySQL 增加独立迁移发布线，固定来源为已发布 TDSQL SQL，只去除表级物理分片选项；生成器
绑定来源/产物摘要并校验，禁止覆盖已发布产物。旧 SQLite/TDSQL SQL 与发布锁条目不改。
DDL 隐式提交，复用 owner claim、逐语句进度 CAS 与 dirty/unsafe 拒绝机制；不能用
upsert revision 或假事务掩盖失败。迁移、status、verify 与 serve 必须选择同一显式方言。

## 验证

行为变更至少运行 `go test ./...` 与 `go vet ./...`。修改数据库模型或 OpenAPI 时，必须
追加运行 `go test -race ./...`、`./scripts/check-generated.sh`、
`./scripts/check-migration-release.sh`、`./scripts/check-openapi-compatibility.sh`、
`go run ./cmd/migrationgen --dialect tdsql --verify` 和 `./scripts/scan-secrets.sh .`；数据库
变更还要在全新临时 SQLite 数据库完成 migrate、status 与 verify。
