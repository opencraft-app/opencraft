---
id: collaboration-empty-migration-statements-20260916
type: task
scope: 修复 Collaboration MySQL 首发迁移的空语句执行和 Computer v2 列序漂移。
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
revision: 1.2.0
precedence: task
derived: false
---

## goal

让 MySQL/TDSQL migration 的运行时期望、进度账本和执行路径共享同一个“可执行语句”视图，
忽略 Atlas 从连续分号解析出的空片段；通过追加 forward migration 把 Computer v2 字段重排为
当前物理规格要求的列序。

## non_goals

- 不修改、删除或重命名任何已发布 migration、摘要或 release lock 既有 entry；修复只追加新版本。
- 不改变 schema、领域模型、ShardKey、OpenAPI 或错误码。
- 不在应用中自动修复 dirty migration 账本。
- 不改写已经发布的 `20260914141219_computer_v2` migration。

## requirement_ids / requirement_refs / requirement_excerpt

- Runtime #12 已成功使用受控 kubeconfig 创建 migration Job，失败点进入数据库迁移。
- 北京目标库只存在 `account_login_identities` 一张业务表，行数为 0；revision 为
  `20260801000000 applied=1/50 error=statement_failed`，`error_stmt` 为空。
- 发布的 MySQL baseline 实际含 25 条 CREATE TABLE，Atlas 把双分号额外解析为 25 条空语句。
- Runtime bootstrap #13 已完成空基线恢复和全部 migration，但严格 MySQL schema audit 报
  `DATABASE_SCHEMA_MISMATCH`：Computer v2 三个新增字段被旧 migration 追加到表尾，而当前
  Ent/PhysicalSchema 要求它们依次位于 `name` 之后。

## interface_refs / data_structure_refs

- `atlas_schema_revisions.total/applied/partial_hashes` 只表达可执行 SQL 语句。
- `tdsqlRuntimeExpectationFromDir` 和 `applyTDSQLBaseline` 复用 `tdsqlMigrationStatements`。

## acceptance

- 回归测试在修复前观测到 baseline total=50，修复后锁定 total=25。
- 状态分类与实际执行都不接收仅含空白/分号的片段。
- 既有发布迁移和 lock entry 字节不变，新 migration/entry 只追加；生成物和 migration release 门禁通过。
- 新镜像发布前，对 0 行单表和失败 revision 的清理须再次精确核对并显式授权。
- `recovery-plan` 默认零 DB 写入；`recovery-apply` 只在所有精确特征和 0 行校验通过后可执行。
- recovery phase 经独立人工审批，不导出 Secret、不生成 GitOps MR、不自动运行 runtime。
- 新增 TDSQL source/runtime 与派生 MySQL forward migration，按
  `name → kind → provider_instance_id → desired_state` 重排列；SQLite 的 Computer v2 重建表
  已具备目标列序，因此不新增 SQLite DDL。

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
- `collaboration/internal/database/migrationsource/tdsql/20260917040000_computer_v2_column_order.sql`
- `collaboration/migrations/tdsql/20260917040000_computer_v2_column_order.sql`
- `collaboration/migrations/mysql/20260917040000_computer_v2_column_order.sql`
- `collaboration/migrations/released.lock.json`

## evidence

- 线上只读检查确认业务表集合、零行数与失败 revision；临时检查 Job 已删除。
- RED：聚焦测试返回 baseline statement total=50。
- GREEN：相同测试返回 total=25，migration/mysqlmigrations 相关 37 项测试通过。

## risks

- 旧失败 revision 的 total=50 与新运行时 total=25 必然被判定为 unsafe；不得直接重试掩盖。
- 清理属于真实数据库破坏性操作，即使当前表为 0 行也必须在执行前再验证并获得用户确认。
- MySQL/TDSQL 的 `MODIFY COLUMN` 会隐式提交；forward migration 必须保持字段类型、默认值和
  NULL 语义完全不变，只修复物理列序，并继续由逐语句进度账本保护。

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
- 主干构建 #6 产出 recovery 镜像。Recovery #1 使用旧启动默认镜像并按预期在 CLI usage 失败，
  没有 DB 写入；#2 使用正确 source/digest 完成只读 plan，但成功 Job 日志未进入审计 JSON。
  后续修复仅对 recovery plan/apply 在成功时收集脱敏日志并校验标记，无标记则 fail closed。
- Recovery #3 经人工审批完成，#4 只读回读为“数据库已为空”。Runtime bootstrap #13 随后完成
  migration，但在 schema audit 处以 `DATABASE_SCHEMA_MISMATCH` fail closed，未创建 Runtime GitOps MR。
- 列序修复 RED：runtime expectation 仍只有 9 个 migration，TDSQL/MySQL 均缺少列序修复文件；
  GREEN：两种方言均包含第 10 个 migration，并锁定三个 `MODIFY COLUMN ... AFTER ...` 的顺序。
- 完整 `go test -p 2 ./...` 与 `go test -race -p 2 ./...` 均通过 1134 项；`go vet ./...`、
  Collaboration guard、generated/migration/OpenAPI/双方言 verify、可信 release lock 对账、
  密钥扫描和全新 SQLite `migrate → status → verify` 均通过。

## decisions

- 在运行时规范化 Atlas statements，不改写已发布 migration 字节。
- dirty 恢复与代码修复分离：先产出新镜像，再对空库残留做一次性受控恢复。
- Computer v2 列序漂移通过新 migration 前向收敛；SQLite 已符合规格，不制造无语义 no-op migration。

## handoff

Recovery 已完成且数据库空基线已回读确认。Runtime bootstrap #13 在严格 schema audit 处失败，
Runtime 未发布、GitOps MR 未创建；待列序 forward migration 通过完整门禁并产出新镜像后重试。
