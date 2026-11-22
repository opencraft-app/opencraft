# Gateway／Brain 按工作区拆分

[Architecture index](../README.md) · [存储端口](storage-ports.md) · [可选 Cloudflare 部署](cloudflare-deployment.md) · [执行所有权](../execution/execution-ownership.md) · [中断 Turn 恢复](../execution/interrupted-turn-recovery.md) · [Assets 工作区](../execution/workspace-assets.md) · [Docker 三角色部署](../../../deploy/docker/README.md)

状态：**设计草案，未实施任何部分。** 对应[存储端口](storage-ports.md)第 4 阶段。下文"现状"以引用的源码行为准（2026-11 核对）；"目标"与"步骤"均为提议，第 8 节列出需要用户决定的问题。Node／Docker 自托管是一等公民：每一步都必须先在 Docker 上独立成立，Cloudflare 只是后续可选装配。

## 1. 目的与范围

目标拓扑（[可选 Cloudflare 部署](cloudflare-deployment.md) §2）要求：

- **部署级 owner**：`AccountCore`（账号池、OAuth 刷新单写者、模型代理、计量）与 `InstallationCore`（服务器核心 SQL、成员与授权、Hub）。
- **每工作区 owner**：`WorkspaceHost`，持有 Codex Host 状态与本工作区容器的生命周期、连接。
- **工作区容器**：Brain（`codex app-server`、Pi、DSH）与 Hands（`exec-server`、终端、文件、浏览器）同处，独立 `CODEX_HOME`；容器内不保存模型或账号凭据。

本页只设计 Node 侧所有权拆分与它在 Docker 上的落地；不设计 DO／Containers 适配器（第 5、6 阶段）。不改变已发布迁移、Hands 执行协议或沙盒 provider 契约（第 3 阶段由沙盒重构另行进行）。

## 2. 现状所有权

Docker 部署（`deploy/docker/compose.yaml`）有 `gateway`、`brain`、`hands` 三个容器（可选第四个 `proxy`，`compose.proxy.yaml`）。三者共享同一 `$DATA`（`OPENCRAFT_DATA_DIR`）与 `/workspace` 绑定挂载；`network_mode: host`（compose.yaml:9）；`brain` 与 `gateway` 为 `pid: host`（compose.yaml:77、145）。README 说明原因：执行租约恢复经 `/proc` 校验真实进程出生，私有描述符公布 loopback 端点（deploy/docker/README.md:226-230）。

"目标 owner"列：**AC**＝AccountCore，**IC**＝InstallationCore，**WH**＝每工作区 WorkspaceHost，**容器**＝工作区容器内的引擎运行时。

| 状态／锁 | 位置 | 现 owner（进程） | 证据 | 目标 owner |
| --- | --- | --- | --- | --- |
| Brain 进程单例锁 | `$DATA/native-host`（proper-lockfile） | brain `host.mjs` | scripts/container-deployment/host.mjs:28 | 容器（每容器一个，锁在容器私有根） |
| 账号 writer 锁 | `$DATA/codex/.codex-writer.sqlite`（`BEGIN EXCLUSIVE`） | codex-core split core（brain 内嵌或 `proxy`） | packages/account-pool-host/src/codex-writer-lock.ts:11-17；apps/codex-core/src/split-core.ts:16 | AC |
| 账号池与密钥 | `$DATA/codex/account-pool.sqlite`、`secrets/`、`personal-logins/<sha>` | 同上 | packages/account-pool-host/src/codex-account-service.ts:64-71 | AC |
| 模型代理 | loopback 端口（`proxy` 模式默认 45071，内嵌模式随机） | 同上 | host.mjs:98-110；scripts/container-deployment/proxy-core.mjs:6-15；compose.proxy.yaml:27 | AC（经 WH 中转或边缘出口，见 §5） |
| 代理调用者令牌 | `$DATA/run/proxy-callers/{pi,dsh,assistant}.json`，每类调用者一个**稳定**令牌，`baseUrl` 必须是 `127.0.0.1` | 同上发布；Pi/DSH 读取 | codex-account-service.ts:163-173；packages/account-pool-host/src/codex-proxy.ts:25；apps/local-agent-host/src/model-config/service.ts:13-19 | AC 签发、WH 分发短期租约 |
| AppServer runtime 锁＋`/proc` 扫描 | `$DATA/codex/.codex-runtime.sqlite`；扫描所有 `app-server` 进程的 `CODEX_HOME` | brain `codex-app-server` | codex-writer-lock.ts:12、21-40；apps/codex-core/src/app-server.ts:47 | 容器（扫描只需本容器 PID 命名空间） |
| `CODEX_HOME` | `$DATA/codex/runtime` | brain 原生 `codex app-server --listen unix://…/native-internal.sock` | app-server.ts:48-49、89-91、129-131；host.mjs:119-123 | 容器（每工作区一份） |
| 原生 Codex 维护 home | `$DATA/native-codex` | codex-core | proxy-core.mjs:14；apps/headless-server/src/headless-application.mjs:1110 | 待定：账号维护属 AC，线程原生数据属容器 |
| Codex Host overlays 锁 | `$DATA/codex/host-overlays-owner/` | **gateway** 内 `CodexEngineAdapter` | apps/opencraft-daemon/src/codex-engine-adapter.ts:899；headless-application.mjs:1099、1105-1107 | WH |
| Host 状态库 | `$DATA/codex/opencraft-host-state.sqlite`（queue、message senders、bot rooms／commands／slots、ioa presence、thread creators、thread catalog、catalog sync） | gateway | apps/opencraft-daemon/src/opencraft-host-state-database.ts:16-82、197-200 | 拆分，见 §4 |
| 暂定线程 | `thread-creations.sqlite` | gateway | apps/opencraft-daemon/src/provisional-threads.ts:25 | WH |
| 中断恢复 | `interrupted-turn-recovery.sqlite`＋进程内 `setTimeout` | gateway | packages/host-recovery/src/index.ts:33、39、101；codex-engine-adapter.ts:1060 | WH |
| 会话定时任务 | `conversation-schedules.sqlite`＋每 2 s `setInterval` 轮询 | gateway | packages/host-schedules/src/index.ts:50、196；codex-engine-adapter.ts:1109 | WH（Node 为 owner 定时器，DO 为 alarm） |
| 执行故障回执 | `execution-fault-receipts.json`（Worker 写） | gateway | apps/opencraft-daemon/src/execution-fault.worker.ts:19 | WH |
| Token usage | `token-usage.sqlite` | gateway | apps/opencraft-daemon/src/token-usage-state-database.ts:49；codex-engine-adapter.ts:1039 | 待定（§4.2） |
| 任务看板 | `tasks.sqlite`（`@opencraft/plugin-tasks`：tasks、task_conversations、members） | gateway | codex-engine-adapter.ts:697；plugins/tasks/src/sqlite.ts:26-41 | IC（跨会话业务记录） |
| 服务器核心 | `$DATA/opencraft-server.sqlite` | gateway（经 SQL 端口） | packages/storage-node/src/server/index.ts:28 | IC |
| DSH writer | `$DATA/agent/owner-writer.lock`＋本机存储 owner | brain `dsh-host.mjs` | scripts/server-deployment/dsh-host.mjs:41-43 | 容器 |
| Pi writer | `$DATA/pi-writer.lock`＋`$DATA/pi-owner` | brain `engine-host.mjs` | scripts/server-deployment/engine-host.mjs:60-62 | 容器 |
| 机器身份 | `$DATA` 下 daemon machine identity | dsh-host、engine-host 各自读取 | dsh-host.mjs:61；engine-host.mjs:76 | IC 定义部署身份；容器得到派生的工作区身份 |
| Session capabilities | `$DATA/session-capabilities.json`＋key | dsh-host、engine-host | dsh-host.mjs:72；engine-host.mjs:78、166；packages/session-capabilities/src/remote.ts:29 | WH 签发、容器校验（§3.4） |
| 模型策略 | `$DATA/model-usage-policy.sqlite`（Pi 与 DSH 同一文件） | engine-host、dsh-host | engine-host.mjs:74；dsh-host.mjs:63-64 | AC 或 IC（策略）；容器只读投影 |
| 模型配置与**凭据** | `$DATA/models/`（`models.json`＋`credentials.json`） | gateway、Pi、DSH 共同读写 | engine-host.mjs:90；headless-application.mjs:811、846、1003 | 配置：IC；凭据：AC（§5） |
| Hands 化身 | `execution/exec-owner.sock` 探测 `incarnation` | brain 观察，变化时重启 AppServer | host.mjs:113-118、138-160；scripts/container-deployment/hands-incarnation.mjs | 容器内部事实，经通道上报 WH |
| Gateway→Core | UDS `$DATA/run/codex-core.sock`＋`daemon.token` | gateway | scripts/container-deployment/paths.mjs:45-47；gateway-application.mjs:14-17、36-37 | WH↔容器通道（§3.3） |
| Gateway→Pi/DSH | 私有描述符 `run/engine-host.json`、`run/dsh-host.json`（loopback URL＋token） | gateway | paths.mjs:48-51；gateway-application.mjs:15-16、34-35 | 同上 |
| 回调通道 | 原生 `native.sock` 上的 orchestration callback lane，断开窗口默认 15 s | brain codex-core | app-server.ts:48；apps/codex-core/src/orchestration-callback-lane.ts:374 | 同上 |
| 跨容器 `/proc` 校验 | gateway 读取 brain 的 `codexPid`／引擎 PID 计算化身 | gateway | codex-engine-adapter.ts:584-592；apps/opencraft-daemon/src/codex-native-core-transport.ts:41；headless-application.mjs:884-893；packages/execution-environment/src/native-execution-origin.ts:10-54 | 由通道 attested incarnation 替代（§3.4） |
| Git 身份来源 | gateway 读取 `/proc/<pid>/cmdline`、children、`exe` 认定 Git 请求来源 | gateway | apps/headless-server/src/git-identity-origin.ts:24-62 | 容器内校验＋通道 attestation，或随 Git broker 进容器（待定） |
| Codex Generation Router | `codex-generations.sqlite`＋`.codex-routing-owner.sqlite`；每个 generation 独立 `runtimeDataDirectory/runtime` 作为 `CODEX_HOME` | systemd 部署的 codex-core | apps/codex-core/src/generation-registry.ts:76-84、104-110；generation-runtime.ts:159-187 | 见 §3.5 |

另外两点与"Brain 按工作区"直接相关：

- **Hands 已部分按工作区分配。** `CodexAppServer` 支持 `resolveWorkspace`／`workspaceAuthoritySocket`，把执行路由到按工作区分配的沙盒环境（app-server.ts:27-42、153-161）；Headless 的 Assets 工作区 owner 按会话分配 E2B 等环境（apps/headless-server/src/workspaces/execution-owner.ts；[Assets 工作区](../execution/workspace-assets.md)）。即今天是**共享 Brain＋按工作区 Hands**；本设计把 Brain 也纳入工作区。
- **多 `CODEX_HOME` 已有先例。** Generation Router 在同一部署内运行多个 AppServer、各自独立 HOME，并以 registry 持久化路由（execution-ownership.md §"Generation Router 的存储与提交边界"）。它按**版本代次**而非工作区划分，且只在 systemd 装配中使用，不在 Docker。

## 3. 目标拓扑

### 3.1 Node／Docker 与 Cloudflare 对照

| 角色 | Node／Docker（本设计） | Cloudflare（第 6 阶段，可选） |
| --- | --- | --- |
| 准入、认证、路由 | `gateway` 容器 | 边缘 Worker |
| InstallationCore | `gateway` 内现有服务器核心 owner（不变） | 每部署一个 DO |
| AccountCore | 现有 split core，固定为 `proxy` 服务（`compose.proxy.yaml` 成为默认） | 每部署一个 DO＋边缘出口 |
| WorkspaceHost | 每工作区一个 owner 实例，宿主见 §3.2 | 每工作区一个 DO |
| 工作区容器 | 默认工作区＝现有 `brain`＋`hands`；其余工作区见 §3.2 | 每工作区一个 Container |

### 3.2 WorkspaceHost 在 Node 上的宿主

`WorkspaceHost` 是**逻辑 owner**：一组数据（§4）＋一把 writer 锁＋一条容器通道＋定时器。它的代码不依赖宿主进程，只依赖存储端口（`SqlDatabase`、`StateDocumentStore`、`BlobStore`）与一个 `WorkspaceLink`（§3.3）。

两种 Node 宿主方案：

- **A（建议先做）：Gateway 进程内，每工作区一个 Worker。** 用 `@opencraft/worker-owner` 承载每个实例的 SQLite 与定时器，主线程只读投影（遵守 AGENTS.md 主线程不得阻塞）。数据根为 `$DATA/workspaces/<id>/host/`，writer 锁在其中。改动最小：今天 `CodexEngineAdapter` 已在 Gateway 内持有这些状态，只需从"一个"变为"按工作区多个"。代价：Gateway 重启会中断所有 WorkspaceHost（今天已是如此）。
- **B：独立 `workspace-host` 服务。** 一个部署级 supervisor 进程承载全部 WorkspaceHost，Gateway 经私有通道访问。好处是 Gateway 发布不打断定时任务与恢复，更接近 DO 形态；代价是新增一个服务与一跳。

两者的 WorkspaceHost 代码相同，差别只在装配。是否需要 B 取决于 Gateway 发布频率与定时任务容忍度（8.2 节问题 4）。

**工作区容器的创建者。** Docker 部署的约束是 Gateway 永不获得 Docker socket（deploy/docker/README.md:11-14）。因此：

1. **单工作区（默认）**：现有 `brain`＋`hands` 就是默认工作区容器，由 Compose 静态声明。第 1–5 步只需要它。
2. **多工作区**：需要选择一个创建者，候选为：（a）运维在 Compose 中静态声明 N 组 `brain-<id>`／`hands-<id>`（由 `layout.mjs` 生成，容量可预算、无 socket）；（b）一个持有 Docker socket 的独立 provisioner 服务，只接受 WorkspaceHost 的签名请求；（c）经第 3 阶段泛化后的沙盒 provider 分配"Brain＋Hands"镜像环境（E2B 自托管或未来 Cloudflare Containers）。本设计不预设答案（8.2 节问题 3）。

Brain 与 Hands 在 Docker 上是否合并为一个容器也待定：合并贴近目标拓扑，但会失去"Brain 发布不重启浏览器标签"的现有性质（README:9-14）。建议默认工作区保持两个容器、共享一个工作区私有根，视为一个"工作区容器组"。

### 3.3 WorkspaceHost ↔ 工作区容器：`WorkspaceLink`

替代今天的 UDS、私有描述符、loopback URL 与 `pid: host`。

- **一条认证双工通道。** 帧化、按 lane 多路复用，每 lane 有界缓冲与信用流控；单帧与单 lane 积压有上限，超限拒绝而非排队无界增长。
- **方向。** 容器内一个 `workspace-agent` 进程监听**一个**端点；WorkspaceHost 主动连接。与 DO 调用容器端口的方向一致。Docker 上端点是工作区私有目录中的 UDS（只挂载给该工作区容器组与 WorkspaceHost 宿主），或私有 bridge 网络上的端口；两者都不需要 `network_mode: host`。
- **认证。** 容器启动时注入一次性**链接密钥**（不是模型或账号凭据）；握手双方证明持有密钥并交换 `{workspaceId, containerIncarnation, leaseEpoch}`。密钥随容器化身轮换。
- **多路复用的 lane（初版）：**

  | lane | 取代 |
  | --- | --- |
  | `control`：health、readiness、incarnation、引擎清单、关闭 | `coreHealth`、描述符读取、`hands-incarnation` 探测 |
  | `codex-control`：现有 codex-core 控制 HTTP 语义 | `run/codex-core.sock`＋`daemon.token` |
  | `codex-native`：AppServer JSON-RPC 与 orchestration callback | `run/native.sock` WebSocket |
  | `pi`、`dsh`：现有 engine-host／dsh-host 协议 | `run/engine-host.json`、`run/dsh-host.json` loopback URL |
  | `files`、`terminal`、`browser` | `execution/files.sock`、`terminal.sock`、浏览器 owner socket |
  | `model-egress`：容器发出的模型请求（§5） | `proxy-callers/*.json` 与 loopback 代理端口 |

  lane 只承载现有协议字节，不改变其语义；第一步可以是"在通道两端各起一个本地 socket 适配器"，让引擎与 Gateway 代码不变。

- **化身与租约。** `containerIncarnation` 由容器内 `workspace-agent` 启动时生成（随机 128 位，并携带容器内 boot 与进程出生证据摘要）；`leaseEpoch` 由 WorkspaceHost 在持久状态中单调递增并在每次接纳新化身时提交。容器拒绝 epoch 落后的连接；WorkspaceHost 拒绝化身未登记的容器。重连只在**同一化身**内续接 lane；化身变化等同今天"Hands incarnation 变化 → 重启 AppServer"（host.mjs:138-160）与"执行进程重启"，走中断恢复。
- **不重放未确认输入。** 通道不做帧级重传。每个变更请求带现有幂等身份（`inputId`、`clientUserMessageId`、callback id）；通道断开时，未收到确认的变更在 WorkspaceHost 侧标记为 unconfirmed，重连后由所有者查询原生状态对账（沿用[中断 Turn 恢复](../execution/interrupted-turn-recovery.md)与 callback lane 断开窗口语义），而不是重发。只读请求可在重连后由调用方重新发起。

### 3.4 去除 `pid: host`

跨容器 `/proc` 读取的用途与替代：

| 用途 | 现状 | 替代 |
| --- | --- | --- |
| Codex 原生进程化身 | Gateway 用 `health.codexPid` 读 `/proc`（native-execution-origin.ts:32-54） | 容器内 `codex-app-server` 自行计算并经 `control` lane 上报；WorkspaceHost 以 `containerIncarnation`＋上报的原生化身作为执行租约身份 |
| Pi/DSH 执行化身 | headless-application.mjs:884-893 | 同上，由 engine-host／dsh-host 在容器内计算 |
| AppServer runtime 锁的 `/proc` 扫描 | 扫描全部进程（codex-writer-lock.ts:21-40） | 不变，但只需容器自身 PID 命名空间，因为 `CODEX_HOME` 已是容器私有 |
| Git 身份来源 | Gateway 读 `/proc/<pid>/cmdline`、children、exe（git-identity-origin.ts:24-62） | 需要决定：把来源校验移入容器并签名回执，或把 Git broker 的进程校验部分随容器部署。不得用"信任容器自报"代替现有校验强度 |

化身字符串格式会变化（今天是 `["process", bootId, pid, startTicks]`），所以已持久化的执行租约与 Git 来源租约在切换时视为旧化身：按现有规则失效并走恢复，不做格式转换。

### 3.5 Generation Router 的去留（计划退役）

Generation Router 目前只在 systemd 完整发布装配中运行（`deploy/web-server/opencraft-codex-generations.service.example`），职责是 Codex 引擎**不中断升级**：并行运行多个 AppServer 版本，registry 记录 Thread 所属版本，新 Thread 进入新版本，旧 Thread 在旧版本完成后退役；另含多 `CODEX_HOME` 路由、冷恢复与维护检查。Docker 装配不使用它。

按工作区拆分后，这一职责由 WorkspaceHost 持有：每个工作区容器记录所运行的镜像版本；升级时新 Thread 在新镜像上启动容器，旧容器完成当前 Turn 后在下一次空闲或重连时退役。采用"每 Thread 专属工作区"默认策略时，这与 Router 的 Thread 级版本固定语义等价，不再需要独立的 generation registry 与路由。

退役条件：WorkspaceHost 的"镜像版本固定＋旧容器排空"步骤（第 7 节）在真实部署上验收，且沿用 Router 现有的不中断、不重放未确认输入与故障停止规则及其测试。在此之前 Router 保留，是 systemd 部署唯一安全的升级路径；之后整体删除（`apps/codex-core/src/generation-*`、registry Worker、systemd 发布中的 bundle、service 示例与相关 smoke）。若已无运行中的 systemd 完整发布部署，可提前到第 1 步之后删除（待用户确认）。

## 4. Codex Host 状态拆分

### 4.1 归属

| 数据 | 目标 | 端口 | 说明 |
| --- | --- | --- | --- |
| `codex_host_queue` | WH | SQL | 每线程队列，只与本工作区原生线程交互 |
| `thread-creations.sqlite` | WH | SQL | 暂定线程只在创建所在工作区有意义 |
| `interrupted-turn-recovery.sqlite` | WH | SQL | 恢复 owner 必须与发出 `turn/start` 的 owner 相同 |
| `conversation-schedules.sqlite` | WH | SQL＋owner 定时器 | 见 4.3 |
| `execution-fault-receipts.json` | WH | State | 已是单键文档 |
| `codex_thread_catalog`、`codex_catalog_sync` | WH 持有真源；IC 持有跨工作区列表投影 | SQL | 侧栏"全部会话"需要跨工作区列表，投影可重建，不授予写权 |
| `message_senders`、`message_sender_origins`、`ioa_*`、`codex_bot_*` | 待定 | SQL | 与主体协作、Bot 房间相关；若 Bot 跨工作区，应进入 IC，否则留 WH |
| `token-usage.sqlite` | 待定 | SQL | 4.2 |
| `tasks.sqlite` | IC | SQL | 跨会话业务记录 |

WorkspaceHost 的 SQL 库是**一个**按工作区的库，合并今天分散的 `opencraft-host-state`、`thread-creations`、`interrupted-turn-recovery`、`conversation-schedules`（各自迁移账本保留为同库内的独立 schema id，或在合并迁移中显式导入；不能改写已发布迁移）。这让 DO 上一个 DO 对应一个 SQL 库成立。合并与否也可以推迟：第 2 步只要求"按工作区根目录"，不要求合库。

### 4.2 Token usage

今天 Gateway 记录 Codex 用量并提供查询（codex-engine-adapter.ts:1027-1046）。用量属于计量与策略，最终消费者是 AC（配额）与管理界面（跨工作区汇总）。建议：WH 只记录本工作区的原始用量事件并可靠转交；AC 持有汇总账本。需要确认现有查询 Worker 的语义是否允许"事件先在 WH 落库、再异步转交"的延迟（8.2 节问题 7）。

### 4.3 定时任务

`ConversationSchedules` 今天每 2 s 轮询（host-schedules/src/index.ts:196）。拆分后改为 owner 驱动：WH 在提交计划后计算"下一个到期时间"，Node 上设置单个 owner 定时器（Worker 内），DO 上设置 alarm。轮询语义不变：到期判断仍以持久状态为准，定时器只是唤醒。Gateway 不在线（方案 B）或 WH 重启后，启动时先按持久状态补齐过期计划，不依赖定时器连续性。

### 4.4 恢复所有权

- Codex：恢复从 Gateway 的单一 `CodexEngineAdapter` 移到每个 WH（今天 execution-ownership.md 记录"Codex Host 恢复在 Gateway"）。容器化身变化即"执行进程重启"证据。
- Pi／DSH：仍在容器内（引擎 owner 持有 `interrupted-turn-recovery.sqlite`），不变。
- 通道断开**不是**执行丢失证据（与现有规则一致）：WH 先经 `control` lane 读取同一化身状态，只有化身变化或确认销毁才进入恢复。

## 5. 账号与凭据

**边界。** AC 唯一持有：账号池、加密凭据、OAuth 刷新、选号与亲和、计量与策略、用户配置的 provider 密钥。工作区容器内不出现任何长期凭据文件。

**现状与目标的差距（需如实承认）：**

- 内嵌代理模式（默认）下，Pi、DSH 直接从 `$DATA/models/credentials.json` 解析 provider 密钥（engine-host.mjs:90；dsh-host 的 `modelStorageDirectory`）。
- `proxy` 模式下也只有"显式 `baseUrl` 且协议为 `anthropic-messages`／`openai-responses`"的 provider 经代理；目录默认端点、人类订阅与其他协议仍直连并需要真实凭据（model-config/service.ts:28-32）。
- 代理调用者令牌按调用者**类型**而非工作区签发，且不过期（codex-account-service.ts:163-173）；`baseUrl` 被校验为 `127.0.0.1`，依赖 host 网络（service.ts:18）。

**目标路径：**

1. 容器内引擎只看到一个本地代理地址（容器 loopback，由 `workspace-agent` 提供），请求经 `model-egress` lane 到 WH，WH 转交 AC。Codex 已经通过 `chatgpt_base_url` 走代理（app-server.ts:107-109），Pi/DSH 复用现有 `proxyProjection`。
2. AC 为每个 `{workspaceId, engine, containerIncarnation}` 签发**短期**调用租约；WH 负责续期，化身变化或工作区停用即撤销。代理按租约做配额与计量。
3. 要把"所有 provider 都经代理"作为前置条件：补齐目录默认端点与其他协议的代理转发，或在工作区模式下明确拒绝这些 provider。不能保留直连而宣称容器无凭据。
4. 人类订阅／个人登录（`personal-logins/`）留在 AC；容器只得到代理租约。
5. Cloudflare 后续：`model-egress` 由容器出站处理交给边缘 Worker，Worker 向 AC DO 取短期凭据后直连 provider（cloudflare-deployment.md §2.1）。Node 上 AC 自己转发。

`model-usage-policy.sqlite` 今天被 Pi 与 DSH 共同打开；拆分后策略写入归 AC（或 IC），容器得到只读快照并在租约中携带版本。

## 6. 迁移与兼容

### 6.1 目录布局

```
$DATA/                       部署级：opencraft-server.sqlite、models/（配置）、hub、installation keys
$DATA/codex/                 AC：account-pool.sqlite、secrets/、personal-logins/、.codex-writer.sqlite
$DATA/workspaces/<id>/host/  WH：Host 状态库、恢复、定时任务、故障回执、writer 锁
$DATA/workspaces/<id>/brain/ 容器私有：codex/runtime（CODEX_HOME）、agent/（DSH）、pi/、run/
/workspace/...               项目与会话目录（挂载范围按工作区收窄，见问题 2）
```

现有安装映射为工作区 `default`。

### 6.2 冷迁移（每步一个，均可重入）

- **只在停机状态执行**：先停 `gateway` 与 `brain`（`proxy` 若独立可继续运行），由 `layout.mjs` 新增的 `migrate-workspaces` 子命令执行。持有部署锁（compose-release 已有部署锁），存在任何 writer 锁持有者即拒绝。
- **方式是 rename，不是复制。** 同一文件系统内逐项 `rename` 到新位置，每项完成后追加到 `$DATA/workspaces/.migration.jsonl`（fsync）。中断后重跑读取日志跳过已完成项；源与目标同时存在即停止并报告，不猜测。
- **只移动、不改写内容。** SQLite 文件连同 `-wal`／`-shm` 一起移动（先确认无持有者并做 `wal_checkpoint`）；迁移账本与 checksum 不变。合库（§4.1）是之后的独立迁移，带 `VACUUM INTO` 备份。
- **原生 `CODEX_HOME` 内的绝对路径。** Codex rollout 与 DSH/Pi 会话可能记录了 `$DATA/codex/runtime` 等绝对路径；`rename` 前必须核实这些引擎是否持久化 home 绝对路径。若有，则不移动 Brain 私有数据，改用新路径指向旧位置（配置层面），并登记为已知例外。**此项未核实。**
- **回退。** 旧版本只认旧路径。回退命令按日志逆序 `rename` 回去；在新版本写入过 WH 合库或新迁移之后，回退需要该迁移自身的备份恢复。发布说明须写明"回退窗口截至合库迁移前"。

### 6.3 单工作区安装

`default` 工作区复用现有 `brain`、`hands` 服务与挂载，用户可见行为不变。多工作区是显式开启的装配选项。Electron 与本机 Host 不经过本设计：它们没有 Gateway／Brain 分离，继续使用现有本机 owner；只有共享的 WorkspaceHost 代码（存储端口之上）可被复用。

### 6.4 保持部署级的内容

服务器核心、成员与授权、Hub、模型配置（非凭据）、插件安装、任务看板、Web 资源、账号与凭据、模型策略、跨工作区会话列表投影。

## 7. 分步计划

每步都在 Docker 上独立可发布、可回退，并且只依赖之前的步骤。

| 步 | 内容 | 在 Node 上的价值 | 验证 |
| --- | --- | --- | --- |
| 1 | `proxy` 服务成为 Docker 默认；补齐所有 provider 经代理或在该模式下拒绝直连 | Brain 发布不重启账号 owner；Brain 不再需要凭据文件 | 真实 Docker：删除 brain 内 `models/credentials.json` 可读性后 Pi/DSH/Codex 均能调用模型；代理重启期间 Brain 不重启 |
| 2 | 抽出 `WorkspaceHost` 模块：把 `CodexEngineAdapter` 的 overlays（§4.1 WH 行）改为通过存储端口、以显式工作区根打开；Gateway 只装配 `default` | 所有权显式化；为 DO 准备 | 现有 host-state、恢复、定时任务、队列测试在新入口下全部通过；`check:boundaries` 计数不增 |
| 3 | 定时任务改为 owner 驱动定时器 | 去除 2 s 轮询 | 到期、重启补齐、时钟回拨、关闭排空测试 |
| 4 | `WorkspaceLink` 与容器内 `workspace-agent`，先以本地 socket 适配器承载现有协议；Gateway 改为只经通道访问 Brain／Hands | 去掉私有描述符与 loopback 依赖 | 断开／重连同一化身不重发变更（held-promise＋丢 ack 测试）；化身变化触发恢复；Gateway 重建后续接 |
| 5 | 化身改由通道上报；移除 Gateway 的跨容器 `/proc` 读取；解决 Git 来源校验 | 删除 `pid: host` 与 `network_mode: host`（Hands 浏览器出网需求另行评估） | 真实 Docker：去掉两项后执行租约、Git 来源、恢复冒烟通过；PID 重用测试 |
| 6 | 冷迁移到 `$DATA/workspaces/default/` | 共享 `$DATA` 不再被 Brain 写入 | 从上一版本真实数据目录升级、中途 kill 后重跑、回退演练 |
| 7 | 多工作区：按 8.1 决定与 8.2 节问题 3 的结论实现容器创建者；按工作区 `CODEX_HOME`、Pi、DSH writer | 一工作区一 Brain | 两个工作区并发 Turn、一方容器重启不影响另一方、凭据不可见检查、容量准入 |
| 8 | 跨工作区会话列表投影与 token usage 转交 | 侧栏与计量跨工作区正确 | 投影重建、转交延迟与重复 |

第 5 阶段（Cloudflare 适配器）只在第 2–4 步完成后开始。

补充步骤（Router 退役前置）：WorkspaceHost 固定工作区容器镜像版本，升级时新 Thread 使用新镜像、旧容器排空后退役；验收覆盖进行中 Turn 不被中断、未确认输入不重放、故障停止。完成并在真实部署验收后删除 Generation Router（见 3.5 节）。

## 8. 待决问题

### 8.1 决定一：拆分单位是 Workspace 还是 Thread（由用户决定）

两个选项都能满足"每单位一个 Brain＋Hands、凭据不进容器"。下文中性列出证据；末尾给出建议，但**由用户决定**，决定前第 7 步不开始（第 1–6 步对两者都成立）。

- **A：单位＝现有 Assets／ordinary Workspace。** 持久 `/workspace`，Thread 被放置（placement）进工作区（[Assets 工作区](../execution/workspace-assets.md) 将 workspace 配置、物理环境与 Thread placement 列为分开的事实；AGENTS.md 执行沙盒节："不假定一个 Thread 等于一个沙盒"）。附加策略"每 Thread 专属工作区"：随 Thread 创建与回收，用于隔离或简单生命周期，可设为默认。
- **B：单位＝Thread。** 每个 Thread 一个 Brain＋Hands 容器。

现状证据：ordinary 工作区日志表 `ordinary_workspaces` 有 `UNIQUE(host_id, thread_id)`（apps/local-agent-host/src/ordinary-workspace-store.ts:47-52），即**今天普通会话的工作区事实上已是"一 Thread 一工作区"**；Bot 则使用独立的工作区池，与普通会话共享预算（workspace-assets.md §Ownership）。因此 A 的"每 Thread 专属"策略与今天普通会话行为一致，A 的"多 Thread 共享"是对现状的扩展。

| 维度 | A：Workspace（＋可选每 Thread 策略） | B：Thread |
| --- | --- | --- |
| 同一 Project 多个 Thread 共享仓库／工作目录 | 放进同一工作区即共享同一 checkout 与 `/workspace` 路径；选择专属策略时退化为各自 checkout | 每 Thread 一个容器，共享 checkout 需要跨容器共享卷或 Git 同步；跨容器共享写目录会重新引入今天要去掉的共享挂载与并发写问题 |
| 父子编排 Thread（`ThreadRelation.parentThreadId`／`lifecycleOwnerThreadId`，packages/access-control/src/orchestration-ledger.ts:11-16；orchestration callback lane） | 父子放进同一工作区时，callback 与共享文件都在同一 owner 和容器内，不跨通道；也可按策略把子 Thread 放入独立工作区 | 每个子 Thread 新开容器：子任务的冷启动与资源预算按子 Thread 数量叠加；父子之间的 callback 与文件交换都必须跨 WorkspaceHost，需要新增跨 owner 的编排协议与文件传递 |
| Codex AppServer 在一个 `CODEX_HOME` 承载多 Thread | 一个工作区一个 AppServer，承载该工作区所有 Thread，与 AppServer 现有设计一致 | 每容器一个 AppServer 只承载一个 Thread；AppServer、Pi、DSH 的常驻开销按 Thread 计；fork／跨 Thread 读取历史需要跨容器 |
| 容器数量、空闲成本、冷启动（默认每环境请求 4 vCPU／8 GiB） | 容器数＝活跃工作区数；共享工作区时远少于 Thread 数。专属策略下与 B 相同 | 容器数＝活跃 Thread 数。若每个都按默认 4 vCPU／8 GiB 预留，单机只能容纳很少的并发 Thread；除非降低每 Thread 预算或空闲即停容器，而停容器把冷启动加到每次恢复对话上（冷启动时间尚未测量） |
| 恢复与状态还原粒度 | 一个容器化身变化影响该工作区内所有 Thread，各自按中断恢复规则处理；专属策略下粒度与 B 相同 | 粒度最细：一个 Thread 的容器故障不影响其他 Thread |
| 生命周期 | 工作区有独立生命周期（创建、空闲回收、删除），需要定义 Thread 删除后工作区何时回收；专属策略下随 Thread | 最简单：随 Thread 创建、归档／删除时回收 |
| 隔离 | 共享工作区内 Thread 之间不隔离（同一用户与文件）；需要隔离时用专属策略 | 天然隔离 |

**Owner 内 Thread 级状态的键。** 两种选项下，queue、中断恢复、定时任务、暂定线程、token usage 都以 `threadId`（加现有的 `inputId`／`turnId`）为主键，与今天在 Gateway 中的键相同。A 中一个 WorkspaceHost 库包含多个 Thread 的行，另需一张 `thread_placement(threadId → workspaceId)` 投影供 Gateway 路由（真源在 WH，IC 持有可重建投影）。B 中每个库只含一个 Thread，`workspaceId == threadId`，路由可直接由 `threadId` 推出，但跨 Thread 查询（定时任务列表、用量汇总）全部依赖 IC 投影。A 选择专属策略时库形态与 B 相同，仍使用同一套键，所以 A 和 B 的 WH 代码可以共用；差别在放置策略与容器数量。

**建议（非决定）：** 选 A，并提供"每 Thread 专属工作区"策略（可作为普通会话默认，与现状一致），同一 Project 的协作 Thread 和父子编排 Thread 可选择放入同一工作区。理由：保留共享 checkout 与同容器编排；容器数与预算不随 Thread 数线性增长；B 的隔离与简单生命周期可通过策略得到。**需要用户决定：** 采用 A 或 B；若 A，默认策略是"专属"还是"按 Project 共享"；子编排 Thread 默认是否与父同工作区。

### 8.2 其他问题

1. **工作区的其余定义问题。** 无论 8.1 结论如何，都需确认 Projectless 会话与 Codex 本地执行路径如何落入工作区，以及 Thread→工作区绑定创建后是否可变（建议不可变）。
2. **`/workspace` 挂载范围。** 今天三容器共享整个 `/workspace`。按工作区收窄会改变"保留绝对项目路径"的现有部署约定（README 的 `OPENCRAFT_HOST_WORKSPACE_DIR` 说明）。
3. **Docker 上谁创建工作区容器**（§3.2 的 a／b／c）。b 引入 Docker socket，违背现有边界；a 无弹性；c 依赖第 3 阶段与 provider 能力。
4. **WorkspaceHost 宿主**：Gateway 内（A）或独立服务（B）。
5. **密度与成本。** 每工作区一个 AppServer＋Pi＋DSH＋浏览器的内存基线未测量；默认 4 vCPU／8 GiB 预算是按工作区还是全机共享，需要与 Assets 预算账本统一。空闲工作区是否停容器（冷启动时间待测）。
6. **AppServer 共享还是按工作区。** 一个共享 AppServer 按线程路由到不同 Hands 环境（今天 `resolveWorkspace` 已支持）成本更低，但 `CODEX_HOME` 共享，不满足"工作区隔离 Brain"。是否接受"小部署共享、隔离部署按工作区"两种装配。
7. **Token usage 与 Bot／IOA 表的归属**（§4.1、§4.2）。
8. **Brain 与 Hands 是否合并**为单容器（§3.2）。

## 9. 与早期调查不一致之处

- `$DATA/codex` 并非只属于 Gateway：同一目录同时是账号 Core 数据根（`account-pool.sqlite`、`.codex-writer.sqlite`）、Brain AppServer runtime 根（`.codex-runtime.sqlite`、`runtime/`＝`CODEX_HOME`）与 Gateway Host overlays 根（host.mjs:122；proxy-core.mjs:13；headless-application.mjs:1099）。三个 owner 以三把不同的锁共存于一个目录，迁移必须逐项区分。
- 模型凭据不只在账号 Core：`$DATA/models/credentials.json` 被 Gateway、Pi、DSH 共同读取；`proxy` 模式也未覆盖所有 provider。
- `pid: host` 的依赖不止执行租约：Gateway 的 Git 身份来源校验也读取 Brain 进程的 `/proc`。
- 15 s 是 Brain 侧 callback lane 的断开窗口（orchestration-callback-lane.ts:374），不是 Gateway 的重连间隔。
- 已存在多 `CODEX_HOME` 机制（Generation Router）与按工作区 Hands 路由（`resolveWorkspace`），本设计应复用其语义而非另造。
