---
id: collaboration-empty-migration-statements-20260916
type: task
scope: 修复 Collaboration MySQL 迁移将连续分号解析为空语句并执行的问题。
triggers: ["Collaboration Runtime", "DATABASE_MIGRATION_FAILED", "statement_failed"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - collaboration/migrations/mysql/
  - collaboration/internal/database/migration/tdsql_state.go
  - collaboration/internal/database/migration/tdsql_apply.go
status: active
reviewed_at: 2026-09-16
review_due: 2026-12-15
revision: 1.0.0
precedence: task
derived: false
---

## goal

让 MySQL/TDSQL migration 的运行时期望、进度账本和执行路径共享同一个“可执行语句”视图，
忽略 Atlas 从连续分号解析出的空片段。

## non_goals

- 不修改、删除或重命名任何已发布 migration、摘要或 release lock。
- 不改变 schema、领域模型、ShardKey、OpenAPI 或错误码。
- 不在应用中自动修复 dirty migration 账本。

## requirement_ids / requirement_refs / requirement_excerpt

- Runtime #12 已成功使用受控 kubeconfig 创建 migration Job，失败点进入数据库迁移。
- 北京目标库只存在 `account_login_identities` 一张业务表，行数为 0；revision 为
  `20260801000000 applied=1/50 error=statement_failed`，`error_stmt` 为空。
- 发布的 MySQL baseline 实际含 25 条 CREATE TABLE，Atlas 把双分号额外解析为 25 条空语句。

## interface_refs / data_structure_refs

- `atlas_schema_revisions.total/applied/partial_hashes` 只表达可执行 SQL 语句。
- `tdsqlRuntimeExpectationFromDir` 和 `applyTDSQLBaseline` 复用 `tdsqlMigrationStatements`。

## acceptance

- 回归测试在修复前观测到 baseline total=50，修复后锁定 total=25。
- 状态分类与实际执行都不接收仅含空白/分号的片段。
- 发布迁移和 lock 字节不变，生成物和 migration release 门禁通过。
- 新镜像发布前，对 0 行单表和失败 revision 的清理须再次精确核对并显式授权。

## affected_paths

- `collaboration/internal/database/migration/tdsql_state.go`
- `collaboration/internal/database/migration/tdsql_apply.go`
- `collaboration/internal/database/migration/tdsql_state_test.go`
- `collaboration/docs/README.md`
- `docs/engineering/domains/release-gitops.md`

## evidence

- 线上只读检查确认业务表集合、零行数与失败 revision；临时检查 Job 已删除。
- RED：聚焦测试返回 baseline statement total=50。
- GREEN：相同测试返回 total=25，migration/mysqlmigrations 相关 37 项测试通过。

## risks

- 旧失败 revision 的 total=50 与新运行时 total=25 必然被判定为 unsafe；不得直接重试掩盖。
- 清理属于真实数据库破坏性操作，即使当前表为 0 行也必须在执行前再验证并获得用户确认。

## validation

- `go test ./internal/database/migration ./internal/database/mysqlmigrations -count=1`
- Collaboration 完整 Go test/vet/race、generated/migration/OpenAPI/secret 门禁。
- `go test -p 2 ./... -count=1` 与 `go test -race -p 2 ./... -count=1` 均通过 1127 项。
- `go vet ./...`、Collaboration guard、docs-impact、generated、migration release、OpenAPI、
  MySQL/TDSQL migration verify 和密钥扫描均通过。
- 默认并行完整 test/race 均只命中既有 IM 请求顺序测试的随机失败；该用例独立
  20 次也可复现 1 次，本变更不修改 IM 路径。

## decisions

- 在运行时规范化 Atlas statements，不改写已发布 migration 字节。
- dirty 恢复与代码修复分离：先产出新镜像，再对空库残留做一次性受控恢复。

## handoff

源码修复已通过完整门禁，待提交和 MR；恢复操作未执行，Runtime 未发布。
