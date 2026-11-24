# 运行时无关的存储端口

[Architecture index](../README.md) · [可选 Cloudflare 部署](cloudflare-deployment.md) · [服务器核心 owner](../server/server-core-owner.md) · [SQLite 生命周期](../server/sqlite-lifecycle.md)

状态：第 1、2 阶段（全部四类端口、Node 适配器与首批使用方）与第 3 阶段（沙盒 provider 泛化，仅 E2B provider）已实施；第 5 阶段的存储适配器（`@opencraft/storage-cloudflare`）已在本地 workerd 中通过全部共享一致性测试，尚未接入任何部署装配，也未在 Cloudflare 账号上运行（见第 6 节）；第 4、6 阶段与 `sandbox-cloudflare` 为设计。以源码、测试与 `config/main-thread-sync-io.json` 为准。

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

| 端口 | 契约包 | 语义 | Node 适配器 | Cloudflare 适配器（`@opencraft/storage-cloudflare`，本地 workerd 已通过） |
| --- | --- | --- | --- | --- |
| `SqlDatabase` | `@opencraft/sql` | owner 内同步关系存储、事务 | `@opencraft/sqlite-node` 的 `nodeSqlDatabase()` | `/sql` 的 `durableObjectSqlDatabase(ctx.storage)`：`sql.exec` 与 `transactionSync` |
| `StateDocumentStore` | `@opencraft/document-storage/state` | 按键 JSON 状态文档、原子读-改-写 | `/state-file`：每键一个文件 | `/state` 的 `durableObjectStateDocumentStore(ctx.storage)`：DO 同步 KV |
| `BlobStore` | `@opencraft/blob-storage` | 不可变对象、大小与摘要校验、顺序上传 | `/file`：暂存＋fsync＋链接发布 | `/blob` 的 `r2BlobStore(bucket, { prefix })`：条件 `put`／multipart |
| `SecretStore`／`KeyMaterial` | `@opencraft/secret-storage` | 命名密钥、一次性安装密钥 | `/documents`＋私有文件 | `/secrets` 的 `durableObjectSecretStore`／`durableObjectKeyMaterial`：DO 同步 KV；Secrets binding 信封加密待做 |

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
- **整数限于 JavaScript 安全整数范围。** DO 只能绑定 number，适配器拒绝范围外的 `bigint`；但 workerd 读取范围外的 INTEGER 时静默取整（Node 适配器则报错）。领域数据不得依赖超过 2^53 的整数；需要时以 TEXT 或 BLOB 保存。
- **只支持位置参数。** 不支持命名参数、`lastInsertRowid` 与 `RETURNING` 以外的扩展；现有服务端核心代码均未使用。
- **`transaction(action)` 是唯一事务入口。** 最外层是写事务（Node 为 `BEGIN IMMEDIATE`），嵌套调用是 savepoint：内层失败只回滚内层，异常继续向外传播。回调必须同步，返回 thenable 视为错误并回滚。领域代码不得执行 `BEGIN`／`COMMIT`／`ROLLBACK`／`SAVEPOINT` 文本，DO 也禁止这些语句。
- **`changes`** 是该语句直接修改的行数，用于 CAS 判断；不得用 DO 的 `rowsWritten`（含索引写入）代替。DO 适配器在语句后读取 SQLite `changes()`，workerd 测试证明它与 Node 一致而 `rowsWritten` 更大（见第 6 节）。
- **BLOB 统一为 `Uint8Array`。** DO 返回的 `ArrayBuffer` 由适配器转换。
- **身份稳定。** 同一底层连接只对应一个 `SqlDatabase` 实例（Node 适配器以 `WeakMap` 缓存），因为 `AuthorityChanges` 与 `PermissionReadCache` 以连接对象作为分组身份。
- **借用作用域。** `scopedSqlDatabase()` 把 owner 连接借给 repository；借用方 `close()` 后，经它发出的调用（包括先前取得的语句）全部失败，owner 与其他借用方不受影响。
- **端口不包含** `close`、文件位置、PRAGMA 配置、备份或迁移执行。它们属于打开连接的 owner；迁移账本规则以端口之上的函数提供（见下），由 owner 调用。

#### 生命周期仍归 owner

迁移账本（`schema_migrations`、连续版本、SHA-256 校验）的语义是跨运行时的，唯一实现是 `@opencraft/sql/migrations`：`hashSqlMigrations`（哈希函数由 owner 提供，Node 与 workerd `nodejs_compat` 均用 `node:crypto`）、`validateMigrationHistory`（版本、名称或 checksum 不符拒绝为 `history-mismatch`，账本超出声明链拒绝为 `newer-schema`）、`applySqlMigrations`（每个待执行迁移一次 `transaction()`，在事务内重新校验账本，原样 `exec` 已发布 SQL，最后一个迁移在记录账本前执行可选 schema 校验）。owner 可传入自己的错误类型：`@opencraft/sqlite-node` 的 `prepareMigrations`／`validateHistory`／`applyMigrations` 委托这些函数并继续抛 `SqliteLifecycleError`，已发布 SQL、名称与 checksum 不变。DO owner 的精简生命周期是 `@opencraft/storage-node/server-sql` 的 `migrateServerSqlDatabase(database)`：只做上述账本与迁移，有对象但无账本的库拒绝采纳，返回 `{ database, outcome, contract }`，不含 `location`（见[InstallationCore 状态](cloudflare-deployment.md#5-installationcore-状态)）。下列能力属于 Node owner，保留在 `@opencraft/sqlite-node` 与 `@opencraft/storage-node`：

| 能力 | Node | DO |
| --- | --- | --- |
| 单写者 | `acquireProcessWriter`、`server.lock` | DO 单实例 |
| 迁移前备份 | `VACUUM INTO` 与恢复日志 | DO 时间点恢复（PITR） |
| 旧六库导入 | `ATTACH` 与 `.server-import/` | 不适用（新部署无旧库） |
| 迁移后 schema 校验 | `:memory:` 重放比对 | 待设计（DO 内不能另开数据库） |
| 连接策略 | WAL、`busy_timeout`、`foreign_keys` | DO 默认强制外键 |

#### 伴随 Worker 的位置

Node Headless 当前由 `Collaboration` 按数据库文件路径启动 `OrchestrationRuntimeWorker`。文件路径是 Node 拓扑事实，不属于 SQL 端口：`ServerDatabaseSource` 的对象形式以可选 `location` 显式携带它，只有 Node owner 填写。DO 中同一 owner 直接执行这些命令，不存在伴随 Worker。`@opencraft/storage-node/server-repository` 在 `workerd` 导出条件下解析为只接受 owner 句柄的实现（`repository.workerd.ts`），不引入 `node:sqlite` 与文件系统；两种实现共享 `repository-handle.ts` 的借用逻辑。

### 3.2 `StateDocumentStore`

`read(key)` 与 `update(key, change)`。`change` 同步执行，返回 `{ result }`（不写）或 `{ result, next }`（原子替换）；抛错则不写。同一键的更新串行。业务 revision、schema 版本与校验留在文档和所属仓储内，端口不再包一层记录格式。

不复用插件文档 API `DocumentPersistence`：它的 `{revision, version, value}` 记录格式会改变既有文件的磁盘格式。两者同属 `@opencraft/document-storage`，契约分开。

Node 适配器 `fileStateDocumentStore(directory)` 每键一个文件，保持原有缩进格式；跨进程在 `<file>.lock` 上以 Worker 持有的内核锁串行（见 [SQLite 生命周期](../server/sqlite-lifecycle.md) 锁文件段，旧版 proper-lockfile 进程被拒绝而非并发写）；同进程按绝对路径先排队，再取文件锁；写入经临时文件、fsync、rename 与目录 fsync（修正旧 `json-file.ts` 未 fsync 的问题）。

**跨 await 的不变量不能依赖端口锁。** 需要在提交前执行异步操作（例如写凭据）的仓储，必须把异步副作用设计成可被 CAS 安全丢弃。图片配置替换密钥时写入新的唯一引用，再由文档 CAS 切换指向，落败方删除自己的引用，成功后回收旧引用；已提交的声明只会指向为它写入的密钥。

已迁移：`models.json`、`image-generation.json`、Pi 的 `model-provider-bindings.json` 与旧 `models.json` 读取、`projects.json`、`server-information.json`（revision CAS 留在 `ServerInformationStore`）、`hub-network.json`（`documentHubStore`；进程单写者 `<file>.lock` 仍由 Node owner `HubStateFile` 持有，文档锁因此改用 `<file>.state-lock`；文件仍含节点 Ed25519 私钥，后续移入 `SecretStore`/KeyMaterial）。凭据文件不进入此端口，进入 `SecretStore`。

不进入此端口：`session-capabilities.json` 是进程端点发现而非存储；`readPrivateJson` 读取的部署输入与用户插件清单属于只读机密配置或安装产物。

事务性账本不是 KV 语义，按各自写入 owner 进入 SQL（2026-11-23）：

- `conversation-resources.json` → 服务器核心库（InstallationCore）表 `conversation_resources`＋导入回执 `conversation_resource_imports`（服务器迁移 v25 `0024_conversation_resources`）。领域 `conversationResourceMethods`（`@opencraft/storage-node/server-conversation-resources`）只依赖 `SqlDatabase`，Node 上在服务器核心 owner Worker 内执行，网络线程只持有已提交行的投影；归属理由见 [workspace-host-split §4.1](workspace-host-split.md#41-归属)。
- Git broker 账本（旧 PID 来源 broker 的 `ownerStateFile` JSON）：**暂不迁移**。服务端 `GitIdentityBroker`／`GitBrokerOwner` 当前无生产装配（见 [Git identity](../identity/git-identity.md#execution-attested-personal-git-protocol)），保留原 JSON 实现供下一代使用，不迁移也不退役；若将来迁移，它只能是 broker 进程独占的独立库，新增库一经发布即成为不可删除的迁移，届时再按实际装配决定。

`conversation-resources.json` 的导入规则：owner 打开时在一个事务内导入旧 JSON 并记录其 SHA-256（文件缺失记为 `absent`）；旧文件不改名、不再写入，保留为只读备份（回退旧版本时旧版本仍能读取导入前的快照）；导入回执存在而文件内容不同或导入时不存在、之后又出现（例如回退后旧版本又写过）、JSON 损坏或部分写入、记录不合法时拒绝启动且不导入任何行，由运维者处置后再启动。导入后删除备份文件不视为变化，照常启动。

### 3.3 `BlobStore`

`@opencraft/blob-storage`：不可变对象。`put(key, ReadableStream | Uint8Array, { maxBytes, sha256? })` 与顺序上传 `upload(key, { maxBytes })`（`write` / `complete({ sha256? })` / `abort`，完成前不可见）；`get(key, range?)`、`head(key)`、`delete(key)`。已存在的键拒绝写入；替换内容是写新键、在 owner 索引中切换引用、再删除旧键。`put`／`complete` 返回 SHA-256，读取不重新计算；摘要由索引 owner（通常是 SQL）保存。

Node 适配器 `fileBlobStore(root)` 每键一个私有文件，字节先写入 `root/.staging` 并 fsync，再以只创建的硬链接发布并 fsync 目录，键要么不存在要么完整。

已迁移：`ArtifactCatalog` 内容（键 `content/<ingestionId>`，与原路径相同；SQL 两阶段 ingestion 不变）与分块附件上传暂存。Host 的执行引擎与 `AttachmentRef` 的 `host-file` 位置按主机路径读取，所以 Host 使用 `HostFileBlobStore`（提交后的键仍是主机文件，并可取得其路径），这是 Host 部署的能力要求，不是通用契约。

未迁移：已提交附件保持 `<id>/content-<name>` 与 `manifest.json` 布局，因为路径属于协议、客户端草稿与 SSH 暂存契约，文件名可含任意 Unicode；按内容寻址的插件包、Web 发布资源与远程浏览器运行时副本留给 Cloudflare 装配阶段。

### 3.4 `SecretStore` 与 `KeyMaterial`

`@opencraft/secret-storage`：

- `SecretStore`：按名称 `get`／`set`／`delete`，无列举与批量读出；`stamp()` 是进程内随机密钥的 HMAC，只在密钥内容变化时变化，只能在同一进程内比较，不暴露凭据哈希。`documentSecretStore(stateDocuments)` 沿用 `credentials.json` 的 `{schemaVersion: 1, entries}` 格式。
- `KeyMaterial`：安装级密钥只创建一次，并发创建者收敛到第一份。`fileKeyMaterial(directory)` 读取失败即关闭：不跟随符号链接，要求属主为当前用户、无组与其他用户权限位。

已迁移：模型凭据（`ModelCredentialRepository` 包装 `SecretStore`，用户可见消息不变）、`session-capabilities.key`、`ssh/access.key`、文件服务 token，以及 Git vault key 的读取方。图片配置替换密钥仍用"新引用＋文档 CAS 切换＋回收"的设计，因为凭据与声明是两个存储。

Git vault key 由 `EmployeeGitVaultStore.open()` 异步解析：新库经 `KeyMaterial` 创建，已有库只读取，缺失即以 unavailable 失败。`credentials.json` 经 `fileSecretStore(directory)` 以私有读取模式打开，权限不安全或为符号链接时拒绝并提示用户。

后续：只读运营配置（`readPrivateJson`）在 Cloudflare 上对应 Secrets binding。

决定：`hub-network.json` 中的节点私钥不拆出。该文档已按私有读取模式打开（不跟随符号链接，同一句柄校验属主与权限），拆出私钥会让回退到旧版本的节点丢失身份；Cloudflare 上它随 Hub 状态存入 owner DO 并按 `SecretStore` 的方式加密。

### 3.5 不进入存储端口

Unix socket、锁文件、`/proc` 读取、Git 与 `/workspace` 工作目录、Electron profile、Codex 原生 home 与 rollout、主机文件 RPC。它们是容器或本机内部资源，由执行环境 owner 管理。Codex、Pi、DSH 引擎自身的 SQLite 随引擎运行在 Node 容器内，不迁移到 SQL 端口。

### 3.6 WorkspaceHost 侧存储

状态：2026-11-24 实施（[gateway-split §4.2](gateway-split.md) 存储行）。领域模块只依赖 `SqlDatabase`；Node 外壳保留原导出、构造签名、库文件、迁移与 checksum；网络主线程同步 IO 只减少。

| 存储 | 唯一写者与线程 | 跨进程／线程读者 | 迁移与账本 | 领域（中立） | Node 外壳 |
| --- | --- | --- | --- | --- | --- |
| thread directory：`opencraft_thread_catalog`、`opencraft_catalog_sync` | 借用 owner 连接的 `ThreadDirectory`：本机 Host 的 `ThreadCatalog`（`opencraft-threads.sqlite`，schema `thread-catalog`）或 Daemon 的 `OpenCraftHostStateDatabase`（`opencraft-host-state.sqlite`），均在各自进程主线程（已登记） | 快照 Worker `snapshot-reader.ts` 在同一文件上只读打开，只把分页结果交回网络线程 | 归连接 owner（`thread-catalog`／`opencraft-host-state-database`） | `SqlThreadDirectory`（`thread-directory/index.ts`，导出 `./thread-directory/domain`）：分块提交经 `transaction()`（原手写 `SAVEPOINT`）；计数票据的读保护可注入，缺省 `connectionReadGuard` 以 `total_changes()` 判定单连接 owner（DO、内存库）的提交；无快照读者时快照来自内存索引 | `thread-directory/node.ts`（导出 `./thread-directory`，`ThreadDirectory(connection, port, now, intervalMs)` 不变）：`nodeSqlDatabase`、`captureSqliteReadGuard`（`data_version` 也看见其他连接的提交）与文件型快照 Worker |
| 员工 Git vault：`employee-git-vault.sqlite` | 无单一写者：Assets 存储 Worker（`plugins/assets/src/server/storage.ts`）与执行 owner（`ExecutionEnvironmentRuntime.open()`：engine／ACP Host、本机 DSH 插件）各自经 `EmployeeGitVaultStore.open()` 打开同一文件，写入由 SQLite 写事务串行、修订号 CAS 判定；DO 装配时须收敛为一个 owner 对象，其余改为 RPC | 容器 Git broker 的 `personal-git-worker.ts` 只读打开并自行解密 | 归 vault owner（schema `employee-git-vault-store`，`stores.json` 的 owner 指向 `.node.ts`） | `EmployeeGitVault`（`employee-git-vault-store.ts`，导出 `./employee-git-vault`）：行、修订号 CAS、墓碑、命名空间与执行上下文信封；加解密与个人 Git 授权经 owner 注入的 `GitVaultCipher`，领域不接触密钥；base64url 自带编解码；写入经 `transaction()`（原手写 `BEGIN IMMEDIATE`） | `employee-git-vault-store.node.ts`（导出 `./employee-git-vault-store`，`EmployeeGitVaultStore.open(directory)` 不变）：0700 目录、0600 NOFOLLOW 文件与属主校验（改用异步 `fs/promises`）、`KeyMaterial`、`openManagedDatabase`、`nodeGitVaultCipher`（AES-256-GCM，`iv‖密文‖tag` 布局不变，旧行可读） |

不迁到 SQL 端口的 Node 专属读者：它们读取其他 owner 的库文件，Cloudflare 上应改为向该 owner 的 RPC，而不是在另一个 DO 里打开同一份数据。

- `ExecutionEnvironmentRuntime.execution()`（`execution-environment.ts`）只读打开 Daemon 或 thread identity 的执行租约库，取得原始执行来源。
- 个人 Git（容器 Git broker Worker）：`git-identity-origin.ts` 读 Codex registry 并经 `/proc` 校验进程来源；`git-execution-authority.ts` 读执行租约库与 `opencraft-server.sqlite` 的主体绑定；`personal-git-worker.ts` 只读 vault 并用 `KeyMaterial` 解密，经 Unix socket 服务。
- thread directory 的快照 Worker（见上表）。

验证：`tests/storage/workspace-stores-workerd.test.ts`（`test:storage-ports:workerd` 与 Cloudflare 演练组 `workspace-stores`）对两个领域模块做中立平台打包检查（无 `node:*`、`Buffer`、`sqlite-node` 与 Node 外壳）；两条迁移链经中立账本运行，与 Node owner 的账本和 schema 相同；thread directory（含与不含连接内执行投影）与 vault 的同一操作序列在 DO SQL 与 `nodeSqlDatabase` 上逐项相同（含失败分块整体回滚、读保护失效、外层事务回滚 vault 写入）；vault 行跨对象重启保留。DO 上的 vault 测试使用测试密钥的 AES-GCM；生产 DO 的密钥来源（`KeyMaterial` 或 Secrets binding）随装配决定。

### 3.7 插件与扩展存储

状态：2026-11-24 实施（[gateway-split §4.2](gateway-split.md) 存储行）。领域模块只依赖 `SqlDatabase`；Node 外壳保留原导出、构造签名、库文件、迁移与 checksum；网络主线程同步 IO 只减少。

| 存储 | 唯一写者与线程 | 跨进程／线程读者 | 迁移与账本 | 领域（中立） | Node 外壳 |
| --- | --- | --- | --- | --- | --- |
| 登录准入：`login-admission.sqlite` | Headless 网络进程的登录准入存储 Worker（`login-admission.worker.ts`，经 `@opencraft/worker-owner`）；网络线程的 `LoginAdmissionPolicy` 只发消息，`history` 走并发读通道 | 无 | 归该 owner（schema `login-admission`，`stores.json` 的 owner 仍是 `store.ts`） | `SqlLoginAdmissionStore`（`sql-store.ts`，导出 `./sql-store`）：发布 CAS、版本与审计、已验证身份、按来源一次性导入；写入经 `transaction()`（原手写 `BEGIN IMMEDIATE`） | `store.ts`：`LoginAdmissionStore(path)` 为 `openManagedDatabase`＋`nodeSqlDatabase`，`openLoginAdmissionStore` 与 Worker 协议不变 |
| thread participants：`ioa_message_presence`、`ioa_participant_state`、`ioa_thread_creators`、`ioa_presence_sync` | 参与者存储 Worker（`thread-participants.worker.ts`）是这四张表唯一写者；它借用连接 owner 已迁移的 WAL 文件（Hub 的 `thread-identity.sqlite` 或 Daemon 的 `opencraft-host-state.sqlite`），与在主线程写 `message_senders` 的 `ThreadIdentity` 由 SQLite 写事务与 `busy_timeout` 串行 | 连接 owner 读同一文件；Worker 只读 `message_senders`／`message_sender_origins` | 归连接 owner（`thread-identity-database`／`opencraft-host-state-database`），插件不迁移 | `SqlParticipantStore`（`sql-participant-store.ts`，导出 `./sql-participant-store`）：投影、修订号、首个创建者；写入经 `transaction()`；回滚失败（失败后事务仍开）经注入的 `unrecoverable` 报出 | `participant-store.ts`：只读探测 WAL 与表、`DatabaseSync`＋`busy_timeout`、`nodeSqlDatabase`，回滚失败映射为 `WorkerOwnerFatal`。DO 上这些表与 thread identity 同属一个 owner 对象，直接在它的 SQL 上执行，不另开连接 |
| tasks：`tasks.sqlite` | 每个数据目录一个 owner：Local Agent Host 启动时打开（`openLocalAgentStorage`）或 Codex 功能私有 owner（`TasksService` 惰性打开），均在各自进程主线程（已登记） | 无 | schema `tasks`；`stores.json` 的 owner 改指 `node-store.ts` | `SqlTasksStore`（`sqlite.ts`，导出 `./sql-store`）：任务、会话关联、事件、成员目录；事件 id 用全局 Web Crypto `crypto.randomUUID()`；外键由连接强制（node:sqlite 默认 `enableForeignKeyConstraints`，DO 始终强制），冗余的 `PRAGMA foreign_keys=ON` 删除 | `node-store.ts`（导出 `./sqlite` 不变：`TasksSqliteStore(path, now)` 并再导出领域）：`openManagedDatabase`（`legacyPolicy: "reject"`，schema 校验 SQL 由 `TASKS_MIGRATIONS` 依次拼接，与原五段相同） |
| 扩展文档：`extension_records`（Host 的 `opencraft-host-documents.sqlite`） | Local Agent Host 主线程的 `HostDocumentService`（已登记）；借用连接时归出借方 | 无 | schema `document-storage`；`stores.json` 的 owner 改指 `node-store.ts` | `SqlDocumentStore`（`sqlite.ts`，导出 `./sql-store`）：revision CAS、格式降级拒绝；revision 不符时原为 `ROLLBACK`，现为不写入的事务提交 | `node-store.ts`（导出 `./sqlite` 不变：`openDocumentDatabase`、`SqliteDocumentStore(path \| BorrowedDatabase)`） |

tasks 与扩展文档的领域留在原文件（SQL 语句的主线程登记随文件保留并减少），Node 外壳是新文件；登录准入与 thread participants 只在 Worker 中运行，领域是新文件。

不迁到 SQL 端口：

- `document-storage/client-resources-sqlite.ts`：已退休的桌面独立文件，只由 Electron Main 的客户端存储导入读取，是客户端本机数据，不是部署级存储。
- `native-history-node` 转录缓存（`transcript-index.sqlite`）：属于 §3.5 的容器内部资源。它是 Codex 原生 rollout 在执行容器内的可丢弃投影，SQLite 只是 `cache/transcripts/*.turns.jsonl` 与 blob 文件的偏移索引，与文件追加、按偏移读取、inode 校验以及损坏即删除重建一体；Cloudflare 上原生 rollout 本身在工作区容器内，缓存随容器运行。它已在专属 Worker（`transcript-cache-storage.worker.ts`）内，不占网络主线程。

验证：`tests/storage/extension-stores-workerd.test.ts`（`test:storage-ports:workerd` 与 Cloudflare 演练组 `extension-stores`）对四个领域模块做中立平台打包检查（无 `node:*`、`Buffer`、`sqlite-node`、`worker-owner` 与 Node 外壳）；各 owner 的已发布迁移链经中立账本运行，与 Node owner 打开的文件账本和 schema 相同（thread participants 用 thread identity 链）；同一操作序列（含 CAS 冲突、错误码、外层事务回滚、外键拒绝）在 DO SQL 与 `nodeSqlDatabase` 上逐项相同；写入的行与账本跨对象重启保留且不重放迁移。

## 4. 分阶段

1. **SQL 端口与 Node 适配器（服务器核心数据）。** 新增 `@opencraft/sql` 与一致性测试；`@opencraft/sqlite-node` 提供 `nodeSqlDatabase()`；`ServerDatabaseSource`／`openServerRepository()` 改为交付 `SqlDatabase`；`access-control` 的领域类、函数与 `CommunicationExtension` 插件契约不再依赖 `DatabaseSync`；手写事务改为 `transaction()`；`Collaboration` 不再从连接推导文件路径。
2. **`StateDocumentStore`、`BlobStore`、`SecretStore`／`KeyMaterial` 与 Node 适配器（已实施）**，迁移第 3.2–3.4 节所列使用方；剩余项见各节"未迁移"与"后续"。
3. **沙盒 provider 泛化（已实施）**：`@opencraft/sandbox/broker` 持有共享 broker 程序与帧解析，`@opencraft/sandbox/providers` 提供 provider 注册（部署装配显式注册，未知 backend 拒绝执行）与可选 `PersistentWorkspaceProvider`；安装配置与凭据按 `backend` 分型，缺省 `backend` 的 schemaVersion 1 安装文件与 version 1 凭据仍为 E2B，修订摘要不变。目前只实现 E2B provider。见[执行沙盒](../execution/execution-sandbox.md#provider-registry-shared-broker-and-persistent-workspaces)。
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

## 6. Cloudflare 适配器（第 5 阶段，本地 workerd 验证）

`@opencraft/storage-cloudflare` 只依赖契约包，并以 `src/bindings.ts` 声明所消费的 workerd 绑定结构子集，不导入 `cloudflare:*` 或 `@cloudflare/workers-types` 全局类型。部署装配把真实的 `ctx.storage`（SQLite-backed DO）与 R2 bucket 传入。

验证：`npm run test:storage-ports:workerd` 用 esbuild 打包 `tests/storage/workerd/conformance-worker.ts`，在 Miniflare（`miniflare@4.20260730.0`，内置 `workerd@1.20260730.1`，兼容日期 `2026-07-30`）的 SQLite-backed DO 与本地 R2 中运行 `SQL_CONFORMANCE_CASES`、`STATE_DOCUMENT_CONFORMANCE_CASES`（含损坏文档用例）、`SECRET_CONFORMANCE_CASES` 与 `BLOB_CONFORMANCE_CASES`，每个用例使用新的 DO 实例或 R2 前缀；另有语义探针。全程内存存储、无网络、无 Cloudflare 账号；本地 workerd 不等于生产 Cloudflare，生产行为仍需在第 6 阶段装配时复核。尚未加入 `gate`。

| 端口 | 结果 | 实现与保证 |
| --- | --- | --- |
| `SqlDatabase` | 10/10 | 语句每次执行 `sql.exec`；`run()` 先读完游标，再读 `SELECT changes()`。`transaction()` 调用 `transactionSync`，workerd 中嵌套调用即 savepoint（内层失败只回滚内层，外层失败丢弃已完成的内层）；返回 thenable 时在回调内抛出 `SqlAsyncTransactionError` 使其回滚。`inTransaction` 由适配器计数。BLOB 的 `ArrayBuffer` 转为 `Uint8Array`；`WeakMap` 保证每个 storage 对象一个端口对象。 |
| `StateDocumentStore` | 8/8 | 文档 JSON 文本存于同步 KV 的 `state/<key>`；读-改-写在一次 `transactionSync` 内完成，DO 单线程使同键更新串行；返回前 `await storage.sync()`。 |
| `SecretStore`／`KeyMaterial` | 5/5 | 密钥沿用 `documentSecretStore`，文档位于独立前缀 `secret/credentials.json`；安装密钥存于 `key/<name>`，`ensure` 在 `transactionSync` 内检查并创建。目前依赖 DO 平台静态加密，尚未用 Secrets binding 中的密钥做信封加密，这是装配阶段的后续步骤。 |
| `BlobStore` | 6/6 | 边接收边用 `crypto.DigestStream` 计算 SHA-256，最多缓存一个分片（默认 8 MiB，R2 要求非末分片至少 5 MiB 且等长）。单分片内的对象用一次 `put`，带已校验的 `sha256`（R2 复核）与 `onlyIf: { etagDoesNotMatch: "*" }`，已存在的键由 R2 原子拒绝。更大的对象走 multipart：`complete()` 前不可见，大小与摘要先校验，失败或放弃即 abort（未 abort 的由 R2 未完成上传生命周期回收）。范围读取到末尾之后或长度为 0 时，R2 报 416，适配器按契约返回空内容。 |

已知差距与契约建议：

- **multipart 的已存在键拒绝不是 R2 原子条件。** Workers binding 的 `R2MultipartUpload.complete()` 不接受条件（S3 API 的 `CompleteMultipartUpload` 支持 `If-None-Match: *`）。适配器在同一 store 实例内按键串行执行 `head`＋`complete`，同一 owner 的并发写入只会成功一个（已由 workerd 测试覆盖）；owner 之外的写入者仍可竞争。由于 Blob 键由索引 owner 分配且每个前缀只属于一个 owner，契约已写明"已存在键的拒绝针对已提交对象与同一 owner 的并发写入；跨 owner 写同一键不属于端口语义"，一致性测试未削弱；若 binding 将来支持完成条件，改为原子条件。
- **整数范围**：见第 3.1 节；建议把"INTEGER 限于安全整数"写入 SQL 契约，并为 Node 与 DO 都增加"绑定范围外 `bigint` 被拒绝"的一致性用例；读取侧的静默取整无法由 DO 适配器检测，只能由数据约定避免。
- **`stamp()` 的进程范围**：workerd 中等价于 isolate；DO 被逐出后 stamp 会变化，符合"只在同一进程内比较"。HMAC 密钥改为首次使用时生成，因为 workerd 禁止在全局作用域生成随机值。

## 7. AccountCore 存储

状态：**Node 侧准备已实施；DO 部分实现（2026-11-24）：模型策略、模型配置、密封凭据与凭据租约已在 `AccountCore` DO 中装配（[可选 Cloudflare 部署 §5.6](cloudflare-deployment.md#56-accountcore-状态2026-11-24)），账号池与模型网关未进入。** 目标是让[可选 Cloudflare 部署](cloudflare-deployment.md#2-目标拓扑)中每部署一个的 `AccountCore` DO 直接持有现有领域代码；Node 行为、文件名、格式、权限、迁移与 checksum 均不变，写者锁与 owner 进程拓扑保持原样。行号以 2026-11-22 源码为准。

### 7.1 持久化清单

| 位置 | 持有 | 归类 | 现状 |
| --- | --- | --- | --- |
| `$DATA/codex/account-pool.sqlite`：`packages/account-pool-host/src/store.ts:134`（`openManagedDatabase`，schema `account-pool-host`） | 账号、配额、亲和、活动账号、`owner_actor` | SQL 端口 | 领域类 `AccountPool`（`account-pool.ts:282`）只依赖 `SqlDatabase`；事务经 `transaction()`（`account-pool.ts:853`），手写 `BEGIN IMMEDIATE`／`COMMIT` 已删除。迁移 v1–3 文本移到 `account-pool-schema.ts`（runtime-neutral，`check:storage` 经导入绑定读取），v4 仍来自生成注册表；`PRAGMA foreign_keys=ON` 与无账本旧库采纳（`legacyAccountPoolMigration`，需 `:memory:` 对照库）留在 Node owner |
| `secrets/account-<id>.json`（托管 OAuth 凭据或外部 `auth.json` 引用）与 `secrets/host-<sha256>.json`（Host／调用方 token）：`store.ts:72` | 凭据记录 | 凭据记录端口 `AccountCredentialRecords`（`account-pool.ts:220`） | Node 适配器 `fileAccountCredentialRecords()` 保持 0700 目录、0600 文件、临时文件＋rename 原子写、删除时的 tombstone 回滚 |
| 外部 `auth.json`（`codex login` 写入，运维者持有） | 引用目标，只读 | Node 专属 | 经 `readExternalFile()`；DO 适配器应拒绝（外部共享文件只存在于主机） |
| `$DATA/model-gateway.sqlite`（`OPENCRAFT_MODEL_GATEWAY_DATABASE`）：`model-gateway-store.ts:84` | 准入账本、限额、贡献、执行授权、计量 | SQL 端口 | `ModelGatewayStore` 领域方法只依赖 `SqlDatabase`；构造参数可为路径（Node owner，含 `busy_timeout=5000`）或已迁移的 `ModelGatewayDatabase` |
| `model-usage-policy.sqlite`：`packages/model-usage-policy/src/index.ts:11` | 模型使用策略与审计 | SQL 端口 | 同上，`ModelPolicyStore` 接受路径或 `ModelPolicyDatabase`；`write()` 改为 `transaction()` |
| `native.mjs:22、45` 的只读 `DatabaseSync` | Daemon／DSH 插件跨进程读取策略与网关贡献 | Node 专属（消费方） | 不迁移；Cloudflare 上改由 AC 投影或 RPC 提供 |
| `.codex-writer.sqlite`／`.codex-runtime.sqlite`：`codex-writer-lock.ts:14` | 内核释放的 `BEGIN EXCLUSIVE` 写者锁＋`/proc` 扫描 | Node 专属进程所有权 | 保留；DO 的单实例语义替代 |
| `account-handoff.json` 与只读封存检查：`apps/codex-core/src/account-owner.ts:96、164` | 围栏交接状态、`boot_id`／PID、物理文件摘要与权限校验 | Node 专属进程所有权 | 保留；只读快照需要 deferred `BEGIN`，不适用 `transaction()`（写事务） |
| `run/proxy-callers/<caller>.json`：`codex-account-service.ts:166` | 本机调用方（Pi／DSH）的代理 URL 与 token | Node 专属发布 | 保留；Cloudflare 上 token 经边缘 Worker 签发 |
| `refresh/`、`login/`、`personal-logins/<sha>/`、`device-login-maintenance/`：`codex-account-service.ts:73–87`、`codex-auth.ts`、`device-login-maintenance.ts` | 刷新与设备登录的临时 `CODEX_HOME`、恢复导入、维护注记 | Node 专属（原生 codex 进程工作目录） | 保留；见 7.3 |

未改用 `SecretStore`：它是异步、按名称的单文档（`credentials.json`），既不能保持每账号文件布局，也不能在选号的同步 SQL 事务内读取凭据。因此新增同步的 `AccountCredentialRecords`；DO 适配器应把凭据记录存入同一 DO 的 SQL 表，用 `KeyMaterial`（或 Secrets binding）派生的密钥做信封加密，使"预留亲和＋读取凭据""写入行＋写入凭据"在同一存储事务内完成。

### 7.2 验证

`tests/storage/account-pool-sql-port.test.ts`（已加入 `test:storage-ports`）把同一组用例分别跑在 Node 文件 owner（`AccountPoolStore`）与"`nodeSqlDatabase(:memory:)`＋`@opencraft/sql/migrations` 精简账本＋内存凭据记录"上：账号与凭据、选号与亲和、配额耗尽轮换、删除级联、Host token、Human owner 隔离；另验证凭据写入失败时账号行经端口事务回滚、精简账本与托管 owner 的 schema 指纹相同、非法设置会关闭交入的存储。尚未在 Miniflare DO 中运行。

### 7.3 阻碍 DO 的 Node 依赖

| 依赖 | 位置 | 处理建议 |
| --- | --- | --- |
| `node:http` 监听（账号代理 HTTP 服务）、`undici` Agent | `server.ts`、`codex-proxy.ts` | 保留在 Node；Cloudflare 上由边缘 Worker 接收模型请求，向 AC 取短期凭据租约后直接流式转发（cloudflare-deployment §2.1） |
| `child_process` 启动 `codex app-server --stdio` 完成 OAuth 刷新、设备登录与用量查询 | `codex-maintenance-client.ts`、`codex-auth.ts` | 已决定（2026-11-22）：交给容器代办。AC 仍是刷新、选号与凭据写入的唯一 owner；OAuth 刷新、设备登录与用量查询由按需启动的维护容器内的原生 codex 执行，结果经受认证通道交回 AC 提交。不在 AC 内重新实现未公开的登录协议。容器只获得本次操作所需的短期材料，不长期持有凭据 |
| `node:fs`：临时 `CODEX_HOME`、外部 `auth.json`、调用方 token 发布、维护注记 | `codex-auth.ts`、`codex-auth-file.ts`、`codex-account-service.ts`、`device-login-maintenance.ts` | 外部共享凭据与本机调用方文件只在 Node 声明；其余随上一项改造消失 |
| `node:sqlite` 写者锁、`/proc`、`boot_id`、PID 围栏交接 | `codex-writer-lock.ts`、`account-owner.ts`、`operator-lease.ts`、`split-core.ts` | 保留在 Node；DO 单实例与输入门替代写者锁与交接 |
| Unix socket 控制面（`node:http` 请求） | `codex-core-control.ts`、`apps/codex-core/src/main.ts` | 保留；DO 以 RPC 暴露同一操作集合 |
| `setInterval`／`setTimeout`（用量轮询、设备码过期、诊断） | `codex-usage.ts`、`codex-auth.ts`、`server.ts`、`split-core.ts` | DO 中改由 alarm |
| `node:crypto`、`Buffer`、`node:zlib`（`configured-forward.ts` 解压） | 多处 | `nodejs_compat` 预期可用，待在 workerd 中核实 |
| `@opencraft/sqlite-node` 值导入 | `store.ts`、`model-gateway-store.ts`、`model-usage-policy/src/index.ts` | `AccountPool` 已与 Node owner 分文件；网关与策略的 owner 打开仍与领域类同文件，DO 装配前需拆分或加 `workerd` 导出条件 |

DO 仍缺：账号池与网关在同一对象 SQL 中的按 schema 账本（策略库已用 `migrateModelPolicySqlDatabase` 的精简生命周期占用默认账本）、同步的加密凭据记录适配器（`sealedSecretStore` 是异步的，不能在选号事务内使用）、刷新执行方式（维护容器）的实现、租约的对外接口（契约已在 `@opencraft/account-pool-host/credential-leases`）。
