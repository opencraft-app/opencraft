# 可选 Cloudflare 部署

[Architecture index](../README.md) · [存储端口](storage-ports.md) · [执行沙盒](../execution/execution-sandbox.md) · [Docker 三角色部署](../../../deploy/docker/README.md)

状态：目标设计。只有存储端口的 Cloudflare 适配器已在本地 workerd 中通过一致性测试（见[存储端口第 6 节](storage-ports.md#6-cloudflare-适配器第-5-阶段本地-workerd-验证)），`InstallationCore`（见第 5 节）与 `RelayHub`（见第 6 节）各有一个仅限测试的本地 workerd 原型；本页不代表任何 Cloudflare 组件已可部署。Node 自托管（Docker／systemd／Electron）始终是一等公民；Cloudflare 是部署装配选项之一，不替换 Node 路径。

## 1. 现状约束

- 现有 Docker 部署已拆为 `gateway`（准入、认证、路由）、`brain`（Codex AppServer、DSH、Pi 与任务生命周期）、`hands`（`exec-server`、终端、文件、浏览器）。
- **Codex AppServer 是原生 `codex app-server` 二进制**，DSH、Pi、ACP 也是子进程，需要 POSIX 文件系统与 PTY。它们不能在 workerd 中运行，只能在容器中运行。
- **Gateway 不是无状态的**：Codex Host 层状态（queue、schedules、中断恢复、tasks、token usage）由 Gateway 进程内的 `CodexEngineAdapter` 写入 `$DATA/codex/`。
- 账号 Core（`apps/codex-core` 的 split core 与 `packages/account-pool-host`）持有账号池、OAuth 刷新、模型代理与计量，是部署级单写者。
- 沙盒内的 Codex `exec-server`、文件、终端与浏览器 owner 全部经 stdio 传输，沙盒不需要入站端口。
- Cloudflare Sandbox SDK **不兼容 E2B API**；接入方式是实现 `@opencraft/sandbox` 端口的新后端，而不是复用 E2B SDK。`sandbox-cloudflare` 作为 `@opencraft/sandbox/providers` 的一个 provider 注册，复用 `@opencraft/sandbox/broker`（只需提供启动 broker 进程的双工通道），持久工作区通过可选 `PersistentWorkspaceProvider` 能力接入；该 provider 尚未实现。

## 2. 目标拓扑

| 组件 | 载体 | 持有 |
| --- | --- | --- |
| 边缘 Worker | Workers＋静态资源 | Web 资源、登录与 OIDC 入口、webhook 接收、WebSocket 路由到 DO、模型请求流式转发 |
| `InstallationCore` | 每部署一个 DO | 服务器核心 SQL（现由多条连接共同打开的库合并为单一 owner）、成员与授权投影、Hub 节点状态 |
| `RelayHub` | 每 installation 一个 DO | 隧道与流预算，替代 Redis 租约与节点间转发（本地原型见第 6 节） |
| `AccountCore` | 每部署一个 DO | 账号池、加密凭据、OAuth 刷新单写者、选号与亲和、计量与策略 |
| `WorkspaceHost` | 每工作区一个 DO | Codex Host 状态（queue、schedules 以 DO alarm 实现、中断恢复、tasks、token usage）；工作区容器生命周期与连接 |
| 工作区容器 | 每工作区一个 Container，由 `WorkspaceHost` 持有 | Brain 与 Hands 同处：`codex app-server`、Pi、DSH、`exec-server`、终端、文件、浏览器；独立 `CODEX_HOME`；`/workspace` 经 R2 持久化 |

### 2.1 模型请求与凭据

工作区容器内不保存任何模型或账号凭据。引擎的模型请求由出站处理交给边缘 Worker；Worker 向 `AccountCore` 获取短期凭据租约后直接流式转发给 provider。长时间流式响应不占用 DO 运行时长，凭据只在 Worker 请求内存中短暂存在。`AccountCore` 仍是刷新与选号的唯一写入者。

协议转换（例如 Anthropic）代码需确认能在 workerd 中运行后才可迁移到 Worker。

`AccountCore` 的存储准备（SQL 端口、凭据记录端口、持久化清单与 Node 专属阻碍）见[存储端口第 7 节](storage-ports.md#7-accountcore-存储)。

### 2.2 工作区容器

- 镜像沿用已发布 Hands 镜像（按 digest 固定），追加 Brain 运行时；不在容器启动时下载工具。
- Brain 与执行用户使用不同 UID；凭据不进入容器文件系统。
- 容器回收或重启时，引擎进程终止；恢复沿用[中断 Turn 恢复](../execution/interrupted-turn-recovery.md)，由 `WorkspaceHost` 持有的 Host 状态驱动，不重放未确认输入。
- `CODEX_HOME` 与 `/workspace` 的持久化语义（R2 FUSE 挂载、目录备份或容器快照）需在第 5 阶段 PoC 中确定，并替换当前依赖自托管 E2B volume API 与 NFS 的持久工作区校验。

## 3. 前置工作

依赖[存储端口](storage-ports.md)第 1–4 阶段：SQL 等存储端口、沙盒 provider 泛化，以及 Gateway／Brain 按工作区拆分。这些改动先在 Node 上成立。

## 4. 待 PoC 验证

| 项 | 需确认 |
| --- | --- |
| 进程 stdin | `container.exec()` 能否在进程运行期间持续写入 stdin；否则 broker 改为容器内服务 |
| 镜像 | Hands＋Brain 镜像是否在 20 GB 上限内；是否允许任意基础镜像；架构限制 |
| 浏览器 | Chromium 沙盒在容器隔离模型下是否可用 |
| 生命周期 | 能否确认实例已销毁；能否读取实际生效 CPU／内存；休眠、重启与最长运行时间语义 |
| 持久化 | R2 FUSE／备份／快照用于 Git 工作区时的性能与一致性 |
| SQL 语义 | **已在本地 workerd（`workerd@1.20260730.1`）回答**：`SELECT changes()` 返回语句直接修改的行数，与 Node 一致；游标 `rowsWritten` 含索引与触发器写入（带索引和审计触发器的表上，修改两行的 UPDATE 为 6），不能用于 CAS。嵌套 `transactionSync` 是 savepoint：内层抛错只回滚内层，外层抛错丢弃全部。多语句 `exec` 依次执行全部语句。`sqlite_master` 与 `PRAGMA foreign_keys`（值为 1）可读。`BEGIN`／`SAVEPOINT`／`COMMIT` 文本被拒绝。BLOB 以 `ArrayBuffer` 返回；`bigint` 不能绑定，范围外 INTEGER 读取时静默取整。`SQL_CONFORMANCE_CASES` 全部通过。2026-11-23 已在真实 Cloudflare 上以相同探针复核，结果一致（见第 7 节） |
| 网络 | 出站限制到边缘 Worker；Gateway 到容器的连接方式 |
| 成本 | 冷启动时间、容器常驻与 DO 时长成本 |

单实例资源上限为 4 vCPU／12 GiB／20 GB 磁盘，满足当前默认 4 vCPU／8 GiB 契约。

## 5. InstallationCore 原型状态

状态：**仅测试原型，本地 workerd 验证**。`tests/storage/workerd/installation-core-worker.ts` 是一个 SQLite-backed DO，由 `npm run test:installation-core:workerd`（`tests/storage/installation-core-workerd.test.ts`）经 esbuild（`workerd` 导出条件）打包、在 Miniflare（`workerd@1.20260730.1`，兼容日期 `2026-07-30`，`nodejs_compat`）中运行；无网络、无 Cloudflare 账号，未加入 `gate`；同一组场景另由 `npm run cf:rehearsal` 在真实 Cloudflare 上运行过（第 7 节）。它不放进包里：还没有部署装配、路由、认证前门与投影分发，正式包会成为无人消费的运行时形态。DO 外壳只有几十行，迁移与领域代码全部来自生产包。

### 5.1 已证明

- **精简生命周期**：DO 在 `blockConcurrencyWhile` 内执行 `migrateServerSqlDatabase(durableObjectSqlDatabase(ctx.storage))`（`@opencraft/storage-node/server-sql`），只做账本校验、checksum 拒绝和按序迁移（每个迁移一次 `transaction()`）；不含进程锁、`VACUUM INTO` 备份、`ATTACH` 旧六库导入、替代谱系采纳与 `:memory:` 校验器（见[存储端口 3.1](storage-ports.md#31-sqldatabase)）。账本规则与 Node `openManagedDatabase` 是同一份实现（`@opencraft/sql/migrations`）。有对象但无账本的库被拒绝而非采纳（`_cf_` 前缀的 workerd 内部表除外）。打开失败时对象保持关闭，之后每个调用都失败，不读旧状态。
- **测试覆盖**：新对象应用全部 22 个已发布 Server 迁移，schema（含触发器）与 node:sqlite 全新库逐项相同；在持久化存储上重启后结果为 `up-to-date`，账本逐行不变；改写一行 checksum 后重启被拒绝；只装前 5 个迁移的"旧版本"对象重启后只补后续迁移，已有账本行不变、最终 schema 与 Node 相同；新版本迁移过的对象被旧版本以 `newer-schema` 拒绝；`ActorStore`（`resolveHuman`、`createSession`、`issueCredential`、`authenticateSession`、撤销、停用）、`MembershipStore`／`InstanceAccess`（授予、撤销、认证、角色与准入状态、撤销修订号）与 `ThreadAccessStore`（创建、`set` 的 CAS、`allows`／`allowsActor`）经 DO RPC 的结果在归一化随机 ID、密钥和时间后，与同一调用序列在临时目录 node:sqlite owner 上的结果完全相同。
- **已发布迁移在 DO 中可执行，无需改动**：`--> statement-breakpoint` 是 SQL 注释，DO 的多语句 `exec` 依次执行全部语句；`0005_native_channels` 的 `CREATE TRIGGER … BEGIN … END` 被当作 schema 接受，不被当作事务控制拒绝；`ALTER TABLE … ADD`、`INSERT … SELECT`、`randomblob()` 正常。当前 22 个迁移不含 `PRAGMA`、`ATTACH`、`VACUUM` 或 drizzle 表重建。外键：node:sqlite 的 owner 连接默认开启外键，DO 也默认开启，两者一致（Node 的借用连接可关闭外键，DO 中不存在借用连接）。本地 workerd 接受 `PRAGMA foreign_keys=OFF`，若将来出现 drizzle 表重建式迁移，需在真实 Cloudflare 上复核该 PRAGMA 后才可依赖。

### 5.2 Node 专属依赖

| 依赖 | 来源 | 处理 |
| --- | --- | --- |
| `node:sqlite`、`node:fs`、`node:path` | `@opencraft/storage-node/server-repository` 的文件打开路径 | 隔离：该导出增加 `workerd` 条件，指向只接受 owner 句柄的 `repository.workerd.ts`；共享的借用逻辑在 `repository-handle.ts`，Node 实现行为不变 |
| `node:crypto`（`createHash`、`randomBytes`、`randomUUID`、`timingSafeEqual`） | `actors.ts`、迁移组合与 checksum | `nodejs_compat` 下可用，凭据签发与校验已在测试中运行 |
| 全局 `Buffer` | `permission-read-cache.ts`、`actors.ts` | `nodejs_compat` 下可用 |
| `process.env` | `ActorStore` 未传 `policy` 时读取 `OPENCRAFT_ACTOR_POLICY` | `nodejs_compat` 下可读（为空即人类策略）；正式装配应显式传入 `policy` |
| `setInterval(...).unref()` | `InstanceAccess.watch` | 探针确认可用；原型未调用。DO 中定时撤销应改由 alarm 或连接 owner 承担 |
| `node:http` 请求与流式读取 | `InstanceAccess.handle` 的成员管理接口 | 仅类型导入，原型未调用；DO 前门应以 `fetch`／RPC 重新装配 |
| `worker_threads`、`isMainThread` 断言、`SharedArrayBuffer`＋`Atomics` 提交栅栏 | `identity-writes.ts`、`commit-fence.ts`、`automation-ledger.ts`、`orchestration-runtime-store.ts`、`server-spaces-runtime.ts` | 未被原型打包：DO 直接在唯一 owner 上构造领域类 |

### 5.3 单一 owner 的含义

Node 上 `opencraft-server.sqlite` 的编排运行时与 Server space 已在核心 owner Worker 的连接上执行，剩余的第二条连接是网络线程过渡连接（见[服务器核心 owner](../server/server-core-owner.md)）。DO 中只有一个 owner 与一个 `SqlDatabase`，这意味着：

- 没有跨连接锁等待与 `busy_timeout`；也不再需要把其他连接的提交转发给 owner 以刷新权限投影——所有写入都经同一连接对象，`AuthorityChanges`／`PermissionReadCache` 的分组天然覆盖全部写入。
- 提交栅栏不再需要：授权复核与写入在同一同步回合、同一 `transaction()` 内完成，DO 输入门保证期间没有其他请求交错。正式实现应以此替代 `IdentityWrites` 的 Worker＋栅栏路径，而不是移植 `Atomics`。
- `ServerDatabaseHandle` 没有 `location`，`Collaboration` 无法按文件启动伴随 Worker；编排与空间领域由同一 DO 直接执行（Node 已用 `orchestrationRuntimeDomain`／`serverSpacesDomain` 在 owner 连接上这样做），所有 Server 核心工作在一个 DO 线程上串行，与认证热路径争用 CPU。是否把无事务耦合的领域拆到其他 DO，需按 CPU 与时延实测决定。

### 5.4 生产 InstallationCore 仍缺

部署装配（wrangler 配置、绑定、边缘 Worker 路由）；认证前门（OIDC／本地账号经 `fetch`，替代 Node HTTP 的 `IdentityProvider`）；投影发布给边缘 Worker 与 Client DO；`Collaboration`、编排、空间、自动化等其余领域的 DO 装配；`AccountCore` 与 `WorkspaceHost` 的协作；DO 版迁移后 schema 校验（DO 内不能另开 `:memory:` 库）；备份与恢复改用 PITR 的运维流程；`SecretStore` 的信封加密；真实 Cloudflare 上的 SQL 语义、CPU 与冷启动复核。

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
  npm run cf:rehearsal -- [--only '<分组: 场景名正则>'] [--skip-miniflare] [--report out.json] [--stale-minutes 10] [--keep]
```

- **只碰自己的名字**：Worker 与 R2 bucket 名称为 `opencraft-rehearsal-<8 位随机运行 ID>-…`，创建、删除前都按精确名称和该正则核对，账号中运行前已存在的资源一律拒绝触碰。不创建容器、D1、KV。
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
| workspace-host（五条迁移链、领域操作与 `nodeSqlDatabase` 对照、v13–v17 升级、alarm owner） | 13 | 13 | 13 | 2.2 s | 23 s |
| login-entry（Argon2id 双向互验、fetch 登录入口与 Node HTTP 入口对照） | 2 | 2 | 2 | 6.4 s | 26 s |
| client-do（可休眠 socket、恢复游标、驱逐与重启、alarm 回收） | 9 | 9 | 9 | 3.2 s | 70 s |
| relay-hub（控制链路、512 流预算、预约到期、1008、替换、吞吐） | 6 | 6 | 5（修正后 6） | 2.1 s | 68 s |

Cloudflare 侧耗时主要是部署（首个版本约 3 s，`immediate` 重启约 8 s）和公网往返，不代表运行时性能。

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
- **代价与风险**：CPU 时长按毫秒计费，失败尝试同样消耗 0.6 s 级 CPU，且同一 installation 的登录集中在单线程 DO 上串行执行，并发登录会排队。正式实现必须在哈希之前做按来源与账号的速率限制和并发上限，并评估把哈希移到无状态 Worker（DO 只做记录读写）以避免阻塞同一对象的其他请求；如需降低成本再评估 WebAssembly 实现，参数仍须与 Node 记录互通。
