# SQLite 数据基础实施设计

状态：已批准  
日期：2026-07-30  
范围：Chatserver Platform v1 的首个后台实施切片

## 1. 目标

本切片建立可运行、可迁移、可验证的 SQLite 数据基础，为后续账号、Server、Agent、
腾讯云 IM 和 TAT 业务实现提供稳定存储。

交付内容：

- 21 个 Ent Schema；
- Ent 自动生成代码；
- SQLite 版本化迁移；
- 数据库配置、连接和事务基础设施；
- `database migrate/status/verify` 三个命令；
- UUIDv7 主键生成；
- ShardKey 元数据和静态审计；
- 并发迁移、崩溃恢复和 Schema 漂移测试。

本切片不实现：

- HTTP API；
- 业务 Repository 和 CRUD；
- 腾讯云 IM/TAT 调用；
- Redis、Worker 和 Scheduler；
- TDSQL 连接与 TDSQL DDL；
- 运行时 AutoMigrate。

## 2. 固定决策

### 2.1 数据访问

采用：

```text
Ent + Atlas 版本化迁移 + modernc.org/sqlite
```

- Ent Schema 描述 Go 实体、字段、索引和通用约束；
- Ent 生成代码不得手工修改；
- Atlas 根据 Ent Schema 生成可审查的 SQLite SQL migration；
- 开发和 CI 使用 Atlas CLI 生成 migration；生产二进制使用 Atlas Go migration
  runtime 执行内嵌 migration；
- 生产程序只执行已打包且 checksum 正确的 migration；
- SQLite 使用无 CGO 的 `modernc.org/sqlite`；
- 不使用 Ent `Schema.Create` 或任何运行时 AutoMigrate。

### 2.2 部署等级

SQLite 是正式的单机生产模式：

```text
一个 Chatserver 进程
一个 SQLite 文件
一个写连接
```

它不提供水平扩展。未来水平扩展使用 TDSQL；本切片只保留所需结构元数据，不实现
TDSQL 运行路径。

### 2.3 逻辑 ID 与路由键

所有 25 张表都有单列全局唯一逻辑 `id`。业务 ID 与路由键分离：

```text
逻辑 ID：id
路由键：server_id / account_id / partition_key / registry shardkey
```

Go 领域层不使用复合 ID，也不拼接数据库主键。

SQLite 首版使用：

```sql
PRIMARY KEY (id)
```

未来 TDSQL 物理 DDL 使用：

```sql
PRIMARY KEY (shardkey, id)
```

其中 `servers.id`、`accounts.id` 等自身就是 shardkey 的根表仍使用单列主键。

## 3. UUIDv7

### 3.1 格式

逻辑主键使用 RFC 9562 UUIDv7，由每个应用实例本地生成：

```text
0198f4c2-7a31-7c91-a6d2-7d76f9188c38
```

- 使用标准小写 UUID 字符串；
- 不增加 `srv_`、`tsk_` 等资源前缀；
- 凭证仍保留 `rt_`、`inv_`、`arc_` 等类型和路由前缀；
- 不依赖数据库 Sequence、中心 ID 服务或 Snowflake Worker ID；
- 实现使用 `github.com/google/uuid.NewV7()`；
- 生成失败时不得回退到 UUIDv4、时间戳或伪随机字符串。

### 3.2 存储与排序

所有业务 ID 和 Group-Shard 路由字段统一使用：

```text
varchar(64) character set ascii collate ascii_bin
```

SQLite 实际存储为 TEXT，应用层严格验证 UUID 格式。保留 `varchar(64)` 语义是为了让
未来 `server_id`、`account_id` 和 `partition_key` 使用完全一致的 TDSQL 类型。

UUIDv7 只提供大致时间有序性，不能作为业务创建时间。稳定分页统一使用：

```text
created_at + id
```

所有时间在进入 Ent 前统一转换为 UTC 并截断到毫秒；SQLite 使用 `datetime` 语义
保存，读取后也统一返回 UTC。这样与未来 TDSQL 的 `datetime(3)` 一致。测试不得
依赖 SQLite 驱动保留微秒或纳秒。

## 4. 25 张表

### 4.1 表矩阵

| 表 | 逻辑 ID | 未来 shardkey | 自然唯一约束 |
|---|---|---|---|
| `account_login_identities` | UUIDv7 | `login_hash` | `login_hash,kind` |
| `accounts` | UUIDv7 | `id` | 登录名由 registry 保证 |
| `auth_sessions` | UUIDv7 | `account_id` | `account_id,refresh_token_hash` |
| `account_server_memberships` | UUIDv7 | `account_id` | `account_id,server_id` |
| `server_slug_registry` | UUIDv7 | `slug` | `slug` |
| `servers` | UUIDv7 | `id` | slug 由 registry 保证 |
| `server_invites` | UUIDv7 | `server_id` | `server_id,token_hash` |
| `members` | UUIDv7 | `server_id` | `server_id,handle`、`server_id,account_id` |
| `agents` | UUIDv7 | `server_id` | `server_id,im_user_id` |
| `agent_im_routes` | UUIDv7 | `im_user_id` | `im_user_id` |
| `agent_runtime_credentials` | UUIDv7 | `server_id` | Agent/version、secret hash |
| `computers` | UUIDv7 | `server_id` | name、TAT instance |
| `tat_instance_bindings` | UUIDv7 | `binding_hash` | `binding_hash` |
| `channels` | UUIDv7 | `server_id` | name、system key、IM 映射 |
| `channel_members` | UUIDv7 | `server_id` | `server_id,channel_id,member_id` |
| `message_thread_refs` | UUIDv7 | `server_id` | `server_id,channel_id,message_id` |
| `message_thread_reads` | UUIDv7 | `server_id` | `server_id,thread_id,member_id` |
| `tasks` | UUIDv7 | `server_id` | `server_id,number` |
| `reminders` | UUIDv7 | `server_id` | 无额外唯一键 |
| `reminder_occurrences` | UUIDv7 | `server_id` | reminder/fire time |
| `tencent_operations` | UUIDv7 | `partition_key` | service/idempotency key |
| `idempotency_records` | UUIDv7 | `partition_key` | scope/idempotency key |
| `outbox_events` | UUIDv7 | `partition_key` | aggregate/revision/type |

其中以下 6 张表是为适配统一普通 Ent Entity 而新增逻辑 ID：

```text
account_login_identities
account_server_memberships
server_slug_registry
tat_instance_bindings
channel_members
agent_im_routes
```

新增 ID 不取代其自然唯一约束，不改变 shardkey，也不增加表数量。

### 4.2 Schema 约定

每个 Ent Schema 必须：

- 显式设置表名；
- 使用公共 ID Mixin；
- 使用 UTC 时间字段；
- 按 `04-数据库规格.md` 声明索引；
- 声明自定义 `ShardKey` Annotation；
- 不声明 Ent Edge；
- 不生成数据库外键；
- 不使用数据库原生 ENUM；
- 不把 JSON 用于核心关系查询。

状态字段使用基于 string 的 Go 类型和常量。Nullable 字段使用 Ent
`Optional/Nillable`，不得用空字符串冒充 NULL。

JSON 字段保存为 TEXT 语义，写入时验证格式。Token、Password 和 Runtime credential
只保存强哈希，不保存明文。

## 5. 工程结构

```text
chatserver/
├── cmd/chatserver/
│   └── main.go
├── internal/config/
├── internal/database/
│   ├── open.go
│   ├── transaction.go
│   ├── partition.go
│   ├── migration/
│   └── schemaaudit/
├── internal/id/
├── internal/ent/
│   ├── schema/
│   └── <generated>
├── migrations/sqlite/
├── atlas.hcl
└── go.mod
```

边界：

- `internal/ent/schema` 是手写 Schema；
- `internal/ent` 其余内容由 Ent 生成；
- 业务包未来只能经 Repository 使用 Ent Client；
- 当前切片不建立空的业务 Service、Controller 或 HTTP Router。

## 6. ShardKey 元数据

每个 Schema 使用自定义 Annotation 声明未来路由字段，例如：

```text
Task       -> server_id
Account    -> id
OutboxEvent-> partition_key
```

Annotation 当前不改变 SQLite SQL。`schemaaudit` 必须检查：

1. 25 张表都有且只有一个合法 ShardKey；
2. 字段实际存在；
3. Annotation 与 `10-TDSQL分区与路由.md` 的矩阵一致；
4. 根表的逻辑 ID 与 shardkey 一致；
5. 自然唯一索引包含未来 shardkey；
6. 生成代码没有额外隐式表或外键。

未来 Repository 必须把 shardkey 作为第一个业务参数，并禁止业务代码直接调用无范围
的 Ent `Get(id)`、`UpdateOne` 和 `DeleteOne`。该路由守卫不在本切片实现。

## 7. SQLite 连接

默认参数：

```text
journal_mode = WAL
synchronous = FULL
busy_timeout = 5s
foreign_keys = OFF
MaxOpenConns = 1
MaxIdleConns = 1
```

要求：

- 数据库父目录权限为 `0700`；
- 新建数据库和相邻 lock 文件权限为 `0600`；
- 使用绝对路径；
- 不接受空路径、目录路径或 NUL 字节；
- 日志不得输出完整 DSN；
- 打开后立即 Ping 并核验关键 PRAGMA；
- 关闭时释放连接和文件锁。

SQLite 单机生产模式不允许多个 Chatserver 服务进程同时写同一个数据库文件：

- 服务进程启动时取得 `<db>.writer.lock` 排他锁，并持有到进程退出；
- `database migrate` 必须取得同一把排他锁，因此只能在服务停止时执行；
- `database status` 和 `database verify` 使用只读检查连接，不取得 writer lock，也不
  修改 PRAGMA；
- lock 文件权限为 `0600`，锁归属由操作系统文件锁判断，不凭 PID 文件判断；
- 进程异常退出后由操作系统释放锁，不删除 lock 文件；
- 等待锁超时返回稳定错误，不绕过单实例保护。

不再额外维护 `<db>.migrate.lock`；writer lock 同时保护服务写入和 migration，避免
服务运行期间发生 Schema 变化。

## 8. 事务

统一事务 helper：

```text
WithTx(ctx, func(txClient) error) error
```

规则：

- callback 返回错误时回滚；
- commit 失败时返回 commit 错误；
- rollback 错误作为诊断信息附加，不覆盖原始业务错误；
- context 取消必须中止后续操作；
- 事务内不得执行网络、文件或腾讯云调用；
- 禁止嵌套事务；
- panic 时尝试回滚后继续抛出 panic。

当前切片只实现通用事务行为，不实现跨领域业务事务。

## 9. 版本化迁移

### 9.1 生成

```text
修改 Ent Schema
→ ent generate
→ Atlas 计算与 migrations/sqlite 的差异
→ 生成 <version>_<name>.sql
→ 人工审查
→ atlas migrate hash
→ 全新库和升级库测试
```

禁止：

- 生产 AutoMigrate；
- 启动时自动修改 Schema；
- 运行时从当前数据库临时生成 SQL；
- checksum 不一致时继续执行；
- 自动生成并执行 down migration。

生成路径和运行路径分离：

- `go generate` 与 Atlas CLI 只在开发和 CI 使用；
- 生产二进制通过 `embed.FS` 携带 `migrations/sqlite` 和 `atlas.sum`；
- 运行时使用 Atlas Go migration runtime，不调用外部 `atlas` 可执行文件；
- 内嵌目录、数据库 revision 与 checksum 任一不一致时拒绝迁移。

### 9.2 应用

migration SQL 和 `atlas.sum` 编译进二进制。执行顺序：

```text
获取 <db>.writer.lock
→ 校验 migration checksum
→ 检查当前 revision
→ 逐个执行 pending migration
→ 写 revision
→ 执行 Schema verify
→ 释放锁
```

每个 migration 在独立事务内执行。失败时回滚当前 migration，不执行后续版本。

未来 destructive migration 必须先设计 SQLite 在线备份与恢复流程；首个 baseline
migration 不包含 destructive DDL。

## 10. 命令

### 10.1 database migrate

```text
chatserver database migrate
```

- 校验配置、权限、checksum 和数据库版本；
- 等待或获取 migration lock；
- 顺序应用 pending migration；
- 最后执行 verify；
- 没有 pending migration 时成功退出。

### 10.2 database status

```text
chatserver database status
```

输出：

- 数据库路径的脱敏表示；
- 当前版本；
- 最新支持版本；
- pending migration 数量；
- checksum 状态；
- 上次 migration 状态。

不修改数据库业务 Schema。

### 10.3 database verify

```text
chatserver database verify
```

依次检查：

- `PRAGMA integrity_check`；
- migration checksum 和 revision；
- 25 张业务表；
- 列、NULL、默认值和索引；
- 不存在外键和额外隐式关系表；
- ShardKey Annotation；
- 关键 SQLite PRAGMA；
- 文件权限。

发现漂移只报错，不自动修复。

## 11. 错误契约

稳定错误码：

```text
CONFIG_INVALID
DATABASE_OPEN_FAILED
DATABASE_BUSY
DATABASE_PERMISSION_UNSAFE
MIGRATION_CHECKSUM_MISMATCH
MIGRATION_FAILED
DATABASE_VERSION_TOO_NEW
DATABASE_INTEGRITY_FAILED
SCHEMA_DRIFT
DATABASE_IN_USE
```

要求：

- 错误码供程序和测试判断；
- 人类可读消息使用中文；
- 保留底层 cause 供诊断；
- 不在日志中输出 DSN、Token、密码或数据行；
- 不把 checksum mismatch、future version 或 integrity failure 降级为警告。

## 12. 并发与崩溃恢复

- 同一数据库文件只能有一个 migration 执行者；
- 第二个进程等待锁，获得后重新检查 revision；
- SQLite 未提交事务在进程崩溃后由数据库回滚；
- 下次执行先检查完整性、revision 和 checksum；
- 检测到不确定状态时拒绝继续写入；
- 恢复由运维明确处理，不自动跳过失败 migration。

## 13. 测试

### 13.1 生成和静态审计

- 21 个 Ent Schema 全部生成成功；
- 连续两次生成结果完全一致；
- generated 文件没有人工修改；
- 21 个 ShardKey Annotation 与矩阵一致；
- 索引名稳定且无冲突；
- 不生成外键或额外表。

### 13.2 UUIDv7

- 生成值符合 UUID 语法；
- Version 为 7，Variant 符合 RFC 9562；
- 并发批量生成不重复；
- 输出为标准小写字符串；
- 生成失败不会静默回退；
- 排序测试不把 UUIDv7 当成严格时钟。

### 13.3 Migration

- 全新临时 SQLite 文件可执行 baseline；
- 完成后恰好有 25 张业务表和 migration 元数据表；
- 重复 migrate 幂等；
- 两个进程并发 migrate 不会重复执行；
- checksum 被修改时在任何 Schema 写入前失败；
- 故意失败的 migration 完整回滚；
- 数据库版本高于二进制时拒绝执行；
- 从上一稳定 fixture 升级后结果与全新库一致。

### 13.4 Verify

- 正常数据库通过；
- 删除索引、修改列或增加外键时报告漂移；
- integrity check 失败时拒绝通过；
- 危险文件权限得到明确错误；
- 关键 PRAGMA 不符时报告；
- 错误信息不泄漏 DSN 或数据。

### 13.5 事务和质量

- 成功 commit；
- callback error rollback；
- panic rollback 后继续 panic；
- commit/rollback error 语义；
- context cancel；
- `go test -race ./...`；
- `go vet ./...`；
- 凭证与真实腾讯云标识扫描。

## 14. 验收标准

以下命令全部成功：

```text
go generate ./...
go test -race ./...
go vet ./...

chatserver database migrate
chatserver database status
chatserver database verify
```

最终产物：

- 一个包含 25 张业务表的 SQLite 数据库；
- 一套可重放且 checksum 正确的版本化 migration；
- 完整 Ent 生成代码；
- UUIDv7 主键生成器；
- ShardKey 元数据与审计器；
- 不包含业务 API、腾讯云 IM/TAT 或占位业务层。

## 15. 后续阶段

本切片通过后，按以下顺序继续：

1. Account 注册、登录和 Session；
2. Server 创建、列表和 slug registry；
3. 腾讯云 IM Human 身份和 Community；
4. Computer/TAT；
5. Agent Runtime credential 与 Session；
6. Task、Reminder、Outbox 和 Worker；
7. TDSQL 物理 DDL、Repository 路由守卫与真实多 set Canary。

## 16. 依据

- [RFC 9562 UUID](https://www.rfc-editor.org/rfc/rfc9562)
- [Google UUID Go package](https://pkg.go.dev/github.com/google/uuid)
- [Ent Code Generation](https://entgo.io/docs/code-gen/)
- [Ent Versioned Migrations](https://entgo.io/docs/versioned/intro/)
- [Atlas Versioned Migrations](https://atlasgo.io/guides/evaluation/setup-migrations)
- [modernc.org/sqlite](https://pkg.go.dev/modernc.org/sqlite)
- [腾讯云 TDSQL 建表与 shardkey](https://cloud.tencent.com/document/product/557/8767)

## 17. 本地审查结论

实施前审查已完成，结论为可进入测试先行实施计划。审查期间已收口：

- 全部内部业务 ID fixture 改为 UUIDv7；
- Human、Agent、Community、Topic HMAC 测试向量可从输入复算；
- SQLite/TDSQL 的部署定位在产品范围、数据库规格与 OpenAPI 中一致；
- SQLite 服务和 migration 使用同一把全生命周期 writer lock；
- 时间统一为 UTC 毫秒，与 TDSQL `datetime(3)` 对齐；
- 生产运行不依赖 Atlas CLI；
- OpenAPI、JSON fixture 和凭证扫描通过。

本审查不等同于代码验收；代码仍必须按第 13、14 节通过测试和命令验收。
