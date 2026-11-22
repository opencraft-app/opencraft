# 服务器核心数据离开网络主线程（设计）

状态：第 1 阶段已实施，其余为设计。以源码、测试与 `config/main-thread-sync-io.json` 的实际计数为准；该登记同时记录主线程可达代码中的 SQL 语句数（`SQL statement`），新增 SQL 会被守卫拦截，各阶段迁移应使其减少。

## 1. 背景

[网络主线程不得阻塞](../../../AGENTS.md) 要求承载连接的主事件循环不直接调用 SQLite 等同步原生库。前五批迁移（#412、#413、#415、#418、#427）已把 SSH 连接、Hub 状态、会话资源日志、助手离线记忆、本机 Host 零散项和桌面私有存储移出主线程，登记从 623 处降到 285 处。剩余最大的一块是 Headless 的服务器核心数据：`packages/access-control`、`packages/storage-node`、`packages/sqlite-node` 合计约 140 处。

### 现状拓扑

- `headless-application.mjs` 在主线程 `openServerDatabase(dataDirectory)`，持有进程写锁（`server.lock`）、执行迁移与旧库导入，得到 owner 连接 `serverStorage`。
- 同一连接上构造这些领域服务，请求处理直接同步执行 SQL：

  | 服务                                       | 文件                                         | 网络线程的典型调用                                           |
  | ------------------------------------------ | -------------------------------------------- | ------------------------------------------------------------ |
  | `ActorStore`                               | `actors.ts`（404 行）                        | `get` ×15、`isCurrent` ×8、`findHuman`，位于认证与授权热路径 |
  | `MembershipStore`                          | `index.ts`                                   | 成员角色、`InstanceAccess.authenticate`                      |
  | `ThreadAccessStore`                        | `thread-access.ts`（311 行）                 | `allows` / `allowsActor`，每次线程访问                       |
  | `HumanAccounts` / `HumanAccountManagement` | `human-accounts.ts`、`account-management.ts` | 登录、账号管理                                               |
  | `Collaboration`                            | `collaboration.ts`（1352 行）                | 协作命令（`command` 已是异步）                               |
  | `ThreadNoteStore`、`CapabilityBindings`    | —                                            | 线程备注、能力绑定                                           |
  | 沟通扩展、频道、个人助手台账               | `communication-extension.ts` 等              | 由 Collaboration 内部调用                                    |

- 同一个 `opencraft-server.sqlite` 还有两个 Worker 打开的**第二、第三条 WAL 连接**：`OrchestrationRuntimeWorker` 与 `server-spaces.worker`。
- owner 连接设置了 `busy_timeout=5000`。任一 Worker 写事务持锁时，主线程上的同步 SQL 可能等待最长 5 秒，期间所有连接、定时器与消息分发停止。这是本设计要消除的具体风险，不只是计数。

### 可复用的现有机制

- `@opencraft/worker-owner`：FIFO 调用、领域错误保类型、致命错误隔离、关闭前排空、无主线程回退（#412）。
- `PermissionReadCache`：由存储 owner 在写入后整体重建并发布的原始行投影（"No SQL or read-through misses on delivery"）；`withPermissionWrite` 保证写入期间投影失效、写入完成后统一发布。
- `AuthorityChanges`：同一 owner 内的提交后通知，观察者只能撤销准入，不能授予。

## 2. 目标与非目标

目标：

1. 网络主线程不再打开或查询服务器核心数据库；`access-control`、`storage-node`、`sqlite-node` 从 Headless 主线程可达图中消失（守卫计数归零）。
2. 认证、授权热路径保持同步读取，读的是内存投影，不引入每请求的跨线程往返。
3. 写入保持原有原子性与 CAS 语义，确认（HTTP 响应、通知）只在提交后发出。
4. 存储失败时关闭准入（fail closed），不以旧投影继续放行。

非目标：

- 不改表结构、迁移、`server/legacy.ts` 已发布内容或备份恢复契约。
- 不改离线管理工具（`scripts/admin/*`，一次性 CLI）的同步用法。
- 不改引擎持有的存储（`codex-engine-adapter` 宿主状态库、DSH、ACP）。
- 不在本设计内处理多实例/多租户。

## 3. 设计

### 3.1 单一 owner Worker

新增 `ServerCoreOwner` Worker（基于 `@opencraft/worker-owner`）：

- 在 Worker 内执行 `openServerDatabase`：写锁、迁移、导入、`openManagedDatabase` outcome 全部在 Worker 内完成，主线程只收到 outcome 与契约摘要（用于 `/__opencraft_health`）。
- 领域服务（第 1 节表格）实例化在 Worker 内，继续使用现有同步实现；它们之间仍共享同一 owner 连接与 `AuthorityChanges` 分组，事务边界不变。
- 主线程拿到的是**端口**：每个领域一个异步门面（`actors`、`membership`、`threadAccess`、`accounts`、`collaboration`……），方法签名与现有同步方法一一对应，只是写入与非热路径读取返回 Promise。
- `OrchestrationRuntimeWorker`、`server-spaces.worker` 暂保留各自连接；它们的提交通过第 3.3 节的变更通知进入 owner。

### 3.2 读：投影

热路径读取改读主线程内存投影，投影由 owner 发布：

| 投影            | 内容                                         | 服务的调用                      |
| --------------- | -------------------------------------------- | ------------------------------- |
| `actors`        | 主体行（id、kind、enabled、epoch、显示信息） | `get`、`isCurrent`、`findHuman` |
| `membership`    | `members`、`actor_members` 原始行            | 角色判定、`authenticate`        |
| `thread-access` | 线程授权行与权限所有者                       | `allows`、`allowsActor`         |

- 投影沿用 `PermissionReadCache` 的"完整原始行 + 整体发布"模型：owner 在 `withPermissionWrite` 结束时生成快照，经 Worker 消息发布；主线程只替换引用，不做增量合并。
- 每次发布带单调递增的 `revision`。主线程只接受更大的 revision；Worker 重启后从 1 重新开始，并以新的 owner 代次区分。
- 冷启动：owner Worker 就绪消息携带全部投影的首个快照，主线程在开始监听前装好投影。
- 体量上限沿用 `PermissionReadCache` 的 entries/bytes 限制；超过上限的投影不发布，相应调用退回异步端口（可用但不在热路径），并记录诊断。

非热路径读取（账号列表、协作视图等）直接走异步端口。

### 3.3 写：提交后确认

- 写入经端口进入 Worker，按 FIFO 执行，事务、CAS、唯一约束都在 Worker 内照旧。
- Worker 在同一回复中返回：领域结果 + 受影响投影的新快照 + 新 revision。主线程**先安装投影、再 resolve 调用**，保证"写后读"在同一线程立即可见。
- `AuthorityChanges` 的观察者（如撤销已建立的会话、关闭远程 socket）改为在主线程订阅：owner 回复或推送中携带"权限已变化"信号，主线程在安装投影后触发观察者。观察者仍只能撤销，不能授予。
- 其他连接的提交（orchestration、server-spaces）：这些 Worker 已经通过现有消息回到主线程；主线程把"可能影响权限"的提交转发给 owner，owner 重新加载相应投影并发布。在 owner 确认之前，主线程不扩大授权（只可能因旧投影多拒绝，不会多放行，因为这两条连接不授予主体或成员资格——实施时需逐条核对）。

### 3.4 失败语义

- owner Worker 致命错误、崩溃或退出：`WorkerOwner` 隔离全部待决与后续调用；主线程把所有投影标为不可用，认证与授权一律拒绝（503 / 未授权），不使用最后一份投影继续放行。
- 投影安装失败（快照不合法）：同上处理，并记录诊断。
- 存储锁等待只发生在 Worker 内，主线程连接、定时器与消息分发不受影响。
- 关闭：先停止入口，再 `owner.close()` 排空已排队写入，最后释放写锁；与现有 `releaseLock` 顺序一致。

## 4. 分阶段实施

每阶段一个 PR，均需 CI 全绿并做真实 Headless 验收。

1. **owner Worker 与过渡连接**（已实施：`openServerCoreOwner`）：`openServerDatabase` 在 Worker 内执行，写锁、迁移与导入随之离开主线程；主线程经 `borrowServerDatabase` 以读写 WAL 连接服务尚未迁移的领域（未迁移的领域仍会写入，所以不能只读），连接设置与原 owner 连接一致（不启用外键、`busy_timeout=5000`）。Headless 与桌面本地账号（owner 角色）都改用它；守卫登记从 285 降到 251。
2. **主体与成员**：`ActorStore`、`MembershipStore` 迁入 Worker，热路径改读 `actors` / `membership` 投影；`InstanceAccess` 改为消费投影。这是认证主路径，配投影一致性与 fail-closed 测试。
3. **线程访问、备注与能力绑定**：`ThreadAccessStore` + `thread-access` 投影；`CapabilityBindings` 走异步端口。共享备注已先行迁入（见下）。
4. **人类账号与账号管理**：登录、绑定与管理写入走端口；会话撤销观察者改为主线程订阅。
5. **协作**：`Collaboration`（`command` 已是异步）及其内部的沟通扩展、频道、提及、个人助手台账整体迁入 Worker。
6. **收尾**：移除主线程过渡连接；`access-control`、`storage-node`、`sqlite-node` 从 Headless 主线程可达图消失，守卫登记对应计数归零。

**领域迁入方式（已实施，以共享备注为首例）**：存储包提供 Worker 侧的 `serveServerCoreOwner(domains)`，在 owner 连接上构造领域服务并按方法名暴露；Headless 的 owner 入口是 `apps/headless-server/src/server-core-worker.mjs`，经 `openServerCoreOwner(dir, { entry })` 启动，网络线程通过 `storage.call.<方法>` 异步调用。访问判定仍在网络线程完成，Worker 只执行已授权的读写。`ThreadNoteStore`（Yjs 合并与 SQL）是第一个迁入的领域。调用方需要同步读取的领域改用投影：能力绑定（`CapabilityBindingProjection`）启动时从 Worker 读入全部行，读走内存；写入先按与表相同的唯一约束在内存校验并应用，再由 Worker 按序提交。存储因此总是这段写入历史的某个前缀，崩溃丢失的写入等同于进程更早停止；任一提交失败后投影整体失效，凭据一律拒绝。没有事务耦合的领域都可按此方式单独迁入，打包时入口登记在 `scripts/packaging/owner-workers.mjs`。

**身份写入（已实施）**：Headless 的登录会话、身份绑定与 Actor 管理写入（`IdentityWrites`，`@opencraft/access-control/identity-writes`）在所有者 Worker 的连接上提交；网络线程的读取仍走权限投影与 WAL 读，WAL 下读不等待写锁。每个写入在提交后由网络线程重新发布同连接上的全部权限投影并通知观察者，因此 await 之后的读取可见写入。需要本进程注册状态的校验（本地账号版本、资源授权方）先在网络线程完成，Worker 只执行已校验的写入；网络线程注册了 Worker 无法执行的注册钩子（预留解析、注册监听）时，登录仍在本线程写入，语义不变。尚在网络线程的写入：部署操作员引导（启动时）、成员写入与本地账号创建。

**独立库的同一模式**：不在服务器核心库里的存储按同样方式拥有自己的 Worker。IM 渠道库（`@opencraft/plugin-im/switchboard`）的渠道配置、发送者绑定、路由版本和显式回复锚点（只含路由字段，不含正文）作为投影留在网络线程，供每条消息的同步检查使用；每个写入在 Worker 提交后连同变化的投影一起返回再生效；消息正文和会话绑定走异步端口。同一消息的去重仍在网络线程同步登记，持久重复检查移入端点准入队列；身份验证码先读出待绑定主体、在网络线程校验，再由 Worker 仅在验证码未变时绑定。

下游消费者：`access-control` 的同步类仍保留并在 Worker 内使用；对外新增的是异步门面。实施前需核对下游产品插件是否直接构造这些类，若有则在对应阶段提供异步门面并更新下游。

## 5. 验证

按 AGENTS 对本规则的验证要求：

- **守卫**：每阶段更新 `config/main-thread-sync-io.json`，计数只减不增；第 6 阶段后上述三个包不再出现在 Headless 条目下。
- **锁等待不阻塞**：测试让另一条连接持有写锁数秒，同时验证主线程定时器、HTTP 请求与 WebSocket 心跳持续响应，且热路径读取不被阻塞。
- **提交顺序与写后读**：同一请求序列中，写入 resolve 后立即读取得到新状态；并发写入按 FIFO 提交。
- **失败与重启**：强制终止 owner Worker，验证认证与授权全部拒绝、无旧投影放行；重启后投影代次更新，旧代次回复被丢弃。
- **关闭排空**：关闭期间已接受的写入全部提交后才释放写锁；关闭后的调用被拒绝。
- **投影一致性**：对每个投影，用随机写入序列比较"投影读取"与"直接 SQL 读取"的结果一致。
- **真实验收**：源码启动 Headless，完成登录、成员管理、线程访问、协作命令；`linux-headless` 与 `docker-compose` CI 通过。

## 6. 风险与开放问题

- **投影体量**：大型部署的主体/成员/线程授权行数需要实测，决定投影上限与退回策略。
- **跨连接提交的权限影响**：需逐条核对 orchestration 与 server-spaces 的写入是否会扩大授权；如会，则这些写入必须经 owner 确认后才生效，或并入 owner Worker。
- **下游契约**：`access-control` 若被下游产品直接以同步方式使用，需要在相应阶段协调。
- **`execution-environment`**：其执行身份查询读取引擎宿主状态库（`busy_timeout=1000`），与本设计无关，随引擎侧改造另行处理。
