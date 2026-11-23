# Gateway／Brain 按工作区拆分

[Architecture index](../README.md) · [存储端口](storage-ports.md) · [可选 Cloudflare 部署](cloudflare-deployment.md) · [执行所有权](../execution/execution-ownership.md) · [中断 Turn 恢复](../execution/interrupted-turn-recovery.md) · [Assets 工作区](../execution/workspace-assets.md) · [Docker 三角色部署](../../../deploy/docker/README.md)

状态：**设计；第 2、3 步与第 4a 步已实施，其余为提议。** 对应[存储端口](storage-ports.md)第 4 阶段。下文"现状"以引用的源码行为准（2026-11 核对）；"目标"与"步骤"中未标注"已实现"的均为提议；§8 记录已定决定与仍待决的问题。Node／Docker 自托管是一等公民：每一步都必须先在 Docker 上独立成立，Cloudflare 只是后续可选装配。

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
| 原生 Codex 维护 home | `$DATA/native-codex` | codex-core | proxy-core.mjs:14；apps/headless-server/src/headless-application.mjs:1112 | 待定：账号维护属 AC，线程原生数据属容器 |
| Codex Host overlays 锁 | `$DATA/codex/host-overlays-owner/` | **gateway** 内 `default` WorkspaceHost（由 `CodexEngineAdapter` 打开并消费） | apps/opencraft-daemon/src/workspace-host.ts:54；codex-engine-adapter.ts:870；headless-application.mjs:1099-1101、1107-1109 | WH（第 2 步已落地） |
| Host 状态库 | `$DATA/codex/opencraft-host-state.sqlite`（queue、message senders、bot rooms／commands／slots、ioa presence、thread creators、thread catalog、catalog sync） | gateway（WorkspaceHost 打开整库） | apps/opencraft-daemon/src/opencraft-host-state-database.ts:16-82、197-200；workspace-host.ts:56、60 | 拆分，见 §4 |
| 暂定线程 | `thread-creations.sqlite` | gateway（WorkspaceHost） | apps/opencraft-daemon/src/provisional-threads.ts:25；workspace-host.ts:57 | WH |
| 中断恢复 | `interrupted-turn-recovery.sqlite`＋进程内 `setTimeout` | gateway（WorkspaceHost） | packages/host-recovery/src/index.ts:33、39、101；workspace-host.ts:64-66；端口 codex-engine-adapter.ts:3714、3740 | WH |
| 会话定时任务 | `conversation-schedules.sqlite`＋owner 驱动唤醒（第 3 步起不再轮询） | gateway（WorkspaceHost） | packages/host-schedules/src/index.ts；workspace-host.ts:62-63；端口 codex-engine-adapter.ts:3771 | WH（Node 为 owner 定时器，DO 为 alarm） |
| 执行故障回执（已停用） | `execution-fault-receipts.json`，原由 Generation Router 故障驱动的 Worker 写入；写入方已删除，旧文件保留不读 | 无 | 2026-11-22 随 Router 消费端删除 | 不迁移；WH 恢复见 §4.4 |
| Token usage | `token-usage.sqlite` | gateway | apps/opencraft-daemon/src/token-usage-state-database.ts:49；codex-engine-adapter.ts:994（第 2 步仍由 adapter 打开） | 待定（§4.2） |
| 任务看板 | `tasks.sqlite`（`@opencraft/plugin-tasks`：tasks、task_conversations、members） | gateway | codex-engine-adapter.ts:673（第 2 步仍由 adapter 打开）；plugins/tasks/src/sqlite.ts:26-41 | IC（跨会话业务记录） |
| 服务器核心 | `$DATA/opencraft-server.sqlite` | gateway（经 SQL 端口） | packages/storage-node/src/server/index.ts:28 | IC |
| DSH writer | `$DATA/agent/owner-writer.lock`＋本机存储 owner | brain `dsh-host.mjs` | scripts/server-deployment/dsh-host.mjs:41-43 | 容器 |
| Pi writer | `$DATA/pi-writer.lock`＋`$DATA/pi-owner` | brain `engine-host.mjs` | scripts/server-deployment/engine-host.mjs:60-62 | 容器 |
| 机器身份 | `$DATA` 下 daemon machine identity | dsh-host、engine-host 各自读取 | dsh-host.mjs:61；engine-host.mjs:76 | IC 定义部署身份；容器得到派生的工作区身份 |
| Session capabilities | `$DATA/session-capabilities.json`＋key | dsh-host、engine-host | dsh-host.mjs:72；engine-host.mjs:78、166；packages/session-capabilities/src/remote.ts:29 | WH 签发、容器校验（§3.4） |
| 模型策略 | `$DATA/model-usage-policy.sqlite`（Pi 与 DSH 同一文件） | engine-host、dsh-host | engine-host.mjs:74；dsh-host.mjs:63-64 | AC 或 IC（策略）；容器只读投影 |
| 模型配置与**凭据** | `$DATA/models/`（`models.json`＋`credentials.json`） | gateway、Pi、DSH 共同读写 | engine-host.mjs:90；headless-application.mjs:812、847、1004 | 配置：IC；凭据：AC（§5） |
| Hands 化身 | `execution/exec-owner.sock` 探测 `incarnation` | brain 观察，变化时重启 AppServer | host.mjs:113-118、138-160；scripts/container-deployment/hands-incarnation.mjs | 容器内部事实，经 `control` 端点上报 WH |
| Gateway→Core | UDS `$DATA/run/codex-core.sock`＋`daemon.token` | gateway | scripts/container-deployment/paths.mjs:45-47；gateway-application.mjs:14-17、36-37 | WH 经端点访问（§3.3） |
| Gateway→Pi/DSH | 私有描述符 `run/engine-host.json`、`run/dsh-host.json`（loopback URL＋token） | gateway | paths.mjs:48-51；gateway-application.mjs:15-16、34-35 | 同上 |
| 回调通道 | 原生 `native.sock` 上的 orchestration callback lane，断开窗口默认 15 s | brain codex-core | app-server.ts:48；apps/codex-core/src/orchestration-callback-lane.ts:374 | 同上 |
| 跨容器 `/proc` 校验 | gateway 读取 brain 的 `codexPid`／引擎 PID 计算化身 | gateway | codex-engine-adapter.ts:558-568；apps/opencraft-daemon/src/codex-native-core-transport.ts:34；headless-application.mjs:885-894；packages/execution-environment/src/native-execution-origin.ts:10-54 | 由 `workspace-agent` 上报的化身替代（§3.4） |
| Git 身份来源 | gateway 读取 `/proc/<pid>/cmdline`、children、`exe` 认定 Git 请求来源 | gateway | apps/headless-server/src/git-identity-origin.ts:24-62 | `workspace-agent` 在容器内校验，WH 签发短期 Git 凭据（§3.4，§8.3 决定 6） |
| Codex Generation Router（已删除） | 原 `codex-generations.sqlite`＋`.codex-routing-owner.sqlite` 与每代独立 `CODEX_HOME` | 原 systemd 部署的 codex-core | 已随 systemd 完整发布装配删除 | 见 §3.5 |

另外两点与"Brain 按工作区"直接相关：

- **Hands 已部分按工作区分配。** `CodexAppServer` 支持 `resolveWorkspace`／`workspaceAuthoritySocket`，把执行路由到按工作区分配的沙盒环境（app-server.ts:27-42、153-161）；Headless 的 Assets 工作区 owner 按会话分配 E2B 等环境（apps/headless-server/src/workspaces/execution-owner.ts；[Assets 工作区](../execution/workspace-assets.md)）。即今天是**共享 Brain＋按工作区 Hands**；本设计把 Brain 也纳入工作区。
- **多 `CODEX_HOME` 曾有先例。** 已删除的 Generation Router 曾在同一部署内运行多个 AppServer、各自独立 HOME，并以 registry 持久化路由（见 execution-ownership.md "Generation Router（已删除）"）。它按**版本代次**而非工作区划分；其不中断升级语义由 §3.5 的镜像版本固定承接。

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

`WorkspaceHost` 是**逻辑 owner**：一组数据（§4）＋一把 writer 锁＋一条容器通道＋定时器。它的代码不依赖宿主进程，只依赖存储端口（`SqlDatabase`、`StateDocumentStore`、`BlobStore`）、唤醒端口与一个 `SandboxEnvironment`（§3.3）。

两种 Node 宿主方案：

- **A（建议先做）：Gateway 进程内，每工作区一个 Worker。** 用 `@opencraft/worker-owner` 承载每个实例的 SQLite 与定时器，主线程只读投影（遵守 AGENTS.md 主线程不得阻塞）。数据根为 `$DATA/workspaces/<id>/host/`，writer 锁在其中。改动最小：今天 `CodexEngineAdapter` 已在 Gateway 内持有这些状态，只需从"一个"变为"按工作区多个"。代价：Gateway 重启会中断所有 WorkspaceHost（今天已是如此）。
- **B：独立 `workspace-host` 服务。** 一个部署级 supervisor 进程承载全部 WorkspaceHost，Gateway 经私有通道访问。好处是 Gateway 发布不打断定时任务与恢复，更接近 DO 形态；代价是新增一个服务与一跳。

两者的 WorkspaceHost 代码相同，差别只在装配。是否需要 B 取决于 Gateway 发布频率与定时任务容忍度（8.2 节问题 4）。

**工作区容器的创建者。** Docker 部署的约束是 Gateway 永不获得 Docker socket（deploy/docker/README.md:11-14）。因此：

1. **单工作区（默认）**：`static-docker` provider，Compose 静态声明的工作区容器（§3.3.4）。第 1–5 步只需要它。
2. **多工作区**：先实现 `docker-provisioner`（持有 Docker socket 的独立服务，只接受 WorkspaceHost 的签名请求；其授权边界作为单独的服务边界设计，Gateway 仍不持有 socket），其次 `e2b`（§8.3 决定 5）。

Brain 与 Hands 合并为一个工作区容器（第 5b 步）。合并后 Brain 发布会重启该容器内的浏览器（今天 README:9-14 的"Brain 发布不重启浏览器标签"性质不再保留）；浏览器为可选组件（§8.3 决定 4）。终端 PTY 由 `workspace-agent` 持有，WorkspaceHost 断开不结束 PTY（决定 2），但容器化身变化会结束 PTY。

### 3.3 放置：WorkspaceHost 只持有 `SandboxEnvironment`

Brain 与 Hands 放在哪里**是部署配置**：WorkspaceHost 只依赖[沙盒端口](../execution/execution-sandbox.md)的 `SandboxEnvironment`，provider（`static-docker`／`docker-provisioner`／`e2b`／`cloudflare`）由部署装配选择，差异只剩 provider 配置与镜像。此前设想的自建帧多路复用通道（`WorkspaceLink`，按 lane 信用流控）不再采用：provider 的进程流本身就是多路复用的字节流。已定前提：单位＝Workspace（默认每 Thread 专属，§8.1）；Brain＋Hands 同一容器；容器内无长期凭据（§8.3 决定 6）。

#### 3.3.1 现状：每个组件如何启动、如何被找到（2026-11-23 源码）

第 4b 步之后，`host.mjs` 与 hands-application 的监督已由 `workspace-agent` 取代，启动配置与原生 listener 移入容器私有目录（§7"第 4b 步现状"）；下表保留调研时的文件与行号，Gateway 到达方式在第 4c 步前不变。

| 组件 | 谁启动 | Gateway 如何到达 | 证据 |
| --- | --- | --- | --- |
| Brain 总控 | Compose `brain` 运行 `host.mjs`，`$DATA/native-host` 进程锁 | — | scripts/container-deployment/host.mjs:28、42-63 |
| 账号 Core（内嵌或 `proxy`） | host.mjs 内嵌启动或独立 `proxy` 服务 | UDS `run/codex-core.sock`＋`daemon.token` | host.mjs:67、98-110；paths.mjs:45-46；gateway-application.mjs:14、17、36-37 |
| Codex AppServer owner（Node） | host.mjs 启动 `codex-app-server.cjs` | 控制 HTTP 经 split core 转发 `/native-health` 到 `run/codex-app-server.sock` | host.mjs:119-125；apps/codex-core/src/split-core.ts:41、102 |
| 原生 `codex app-server` | AppServer owner 以 `--listen unix://…/native-internal.sock` 启动，`CODEX_HOME=$DATA/codex/runtime` | 不直接到达；owner 自己连一条 owner lane | apps/codex-core/src/app-server.ts:49、129-133、148；native-process.ts:47-54 |
| orchestration callback lane | AppServer owner 在 `run/native.sock` 开 WebSocket 门面，**每个 lane 各开一条**到原生的上游连接（≤32） | Gateway 读 health 中的 `nativeSocket`，连 `ws+unix://…/native.sock?opencraftLane=` | orchestration-callback-lane.ts:72、355-366、374；apps/opencraft-daemon/src/codex-core-socket.ts:41-42 |
| Pi（engine-host） | host.mjs 启动 | 描述符 `run/engine-host.json`：`websocketUrl`＋`controlUrl=http://127.0.0.1:<随机>`＋token | host.mjs:129；scripts/server-deployment/engine-host.mjs:229、241-243 |
| DSH（dsh-host） | host.mjs 启动 | 描述符 `run/dsh-host.json`：`websocketUrl`＋owner-handoff loopback URL | scripts/server-deployment/dsh-host.mjs:115-119；gateway-application.mjs:35 |
| Hands exec-server | Compose `hands` 的 `hands-execution-owner.mjs`，`exec-owner.sock`；**只接受固定向量** `codex exec-server --listen stdio` | AppServer 的 sandbox runner 经 `hands-unix` backend 连接 | hands-application.mjs:28-31；packages/sandbox-node/src/hands-unix.ts:202-215；host.mjs:91-96 |
| Hands 终端／文件／浏览器 | 同上，各自 owner socket | Gateway 直连 `execution/terminal.sock`、`files.sock`、浏览器 `owner.sock` | hands-application.mjs:28、37；paths.mjs:37-43；gateway-application.mjs:32-33 |
| Hands 化身 | `exec-owner.sock` probe 帧 `healthy{incarnation}` | Brain 轮询，变化即重启 AppServer | hands-unix.ts:195；host.mjs:113-118、138-160 |

**跨容器依赖。** `network_mode: host` 与 `pid: host`（deploy/docker/compose.yaml:9、110、188）支撑：（1）Gateway 用 health 中的 `codexPid` 读 `/proc` 计算原生化身（apps/opencraft-daemon/src/codex-native-core-transport.ts:31-35；packages/execution-environment/src/native-execution-origin.ts:10-38）；（2）Pi/DSH 经 `/execution-origin` 返回 PID 再由 Gateway 读 `/proc`（engine-host.mjs:183-200；headless-application.mjs:893-899）；（3）Git 身份 broker 以 SO_PEERCRED 取对端 PID 并沿 `/proc` 树校验（packages/execution-environment/src/git-identity-ipc.ts:11-27；apps/headless-server/src/git-identity-broker.ts:24-36；git-identity-origin.ts:24-38）；（4）各 loopback URL。

**容器→Gateway 方向的连接（常被忽略）。** AppServer 连 Gateway 的工作区授权 socket（app-server.ts:153-154）；Pi/DSH 连 Gateway 的 session-capability MCP `http://127.0.0.1/mcp`，签名密钥读 `$DATA/session-capabilities.json`（packages/session-capabilities/src/remote.ts:28-34；engine-host.mjs:80）；DSH 任务目录连 `codex-core.sock`（host.mjs:89）；执行进程连 Git broker；引擎连模型代理（`proxy-callers/*.json`）。

**已经"经 sandbox.spawn＋stdio"的部分（E2B／普通会话）。** 端口 `SandboxBackend.create → SandboxEnvironment.spawn → SandboxProcess`（packages/sandbox/src/contract.ts）；共享 broker 承担帧、PTY、进程组与终止，provider 只提供"启动 broker 并给一条双工"（packages/sandbox/src/broker.ts；E2B 见 packages/sandbox-e2b/src/index.ts）。exec-server 经 `createSandboxJsonRpcBridge` 换成 Gateway 进程内 `ws://127.0.0.1:<port>/<capability>` 再注册给 AppServer（apps/local-agent-host/src/sandbox-conversation-binding.ts；packages/sandbox-node/src/json-rpc-bridge.ts），因此要求 AppServer 能访问 Gateway loopback（workspace-execution-channel.ts 校验 `ws://127.0.0.1`）。终端经 broker PTY（sandbox-process-service.ts）；文件每次操作 spawn 一个 Python helper（sandbox-workspace-files.ts）；浏览器 spawn 容器内 owner，再经 stdio↔UDS 中继连接它——第 4a 步已把该中继抽成通用 `openSandboxEndpoint`（§3.3.3）。

**Codex stdio。** 固定版本 `@openai/codex 0.162.1` 已支持 `app-server --listen stdio://`，但 stdio 只有**一条**连接，而 AppServer owner 今天对原生开 1 条 owner lane＋每个 callback lane 1 条（orchestration-callback-lane.ts:72、358-366）。因此**不把原生 AppServer 改成 stdio**：容器内 Node owner 继续用容器私有 UDS 连原生，只把 owner 的对外面暴露为端点。

**本地 backend 不能充当工作区 provider。** `hands-unix` 每连接一个固定向量 exec-server、不支持 terminal；`linux-systemd` 是本机 transient unit。二者都不能创建带镜像的工作区容器。可复用的是 `hands-unix` 的"容器内 owner 监听私有 UDS、token 握手、lease 帧"模式与 broker 协议本身。

#### 3.3.2 差距

| 现状 | 目标 | 可复用 |
| --- | --- | --- |
| Brain 进程是 Compose 服务，host.mjs 启动 | 容器内常驻 `workspace-agent`（瘦身的 host.mjs）作为容器入口，由 provider 启动 | host.mjs 的启动顺序、就绪等待、AppServer 替换（:113-160） |
| Gateway 读 `$DATA/run/*.json`、`*.sock`、loopback | WH 经 `SandboxEnvironment` 打开**命名端点**的字节流 | `openSandboxEndpoint`（第 4a 步）；`json-rpc-bridge` 的私有本地监听模式 |
| AppServer 经 Gateway loopback 连 exec-server | 同容器：AppServer 的 sandbox runner 在容器内直接 spawn exec-server（同 `include_local=false` 约束） | `configureCodexExecutionSandbox`（codex-core/src/execution-sandbox.ts:18） |
| 容器→Gateway：授权 socket、session-capability MCP、Git broker、任务目录 | 容器内 `workspace-agent` 提供这些 UDS，经一条**反向 RPC 进程流**转给 WH | 现有请求/应答协议不变，只换端点 |
| Gateway 读 `/proc` 得化身；Git broker 读 `/proc` 树 | `workspace-agent` 在容器内计算并签名上报；Git peer 校验在容器内完成 | `observeNativeExecutionProcess`、`readGitProcess` 原样搬进容器 |
| 化身来自 `bootId+pid+startTicks` 与 `hands-incarnation` 探测 | `{environmentInstanceId, agentIncarnation, leaseEpoch}`；environment 实例来自 provider receipt | E2B `onCreated` receipt（providers.ts） |
| `CODEX_HOME=$DATA/codex/runtime`，共享 `$DATA` | 工作区私有卷：`/workspace` 之外的 `/var/lib/opencraft-workspace/{codex,pi,agent}` | `PersistentWorkspaceProvider.privateVolumeId` |
| broker 任一进程传输失败即回收整个环境 | **attached** 进程（中继）断开只结束该进程与该连接；Brain 不随 WH 断开而死 | **第 4a 步已实现**：`SandboxCommand.attached` |
| 端口只有 `create`；Gateway 重启后无法重连已存在实例（E2B "never resumes"） | 可选能力 `attach(receipt)`：按已登记 receipt 重连同一实例，不重建 | E2B `Sandbox.connect`；Docker 按容器 ID；静态 provider 天然可重连 |
| 每 backend 一个 `templateId` | 每工作区记录 `{provider, image}`，create 时携带 | 原 Router 的"按 Thread 固定版本"语义 |

#### 3.3.3 设计

```
 Gateway 进程（或独立 workspace-host 服务）
 ┌──────────────────────────────────────────────────────────────┐
 │ WorkspaceHost(ws-A)  ── Host 状态库／恢复／定时器（第 2–3 步）  │
 │   └─ WorkspaceRuntime  ── 只依赖 SandboxEnvironment            │
 │        ├─ endpoint("codex-control") → 私有本地 UDS → CodexCoreControlClient
 │        ├─ endpoint("codex-native")  → 私有本地 UDS → CodexCoreSocket(+lane)
 │        ├─ endpoint("pi"|"dsh")      → 私有本地 UDS → engine/dsh client
 │        ├─ terminal / files / browser                           │
 │        └─ reverse RPC 进程 ← 授权／session-cap／Git／任务目录请求
 └───────────────┬──────────────────────────────────────────────┘
                 │ SandboxBackend（部署装配选择，WH 不 import vendor）
     ┌───────────┼───────────────┬──────────────────┐
  static-docker  docker-provisioner  e2b            cloudflare（后续）
                 │ 每个"进程"＝一条 broker 流（stdin/stdout）
 工作区容器（镜像按 digest 固定；无长期凭据；工作区私有卷）
 ┌──────────────────────────────────────────────────────────────┐
 │ workspace-agent（容器入口，常驻 supervisor，不是 WH 的子进程）   │
 │   ├─ codex-app-server owner ─UDS─ codex app-server（CODEX_HOME 在私有卷）
 │   │     └─ sandbox runner：容器内 spawn exec-server --listen stdio
 │   ├─ engine-host(Pi)、dsh-host（监听容器私有 UDS）              │
 │   ├─ 终端会话 owner（持有 PTY）／文件／浏览器 owner（可选）      │
 │   └─ 反向端点 UDS：authority、session-cap MCP、git-broker、任务目录
 │ relay（python 中继，按需 spawn，attached，生命周期＝一条连接）   │
 └──────────────────────────────────────────────────────────────┘
```

**最小新抽象（三个）：**

1. **`openSandboxEndpoint(environment, {target})`**（`@opencraft/sandbox/endpoint`，无 Node 类型）：spawn 固定中继程序（`attached: true`），返回字节双工 `{write, end, close, closed}`。Node 侧 `createSandboxEndpointListener`（`@opencraft/sandbox-node/endpoint-listener`）把每条本地连接变成一条端点连接，监听在私有 0700 目录中的 UDS，使 `CodexCoreSocket`、`CodexCoreControlClient`、engine/dsh client 不改代码。**每条连接＝一个沙盒进程**：多路复用、断开都由 provider 的进程流承担。第 4a 步的 target 是调用方校验过的容器内 UDS 路径；第 4b 步起改为名称，名称→容器内 socket 的映射由镜像内 `workspace-agent` 固定，不接受任意路径。浏览器中继已迁移（§7 第 4a 步）。
2. **`workspace-agent`**：现 host.mjs 去掉 `$DATA` 共享与描述符发布后的容器入口。职责：启动／监督 Brain 进程与 AppServer 替换、持有终端 PTY（§8.3 决定 2）、在容器内计算化身与 Git peer 校验、提供反向端点。对外只有 `control` 端点（health、incarnation、引擎清单、drain）与命名端点。它**由 provider 作为容器主进程启动**，不是某条 broker 流的子进程，所以 WH／Gateway 重启不杀 Brain。任一关键子进程失败即整体退出（§8.3 决定 3）。
3. **`SandboxBackend` 两个可选能力**：`attach(receipt) → SandboxEnvironment`（重连既有实例；无法证明同一实例即失败，不重建）与 create 参数中的 `image`（取代 backend 级 `templateId`）。`attached` 进程语义已在第 4a 步加入：该进程传输失败或终止未确认只结束它自己，不回收环境；默认仍是严格语义。

**反向方向**不新建监听：WH 在连接建立后 spawn 一个长寿 `reverse` 进程（attached），容器内反向端点的每个请求作为一行 JSON 写到它的 stdout，WH 处理后写回 stdin。只承载今天已有的请求/应答协议（授权策略、session capability、Git broker、任务目录），都是小报文；断开时容器内调用方得到"不可用"，与今天 socket 不可达一致，不重放。**模型流量不走 sandbox stdio**（§8.3 决定 1，§5）。

**WorkspaceHost 如何使用：**

```
open(ws): rec = 读 WH 持久记录 {provider, image, receipt?, leaseEpoch}
  env = receipt ? backend.attach(receipt) : backend.create(identity, resources, {image})
  提交 receipt、leaseEpoch+1（先持久化再接纳）
  ctl = openEndpoint(env, "control"); 校验 {agentIncarnation, environmentInstanceId}
  化身不同于上次登记 → 走中断恢复；相同 → 续接
  按需 openEndpoint("codex-native" | "pi" | ...)，交给现有 adapter
close/idle: drain → env.close()（删除实例；卷保留由 PersistentWorkspaceProvider 管）
```

执行租约身份＝`[environmentInstanceId, agentIncarnation, 原生进程化身(容器内计算)]`，不再读宿主 `/proc`。旧格式租约按 §3.4 规则失效。

**不重放未确认输入。** 端点连接不做重传。每个变更请求带现有幂等身份（`inputId`、`clientUserMessageId`、callback id）；连接断开时，未收到确认的变更在 WH 侧标记为 unconfirmed，重连后由所有者查询原生状态对账（沿用[中断 Turn 恢复](../execution/interrupted-turn-recovery.md)与 callback lane 15 s 断开窗口语义），而不是重发。只读请求可在重连后由调用方重新发起。

#### 3.3.4 provider 只是配置

| provider | create | 每进程流 | attach | 持久卷 | Gateway 需要 Docker socket |
| --- | --- | --- | --- | --- | --- |
| `static-docker`（默认单工作区） | 不创建：Compose 声明的 `workspace` 容器，`workspace-agent` 在私有 UDS 上提供 broker（`hands-unix` 握手＋broker 帧，去掉固定向量，改为镜像内命令白名单） | UDS 连接 | 天然 | bind mount | 否 |
| `docker-provisioner`（多工作区，首选，§8.3 决定 5） | 独立 provisioner 服务持 socket，只接受 WH 签名请求；`docker run` 带 `--cpus/--memory/--pids-limit`、工作区卷、私有 bridge 网络 | `docker exec -i` 的 hijacked stream | 按容器 ID | named volume | 否（socket 只在 provisioner；其授权边界单独设计） |
| `e2b`（其次） | 现有 backend，template＝工作区镜像 | `commands.run(stdin)` | `Sandbox.connect`（新增） | 现有 privateVolume | 否 |
| `cloudflare`（后续） | Container 由 WH DO 持有 | `container.exec` stdin（PoC 项，cloudflare-deployment.md §4） | DO 内天然 | R2/快照（PoC） | 不适用 |

部署装配只写一份：`{backend, options, image, resources}`。Electron／本机 Host 不经过本设计。

**镜像固定（Generation Router 的后继）。** 工作区记录持有 `image`（digest）。升级＝改部署默认镜像：新工作区（默认每 Thread 专属＝新 Thread）用新镜像；已存在工作区保持旧镜像直到空闲回收或显式迁移（迁移＝drain 后以新镜像 create、同一卷、走恢复）。不需要 registry、路由库或多 `CODEX_HOME` 并存于一个进程。`static-docker` 只有一个镜像，升级规则保持 README 现状（先等待活动任务）。

#### 3.3.5 风险（如实）

1. **吞吐与编码。** broker 对 stdout 每块做 base64＋JSON（约 1.4×，单行上限 512 KiB）；E2B 每条流还过一层 gRPC。原生 AppServer 的历史读取、大 diff、截图会受影响。缓解：读路径已有 `CodexCoreReadIsolation`；必要时 broker 加二进制帧版本。模型流量不走 broker（决定 1）。
2. **连接数＝进程数。** 每个 callback lane、每次文件操作都是一个沙盒进程。第 4a 步之后的测量（§7）显示 `docker exec` 每进程约 115 ms：文件操作改为常驻进程；E2B 未测。
3. **浏览器媒体。** CDP 截屏／录屏帧经 stdio 中继可能成为瓶颈。浏览器为可选组件、不在第一里程碑（决定 4）；若不满足，浏览器保留独立 provider 端口（屏幕流）而不是硬塞进 broker。
4. **端点无输出流控。** 沙盒进程契约只有输出回调，没有暂停；本地监听对未被读走的输出设上限，超限关闭该连接（fail closed，不无界缓冲）。主机→容器方向逐块等待 provider 写入，形成真实背压。
5. **合并后的隔离。** 去掉 `hands-unix` 固定向量后，Brain 与执行代码同一信任域；靠不同 UID（cloudflare-deployment.md §2.2）与"容器内无长期凭据"（决定 6）保证。
6. **重启语义。** `attach` 只能在 receipt 可证明同一实例时成功；未知即视为丢失并恢复，不得重建后假装续接。Docker 主机重启后 named volume 仍在但实例是新的——这是"化身变化"，不是续接。

**不做：** 不自建 `WorkspaceLink` 帧多路复用协议；不把原生 `codex app-server` 改成 stdio，不改 Codex、exec-server 协议；不让 Gateway 获得 Docker socket；不按操作系统隐式选择 provider，provider 失败不回退本机；不保留 `$DATA/run` 描述符作为并行兼容通道；本阶段不做 Cloudflare 适配或 provisioner 弹性调度。

### 3.4 去除 `pid: host`

跨容器 `/proc` 读取的用途与替代（第 5a 步）：

| 用途 | 现状 | 替代 |
| --- | --- | --- |
| Codex 原生进程化身 | Gateway 用 `health.codexPid` 读 `/proc`（native-execution-origin.ts:32-54） | 容器内 `workspace-agent` 计算并经 `control` 端点签名上报；WH 以 `[environmentInstanceId, agentIncarnation, 原生化身]` 作为执行租约身份 |
| Pi/DSH 执行化身 | headless-application.mjs:885-894 | 同上，由 engine-host／dsh-host 在容器内计算 |
| AppServer runtime 锁的 `/proc` 扫描 | 扫描全部进程（codex-writer-lock.ts:21-40） | 不变，但只需容器自身 PID 命名空间，因为 `CODEX_HOME` 已是容器私有 |
| Git 身份来源 | Gateway 读 `/proc/<pid>/cmdline`、children、exe（git-identity-origin.ts:24-62） | `readGitProcess` 校验移入容器内 `workspace-agent`，结果经反向端点交给 WH；WH 签发单次、短期、按仓库限定的 Git 凭据（决定 6）。不得用"信任容器自报"降低现有校验强度：校验代码与今天相同，只是在容器 PID 命名空间内运行 |

`workspace-agent` 的化身随其进程启动生成（随机 128 位，并携带容器内 boot 与进程出生证据摘要）；`leaseEpoch` 由 WH 在持久状态中单调递增并在每次接纳新化身时提交。容器拒绝 epoch 落后的连接；WH 拒绝化身未登记的容器。化身字符串格式会变化（今天是 `["process", bootId, pid, startTicks]`），所以已持久化的执行租约与 Git 来源租约在切换时视为旧化身：按现有规则失效并走恢复，不做格式转换。

### 3.5 Generation Router（已删除）

Generation Router 只在 systemd 完整发布装配中运行，用于 Codex 引擎不中断升级（多版本 AppServer 并行、registry 记录 Thread 所属版本、旧版本完成后退役）。用户确认该装配已无部署使用（2026-11-22），Router 与其 systemd 装配已删除。

后继：WorkspaceHost 固定工作区容器的镜像版本，升级时新 Thread 使用新镜像，旧容器完成当前 Turn 后退役；在"每 Thread 专属工作区"默认策略下与 Router 的 Thread 级版本固定等价。该能力实现前，Docker 升级 Brain 的现有规则不变（先等待活动任务完成，见 deploy/docker/README.md）。

### 3.6 部署形态统一建模

所有部署形态共用**一个**模型：同一组角色与端口，部署形态之间只换适配器。规则：

- 每个新抽象必须在**至少两种**部署形态中有真实用途，其中至少一种基于 Node；不添加只有 Cloudflare 需要的东西。
- 领域代码中不出现"如果是 Cloudflare／Docker／Electron"分支；差异只存在于装配根（composition root）对适配器的选择。
- 同一端口的每个适配器通过同一套一致性测试（存储端口见[存储端口](storage-ports.md)；沙盒端口与端点见 tests/execution/sandbox-endpoint-conformance.test.ts）。

| 角色／端口 | Electron 桌面 | Docker 单机（`static-docker`） | Docker 多工作区（`docker-provisioner`） | E2B | Cloudflare |
| --- | --- | --- | --- | --- | --- |
| InstallationCore | 不拆分：daemon 内本机 owner（`opencraft-server.sqlite`） | `gateway` 内服务器核心 owner（已实现） | 同左 | 同 Docker（E2B 只承载工作区） | 每部署一个 DO（原型，见 cloudflare-deployment.md §5；未接入部署） |
| AccountCore | daemon 内账号 owner（本机，凭据在本机） | split core，`proxy` 服务（第 1 步，部分实现：模式存在，未成为默认） | 同左，容器经私有网络到达 | 同左，经公网／隧道到达（未实现） | 每部署一个 DO＋边缘出口（设计） |
| WorkspaceHost | `apps/opencraft-daemon/src/workspace-host.ts` 装配 `default`（已实现） | Gateway 内装配 `default`（已实现，第 2–3 步） | Gateway 内每工作区一个（未实现，第 7 步） | 同左（未实现） | 每工作区一个 DO（设计） |
| 工作区容器／provider | 无：本机 Host 直接执行（可选 `linux-systemd` 资源域）；不经过放置设计 | `static-docker`（未实现，第 4c 步；今天是 Compose `brain`＋`hands`，各运行一个 `workspace-agent`，第 4b 步） | `docker-provisioner`（未实现，第 7 步） | `e2b` backend（已实现，承载 Hands；承载 Brain＋`attach` 未实现） | `cloudflare` Container backend（设计，PoC 项） |
| 存储端口（SQL／State／Blob／Secret） | Node 适配器（`nodeSqlDatabase`、`fileStateDocumentStore` 等，已实现） | 同左（已实现） | 同左（已实现） | WH 侧同 Docker；容器内只有工作区卷 | `@opencraft/storage-cloudflare`（workerd 一致性测试通过，未接入部署） |
| 唤醒端口 `OwnerWakeTimer` | `boundedWakeTimer`（已实现） | 同左（已实现） | 同左（已实现） | 同左（WH 侧） | DO alarm（未实现） |
| 端点 `openSandboxEndpoint`＋`attached` | 不使用（本机 owner 直接连接本机 socket） | 浏览器中继已使用（经 Hands／E2B 环境的 `spawn`，第 4a 步）；Brain 端点第 4c 步 | 同 `static-docker`，经 `docker exec -i` 流（未实现） | 浏览器中继已使用（broker `attached`，已实现；真实 E2B 冒烟未运行） | `container.exec` stdin 适配（设计） |
| 本地端点监听 `createSandboxEndpointListener` | 不使用 | Gateway 内（已实现组件，第 4c 步接入） | 同左 | 同左 | 不适用：DO 直接持有端点连接，不需要本地 socket |
| 容器入口 `workspace-agent`＋命名端点 | 不使用（本机 owner 直接监督） | `brain`、`hands` 容器入口（已实现，第 4b 步；角色是装配） | 同一入口作为 provisioned 容器主进程（未实现） | 同一入口作为模板主进程（未实现；浏览器 owner 暂用 `{unix}` 目标） | Container 主进程（设计） |

## 4. Codex Host 状态拆分

### 4.1 归属

| 数据 | 目标 | 端口 | 说明 |
| --- | --- | --- | --- |
| `codex_host_queue` | WH | SQL | 每线程队列，只与本工作区原生线程交互 |
| `thread-creations.sqlite` | WH | SQL | 暂定线程只在创建所在工作区有意义 |
| `interrupted-turn-recovery.sqlite` | WH | SQL | 恢复 owner 必须与发出 `turn/start` 的 owner 相同 |
| `conversation-schedules.sqlite` | WH | SQL＋owner 定时器 | 见 4.3 |
| `codex_thread_catalog`、`codex_catalog_sync` | WH 持有真源；IC 持有跨工作区列表投影 | SQL | 侧栏"全部会话"需要跨工作区列表，投影可重建，不授予写权 |
| `message_senders`、`message_sender_origins`、`ioa_*`、`codex_bot_*` | 待定 | SQL | 与主体协作、Bot 房间相关；若 Bot 跨工作区，应进入 IC，否则留 WH |
| `token-usage.sqlite` | 待定 | SQL | 4.2 |
| `tasks.sqlite` | IC | SQL | 跨会话业务记录 |

WorkspaceHost 的 SQL 库是**一个**按工作区的库，合并今天分散的 `opencraft-host-state`、`thread-creations`、`interrupted-turn-recovery`、`conversation-schedules`（各自迁移账本保留为同库内的独立 schema id，或在合并迁移中显式导入；不能改写已发布迁移）。这让 DO 上一个 DO 对应一个 SQL 库成立。合并与否也可以推迟：第 2 步只要求"按工作区根目录"，不要求合库。

**第 2 步现状（2026-11-22）。** 生命周期核心在 `@opencraft/workspace-host`（packages/workspace-host/src/index.ts）：显式 `WorkspaceIdentity {id, root}`、可选锁端口、按登记顺序打开、失败按逆序回收并释放锁、两阶段关闭（`drain()` 逆序停止 `dispatch` owner 并等待其在途工作；`close()` 逆序关闭 `state` 存储后最后释放锁；单步失败不阻止后续关闭）、同一运行时内同一 root 只允许一个 owner。该包不依赖 Node（`types: []`），供日后每工作区 DO 复用。Node 装配在 apps/opencraft-daemon/src/workspace-host.ts：`openCodexWorkspaceHost` 以显式根打开 overlays 锁（仅在独立 core 之后）→ Host 状态库 → 暂定线程 →（执行租约挂起）→ queue（含内嵌模式旧原生队列一次性导入）→ 定时任务 → 中断恢复 → provider 重试；各 SQLite owner、文件名、迁移与线程位置不变，未改 schema。`CodexEngineAdapter` 只提供端口并消费 `stores`（codex-engine-adapter.ts:870），关闭时先 `drain()`（:2036），在 Thread 操作结算、token usage／附件／任务关闭后再 `close()`（:2084）。Gateway（headless-application.mjs:1101）与桌面 daemon（apps/opencraft-daemon/src/main.ts:163）各装配一个 `default`，根为今天的 `$DATA/codex`／`codexDataDirectory`，无数据迁移。

仍留在 adapter、未进入 WorkspaceHost 的：`token-usage.sqlite`（§4.2 待定）、`tasks.sqlite`（IC）、消息附件 `opencraft-message-attachments`、置顶／标题／thread identity、转录缓存、会话 MCP、维护准入；账号池与内嵌模式的组合 writer 锁（AC）；SSH 远程 Host 的本地 Host 状态镜像（`attachmentHistoryDirectory`，非本机工作区）。Host 状态库内 senders／Bot／IOA 表（上表"待定"）随整库由 WH 打开，归属未改。WorkspaceHost 的 SQLite 仍在 Gateway 主线程同步打开（存量，登记于 `config/main-thread-sync-io.json`）；改为 Worker 承载属方案 A 的后续工作，不在本步。

**SQL 端口现状（2026-11-23）。** WH 各存储的领域代码改为只依赖 `@opencraft/sql` 的 `SqlDatabase`，Node owner 仍用 `openManagedDatabase` 打开原文件并借出 `nodeSqlDatabase(connection)`；手写 `BEGIN`／`COMMIT`／`SAVEPOINT` 改为 `transaction()`（嵌套为 savepoint），已发布迁移、checksum、文件名与线程位置不变。清单：`SqlConversationSchedules`（Node 子类 `ConversationSchedules`）、`SqlInterruptedTurnRecovery`／`SqlProviderTurnRetry`（`InterruptedTurnRecovery`／`ProviderTurnRetry`）、`SqlProvisionalThreads`（`ProvisionalThreads`）借出 `ScopedSqlDatabase`；Host 状态库 `OpenCraftHostStateDatabase` 新增 `sql` 端口，`transaction()` 委托该端口，`SqlHostQueue`（Node 子类 `OpenCraftHostQueue` 保留自开库与旧原生队列一次性导入）、`InputDeliveryStore`、`ExecutionLeaseReader/Store`、`OpenCraftMessageSenders` 借用该端口（仍传 node 连接的 Hub thread-identity 库与测试在借用方边界经 `sqlPort()` 适配）。执行租约的启动时钟改为注入端口 `ExecutionBootClock`（Node 默认读 `/proc`）。tests/storage/workspace-host-sql-port.test.ts 在 `nodeSqlDatabase(:memory:)` 上以已发布迁移验证账本、schema 与 Node owner 文件一致并跑各存储关键操作；tests/storage/workspace-host-workerd.test.ts 在 Miniflare DO SQL 上原样执行五条迁移链（含 v13 改名、v17 重建队列与外键），重启保留账本、旧对象升级、篡改 checksum 拒绝，领域操作结果与 Node 逐项相同。DO 仍缺：五个存储各有一份 `schema_migrations`，同一 DO 库只能承载其一，需 §4.1 合库迁移（账本按 schema id 区分或显式导入）；`codex_thread_catalog` 的 `ThreadDirectory`（app-host-server）仍依赖 `DatabaseSync.location()`、`worker_threads` 快照读取与 read guard；中断恢复与 provider 重试仍用进程内 `setTimeout`，未接唤醒端口（DO 需 alarm）；执行租约启动时钟需由容器 `control` 端点提供（§3.4）；IOA 元数据工厂 `createThreadMetadata` 与 token usage 仍收 `DatabaseSync`；Node owner 的文件、writer 租约、旧库接纳与原生队列导入保持 Node 专属。

### 4.2 Token usage

今天 Gateway 记录 Codex 用量并提供查询（codex-engine-adapter.ts:992-1024）。用量属于计量与策略，最终消费者是 AC（配额）与管理界面（跨工作区汇总）。建议：WH 只记录本工作区的原始用量事件并可靠转交；AC 持有汇总账本。需要确认现有查询 Worker 的语义是否允许"事件先在 WH 落库、再异步转交"的延迟（8.2 节问题 7）。

### 4.3 定时任务

`ConversationSchedules` 原先每 2 s 轮询。拆分后改为 owner 驱动：WH 在提交计划后计算"下一个到期时间"，Node 上设置单个 owner 定时器（Worker 内），DO 上设置 alarm。轮询语义不变：到期判断仍以持久状态为准，定时器只是唤醒。Gateway 不在线（方案 B）或 WH 重启后，启动时先按持久状态补齐过期计划，不依赖定时器连续性。

**第 3 步现状（2026-11-22）。** 唤醒端口由 `@opencraft/workspace-host` 持有：`OwnerWakeTimer { arm(at), cancel() }`（`at` 为 owner 时钟的绝对时间，回调不早于该时刻；`arm` 替换上一次）与 `OwnerWakeTimerFactory`。Node 实现 `boundedWakeTimer(timeoutWakeClock(now), wake)`：每段相对延迟不超过 `MAX_WAKE_DELAY_MS`（60 s），到点重读墙钟，未到目标就续段——时钟回拨不会提前唤醒，前拨最迟一段内发现，远期目标不触及平台定时器上限；DO 将来以 alarm 实现同一端口。`ConversationSchedules` 在 `start()` 后不再轮询：每次提交的计划变更（save／action／suspend）与每次推进结束（含 flight 结算）都从持久状态（叠加内存中已有的重试退避）计算最早可推进时间并重新 arm；无待办时 cancel。唤醒只触发一次推进，是否到期仍在推进时读持久状态判断，过时或提前的唤醒不派发任何工作。`start()` 先按持久状态补齐过期与未完成的 occurrence（再次调用即再补齐一次，供 admission 重开／引擎重新 initialize）；`close()` 先 cancel 唤醒，再等待在途推进与 flight。admission 被 fence 时没有重开通知，若已有到期工作则按原 2 s 节奏复查而不派发，无到期工作则只在计划时间唤醒。持久 schema、occurrence ID 与并发 4 个 flight 上限不变。WH 装配经 `CodexWorkspaceHostOptions.scheduleWakeTimer` 注入（默认 Node 实现），`drain()` 关闭 schedules 时即取消唤醒。Pi 引擎（plugins/pi-engine）与 local-agent-host（DSH）共用同一 `ConversationSchedules`，以默认 Node 唤醒同样转为 owner 驱动；二者的 `resumeBackground()` 已调用 `start()`，即 admission 重开时的补齐入口，无需另改。测试见 tests/chat/conversation-schedule-wake.test.ts 与 tests/execution/workspace-host.test.ts。

### 4.4 恢复所有权

- Codex：恢复从 Gateway 的单一 `CodexEngineAdapter` 移到每个 WH（今天 execution-ownership.md 记录"Codex Host 恢复在 Gateway"）。容器化身变化即"执行进程重启"证据。
- Pi／DSH：仍在容器内（引擎 owner 持有 `interrupted-turn-recovery.sqlite`），不变。
- 通道断开**不是**执行丢失证据（与现有规则一致）：WH 先经 `control` 端点读取同一化身状态，只有化身变化或确认销毁才进入恢复。

## 5. 账号与凭据

**边界。** AC 唯一持有：账号池、加密凭据、OAuth 刷新、选号与亲和、计量与策略、用户配置的 provider 密钥。工作区容器内不出现任何长期凭据文件。

**现状与目标的差距（需如实承认）：**

- 内嵌代理模式（默认）下，Pi、DSH 直接从 `$DATA/models/credentials.json` 解析 provider 密钥（engine-host.mjs:90；dsh-host 的 `modelStorageDirectory`）。
- `proxy` 模式下也只有"显式 `baseUrl` 且协议为 `anthropic-messages`／`openai-responses`"的 provider 经代理；目录默认端点、人类订阅与其他协议仍直连并需要真实凭据（model-config/service.ts:28-32）。
- 代理调用者令牌按调用者**类型**而非工作区签发，且不过期（codex-account-service.ts:163-173）；`baseUrl` 被校验为 `127.0.0.1`，依赖 host 网络（service.ts:18）。

**目标路径：**

1. **模型流量不经 sandbox stdio**（§8.3 决定 1）：容器经网络（Docker 上为私有 bridge 网络）直接到达 AC 代理，只持有短期调用令牌；不经 WH 中转、不占用端点连接。Codex 已经通过 `chatgpt_base_url` 走代理（app-server.ts:107-109），Pi/DSH 复用现有 `proxyProjection`，只把 `baseUrl` 从 `127.0.0.1` 改为该网络地址（这同时去掉 `network_mode: host` 依赖）。
2. AC 为每个 `{workspaceId, engine, containerIncarnation}` 签发**短期**调用租约；WH 负责续期，化身变化或工作区停用即撤销。代理按租约做配额与计量。
3. 要把"所有 provider 都经代理"作为前置条件：补齐目录默认端点与其他协议的代理转发，或在工作区模式下明确拒绝这些 provider。不能保留直连而宣称容器无凭据。
4. 人类订阅／个人登录（`personal-logins/`）留在 AC；容器只得到代理租约。
5. 同一模型在各部署形态下只换 AC 代理的到达地址与适配器（§3.6）：Node 上 AC 自己转发；Cloudflare 上容器出站由边缘 Worker 处理，Worker 向 AC DO 取短期凭据后直连 provider（cloudflare-deployment.md §2.1）。领域代码不区分部署形态。

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
| 2 | 抽出 `WorkspaceHost` 模块：把 `CodexEngineAdapter` 的 overlays（§4.1 WH 行）改为通过存储端口、以显式工作区根打开；Gateway 只装配 `default` | 所有权显式化；为 DO 准备 | 现有 host-state、恢复、定时任务、队列测试在新入口下全部通过；`check:boundaries` 计数不增。**已实现（2026-11-22，见 §4.1 第 2 步现状）**：WH 存储仍由 Node SQLite owner 打开，领域代码已换成 `SqlDatabase` 端口并在 workerd DO SQL 上验证迁移与操作（2026-11-23，见 §4.1 SQL 端口现状）；多根只在测试中验证，生产仍只装配 `default` |
| 3 | 定时任务改为 owner 驱动定时器 | 去除 2 s 轮询 | 到期、重启补齐、时钟回拨、关闭排空测试。**已实现（2026-11-22，见 §4.3 第 3 步现状）**：Node 唤醒仍在 Gateway 主线程（与第 2 步同），尚未移入 Worker；DO alarm 实现待 DO 装配 |
| 4a | 抽出 `openSandboxEndpoint`＋`attached` 进程语义；浏览器中继改用它。无部署变化 | 通用"经 stdio 到达容器内 socket"原语；中继断开不再回收整个环境 | 契约一致性测试（任一 backend 必须通过）：二进制往返、EOF、背压、两端关闭、attached 失败只关该连接、非 attached 仍回收环境；浏览器测试不变通过。**已实现（2026-11-23）**，见下文"第 4a 步现状"；E2B 真实冒烟未运行 |
| 门禁 | **测量**：每连接／每文件操作 spawn 沙盒进程的延迟与并发，按 provider 分别测量 | 决定第 4b 步的端点粒度 | 第 4b 步开始前必须有目标 provider 的数据；若代价过高，文件操作改为容器内常驻进程（一条 attached 进程承载多个请求）。本地数据见下文；E2B、Cloudflare 未测量 |
| 4b | `workspace-agent`：host.mjs 改为在容器私有 run 目录发布 UDS（不写 `$DATA/run`），引擎 host 改听 UDS；提供 `control` 与命名端点（名称白名单）；持有终端 PTY；关键子进程失败即整体退出；仍跑在现 `brain` 容器 | 端点到达方式与部署无关 | 现有容器冒烟（scripts/smoke/server/smoke-container.mjs）不变通过；端点名白名单拒绝任意路径；WH 断开后 PTY 仍在。**已实现（2026-11-23）**，见下文"第 4b 步现状"；"引擎 host 改听 UDS"移入第 4c 步 |
| 4c | `static-docker` provider：`workspace-agent` 在私有挂载 UDS 上服务 broker；Pi/DSH 改听容器私有 UDS 并登记端点 `pi`/`dsh`；Gateway 的 `default` WH 改经该 provider＋命名端点访问 codex-control/native、Pi、DSH、terminal、files、browser，删除描述符读取（gateway-application.mjs:14-17、34-43） | 去掉私有描述符与 loopback 依赖 | 真实 Docker：Gateway 重建后续接同一化身；断开时未确认变更不重发（held-promise＋丢 ack）；callback lane 15 s 窗口语义不变 |
| 4d | 反向 RPC 进程：授权 socket、session-capability MCP、任务目录改经它；签名密钥留 WH，容器只拿短期 token | 容器不再连 Gateway loopback | 撤销授权后容器内请求被拒；WH 断开期间请求失败而非排队 |
| 5a | 化身与 Git peer 校验移入 `workspace-agent`，经 `control` 签名上报；删除 Gateway 的 `/proc` 读取；Git 凭据改为单次／短期、按仓库限定 | 删除 `pid: host` 依赖 | PID 重用测试；Git 来源租约在新格式下通过、旧格式失效走恢复；容器内无长期 Git 凭据 |
| 5b | 合并 `hands` 进 `brain` 为单个 `workspace` 容器；AppServer 容器内直接 spawn exec-server；删除 `hands-unix` 固定向量路径与 `pid: host`、`network_mode: host`（先 Brain＋Hands，浏览器可选、不在本里程碑） | 一个工作区一个容器 | 真实 Docker：去掉两项后执行租约、Git、恢复、终端冒烟；`/proc` 不可见检查；模型请求经私有网络到 AC 代理 |
| 5c | `CODEX_HOME`、Pi、DSH 数据移到工作区私有卷（与第 6 步冷迁移合并执行） | 共享 `$DATA` 不再被 Brain 写入 | 从上一版本数据目录升级、中途 kill 重跑、回退演练 |
| 6 | 冷迁移到 `$DATA/workspaces/default/` | 共享 `$DATA` 不再被 Brain 写入 | 从上一版本真实数据目录升级、中途 kill 后重跑、回退演练 |
| 7 | 多工作区：实现 `docker-provisioner`（其 Docker socket 授权作为独立服务边界设计），其次以 `e2b` 承载工作区镜像＋`attach`；WH 代码不变 | 一工作区一 Brain | 两个工作区并发 Turn、一方容器重启不影响另一方、凭据不可见检查、容量准入 |
| 8 | 跨工作区会话列表投影与 token usage 转交 | 侧栏与计量跨工作区正确 | 投影重建、转交延迟与重复 |

第 5 阶段（Cloudflare 适配器）只在第 2–4d 步完成后开始。

**第 4a 步现状（2026-11-23）。** 契约：`SandboxCommand.attached?: true`（仅 pipe 进程；由 `createSandbox` 校验并原样交给 backend）。共享 broker 对 attached 进程的传输丢失、启动失败与终止未确认只结束该进程（`exited` 拒绝；`terminate()` 以 `SANDBOX_CLEANUP` 拒绝），不调用 `closeEnvironment()`；guest 侧 broker 在控制流结束时自行 kill 进程组，环境关闭回收残留；`attached` 不发送给 guest。非 attached 进程保持原有 fail-closed 语义。`@opencraft/sandbox/endpoint` 的 `openSandboxEndpoint(environment, {target: {unix}, onData, python?, cwd?})` spawn 固定 Python 中继（非阻塞 socket 写、1 MiB 待发上限、stdin EOF→`SHUT_WR`、目标 EOF→退出 0），返回 `{write, end, close, closed: "ended"|"failed"}`；路径须为绝对、无 `.`/`..` 段、≤107 字节。`@opencraft/sandbox-node/endpoint-listener` 的 `createSandboxEndpointListener` 在私有 0700 目录中监听 UDS，每条本地连接＝一条端点连接：每连接先 `authorize()`，本地→沙盒逐块等待 provider（背压），沙盒→本地超过 `maxBufferedBytes`（默认 8 MiB）关闭该连接，连接数上限默认 32，终止未确认上报 `onCleanupUnconfirmed` 并使 `close()` 拒绝；尚未接入任何生产装配。浏览器 `connectSandboxBrowserOwner` 改用 `openSandboxEndpoint`（同一解释器、`/workspace` cwd、帧与授权逻辑不变），删除私有中继副本；中继死亡不再回收整个 E2B 环境。一致性测试 tests/execution/sandbox-endpoint-conformance.test.ts 对 in-process、本地子进程、E2B 适配器＋共享 broker（vendor SDK 以本地进程替代）三个 harness 运行同一组断言；设置 `OPENCRAFT_SANDBOX_CONFORMANCE_DOCKER=<含 python3 的镜像>` 时追加真实 `docker exec -i`＋broker harness（本机 `python:3.12-alpine` 通过）。未做：真实 E2B 冒烟；Cloudflare 无实现。

**测量门禁数据（2026-11-23，4 vCPU 云开发容器，cgroup v1 Docker 29.10；每项先预热 3 次）。** "端点"＝`openSandboxEndpoint`＋1 字节回显往返＋关闭；"一次性进程"＝spawn `python3 -I -c pass` 到退出，对应今天每次文件操作一个 helper 的模式。

| harness | 端点 p50／p95 | 一次性进程 p50／p95 | 32 并发端点（全部完成） | 128 并发端点（全部完成） |
| --- | --- | --- | --- | --- |
| in-process（无真实进程，下限参照） | 0.1／0.6 ms | 不适用 | 13 ms | 21 ms |
| 本地子进程（无 broker） | 15／17 ms | 12／15 ms | 154 ms | 598 ms |
| E2B 适配器＋broker，本地进程替代 SDK | 37／39 ms | 35／47 ms | 379 ms | 1381 ms |
| 真实容器：`docker exec -i`＋broker | 116／142 ms | 114／135 ms | 1074 ms | 4596 ms |

所有并发连接均成功。结论（仅就已测 provider）：每条长寿连接一个进程可接受（callback lane 上限 32，冷建立约 1 s）；**每次文件操作一个 `docker exec` 进程（约 115 ms）代价过高**，第 4b 步应让文件操作走容器内常驻进程（一条 attached 连接承载多个请求），终端与浏览器保持每连接一个进程。**真实 E2B（含 gRPC 与网络往返）与 Cloudflare 未测量**；在以它们为目标 provider 之前必须补测，测量方法即上述 harness。

**第 4b 步现状（2026-11-23）。** `workspace-agent`（scripts/container-deployment/workspace-agent.mjs、`-application`、`-supervisor`、`-roles`）取代 host.mjs 与 hands-application 各自的子进程监督，是所有工作区容器的同一入口：通用 supervisor 不含 provider 或角色分支，角色（`brain`、`hands`、`browser`）只是装配。Compose `brain` 运行 `workspace-agent.mjs --role brain`；`hands` 运行 `native-hands.mjs`，即同一 agent 的 `hands`＋`browser` 角色（产品仍可经 `OPENCRAFT_CONTAINER_HANDS_ENTRY` 组合服务）。第 5b 步合并容器时只需一个 agent 选择 `brain`＋`hands` 角色。

- **监督。** 子进程按角色顺序启动并等待就绪（brain：等待 `proxy`→读 Hands 化身→AppServer（独立进程组）→DSH、Pi；hands：exec、terminal、files；browser 可选）。任一关键子进程退出或无法启动即按逆序停止其余子进程（`SIGTERM`，超时 `SIGKILL`），释放锁后以 1 退出；Docker 重启容器＝新化身，恢复交给中断 Turn 恢复，不局部重启（§8.3 决定 3）。Hands 化身变化引起的 AppServer 替换是有意替换，不算失败。
- **化身。** 每次启动生成随机 128 位 id，并带 `sha256(bootId:pid:starttime)` 出生证据；经 `control` 端点上报（`opencraft-health agent` 打印），`opencraft-health brain|hands` 要求 agent `healthy` 且角色匹配。化身尚未进入执行租约身份（第 5a 步）。
- **容器私有 run 目录。** `/run/opencraft-agent`（Compose 为 brain、hands 各挂 tmpfs，镜像内也预建 0700 目录；`OPENCRAFT_AGENT_RUN_DIR` 必须在共享挂载之外，启动时清空）。其中：`control.sock`、`endpoints/<名称>`、Pi/DSH/Codex sandbox 启动配置（此前在 `$DATA/run`）、AppServer 原生 listener `codex/native-internal.sock`（新增 `--private-directory`）。Brain 启动时删除旧版本留在 `$DATA/run` 中的这些文件。
- **命名端点。** `@opencraft/sandbox/endpoint` 定义 `SANDBOX_ENDPOINT_NAMES`（`control`、`codex-control`、`codex-native`、`pi`、`dsh`、`exec`、`terminal`、`files`、`browser`）与 `SANDBOX_ENDPOINT_DIRECTORY`；`openSandboxEndpoint` 接受 `{name}`，中继只连接 `<端点目录>/<名称>`；未列名称、同时给 `name` 与 `unix`、相对端点目录都在 spawn 前以 `SANDBOX_POLICY` 拒绝（一致性测试新增一项，各 harness 通过）。agent 只发布白名单名称，目标由角色固定。`{unix}` 只保留给尚未由 agent 监督的 E2B 浏览器 owner（E2B 承载 agent 后删除）。
- **终端 PTY。** 由 Hands 容器中 agent 监督的 terminal owner 持有：客户端断开或 Gateway 重建不结束 PTY（单测经 `endpoints/terminal` 断开重连仍是同一 shell；容器冒烟在 Gateway 重建后续接）；agent 化身变化结束 PTY。
- **文件常驻进程。** Docker 默认路径本来就是 Hands 中的常驻 files owner（`files.sock`）。经沙盒端口的 `SandboxWorkspaceFiles`（E2B 及后续 provider）改为每个绑定一个 **attached 常驻 helper**：一条 stdio 长连接承载多个请求（按 id 的 JSON 行，helper 8 线程并发，最多 64 个在途），整行按序写入、不交错；进程丢失只使在途请求失败、不重发，下一请求启动新进程；单请求 30 s 超时即退役该进程；绑定关闭时回收。
- **发布与回退。** 服务入口仍是 `container-service.mjs brain|hands`；`compose-release doctor` 额外检查渲染后的 brain、hands 带私有 `/run/opencraft-agent` tmpfs 且未经卷共享。回退到旧镜像不需额外步骤：旧镜像忽略 tmpfs 与变量，并重新在 `$DATA/run` 写配置。`bin/opencraft-host` 改为 `workspace-agent.mjs --role brain`。

**第 4c 步剩余（这些面在 4b 仍经共享目录到达；4b 不另建并行通道）。** Gateway 读 `run/engine-host.json`、`run/dsh-host.json`（Pi/DSH 仍监听 loopback TCP；改听私有 UDS 并登记 `pi`/`dsh` 端点放在 4c，因为在 provider 端点存在前 Gateway 无法到达私有 UDS）、连 `run/native.sock`（端点 `codex-control`、`codex-native` 已登记，目标仍是共享路径）、读 `daemon.token`；`proxy` 经 `run/codex-app-server.sock` 转发 `/native-health`；Gateway 直连 Hands 的 `execution/terminal.sock`、`files.sock`、浏览器 `owner.sock`（端点已登记）；Brain 经 `execution/exec-owner.sock` 到 Hands（第 5b 步合并后消失）。`run/codex-core.sock` 与 `proxy-callers/` 属于 AccountCore，按 §5 改为网络＋短期令牌，不属于 4c。

补充步骤（Generation Router 的后继，排在第 7 步之后）：WorkspaceHost 固定工作区容器镜像版本，升级时新 Thread 使用新镜像、旧容器排空后退役；验收覆盖进行中 Turn 不被中断、未确认输入不重放、故障停止（见 3.5 节）。

## 8. 决定与待决问题

### 8.1 决定一：拆分单位是 Workspace 还是 Thread（已决定：A）

**决定（2026-11-22）：** 采用 A，单位为 Workspace。默认策略为"每 Thread 专属工作区"（与今天普通会话一致）；同一 Project 的协作 Thread 与父子编排 Thread 可选择放入同一工作区。默认策略可由用户后续调整。下文保留决定前的对照。

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
3. ~~Docker 上谁创建工作区容器~~：已决定，见 §8.3 决定 5。
4. **WorkspaceHost 宿主**：Gateway 内（A）或独立服务（B）。
5. **密度与成本。** 每工作区一个 AppServer＋Pi＋DSH＋浏览器的内存基线未测量；默认 4 vCPU／8 GiB 预算是按工作区还是全机共享，需要与 Assets 预算账本统一。空闲工作区是否停容器（冷启动时间待测）。
6. **AppServer 共享还是按工作区。** 一个共享 AppServer 按线程路由到不同 Hands 环境（今天 `resolveWorkspace` 已支持）成本更低，但 `CODEX_HOME` 共享，不满足"工作区隔离 Brain"。是否接受"小部署共享、隔离部署按工作区"两种装配。
7. **Token usage 与 Bot／IOA 表的归属**（§4.1、§4.2）。
8. ~~Brain 与 Hands 是否合并~~：已决定合并为一个工作区容器（§3.2，第 5b 步）。

### 8.3 决定二：放置设计（2026-11-23，用户决定）

1. **模型流量不经 sandbox stdio。** 容器经网络到达账号代理／AccountCore，只持有短期令牌（§5）。
2. **终端 PTY 由 `workspace-agent` 持有**，WorkspaceHost 断开后仍存活；重连只是重新 attach（第 4b 步）。容器化身变化仍结束 PTY。
3. **任一关键子进程失败，`workspace-agent` 整体退出**＝容器化身变化；恢复复用中断 Turn 恢复，不做局部重启监督。
4. **浏览器为可选组件，不在第一里程碑。** 去除 host 网络先针对 Brain＋Hands（第 5b 步）。
5. **多工作区先做 `docker-provisioner`**；它持有 Docker socket 的授权必须作为单独设计的服务边界（Gateway 仍永不持有 socket）。其次 E2B。
6. **边界是"容器内无长期凭据"。** Git 与模型访问得到单次／短期、按范围限定的凭据。

## 9. 与早期调查不一致之处

- `$DATA/codex` 并非只属于 Gateway：同一目录同时是账号 Core 数据根（`account-pool.sqlite`、`.codex-writer.sqlite`）、Brain AppServer runtime 根（`.codex-runtime.sqlite`、`runtime/`＝`CODEX_HOME`）与 Gateway Host overlays 根（host.mjs:122；proxy-core.mjs:13；headless-application.mjs:1099）。三个 owner 以三把不同的锁共存于一个目录，迁移必须逐项区分。
- 模型凭据不只在账号 Core：`$DATA/models/credentials.json` 被 Gateway、Pi、DSH 共同读取；`proxy` 模式也未覆盖所有 provider。
- `pid: host` 的依赖不止执行租约：Gateway 的 Git 身份来源校验也读取 Brain 进程的 `/proc`。
- 15 s 是 Brain 侧 callback lane 的断开窗口（orchestration-callback-lane.ts:374），不是 Gateway 的重连间隔。
- 已存在多 `CODEX_HOME` 机制（Generation Router）与按工作区 Hands 路由（`resolveWorkspace`），本设计应复用其语义而非另造。
