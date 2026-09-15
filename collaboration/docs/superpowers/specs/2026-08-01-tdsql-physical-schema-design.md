# Chatserver TDSQL 物理 Schema 与数据库适配器设计

## 状态

- 日期：2026-08-01
- 状态：已完成用户逐段确认和 5 轮独立审查，末轮问题已修订，等待用户最终确认
- 适用范围：Chatserver v1 全新数据库初始化
- 替代范围：本规格替代
  `2026-07-31-chatserver-k8s-tdsql-design.md` 中关于 `mysql` 运行时方言、
  `migrations/mysql` 和数据库 readiness 的设计；其余 K8s、Secret 和部署安全决策不变。

## 目标

Chatserver 只支持两种正式数据库平台：SQLite 与腾讯云 TDSQL MySQL。业务层继续使用
一套 Ent Entity 和 Repository；数据库差异集中在物理能力适配、migration 生成、
TDSQL DDL 编译和只读 Schema Audit。

全新 TDSQL 数据库必须真实创建为 HASH Group-Shard 表，而不是把普通 MySQL DDL
部署到 TDSQL 后形成 noshard 单表。服务只有在能够证明物理表类型、shardkey、主键、
唯一索引和各 set 分布符合规格时才能进入 ready。

## 范围

本规格实现：

- 正式数据库方言 `sqlite | tdsql`。
- SQLite/TDSQL 数据库能力适配器。
- manifest 驱动的单一 `PhysicalSchema`。
- ordinary-MySQL 逻辑 DDL 到 TDSQL DDL 的确定性编译。
- `migrations/tdsql` 运行时 migration。
- TDSQL 平台识别、物理结构和各 set 分布的只读审计。
- 全新空库初始化、重复 migration 和启动门禁。

本规格明确不实现：

- 现有 noshard 数据库的在线或离线迁移。
- DTS、双写、增量同步、切换或回滚。
- 自动 ALTER 旧表、导入旧 revision 或接管现有 Canary。
- Repository 分区路由门禁、Worker 分区调度或跨分片事务治理。
- 普通 MySQL 作为正式运行平台。

若目标 TDSQL schema 已存在业务表但没有本规格生成的 migration 历史，初始化必须拒绝；
用户需要提供一个新的空 schema/database。

## 已选方案与备选方案

### 采用：方言能力适配器 + 共享物理规格

单份 Ent/Repository 保持领域语义一致，SQLite 与 TDSQL 只实现数据库平台能力。
DDL 编译器与 Audit 共享同一个 `PhysicalSchema`，避免生成规则和验收规则漂移。

### 不采用：每种数据库一套 Repository

该方案会复制 25 张表的读写语义，使 SQLite 与 TDSQL 的幂等、事务和状态机逐步分叉。

### 不采用：继续在调用处散布 driver switch

现有 `if driver == mysql` 已分散在配置、连接、migration、CLI 和 audit 中。继续扩散会
让 `mysql` 与 `tdsql` 再次混同，也无法统一启动门禁。

## 总体架构

```text
                        ┌───────────────────────────┐
Ent Schema + Annotation│  PhysicalSchema Catalog   │
──────────────manifest►│ table / shardkey / keys   │
                        └─────────────┬─────────────┘
                                      │
                         ┌────────────┴────────────┐
                         │                         │
                         ▼                         ▼
              TDSQL DDL Compiler          TDSQL Schema Audit
                         │                         │
ordinary MySQL source ───┘                         │
                         ▼                         │
                migrations/tdsql                   │
                         │                         │
                         └──────────► TDSQL ◄──────┘

CLI / serve ──► Database Adapter Registry ──► SQLiteAdapter | TDSQLAdapter
```

## 数据库平台适配器

数据库启动路径只解析一次 `DatabaseDriver`，随后通过同一个适配器完成连接、迁移和审计。
下图箭头统一表示“importer → dependency”；包依赖固定为：

```text
CLI / serve / repositories ──► database façade
                                      │
                                      ├──► database/platform ──► config
                                      ├──► sqliteadapter
                                      └──► tdsqladapter

sqliteadapter / tdsqladapter ──► database/platform + config + migration + schemaaudit
schemaaudit ──► tdsqlddl + physicalschema
tdsqlddl ──► physicalschema
migration ──► config
```

- `internal/database/platform` 只定义 `Handle`、`OpenMode`、`MigrationState`、
  `Capabilities` 和 `Adapter`，不依赖具体 adapter。
- `sqliteadapter`、`tdsqladapter` 实现接口，并向下调用 migration/schemaaudit。
- 顶层 `internal/database` 是兼容 façade，负责 registry 与现有公开入口；可以用 type alias
  暴露 `platform.Handle`，避免业务 Repository 改成数据库专用实现。
- `migration`、`schemaaudit`、`physicalschema` 和 `tdsqlddl` 不反向 import adapter 或
  façade，因此依赖图无环。

接口是面向调用方的高层能力，不向 CLI 暴露 Atlas 或 migration fs 细节：

```go
type Adapter interface {
	Driver() config.DatabaseDriver
	Open(ctx context.Context, cfg config.Database, mode OpenMode) (*Handle, error)
	Migrate(ctx context.Context, db *sql.DB) error
	MigrationStatus(ctx context.Context, db *sql.DB) (MigrationState, error)
	VerifySchema(ctx context.Context, db *sql.DB) error
	Capabilities() Capabilities
}
```

- `OpenMode` 只有 `Writer` 与 `ReadOnly`；TDSQL 两者都使用连接池，SQLite Writer 继续
  持有现有进程锁。
- `MigrationState` 是平台无关的 `Kind(empty|pending|clean|dirty|unsafe)`、稳定 reason code
  与脱敏问题列表。
- `Capabilities` 首版只有 `PhysicalSharding`、`TransactionalDDL`、`RequiresProxyAudit`
  三项；没有调用方的能力不提前加入。
- `Handle` 继续提供 Ent Client、`SQLDB()`、writer/read-only 身份与幂等 `Close()`；
  adapter 构造它，Repository 只消费它。

实现只有：

- `SQLiteAdapter`：沿用 SQLite 文件、锁、PRAGMA、migration 和逻辑 schema audit。
- `TDSQLAdapter`：底层复用 `go-sql-driver/mysql`、Ent MySQL dialect 和 Atlas MySQL
  driver，但使用独立 TDSQL migration、物理 audit 与非事务 DDL 语义。

`Capabilities` 只表达当前基础设施真正消费的能力，例如是否要求物理 shardkey、DDL
是否可事务回滚、是否需要 Proxy audit。业务 Service 和 Repository 不依据数据库类型
选择业务规则。

正式配置与 CLI 只接受 `sqlite`、`tdsql`。旧的 `mysql` 值返回明确配置错误，不通过
DSN、版本字符串或端口猜测平台。`NewMySQLDatabase` 等面向用户的命名改为 TDSQL；
内部连接实现仍可保留 MySQL 技术名称。

## PhysicalSchema

现有 shardkey manifest 从 `schemaaudit` 的私有实现移动到独立的物理规格包，成为编译器
和 audit 的共同输入。Catalog 由 manifest 与 Ent 生成的 desired table metadata 构建，
不新增第三份手写表清单。

每张表的物理规格至少包含：

```text
TableSpec
├── table name
├── table kind: hash-shard
├── shardkey column
├── logical primary key
├── physical primary key
├── columns and route-column constraints
├── all indexes, including unique indexes
└── foreign keys: always empty in v1
```

规则固定为：

- `shardkey == id` 时，物理主键是 `(id)`。
- 其余表的物理主键是 `(shardkey, id)`，shardkey 放在前面以保持同租户数据局部性。
- 每个 UNIQUE 索引必须包含 shardkey；否则 Catalog 构建失败。
- shardkey 列必须存在、非空、不可更新，并满足 TDSQL 支持的物理类型。
- Server slug 使用 2–63 位小写 ASCII 业务约束，物理上限 63。
- 腾讯 IM UserID 使用 1–32 位 `[A-Za-z0-9_-]` 业务约束，物理上限 32。
- 字符串 shardkey 使用明确的 ASCII binary 语义，不能退回默认无界字符串。
- UUIDv7、hash 与 partition key 等现有有界字段沿用各自 Ent SchemaType。
- 业务表列集合与 Catalog 精确相等；缺列和额外列都失败。
- 普通索引和唯一索引的名称、唯一性与有序列必须与 Catalog 一致。
- 业务表禁止数据库外键；任何 `FOREIGN KEY`/引用型 `CONSTRAINT` 在生成期失败，关联
  正确性继续由应用和事务维护。

现有 `SupplementalLogicalID` 不能决定是否生成复合主键；所有 `shardkey != id` 的业务表
都遵守同一物理主键规则。

`atlas_schema_revisions` 是 migration 执行器自己的 no-shard 控制表，不进入 25 张业务
分表 manifest；adapter 只验证它可正常维护 revision。

## Migration 源与产物

正式运行时只嵌入：

```text
migrations/
├── sqlite/
└── tdsql/
```

TDSQL 不能直接把已编译的 `shardkey` SQL replay 到普通 MySQL dev database。因此保留
一份不嵌入运行时的 ordinary-MySQL **逻辑 baseline source**：

```text
internal/database/migrationsource/tdsql/
```

它不是第三种运行平台，也不会被生产二进制执行。本规格只允许一个 baseline SQL 文件：

- logical source 目录：固定 `20260801000000_baseline.sql` 与 Atlas `atlas.sum`。
- runtime 目录：同名编译后 baseline `.sql` 与权威 `atlas.sum`。
- source 目录另有 `compile.sum`，每行绑定 compiler format version、Catalog SHA-256、
  文件名、source SHA-256 与 output SHA-256。

编译单元是**整个 logical source 目录**，不是单个 migration 文件。全部有序 SQL 中必须
恰好出现 25 张 manifest 业务表且每张只有一个 `CREATE TABLE`。本规格不生成第二个
TDSQL migration，也不设计部署后的 schema evolution；未来新增/修改 schema 必须另立
规格并扩展 migration 状态机。

baseline 一经纳入运行时历史即不可改写。`migrations/tdsql/atlas.sum` 是 runtime 和已应用
revision 的权威 checksum；logical `atlas.sum` 只服务生成；`compile.sum` 证明二者由当前
Catalog 和 compiler 确定性绑定。CI 从 logical source 全量重建临时 output，并要求 SQL、
`compile.sum`、两个 `atlas.sum` 与仓库内容逐字节一致。

生成工具只创建不存在的 baseline，不覆盖历史。它在临时目录完成 Atlas 生成、编译、
重新解析、checksum 与绑定校验后，再用临时文件和 rename 发布。若跨目录发布中途失败，
工具只删除本次新建文件，绝不修改既有文件；构建门禁在 source/output/binding 不完整时
失败。生产 binary 使用 `go:embed` 的构建时快照，运行中的进程不会观察工作区半成品。

命令收敛为：

```text
go run ./cmd/migrationgen --dialect sqlite <name>
go run ./cmd/migrationgen --dialect tdsql baseline
go run ./cmd/migrationgen --dialect tdsql --verify
```

普通 MySQL dev URL 仅用于从空状态生成 `tdsql` logical baseline，不代表产品支持 MySQL。

## TDSQL DDL Compiler

Compiler 使用受限、可审计、fail-closed 的 lexer/parser，不做全局字符串替换。解析器理解
顶层语句、`CREATE TABLE`、括号层级、反引号标识符、字符串、转义、行/块注释和语句
边界；它必须正确跳过默认值或注释内的逗号、括号和关键字。

对整个 baseline 编译单元中的每个 manifest 业务表：

1. 必须恰好发现一次目标 `CREATE TABLE`。
2. 校验 shardkey 列、nullable、类型和长度。
3. 将普通逻辑主键改写为 Catalog 指定的物理主键。
4. 校验全部 UNIQUE 已包含 shardkey。
5. 在表选项中追加规范化 `shardkey=<column>`。
6. 重新解析输出并与 `PhysicalSchema` 比较。

编译器必须幂等：同一产物再次编译得到逐字节相同内容。已经存在且与 Catalog 完全匹配的
单个 shardkey option 和物理 PK 是 no-op；同一表声明多个 shardkey、值冲突或物理 PK
不匹配才失败。缺表、重复表、未知目标表、无法理解的目标语法、非法 PK/UNIQUE 都失败。

首版 SQL allowlist 只有注释和 25 个 `CREATE TABLE`；revision table 仍由 Atlas executor
管理。任何 `ALTER TABLE`、独立 `CREATE INDEX`、DML、存储过程、触发器或额外 SQL 语句
均在生成期拒绝。该约束与 fresh-only 范围一致，不能把未知语句留给部署后 audit 兜底。

Compiler 不读取数据库、不连接 Canary、不生成 down migration。

### 共享 DDL 模型

`tdsqlddl` 对 compiler 与 audit 暴露同一套契约：

```text
ParseCreateTable(SQL) → AST
Canonicalize(AST) → CanonicalTable
Compare(CanonicalTable, TableSpec) → []Violation
Render(AST) → canonical SQL
```

Canonicalization 规则：

- 关键字大小写、反引号、空白、表 option 顺序不参与比较；项目表/列/索引名规范为小写。
- PK 与 UNIQUE 的列集合和列顺序精确比较。
- AST 明确建模完整列集合、普通/唯一索引和外键；Compare 要求列/索引精确相等且外键
  为空，Compiler 在生成期即拒绝额外列、额外索引和所有外键。
- shardkey 名与 table kind 精确比较。
- 列类型同义写法归一；长度、unsigned、nullable、字符集/collation 精确比较。
- `SHOW CREATE TABLE` 注入的隐式默认值、engine 版本属性、row format 等不属于 Catalog
  invariant 时忽略；未知 TDSQL table option 保留在 AST，但不会覆盖已知 invariant。
- Compiler 输出再次 Parse/Canonicalize 后必须与 Catalog 无 violation；Audit 对实际
  `SHOW CREATE TABLE` 使用完全相同的 Compare。

## 空库 Migration 安全

`chatserver database migrate --database-driver tdsql` 在执行第一条业务 migration 前先做
平台 probe，再识别 schema/revision 状态。这里的“用户表”指当前 database 内除 Atlas
自有 revision table 外的所有表，不只检查 manifest 表。

Revision 必须按以下优先级归类，不能用后面的状态掩盖前面的异常：

1. revision control table 若存在，先验证必须包含预期 `claim_id` 定义；不匹配为 unsafe。
2. revision row 为 0 且用户表为 0 才是 empty；row 为 0 但存在任意用户表是 unsafe/not-empty。
3. revision row 必须恰好一条，并依次验证固定 version、当前 runtime hash、Total、合法
   32 位 hex claim_id、`0≤Applied≤Total`。任一不符立即 unsafe，即使 Error 非空。
4. PartialHashes 结构必须满足：数量等于 Applied，或者 Applied==Total 且数量为 0；
   其他组合立即 unsafe，不能被 Error/dirty 掩盖。
5. 任意非 manifest 用户表立即 unsafe；不会被 pending/dirty 掩盖。
6. identity 与结构合法后，`Error != ""` 是 dirty。
7. Error 为空且 `Applied < Total` 或 `PartialHashes` 非空是 pending。包括最后一条 DDL
   成功但最终清理写失败的状态。
8. 只有 `Applied==Total`、Error 为空、PartialHashes 为空且业务表精确为 25 张才是 clean；
   其余组合均 unsafe。

所有入口行为与稳定错误如下：

| 状态/原因 | `migrate` | `status` | `verify` | `serve/ready` |
|---|---|---|---|---|
| `empty` | 初始化 | 报告 empty | `DATABASE_MIGRATION_REQUIRED` | 不 ready：`DATABASE_MIGRATION_REQUIRED` |
| `clean` | no-op 后 audit | 报告 clean | 执行 audit | audit 通过才 ready |
| `pending` | `DATABASE_MIGRATION_UNSAFE` | 报告 pending | 同左 | 不 ready，同左 |
| `dirty` | `DATABASE_MIGRATION_UNSAFE` | 报告 dirty | 同左 | 不 ready，同左 |
| `unsafe`：没有 revision row，但存在任意用户表 | `DATABASE_NOT_EMPTY` | 报告 unsafe/reason | 同左 | 不 ready，同左 |
| `unsafe`：已有 revision row，identity/checksum/表集合等任一组合异常 | `DATABASE_MIGRATION_UNSAFE` | 报告 unsafe/reason | 同左 | 不 ready，同左 |

空库通过后才执行 `migrations/tdsql`。不存在“从部分成功处续跑”：本规格只有一个 baseline，
任何部分状态都要求重建这个全新 schema。

TDSQL DDL 按非事务性 DDL 处理。先确保 revision table 可用，再在执行第一条业务 SQL 前
通过 insert-only 原子 claim 成功持久化固定 version `20260801000000` 的 baseline revision
（`Applied=0`、`Total=N`、hash 已固定）。TDSQL revision control table 增加
`claim_id char(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL`；claim_id 是随机
128-bit hex owner token，不进入日志。同一固定 version 的 duplicate key 绝不能转成
upsert。

TDSQL revision store 在 Atlas 基础接口外提供 `ClaimRevision`（insert-only）和
`WriteOwnedRevision`（CAS）两个内部原语；普通 `WriteRevision` 不得用于 baseline 首次
claim。SQLite 保留现有 revision 行为，不需要 TDSQL claim_id。

只有 insert 成功者可以执行 DDL。重复 claim 的进程必须重读状态：若已 clean 则 no-op
后 audit；若 pending/dirty/unsafe 则拒绝。由于所有实现版本都使用同一固定 baseline
identity，即使两个不同构建同时初始化，也只能有一个 claim 胜出；hash 不同会成为 unsafe。

创建 revision table 或首次 claim 写失败时不得执行任何业务 DDL，可在仍为 empty 时安全
重试。不依赖尚未验证跨 Proxy/连接语义的 `GET_LOCK()`。

每成功一条业务 SQL 后立即持久化 Applied 与 PartialHashes；进度写失败就停止，不再执行
下一条。所有进度、Error 和最终 complete 更新都必须以
`version + owner token + expected Applied` 做 compare-and-swap，affected rows 必须为 1；
否则立即停止。执行 SQL 失败时尝试写入脱敏 Error/ErrorStmt，但 error 写入本身失败并
不影响安全性：先前持久化的 Applied<Total/PartialHashes 仍使状态保持 pending。全部 SQL
完成后，只有 owner 的最终 CAS 写成功并清空 PartialHashes 才是 clean；不能仅以
Applied==Total 判定完成。

`ClaimRevision` 返回三态：`won | duplicate | failed`。`won` 才进入 DDL；`duplicate` 是
正常并发竞争结果，不映射为 FAILED，必须重读并按 clean no-op 或 pending/dirty/unsafe
拒绝；只有非 duplicate 的 claim 错误返回 `DATABASE_MIGRATION_FAILED`。

当前 owner 的 `migrate` 调用中，业务 DDL、Applied/PartialHashes、Error、最终 complete
或 owner CAS 任一步失败，统一返回 `DATABASE_MIGRATION_FAILED` 并保留脱敏 cause。后续
调用根据已持久化的 pending/dirty/unsafe 返回 `DATABASE_MIGRATION_UNSAFE`。

公共 preflight 只拒绝本次调用开始时已经存在的历史/其他 owner pending/dirty。当前进程
赢得 claim 后不再调用公共 preflight，而是构造 owner-bound `RevisionReadWriter`：

- `ReadRevision` 只返回固定 version、hash 与本 owner claim 匹配的 row。
- Atlas Executor 启动时的首次冗余 `WriteRevision(0→0)` 映射为只读
  `AssertOwnedRevision`：SELECT 并核对 version/hash/claim_id/Applied，不执行 UPDATE，
  因而不依赖 MySQL/TDSQL changed-rows 或 matched-rows 语义。
- 之后每次 `WriteRevision` 映射到 `WriteOwnedRevision` CAS，绝不退回普通 upsert。
- Owner store 在内存维护上一次 Applied，确保逐条 k→k+1 进度写和最终 N→N 清理写都
  以正确 expected Applied fencing；这些真实 UPDATE 必须改变进度、error 或 partial hash，
  affected rows 必须为 1。
- 任一 identity/owner/CAS 不匹配返回 `WriteRevisionError`，Executor 立即停止。

现有 Atlas Executor 支持 partial resume，但 public preflight 会在新调用进入 Executor 前
拒绝 pending/dirty，明确关闭跨调用续跑；当前 owner 的首次执行不属于 resume。任意部分
状态都绝不能记录或解释为 complete。

随后 `database status` 按事实报告 pending 或 dirty；`migrate`、`verify`、`serve` 一律
拒绝。恢复方式是删除该失败的全新测试/初始化 schema 后重新创建，不在工具中实现通用
修复器。

`MigrationStatus`、`database status`、`verify` 和 `serve` 必须纯只读：先从
`information_schema` 判断 revision table 是否存在，仅在存在时读取，不得调用会执行
`CREATE TABLE IF NOT EXISTS` 的 revision-store ensure。只有 `migrate` 可以创建 revision
table 或写 revision。

## TDSQL Physical Schema Audit

`TDSQLAdapter.VerifySchema` 是纯只读、汇总式检查。它尽量返回全部不一致，但任何关键项
失败都会阻止 ready。

### 平台与拓扑

- 固定执行 `/*proxy*/show status`。普通 MySQL 虽会忽略注释，但其标准 `SHOW STATUS`
  不会返回 TDSQL set 身份与 `hash_range`，因此稳定判为 `DATABASE_PLATFORM_MISMATCH`。
- `ProxyTopologyReader` 将观察到的 TDSQL 结果归一为
  `Set{OpaqueID, RangeStart, RangeEnd}`；OpaqueID 来自 Proxy status 的 set 身份字段，
  只用于与 allsets 结果关联，不离开进程。
- `hash_range` 语法固定为闭区间 `<uint>-<uint>`。按 RangeStart 排序后要求第一段从 0
  开始，且每段 `next.start == previous.end + 1`；不硬编码 63/1023。
- 在没有独立 DCDB 元数据提供权威 domain 上界时，本 audit 只证明 Proxy **已报告区间**
  之间无空洞/重叠，不宣称能证明未知尾部不存在。若未来 adapter 获得独立上界，再增加
  `last.end == expected.end` 校验；该能力不属于本规格。
- set 身份必须唯一，RangeStart≤RangeEnd；解析失败、空结果、重复 set、已报告 range
  内部空洞或重叠均为 schema mismatch。
- 单 set TDSQL 合法，不人为要求至少两个 set。
- SQL 明确返回 access denied 时是 `DATABASE_AUDIT_FORBIDDEN`；查询成功但缺少 TDSQL
  topology 字段时是平台不匹配。

### 逐表结构

- `SHOW CREATE TABLE` 必须表达预期 shardkey 和 hash-shard table kind。
- 物理主键必须与 `PhysicalSchema` 顺序完全一致。
- SHOW CREATE 的 CanonicalTable 校验 UNIQUE、PK、shardkey 与 table kind；
  `information_schema.columns` 独立校验全部声明列的类型、长度、nullable、字符集/排序语义。
- 不允许未声明外键。
- 解析、规范化与 Catalog Compare 复用 Compiler 的共享 DDL 模型，不另写宽松正则。

### 各 set 物理存在性

- 通过只读 `/*sets:allsets*/` 查询 `information_schema`，确认每张分表在每个 set 存在。
- allsets 返回的 opaque set identity 必须与 ProxyTopologyReader 集合完全一致；每个
  `(table,set)` 恰好一条存在记录。结果按 set 身份归一化，不依赖 Proxy 返回顺序。
- set ID、地址和节点信息仅在内存参与去重，不写日志或用户输出。

### 调用点

- `database verify`：严格要求 MigrationState==clean，随后输出完整中文问题列表。
- `database migrate`：migration 完成后立即执行相同 audit。
- `serve`：严格要求 MigrationState==clean，再执行相同 audit；失败时不进入 ready。

## 错误与可观测性

至少区分以下稳定错误：

- `CONFIG_INVALID`：传入 `mysql` 或未知方言。
- `DATABASE_PLATFORM_MISMATCH`：普通 MySQL 或缺少 TDSQL Proxy 能力。
- `DATABASE_NOT_EMPTY`：revision row 数量为 0 时遇到任意已有用户表；只要存在 revision
  row，其 identity/checksum/结构异常一律归 `DATABASE_MIGRATION_UNSAFE`。
- `DATABASE_MIGRATION_REQUIRED`：空库尚未执行 baseline，verify/serve 不可继续。
- `DATABASE_MIGRATION_FAILED`：当前 migration 调用在 revision claim、业务 DDL、进度、
  error 或 complete 任一步失败；底层 cause 保留但脱敏。
- `DATABASE_MIGRATION_UNSAFE`：revision 或初始化状态无法安全识别。
- `DATABASE_SCHEMA_MISMATCH`：建表后物理规格不一致。
- `DATABASE_AUDIT_FORBIDDEN`：缺少必要只读诊断权限。

面向用户的错误使用中文，包含表名、字段/索引名和期望/实际类别；不得包含 DSN、密码、
主机、端口、set ID、节点地址、SQL 参数值或业务数据。底层 driver 错误保留为 cause，
但进入日志前继续经过现有脱敏策略。

## 测试策略

实施严格采用 RED → GREEN → REFACTOR。

### 单元测试

- Adapter registry：只接受 sqlite/tdsql；TDSQL 复用 MySQL 技术 driver 但选择 tdsql
  migration/audit。
- PhysicalSchema：25 张表与 Ent Annotation 一致；缺表、重复表、未知 shardkey、非法
  route column、PK/UNIQUE 缺 shardkey 均失败。
- Compiler golden：复合 PK、`shardkey=`、字符串和注释内的逗号/括号、反引号、默认值、
  多语句、CRLF、未知语法、缺失/重复表、冲突 table option、额外/缺失列、额外普通或
  唯一索引、FOREIGN KEY 和幂等性；这些非法项必须在生成期失败。
- Baseline projection：单一 logical source 与 tdsql 产物、`compile.sum`、两个
  `atlas.sum` 可全量重建且无 diff；已有 baseline 不可覆盖。
- Migration state matrix：逐项覆盖 empty/clean/pending/dirty/两类 unsafe 对
  migrate/status/verify/serve 的行为和稳定错误码；verify/serve 只允许 clean 进入 audit。
- Revision fault injection：第 0…N 条 SQL 执行失败、首次 pending 写失败、每次 Applied
  更新失败、Error 写失败、最终清理写失败；断言任何业务 DDL 前必有 pending，且除完整
  成功外都不会得到 clean，也不会自动续跑。
- Concurrent initialization：用 barrier 让两个调用同时观察 empty，断言固定 version 的
  insert-only claim 只有一个成功、只有 owner 执行业务 DDL；loser 只能重读后 no-op 或
  拒绝。覆盖不同 hash 构建竞争、owner token/CAS 不匹配、duplicate 不得 upsert，以及
  首次 0→0 使用只读 owner assertion、不依赖 RowsAffected。
- Revision classification priority：未知 version/hash/Total/claim schema/claim_id/计数和
  PartialHashes 数量异常必须优先 unsafe，不能因 Error 或 Applied 状态误归 pending/dirty。
- Read-only entry points：fake driver 将任意 Exec 视为失败，逐状态验证 status/verify/serve
  不创建 revision table、不写 revision、不执行任何 DDL。
- Publish fault injection：source SQL/sum、output SQL/sum、compile.sum 每个发布点失败，
  断言不覆盖历史、本次文件尽力清理，且半发布状态必被 `--verify` 和构建门禁拒绝。
- Audit：使用受控 fake SQL driver 覆盖平台不匹配、权限拒绝、错误 shardkey、PK、UNIQUE、
  缺失/额外列与索引、外键、set 缺表、range 内部空洞/重叠和结果乱序。
- SQLite 全量回归，证明 Entity/Repository 没有分叉。

### 集成测试

- 普通 MySQL 只承担 Atlas 空状态 logical baseline 生成，并验证其作为 `tdsql` 运行目标
  会被拒绝。
- 一次性空 TDSQL schema 应用全部 migration 两次：首次成功，第二次 no-op。
- 在同一个一次性 TDSQL schema 上并发启动两个 initializer，真实验证 insert-only claim、
  duplicate 分支、CAS affected rows 和只有一个 owner 执行 baseline DDL。
- 25 张业务表的物理审计全部通过，并确认每个 set 存在。
- 在独立临时 schema 中制造错误 shardkey/PK/UNIQUE/缺表，audit 必须稳定拒绝。
- 测试环境不得指向共享 Canary；临时 schema 名唯一，测试结束显式清理并复查无残留。

### 工程门禁

- `go test ./...`
- `go test -race ./...`
- `go vet ./...`
- 两个 migration checksum 与 `compile.sum` 绑定校验
- logical baseline source → tdsql baseline 的可重现性和不可变校验
- 凭据扫描；fixture 和错误输出不得出现真实 DSN、Secret 或节点信息

## 验收标准

- CLI 和配置只公开 `sqlite | tdsql`。
- 全新 SQLite 数据库仍能初始化、启动并通过全部回归。
- 全新 TDSQL schema 可从零完成 migration，重复运行无副作用。
- 25 张业务表全部具有 manifest 指定的真实 shardkey。
- 物理 PK 和 UNIQUE 满足 TDSQL shardkey 规则。
- slug 和 IM UserID 路由列使用批准的 ASCII/长度约束。
- 所有业务分表在全部已报告 set 存在，Proxy 已报告的 hash range 从 0 开始且内部无空洞
  和重叠；不在无独立元数据时声称验证未知尾部。
- 普通 MySQL、已有 noshard 业务表、旧 revision、审计权限不足和任意物理漂移都会阻止
  migration 或 readiness，不会触发自动修复。
- 整个实施和测试过程不连接、不部署、不修改现有 Canary。

## 实施顺序

1. 收紧 Ent 路由字段与构建 `PhysicalSchema`。
2. 引入 adapter registry，贯穿 config、open、migration、CLI 和 audit。
3. 建立 ordinary-MySQL logical baseline source 与 TDSQL compiler，生成独立、不可变的
   tdsql baseline。
4. 实现 migration 空库安全门禁。
5. 实现 TDSQL physical audit 与 readiness 门禁。
6. 完成纯单测、普通 MySQL 生成测试和一次性 TDSQL 空库验收。

旧库迁移、线上部署和 Worker/Repository 分区治理必须另立规格，不得悄悄扩入本任务。
