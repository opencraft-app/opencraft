# Platform v1 规格入口

本目录的机器可读契约具有明确优先级：

1. `model-contract.yaml`：26 张业务表的领域类别、路由键、引用、生命周期、删除与保留策略；
2. `openapi.yaml`：Human、Runtime、Computer 和回调 HTTP 契约；
3. `computer-bootstrap.openapi.yaml`：独立的 Computer bootstrap HTTP 契约；
4. `migrations/released.lock.json`：已发布迁移字节的 append-only 锁（位于仓库根 migration 目录）；
5. `releases/*.openapi.yaml` 与 `releases/released.lock.json`：已发布 HTTP 契约的不可变基线；
6. `02`–`10`：当前中文解释性规格，必须被机器契约反向校验。

`11` 及之后的设计、实施计划和验收记录保留历史决策，不是当前接口或数据库权威；其中
出现的旧路径只能解释当时实现，不能覆盖上述机器契约。新增功能先修改机器契约与测试，
再同步当前中文规格，最后实现行为。

当前身份边界固定为：Human 使用 `/servers/**`、`/me/**`；Agent Runtime 使用
`/runtime/**`；Computer 使用 `/computer/**`、Enrollment 和独立 bootstrap surface。
Agent 不再通过长期 AgentCredential 调用已删除的 session 端点；短期 Runtime/IM session
由 Computer 针对当前 launch fence 签发或刷新。

OpenAPI 发布只能显式执行 `go run ./cmd/openapi-release --version <semver>`。日常门禁运行
`scripts/check-openapi-compatibility.sh`；受保护 CI 还必须通过
`CHATSERVER_OPENAPI_TRUSTED_RELEASE_LOCK` 提供默认分支的 lock，防止同时改写快照和 digest。

当前发布基线为 `3.0.0`：活跃 Agent 从创建开始必须绑定同 Server、已纳管的 active
Computer，`computerId` 不可为空且不能解绑。`2.0.0` snapshot 继续作为不可变历史保留。

Migration 发布锁只能显式执行 `go run ./cmd/migration-release` 更新。日常生成门禁会调用
`scripts/check-migration-release.sh`；受保护 CI 通过
`CHATSERVER_MIGRATION_TRUSTED_RELEASE_LOCK` 提供默认分支的 lock，因此旧 SQL 与其摘要不能在
同一次变更中一起被改写。
