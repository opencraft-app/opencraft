# SQLite 数据基础实施计划

状态：已批准实施  
日期：2026-07-30  
依据：`11-SQLite数据基础实施设计.md`

## 1. 实施原则

- 严格使用 Red → Green → Refactor；
- 每个行为先写最小失败测试，并确认失败原因正确；
- 不以“代码能编译”替代迁移、Schema 和崩溃行为测试；
- Ent 生成代码不手改；
- 生产运行不调用 AutoMigrate 或外部 Atlas CLI；
- 当前只实现 SQLite 数据基础，不提前加入 HTTP、业务 CRUD、IM、TAT、Redis 或 Worker；
- 每完成一个阶段立即运行该阶段测试；全部完成后再跑竞态、静态检查和凭证扫描。

## 2. 工具与版本

项目使用 Go 1.25 tool directive 固定生成工具，`go.mod` 固定实际工具链补丁版本：

```text
go tool ent
go tool atlas
```

运行依赖：

- `entgo.io/ent`
- `ariga.io/atlas`
- `modernc.org/sqlite`
- `github.com/google/uuid`
- `github.com/gofrs/flock`

测试默认只使用 Go 标准库，不引入断言框架。依赖版本在首次解析模块时固定到
`go.mod/go.sum`，不使用 `latest` 浮动构建。

## 3. 逐步任务

### 任务 1：模块、错误与 UUIDv7

文件：

```text
go.mod
internal/apperror/error.go
internal/apperror/error_test.go
internal/id/id.go
internal/id/id_test.go
internal/clock/clock.go
internal/clock/clock_test.go
```

Red：

1. 错误必须提供稳定 Code、中文 Message、可展开 Cause；
2. UUID 必须为小写、Version 7、RFC Variant；
3. 并发生成不得重复；
4. 时间必须转 UTC 并截断到毫秒。

Green：

- 实现最小错误类型、`id.New()` 和 UTC 毫秒归一化；
- UUID 失败直接返回错误，不回退。

验收：

```text
go test ./internal/apperror ./internal/id ./internal/clock
```

### 任务 2：Ent 公共约定与 ShardKey Annotation

文件：

```text
internal/ent/generate.go
internal/ent/schema/mixin.go
internal/ent/schema/annotation.go
internal/database/schemaaudit/manifest.go
internal/database/schemaaudit/manifest_test.go
```

Red：

1. 正式 manifest 必须恰好包含 25 张表；
2. 每张表只有一个已知 shardkey；
3. 5 张补充逻辑 ID 的表必须出现在 manifest；
4. 所有表逻辑 ID 都使用相同 UUIDv7 默认生成器。

Green：

- 定义 ID/时间 Mixin；
- 定义 `ShardKey` Annotation；
- 冻结表名、Schema 名、shardkey 的唯一 manifest。

验收：

```text
go test ./internal/database/schemaaudit
```

### 任务 3：21 个 Ent Schema

文件：

```text
internal/ent/schema/account_login_identity.go
internal/ent/schema/account.go
internal/ent/schema/auth_session.go
internal/ent/schema/account_server_membership.go
internal/ent/schema/server_slug_registry.go
internal/ent/schema/server.go
internal/ent/schema/server_invite.go
internal/ent/schema/member.go
internal/ent/schema/agent.go
internal/ent/schema/agent_runtime_credential.go
internal/ent/schema/computer.go
internal/ent/schema/tat_instance_binding.go
internal/ent/schema/channel.go
internal/ent/schema/channel_member.go
internal/ent/schema/task.go
internal/ent/schema/reminder.go
internal/ent/schema/reminder_occurrence.go
internal/ent/schema/tencent_operation.go
internal/ent/schema/idempotency_record.go
internal/ent/schema/outbox_event.go
internal/database/schemaaudit/schema_test.go
```

Red：

- 从 Ent Graph 读取 Schema，逐表比对字段、可空性、默认值、索引和 Annotation；
- 禁止 Edge、外键和隐式表；
- 唯一索引必须与 `04-数据库规格.md` 一致；
- `id` 必须是单列逻辑主键。

Green：

- 按数据库规格逐表实现 Schema；
- 状态字段使用 string 类型常量；
- JSON 使用 TEXT 语义；
- Secret 仅定义 hash 字段。

验收：

```text
go generate ./internal/ent
go test ./internal/database/schemaaudit
```

### 任务 4：生成代码稳定性

文件：

```text
internal/ent/<generated>
internal/database/schemaaudit/generated_test.go
```

Red：

- 生成结果必须只包含 21 个业务 Entity；
- 不得出现关系表、外键或自增整数主键；
- 连续两次生成后工作树内容哈希一致。

Green：

- 固定 Ent 版本与 feature；
- 修正 Schema，直到生成结果稳定；
- 生成代码只通过 `go generate` 更新。

验收：

```text
go generate ./internal/ent
go generate ./internal/ent
go test ./internal/database/schemaaudit
```

### 任务 5：SQLite 路径、权限、连接和 writer lock

文件：

```text
internal/config/database.go
internal/config/database_test.go
internal/database/open.go
internal/database/open_test.go
internal/database/lock.go
internal/database/lock_test.go
```

Red：

- 拒绝空路径、相对路径、目录、NUL 和不安全父目录；
- 新建父目录 `0700`、数据库和 lock 文件 `0600`；
- DSN 不得进入错误和日志；
- 每个连接核验 WAL、FULL、5 秒 busy timeout、foreign_keys OFF；
- 只允许一个 writer lock 持有者，context 超时返回 `DATABASE_IN_USE`；
- 锁持有者异常关闭后可重新取得。

Green：

- 预创建并校验文件；
- modernc DSN 使用 `_pragma` 和 `_time_format=sqlite`；
- 连接池固定为 1/1；
- 使用 gofrs/flock 的 context lock。

验收：

```text
go test ./internal/config ./internal/database -run 'Open|Lock|Config'
```

### 任务 6：SQLite baseline migration

文件：

```text
atlas.hcl
migrations/sqlite/202607300001_baseline.sql
migrations/sqlite/atlas.sum
internal/database/migration/embed.go
internal/database/migration/runner.go
internal/database/migration/runner_test.go
```

Red：

- 空数据库迁移后恰好有 25 张业务表和 Atlas revision 元数据；
- 重复执行幂等；
- checksum 被修改时零 Schema 写入；
- future revision 拒绝；
- 两个迁移进程不能同时执行；
- baseline 任一语句失败时不留下半套业务表。

Green：

- 用 Ent desired state + Atlas replay 生成 baseline；
- 人工核对 SQL 后生成 `atlas.sum`；
- 将 migration 目录嵌入二进制；
- 用 Atlas Go Executor 校验并应用；
- application 前取得 writer lock。

验收：

```text
go tool atlas migrate validate --dir file://migrations/sqlite
go test ./internal/database/migration
```

### 任务 7：Schema verify 与 status

文件：

```text
internal/database/schemaaudit/sqlite.go
internal/database/schemaaudit/sqlite_test.go
internal/database/status.go
internal/database/status_test.go
```

Red：

- 正常库通过；
- 缺表、缺列、错误 NULL、默认值、索引、外键或额外业务表均报 `SCHEMA_DRIFT`；
- `integrity_check` 异常报 `DATABASE_INTEGRITY_FAILED`；
- status 正确区分 current/latest/pending/future/checksum mismatch；
- status/verify 使用只读连接且不改变数据库和 PRAGMA。

Green：

- 查询 `sqlite_schema`、`PRAGMA table_info/index_list/index_info/foreign_key_list`；
- 与由 Schema manifest 生成的期望快照比对；
- 输出结构化状态，不打印完整路径。

验收：

```text
go test ./internal/database/schemaaudit ./internal/database -run 'Verify|Status'
```

### 任务 8：事务 helper

文件：

```text
internal/database/transaction.go
internal/database/transaction_test.go
```

Red：

- 正常 commit；
- callback error rollback；
- panic rollback 后继续 panic；
- context cancel；
- 嵌套事务明确拒绝；
- commit/rollback 错误优先级稳定。

Green：

- 围绕 Ent Tx 实现 `WithTx`；
- 不捕获业务 panic，只负责回滚与重新抛出；
- 错误使用稳定 Code 包装。

验收：

```text
go test ./internal/database -run Transaction
```

### 任务 9：数据库 CLI

文件：

```text
cmd/chatserver/main.go
internal/cli/database.go
internal/cli/database_test.go
```

Red：

- `database migrate/status/verify` 参数、退出码和中文错误稳定；
- migrate 在服务持锁时失败；
- status/verify 不写 Schema；
- 输出不包含 DSN、token 或绝对数据库路径。

Green：

- 使用标准库 `flag.FlagSet`，不引入大型 CLI 框架；
- main 只组装依赖和映射退出码；
- 命令逻辑保留可注入接口，测试不启动子进程。

验收：

```text
go test ./internal/cli ./cmd/chatserver
go run ./cmd/chatserver database migrate
go run ./cmd/chatserver database status
go run ./cmd/chatserver database verify
```

### 任务 10：最终硬化

文件：

```text
internal/database/testdata/*
scripts/check-generated.sh
scripts/scan-secrets.sh
README.md
```

Red：

- 故意修改 migration、generated 文件、权限或 Schema 时检查必须失败；
- fixture 不得包含真实 Tencent Secret、JWT、Bearer token 或私钥；
- race 模式无数据竞争。

Green：

- 增加确定性生成检查、凭证扫描和完整验收脚本；
- README 只记录可执行命令与当前 SQLite 范围。

最终验收：

```text
go generate ./...
go test ./...
go test -race ./...
go vet ./...
go tool atlas migrate validate --dir file://migrations/sqlite
```

## 4. 变更门禁

遇到以下情况立即停止当前实现步骤并先修订设计：

- Ent 无法表达数据库规格中的字段或唯一约束；
- Atlas baseline 生成外键、隐式表或自增整数 ID；
- SQLite migration 不能事务回滚；
- modernc 时间或 PRAGMA 行为与测试不一致；
- 为通过 SQLite 测试需要破坏未来 shardkey 元数据；
- 需要新增规格外业务表。当前经正式 Thread 设计评审后，表数已从当时的 21 张
  扩展为 25 张。

普通依赖 API 差异、编译错误或测试失败不属于设计阻塞，应在当前 TDD 步骤内修复。
