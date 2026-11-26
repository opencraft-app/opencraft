# 可选 Cloudflare 部署

[Architecture index](../README.md) · [存储端口](storage-ports.md) · [执行沙盒](../execution/execution-sandbox.md) · [Docker 三角色部署](../../../deploy/docker/README.md)

状态：Cloudflare 是与 Node 自托管（Docker／systemd／Electron）并列的部署装配选项。真实 Cloudflare 临时环境已验证 `sandbox-cloudflare` provider（第 7.5 节），以及 InstallationCore、AccountCore、ClientDO 和 WorkspaceHost 组成的原生 Codex AppHost、模型出口与 Linux Hands（第 5.7、7.6 节）。存储端口的 Cloudflare 适配器已在本地 workerd 中通过[一致性测试](storage-ports.md#6-cloudflare-适配器第-5-阶段本地-workerd-验证)。RelayHub 仍是 workerd 原型（第 6 节）；生产上线边界见各组件的状态和待验收项。

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
| 工作区容器 | 每工作区一个 Container，由 `WorkspaceHost` 持有 | 当前打包方案在同一容器装配 Brain 与 Hands，包括 `codex app-server`、Pi、DSH、`exec-server`、终端、文件和浏览器；独立 `CODEX_HOME`；容器磁盘是缓存，工作区内容以 Git 为真源，可选容器快照加速恢复；默认空闲 15 分钟休眠 |

### 2.1 模型请求与凭据

工作区容器内不保存任何模型或账号凭据。引擎的模型请求由出站处理交给边缘 Worker；Worker 向 `AccountCore` 获取短期凭据租约后直接流式转发给 provider。长时间流式响应不占用 DO 运行时长，凭据只在 Worker 请求内存中短暂存在。`AccountCore` 仍是刷新与选号的唯一写入者。

协议转换（例如 Anthropic）代码需确认能在 workerd 中运行后才可迁移到 Worker。

`AccountCore` 的存储准备（SQL 端口、凭据记录端口、持久化清单与 Node 专属阻碍）见[存储端口第 7 节](storage-ports.md#7-accountcore-存储)；租约契约与 DO 装配现状见 5.6。

### 2.2 工作区容器

- 镜像沿用已发布 Hands 镜像（按 digest 固定），追加 Brain 运行时；不在容器启动时下载工具。
- Brain 与执行用户使用不同 UID；凭据不进入容器文件系统。
- 容器回收或重启时，引擎进程终止；恢复沿用[中断 Turn 恢复](../execution/interrupted-turn-recovery.md)，由 `WorkspaceHost` 持有的 Host 状态驱动，不重放未确认输入。
- 持久化语义已决定（2026-11-23）且与 provider 无关：Git 是工作区内容的真源，容器磁盘（含 `CODEX_HOME`）随 `destroy()`／崩溃丢失，是可重建缓存；`snapshotContainer` 作为 `captured` 快照能力只用于加速恢复（平台 beta、30 天 TTL、Worker API 不可删），不作兜底；未提交改动可能随化身丢失。契约与对账规则见[工作区拆分 §3.7](workspace-host-split.md#37-工作区持久化与空闲设计2026-11-23-用户决定未实现)。
- 空闲：WorkspaceHost 判定空闲后停止容器（默认 15 分钟，可配置常驻）；容器 inactivity timeout 在未启用 Codex 的配置中用作兜底，每次 DO 构造时重设。启用 Codex 快照时由 WorkspaceHost 捕获快照后关停（见 5.7）。

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
| 成本 | **已探测**：冷启动中位约 0.6 s（部署后首次 3.9 s）；按超额单价，8 GiB／20 GB 运行约 0.077 美元／小时，每消耗 1 vCPU 小时另计 0.072 美元，容器休眠期间停止计算这三项费用。[Cloudflare Containers 定价](https://developers.cloudflare.com/containers/platform/pricing/) |

单实例资源上限为 4 vCPU／12 GiB／20 GB 磁盘，满足当前默认 4 vCPU／8 GiB 契约（自定义实例类型实测被接受）。仍待验证：镜像大小与架构、浏览器沙盒、HTTPS 出站拦截。

## 5. InstallationCore 状态

状态（2026-11-24）：**正式 DO 装配覆盖身份与准入**。真实 Cloudflare 临时环境已验证 Web 账号设置、登录和 AppHost 准入（第 7.6 节）；InstallationCore 的完整场景组在本地 workerd 运行。`InstallationCore` 类在 `apps/headless-server/src/cloudflare/installation-core.ts`，结构绑定 `bindings.ts`，Wrangler 模板 `deploy/cloudflare/wrangler.installation-core.jsonc`；装配见第 5.5 节。它与 Node 根复用 `apps/headless-server/src/assembly/installation.mjs` 的 `open*` 步骤。`npm run test:installation-core:workerd` 已在 `npm test`、`gate` 与 CI `core-tests`。原测试原型保留为迁移与领域端口的对照夹具，其迁移场景亦在真实 Cloudflare 运行过（第 7 节）。

### 5.1 已证明

- **精简生命周期**：DO 在 `blockConcurrencyWhile` 内执行 `migrateServerSqlDatabase(durableObjectSqlDatabase(ctx.storage))`（`@opencraft/storage-node/server-sql`），只做账本校验、checksum 拒绝和按序迁移（每个迁移一次 `transaction()`）；不含进程锁、`VACUUM INTO` 备份、`ATTACH` 旧六库导入、替代谱系采纳与 `:memory:` 校验器（见[存储端口 3.1](storage-ports.md#31-sqldatabase)）。账本规则与 Node `openManagedDatabase` 是同一份实现（`@opencraft/sql/migrations`）。有对象但无账本的库被拒绝而非采纳（`_cf_` 前缀的 workerd 内部表除外）。打开失败时对象保持关闭，之后每个请求都以 503 `installation_unavailable` 拒绝，不读旧状态。
- **迁移与领域端口（原型夹具）**：新对象应用全部 22 个已发布 Server 迁移，schema（含触发器）与 node:sqlite 全新库逐项相同；在持久化存储上重启后结果为 `up-to-date`，账本逐行不变；改写一行 checksum 后重启被拒绝；只装前 5 个迁移的"旧版本"对象重启后只补后续迁移，已有账本行不变、最终 schema 与 Node 相同；新版本迁移过的对象被旧版本以 `newer-schema` 拒绝；`ActorStore`、`MembershipStore`／`InstanceAccess` 与 `ThreadAccessStore` 经 DO RPC 的结果在归一化随机 ID、密钥和时间后，与同一调用序列在临时目录 node:sqlite owner 上的结果完全相同。
- **正式 DO 与 Node 同一调用序列**（`installation-core-do.scenarios.ts`）：同一组 HTTP 请求分别打到正式 DO（Miniflare）与 Node `startHeadlessServer`（公开监听 `0.0.0.0`＋`accessControl`，同一 Human 登录配置与 setup 凭证），归一化 ID、token、时间与 origin 后状态码、`cache-control`／`content-type`／`x-content-type-options`／`location`、`Set-Cookie` 形状与 JSON 正文逐项相同：匿名会话 401、匿名 Actor 401、浏览器得到拒绝页；错误凭证 setup 403、setup 200 并签发会话、`/__opencraft_account/status` 管理员；`/__opencraft_access/session` 角色；邀请与接受（201）；成员不能管理成员（403）、管理员列出成员；错误密码与未知用户 401、跨源 403、多余字段 400；同一成员第二次登录；Actor Session bearer 访问非 Actor 路由 403；成员不能更改成员资格（403）；管理员撤销成员后成员两个登录的 Actor API 401、实例会话 403，重新登录可认证但不被准入；重启后管理员会话仍有效、被撤销者仍被拒绝、`/setup` 303、再次 setup 409；登出后 401、再登录 200。
- **服务器信息**：`openServerInformation` 复用 Node 服务与权限检查，公开入口设置存入 InstallationCore 状态文档。已准入的用户可读取，管理员可用当前修订号更新。Node 和 DO 对照场景验证拒绝匿名、普通成员写入和旧修订号，撤权后不可再读，重启后保留已提交的设置。
- **个人数据**：InstallationCore 使用同一 Server owner 和 Human 准入逻辑保存模型默认值与跨设备已读回执。Node 和 DO 对照验证不同账号的隔离、旧修订号拒绝及重启续读。SSH 密钥管理仍由有 SSH 装配的组合根提供。
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

- **边缘 Worker**：可选 `ASSETS` 绑定提供 Workbench 静态资源与发布清单（见下）。Client DO 已接入默认 Codex 工作区的创建、读取、文本 Turn 与 `turn/interrupt`，WorkspaceHost 的私有拦截已接到模型出口。
- **其余 installation 步骤的 DO 装配**：`openCapabilityBindings`／`openCapabilitySigningKey`（`KeyMaterial` 已有 DO 适配器）、Collaboration 的执行与 Personal Assistant（需要 WorkspaceHost 的 `conversationExecution` 与 App Host 迟绑定）、`openConnectors`、`openMcpApps`、`openTurnPush`。Actor 消息、已读和收件箱已由共用 `CollaborationHttpApi` 经同线程核心 owner 提交。Node 与 DO 共用编排命令客户端，独立 Node 文件 Worker 由自己的传输适配器接入。workerd 验证了同源与 Actor 授权、发送去重、驱逐后收件箱游标续读。DO 尚未装配执行端口，HTTP 入口以 409 `execution_unavailable` 拒绝新的执行请求。
- **OIDC**：流程状态在 `HumanAuth` 内存中，需写入 DO storage 并保持一次性消费（[登录入口原型结果](gateway-split.md#34-登录入口原型结果)）；discovery 与 ID Token 验签未在 workerd 中跑通。
- **登录准入**（`plugins/login-admission`）未装配：其存储 `SqlLoginAdmissionStore` 已在 SQL 端口上，IC 可在自身 SQL 上装配（[存储端口 §3.7](storage-ports.md)）；管理员 `admit` 函数的求值仍经 `@opencraft/javascript-runtime` 的 `node:worker_threads` 隔离，DO 上的执行方式待定。Hub 节点身份（`HubNodeIdentity`）与 RelayHub 未装配；身份组合（下游产品）未装配。
- **投影发布**给边缘 Worker 与 Client DO；`WorkspaceHost` 的协作。`AccountCore` 的账号路由授权已经由 IC 回答（内部账号授权交换，5.6）。
- DO 版迁移后 schema 校验（DO 内不能另开 `:memory:` 库）；备份与恢复改用 PITR 的运维流程；IC 自己的 `SecretStore` 用途（若有）同样需经 `sealedSecretStore` 密封（AC 已这样做，见 5.6）；`ActorStore` 显式策略。
- **真实 Cloudflare 复核**：正式 DO 场景已加入 `cf:rehearsal` 的 `installation-core-do` 分组，尚未在真实账号上运行；SQL 语义、CPU 与冷启动、alarm 精度、并发登录下的排队（Argon2id 每次 0.3–0.9 s CPU，§7.4）以及把哈希移到无状态 Worker 的评估。Workers Free 计划不可用。

**Workbench 静态入口。** 在仓库根构建无预置 Host 的 Web 发行树。打包脚本在 Cloudflare 副本中写入本站的 `local-codex` profile，由 `appHost: true` 显式选择同源 `/apphost` 的 V3 连接和现有准入检查。

```sh
OPENCRAFT_HEADLESS_SERVER_BUILD=false VITE_HYPERNODE_PLUGIN=disabled VITE_APPSERVER_HOSTS_JSON='' VITE_APPSERVER_WS_URL='' npm run build:web:release
assets_dir="$(mktemp -d)/workbench-assets"
node scripts/cloudflare/prepare-workbench-assets.mjs apps/workbench-web/dist "$assets_dir"
```

在 Wrangler 模板中启用 `ASSETS`，将 `directory` 指向打包输出，保留 `run_worker_first: true` 和 `html_handling: "none"`。Workbench 会在完全匹配已配置端点时迁移同一个 Host 的旧 WebSocket profile，继续使用原 Host ID 和用户配置。

Worker 先转发 InstallationCore 与 AccountCore 自有路由。静态 GET／HEAD 由 InstallationCore 现有的 `/__opencraft_access/admission` 门禁核实。静态请求不会把登录凭据交给 Assets；未经准入的导航保留现有 401／403 拒绝页。已准入的导航可回落到 `index.html`，带内容 hash 的资产允许浏览器缓存，发布清单和 HTML 禁止共享缓存。保留 API 路径、源码映射及未装配的 WebSocket 入口不会回落到 SPA。现有 Web 发布清单仍按原字节返回。该入口可本地验证登录后加载 Web Workbench。已接本地 Client DO 的 Codex Thread 读取和重连后的新 lease。实时事件订阅、游标恢复和执行授权仍待装配。现有 `attempt` 参数标识单次 WebSocket 尝试，不能用作 DO 实例身份。详见[会话原型与线格式边界](gateway-split.md#33-client-do-原型结果)。

固定域名的同站发布可向 `uploadWorkbenchAssets` 传入仍需服务的上一版构建目录。上传器合并其带内容哈希的 `/assets/` 资源，地址与内容冲突时拒绝发布。新 HTML、发布元数据和 Service Worker 从当前发行树交付。这样旧标签页仍可以按原 URL 取首次发送所需的延迟加载模块。

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

**部署装配。** `deploy/cloudflare/wrangler.installation-core.jsonc` 是模板，入口为 `apps/headless-server/src/cloudflare/deployment-worker.mjs`。模板依序声明 InstallationCore（v1）、AccountCore（v2）、WorkspaceHost（v3）和 ClientDO（v4）的 `new_sqlite_classes` 迁移。工作区镜像在 `containers.images` 中按 digest 固定，setup 凭证以 Worker Secret 配置。默认校验和构建只在本地执行。第 7.6 节的显式 Wrangler 演练部署临时副本。

### 5.6 AccountCore 状态（2026-11-24）

**首次配置模型。** 在首次部署时，将 `OPENCRAFT_ACCOUNT_MODEL_BOOTSTRAP` 作为 Worker Secret 注入。它是一个 JSON 对象，`document` 使用现有 `models.json` 格式（`schemaVersion: 1`、`revision: 0`、`providers`、`defaultModel`），可选的 `credentials` 按 `credentialRef` 提供初始值。Codex 的 `OPENCRAFT_WORKSPACE_CODEX_EGRESS_PROVIDER` 选其中启用的 `openai-responses` provider。首个 AccountCore 打开时会校验整个输入、密封凭据，再提交模型文档。中途退出可用同一输入继续，已有模型文档会跳过初始化。安装可在确认模型目录及请求后移除 bootstrap Secret，保留用于读回密封凭据的 `OPENCRAFT_ACCOUNT_SEALING_KEY`。

状态：**正式 DO 装配覆盖模型策略、模型配置、密封凭据和凭据租约、账号池选号与续期、模型网关和个人订阅**。模型配置、密封凭据与原生 Codex 模型出口已在真实 Cloudflare 临时环境中经第 7.6 节复验，账号池与网关的完整验证仍为本地 workerd。`AccountCore` 类在 `apps/headless-server/src/cloudflare/account-core.ts`，与 `InstallationCore` 共用部署入口和 Wrangler 模板（`ACCOUNT_CORE` 绑定，`v2` 迁移）；调用 `src/assembly/` 的同一模块。`npm run test:account-core:workerd` 已在 `npm test`、`gate`、CI `core-tests`，对应原型也是 `cf:rehearsal` 的 `account-core-do` 分组。

**前提 P4-1 的核对。** [网关拆分 §5.1](gateway-split.md#51-步骤) 把 P4-1（`proxy` 默认、全部 provider 经代理）列为 AC 的前提。源码现状：Docker 的 `proxy` 服务与 Brain 的 `OPENCRAFT_PROXY_MODE=external` 默认值自 #511 起已是默认拓扑（`deploy/docker/compose.yaml`）；代理模式下引擎侧每个 provider 要么经账号 Core 转发、要么无需凭据、要么在配置时被拒绝（`proxyRouting`／`assertProxyRoutable`，`tests/execution/model-proxy-mode.test.ts`），不再保留直连。未完成：真实 Docker 上"Brain 读不到 `models/credentials.json` 时 Pi／DSH／Codex 仍能调用模型"的验收（Brain 仍挂载整个数据卷）；调用方令牌仍按调用方类型签发且不过期（`run/proxy-callers/`）。这两项约束的是 C2（容器流量真正改走边缘出口）而不是 AC 自身的存储与接口，所以不阻塞本节；短期租约契约正是后一项的替代设计（见下）。

**打开顺序。** 构造函数在 `blockConcurrencyWhile` 内：从 secret `OPENCRAFT_ACCOUNT_SEALING_KEY` 导入密封密钥；`migrateModelPolicySqlDatabase(durableObjectSqlDatabase(ctx.storage))`（`@opencraft/model-usage-policy/sql-owner`：账本校验、checksum 拒绝、按序迁移，无账本的非空库拒绝采纳，与 IC 的精简生命周期同形；三个迁移族的对象与账本表不算策略对象）；`openAccountPoolSqlStorage`（一次迁移账号池、凭据记录和模型网关三个族）；`assembleAccount` 以下表的中立输入装配；`assembleAccountPoolCore` 装配账号池、续期管理器与续期调度（唤醒为对象唯一 alarm 经 `mergedOwnerWake`）。任何一步失败对象保持关闭，所有请求 503 `account_unavailable`，重启后仍然如此；不存在"无密钥时明文落库"的退路。关闭时先停续期调度并等待在途续期，再关闭策略写者。

| 账号模块输入（`assembly/account.mjs`） | Node 根（`assembly/account-node.mjs`） | AccountCore |
| --- | --- | --- |
| `openModelPolicy` | `openModelPolicyDatabase($DATA/model-usage-policy.sqlite)`：`openManagedDatabase`、写者锁、备份、`:memory:` schema 校验 | 对象 SQL 上的精简生命周期；同一迁移链（`modelPolicyMigrations`；测试断言生成注册表未追加迁移） |
| `modelDocuments`（`models.json` 与租约账本） | `fileStateDocumentStore($DATA/models)` | `durableObjectStateDocumentStore(storage, { prefix: "models/" })` |
| `modelSecrets` | `fileSecretStore($DATA/models)`（私有 0600 `credentials.json`） | `sealedSecretStore(durableObjectSecretStore(storage), key)` |
| `modelGateway`（第一次创建 HTTP 服务时读取一次） | 读取 `OPENCRAFT_MODEL_GATEWAY_DATABASE`；store 为 `modelGatewayStoreHolder(() => new ModelGatewayStore(path))`（首个网关请求打开，account 关闭时关闭）；个人订阅 `codexCorePersonalSubscriptions(CodexCoreControlClient)` | 对象 SQL 中的迁移族 `model-gateway`（同一已发布链 v1–v4）上的同一 `ModelGatewayStore`；个人订阅 `accountPoolPersonalSubscriptions`（同对象账号池），只在有订阅路由时提供（现无，见"模型网关"） |
| 网关贡献 | `gatewayContributions` 使用 account 的模型配置与凭据仓库（`$DATA/models/` 原文件） | 同一函数，对象状态文档与密封凭据 |
| 路由授权 | 同进程的 `instanceAccess`／`actorAccess`／`actorStore` | 每请求向 IC 询问（见"前门"） |
| 账号池存储（不经 account 模块；Node 由 Codex Core 组合） | `AccountPoolStore`：`$DATA/codex/account-pool.sqlite`（`openManagedDatabase`，schema `account-pool-host`）＋`secrets/` 私有文件 | 对象 SQL 中的迁移族 `account-pool-host`（同一已发布链 v1–v4）＋`account-credential-records`（同步密封的凭据记录行） |
| 账号续期执行 | 原生 codex 维护子进程（`createManagedCodexRefresh`） | 维护执行方的 fetch 绑定 `ACCOUNT_MAINTENANCE`（`fetchAccountRenewal`）；未配置时续期以 `service-unavailable` 失败并退避重试 |
| 续期调度唤醒 | `boundedWakeTimer`／运行时超时（Codex Core 现状为按请求续期＋用量轮询） | 对象唯一 alarm，经 `mergedOwnerWake` |

**前门与授权。** 账号拥有的路由是共享定义 `apps/headless-server/src/account-routes.ts`（`/__opencraft_model_policy`、`/__opencraft_model_gateway`，两者在 AC 中都已装配）；账号模块的 HTTP 服务按它分派，Node 网关仍在原位置调用该服务，线上字节不变（`headless-composition` 的 "account inputs" 与 "model policy and model gateway" 用例）。入口 Worker 把这些路径转发给名为 `account` 的唯一对象。授权仍归 installation：对象对每个请求先经内部"账号授权交换"（`/__opencraft_internal/account-authority`，只经对象绑定可达，入口不转发）向 IC 询问准入闸门——IC 执行与 Node 相同的 `instanceAccess.prepare` 与 `installationGate`，拒绝原样返回；通过后，策略处理器的两次授权询问（处理前与读完写入正文后）同样问 IC，由 Node 网关使用的同一函数 `installationAccountAuthorities` 回答。`modelPolicyHttp` 与 `modelGatewayHttp` 为此接受异步授权，Node 行为不变；网关的每次授权（处理前、读完正文后、贡献与订阅写入的各检查点）同样每次问 IC。对 IC 的询问每次取新 stub：被重置（带错误驱逐、重新部署）的对象，其旧 stub 一直失效（驱逐场景发现）。

**凭据密封（信封加密缺口的处理）。** `@opencraft/secret-storage/sealed` 的 `sealedSecretStore` 在值进入内层存储前以 AES-256-GCM（WebCrypto，随机 96 位 IV）加密，附加数据绑定 secret 名（密文不能挪给另一个名字），存储格式 `ocs1.<keyId>.<iv>.<密文>`；密钥是 secret 绑定中的 `<id>.<32 字节 base64url>`，不可导出、不写入对象存储。读取时明文或格式不符的值以 `SecretStoreCorruptError` 拒绝，另一密钥 id 的值以 `SecretSealingKeyError` 拒绝，从不当作明文返回；以相同值重写保留原密文，所以 `stamp` 仍只在值变化时变化。这不是完整的信封加密：没有每记录数据密钥层与密钥轮换流程（换钥需要重新密封全部值），密钥丢失即凭据丢失；它们列为后续。

**短期凭据租约契约。** `@opencraft/account-pool-host/credential-leases`（中立）：`grant({workspace, engine, incarnation}, ttlMs)`（1 s–1 h）签发租约与一次性返回的令牌；`renew`；`redeem(token, providerId)` 只为当前租约返回一个 provider 的 `{protocol, baseUrl, credential}`；`revoke(id)`、`revokeHolder({workspace, engine?, keepIncarnation?})`（化身更换或工作区停用）。未知、过期与撤销一律 `lease_invalid`，不可转发的 provider 为 `provider_unavailable`。账本是一个状态文档（`credential-leases.json`），只存令牌的 SHA-256，每次写入顺带清除过期租约，当前租约上限 4096。provider 来源 `model-config/provider-credentials.ts` 与 Node 代理投影共用同一路由规则（`provider-route.ts`：启用、协议可转发、显式 HTTPS 地址、有凭据引用），并像语音配置一样以 stamp／revision 双读避免撕裂。两边都能用：AC 装配它；Node 账号模块也装配它（同一 `models/` 目录，未被调用时不产生文件），现有 Node 代理路径不改走租约。对外接口见下文"租约交换与出口"。

**账号池（第二部分，2026-11-24）。** AC 是账号池选号、亲和与续期的唯一写者：对象内只有一个 `AccountPool`（`@opencraft/account-pool-host/account-pool`，与 Node `AccountPoolStore` 同一领域类），续期只经它的 `AccountCredentialRefreshManager` 提交。

- **同库多条迁移链。** 一个 DO 只有一个 SQL 库，而策略、账号池各有已发布迁移链；不绕开账本、不改写已发布 SQL：策略是主链，继续用 `schema_migrations`（第一部分已占用），账号池、凭据记录与模型网关是三个迁移族，记在 `schema_family_migrations(family, version, name, checksum, applied_at)`（`@opencraft/sql/families` 的 `beside-main` 组合；与 Server 扩展族、WorkspaceHost 同一原语，见[存储端口 §3.1](storage-ports.md#生命周期仍归-owner)）。规则：篡改 checksum、改名、超出声明或未声明的族一律拒绝；族以前缀声明对象（`owns`），无账本而本族对象已存在时拒绝采纳；每个迁移一个事务。策略的"无账本非空库拒绝采纳"把账本表与三个族的对象排除在外。单链的 Node 库从不创建族账本，Node owner、文件、账本与 checksum 不变。账号池族 `account-pool-host` 与 Node owner 同一 schema id、同一已发布链：v1–v3 来自 `account-pool-schema.ts`，v4 来自生成注册表（`@opencraft/sqlite-node/store-migrations-data`，纯数据，经中立的 `resolveSqlMigrationContract` 以同一规则校验前缀）。
- **凭据记录同步密封。** `AccountCredentialRecords` 是同步端口（选号事务内读凭据），所以 DO 适配器 `sqlAccountCredentialRecords` 把记录存为同一 SQL 中的 `account_credential_records` 行（新链 `account-credential-records` v1，已发布、测试钉住 checksum），每个值经 `@opencraft/secret-storage/sealed-records` 同步密封：AES-256-GCM 走 `node:crypto`（Node 与 workerd `nodejs_compat` 都提供，workerd 中已验证），密钥文本与 `OPENCRAFT_ACCOUNT_SEALING_KEY` 相同，经 HMAC-SHA256 派生出只用于记录的子密钥，附加数据绑定行（`account:<id>`、`host:<sha256(hostId)>`），格式 `ocr1.<keyId>.<iv>.<密文+标签>`。挪到别的行、另一密钥、明文或格式不符一律拒绝，从不当明文返回；"写账号行＋写凭据""预留亲和＋读凭据"在同一 `transaction()` 内。外部 `auth.json` 引用在此 owner 中不可读（`readExternalFile` 拒绝）。为让账号池领域进入对象，`codex-auth-file.ts` 拆出不读文件的 `codex-auth-file-format.ts`（`readCodexAuthFile` 留在 Node 文件中，导出不变）。
- **续期执行与调度。** 存储端口 §7.3 已决定 OAuth 续期由维护容器中的原生 codex 执行、AC 不重新实现未公开的登录协议，因此对象内续期的出站 HTTP 是一次 `fetch`：`fetchAccountRenewal`（`@opencraft/account-pool-host/renewal`）把账号身份与当前托管凭据 POST 到维护执行方的 `/__opencraft_maintenance/account-renewal`，校验应答（失败只带白名单错误码、账号身份不得改变），由续期管理器提交。主动续期是 `scheduleAccountRefresh`（`@opencraft/owner-wake` 上的单个唤醒）：从账号池推导最早到期（托管、启用、有 refresh token 与过期时间的账号，过期前 5 分钟），唤醒时重读状态、续期到期者、失败按 60 s 退避（退避只在内存中，重建后立即重试一次）；续期管理器的提前量与它一致。`assembleAccountPoolCore` 把三者组合起来，Node 与 AC 是对等组合根。Node 的 Codex Core 现仍按请求续期（原生维护子进程）且未装配该调度；比较证明中的 Node 侧是 Node 文件 owner（`AccountPoolStore`）＋同一组合＋运行时超时。
- **对外接口。** 账号池不新增对外路由：选号与续期由对象内的服务持有（`services().pool`），测试经测试子类调用；账号管理路由、Codex 请求的选号出口与个人订阅属于后续（见"仍缺"）。

**租约交换与出口（2026-11-24）。** 租约的对外接口是部署内部的 Fetch 契约 `@opencraft/account-pool-host/credential-lease-exchange`（中立），两条路径都在 `/__opencraft_internal/` 下，入口 Worker 从不转发，只有绑定了 `ACCOUNT_CORE` 的调用方可达：

| 路径（POST JSON） | 调用方 | 操作 | 应答 |
| --- | --- | --- | --- |
| `/__opencraft_internal/credential-leases/holder` | 工作区 owner（WorkspaceHost；启动引擎时签发，引擎运行时续期，化身更换或工作区停用时撤销） | `{action:"grant", holder:{workspace, engine, incarnation}, ttlMs}`、`{action:"renew", id, ttlMs}`、`{action:"revoke", id}`、`{action:"revokeHolder", match:{workspace, engine?, keepIncarnation?}}` | 200 `{ok}`；拒绝为 `{error}`：`invalid_lease_request` 400、`lease_invalid` 403、`provider_unavailable` 404、`lease_capacity` 429；其他 503 `lease_unavailable`（不回显内部错误） |
| `/__opencraft_internal/credential-leases/redeem` | 出口（边缘出口 Worker） | `{token, providerId}` | 200 `{ok: {providerId, protocol, baseUrl, credential, leaseId, holder, expiresAt}}`，拒绝同上 |

`credentialLeaseExchangeClient(owner)` 在调用方一侧实现同一 `CredentialLeases` 接口（每次操作取新 stub，拒绝还原为同一 `CredentialLeaseError` 码），所以进程内账本与交换可互换。WorkspaceHost 以 `{workspace, engine, incarnation}` 为持有者，通过 AccountCore DO 交换端口申请。

出口是 `credentialEgress`（`@opencraft/account-pool-host/credential-egress`，中立），部署装配为 `apps/headless-server/src/cloudflare/egress.ts`（只绑定 `ACCOUNT_CORE`，由 WorkspaceHost 调用）。Cloudflare 部署用 `interceptOutboundHttp` 把指定模型主机绑定到私有 WorkerEntrypoint，再由当前 WorkspaceHost 校验 Turn 与容器归属并注入租约。WorkspaceHost 在每次启动前注册，重新接管运行中的容器时更新注册；容器通用出网保持关闭。Codex 用容器内的回环代理发送至 `<私有出口>/__opencraft_egress/<providerId>`。租约保留在 WorkspaceHost，出口兑换后按协议放入凭据（`anthropic-messages` 用 `x-api-key`，`openai-*` 用 `Bearer`，与 Node `configured-forward.ts` 同一规则），丢弃租约令牌、cookie 与逐跳头，路径不得离开 `baseUrl`，请求与应答正文都以流转发，去掉 provider 的 `set-cookie`。凭据只在一次请求的内存中：出口没有任何存储绑定，打包检查确认它不触及存储适配器、账本、SQL 或任何 `node:` 模块。缺令牌 401 `lease_required`，未知／过期／撤销 401 `lease_invalid`，不可用 provider 404，均在任何字节到达 provider 之前。计量、按租约限额与协议转换不在其中（见"仍缺"）。

**模型网关（第三部分，2026-11-24）。** AC 是网关准入账本、限额、贡献与计量的唯一写者（Node 上该文件由网关、Codex Core、引擎计量等多个进程以 `busy_timeout` 共享）。

- **owner 与领域分开。** 中立领域 `ModelGatewayStore`（`@opencraft/account-pool-host/model-gateway`：表结构与已发布迁移 `modelGatewayMigrations` 为纯数据，`crypto.randomUUID`，不导入 `node:` 与 `sqlite-node`）；Node owner `model-gateway-store.ts`（包根导出）保留按路径构造、`openManagedDatabase`、schema `model-gateway`、`busy_timeout=5000`，文件、账本、checksum 与对象清单不变——拆分前先提交的 `tests/storage/model-gateway-sql-port.test.ts` 钉住这些，拆分后原样通过。
- **借用而非按请求开库。** `modelGatewayHttp` 接收 `store()`（组合根打开的 store），不再按路径每请求开库与关闭；贡献（`gatewayContributions`，中立）同样借用，模型配置与凭据来自 account 的端口。Node 资源生命周期因此改变一处：设置路由原先每个请求打开并关闭一次文件，现在由第一个网关请求打开（启动时仍不打开；打开失败仍是该请求 503 `gateway_unavailable`，下一个请求重试），之后 account 持有一个连接，在 account `close` 时先于策略写者关闭（Web 监听已停止之后）。`headless-composition` "model gateway store" 用例证明：无网关请求的服务器不创建文件；外来文件 503、移除后下一个请求成功；多个请求只占一个连接（Linux `/proc/self/fd`）；关闭后为 0；另一进程读到写入。Codex Core、引擎计量与 sponsor 的按调用打开不变。
- **迁移族。** `accountPoolSqlSchemas()` 将已发布的 `model-gateway` 链与账号池、凭据记录一起迁移。三个族使用 `schema_family_migrations`。迁移 SQL、名称与 checksum 沿用生成注册表；网关领域借用 AccountCore 已打开的数据库。
- **个人订阅端口。** `PersonalSubscriptions`（`@opencraft/account-pool-host/personal-subscriptions`）：`request(actor, start|poll|cancel, sessionId)` 与 `accept(actor, connection)`（按实现校验完成的连接从哪里提供）。Node 实现 `codexCorePersonalSubscriptions` 仍经 `CodexCoreControlClient` 调 Codex Core，原 loopback 校验移入其 `accept`；AC 实现 `accountPoolPersonalSubscriptions` 直接读同对象账号池中该 Human 的行（`new AccountPool(poolStorage, { ownerActor })`，同一存储的视图，不修剪亲和），完成时以该 Human 池的 Host token 作为连接凭据，由同一 `connectSubscription` 记为个人贡献。设备登录（维护执行方）与订阅完成后的请求路由（Codex 选号出口）都不存在：没有账号时 `start` 为 503；生产对象没有路由，因此不声明订阅（`subscriptionAvailable: false`，与没有 Codex Core 的 Node 相同），测试子类以固定目录的替身路由覆盖 `personalSubscriptionRoute`。

**模型网关（第三部分，2026-11-24）。** AC 是网关准入账本、限额、贡献与计量的唯一写者（Node 上该文件由网关、Codex Core、引擎计量等多个进程以 `busy_timeout` 共享）。

- **owner 与领域分开。** 中立领域 `ModelGatewayStore`（`@opencraft/account-pool-host/model-gateway`：表结构与已发布迁移 `modelGatewayMigrations` 为纯数据，`crypto.randomUUID`，不导入 `node:` 与 `sqlite-node`）；Node owner `model-gateway-store.ts`（包根导出）保留按路径构造、`openManagedDatabase`、schema `model-gateway`、`busy_timeout=5000`，文件、账本、checksum 与对象清单不变——拆分前先提交的 `tests/storage/model-gateway-sql-port.test.ts` 钉住这些，拆分后原样通过。
- **借用而非按请求开库。** `modelGatewayHttp` 接收 `store()`（组合根打开的 store），不再按路径每请求开库与关闭；贡献（`gatewayContributions`，中立）同样借用，模型配置与凭据来自 account 的端口。Node 资源生命周期因此改变一处：设置路由原先每个请求打开并关闭一次文件，现在由第一个网关请求打开（启动时仍不打开；打开失败仍是该请求 503 `gateway_unavailable`，下一个请求重试），之后 account 持有一个连接，在 account `close` 时先于策略写者关闭（Web 监听已停止之后）。`headless-composition` "model gateway store" 用例证明：无网关请求的服务器不创建文件；外来文件 503、移除后下一个请求成功；多个请求只占一个连接（Linux `/proc/self/fd`）；关闭后为 0；另一进程读到写入。Codex Core、引擎计量与 sponsor 的按调用打开不变。
- **迁移族。** `accountPoolSqlSchemas()` 将已发布的 `model-gateway` 链与账号池、凭据记录一起迁移。三个族使用 `schema_family_migrations`。迁移 SQL、名称与 checksum 沿用生成注册表；网关领域借用 AccountCore 已打开的数据库。
- **个人订阅端口。** `PersonalSubscriptions`（`@opencraft/account-pool-host/personal-subscriptions`）：`request(actor, start|poll|cancel, sessionId)` 与 `accept(actor, connection)`（按实现校验完成的连接从哪里提供）。Node 实现 `codexCorePersonalSubscriptions` 仍经 `CodexCoreControlClient` 调 Codex Core，原 loopback 校验移入其 `accept`；AC 实现 `accountPoolPersonalSubscriptions` 直接读同对象账号池中该 Human 的行（`new AccountPool(poolStorage, { ownerActor })`，同一存储的视图，不修剪亲和），完成时以该 Human 池的 Host token 作为连接凭据，由同一 `connectSubscription` 记为个人贡献。设备登录（维护执行方）与订阅完成后的请求路由（Codex 选号出口）都不存在：没有账号时 `start` 为 503；生产对象没有路由，因此不声明订阅（`subscriptionAvailable: false`，与没有 Codex Core 的 Node 相同），测试子类以固定目录的替身路由覆盖 `personalSubscriptionRoute`。

**语音（未接上租约，原因）。** `SpeechTranscriptionService` 不能经同一租约路径完成：① 调用方是 Human 的浏览器会话而不是工作区里的引擎，租约持有者 `{workspace, engine, incarnation}` 不适用，需要另一种持有者与授权（IC 的准入）；② 它不是透传：服务端把 WAV 转为 base64 JSON 调用 Hunyuan、按会话／尝试做幂等记录与每分钟限额（进程内存），出口的"原样流式转发"不覆盖这些；③ provider 路由规则把 `hunyuan-asr` 归为 `keyless`（引擎从不执行语音），`redeem` 因此不会为它返回凭据；④ 处理器仍是 `node:http` 形状（G4"现可迁"）。可行路径是先把它迁到 `@opencraft/http-exchange`，再在 AC 中按 IC 授权直接调用（凭据在 AC 内解密），或为浏览器会话定义第二种短期持有者；两者都超出本步。

**已证明**（`tests/storage/workerd/account-core-do.scenarios.ts`，另见 Node 侧 `tests/storage/account-core-ports.test.ts`）：

- **策略与 Node 同一请求序列**：经入口 Worker、IC 闸门与授权，同一组 16 个请求在对象与 Node `startHeadlessServer` 上归一化后状态码、关键响应头与正文逐项相同：匿名 401（JSON 与拒绝页）、Actor Session bearer 403、管理员读写、过期 revision 409、非法规则与多余字段 400、跨源 403、PUT 405、成员只读与写入 403、撤销成员后闸门 403、重启后修订与审计保留。
- **配置、凭据与租约与 Node 账号装配同一调用序列**（31 步，含重启）：配置 CAS 与冲突消息、凭据格式错误消息、签发／兑现／续期、无需凭据与明文 HTTP provider 不可兑现、过期、按化身撤销、单个撤销、凭据轮换后兑现新值、重启后租约仍有效、删除凭据后不可兑现；对象存储（KV 全部条目与策略表）中不出现任何凭据明文。
- **驱逐**：AC 被驱逐后策略、凭据与租约不变；IC 被驱逐后，AC 的授权询问到达重建的 IC。
- **打开被拒绝**：缺失或畸形的密封密钥使 AC 保持关闭（503），重启后仍然；IC 照常服务。
- **入口**：内部授权路径经入口为 404；对象未装配的网关路由为 404 `missing`。
- **账号池与 Node 同一序列**（49 步，含主动续期与重启）：对象与 Node 文件 owner（同一 `assembleAccountPoolCore`，运行时超时唤醒）结果归一化后逐项相同：添加、重复与非法 id、首选／绑定／继承／元数据选号、亲和计数、配额耗尽后绑定迁移、排除、授权拒绝、全部不可用、恢复、停用、重排与不完整重排、Host token 签发与认证、两个即将到期的账号由唤醒主动续期（一个成功，一个被执行方以 `authorization-rejected` 拒绝、凭据保留、维护视图为 error）、按需续期、替换凭据、重启后账号／凭据／亲和／Host token 不变、删除后轮转。对象 SQL 中不出现任何凭据或 refresh token 明文，记录以 `ocr1.k1.` 密封。
- **驱逐后由 alarm 续期**：添加 2 s 后到期的账号并立即驱逐（无事件、内存丢弃），alarm 重建对象，调度从存储重新推导并经执行方续期；亲和仍在。
- **从第一部分升级与拒绝**：只有策略链的对象存储（第一部分的形状，带策略与模型凭据数据）重开后，策略账本逐行不变、修订仍在、凭据仍可兑现，`schema_family_migrations` 加入 `account-pool-host` v1–v4、`account-credential-records` v1 与 `model-gateway` v1–v4 三个族；篡改账号池链 checksum 时对象 503、恢复后重新服务；删去凭据记录链账本而保留其表时拒绝采纳（503）。Node 侧另有 `tests/storage/account-pool-sql-owner.test.ts`（进入 `test:storage-ports`）：主链旁两个族共存与各自版本、篡改／改名／更新历史／未声明的族／无账本对象／非法族 id／未声明对象的族的拒绝、失败迁移不留账本与对象、中立合同解析与 Node `resolveStoreMigrations` 相同、账号池表与 Node 文件 owner 的 schema 指纹相同、凭据记录链 checksum 钉住、密封绑定行与密钥、续期交换的校验、调度在假时钟上的到期／退避／重建；`account-pool-sql-port.test.ts` 把全部账号池用例另跑在"共享库＋迁移族＋密封 SQL 凭据记录"上。
- **租约交换、出口转发与撤销**：测试 Worker 以绑定调用方身份经交换签发、续期租约（非法 TTL 400）；出口以兑换到的凭据把 OpenAI 协议请求（`Bearer`）与 Anthropic 协议请求（`x-api-key`）转发到本机 loopback 上的 provider 替身：provider 只看到凭据、看不到租约令牌与 cookie，正文原样，首个事件在 provider 仍持有第二个事件时即到达（流式而非缓冲），`set-cookie` 被去掉；缺令牌、未知令牌、未知 provider、越出路径、按化身撤销、过期与单个撤销后一律拒绝且 provider 不再收到请求；两条内部路径经公开入口为 404；对象存储中不出现租约令牌或凭据明文。出口打包不触及存储与 `node:`。Node 侧 `tests/storage/credential-egress.test.ts`（进入 `test:storage-ports`）对交换客户端／服务端与出口做同样的检查。该场景需要本机 loopback provider，`cf:rehearsal` 在真实 Cloudflare 上跳过它。
- **模型网关与 Node 同一请求序列**（32 步，含重启）：经入口、IC 闸门与网关授权，对象与设置了网关文件的 Node `startHeadlessServer`（两边预置同一已批准服务）归一化后逐项相同：匿名 401（JSON 与拒绝页）、Actor Session bearer 403、管理员读、配置限额、过期 revision 409、非法限额与多余字段 400、跨源与非 JSON 403、管理员读成员、成员读、成员读他人与配置 403、个人限额、无订阅时 403、无同意的团队贡献 400、未批准服务 403、非法 key 400、贡献、目录、共享范围（无同意 400、有同意 200）、他人撤回 403、撤回、未知请求的对账、撤销成员后 403、重启后限额与撤回状态保留。对象存储中不出现贡献的 key 明文。
- **个人订阅经同对象账号池**：该 Human 在池中无账号时 `start` 503；测试经对象内的该 Human 池添加账号（安装池不可见）后 `start` 完成：网关账本中为个人、已共享的 `subscription-<sha256(actor)>`，模型配置中为该 provider（替身路由地址），其凭据是该 Human 池的 Host token（`authenticateHostToken` 认出 `personal-subscription:<sha>`），对象存储中无明文；`cancel` 为 `{cancelled:false}`；驱逐后贡献仍在、`poll` 再次完成、token 不变。
- **从第二部分升级与拒绝**：只有策略与账号池链的对象存储（第二部分的形状）重开后，其他链的账本逐行不变、策略修订仍在，只多出 `model-gateway` v1–v4；删去网关链账本而保留其表时拒绝采纳（503）。Node 侧 `model-gateway-sql-port.test.ts` 另把同一领域序列（限额、sponsor、预留、计量、对账、贡献、会话模型绑定、执行授权）跑在 Node 文件 owner 与"共享库＋迁移族"上，要求逐项相同。
- **中立打包**：对象入口不触及策略的 Node owner 与原生读取、账号池的文件 owner、网关的文件 owner（`model-gateway-store.ts`）、Codex Core 客户端与维护进程、代理、文件存储与 Node 账号输入；Node SQLite 包只触及生成迁移注册表（纯数据，无导入）；内建模块只有 `node:crypto`（迁移 checksum、同步记录密封、账号池摘要、语音绑定）与 `node:path`（外部凭据引用的绝对路径规则，纯计算）。

**仍缺（生产 AccountCore）：**

- **账号池的其余部分**：续期的 Node 执行适配器 `createNodeAccountRenewalExecutor` 已复用原生 Codex 执行器，处理私有 Fetch 协议并清理临时 profile。维护容器及 `ACCOUNT_MAINTENANCE` 生产绑定仍待装配；设备登录与用量查询（同样交给维护容器）未接；账号管理路由（列出、导入、启停、排序、删除）、Codex 请求的选号出口（Node 上是 `CodexAccountPoolProxy`）未在 AC 装配；按 Human 的个人账号池只作为个人订阅的视图使用（没有导入路由与登录）；Node Codex Core 尚未采用 `scheduleAccountRefresh`（仍按请求续期）。
- **模型网关的其余部分**：设置路由、领域与贡献已在 AC（上文"模型网关"），但计量的调用方不在：引擎请求的准入、预留与结算（`meteredModelRequest`、`bindModelGatewaySponsor`、`requiresModelGateway`）仍是 Node 进程按路径打开文件，Cloudflare 出口可复用 `@opencraft/account-pool-host/model-gateway-usage` 的流式回执观察器，终态帧等待计量 owner 提交后转发；出口到 AC 的执行准入、预留与结算接口仍待装配；个人订阅在 AC 中缺设备登录与订阅路由（Codex 选号出口），生产对象因此不声明订阅；`ModelGatewaySettingsTransport`（AppHost 侧设置）未迁。
- **语音**：未接上租约，原因见上文"语音"；HTTP 处理器仍是 `node:http` 形状（G4 "现可迁"）。
- **租约的其余部分**：交换契约与出口已有（上文），但 WorkspaceHost DO 与容器出站改走出口（C2）不存在；出口没有计量、按租约限额与协议转换（例如 Anthropic 转换需先确认能在 workerd 运行，§2.1）；Node 账号 Core 仍以按类型的不过期调用方令牌转发，未改用租约（P4-1 的剩余项）。
- **密封**：每记录数据密钥、密钥轮换与重新密封流程；密钥备份的运维说明。
- 引擎跨进程读取策略（`native.mjs`）在 Cloudflare 上的替代（AC 投影或 RPC）；容器内引擎拿到的策略快照与版本。
- 真实 Cloudflare 复核（`cf:rehearsal` 的 `account-core-do` 分组）。
### 5.7 装配包的 VFS

`@opencraft/runtime-plugin-host/package-vfs` 接收宿主指定的 manifest 摘要和限长的
`readFile(path, maxBytes)`。它校验 manifest 与登记文件后提供只读快照。
Docker 从只读目录取文件，DO 可以按相同相对路径从 R2 读取对象。本地 workerd
用 DO、R2 和 Worker Loader 运行测试包里的 Worker 模块，并验证摘要不匹配时拒绝加载。
正式 InstallationCore 目前提供核心登录路径，私有身份和服务装配尚未接入 DO。

### 5.7 WorkspaceHost 状态

状态（2026-11-24）：**正式 DO 装配覆盖 Host SQL、容器生命周期、Engine Host 输入与执行观察、空闲、中断恢复、化身围栏、凭据租约调用点和运维路由**。本地 workerd 使用容器替身；真实 Cloudflare 临时环境已通过原生 Codex 与 Linux Hands 验收（第 7.6 节），其他覆盖范围见本节各项。

**位置与理由。** DO 类在 `apps/headless-server/src/cloudflare/workspace-host.ts`，理由与 §5.5 相同：它是小组合根，调用 Node 根也调用的 workspace-host 模块（`src/assembly/workspace-host.mjs`），不能放进 `packages/`。同目录的 `workspace-link.ts`（端点字节流上的 HTTP/1.1 与 RFC 6455 客户端）与 `workspace-engine.ts`（容器 Engine Host 与执行历史读取）是模块既有工厂端口的 DO 侧适配器，不是新端口。Host SQL 的族组合在 `src/assembly/workspace-host-sql.ts`（不按平台命名：将来 Node 合库用同一份），运维与对象路由在 `src/workspace-host-routes.ts`（入口 Worker 与对象共用）。`check:boundaries` 对 `cloudflare/`、路由表与 `@opencraft/sql/families` 施加 §5.5 的同一中立规则。

**打开顺序。** 构造函数在 `blockConcurrencyWhile` 内：解析配置（var，非机密），读取并校验对象状态文档 `workspace-host/identity`；按空闲配置重设容器的 inactivity timeout。机器 ID 与 Brain 共用运行时 UUID v4 契约，新绑定参数无效时返回 400，存量无效绑定在启动容器前保持关闭。未绑定的对象不迁移、不启动任何东西（`status` 答 `unbound`）。已绑定（内部 `open` 固化工作区、机器 ID 和可选的 Actor 所有者，同一身份可重复打开，身份冲突返回 409）时依次：迁移 Host SQL 族；对象唯一 alarm 经 `mergedOwnerWake` 供空闲、租约续期与中断恢复共用；provider 注册表 → backend → `createSandboxPool`（默认 4 vCPU／8 GiB，容量一个环境）→ `createWorkspaceRuntime`（placement 记录在状态文档）；同一 SQL 上的 `ExecutionLeaseStore` 与 `SqlInterruptedTurnRecovery`；`assembleWorkspaceHost(...)` 后按 Node 根顺序调用 `openConversationExecution`、`openEngines`（`attachIndependentEngine`＝容器 Engine Host 适配器，其余引擎工厂明确拒绝）、`openExecutionObservation`（`openExecutionLeases`＝DO SQL 上的租约库，`createExecutionRecovery`＝端点上的历史读取，`reportedExecutionProcess` 只收所有者上报）。打开期间任何会启动容器的使用都被拒绝（启动时的未定租约对账因此保持未知，不为它启动容器）；打开失败按具名 disposer 回滚并保持关闭（503），重启后仍是。

**多库共存（Host SQL 族）。** WH 拥有的每个库保留各自已发布的迁移链（发布前缀＋存储注册表追加的生成 SQL，经中立 `resolveSqlMigrationContract` 取得，与 Node owner 应用的完全相同），作为同一数据库内的一个**族**，记在 `schema_family_migrations`：与 AccountCore、Server 扩展族是同一原语 `@opencraft/sql/families`（[存储端口 §3.1](storage-ports.md#生命周期仍归-owner)），这里用 `families` 组合——没有主链，全部是平级族。规则：每族版本连续、SHA-256 逐行核对，篡改为 `history-mismatch`，超出声明或账本中有本构建未声明的族为 `newer-schema`；已有单链 `schema_migrations` 的库与无账本却有对象的库都拒绝、不采纳；每个迁移一个 `transaction()`，事务内重新校验。族与理由：

| 族（注册表 schema id） | Node 上的文件 | 内容 |
| --- | --- | --- |
| `opencraft-host-state-database` | `opencraft-host-state.sqlite` | queue、投递、执行租约（v15）、thread directory（`durable-thread-catalog`）、senders／Bot／IOA、token usage 表 |
| `provisional-threads` | `thread-creations.sqlite` | 暂定线程 |
| `host-schedules` | `conversation-schedules.sqlite` | 会话定时任务 |
| `host-recovery` | `interrupted-turn-recovery.sqlite` | 中断 Turn 恢复 |
| `provider-retry` | `provider-turn-retry.sqlite` | provider 重试 |
| `employee-git-vault-store` | `employee-git-vault.sqlite` | 员工 Git vault |

不作为族：`thread-identity-database`（其执行租约迁移与 Host 状态 v15 是同一 SQL，WH 用 Host 状态的租约表）与 DSH 的 `thread-catalog`（引擎在容器内的库；WH 的 thread directory 是 Host 状态的表）——二者会重复创建 Host 状态已有的对象。各链对象互不相交由 Node 测试证明：族迁移后的库与六个 Node owner 各自文件的对象逐项相同。Node 仍按文件打开（`openManagedDatabase`），合库（workspace-host-split §4.1）时用同一运行器加 Node 的备份与校验。

**容器只经沙盒 provider。** 对象从不直接调用 `ctx.container.start`：`cloudflare://WorkspaceHost` 经 provider 注册表选择，创建经池准入、自定义实例、化身标签与身份 exec 校验（§7.5）；没有容器绑定时打开失败、对象关闭，不回退任何本机执行。provider 新增可选 `env`：容器主进程环境只带工作区 id 与 machine id（非机密，容器内无凭据）。Cloudflare 容器停止后释放原可写磁盘。已配置快照的环境先把引用写入放置状态，后续用沙盒池恢复；无可用快照时通过同一入口新建。两条路径都验证资源预算并分配新化身。

**WorkspaceLink 适配（模块 transport 工厂的 DO 侧）。** 容器内 owner 不变；对象持有 `WorkspaceRuntime.connect` 的端点连接（每连接一个 attached 中继进程），在字节流上说与 Node 客户端相同的协议：Engine Host 的描述符来自 agent `control` 的 `describe`（不读文件），与 `/health` 逐项一致（schema、pid、machine id、引擎集合、默认引擎），`/host-inputs` 提交与回执，`/execution-origin` 经 `WorkspaceRuntime.fenced` 只在前后两次 `probe` 都是已绑定 agent 化身时才采纳；执行历史读取（`thread/turns/list`、`thread/read`）每次一条新端点 WebSocket，忽略服务器请求，复用抽到中立模块的 `createNativeExecutionTurnInspector`。连接断开即失败，不重放；未知保持未知。

**Codex 的私有连接。** 为拥有 Codex AppServer 的工作区镜像设置 `OPENCRAFT_WORKSPACE_ENGINES=pi,codex` 和 `OPENCRAFT_WORKSPACE_IDLE=resident`。独立 Engine Host 继续处理自己的引擎。Codex 的控制查询经 `codex-control` 的私有令牌校验，采纳 Linux AppServer 自证的原生子进程化身；原生 WebSocket 拨固定的 `codex-native`，连接在 agent 化身围栏内建立。仅持有对象绑定的 owner 可以调用 `codex-health` 和 `codex-native?lane=…`，入口 Worker 不暴露这两个操作。调用方负责 Actor 授权、RPC 分发和生成稳定的 lane id。容器继续处理 Codex 回调与交互对账。传输遇到断开即关闭，不重送帧。Codex 工作区的默认空闲策略是常驻，配置兼容镜像并开启快照后，显式的运维休眠才请求磁盘快照。

**Codex Bridge 的 transport。** Node 的 Bridge Gateway 使用私有 loopback HTTP 和 SQLite Worker 装配 `BridgeGatewaySession`。共享会话层从注入的私有请求端口调用 Bridge Host，从收件箱恢复会话和事件身份，并在事件提交后确认游标。workerd 使用同一会话层和 DO SQL 收件箱验证提交、确认和驱逐后去重。

启用 `OPENCRAFT_WORKSPACE_CODEX_BRIDGE_ENDPOINT=true` 的安装使用包含 Bridge 运行包的固定镜像。Brain 等待原生 AppServer 就绪后，通过工作区 supervisor 启动和维护同一个 Bridge Host，发布私有 `codex-bridge` Unix 端点。WorkspaceHost 使用已认证的沙盒中继和化身围栏访问 Bridge 的既有 HTTP 协议，管理员唤醒工作区时检查 Bridge 健康。真实 Cloudflare 临时部署从固定镜像冷启，经同一个 transport 创建了原生 Codex Thread，读回 Bridge 投影的会话并确认事件游标。Workbench 目前仍使用 `codex-native`，Bridge 的产品会话路由与 Turn 准入仍待装配。

**Codex 首屏历史。** Client DO 通过 `opencraft/resume-history.initialReadPage` 声明被动分页读取。Workbench 可在 `thread/read` 中请求最近至多十轮，响应携带会话元数据、`initialTurnsPage` 和分页游标。休眠时从同一份 WorkspaceHost DO 快照读取。小页通过绑定 Thread 放置和快照的游标继续读，确认从同一快照恢复后也可读完该段，读到缓存末尾时交回原生游标。快照替换后旧游标返回 `HISTORY_PREVIEW_CURSOR_EXPIRED`，快照缺失沿用历史暂不可读的响应。容器运行时，新的首屏请求在同一放置回执和授权检查下并行使用现有只读通道。旧客户端继续逐项读取，更早内容仍走 `thread/turns/list`，活跃 Turn 的观察仍走原有恢复流程。

Bridge 生产者提供身份分页时，容器恢复后的历史读取在当前放置回执下运行。WorkspaceHost 校验 outbox ID 和生产者已确认的游标，从本地收件箱读取共同前缀的 Turn 和条目 ID，再从生产者获取尚未确认的身份页。历史读取不变更收件箱的放置、游标或归档，事件拉取和确认由实时路径负责。旧生产者沿用兼容回放。

生产者只提供身份分页时，指定 Turn 的历史请求在单次读取内复用解析目标时得到的身份映射。原生结果返回后，只读取该游标之后的新映射。生产者 ID 需要一致，最新游标需要覆盖已读位置，才能返回映射后的结果。这条规则由共享 Bridge Gateway 执行。

生产者声明身份筛选能力时，Gateway 用公开 Turn ID 解析指定的目标，再按本页出现的原生 ID 查询映射。已确认的前缀由本地收件箱筛选，尚未确认的部分由生产者筛选。两段查询沿用同一会话范围、生产者 ID 和游标校验。页内 ID 超过筛选预算时沿用身份分页，保留完整映射。

Bridge Host 的 SQLite v7 和 WorkspaceHost 的 Bridge inbox 迁移族 v5 按会话、历史 ID 和事件序号建索引。筛选查询通过这两类索引分别定位原生 ID 和公开 Turn ID，再按事件序号合并、去重和分页。索引在现有事件上建立，升级沿用原收件箱和 outbox 记录。

**归档历史。** 休眠前只采集最近未归档会话的正文，归档目录仍同步元数据。声明 `opencraft/thread-lifecycle.openArchivedHistory` 时，已打开的 Workbench 历史视图在首屏和分页读取中携带显式意图。WorkspaceHost 复核 Thread 放置、当前读取授权和归档状态。共享工作区在原有 Thread 放置记录中保存原生归档回执，Actor 工作区沿用资源生命周期记录。已确认归档时，普通正文请求在进入原生读取或快照之前返回 `THREAD_ARCHIVED`。元数据仍可读取。需要恢复时，仅恢复已记录的快照并走只读通道。快照不可用时返回历史暂不可读，目录浏览保持休眠。

**Hands 终端私有连接。** WorkspaceHost 经 agent 的 `terminal` 端点描述取得容器内 owner 的私有握手凭证，并通过 `WorkspaceRuntime.connect` 接入既有终端 owner。Node Gateway 和 DO 复用同一套帧解码、握手、请求回执和输出订阅，断开连接只释放中继，PTY 继续由 Hands 持有。云端验收先经 Workbench 启动工作区，再在真实 Linux 上开启 PTY。重新连接后读回同一个 Shell PID 和环境变量，输入与尺寸调整生效，另一 owner 被拒绝且收不到输出，终止由 Hands 确认。实测 UID 1000，`nofile` 1048576。独立冷启动验收同样跑通。先拒绝非 UUID 机器 ID 并保持未绑定；有效身份绑定后由首次终端连接启动容器，PTY 完成输入、续接、调整尺寸和终止。Brain 与 Hands 在每个工作区共用 Linux 用户。

**Workbench 终端。** Actor 独占工作区通过 AppHost 现有的 `process/*` 方法提供终端。InstallationCore 核验当前登录、默认 Space 和执行权限；绑定 Thread 的终端还核验 Thread 创建者与已提交的工作区归属。请求只到当前 Actor 的 WorkspaceHost。WorkspaceHost 先验证绑定，再经私有连接把操作交给 Hands PTY owner；输出交付前复核同一权限。共享工作区保留既有会话和 Turn，公开 Shell 仅在 Actor 独占模式下接入。

终端列表在容器停止时返回空目录。首次打开有效终端才启动 Hands；浏览器掉线只断开观察，可以按输出序号接回同一化身内的 PTY。活动观察保持物理连接；最后一个观察退出后可按工作区空闲策略保存磁盘并停止容器。磁盘快照保存文件，PTY 生命周期随原容器结束。workerd 验证跨 Actor 和跨 Thread 访问拒绝，并保留共享 Thread 的读取。独立 Cloudflare 验收通过 Chromium 的 Workbench runtime 验证冷目录无启动、真实 Shell 输入、调整尺寸、刷新后原 PID 和环境续接、进程退出，以及浏览器保持连接时容器继续按 alarm 休眠。

**归档后的终端资源。** WorkspaceHost 收到 Codex 原生归档或恢复回执后，先持久化该观察，再提交给 InstallationCore 的 `ConversationResourceLifecycle`。InstallationCore 用既有核心 SQL `conversation_resources` 提交会话资源代次和待确认 owner；对应 WorkspaceHost 经私有终端协议让 Hands 清理会话的 PTY 和仍在运行的同组后代。处理期间拒绝该 Thread 的新建、续接和输入，已有观察者仍可接收退出事件。同一 Actor 的未绑定终端继续运行。恢复归档完成终端 owner 的确认后开放新建。

WorkspaceHost 的 alarm 重发已持久化的观察，InstallationCore 的 alarm 重试未确认的清理。两者依赖原 Thread 的放置凭证，原容器停止后直接确认旧进程组已结束，正常空闲时没有终端清理定时请求。workerd 验证两个 DO 各自驱逐后恢复，重发观察时原生归档调用次数保持不变。真实 Cloudflare 和 Chromium 验证归档后 Shell 及其后台子进程均从 `/proc` 消失，独立终端继续可用，恢复归档后能新开终端并读回原 Turn。Codex 本身的归档回执丢失时结果仍未知。

**草稿终端归属。** 支持草稿终端的 AppHost 声明 `opencraft/terminal.draftScopeOnThreadStart`。Workbench 在首次创建 Thread 时提交已有的草稿 Scope。InstallationCore 用 Actor 与 Scope 固定创建身份，原生 Codex 回执仍由 WorkspaceHost 确认。InstallationCore 在回复创建前原子提交工作区内的双向绑定，原生 AppServer 只接收现有的创建参数。浏览器重连可以重获原 Thread 回执，草稿终端保留原来的物理句柄。

绑定提交后，现有草稿终端的输入、续接、目录和输出服从目标 Thread 的资源状态。归档时 InstallationCore 将同一 Actor 的草稿别名交给现有 Hands 清理协议。云端 Chromium 验证首个 Turn 前打开终端、创建后继续使用同一 Shell PID、归档后 Shell 及后台子进程均从 `/proc` 消失。另一个草稿的终端继续运行，恢复归档后可以重新新建终端。

**Codex Thread 归属。** WorkspaceHost 将私有 lane 上的 `thread/start` 和 `thread/fork` 成功响应与原请求关联。普通持久 Thread 的归属先写入 WorkspaceHost 的状态文档，随后成功响应才返回调用方。临时和延迟发布的创建、读取和通知均不会产生归属记录。InstallationCore 通过绑定向对应 WorkspaceHost 复核归属，查询还要求当前登录、安装成员身份、已记录的 Thread 权限与 Space 授权。归属发布失败可通过 WorkspaceHost 的私有操作从原记录重试，无需重放创建。归属记录可跨 DO 驱逐继续查询。已写入原生磁盘历史的 Thread 可以经同镜像快照恢复。

**按 Actor 分配工作区。** 设置 `OPENCRAFT_WORKSPACE_CODEX_ISOLATE_ACTORS=true` 后，无项目的新会话和模型目录使用由安装机器 ID 与 Human Actor ID 派生的工作区。WorkspaceHost 把 Actor 与机器身份一起固化，启动前核对名字与归属，拒绝其他 Actor 的创建和执行。登录世代变化仍由现有准入检查处理，工作区身份随 Actor 保留。共享部署使用默认工作区。已有 Thread 的读取、执行和分支沿用已提交的工作区归属，共享的 Thread 链接仍由 Space 与 Thread 权限控制。

workerd 通过真实登录入口验证两个 Actor 各自创建、执行和读取自己的 Thread，拒绝跨 Actor 执行，同时允许按 Space 权限读取已共享的 Thread。旧共享工作区的会话可按历史归属继续执行。独立 Cloudflare 验收用两个 Actor 绑定冷启动两个 Linux 容器；各自经私有 Hands 终端在同一路径写入不同内容，读回复核内容和容器化身均不同，伪造的所有者绑定被拒绝。

**会话目录。** Workbench 的 `thread/list` 使用当前选定工作区的原生 Codex 目录与排序。Actor 隔离模式当前列出该 Actor 的工作区，跨工作区目录聚合留待接线。WorkspaceHost 对每批候选记录附上已提交的归属凭证，InstallationCore 核对已发布的同一凭证以及当前的 Thread 和 Space 权限，随后返回目录元数据。每次请求最多扫描四页原生目录，跨过不可读记录后仍可用游标继续。分页位置经密封并绑定当前登录、工作区、筛选与排序方向。Codex 原生目录可发现已写入历史的会话。

首次浏览时，若容器未运行且工作区还没有环境放置记录，经准入的 `thread/list` 和 `project/list` 首屏由 DO 直接返回空页。工作区一旦提交过环境放置，目录继续从原生 Codex 读取。模型目录仍由原生 AppServer 提供，浏览器自动查询时会启动容器。workerd 场景断言空目录的容器启动计数为零，并对比首次文件目录读取启动容器后的项目创建与读取。

**会话生命周期。** Cloudflare AppHost 声明重命名和归档能力，经原生 `thread/name/set`、`thread/archive` 和 `thread/unarchive` 更新 Codex。InstallationCore 核验当前会话创建者的权限，WorkspaceHost 在同一可写通道上重新核验权限和执行状态后发送。归档前读取原生 Thread 状态，活跃或仍有未结执行的会话会在发送前返回拒绝，原生回执不明时保留未知结果。归档保留归属和历史，目录通过原生 `archived` 条件展示结果。恢复归档校验回执与原 Thread ID 一致。真实 Cloudflare Browser Run 验证了同一 Thread 依次改名、进入归档目录、恢复到普通目录，随后读回原 Turn 与完整回复。五次原生创建、执行和生命周期操作各发起一次。

**会话分支。** 持久分支使用原生 `thread/fork`，可包含指定的已完成 Turn 或截在指定 Turn 之前。InstallationCore 核验源会话创建者、执行权限及归属，子会话继承源 Space 和可见性。WorkspaceHost 经现有创建请求幂等记录和原生写通道发送，校验回执中的父子 ID。发布前先提交子会话的访问策略。未落盘或仍在执行的源会话暂缓分支。工作区、执行配置及自动 Goal 续跑由 Host 管理，分支后的首个显式 Turn 才开始执行。

真实 Cloudflare Chromium 验收从两个已完成 Turn 的会话分出只含第一个 Turn 的子会话，经 Workbench 分页读回原回复，在子会话继续执行一个 Turn，再截在该 Turn 之前创建第二级分支。父会话保留原来的两个 Turn。两次分支各发送一次原生请求，模型出口使用受控 Responses SSE。

**Workbench 新建聊天。** 启用 Codex Turns 的 AppHost 声明分页历史能力，Workbench 新建会话时发送原生 `historyMode: "paginated"`。未指定历史模式的创建请求沿用 legacy。Composer 通过 `model/list` 读取原生模型元数据，InstallationCore 复核默认 Space 的访问权限，WorkspaceHost 只交付 AccountCore 已启用的模型。显式模型选择经 `thread/start` 或 `turn/start` 转发，提交前再次核对配置。创建请求将选择固定在既有幂等记录里。空的项目目录、动态工具声明和默认 Space 可由 Composer 显式发送，部署仍持有工作区放置与沙盒配置。

Cloudflare AppHost 声明原生会话在首个 Turn 被接纳后可恢复。Workbench 使用既有首轮耐久性声明，先发送首条输入再切换到正式会话。云端预览的 Web 配置使用部署提供的工作区，AppHost 声明由服务端持有工具配置。

真实 Cloudflare 的 Chromium 预演从 Workbench 模型资源选中 `gpt-5.4`，经 Composer 新建草稿对应的 Thread，并发送首条输入。完整 Web 预览另经浏览器的账号登录页和发送按钮验证。原生 `thread/start` 和 `turn/start` 各调用一次，真实 Linux Hands 执行了受控 Responses SSE 所请求的命令。刷新后页面读回同一回复，目录返回了同一 Thread。

**Hands 放置。** Hands 是工作区的执行角色。可以由同一镜像、本机 Linux 服务或独立的受约束 Linux 环境承载。当前 Cloudflare 镜像验证同容器装配。Compose 已通过共享 Unix socket 拆分 Brain 和 Hands。跨机器时需要私有的认证传输和显式工作目录映射，继续由选定的 `CreateSandbox` backend 持有效资源预算、执行租约、取消和清理。模型出口与 Hands 放置独立。参见 [执行沙盒契约](../execution/execution-sandbox.md)。

**产品工作区镜像与模型入口。** Cloudflare 的 `deploy/docker/Dockerfile.owned-electron` 提供 `cloudflare-workspace` target，继承 Docker 与 E2B 共用的 Hands 镜像构建和同次打包的 Brain 运行时。部署使用一个固定 Registry 镜像 digest。它在私有 cgroup 命名空间中为工作区建立子组，设置 4 vCPU、8 GiB 和 4096 tasks，并将该组只读挂载给 Hands 核验。启动进程确保每个进程继承的文件描述符软上限至少为 65536，随后降为镜像指定的非 root UID/GID，WorkspaceHost 的 `OPENCRAFT_WORKSPACE_USER` 须使用同一 UID/GID 打开代理通道。它消费既有产品发布的 Linux 运行时和固定版本 Codex，由非 root 的 `workspace-agent --role hands --role brain` 启动原生 AppServer、官方 Hands exec-server 和 Pi。Cloudflare target 在同一 Hands 镜像上增加 Tini，启动脚本在切换到工作区 UID/GID 后以 Tini 作为 PID 1，回收已退出的孤儿进程。默认 Docker target 继续选择现有 Compose 装配。给 Cloudflare 工作区配置镜像 digest、`OPENCRAFT_WORKSPACE_ENGINES=pi,codex`、常驻策略以及 `OPENCRAFT_WORKSPACE_CODEX_EGRESS_ORIGIN`／`OPENCRAFT_WORKSPACE_CODEX_EGRESS_PROVIDER`，由放置 owner 下发安装的 machine ID 和两个非秘密出口参数。首次写入的 machine ID 与已有身份冲突时拒绝启动。Hands 继续核验有效 CPU、内存、4096 tasks 约束。Cloudflare 的自定义实例配置仅暴露 vCPU、内存和磁盘；其 `durable_object` 调度下的进程具有 root 级能力，UID 和文件模式只用于文件归属。组合 Brain／Hands 的活跃任务隔离、进程能力和实际 cgroup 仍需在目标平台上证明。[Cloudflare Container API](https://developers.cloudflare.com/containers/api/durable-object-container/)

本地 Docker 以该 target 的默认入口验证了 Hands、文件、终端、Pi 和 Codex owner 就绪，真实 Codex 经回环模型替身完成流式 Turn，连接恢复后可读并续接同一 Thread。只读策略的原生 `exec_command` 已到达 Hands 沙盒；当前本地 Docker 的默认运行条件拒绝 Bubblewrap 创建命名空间，加用现有 Compose Hands capability 集后仍拒绝 `pivot_root`。独立 Ubuntu 24.04 VM 中，以同一镜像内的运行时运行真实 Codex 和 Hands。临时 systemd 测试服务允许该服务建立用户命名空间，保留 Codex 的原生只读沙盒。测试读取了实际的 4 vCPU、8 GiB、4096 tasks cgroup 限制；原生命令进程以非 root 身份返回退出码 0、65536 FD 上限，并收到只读工作区的写入拒绝。该结果适用于本次 VM 配置；Cloudflare 容器的沙盒与持久恢复仍需在目标运行时验收。

云端的独立 microVM 已验证关闭通用出网时指定私有 HTTP 主机可被 WorkerEntrypoint 拦截并返回 200。以 4 vCPU／8 GiB 配置读取平台原生 cgroup，内存为 `8589934592`，`cpu.max` 为 `max 100000`，`pids.max` 为 `max`；Hands 要求实际落实 CPU 配额和 4096 tasks 后才能启动。独立云端探针证实可在委派的子 cgroup 中设置全部三项限制，挂载只读视图，并以非 root 身份创建用户命名空间。

2026-11-24 在临时 Cloudflare 部署上，用同一固定候选镜像的默认入口冷启。安装登录、AppHost 握手、首次创建 Thread、授权 `turn/start`、两段文本增量与 `turn/completed` 均通过。重复提交同一创建请求返回原 Thread，AppHost 重连后能读回同一 Thread 和已完成 Turn。真实 Codex 经私有模型出口访问受控 Responses SSE，并通过真实 Linux Hands 执行命令。命令在 `/opencraft-workspace` 子 cgroup 内以 UID 1000、退出码 0 完成，文件描述符软上限 1048576，满足 65536 下限。该次验证覆盖云端传输和实际执行，外部模型服务推理待验证。验收后删除本次临时 Worker、队列和容器应用，保留固定候选镜像。

Brain 的 `workspace-egress` 模式通过私有 Unix socket 给 AppServer 返回本次启动的回环地址与本地合成认证。回环中继接收模型列表与 Responses 请求，经 HTTP 发送至配置的 `/__opencraft_egress/<provider>/{models,responses}`，流式传递结果，移除本地认证与会话头。WorkspaceHost 在同一容器上有界等待 agent `ready`，随后才使用已发布的端点。原生 AppServer 在建 Thread 时就读取模型目录。AccountCore 通过工作区化身的有效 Codex 租约返回已配置的模型元数据。Responses 请求还须通过当前 Turn 的权限复核。凭据与租约留在容器外，原生 ChatGPT OAuth 账号选择与计量仍需 AccountCore 装配。

`turn/interrupt` 经 Client DO 到 WorkspaceHost，复核当前登录、Thread 执行权限和已提交归属。WorkspaceHost 校验活动 Turn 的 `threadId`、`turnId` 和工作区化身，通过持有此 Turn 的原生连接发出停止请求。原生回执与 `turn/completed` 分别交付，执行租约在收到终态后结算。相同活动 Turn 的停止请求共享一次原生调用。浏览器断开只结束本次事件投递，已提交的 Turn 仍由 WorkspaceHost 持有。云端受控 SSE 预演在浏览器重连后读回同一活跃 Turn，再收到真实 Codex 的停止回执及 `interrupted` 终态。

**原生审批。** WorkspaceHost 复用 Node 路径的 `HostInteractions`，通过现有 `opencraft/shared-interactions` 协议投影原生待审批请求。停止、读取互动和提交互动共用一个私有 Turn 控制入口。回复按 Thread、Turn、容器化身及当前执行权限校验，带原生回调 ID 和回调键发回原连接。原生 `serverRequest/resolved` 或 Turn 终态负责结算互动。90 秒期限只约束提交前的准入。真实云端预演在浏览器断开约 100 秒后读回同一待审批请求，批准后命令退出码为 0，重复提交返回已结算结果。另一轮真实云端预演主动重建 WorkspaceHost，凭已持久化的执行租约核对原 Codex 进程与 Turn，重新连接原生回调通道，借助回调重投恢复原审批 ID，继续执行至完成。容器与原生进程须仍在运行。

**原生历史分页。** Workbench 先用 `thread/read` 读取会话元数据，再按原生 `thread/turns/list` 和 `thread/items/list` 游标读取支持分页的会话。分页经既有 Thread 读取入口，WorkspaceHost 和 ClientDO 在返回前再次核对会话归属和访问权限。超过中继大小上限的历史响应返回既有缩页错误，Workbench 可继续缩小请求。Codex 0.162.1 的 legacy 会话保留原读取方式，也可用原生 Turn 分页，原生 Item 分页需要分页会话。

真实 Cloudflare Chromium 验收创建了分页会话，完成两个 Turn，刷新后通过分页重建原时间线。原生 Turn 游标返回较早的 Turn，三次原生 Item 分页读到原回复。另一轮先让容器自动休眠，再刷新并从新化身读回同一条时间线，也验证了归档期间仍可分页读取及恢复归档。两轮刷新都通过分页完成。

**活跃流重连。** Cloudflare AppHost 提供 `thread/resume`。InstallationCore 复核当前登录、执行权限和 Thread 归属。WorkspaceHost 按已授权的 Thread ID 调用同一条原生执行通道，审批和执行租约继续由原 owner 持有。客户端传来的路径、工作目录与模型信息只用于核对回执。首次输入前，工作区用已持有的原生创建回执提供空历史及执行设置。真实 Cloudflare 预演经新 AppHost WebSocket 读回同一活跃 Turn，收到后续 `item/agentMessage/delta` 与完整的 `item/completed`，再次读取历史得到相同文本。原生快照缺少断线前尚未完成的文本，完整消息以完成通知和历史为准。

**命令执行过程。** WorkspaceHost 和 ClientDO 使用同一范围检查转发原生 `commandExecution` 的 `item/started`、`item/commandExecution/outputDelta` 和 `item/completed`。重连订阅沿用原 Item ID，Workbench 用已有时间线消费命令、输出和退出状态。大输出在传输中保留尾部，历史仍由 Codex 持有。真实 Cloudflare Browser Run 验证固定镜像中的 Codex 0.162.1 依次发送命令开始、四条增量和退出码 0。Workbench 在 Linux Hands 进程退出前显示了输出。受控 Responses SSE 触发了这次命令。

**原生活动时间线。** WorkspaceHost 创建、恢复和分支 Thread 时使用 Codex 自带的 `tools.update_plan.enabled`。Cloudflare Turn 与重连续接复用原生计划、推理、文件变更以及 `thread/tokenUsage/updated` 通知，WorkspaceHost 和 ClientDO 均按当前 Thread、Turn 核对范围。现有 Workbench 投影器负责呈现计划、推理摘要和文件 diff。文件变更继续走原生审批，普通 Turn 提交不授予额外写权限。Token 通知提供当前 Thread 的实时用量；持久计量账本和查询仍待接入。

**运行中追加输入。** Workbench 可用原生 `turn/steer` 向 `expectedTurnId` 指定的活跃 Turn 追加文本。Cloudflare 试点要求调用者仍是该 Turn 的原执行主体，并检查当前 Thread 权限、工作区化身与模型租约。发送前，WorkspaceHost 将输入 ID 与作者写入已有执行提交表。追加输入沿用原执行租约、模型与环境。RPC 收到匹配的原生回执后才返回成功，回执不明的 ID 留待按原生历史核对，重发同一 ID 不会再次调用 Codex。原生 `userMessage` 事件携带 Client ID，供 Workbench 对齐同一条输入。真实 Cloudflare Browser Run 在 Linux Hands 执行期间发送了一次 `turn/steer`，同一 Turn 产生一条原生用户消息，受控 Responses 服务在下一次模型请求里收到该输入。

Workbench 打开会话或重连时先读取历史。对于本窗口已收到回执且服务端仍报告运行中的 Turn，重连时复用执行激活恢复订阅。Cloudflare AppHost 在 `opencraft/resume-history` 中声明 `observeActiveTurns`，已打开的会话可依据原生历史中的运行状态订阅同一 Turn，覆盖刷新后的新窗口。订阅仍经 `thread/resume` 核对执行权限，拒绝时保留已读取的历史。订阅前后若 Turn 已完成，Workbench 用原生历史确认终态。支持 `opencraft/read-history` 的 Host 沿用既有 Watch 路径。

真实 Cloudflare Browser Run 验证了同一浏览器运行时断线重连。随后在 Linux Hands 执行期间刷新页面，新 Workbench 运行时用一次原生 `thread/resume` 订阅同一 Turn，收到回复增量与完成事件，整个过程只有一次 `turn/start`。云端推理由受控 Responses SSE 提供。

**Codex 计划休眠。** 使用支持快照启动的镜像时，安装可显式设置 `OPENCRAFT_WORKSPACE_CODEX_SNAPSHOTS=true`。运维 `sleep` 确认没有活跃执行、审批恢复或仍在使用的端点后，释放空闲的原生通道。配置了 Bridge 时，WorkspaceHost 在休眠前使用当前放置回执读取 Bridge 维护状态，确认没有正在派发的输入。WorkspaceRuntime 在停止容器前提交 placement 中的快照引用；快照失败时保留原容器。镜像入口在新启动时清理从快照带来的旧 Brain 与终端 owner 进程锁目录，再由真实 Codex 读取原生历史。快照绑定同一个镜像摘要，有 30 天时限，仅包含磁盘。崩溃发生在快照之前、未写入原生历史的数据、跨镜像迁移和周期捕获属于其他路径。

真实 Cloudflare 预演使用支持快照启动的固定镜像。运维 `sleep` 确认停止原容器，AppHost 的下一次历史读取恢复相同 Thread 和已完成 Turn，工作区 epoch 从 1 增至 2。第二个 Turn 在原 Thread 上完成，并经新容器内的真实 Linux Hands 执行命令。模型出口使用受控 Responses SSE。

**空闲（§3.7.2）。** WorkspaceHost 的 alarm 根据最近使用时间检查端点、待恢复记录和仍在执行的 Turn，并结算已结束的 Engine Host 租约。空闲时长默认 15 分钟，由 `OPENCRAFT_WORKSPACE_IDLE` 配置，`resident` 为常驻。启用 Codex 快照时，alarm 与运维操作走同一条休眠路径。对象驱逐后从持久化的最近使用时间恢复截止时间；仍有未写入原生历史的会话、未结算租约或活动连接时保持运行。Codex 关闭由 WorkspaceHost 在快照引用提交后发起；容器侧 inactivity timeout 仅用于未启用 Codex 的配置。快照失败后延时重试。休眠期间到达的工作区请求等待休眠结束，再按原路径执行。

`model/list` 复用 AccountCore 当前模型配置和 Codex 目录元数据，通过既有 AppHost 路由返回。分页游标绑定提供商和配置版本。支持 `opencraft/model-catalog-revalidation` 的连接在编译新 Turn 前重读目录，避免沿用已变更的默认模型。Thread 创建及显式选模也先校验当前配置，停用的模型会在启动 Linux 前被拒绝。容器内的模型出口仍执行凭据租约校验。workerd 覆盖冷工作区和快照休眠后的读、同连接内配置换版、旧游标拒绝和原生执行回归。

Client DO 通过 `acceptWebSocket` 接受浏览器连接。连接附件保留准入身份、AppHost 渲染端 ID、Host 代次及已确认的 lease 初始化状态。对象内存被释放后，业务帧先重新核对准入，再用共用 AppHost 会话重建控制层，原 socket 继续使用，Turn 请求、终端输入和其他业务帧不进入附件。Workbench 定期探活由 Cloudflare 自动回包，回到前台时仍使用单独的探活 ID。真实 Cloudflare 在同一条 AppHost WebSocket 上观察到 Client DO 实例更换，并在持续探活后成功重建原 lease、继续读目录。独立账单时长未测。[Cloudflare WebSocket hibernation](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)

WorkspaceHost 在快照休眠前通过已绑定的容器收集目录，并将投影与本次快照及容器放置回执关联。已休眠时，按更新时间倒序的会话目录复用 `SqlThreadDirectory`，按维护顺序的项目目录使用已提交的原生 Project 元数据。两条路径保留当前 Actor 授权，并支持分页。旧部署缺少有效投影及其他原生筛选或排序时继续走原生查询。`process/list` 以一次性请求读取清单，启动或接回 PTY 才打开输出事件连接。workerd 验证会话和项目的冷分页与对象驱逐，真实 Cloudflare 验证目录读、项目翻页及终端清单没有改变容器 epoch，并观察到实际打开 PTY 后 epoch 恰好递增一次。

会话目录还可携带最近一次已观察的终态 Turn 摘要。WorkspaceHost 从原生 `turn/completed` 记录 Turn ID、状态和完成时间，显式读取旧会话的最新历史时也可补齐缺失摘要。安装层按会话的现有放置与访问权限交付该字段。侧栏用同一份账号已读回执判断未读。支持摘要的会话目录行即使暂缺摘要，侧栏也不逐会话补读历史；其他 Host 沿用原有补查。打开会话查看原生历史仍可按需启动 Linux。

支持 `archiveStateInRead` 的 AppHost 在现有 `thread/read` 中返回归档状态。InstallationCore 在复核权限与放置后读取已提交的生命周期观察。WorkspaceHost 已收到原生确认、仍在重试发表该观察时，优先采用该工作区的确认结果。直达会话只读取指定 Thread。响应缺少归档状态时，Workbench 仍消费该会话的生命周期回执、通知和明确的读取拒绝。归档目录分页由用户主动浏览触发。归档会话的历史仍可读取，执行沿用现有准入规则。 归档 Bridge 会话的历史读取经当前工作区的 Bridge 记录解析原生身份，再使用原生只读 AppServer 通道和公开身份投影。容器重启后也可读取，无需恢复执行会话。

部署配置中带有明确 AppHost 的会话直达链接在 Workbench 初始化期间开始准入和连接。页面装配接管同一逻辑通道。带容器快照的工作区在已运行的容器上有界采集最近会话的首屏历史，服务端将记录与放置和本次休眠快照绑定。休眠时通过 WorkspaceHost DO 读取已采集的历史，返回前复核当前权限。缺失或超出缓存范围的读返回暂不可用。已运行的容器可以按原放置回执接回，读取路径没有恢复或创建容器的权限。发起 Turn 仍走原生执行准入。活动会话缺少首屏历史时，当前 Host 可返回明确的休眠状态。Workbench 使用已提交文本的原消息 ID 调用原生 `turn/start`，原生授权和回执继续拥有执行准入。历史随后追平，归档会话继续只读。

2026-11-25，真实 Cloudflare 演练从快照休眠状态打开并刷新已登录的 Chromium Workbench。两次都读到会话和项目目录、显示同一未读标记，并且没有发出侧栏历史补查或增加 Linux epoch。浏览器留在首页，持续收到探活回复后观察到 Client DO 实例重建，原 WebSocket 和 AppHost lease 上继续读取两页项目，Linux 仍处于停止状态。随后从休眠打开项目 PTY，epoch 增加一次并收到 `uname -s` 的 Linux 输出。再次休眠后，经新 AppHost 连接直接发送原生 Codex Turn，epoch 也只增加一次，GPT-OSS 20B 完成回复。演练使用隔离的 Worker 与容器应用，结束后核对了回收结果。

独立 Cloudflare 验收将空闲期限设为 25 秒。WorkspaceHost 的 alarm 捕获快照并停止原容器，下一次 AppHost 历史读取唤醒新化身并返回原 Thread 的完整回复。随后在同一 Thread 上完成第二个 Turn，Linux Hands 再次执行命令。模型出口使用受控 Responses SSE。

**中断恢复与化身围栏。** 新化身是旧执行进程结束的证据：`created`（带 previous）、`incarnation-changed`，或 provider 报告丢失（`released lost:*`，来自 `monitor()`）时，在新绑定被使用**之前**同步：执行租约 `suspend()`、恢复行 `lost()`、请求一次恢复。恢复由 Host 状态驱动：`inspect` 只用所有者经围栏上报的当前 Turn（同一 Turn 仍在进行为 live，已结束或有更新的 Turn 为 finished，只有带丢失证据且当前化身没有它才是 lost，读取失败为 unknown）；`continue` 以 Host 自有的 `restart-recovery:` 输入 id 提交系统续写提示，原输入从不重放；最多 3 次、`dispatching` 中断为 unconfirmed，规则与 Node 相同（`@opencraft/host-recovery`）。被接受的 Host 输入在引擎给出 Turn 时登记为恢复行。对象持久化化身纪元（状态文档 `epoch`，每个新 agent 化身加一）并在 `status` 中报告。注意：`fenced` 发现化身变化会释放绑定，而 Cloudflare 环境的 `close` 就是销毁容器，所以容器内 agent 重启后的下一次使用是新容器。

**凭据租约。** 端口 `WorkspaceCredentialLeases` 是 `CredentialLeases` 的结构子集；持有者 `{workspace, engine, incarnation}`。新化身绑定时先撤销该引擎旧租约再申请，休眠、丢失与化身变化时 `revokeHolder({workspace})`，到半寿命时经 alarm 续期（失效则为同一化身重新申请）。启用私有 Codex 模型出口的生产对象通过绑定的 AccountCore 申请租约。WorkspaceHost 从内存读取本化身的令牌并用于出口认证。容器只接收模型目录和推理响应。

**路由。** 入口 Worker 把 `/__opencraft_workspaces/<工作区 id>/{status,wake,sleep}`（与 Node `workspace-admin.mjs` 的运维操作对应）按 `idFromName("workspace:<id>")` 转给该工作区对象，转发前把请求的 cookie／authorization 交给 InstallationCore 的 `/__opencraft_access/session`，只有管理员才转发（401／403 原样）；非法 id 与其他方法 404。`open`、`inputs`、`execution` 是 owner 之间的内部操作，入口从不转发；Client 会话到工作区的路由依赖尚未抽出的 client-session（gateway-split §4.1.1"G1 剩余"），本步不做。

**证明。** `npm run test:workspace-host:workerd` 新增 `tests/storage/workspace-host-do-workerd.test.ts`（场景 `workspace-host-do.scenarios.ts`，替身 `workspace-container-double.ts`：在 isolate 内逐帧扮演共享 broker、固定中继、`workspace-agent` 的 `control` 与 Engine Host 的 HTTP／WebSocket，`monitor()`／`destroy()`／崩溃／DO 重置语义同 Node 夹具）：未绑定不迁移不启动、六族账本与表；容器只经 provider 启动（4 vCPU／8 GiB 自定义实例、无 Internet、化身标签、启动环境只含工作区 id 与 machine id）；Host 输入经模块到 Engine Host，租约库记录、恢复行登记、围栏上报；进行中 Turn 不空闲、结束后 alarm 停止容器并结算租约、撤销租约、唤醒为新化身、驱逐后构造函数重设兜底并按 receipt 重连同一容器；崩溃后新化身只收到一次系统续写（无原文重放）、旧化身租约撤销、新化身获租约；agent 化身变化时上报被拒、绑定释放、唤醒后恢复；篡改族账本后对象 503；运维路由无会话 401、管理员 200。另有 `tests/storage/sql-migration-families.test.ts`（族账本规则、升级保数据、与 Node 文件对象相同，进入 `test:storage-ports`）、`tests/server/workspace-link.test.ts`（适配器对真实 `node:http`／`ws`）、`tests/execution/sandbox-cloudflare.test.ts` 的 `sleep` 用例。中立打包：部署入口不触及 `worker-owner`、`sandbox-node`、`personal-assistant`、`ws`、`proper-lockfile`、Node 引擎客户端与 Node 根；触及的 `sqlite-node` 文件逐一列出（来自与领域类、迁移常量同模块的 Node owner 子类与存储注册表，对象不调用），不得增长。为此 `bot-client.ts` 不再静态导入 Node 的 Bot 进程启动器，改由根注入（`openExecutionDelivery({ spawnAssistant })`，Node 行为不变）。InstallationCore 自身的中立检查改为打包 `installation-core.ts`，结论不变。

私有 Codex 连接另经本地 workerd 验证对象路由、无公开入口、并行 Pi 输入及容器崩溃后关闭私有连接。Node 端以真实 HTTP 与回调 relay 验证化身围栏、流式通知、审批重连与去重、`thread/resume` 及 `turn/interrupt` 的传递，原生进程在该测试里为协议替身。另以本地 Linux 容器内的真实 Codex 0.162.1 AppServer 和回环模型替身验证进程化身、Turn 流式完成、断线后读取并续接同一 Thread。

**个人工作区文件。** 同时启用隔离工作区与 `OPENCRAFT_WORKSPACE_CODEX_FILES=true` 的安装，可以经现有 Workbench Files 入口列目录、读元数据及读写普通文件。ClientDO 从 Thread placement 解析工作区，WorkspaceHost 复核当前 Actor、提交回执和归档状态。范围回执本身只读 DO 状态。实际读写经 WorkspaceRuntime 围栏，送入同一镜像内已有 Hands 文件 owner 的私有端点。端点固定在个人工作区的 Codex 目录，拒绝越界路径以及经软链接或硬链接读写，单文件读写上限 512 KiB。部署需要包含该端点的镜像。

本地 workerd 验证共享会话的其他 Actor 仍可读会话历史、文件入口仅授予工作区 owner。实际 Linux 候选镜像通过 512 KiB 往返、目录和元数据查询以及链接拒绝检查。临时 Cloudflare 部署的 Chromium 客户端通过 Workbench 文件接口写入、读取和列目录，由同一容器的终端读回文件，并验证越界和软链接拒绝、归档停用和取消归档恢复。

完整 Web Workbench 在同一镜像的临时预览中，从会话工作目录打开测试文本，编辑并保存。更新 Web 资源后，分别用桌面鼠标、宽窗口触控模拟和手机尺寸触控模拟验证面包屑从授权根目录开始、返回到该根目录时父目录操作禁用，以及回到会话目录后重新读到已保存的文本。

**个人项目。** `OPENCRAFT_WORKSPACE_CODEX_PROJECTS=true` 与隔离工作区及文件端点一起启用时，Workbench 使用现有目录选择器浏览 Actor 自己的 Hands 目录。WorkspaceHost 将 `project/list` 和 `project/create` 转给容器里的原生 Codex AppServer，由它持久化 Project 与幂等键。登记前通过已有文件端点检查所选目录。首次发送时，WorkspaceHost 从同一原生目录验证项目 ID 和工作目录，再沿用已有 `thread/start` 路径，确认回执中原生 Thread 保留了项目 ID 和工作目录。项目终端复用同一 Hands 进程 owner，启动时验证项目目录和 Thread 归属。

终端命令由 ClientDO 经私有绑定逐次请求 WorkspaceHost，输出和退出事件仍由绑定内的 WebSocket 单向送回客户端。每个命令关联已准入的终端会话，WorkspaceHost 继续核对 Actor、Thread 和 Project 范围。拆分解决真实 Cloudflare 在长时间使用双向 DO WebSocket 时出现的子请求调用深度错误。云端验收复用固定镜像，核对项目登记重试、原生 Thread 的项目 ID 和目录、完成的 Linux Hands Turn，以及项目终端连续输入后返回的实际 `pwd`。

完整 Web 预览的 Cloudflare Host profile 将静态 `workspaceBrowseRoots` 设为空，未选项目的新会话由 Codex 分配目录。Workbench 在云端登录后用 DO 声明的项目根进入目录选择器和草稿终端。真实 Chromium 通过目录选择器登记 Hands 已有的目录，在该 Project 发送首条消息，并在会话里的终端读回同一工作目录。手机尺寸的触控模拟另验证了进入项目根、打开项目子目录和取消选择。

按第 5 节的 Web 发布构建和静态资源打包部署后，真实 Chrome 使用同源 AppHost V3 登录。草稿终端进入生产 DO 声明的项目根。新 Turn 在已有 Project 中展示推理摘要与文件审批，批准一次后接收最终文本并展示实际 diff。重开会话能读回文件变更，项目终端返回同一个项目目录。Chrome 的触控模拟也通过了登录、打开会话和查看 diff。此前另验证过关闭浏览器后恢复待处理审批。Workbench 在发送首个 Turn 前预备 Thread 投影，并在首次历史读取时保留活动计划。真实 Chrome 通过键盘和触控模拟分别在文件审批等待期间展开底部步骤，核对原生计划的 `inProgress` 状态，Turn 完成后底部计划收起。推理由受控 Responses SSE 提供。Cloudflare Turn 流和活跃 Turn 重连接收同一 WorkspaceHost 审批账本的 `opencraft/interactions/changed` 快照，排空时仍保留 Thread、epoch 和最新 revision。首次订阅也发送当前快照。DO 在发送每帧前继续验证调用方权限和 Thread placement。真实 Cloudflare 演练验证待处理、回复和清空快照，清空事件先于 Turn 完成。Chrome 原页面批准一次后清除审批控件和等待提示，继续收到回复与文件 diff。断开后经原生 AppHost 重新订阅同一 Turn，也收到待审批和清空快照，单次批准完成原 Turn。浏览器刷新期间曾出现目录与历史的 503，源于一次性 RPC 为每个请求申请了带重放标记的 Codex 通道。中继最多同时持有 32 个通道，普通闲置的可重放通道默认保留 60 秒。WorkspaceHost 的单次 RPC 现走既有的随连接关闭通道；Turn 和需要回调恢复的通道继续使用稳定 ID。独立 Cloudflare 演练重现旧路径读取失败；使用相同镜像与相同输入，修复后的工作区在一次审批等待中通过 40 次目录及历史读取，之后批准并完成同一 Turn。 真实 Chrome 在新 Turn 等待审批时刷新，重新收到相同 Thread 与 Turn 的审批快照。批准后显示回复及文件 diff；原生历史确认 Thread 只有一个 Turn，已完成且无待审批项。 ClientDO 按同一 AppHost 连接内的 Thread 与 Turn 认领事件流。后续 `thread/resume` 仍独立验证并返回对应的历史或元数据回执，已认领的事件流在收到终态、失联或连接关闭时释放。Workerd 演练在恢复审批后发起第二次元数据 Resume，再发起一个因路径校验被拒绝的 Resume，仍收到原有流的清空与完成事件。 真实 Cloudflare Chrome 在等待审批时刷新，批准后重复 Resume 与原 Turn 的实时 `turn/completed` 均到达刷新后的连接。原生历史核对只有一次 Turn 提交，文件变更和项目终端也通过验收。

**侧聊。** 云端 AppHost 支持在空闲父 Thread 上创建持久侧聊。WorkspaceHost 沿用原生 `thread/fork` 和 `thread/settings/update`，以父 Thread 和创建意图去重，将父子关系与放置记录一起提交。侧聊仍通过普通 Thread 接口恢复历史和发送 Turn。侧聊的固定指令随每次 Turn 提交，工作区目录继承自父 Thread。ClientDO 的 `thread/unsubscribe` 只解除对应 AppHost 连接的推送订阅。普通会话目录隐藏侧聊子 Thread。目前云端预览的侧聊索引使用浏览器存储。真实 Chrome 使用受控 Responses SSE 验证创建、发送、同浏览器刷新后恢复同一个子 Thread、关闭侧聊及再次刷新保留父会话。

**Bridge 持久收件箱与 Turn。** 启用 `OPENCRAFT_WORKSPACE_CODEX_BRIDGE_ENDPOINT=true` 后，WorkspaceHost 复用现有 AppServer-to-Bridge 会话映射，接入容器内的私有 Unix socket。新会话使用 Bridge 公共 Thread ID。DO 读取带持久源 ID 与保留范围的事件页，将事件和游标提交到自身 SQLite 后再确认。DO 重建继续使用原游标，发现源被替换或日志回滚就拒绝继续。Turn 创建、事件投递和模型出口仍由同一个 WorkspaceHost 绑定当前登录、Thread 放置和执行租约。固定镜像的 Cloudflare 演练通过公开 AppHost 验证了项目及无项目会话、流式输出、Linux Hands 的非 root UID 和至少 65,536 文件描述符、原生历史回读和侧聊。推理由受控 Responses SSE 提供。

**仍缺（剩余缺口）。**

- 真实 Cloudflare 的 AppHost 与固定镜像均通过 REST 和 Wrangler 部署验收（第 7.6 节）。Wrangler 4.168.0 使用正式模板上传 Worker、执行四个 SQLite DO 迁移，并自动创建 WorkspaceHost 容器应用。两条路径都经 AccountCore 的首次模型配置启动原生 Codex。
- IC 已接本地最小固定工作区分配，由 `OPENCRAFT_WORKSPACE_CODEX_DEFAULT` 指定默认 WorkspaceHost，并从安装的 machine identity 提供 `open` 所需的 machine id。跨 Actor 的项目协作工作区及通用 Assets 交付待接。
- 模块其余步骤未装配：执行交付（Assets vault、个人 Git、ENV）、浏览器、capability MCP、通用会话资源及 token usage。Codex 已接私有原生连接、文本 Turn、AppHost 续接、Workbench 断线或刷新后自动订阅活跃流，以及原生进程存活时的审批恢复。其余 AppHost 方法以及快照缺失或跨镜像的 Thread 恢复仍待装配。DSH 的独立端点也未接。
- `@opencraft/session-capabilities` 的 `session-authority` 持有会话声明、执行绑定、凭据用途校验，以及工具调用的执行身份。Node 的 MCP 监听器已经走这一层。`credential-wire` 的 Web Crypto 适配沿用现有 HMAC 凭据格式，本地 workerd 使用 MCP SDK 的 Fetch transport 验证了双向验签、绑定前拒绝调用、绑定后的目录及调用、撤销和 CLI 用途隔离。WorkspaceHost 的签发路由、容器访问和密钥归属仍待装配。
- 定时任务、provider 重试 owner 与 thread directory 同步未在对象中打开（表已迁移）；恢复通知没有客户端会话可推送；执行租约启动时钟为 `null`（应由容器 `control` 提供，workspace-host-split §3.4）；容器拒绝 epoch 落后连接需 agent 支持。
- 模型出口使用单个私有 HTTP 拦截主机。通用出站处理、HTTPS 拦截、原始 TCP `connectEndpoint` 与 DO 版迁移后 schema 校验（同 §5.4）待做。

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

`npm run cf:rehearsal`（`scripts/cloudflare/rehearsal.ts`）默认把第 4–6 节的 workerd 原型按与 Miniflare 测试相同的 esbuild 配置打包，经 Cloudflare REST API 部署到真实账号，运行与 `test:*:workerd` **同一组**共享场景（`tests/*/workerd/*.scenarios.ts`，经 `tests/cloudflare/scenarios.ts` 汇总，不复制断言），同时在本进程内用 Miniflare 跑一遍并逐项对比，最后删除本次创建的全部资源。显式 `--codex-image` 使用正式部署入口和固定镜像（第 7.6 节）。这些演练需要真实账号，不在 `test`、`gate` 或 CI 中；`tests/` 下的原型与场景不进入生产包。

### 7.1 用法与安全边界

```sh
CLOUDFLARE_ACCOUNT_ID=<32 位十六进制> CLOUDFLARE_API_TOKEN=<Workers Scripts + R2 编辑权限的 token；由代理注入时填任意占位> \
  npm run cf:rehearsal -- [--only '<分组: 场景名正则>'] [--skip-miniflare] [--report out.json] [--stale-minutes 10] [--keep] [--containers]
```

- **只碰自己的名字**：Worker 与 R2 bucket 名称为 `opencraft-rehearsal-<8 位随机运行 ID>-…`，创建、删除前都按精确名称和该正则核对，账号中运行前已存在且非演练残留的资源一律拒绝触碰。默认不创建容器、D1、KV；`--containers` 和 `--codex-image` 分别创建测试容器（第 7.5 和 7.6 节）。
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

### 7.6 原生 Codex AppHost 与 Linux Hands

给 `CLOUDFLARE_ACCOUNT_ID` 和 `CLOUDFLARE_API_TOKEN` 注入账号 ID 与 Workers Scripts、Containers 应用管理凭据。设置 `OPENCRAFT_CODEX_IMAGE` 为同账号已有的 `registry.cloudflare.com/<account>/<repository>@sha256:<digest>`，镜像需包含随包 Codex AppServer 和 Cloudflare Workspace Agent。

演练 Codex Bridge 时附加 `--codex-bridge`，使用包含 Bridge Host 与适配器的固定镜像。演练断言 Thread 由 Bridge 创建，并走同一公开 AppHost 验证完整 Turn。

2026-11-25 的 Bridge 演练通过了受控 Responses SSE、推理摘要、计划、文件审批与变更、Token 用量、至少 65,536 FD，以及 Linux 项目 PTY。审批等待期间并行执行的 40 次独立目录与历史读取均通过。随后回读同一 Bridge Thread 的原生历史，并确认临时 Worker 和容器应用已删除。独立 Bridge 预览使用真实 Chrome 验证新建、侧聊回复、刷新恢复、关闭侧聊和父 Thread 后续回复回读。刷新后较早提交的一次消息进入了重试，重新打开父会话并完成激活后提交成功。

```sh
npm run cf:rehearsal -- --codex-image "$OPENCRAFT_CODEX_IMAGE" --only '^codex:' --report codex-rehearsal.json
npm run cf:rehearsal -- --codex-image "$OPENCRAFT_CODEX_IMAGE" --codex-wrangler wrangler --report codex-wrangler.json
```

默认经 Cloudflare REST API 将正式 Worker 入口与其 InstallationCore、AccountCore、ClientDO、WorkspaceHost 接到固定镜像，入口外层要求每次运行生成的访问密钥。指定 `--codex-wrangler` 时，使用所给 CLI 和正式 Wrangler 模板的临时副本，入口直接使用安装本身的账号准入。两个模式都经 `OPENCRAFT_ACCOUNT_MODEL_BOOTSTRAP` 登记 Responses 测试服务与密封凭据，模型请求从真实容器经正式出口到达该服务。脚本不需要 R2、Browser Run、Queue 或本机 Docker，不扫描或回收此前演练残留资源。默认结束时按精确名称删除本次两个 Worker 和容器应用，并重新列出资源确认删除；镜像直接复用。若显式传入 `--keep`，调试后按本次输出的精确资源名清理。

需要验收真实模型时，给同一命令加 `--codex-provider /path/to/provider.json`。文件包含三项 `baseUrl`（包含版本路径的 HTTPS Responses 基地址）、`model` 和 `apiKey`。外部模式只部署正式入口的临时 Worker 和 WorkspaceHost 容器应用，凭据经 Worker Secret 注入现有 AccountCore 密封流程，出口仍使用现有租约。用一个只存在于 Linux Project 的随机文件核对模型实际调用命令、流式输出、原生完成历史和项目 PTY。

同账号也可以用 `--codex-bridge --codex-workers-ai` 验收真实的 Workers AI GPT-OSS 20B。模型 Worker 读取 Codex 原生工具目录，将 function、namespace 和 freeform custom 工具转换成 Chat Completions 调用，并恢复每个调用的原生名称、命名空间、ID、参数和结果。Responses 模型配置显式声明 `customToolCalls: true` 后，Codex 自己发布原生 `apply_patch`。Bridge/AppServer 继续授权、执行和持久化工具结果，模型 Worker 只转换协议。运行时为文本模型，图片工具结果只保留文本或明确的模态提示。托管 `web_search` 需要提供该能力的模型服务商。[Cloudflare Workers AI 兼容接口](https://developers.cloudflare.com/workers-ai/configuration/open-ai-compatibility/#responses-api-for-gpt-oss)

REST 模式下，临时验证队列在 Cloudflare 内启动 AppHost 客户端，沿用生产 Worker 入口与同一 AppHost WebSocket。它逐项缩小演练模型的工具选择，让真实模型生成调用参数，核对计划、文件审批与回读、进程、提问和其他工具结果。临时模型 Worker 记录原生调用和结果的回执。预览模型沿用正常工具选择。可用 `OPENCRAFT_REHEARSAL_NATIVE_TOOLS` 指定逗号分隔的工具组复验。演练结束回收队列、两个 Worker 和容器应用。

Cloud 模式的普通协作回合可使用 Codex 的原生结构化提问。Workbench 通过共享 interaction 提交答案，同一 Turn 会继续推理。原生工具回执按调用 ID 和命名空间还原，子代理通知与工具输出交错时仍保持 Chat Completions 要求的调用和结果顺序。

2026-11-25 的 GPT-OSS 20B 补充验收分别确认了计划通知、持续进程 stdin、原生补丁审批与读回、普通模式的结构化提问、Goal 创建／读取／完成，以及子代理启动／等待／关闭／恢复／续发。子代理验收读到同一个代理的两次原生完成结果。MCP 资源和模板列表正常返回空集，读取未挂载的 MCP 服务返回原生错误。图片工具返回文本模型不支持图片输入的诊断。当前预览使用原账号在 Cloudflare Chrome 验证了补丁和结构化答案的刷新回读。

2026-11-25 的正式 Bridge 验收在 Cloudflare 约 53 秒通过。GPT-OSS 20B 先调用 Linux 命令读取隐藏随机文件，再流式输出包含该值的回复。AppHost 收到命令退出码 0、至少两段文本和 Turn 完成，随后从原生历史读回回复。项目 PTY 独立验证了连续输入和工作目录。验收后清理了临时模型 Worker、主 Worker 和容器应用。

在上述 Bridge 演练命令上加 `--codex-restart`，可复验快照休眠、重启和模型凭据边界。2026-11-25 在真实 Cloudflare 上约 118 秒通过。原生 Linux 命令读取随机文件，GPT-OSS 20B 流式完成回复。运维入口完成快照并停止容器。新的 AppHost 连接读回同一 Bridge Thread、原 Turn 和完整回复，工作区 epoch 增加一次。原输入 ID 再提交时收到结果未确认回执，历史仍只有原 Turn。新输入在同一 Thread 完成。验收只把临时模型凭据的 SHA-256 指纹传给 Linux 检查命令，未在可读工作区文件和进程环境中发现该凭据。

**活跃执行期间容器退出。** 平台确认原容器停止后，WorkspaceHost 结清其运行租约，结束旧流与审批，并保留原输入的提交记录。若 DO 在收到停止通知前被驱逐，重开时根据平台报告的停止状态结清同一批租约。workerd 覆盖已收到原生 Turn 回执后退出，以及原生执行已收到输入、回执未到且 DO 被同时驱逐的情况。两条路径中，同一输入 ID 重试不会转发到原生运行时，新的任务可以获得执行槽。

`--codex-crash` 在隔离的 Cloudflare 队列演练中先完成上述快照验证，再在 GPT-OSS 20B 发起的原生 Linux 命令执行期间强制停止容器。首次演练发现同一个 outbox 的生产者游标随容器盘回到快照的 135，WorkspaceHost 已提交到 167，严格围栏因此拒绝读取。修复后，通用 `WorkspaceRuntime` 提供已核验的环境回执与快照来源。Bridge 在新容器回执下，从生产者已确认的共同前缀恢复游标，并在同一 SQL 事务归档弃用的事件尾部。原回执上的连接不会接到新容器。常规重连和未证实的游标回退继续由原有围栏校验。独立 Node Bridge inbox 沿用原迁移链与协议。

2026-11-25 在真实 Cloudflare 上约 136 秒通过。活跃的 Linux Hands 命令被强制中止。AppHost 重连后从新化身读回原 Bridge Thread 和快照中的完整回复，同一输入 ID 收到结果未确认回执，新的 GPT-OSS 20B Turn 在同一 Thread 完成。最新快照之后的原生历史可能随容器丢失，DO 已接收的分叉事件仍在归档。临时 Worker、验证队列和容器应用已回收。

**2026-11-24 结果**。真实账号最终演练分别耗时约 44 秒（Wrangler 4.168.0）和 30 秒（REST）。检查覆盖 Web 账号登录和 AppHost 授权、模型目录读取、原生 Project 登记重试与 Thread 放置。两个 Turn 文本增量分别到达后收到完成事件，能读回完成历史。测试模型根据容器工具回执核对命令退出码、非 root UID、工作目录、`/opencraft-workspace` cgroup 和每进程 FD 至少 65536。项目终端 19 次独立写入后返回实际 `pwd`，并核实临时 Worker 和容器应用均已删除。本组使用 Responses 测试服务验证模型出口和 SSE 转发。第三方模型账号授权、真实推理和长时间使用成本另行验收。

同日扩展的时间线演练约 31 秒通过。固定镜像中的 Codex 发出推理摘要、计划与实时 Token 用量，为测试文件请求审批，收到同一 Thread、Turn 的一次性批准后提交文件变更。Linux Hands 在项目目录中读到了新文件内容，随后完成 Turn 和终端检查。

另用临时 Worker 验证当前账号可通过 Workers AI binding 调用 `@cf/openai/gpt-oss-20b`。Responses 输入的非流式请求返回了真实模型结果，Responses 的 `stream: true` 请求没有返回事件，Chat Completions 模式返回了对应的流式分片。Codex 云端 Turn 仍需支持原生 Responses SSE 的实际 provider。 [Cloudflare 的 Responses 兼容范围](https://developers.cloudflare.com/workers-ai/configuration/open-ai-compatibility/#responses-api-for-gpt-oss)

### 7.7 GPT-OSS 20B 云端预览换版

`npm run cf:preview` 是预览换版入口。预览入口持续可用，Linux 容器空闲后按工作区休眠配置停止。需要 Node 26、Python 3，以及具有 Workers Scripts、Containers、Queues 和 Workers 日志权限的 Cloudflare 凭据，沿用 `CLOUDFLARE_ACCOUNT_ID` 和 `CLOUDFLARE_API_TOKEN`。状态文件保存在仓库外，权限为 `0600`。已有预览首次接入时使用它的私有部署回执和当前镜像 digest。接入只读取 Cloudflare 资源清单。

```sh
npm run cf:preview -- "$PREVIEW_STATE" --adopt "$ACCESS_RECEIPT" "$OPENCRAFT_CODEX_IMAGE"
npm run cf:preview -- "$PREVIEW_STATE" --publish-address
node scripts/cloudflare/prepare-workbench-assets.mjs "$WEB_DIST" "$PREVIEW_ASSETS"
npm run cf:preview -- "$PREVIEW_STATE" "$PREVIEW_ASSETS"
```

换版沿用状态文件中的账号、密码与固定镜像，可在资产目录后显式提供新的镜像 digest。部署先验证原凭据能登录、新 Workbench 能加载、GPT-OSS 20B 能返回完整 Responses 流，再登记新地址，删除上一版的验证队列、容器应用、Worker、DO 命名空间和模型 Worker。换版失败时回收候选资源，继续保留原地址和登录。操作中断或 Cloudflare 删除失败时，下次执行会继续回收，也可单独执行 `npm run cf:preview -- "$PREVIEW_STATE" --cleanup-only`。状态锁在运行部署命令的同一主机上串行化这些操作。每个预览使用独立工作区，轮换会删除旧预览的会话和工作区数据。固定镜像由构建流程复用，预览轮换负责释放部署资源。


`--publish-address` 为已登记的预览启用固定地址 `https://opencraft-preview.<workers-subdomain>.workers.dev`。入口使用 Cloudflare Service binding，转发原有登录和 AppHost WebSocket，浏览器始终使用固定域名。之后换版先登记通过验收的目标，再切换并核对固定地址指向，最后删除旧资源。切换失败时保留旧目标，`--cleanup-only` 会从已登记的目标重试。固定入口沿用预览的有效期与独立工作区语义，新版本使用原账号和密码建立会话。[Cloudflare HTTP Service bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/http/)

如已有托管在同一 Cloudflare 账号的域名，可先执行 `npm run cf:preview -- "$PREVIEW_STATE" --publish-address "https://$PREVIEW_HOSTNAME"`，再在 Cloudflare 将该主机名作为 Custom Domain 绑定到 `opencraft-preview` Worker。自定义域名随当前预览状态保存，每次换版继续指向同一个入口。两个地址各自使用同源登录。[Cloudflare Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)
