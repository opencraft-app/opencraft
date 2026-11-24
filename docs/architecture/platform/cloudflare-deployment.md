# 可选 Cloudflare 部署

[Architecture index](../README.md) · [存储端口](storage-ports.md) · [执行沙盒](../execution/execution-sandbox.md) · [Docker 三角色部署](../../../deploy/docker/README.md)

状态：目标设计。Cloudflare Containers 的平台能力已做真实探测（2026-11-23，结论见[工作区拆分 §3.6](workspace-host-split.md#36-部署形态统一建模)）；`sandbox-cloudflare` provider 已实现并在真实 Cloudflare 上预演通过（第 7.5 节），`WorkspaceHost` 已有正式 DO 装配的第一部分（Host SQL、容器生命周期、Engine Host 输入、空闲、中断恢复与凭据租约调用点，本地 workerd 以容器替身验证，见第 5.7 节）。存储端口的 Cloudflare 适配器已在本地 workerd 中通过一致性测试（见[存储端口第 6 节](storage-ports.md#6-cloudflare-适配器第-5-阶段本地-workerd-验证)）；`InstallationCore` 已有正式 DO 装配（身份与准入部分，本地 workerd 验证，Wrangler 模板未部署，见第 5 节），`RelayHub` 仍是仅限测试的本地 workerd 原型（见第 6 节）；本页不代表任何 Cloudflare 组件已在真实账号上部署或可用于生产。Node 自托管（Docker／systemd／Electron）始终是一等公民；Cloudflare 是部署装配选项之一，不替换 Node 路径。

## 1. 现状约束

- 现有 Docker 部署已拆为 `gateway`（准入、认证、路由）、`brain`（Codex AppServer、DSH、Pi 与任务生命周期）、`hands`（`exec-server`、终端、文件、浏览器）。
- **Codex AppServer 是原生 `codex app-server` 二进制**，DSH、Pi、ACP 也是子进程，需要 POSIX 文件系统与 PTY。它们不能在 workerd 中运行，只能在容器中运行。
- **Gateway 不是无状态的**：Codex Host 层状态（queue、schedules、中断恢复、tasks、token usage）由 Gateway 进程内的 `CodexEngineAdapter` 写入 `$DATA/codex/`。
- 账号 Core（`apps/codex-core` 的 split core 与 `packages/account-pool-host`）持有账号池、OAuth 刷新、模型代理与计量，是部署级单写者。
- 沙盒内的 Codex `exec-server`、文件、终端与浏览器 owner 全部经 stdio 传输，沙盒不需要入站端口。
- Cloudflare Sandbox SDK **不兼容 E2B API**；接入方式是实现 `@opencraft/sandbox` 端口的新后端，而不是复用 E2B SDK。`sandbox-cloudflare` 作为 `@opencraft/sandbox/providers` 的一个 provider 注册，由 WorkspaceHost DO 持有容器，经 `ctx.container.exec` 启动并承载 `@opencraft/sandbox/broker`，命名端点优先容器原始 TCP；工作区内容以 Git 为真源，容器快照只是可选加速能力（[工作区拆分 §3.7](workspace-host-split.md#37-工作区持久化与空闲设计2026-11-23-用户决定未实现)）。该 provider 已实现（`@opencraft/sandbox-cloudflare`，命名端点经中继；原始 TCP、快照与 `sleep` 未做），现状与剩余项见工作区拆分 §3.6"实现现状"与 §7。

## 2. 目标拓扑

| 组件 | 载体 | 持有 |
| --- | --- | --- |
| 边缘 Worker | Workers＋静态资源 | Web 资源、登录与 OIDC 入口、webhook 接收、WebSocket 路由到 DO、模型请求流式转发 |
| `InstallationCore` | 每部署一个 DO | 服务器核心 SQL（现由多条连接共同打开的库合并为单一 owner）、成员与授权投影、Hub 节点状态 |
| `RelayHub` | 每 installation 一个 DO | 隧道与流预算，替代 Redis 租约与节点间转发（本地原型见第 6 节） |
| `AccountCore` | 每部署一个 DO | 账号池、加密凭据、OAuth 刷新单写者、选号与亲和、计量与策略 |
| `WorkspaceHost` | 每工作区一个 DO | Codex Host 状态（queue、schedules 以 DO alarm 实现、中断恢复、tasks、token usage）；工作区容器生命周期与连接（第一部分已装配，见 5.7） |
| 工作区容器 | 每工作区一个 Container，由 `WorkspaceHost` 持有 | Brain 与 Hands 同处：`codex app-server`、Pi、DSH、`exec-server`、终端、文件、浏览器；独立 `CODEX_HOME`；容器磁盘是缓存，工作区内容以 Git 为真源，可选容器快照加速恢复；默认空闲 15 分钟休眠 |

### 2.1 模型请求与凭据

工作区容器内不保存任何模型或账号凭据。引擎的模型请求由出站处理交给边缘 Worker；Worker 向 `AccountCore` 获取短期凭据租约后直接流式转发给 provider。长时间流式响应不占用 DO 运行时长，凭据只在 Worker 请求内存中短暂存在。`AccountCore` 仍是刷新与选号的唯一写入者。

协议转换（例如 Anthropic）代码需确认能在 workerd 中运行后才可迁移到 Worker。

`AccountCore` 的存储准备（SQL 端口、凭据记录端口、持久化清单与 Node 专属阻碍）见[存储端口第 7 节](storage-ports.md#7-accountcore-存储)。

### 2.2 工作区容器

- 镜像沿用已发布 Hands 镜像（按 digest 固定），追加 Brain 运行时；不在容器启动时下载工具。
- Brain 与执行用户使用不同 UID；凭据不进入容器文件系统。
- 容器回收或重启时，引擎进程终止；恢复沿用[中断 Turn 恢复](../execution/interrupted-turn-recovery.md)，由 `WorkspaceHost` 持有的 Host 状态驱动，不重放未确认输入。
- 持久化语义已决定（2026-11-23）且与 provider 无关：Git 是工作区内容的真源，容器磁盘（含 `CODEX_HOME`）随 `destroy()`／崩溃丢失，是可重建缓存；`snapshotContainer` 作为 `captured` 快照能力只用于加速恢复（平台 beta、30 天 TTL、Worker API 不可删），不作兜底；未提交改动可能随化身丢失。契约与对账规则见[工作区拆分 §3.7](workspace-host-split.md#37-工作区持久化与空闲设计2026-11-23-用户决定未实现)。
- 空闲：WorkspaceHost 判定空闲后停止容器（默认 15 分钟，可配置常驻）；容器 inactivity timeout 只作兜底，且每次 DO 构造都要重设（已实现，见 5.7）。

## 3. 前置工作

依赖[存储端口](storage-ports.md)第 1–4 阶段：SQL 等存储端口、沙盒 provider 泛化，以及 Gateway／Brain 按工作区拆分。这些改动先在 Node 上成立。

## 4. 待 PoC 验证

| 项 | 需确认 |
| --- | --- |
| 进程 stdin | **已在真实 Cloudflare 回答（2026-11-23）**：`ctx.container.exec` 流式 stdin 有真实背压，PTY 与退出码可用；broker 可直接由 exec 承载，不需要容器内服务 |
| 镜像 | Hands＋Brain 镜像是否在 20 GB 上限内；是否允许任意基础镜像；架构限制 |
| 浏览器 | Chromium 沙盒在容器隔离模型下是否可用 |
| 生命周期 | **已探测**：`monitor()` 报告崩溃与退出码、不自动重启；`destroy()` 100–930 ms；自定义 4 vCPU／8 GiB 被接受，容器内 `pids.max`／nofile 不受限（由 agent 设置）；DO 驱逐与代码部署后可重连同一容器；inactivity timeout 生效（单样本早于设定）。最长运行时间未测 |
| 持久化 | **已决定**：Git 为真源，`snapshotContainer` 为可选加速（2.4 s 捕获、498 ms 恢复）；R2 FUSE 不采用为工作区真源 |
| SQL 语义 | **已在本地 workerd（`workerd@1.20260730.1`）回答**：`SELECT changes()` 返回语句直接修改的行数，与 Node 一致；游标 `rowsWritten` 含索引与触发器写入（带索引和审计触发器的表上，修改两行的 UPDATE 为 6），不能用于 CAS。嵌套 `transactionSync` 是 savepoint：内层抛错只回滚内层，外层抛错丢弃全部。多语句 `exec` 依次执行全部语句。`sqlite_master` 与 `PRAGMA foreign_keys`（值为 1）可读。`BEGIN`／`SAVEPOINT`／`COMMIT` 文本被拒绝。BLOB 以 `ArrayBuffer` 返回；`bigint` 不能绑定，范围外 INTEGER 读取时静默取整。`SQL_CONFORMANCE_CASES` 全部通过。2026-11-23 已在真实 Cloudflare 上以相同探针复核，结果一致（见第 7 节） |
| 网络 | **已探测**：`enableInternet:false`＋`interceptAllOutboundHttp` 时 HTTP 全部交给 Worker entrypoint（可带每工作区 props），HTTPS 失败；HTTPS 拦截需容器信任平台 CA（未测）。WH DO 到容器：exec 中继或原始 TCP，WebSocket 无背压不采用 |
| 成本 | **已探测**：冷启动中位约 0.6 s（部署后首次 3.9 s）；4 vCPU／8 GiB／20 GB 运行约 0.11–0.37 美元／小时，空闲常驻约 75 美元／月，休眠不计费 |

单实例资源上限为 4 vCPU／12 GiB／20 GB 磁盘，满足当前默认 4 vCPU／8 GiB 契约（自定义实例类型实测被接受）。仍待验证：镜像大小与架构、浏览器沙盒、HTTPS 出站拦截。

## 5. InstallationCore 状态

状态（2026-11-24）：**正式 DO 装配（身份与准入部分），本地 workerd 验证，未部署到真实 Cloudflare**。`InstallationCore` 类在 `apps/headless-server/src/cloudflare/installation-core.ts`，部署入口 `worker.ts`，结构绑定 `bindings.ts`，Wrangler 模板 `deploy/cloudflare/wrangler.installation-core.jsonc`；装配方式见 5.5。它与 Node 根调用同一个 installation 模块（`apps/headless-server/src/assembly/installation.mjs`）的同一组 `open*` 步骤，不在 DO 里另写领域代码。验证：`npm run test:installation-core:workerd`（`tests/storage/installation-core-workerd.test.ts` 的迁移与端口场景，加上 `tests/storage/installation-core-do-workerd.test.ts` 的正式 DO 场景）经 esbuild（`workerd` 导出条件）打包、在 Miniflare（`workerd@1.20260730.1`，兼容日期 `2026-07-30`，`nodejs_compat`）中运行，已在 `npm test`、`gate` 与 CI `core-tests`；无网络、无 Cloudflare 账号。原测试原型 `tests/storage/workerd/installation-core-worker.ts` 保留为迁移与领域端口的对照夹具；迁移场景另由 `npm run cf:rehearsal` 在真实 Cloudflare 上运行过（第 7 节），正式 DO 分组尚未在真实账号上运行。

### 5.1 已证明

- **精简生命周期**：DO 在 `blockConcurrencyWhile` 内执行 `migrateServerSqlDatabase(durableObjectSqlDatabase(ctx.storage))`（`@opencraft/storage-node/server-sql`），只做账本校验、checksum 拒绝和按序迁移（每个迁移一次 `transaction()`）；不含进程锁、`VACUUM INTO` 备份、`ATTACH` 旧六库导入、替代谱系采纳与 `:memory:` 校验器（见[存储端口 3.1](storage-ports.md#31-sqldatabase)）。账本规则与 Node `openManagedDatabase` 是同一份实现（`@opencraft/sql/migrations`）。有对象但无账本的库被拒绝而非采纳（`_cf_` 前缀的 workerd 内部表除外）。打开失败时对象保持关闭，之后每个请求都以 503 `installation_unavailable` 拒绝，不读旧状态。
- **迁移与领域端口（原型夹具）**：新对象应用全部 22 个已发布 Server 迁移，schema（含触发器）与 node:sqlite 全新库逐项相同；在持久化存储上重启后结果为 `up-to-date`，账本逐行不变；改写一行 checksum 后重启被拒绝；只装前 5 个迁移的"旧版本"对象重启后只补后续迁移，已有账本行不变、最终 schema 与 Node 相同；新版本迁移过的对象被旧版本以 `newer-schema` 拒绝；`ActorStore`、`MembershipStore`／`InstanceAccess` 与 `ThreadAccessStore` 经 DO RPC 的结果在归一化随机 ID、密钥和时间后，与同一调用序列在临时目录 node:sqlite owner 上的结果完全相同。
- **正式 DO 与 Node 同一调用序列**（`installation-core-do.scenarios.ts`）：同一组 38 个 HTTP 请求分别打到正式 DO（Miniflare）与 Node `startHeadlessServer`（公开监听 `0.0.0.0`＋`accessControl`，同一 Human 登录配置与 setup 凭证），归一化 ID、token、时间与 origin 后状态码、`cache-control`／`content-type`／`x-content-type-options`／`location`、`Set-Cookie` 形状与 JSON 正文逐项相同：匿名会话 401、匿名 Actor 401、浏览器得到拒绝页；错误凭证 setup 403、setup 200 并签发会话、`/__opencraft_account/status` 管理员；`/__opencraft_access/session` 角色；邀请与接受（201）；成员不能管理成员（403）、管理员列出成员；错误密码与未知用户 401、跨源 403、多余字段 400；同一成员第二次登录；Actor Session bearer 访问非 Actor 路由 403；成员不能更改成员资格（403）；管理员撤销成员后成员两个登录的 Actor API 401、实例会话 403，重新登录可认证但不被准入；重启后管理员会话仍有效、被撤销者仍被拒绝、`/setup` 303、再次 setup 409；登出后 401、再登录 200。
- **驱逐后重建**：`ctx.abort()`（与平台驱逐一样不触发任何事件）后的下一个请求重新构造对象：登录、成员表与 setup 状态不变；驱逐后写入的撤权经重建的 owner 提交，再次驱逐后仍生效。
- **定时撤销在 alarm 上**：`InstanceAccess.watch` 在对象唯一 alarm 上布置（`mergedOwnerWake`），准入期间每 500 ms 重新布置且不撤销；管理员撤销成员后，下一次 alarm 复查撤销该 watch；关闭的 watch 删除 alarm。
- **打开被拒绝**：畸形 setup 凭证（Node 启动以 `Invalid private setup token file` 拒绝）使对象保持关闭，所有路由 503，重启后仍然如此。
- **中立打包**：部署入口不触及任何 Node owner 实现（`sqlite-node`、`worker-owner`、`identity-core/node`、Hub 的 Node 端口与文件存储、共享内存提交栅栏、Node Server owner 与旧日志、`model-usage-policy`、`account-pool-host`、Node 密码哈希、`login-admission`、Node 根、网关与 `root-inputs-node`）；只触及 `nodejs_compat` 提供的 `node:crypto`、`node:util`、`node:path`、`node:url`、`node:fs/promises`、`node:timers/promises`、`node:worker_threads`（后五个来自 installation 模块中协作步骤的静态导入，DO 不调用这些步骤，见 5.2）。Wrangler 模板与入口、类名、绑定、兼容日期和标志一致由同一测试检查。
- **已发布迁移在 DO 中可执行，无需改动**：`--> statement-breakpoint` 是 SQL 注释，DO 的多语句 `exec` 依次执行全部语句；`0005_native_channels` 的 `CREATE TRIGGER … BEGIN … END` 被当作 schema 接受，不被当作事务控制拒绝；`ALTER TABLE … ADD`、`INSERT … SELECT`、`randomblob()` 正常。当前 22 个迁移不含 `PRAGMA`、`ATTACH`、`VACUUM` 或 drizzle 表重建。外键：node:sqlite 的 owner 连接默认开启外键，DO 也默认开启，两者一致（Node 的借用连接可关闭外键，DO 中不存在借用连接）。本地 workerd 接受 `PRAGMA foreign_keys=OFF`，若将来出现 drizzle 表重建式迁移，需在真实 Cloudflare 上复核该 PRAGMA 后才可依赖。

### 5.2 Node 专属依赖

| 依赖 | 来源 | 处理 |
| --- | --- | --- |
| `node:sqlite`、`node:fs`、`node:path` | `@opencraft/storage-node/server-repository` 的文件打开路径 | 隔离：该导出增加 `workerd` 条件，指向只接受 owner 句柄的 `repository.workerd.ts`；共享的借用逻辑在 `repository-handle.ts`，Node 实现行为不变 |
| `node:crypto`（`createHash`、`randomBytes`、`randomUUID`、`timingSafeEqual`） | 迁移组合与 checksum、`HumanAuth`、本地账号插件与账号页、协作步骤 | `nodejs_compat` 下可用，凭据签发与校验已在测试中运行 |
| 全局 `Buffer` | `permission-read-cache.ts` | `nodejs_compat` 下可用（G3b 后 IC 领域模块不再使用） |
| `process.env` | `ActorStore` 未传 `policy` 时读取 `OPENCRAFT_ACTOR_POLICY` | `nodejs_compat` 下为空即人类策略，与 Node 未配置时相同；Node 根与 DO 都未显式传入，仍是后续项 |
| `setInterval(...).unref()` | `InstanceAccess.watch`、`ActorAccess.watch` | **已改**：两者经 `@opencraft/owner-wake` 的 `periodicOwnerWork`（500 ms）；默认 `timeoutOwnerWake()`，Node 时序不变；`assembleInstallation({ ownerWake })` 传入时用之，DO 传入合并后的 alarm |
| `node:http` 请求与流式读取 | `InstanceAccess.handle`、`HumanAuth`、本地账号、`ActorAccess` | **已改**：DO 前门经 `@opencraft/http-exchange/fetch` 调用同一处理器；路由表与准入闸门与 Node 共享（5.5） |
| 私有文件（setup 凭证、Human 登录配置） | `readPrivateJson` | **已改**：setup 凭证来自 secret 绑定，登录配置来自 var，均经与 Node 相同的校验（5.5） |
| Node 原生 Argon2id | `createNodePasswordHasher` | **已改**：DO 用纯 JS `password-hash-portable`，PHC 记录双向互通（§7.4 的 CPU 结论） |
| `worker_threads`、`isMainThread` 断言、`SharedArrayBuffer`＋`Atomics` 提交栅栏 | 核心 owner Worker、`identity-writes.ts` 的跨线程栅栏、`orchestration-runtime-store.ts`、`server-spaces-runtime.ts` | **已改**：DO 用同线程核心 owner 与 `sameThreadCommitFence`（5.5），不创建 Worker；`ServerSpacesRuntime`／`OrchestrationRuntimeWorker` 所在模块仍被 installation 模块静态导入 `node:worker_threads`／`node:url`，DO 不调用这些步骤 |
| 按路径读取策略库 | `projectModelCatalog`、`filterGatewayModelCatalog` | 留在 Node owner Worker（`server-core-worker.mjs`），不进入共享 owner 领域 |

### 5.3 单一 owner 的含义

Node 上 `opencraft-server.sqlite` 的编排运行时与 Server space 已在核心 owner Worker 的连接上执行，剩余的第二条连接是网络线程过渡连接（见[服务器核心 owner](../server/server-core-owner.md)）。DO 中只有一个 owner 与一个 `SqlDatabase`，这意味着：

- 没有跨连接锁等待与 `busy_timeout`；也不再需要把其他连接的提交转发给 owner 以刷新权限投影——所有写入都经同一连接对象，`AuthorityChanges`／`PermissionReadCache` 的分组天然覆盖全部写入。
- 提交栅栏不再需要跨线程：授权复核与写入在同一同步回合、同一 `transaction()` 内完成，DO 输入门保证期间没有其他请求交错。正式装配以同线程核心 owner（`sameThreadServerCore`）与 `sameThreadCommitFence` 替代 `IdentityWrites` 的 Worker＋共享内存栅栏路径，没有移植 `Atomics`。owner 调用先进先出、一次一个、参数与结果按结构化克隆传递，并且每个调用在上一个应答送达发起方（`IdentityWrites` 已应用该结果）之后的宏任务中才执行，否则同线程栅栏会把"尚未应用的更早提交"判为延迟应答而拒绝。
- `ServerDatabaseHandle` 没有 `location`，`Collaboration` 无法按文件启动伴随 Worker；编排与空间领域由同一 DO 直接执行（Node 已用 `orchestrationRuntimeDomain`／`serverSpacesDomain` 在 owner 连接上这样做，同线程 owner 与 Node owner Worker 现在共用 `server-core-domains.mjs` 这一份组合），所有 Server 核心工作在一个 DO 线程上串行，与认证热路径争用 CPU。是否把无事务耦合的领域拆到其他 DO，需按 CPU 与时延实测决定。

### 5.4 生产 InstallationCore 仍缺

已完成（2026-11-24）：IC 的 DO 装配中身份与准入部分（成员、Actors、Human 登录与本地账号、实例准入、Actor 访问与身份写入）；认证前门（本地账号登录与 setup、邀请与接受、会话、Actor API、实例准入与成员管理）；Wrangler 模板（未部署）。仍缺：

- **边缘 Worker**：静态资源与发布清单、Client DO、Client 会话到 WorkspaceHost 的路由、模型出口；现有入口只把 IC 自有路由转发给 IC 对象，把工作区运维操作（管理员）转发给按 id 寻址的 WorkspaceHost 对象（5.7），其余一律 404。
- **其余 installation 步骤的 DO 装配**：`openServerInformation`（只需 DO 状态文档，可作为下一步）、`openPersonalServices`、`openCapabilityBindings`／`openCapabilitySigningKey`（`KeyMaterial` 已有 DO 适配器）、`openSpaces`、`openCollaboration`（需要 workspace-host 的 `conversationExecution` 与 App Host 迟绑定）、`openConnectors`、`openMcpApps`、`openTurnPush`。同线程核心 owner 已提供这些步骤需要的全部 owner 方法，`Collaboration` HTTP API 随 `openCollaboration` 接入，共享路由表中它们的路由在对象未装配时与 Node 缺席服务一样回答 404 `missing`。
- **OIDC**：流程状态在 `HumanAuth` 内存中，需写入 DO storage 并保持一次性消费（[登录入口原型结果](gateway-split.md#34-登录入口原型结果)）；discovery 与 ID Token 验签未在 workerd 中跑通。
- **登录准入**（`plugins/login-admission`）仍是 Node Worker＋SQLite owner，需 SQL 端口版本；Hub 节点身份（`HubNodeIdentity`）与 RelayHub 未装配；身份组合（下游产品）未装配。
- **投影发布**给边缘 Worker 与 Client DO；`AccountCore` 与 `WorkspaceHost` 的协作。
- DO 版迁移后 schema 校验（DO 内不能另开 `:memory:` 库）；备份与恢复改用 PITR 的运维流程；`SecretStore` 的信封加密；`ActorStore` 显式策略。
- **真实 Cloudflare 复核**：正式 DO 场景已加入 `cf:rehearsal` 的 `installation-core-do` 分组，尚未在真实账号上运行；SQL 语义、CPU 与冷启动、alarm 精度、并发登录下的排队（Argon2id 每次 0.3–0.9 s CPU，§7.4）以及把哈希移到无状态 Worker 的评估。Workers Free 计划不可用。

### 5.5 正式装配（2026-11-24）

**位置与理由。** DO 类与入口在 `apps/headless-server/src/cloudflare/`，与 Node 组合根（`headless-application.mjs`）和它们共同调用的 installation 模块、根输入端口（`src/assembly/`）同在 Headless 服务这一 owner 下。按[网关拆分 §4.1](gateway-split.md#41-组合根按角色分开owner-共享)，每个 DO 类是一个小组合根，调用同一模块的中立适配；它不能放进 `packages/`：共享包不得导入应用（`check:boundaries` 的 "must not import from an app host"），`@opencraft/storage-cloudflare` 只依赖契约包（[存储端口第 6 节](storage-ports.md#6-cloudflare-适配器第-5-阶段本地-workerd-验证)），而 installation 模块属于 Headless 组合。目录按平台命名是因为它是部署装配（平台适配层），领域与契约不按平台命名。类不导入 `cloudflare:*`：它是带 `fetch`／`alarm` 的普通 DO 类，运行时结构类型在 `bindings.ts`，因此随 `@opencraft/headless-server` 一起类型检查；前门是 fetch，不需要 RPC。`check:boundaries` 对该目录、同线程 owner、共享 owner 领域与路由表施加与根输入端口相同的中立规则。

**打开顺序。** 构造函数在 `blockConcurrencyWhile` 内：迁移 DO SQL；`documentRootInputs`（对象状态文档 `installation/` 前缀；Human 登录配置与机器名来自绑定）；`sameThreadCommitFence()`；`sameThreadServerCore(handle, { identityFence })`；`assembleInstallation({ serverStorage, identityFence, isHuman, ownerWake: mergedOwnerWake(alarm) })`；然后按 Node 根的顺序调用 `relayConnection`、`humanAuthConfiguration`、`openMembership`（`accessControl: true`：公开部署始终经实例成员准入）、`machineIdentity`、`openIdentity`、`openAdmission`、`openActorAccess`。任何一步失败都按具名 disposer 回滚并保持关闭。

| Node 专属输入 | Node 根 | InstallationCore |
| --- | --- | --- |
| 核心 SQL owner | `openServerCoreOwner`：Worker、写者锁、迁移与旧库导入 | `sameThreadServerCore`（`src/assembly/server-core-same-thread.ts`）：同一份 owner 领域（`src/server-core-domains.mjs`，Node owner Worker 也由它组合）与存储方法（`@opencraft/storage-node/server-core-methods`，`serveServerCoreOwner` 也由它组合）；先进先出、克隆参数与结果、应答送达后才执行下一调用 |
| 身份提交栅栏 | `sharedMemoryCommitFence` | `sameThreadCommitFence` |
| 根输入 | `nodeRootInputs`（私有文件、`machine-id`、Hub 状态文件） | `documentRootInputs`；`OPENCRAFT_HUMAN_AUTH`（var，JSON，同一 `parseHumanAuthConfiguration`）、`OPENCRAFT_MACHINE_NAME`；relay 恒为 `null`；Hub 不装配（`hub: null`） |
| `createPasswordHasher` | `createNodePasswordHasher`（`node:crypto.argon2`） | `createPortablePasswordHasher`（纯 JS `@noble/hashes` Argon2id，同参数 PHC 记录，§7.4） |
| `readSetupToken` | `readPrivateJson(setupTokenFile)` | secret `OPENCRAFT_SETUP_TOKEN` 作为 `{ token }`，同一校验 |
| `openLoginAdmission` | `openLoginAdmissionPolicy`（Worker＋SQLite，下游组合启用） | 不装配（5.4） |
| 登录、setup 与邀请尝试计数 | 进程内存（默认，未传入） | `openAdmission({ loginAttempts })` 新增的可选输入：`stateLoginAttemptLimiter` 位于对象状态（`login-attempts/`），`HumanAuth` 与 `LocalAccountApplication` 共用 |
| 访问 watch 的定时复查 | `timeoutOwnerWake()`（默认，未传入） | `assembleInstallation({ ownerWake })` 新增的可选输入：对象唯一 alarm 经 `mergedOwnerWake`，`alarm()` 唤醒到期的 owner 工作，各自从状态重新推导 |

**前门。** `src/installation-routes.ts` 是 Node 网关与对象共用的路由定义：installation 服务的路径归属（`/setup`、`/__opencraft_account*`、`/__opencraft_auth*`、`/__opencraft_actors/collaboration/*`、`/__opencraft_actors*`、服务器信息、个人模型默认值、已读回执、个人 SSH key）、服务缺席或拒绝时的 404 `missing`、准入闸门（Actor Session bearer 访问非 Actor 路由 403、未准入 401／403 的 JSON 或拒绝页、已识别但未准入的 Human 不降级为匿名 403）与应答内容。`serve-workbench-web.mjs` 消费同一张表与闸门，只保留自己的帧写法（JSON 经 `sendJson` 带 `Content-Length`，拒绝页分块），原始字节不变（`headless-composition` 的 "installation routes" 用例在抽取前后都通过）。对象的顺序与 Node 相同：`InstanceAccess.prepare` → 共享路由 → 闸门 → `/__opencraft_access/*`（`InstanceAccess.handle`）；客户端地址取边缘可信的 `CF-Connecting-IP`。入口 Worker 只把共享路由与 `/__opencraft_access/*` 转发到名为 `installation` 的唯一对象。

**关闭与驱逐。** 具名 disposer 按 Node 关闭第 11 步的顺序（身份组合、登录准入、账号应用、账号管理、`HumanAuth`、Human 账号、身份写入、Actors、成员），最后排空并关闭同线程核心 owner；打开失败时与 `close()` 时执行，逐个结算、汇总失败。平台驱逐不产生事件：DO 内存被丢弃，持久状态已按事务提交，下一事件重新构造并重新打开（驱逐场景见 5.1）。

**部署装配。** `deploy/cloudflare/wrangler.installation-core.jsonc` 是模板：入口 `apps/headless-server/src/cloudflare/worker.ts`（Wrangler 以 `workerd` 条件打包），`nodejs_compat`，兼容日期与测试相同，DO 绑定 `INSTALLATION_CORE`（类 `InstallationCore`，`new_sqlite_classes` 迁移 v1）与 `WORKSPACE_HOST`（类 `WorkspaceHost`，迁移 v2，`containers` 以 digest 固定工作区镜像，见 5.7），IC 的 var 只有登录配置与机器名（另有非机密的 `OPENCRAFT_WORKSPACE_*`），setup 凭证经 `wrangler secret put`。仓库内任何校验或构建都不部署它。

### 5.7 WorkspaceHost 状态

状态（2026-11-24）：**正式 DO 装配第一部分（Host SQL、容器生命周期、Engine Host 输入与执行观察、空闲、中断恢复、化身围栏、凭据租约调用点、运维路由），本地 workerd 验证（容器替身，无真实 Containers），未部署到真实 Cloudflare**。编号接在 AccountCore（§5.6，PR #581）之后。

**位置与理由。** DO 类在 `apps/headless-server/src/cloudflare/workspace-host.ts`，理由与 §5.5 相同：它是小组合根，调用 Node 根也调用的 workspace-host 模块（`src/assembly/workspace-host.mjs`），不能放进 `packages/`。同目录的 `workspace-link.ts`（端点字节流上的 HTTP/1.1 与 RFC 6455 客户端）与 `workspace-engine.ts`（容器 Engine Host 与执行历史读取）是模块既有工厂端口的 DO 侧适配器，不是新端口。Host SQL 的族组合在 `src/assembly/workspace-host-sql.ts`（不按平台命名：将来 Node 合库用同一份），运维与对象路由在 `src/workspace-host-routes.ts`（入口 Worker 与对象共用）。`check:boundaries` 对 `cloudflare/`、路由表与 `@opencraft/sql/families` 施加 §5.5 的同一中立规则。

**打开顺序。** 构造函数在 `blockConcurrencyWhile` 内：解析配置（var，非机密）；容器在运行时重设 inactivity timeout（`armCloudflareContainerTimeout`，平台不跨 DO 重启保留，兜底而非正确性依据）；读对象状态文档 `workspace-host/identity`。未绑定的对象不迁移、不启动任何东西（`status` 答 `unbound`）。已绑定（内部 `open` 写入 `{workspace, machine}`，同一身份再次调用为空操作，不同身份 409）时依次：迁移 Host SQL 族；对象唯一 alarm 经 `mergedOwnerWake` 供空闲、租约续期与中断恢复共用；provider 注册表 → backend → `createSandboxPool`（默认 4 vCPU／8 GiB，容量一个环境）→ `createWorkspaceRuntime`（placement 记录在状态文档）；同一 SQL 上的 `ExecutionLeaseStore` 与 `SqlInterruptedTurnRecovery`；`assembleWorkspaceHost(...)` 后按 Node 根顺序调用 `openConversationExecution`、`openEngines`（`attachIndependentEngine`＝容器 Engine Host 适配器，其余引擎工厂明确拒绝）、`openExecutionObservation`（`openExecutionLeases`＝DO SQL 上的租约库，`createExecutionRecovery`＝端点上的历史读取，`reportedExecutionProcess` 只收所有者上报）。打开期间任何会启动容器的使用都被拒绝（启动时的未定租约对账因此保持未知，不为它启动容器）；打开失败按具名 disposer 回滚并保持关闭（503），重启后仍是。

**多库共存（Host SQL 族）。** WH 拥有的每个库保留各自已发布的迁移链（发布前缀＋存储注册表追加的生成 SQL，与 Node owner 应用的完全相同），作为同一数据库内的一个**族**，记在 `schema_family_migrations(family, version, name, checksum, applied_at)`：与 Server 扩展族账本同形（[sqlite-lifecycle "Server 产品扩展迁移族"](../server/sqlite-lifecycle.md)），但这里没有核心链，全部是对等族。运行器 `@opencraft/sql/families`（运行时中立）：每族版本连续、SHA-256 逐行核对，篡改为 `history-mismatch`，超出声明或账本中有本构建未声明的族为 `newer-schema`；已有单链 `schema_migrations` 的库与无账本却有对象的库都拒绝、不采纳；每个迁移一个 `transaction()`，事务内重新校验。族与理由：

| 族（注册表 schema id） | Node 上的文件 | 内容 |
| --- | --- | --- |
| `opencraft-host-state-database` | `opencraft-host-state.sqlite` | queue、投递、执行租约（v15）、thread directory（`durable-thread-catalog`）、senders／Bot／IOA、token usage 表 |
| `provisional-threads` | `thread-creations.sqlite` | 暂定线程 |
| `host-schedules` | `conversation-schedules.sqlite` | 会话定时任务 |
| `host-recovery` | `interrupted-turn-recovery.sqlite` | 中断 Turn 恢复 |
| `provider-retry` | `provider-turn-retry.sqlite` | provider 重试 |
| `employee-git-vault-store` | `employee-git-vault.sqlite` | 员工 Git vault |

不作为族：`thread-identity-database`（其执行租约迁移与 Host 状态 v15 是同一 SQL，WH 用 Host 状态的租约表）与 DSH 的 `thread-catalog`（引擎在容器内的库；WH 的 thread directory 是 Host 状态的表）——二者会重复创建 Host 状态已有的对象。各链对象互不相交由 Node 测试证明：族迁移后的库与六个 Node owner 各自文件的对象逐项相同。Node 仍按文件打开（`openManagedDatabase`），合库（workspace-host-split §4.1）时用同一运行器加 Node 的备份与校验。

**容器只经沙盒 provider。** 对象从不直接调用 `ctx.container.start`：`cloudflare://WorkspaceHost` 经 provider 注册表选择，创建经池准入、自定义实例、化身标签与身份 exec 校验（§7.5）；没有容器绑定时打开失败、对象关闭，不回退任何本机执行。provider 新增可选 `env`：容器主进程环境只带工作区 id 与 machine id（非机密，容器内无凭据）。backend 新增 `sleep`：Cloudflare 容器停止后不保留磁盘（`captured` 快照未做），所以休眠＝确认销毁（与 `close` 同一路径），唤醒＝`create`、新化身。

**WorkspaceLink 适配（模块 transport 工厂的 DO 侧）。** 容器内 owner 不变；对象持有 `WorkspaceRuntime.connect` 的端点连接（每连接一个 attached 中继进程），在字节流上说与 Node 客户端相同的协议：Engine Host 的描述符来自 agent `control` 的 `describe`（不读文件），与 `/health` 逐项一致（schema、pid、machine id、引擎集合、默认引擎），`/host-inputs` 提交与回执，`/execution-origin` 经 `WorkspaceRuntime.fenced` 只在前后两次 `probe` 都是已绑定 agent 化身时才采纳；执行历史读取（`thread/turns/list`、`thread/read`）每次一条新端点 WebSocket，忽略服务器请求，复用抽到中立模块的 `createNativeExecutionTurnInspector`。连接断开即失败，不重放；未知保持未知。

**空闲（§3.7.2）。** 判定在对象内：没有对外端点连接、没有恢复中的行、引擎报告的进行中 Turn 为零（已结束的租约顺带对账结算），且距上次使用超过空闲时长（默认 15 分钟，`OPENCRAFT_WORKSPACE_IDLE`，`resident` 为常驻），然后 `WorkspaceRuntime.sleep()`。判定本身的引擎读取不算使用。唤醒都在 alarm 上，容器休眠不影响到期。

**中断恢复与化身围栏。** 新化身是旧执行进程结束的证据：`created`（带 previous）、`incarnation-changed`，或 provider 报告丢失（`released lost:*`，来自 `monitor()`）时，在新绑定被使用**之前**同步：执行租约 `suspend()`、恢复行 `lost()`、请求一次恢复。恢复由 Host 状态驱动：`inspect` 只用所有者经围栏上报的当前 Turn（同一 Turn 仍在进行为 live，已结束或有更新的 Turn 为 finished，只有带丢失证据且当前化身没有它才是 lost，读取失败为 unknown）；`continue` 以 Host 自有的 `restart-recovery:` 输入 id 提交系统续写提示，原输入从不重放；最多 3 次、`dispatching` 中断为 unconfirmed，规则与 Node 相同（`@opencraft/host-recovery`）。被接受的 Host 输入在引擎给出 Turn 时登记为恢复行。对象持久化化身纪元（状态文档 `epoch`，每个新 agent 化身加一）并在 `status` 中报告。注意：`fenced` 发现化身变化会释放绑定，而 Cloudflare 环境的 `close` 就是销毁容器，所以容器内 agent 重启后的下一次使用是新容器。

**凭据租约（调用点）。** 端口 `WorkspaceCredentialLeases` 是 #581 `CredentialLeases` 的结构子集；持有者 `{workspace, engine, incarnation}`。新化身绑定时先撤销该引擎旧租约再申请，休眠、丢失与化身变化时 `revokeHolder({workspace})`，到半寿命时经 alarm 续期（失效则为同一化身重新申请）。令牌只在对象内存，不进容器、不进持久存储，供将来边缘出口取用（`modelLease`）。生产对象的 `credentialLeases()` 在 AccountCore 的租约兑换接口（AC 第二部分）装配前返回 `undefined`：不申请租约，容器也就到达不了任何模型；测试以替身证明调用点。

**路由。** 入口 Worker 把 `/__opencraft_workspaces/<工作区 id>/{status,wake,sleep}`（与 Node `workspace-admin.mjs` 的运维操作对应）按 `idFromName("workspace:<id>")` 转给该工作区对象，转发前把请求的 cookie／authorization 交给 InstallationCore 的 `/__opencraft_access/session`，只有管理员才转发（401／403 原样）；非法 id 与其他方法 404。`open`、`inputs`、`execution` 是 owner 之间的内部操作，入口从不转发；Client 会话到工作区的路由依赖尚未抽出的 client-session（gateway-split §4.1.1"G1 剩余"），本步不做。

**证明。** `npm run test:workspace-host:workerd` 新增 `tests/storage/workspace-host-do-workerd.test.ts`（场景 `workspace-host-do.scenarios.ts`，替身 `workspace-container-double.ts`：在 isolate 内逐帧扮演共享 broker、固定中继、`workspace-agent` 的 `control` 与 Engine Host 的 HTTP／WebSocket，`monitor()`／`destroy()`／崩溃／DO 重置语义同 Node 夹具）：未绑定不迁移不启动、六族账本与表；容器只经 provider 启动（4 vCPU／8 GiB 自定义实例、无 Internet、化身标签、启动环境只含工作区 id 与 machine id）；Host 输入经模块到 Engine Host，租约库记录、恢复行登记、围栏上报；进行中 Turn 不空闲、结束后 alarm 停止容器并结算租约、撤销租约、唤醒为新化身、驱逐后构造函数重设兜底并按 receipt 重连同一容器；崩溃后新化身只收到一次系统续写（无原文重放）、旧化身租约撤销、新化身获租约；agent 化身变化时上报被拒、绑定释放、唤醒后恢复；篡改族账本后对象 503；运维路由无会话 401、管理员 200。另有 `tests/storage/sql-migration-families.test.ts`（族账本规则、升级保数据、与 Node 文件对象相同，进入 `test:storage-ports`）、`tests/server/workspace-link.test.ts`（适配器对真实 `node:http`／`ws`）、`tests/execution/sandbox-cloudflare.test.ts` 的 `sleep` 用例。中立打包：部署入口不触及 `worker-owner`、`sandbox-node`、`personal-assistant`、`ws`、`proper-lockfile`、Node 引擎客户端与 Node 根；触及的 `sqlite-node` 文件逐一列出（来自与领域类、迁移常量同模块的 Node owner 子类与存储注册表，对象不调用），不得增长。为此 `bot-client.ts` 不再静态导入 Node 的 Bot 进程启动器，改由根注入（`openExecutionDelivery({ spawnAssistant })`，Node 行为不变）。InstallationCore 自身的中立检查改为打包 `installation-core.ts`，结论不变。

**仍缺（剩余缺口）。**

- 真实 Cloudflare：WH DO 尚未进入 `cf:rehearsal`；产品镜像（`workspace-agent`＋Engine Host＋Brain）未做；Wrangler 模板中 `containers[].image` 与对象读取的 `ctx.container.images.<名>` 的映射未在真实部署核对（预演用 API 的 `images` 映射）。
- machine id 由调用 `open` 的 owner 给出；IC 尚未发布它，放置（Thread→工作区）与 client-session 未装配，所以生产中还没有调用 `open` 的一方。
- 模块其余步骤未装配：执行交付（Assets vault、个人 Git、ENV）、浏览器、capability MCP、终端与文件 owner、会话资源、AppHost transport 层、readiness、token usage。Codex AppServer 路径（`CodexEngineAdapter` 是 Node transport）与 DSH 端点未接，只接了 Engine Host（Pi）。
- 定时任务、provider 重试 owner 与 thread directory 同步未在对象中打开（表已迁移）；恢复通知没有客户端会话可推送；执行租约启动时钟为 `null`（应由容器 `control` 提供，workspace-host-split §3.4）；容器拒绝 epoch 落后连接需 agent 支持。
- AccountCore 租约兑换与边缘出站处理（`interceptAllOutboundHttp`、HTTPS 拦截）未做；`captured` 快照、原始 TCP `connectEndpoint` 未做；DO 版迁移后 schema 校验（同 §5.4）。

## 6. RelayHub 原型结果

状态：**仅测试原型，本地 workerd 验证**。`tests/protocol/workerd/relay-hub-worker.ts`（边缘 Worker＋`RelayHubDO`）由 `npm run test:relay-hub:workerd`（`tests/protocol/relay-hub-workerd.test.ts`）经 esbuild 打包、在 Miniflare（`workerd@1.20260730.1`，兼容日期 `2026-07-30`，无 `nodejs_compat`）中运行，已随其他 `test:*:workerd` 套件进入 `npm test`、`gate` 与 CI；本地运行不需要 Cloudflare 账号，真实账号上的运行见第 7 节。测试中的 Headless 是按 `plugins/relay-connect` 行为写的替身（用共享 `parseOpen` 解析 open、按流 id 与 token 回拨 `DATA_PATH`、回显字节），不是真实插件。浏览器侧只验证 WebSocket 客户端连接。

### 6.1 Redis 集群到 DO 的映射

| Node 中继（`apps/relay-server`） | DO 原型 |
| --- | --- |
| `connection:<instanceId>` 12 s 租约（2 s tick 续租）选出持有控制链路的节点，换主时 `retire` | 边缘 Worker 按控制凭据选 `idFromName(installation)`，`RelayHubDO` 是该 installation 的唯一 owner，无选主、无续租。新控制链路取存储中单调递增的 generation，关闭旧链路（1012）及其全部流与预约 |
| `pending:<id>` 10 s 记录＋`forwardUpgrade` 把 Headless 的数据回拨转发到 owner 节点 | 流 id 仍是 `^[0-9a-f-]{36}$` 形状，前 64 位是边缘密钥对 installation 的 HMAC 路由标签；边缘按标签无状态地把回拨送到同一 DO，DO 校验预约与 token。预约只在内存：等待中的客户端请求本身就把对象钉住，持久化只会在重启后留下空占位。10 s 期限由 DO alarm 执行 |
| 内部 `/channel` WebSocket 把客户端流转发到 owner 节点 | 不存在：客户端连接也按 installation 路由到同一 DO |
| 每 installation 512（active＋connecting）＋每节点 4096 全局槽位 | 每 DO 512（active＋connecting）；节点级全局池由平台限制取代 |
| `hub-owner` 租约＋`hub-state`／`hub-routes` 发布 | 未覆盖，见 6.4 |
| `RelaySessionStore`（登录 starts／tickets／sessions） | 未覆盖；按 origin 绑定的会话应由 InstallationCore 或按入口划分的 DO 持有 |

线协议保持 `opencraft-relay.v1`：DO 在控制链路发送 `{type:"open",id,token}`，Headless 带 `STREAM_HEADER` 与 `Bearer <token>` 回拨。现有 relay-connect 无需修改即可对接（真实插件对接尚未运行）。DO 不回显 `DRAIN_HEADER`，因为分离保留流（1006/1012 时保留数据流）未实现，不声明未接通的能力。

### 6.2 已证明

- 客户端流经 DO 打开、文本与二进制帧原样往返、任一端关闭后另一端以相同 code 关闭并释放槽位；未建立控制链路的 installation 返回 503，互不影响；`/__opencraft_*` 路径不可作业务路由（复用 `relayPathAllowed`）；伪造或已用 token 回拨返回 401。
- 预算：512 个流全部被接纳后，第 513 个客户端请求得到 503，控制链路不发送新 open、不关闭、不重连，已有流继续通信；关闭一个流后新请求被接纳。
- 预约期限：默认实例中预约期限为 10 000 ms 并由 alarm 持有；用 `RESERVATION_MS=300` 绑定（仅测试）缩短后，Headless 丢弃的 open 在到期后返回 503、计入 `openTimeouts`、释放槽位，迟到回拨返回 401，控制链路不受影响。
- 控制链路收到任何入站帧（含畸形 JSON）以 1008 关闭，并关闭该链路的全部流，之后新请求 503。
- 同一凭据重连：新链路 generation 递增，旧链路的流以 1012 关闭，新 open 只发往新链路，旧链路的关闭握手在 DO 中完成。
- 本地数值（**仅本机 Miniflare，不代表 Cloudflare**，三次运行）：流打开 p50 约 2.0–2.5 ms，回显往返 p50 约 0.4 ms、p99 约 0.6–1.1 ms，16 KiB 帧双向各 8 MiB 回显约 79–113 MiB/s。

### 6.3 复用与 Node 专属部分

| 代码 | 结论 |
| --- | --- |
| `@opencraft/relay-protocol` 主入口（路径、头、`MAX_RELAY_STREAMS`、`parseOpen`、`relayPathAllowed`） | 与运行时无关，原型直接打包使用 |
| `@opencraft/relay-protocol/node`（`relayDuplex`、`bridgeRelayDuplex`、`closeWhenDone`、`relayIdleDeadline`） | Node 专属：`ws`、`createWebSocketStream`、`Duplex`、`setImmediate`、`unref`。DO 以消息级桥接替代字节流；15 分钟空闲期限未移植，应改由 alarm 实现 |
| `@opencraft/relay-protocol/websocket-sender` | Node 专属（`ws` 事件与 pong 信用） |
| `plugins/relay-connect` | 留在 Headless（Node）：出站 `ws` 客户端与 `net.createConnection` 到本地端口；线协议不变 |
| `apps/relay-server` 的 HTTP 转发（`httpRequest({ createConnection: () => stream })` 把 HTTP/1.1 写进隧道） | 无法直接移植：workerd 没有基于自定义 Duplex 的 `node:http` 客户端。需在流上实现 HTTP/1.1 序列化与解析，或另定按请求分帧的协议版本；原型只桥接 WebSocket 客户端 |
| `authentication.ts`、assertion 签发、选择页 | 未移植；签名需 `nodejs_compat` 或 WebCrypto Ed25519 |
| `@opencraft/hub-network` 的 `HubNetwork`（`ws` 服务器、`node:http`、Worker 文件 owner） | Node 专属 |

### 6.4 HubLink 级联能否映射为 DO 到 DO

Hub 级联有两层：联邦模型（稳定节点身份、签名邀请、连接作用域的路由 epoch、`allowTransit`、路径校验与 `MAX_HOPS`）和传输（每条 peer 链路的控制 WebSocket＋128 流预算的数据回拨）。在 Cloudflare 上：

- 一个 Hub 身份对应一个 Hub DO 持有 `hub-state`，即可替代 `hub-owner` 租约与 `hub-routes` 发布；这与本原型替代 `connection:` 租约的方式相同。
- 同一账号内两个 Hub 都在 Cloudflare 时，一跳可以是 DO 到 DO 的 stub `fetch`（可返回 WebSocket）或 RPC，替代对外 WebSocket；但联邦模型不变：每个 Hub 有独立身份与策略，路由 epoch、路径与转发许可仍须校验，不能因同账号而合并成一个信任域。每一跳仍是一个 DO 的消息事件，级联越深，单流的 DO 消息费与时延越高。
- 与外部（Node 或其他组织）Hub 的链路仍是现有 WebSocket 协议。入站链路可像本原型的控制链路一样终止在 DO；出站链路需 DO 主动发起 WebSocket，这类连接不可休眠，会钉住对象。
- 结论：可以映射，但只替换传输与 owner 选举，不替换联邦模型；本原型未实现。

### 6.5 本地 workerd 发现

- 兼容日期 `2026-07-30` 下普通 WebSocket 的 `binaryType` 默认为 `blob`，二进制中继必须显式设为 `arraybuffer`，否则会把 `Blob` 当字符串转发。
- 在**其他事件上下文**中 `close()` 一个可休眠 WebSocket：DO 端关闭握手完成（`webSocketClose` 已运行），但 TCP 连接要到对象休眠（本地约 10 s 空闲）才释放；对象被普通流钉住时一直不释放，`ws` 客户端最晚在其 30 s closeTimeout 后才报告关闭。普通 `accept()` 的 socket 约 0.1 s 关闭；在该 socket 自身事件中关闭（1008 路径）也立即生效。因此原型只让控制链路可休眠，数据流用普通 socket。此行为需在真实 Cloudflare 上复核。
- Worker 模块的额外具名导出会被当作入口，导出常量会导致运行时启动失败。

### 6.6 真实 Cloudflare 上需核对的成本与限制

- **单 DO 消息速率**：一个 installation 的全部流都经同一个单线程对象，每条中继消息都是一次 DO 事件（WebSocket 入站消息计费）。需实测 512 个活跃流同时传输时的单对象吞吐上限与 CPU 时间，确认是否需要按流分片到多个 DO（预算仍由单一 owner 记账）。
- **休眠**：只有控制链路可休眠；任一打开的流或等待中的预约都会钉住对象并按时长计费。长连接聊天流本身每隔数秒就有心跳，即使改用可休眠 socket，每条消息也会唤醒对象。需核对 relay-connect 每 15 s 的协议 ping 能否在不唤醒对象的情况下由运行时应答。
- **流量与位置**：核对 Workers／DO 的流量计费与 WebSocket 消息计费；DO 建在首个请求附近（通常是 Headless 控制链路），远端浏览器流量会绕行到该位置，需评估 `locationHint`。
- **部署与重启**：代码部署或对象重启会断开全部 WebSocket，导致所有 Headless 同时重连；Node 中继的排空与交接（1012＋`DRAIN_HEADER`）在 DO 中没有对应物。
- **单对象连接数与消息大小**：每个流占两个 WebSocket，需核对单 DO 的 WebSocket 数量上限；原型按 Node 中继保持 64 KiB 单消息上限。

### 6.7 原型未覆盖

浏览器身份与 installation 准入、普通 HTTP 请求转发、排空交接、15 分钟空闲期限、客户端中途放弃时立即释放预约（目前依赖到期）、Hub 链路、登录会话存储，以及 `relay-observation` 的容量指标。

## 7. 真实 Cloudflare 预演（`npm run cf:rehearsal`）

`npm run cf:rehearsal`（`scripts/cloudflare/rehearsal.ts`）把第 4–6 节的 workerd 原型按与 Miniflare 测试相同的 esbuild 配置打包，经 Cloudflare REST API 部署到真实账号，运行与 `test:*:workerd` **同一组**共享场景（`tests/*/workerd/*.scenarios.ts`，经 `tests/cloudflare/scenarios.ts` 汇总，不复制断言），同时在本进程内用 Miniflare 跑一遍并逐项对比，最后删除本次创建的全部资源。它需要真实账号，不在 `test`、`gate` 或 CI 中；`tests/` 下的原型与场景不进入生产包。

### 7.1 用法与安全边界

```sh
CLOUDFLARE_ACCOUNT_ID=<32 位十六进制> CLOUDFLARE_API_TOKEN=<Workers Scripts + R2 编辑权限的 token；由代理注入时填任意占位> \
  npm run cf:rehearsal -- [--only '<分组: 场景名正则>'] [--skip-miniflare] [--report out.json] [--stale-minutes 10] [--keep] [--containers]
```

- **只碰自己的名字**：Worker 与 R2 bucket 名称为 `opencraft-rehearsal-<8 位随机运行 ID>-…`，创建、删除前都按精确名称和该正则核对，账号中运行前已存在的资源一律拒绝触碰。默认不创建容器、D1、KV；容器只在显式 `--containers` 时创建（第 7.5 节）。
- **访问密钥**：每次运行生成 32 字节随机密钥，只存在于进程内存与 Worker 的 `secret_text` binding；`scripts/cloudflare/rehearsal-guard.ts` 包在每个原型外层，对所有路由先做 SHA-256 后常量时间比较，不匹配一律 404。场景使用的虚拟主机（如 `inst-a.relay.test`）经请求头还原后再交给原型。
- **清理**：正常结束、异常、`SIGINT`／`SIGTERM`／`SIGHUP`、未捕获异常都会删除本次 Worker（`force=true` 同时删除 DO 命名空间与存储）和 bucket（先经仍在运行的绑定 Worker 清空对象，若绑定 Worker 已删除则临时部署一个只含清空入口的 `…-purge` Worker）。清理开始后不再部署新版本。结束时重新列出账号并与运行前比较。
- **残留回收**：`SIGKILL` 或宕机无法清理，因此每次启动先列出 `opencraft-rehearsal-` 前缀资源，按运行 ID 分组；整组在 `--stale-minutes`（默认 10）内没有变化才视为过期并删除（bucket 同样先清空），避免误删另一个仍在运行的预演。`--stale-minutes 0` 立即回收全部前缀残留。`--keep` 仅供调试，保留资源由下一次运行回收。
- 重启语义：`persist` 场景的“重启”是同名 Worker 上传新版本后再以 `code_update_strategy: immediate` 部署同一版本，使仍活跃的 DO 立即换代（默认 `deferred` 下活跃对象可继续运行旧代码最长约 300 s）。
- 每次调用的 CPU／墙钟时间取自 Workers Logs（部署时开启 `observability`），因为 Cloudflare 上 isolate 内时钟在纯 CPU 计算期间不前进。

### 7.2 2026-11-23 结果

账号为 Workers Paid；兼容日期 `2026-07-30`，Miniflare `4.20260730.0`。完整运行 74 个场景、用时 348 s；Miniflare 74／74 通过，Cloudflare 73／74 通过，唯一差异见 7.3，修正场景后单独重跑 RelayHub 分组 6／6 通过、无差异。运行前后账号均为原有 8 个 Worker、0 个 R2 bucket，无前缀残留；`--keep` 后用 `--stale-minutes 0` 回收（含清空 8 个对象的 bucket）与运行中 `SIGINT` 清理也各验证一次。

| 分组 | 场景 | Miniflare | Cloudflare | Miniflare 合计 | Cloudflare 合计 |
| --- | --- | --- | --- | --- | --- |
| storage-ports（DO SQL、state／secrets／keys、R2 blob 含上传会话、范围读、摘要、已存在拒绝、SQL 语义探针） | 37 | 37 通过 | 37 通过 | 1.5 s | 27 s |
| installation-core（22 个 Server 迁移、schema 等价、重启／篡改／新旧版本、领域 RPC 与 Node owner 对照） | 7 | 7 | 7 | 1.9 s | 62 s |
| installation-core-do（正式 DO：与 Node 同一调用序列、驱逐、alarm 上的 watch、打开被拒；2026-11-24 加入） | 4 | 未运行 | 未运行 | — | — |
| workspace-host（五条迁移链、领域操作与 `nodeSqlDatabase` 对照、v13–v17 升级、alarm owner） | 13 | 13 | 13 | 2.2 s | 23 s |
| login-entry（Argon2id 双向互验、fetch 登录入口与 Node HTTP 入口对照） | 2 | 2 | 2 | 6.4 s | 26 s |
| client-do（可休眠 socket、恢复游标、驱逐与重启、alarm 回收） | 9 | 9 | 9 | 3.2 s | 70 s |
| relay-hub（控制链路、512 流预算、预约到期、1008、替换、吞吐） | 6 | 6 | 5（修正后 6） | 2.1 s | 68 s |

Cloudflare 侧耗时主要是部署（首个版本约 3 s，`immediate` 重启约 8 s）和公网往返，不代表运行时性能。`installation-core-do` 分组在本次运行之后加入，需要账号凭据，尚未在真实 Cloudflare 上运行（Miniflare 下 4／4 通过）。

### 7.3 与 Miniflare 的差异

- **语义差异：未发现**。DO SQL（`changes()`、嵌套事务即 savepoint、多语句 `exec`、事务控制文本被拒、`sqlite_master`／`PRAGMA foreign_keys`、BLOB 与范围外整数）、22 个已发布 Server 迁移与五条 WorkspaceHost 迁移链、账本 checksum 拒绝、DO alarm、可休眠 WebSocket、R2 条件写与 multipart 结果全部与 Miniflare 一致；第 4 节表中的 SQL 结论在真实 Cloudflare 上成立。
- **RelayHub 预算场景首次失败，根因在驱动端而非 Cloudflare**：512 个客户端升级与 512 个 Headless 回拨都从同一预演进程发出，只放行了 83 个，其余 429 个回拨晚于 10 s 预约期限被判过期（`openTimeouts 429`、`rejectedTokens 429`）。在同一沙盒对 `api.cloudflare.com` 做并发新建 HTTPS 连接探针：16 个约 0.2 s，512 个耗时 10.2 s，1024 个 20.3 s，即出站代理每秒只能建立约 50 个新连接，1024 次握手必然超出 10 s。DO 侧 `RelayHubDO/fetch` 的 CPU 最大 2 ms，没有排队证据。场景现对 `patience > 1` 的运行时按比例放宽该场景的预约期限（10 s 期限本身仍由预约到期场景断言），重跑通过。真实部署中客户端与 Headless 分布在各自网络，不受此限制；单对象在真实网络下的并发建流上限仍需分布式压测。
- **isolate 内时钟**：Cloudflare 上 `performance.now()` 在纯 CPU 计算期间不前进（Argon2id 读数为 0），Miniflare 本地会前进；需要 CPU 数字时只能读 Workers Logs。
- **时延与吞吐（仅供量级参考，含本沙盒到边缘的网络）**：Client DO 事件 append→两个 socket p50 134 ms（Miniflare 4.9 ms）；RelayHub 建流 p50 115 ms、回显 RTT p50 31 ms、8 MiB 双向回显 55.9 MiB/s（Miniflare 2.2 ms／0.44 ms／97.5 MiB/s）。
- Workers Logs 中各 DO 单次调用 CPU：InstallationCore RPC p95 33 ms（迁移整库最大 45 ms），WorkspaceHost RPC p95 15 ms，存储一致性对象最大 549 ms（multipart 摘要校验），其余普遍 ≤ 4 ms。

### 7.4 Argon2id 登录的 CPU 结论

参数 `m=19456,t=2,p=1`，纯 JS 实现（打包 32 KiB）。Workers Logs 计量的 `LoginCore` 单次 RPC（每次一次 Argon2id 验证或哈希）CPU p50 630 ms、p95 843 ms、最大 872 ms；同一对象 fetch 登录入口中含哈希的调用最大 284 ms（两条路径差异本次未细分原因）。对照：Miniflare 本地 isolate 时钟 164 ms，Node 原生 `node:crypto` 24–25 ms；客户端观察到的验证往返中位 689 ms（含网络）。

- **CPU 上限**：Workers Paid 默认每请求 30 s CPU，单次登录最多约 0.9 s，余量 30 倍以上，不需要提高 `limits.cpu_ms`；Workers Free 的 10 ms 则完全不可用。
- **登录延迟**：约 0.3–0.9 s 的服务端计算加网络往返，交互式登录可以接受，但约为 Node 原生的 25–35 倍。
- **代价与风险**：CPU 时长按毫秒计费，失败尝试同样消耗 0.6 s 级 CPU，且同一 installation 的登录集中在单线程 DO 上串行执行，并发登录会排队。哈希之前的按来源、账号与全局的尝试预算已在登录 DO 的持久存储中实现（[登录尝试预算](gateway-split.md#34-登录入口原型结果)，每分钟全局 60 次，即单个 installation 最坏约 54 s CPU／分钟）；仍需评估把哈希移到无状态 Worker（DO 只做记录读写）以避免阻塞同一对象的其他请求；如需降低成本再评估 WebAssembly 实现，参数仍须与 Node 记录互通。

### 7.5 Cloudflare Containers 组（`--containers`）

显式开关，默认 `npm run cf:rehearsal` 不运行，也不在 `test`、`gate`、CI 中；`--containers --only '^containers'` 只运行该组。需要本机 Docker 与 `registry.cloudflare.com`（推送凭据由 API `containers/registries/registry.cloudflare.com/credentials` 签发，只写入临时 `DOCKER_CONFIG`）。`scripts/cloudflare/rehearsal-containers.ts`：

- **镜像**：`scripts/cloudflare/container-agent.Dockerfile`＝`python:3.12-alpine`＋Node 22 二进制＋esbuild 打包的真实 `workspace-agent --bare`（容器主进程，只发布 `control`）；不是产品镜像。推送后经 `containers/image-preparations` 等待就绪。
- **部署**：Worker `opencraft-rehearsal-<run>-containers`（兼容日期 `2026-11-01`，版本元数据 `containers:[{class_name, images:{base}}]`，访问守卫同上）＋ DO `WorkspaceContainer`（tests/execution/workerd/sandbox-cloudflare-worker.ts，只经 provider registry → backend → pool → `WorkspaceRuntime` 驱动容器）＋ `durable_object` 调度的容器应用。预算 1/4 vCPU、512 MiB、2 GB 磁盘。不创建快照。
- **步骤**：create（自定义实例、化身标签、身份 exec）→ spawn（exec 不继承 start env、argv 含空格、退出码 3、PTY `45 123`）→ 非 attached Python 回显服务＋attached 中继 4 MiB 往返 SHA 一致 → agent `probe` → `ctx.abort()` 重置 DO → 新 DO 中 `WorkspaceRuntime.observe()` 按 receipt `attached`（同一 agent 化身）→ `workspace://default/endpoints/control` 往返 → 另一 receipt 句柄 `kill -TERM 1`，`monitor()` 报告 `lost {exited, 0}`，runtime `released lost:exited` → 再次使用 `attach-failed`→`created`（新化身）→ close：`destroy()`＋`monitor()` 落定，`inspect()` 为 `null`。
- **清理**：删除容器应用、Worker（`force=true`，含 DO 命名空间）、镜像 tag 与其 digest 清单；启动时回收 Worker 已不存在的前缀容器应用与镜像；结束时列出 Worker、容器应用、镜像。

**2026-11-23 结果**（ewr 机房，单次运行，数字只作量级）：6／6 通过，总用时 65 s（构建 0.3 s、推送＋准备 11 s、部署 5.5 s）。create 3.9 s（冷启动＋身份 exec）；spawn 首个 exec 230 ms、PTY 56 ms；中继建立 62 ms，4 MiB 往返 264 ms；DO 重置后 attach＋probe 约 140 ms；agent 停止到 `lost` 138 ms；丢失后新建化身 1.2 s；close 275 ms。前几次运行暴露并修正了两处驱动问题：新建 Worker 后 DO 命名空间列表分页／滞后（改为分页轮询），以及一次 DO 调用时容器绑定尚未就绪（部署步骤改为等待 `status` 可用）。运行前后账号均为原有 8 个 Worker、0 个 R2 bucket、0 个容器应用；**残留**：每次推送后 Cloudflare 的镜像准备在同一仓库生成一个 `application/vnd.cloudchamber.btrfs-chain.v1` 清单，registry 以 409 `SINGLETON_ARTIFACT_EXISTS` 拒绝删除（探测时的 `opencraft-probe-cfc-probe-base` 仓库有同类残留）；本日 6 次运行留下 6 个此类清单（各约 6 MiB，仓库 `opencraft-rehearsal-<run>-agent`），脚本将其报告为平台保留而非清理失败。未验证：快照、`sleep`、原始 TCP、inactivity timeout 实际到期、长时间运行的费用。
