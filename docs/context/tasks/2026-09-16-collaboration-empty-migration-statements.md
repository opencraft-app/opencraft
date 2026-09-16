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
  - collaboration/internal/database/migration/mysql_recovery.go
  - .ci/collaboration-recovery.yml
status: active
reviewed_at: 2026-09-17
review_due: 2026-12-15
revision: 1.1.0
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
- `recovery-plan` 默认零 DB 写入；`recovery-apply` 只在所有精确特征和 0 行校验通过后可执行。
- recovery phase 经独立人工审批，不导出 Secret、不生成 GitOps MR、不自动运行 runtime。

## affected_paths

- `collaboration/internal/database/migration/tdsql_state.go`
- `collaboration/internal/database/migration/tdsql_apply.go`
- `collaboration/internal/database/migration/tdsql_state_test.go`
- `collaboration/docs/README.md`
- `docs/engineering/domains/release-gitops.md`
- `docs/runbooks/collaboration-beijing-bootstrap.md`
- `.ci/collaboration-recovery.yml`
- `.ci/runtime/commands/run_collaboration_baseline_recovery.sh`
- `.ci/runtime/harness_ci/db_job.py`

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
- MR !4108 可信 guard 复现同一失败。调用链确认 Community 成功后会合法地立即派生
  `#全员` Topic；端到端测试夹具原先未实现 `create_topic` 响应，竞态时将合法请求误判为
  未知路径。夹具现在校验 Group/Topic/所有者字段并返回对应 TopicId，不改生产并发语义。
- 修复后目标用例连续 50 次通过，race 连续 10 次通过；与 CI 相同的
  `.ci/checks/collaboration_guard.sh` 和 docs-impact 通过。
- MR !4108 已合入，主干构建 #5 产出可验证的北京新镜像；构建为 build-only，Runtime 未发布。
- Recovery 新切片 RED：缺少精确恢复分类器、CLI 和 DB Job 操作时，Go/Python 聚焦测试如期失败。
- GREEN：精确签名/动作分类 3 项、CLI 解析、聚焦 Go 70 项、Collaboration delivery 13 项、
  DB Job 30 项与 YAML 解析通过。
- 最终完整 `go test -p 2 ./...` 和 `go test -race -p 2 ./...` 均通过 1131 项，`go vet ./...`、
  Collaboration guard、generated/migration/OpenAPI/双方言 verify/密钥扫描通过。CI runtime 556 项、
  materialized smoke、Stream YAML/guard 解析、docs-impact 与聚焦 recovery delivery/DB Job 43 项通过。

## decisions

- 在运行时规范化 Atlas statements，不改写已发布 migration 字节。
- dirty 恢复与代码修复分离：先产出新镜像，再对空库残留做一次性受控恢复。

## handoff

MR !4108 已合入并产出新镜像。受控 recovery 源码、独立最小权限流水线与 runbook
已通过完整门禁，待提交和 MR；真实恢复操作未执行，Runtime 未发布。
