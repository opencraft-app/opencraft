# 运行时无关的存储端口

[Architecture index](../README.md) · [可选 Cloudflare 部署](cloudflare-deployment.md) · [服务器核心 owner](../server/server-core-owner.md) · [SQLite 生命周期](../server/sqlite-lifecycle.md)

状态：第 1 阶段（SQL 端口与 Node 适配器，服务器核心数据）已实施；其余端口与 Cloudflare 适配器为设计。以源码、测试与 `config/main-thread-sync-io.json` 为准。

## 1. 目的

OpenCraft 服务端需要在两类运行时上运行同一份领域逻辑：

- **Node**：Electron Daemon、本机 Host、Docker／systemd Headless。存储是本地文件系统与 `node:sqlite`。
- **可选 Cloudflare**：Workers 与 Durable Objects（DO）。存储是 DO 内置 SQLite、R2 与 Secrets binding。见[可选 Cloudflare 部署](cloudflare-deployment.md)。

领域代码不能为第二种运行时打补丁或按运行时分支。本设计把存储拆成少量运行时无关端口，由部署装配显式选择适配器；Node 仍是一等公民和参考实现。

## 2. 原则

1. **契约与实现分包。** 契约包不导入 `node:*`、`cloudflare:*` 或供应商 SDK；Node 适配器位于 `*-node` 包，Cloudflare 适配器位于 `*-cloudflare` 包。沿用 `sandbox`／`sandbox-node`／`sandbox-e2b` 与 `document-storage` 的 `contract`／`/sqlite` 分层。
2. **所有权不变。** 每份数据仍只有一个写入 owner。Node 上 owner 是 Worker（经 `@opencraft/worker-owner`）加主线程投影；Cloudflare 上 owner 是一个 DO。单写者由 owner 保证（Node 的进程锁、DO 的单实例语义），**锁与 fencing 不属于存储端口**。
3. **装配显式选择。** 部署装配选择适配器，与沙盒后端相同；不按 `globalThis`、操作系统或宿主名称自动探测。
4. **共享一致性测试。** 每个端口有一套运行时无关的一致性测试，所有适配器都必须通过。Cloudflare 适配器在 workerd 中运行同一套测试；未通过的适配器不得被装配宣称可用。
5. **不为单一使用方造端口。** 只有一个使用方的持久化并入已有端口（例如并入 SQL 表），不新增抽象。
6. **JS API 差异用运行时垫片处理，存储语义不用垫片处理。** `nodejs_compat` 可覆盖 `crypto`、`Buffer` 等 API；事务、提交顺序与 CAS 语义必须由端口明确定义并由适配器真实实现，不能靠拦截 SQL 文本或模拟文件系统。

## 3. 端口

| 端口 | 契约包 | 语义 | Node 适配器 | Cloudflare 适配器（设计） |
| --- | --- | --- | --- | --- |
| `SqlDatabase` | `@opencraft/sql` | owner 内同步关系存储、事务 | `@opencraft/sqlite-node` 的 `nodeSqlDatabase()` | DO `ctx.storage.sql` 与 `transactionSync` |
| `StateDocumentStore` | `@opencraft/document-storage/state` | 按键 JSON 状态文档、原子读-改-写 | `/state-file`：每键一个文件 | DO storage |
| `BlobStore` | 待定 | 流式不可变对象、sha256 校验、分块上传 | tmp＋fsync＋rename | R2（multipart） |
| `SecretStore` | 待定 | 只读机密配置、一次性生成密钥、加密可变凭据 | 0600 私有文件 | Secrets binding＋DO 内密文 |

### 3.1 `SqlDatabase`

契约（`packages/sql/src/contract.ts`）：

```ts
type SqlValue = null | number | bigint | string | Uint8Array;
type SqlRow = Record<string, SqlValue>;
interface SqlStatement {
  get(...params: SqlValue[]): SqlRow | undefined;
  all(...params: SqlValue[]): SqlRow[];
  iterate(...params: SqlValue[]): IterableIterator<SqlRow>;
  run(...params: SqlValue[]): { readonly changes: number | bigint };
}
interface SqlDatabase {
  prepare(sql: string): SqlStatement;
  exec(sql: string): void;
  transaction<T>(action: () => T): T;
  readonly inTransaction: boolean;
}
```

- **语句对象是"SQL＋绑定"的可复用句柄**，不是原生 prepared statement 的承诺。领域代码可以缓存它；DO 适配器在每次调用时执行 `sql.exec(sql, ...params)`。
- **只支持位置参数。** 不支持命名参数、`lastInsertRowid` 与 `RETURNING` 以外的扩展；现有服务端核心代码均未使用。
- **`transaction(action)` 是唯一事务入口。** 最外层是写事务（Node 为 `BEGIN IMMEDIATE`），嵌套调用是 savepoint：内层失败只回滚内层，异常继续向外传播。回调必须同步，返回 thenable 视为错误并回滚。领域代码不得执行 `BEGIN`／`COMMIT`／`ROLLBACK`／`SAVEPOINT` 文本，DO 也禁止这些语句。
- **`changes`** 是该语句直接修改的行数，用于 CAS 判断；不得用 DO 的 `rowsWritten`（含索引写入）代替。DO 适配器需验证 `changes()` 等价性后才可宣称支持。
- **BLOB 统一为 `Uint8Array`。** DO 返回的 `ArrayBuffer` 由适配器转换。
- **身份稳定。** 同一底层连接只对应一个 `SqlDatabase` 实例（Node 适配器以 `WeakMap` 缓存），因为 `AuthorityChanges` 与 `PermissionReadCache` 以连接对象作为分组身份。
- **借用作用域。** `scopedSqlDatabase()` 把 owner 连接借给 repository；借用方 `close()` 后，经它发出的调用（包括先前取得的语句）全部失败，owner 与其他借用方不受影响。
- **端口不包含** `close`、文件位置、PRAGMA 配置、备份或迁移执行。它们属于打开连接的 owner。

#### 生命周期仍归 owner

迁移账本（`schema_migrations`、连续版本、SHA-256 校验）的语义是跨运行时的；下列能力属于 Node owner，保留在 `@opencraft/sqlite-node` 与 `@opencraft/storage-node`，DO owner 另行实现精简版本：

| 能力 | Node | DO |
| --- | --- | --- |
| 单写者 | `acquireProcessWriter`、`server.lock` | DO 单实例 |
| 迁移前备份 | `VACUUM INTO` 与恢复日志 | DO 时间点恢复（PITR） |
| 旧六库导入 | `ATTACH` 与 `.server-import/` | 不适用（新部署无旧库） |
| 迁移后 schema 校验 | `:memory:` 重放比对 | 待设计（DO 内不能另开数据库） |
| 连接策略 | WAL、`busy_timeout`、`foreign_keys` | DO 默认强制外键 |

#### 伴随 Worker 的位置

Node Headless 当前由 `Collaboration` 按数据库文件路径启动 `OrchestrationRuntimeWorker`。文件路径是 Node 拓扑事实，不属于 SQL 端口：`ServerDatabaseSource` 的对象形式以可选 `location` 显式携带它，只有 Node owner 填写。DO 中同一 owner 直接执行这些命令，不存在伴随 Worker。

### 3.2 `StateDocumentStore`

`read(key)` 与 `update(key, change)`。`change` 同步执行，返回 `{ result }`（不写）或 `{ result, next }`（原子替换）；抛错则不写。同一键的更新串行。业务 revision、schema 版本与校验留在文档和所属仓储内，端口不再包一层记录格式。

不复用插件文档 API `DocumentPersistence`：它的 `{revision, version, value}` 记录格式会改变既有文件的磁盘格式。两者同属 `@opencraft/document-storage`，契约分开。

Node 适配器 `fileStateDocumentStore(directory)` 每键一个文件，保持原有缩进格式与 proper-lockfile 锁，新旧进程仍在同一文件上串行；同进程按绝对路径先排队，再取文件锁；写入经临时文件、fsync、rename 与目录 fsync（修正旧 `json-file.ts` 未 fsync 的问题）。

**跨 await 的不变量不能依赖端口锁。** 需要在提交前执行异步操作（例如写凭据）的仓储，必须把异步副作用设计成可被 CAS 安全丢弃。图片配置替换密钥时写入新的唯一引用，再由文档 CAS 切换指向，落败方删除自己的引用，成功后回收旧引用；已提交的声明只会指向为它写入的密钥。

已迁移：`models.json`、`image-generation.json`、Pi 的 `model-provider-bindings.json` 与旧 `models.json` 读取、`projects.json`、`server-information.json`（revision CAS 留在 `ServerInformationStore`）、`hub-network.json`（`documentHubStore`；进程单写者 `<file>.lock` 仍由 Node owner `HubStateFile` 持有，文档锁因此改用 `<file>.state-lock`；文件仍含节点 Ed25519 私钥，后续移入 `SecretStore`/KeyMaterial）。凭据文件不进入此端口，进入 `SecretStore`。

不进入此端口：`session-capabilities.json` 是进程端点发现而非存储；`readPrivateJson` 读取的部署输入与用户插件清单属于只读机密配置或安装产物。

事务性账本（`conversation-resources.json`、Git broker 账本）不是 KV 语义，并入 SQL 核心。

### 3.3 `BlobStore`

`put(stream, { sha256, maxBytes }) → ref`、`get(ref, range?)`、`head(ref)`、`delete(ref)` 与分块上传会话。对象索引留在 SQL，沿用 `ArtifactCatalog` 的 ingestion → 写对象 → committed 两阶段；未提交对象由 owner 清理。承接附件、Artifact 内容、按内容寻址的插件包与 Web 资源。

### 3.4 `SecretStore`

三类：只读机密配置（现 `readPrivateJson`）、一次性生成密钥（Git vault key、能力 HMAC key、SSH key）、可变凭据（现明文 `models/credentials.json`、账号池凭据）。Cloudflare 上可变凭据以 Secrets binding 中的密钥加密后存入 owner DO。

### 3.5 不进入存储端口

Unix socket、锁文件、`/proc` 读取、Git 与 `/workspace` 工作目录、Electron profile、Codex 原生 home 与 rollout、主机文件 RPC 与分块上传临时文件。它们是容器或本机内部资源，由执行环境 owner 管理。Codex、Pi、DSH 引擎自身的 SQLite 随引擎运行在 Node 容器内，不迁移到 SQL 端口。

## 4. 分阶段

1. **SQL 端口与 Node 适配器（服务器核心数据）。** 新增 `@opencraft/sql` 与一致性测试；`@opencraft/sqlite-node` 提供 `nodeSqlDatabase()`；`ServerDatabaseSource`／`openServerRepository()` 改为交付 `SqlDatabase`；`access-control` 的领域类、函数与 `CommunicationExtension` 插件契约不再依赖 `DatabaseSync`；手写事务改为 `transaction()`；`Collaboration` 不再从连接推导文件路径。
2. **`StateDocumentStore`（已实施首批使用方）、`BlobStore`、`SecretStore` 与 Node 适配器**，迁移第 3.2–3.4 节所列使用方。
3. **沙盒 provider 泛化**：共享 broker 协议与帧解析、provider 注册、按 provider 分型的安装配置与凭据、可选持久工作区能力。见[执行沙盒](../execution/execution-sandbox.md)。
4. **Gateway／Brain 按工作区拆分**：Codex Host 状态成为独立 owner；`CODEX_HOME`、Pi、DSH writer 按工作区实例化；去除对 `pid: host` 与共享 `$DATA` 的依赖。
5. **Cloudflare 适配器**：DO SQL、DO 文档、R2、Secrets 与 `sandbox-cloudflare`，均通过同一套一致性测试。
6. **Cloudflare 部署装配**。见[可选 Cloudflare 部署](cloudflare-deployment.md)。

第 1–4 阶段只改变 Node 侧所有权与抽象，对现有部署独立成立，不以 Cloudflare 落地为前提。

## 5. 第 1 阶段实施与验收

- `@opencraft/sql` 一致性测试在 Node 适配器上通过：读写、`changes`、嵌套事务回滚、异步回调拒绝、BLOB 往返、实例身份。
- `access-control`、`storage-node`、`session-capabilities`、`thread-summary` 生产源码不再导入 `node:sqlite` 的 `DatabaseSync` 类型（Worker 与 owner 打开连接处除外，它们负责构造适配器）。
- 既有服务器核心、协作、编排、空间与身份测试通过；`check:boundaries` 的主线程同步 IO 计数不增加；`check:storage` 通过。
- 不改表结构、迁移、已发布 SQL 或备份恢复契约。

### 已实施（第 1 阶段）

- `packages/sql`：契约、`scopedSqlDatabase()` 与 `SQL_CONFORMANCE_CASES`；`tests/storage/sql-port-node.test.ts` 在 Node 适配器及借用作用域上运行全部用例。
- `@opencraft/sqlite-node` 的 `nodeSqlDatabase(connection)` 只依赖连接的 `prepare`／`exec`／`isTransaction`；事务语义的唯一 Node 实现仍是 `migrations.ts` 的 `transaction()`（owner 持有原始连接时直接使用，例如迁移与旧库导入）。
- `openServerDatabase()`、`borrowServerDatabase()`、`openServerCoreOwner()` 交付 `{ database: SqlDatabase, outcome, location }`；`openServerRepository()` 返回 `{ database, outcome, location?, close }`，借用方用 `close()` 撤销自己的借用，不再经 `database.close()`。
- `access-control` 生产源码只有 `orchestration-runtime.worker.ts` 与 `server-spaces.worker.ts` 打开 `DatabaseSync` 并构造适配器；`ThreadAccessStore.set`、`ThreadOrchestrationLedger.transaction` 与 `ThreadNoteStore.exchange` 的手写事务改为 `transaction()`。`ThreadOrchestrationLedger.transaction` 嵌套时从"直接执行"变为 savepoint：被外层捕获的内层失败只回滚内层。
- `Collaboration` 从 repository 的 `location` 取得伴随 Worker 的文件，不再调用 `DatabaseSync.location()`。
- **下游插件契约变化：** `CommunicationExtension` 钩子的 `db` 参数类型从 `DatabaseSync` 改为 `SqlDatabase`。实现方若只用 `prepare`／`exec`／语句方法无需改动逻辑；使用 `isTransaction` 的改为 `inTransaction`，手写事务改为 `db.transaction()`。
- 主线程同步 IO 登记减少 20 处调用，删除手写事务文本使相关文件的 SQL 语句计数下降；表结构、迁移、已发布 SQL 与备份恢复契约未改变。
