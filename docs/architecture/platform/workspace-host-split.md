# Gateway／Brain 按工作区拆分

[Architecture index](../README.md) · [存储端口](storage-ports.md) · [可选 Cloudflare 部署](cloudflare-deployment.md) · [执行所有权](../execution/execution-ownership.md) · [中断 Turn 恢复](../execution/interrupted-turn-recovery.md) · [Assets 工作区](../execution/workspace-assets.md) · [Docker 三角色部署](../../../deploy/docker/README.md)

状态：**设计；第 2、3、4a、4b、4c 步已实施，第 7a 步的 `sandbox-cloudflare` provider 已实现（WorkspaceHost DO 装配与部署未做），其余为提议。** §3.7 的持久化与空闲契约是已定设计、未实现。 对应[存储端口](storage-ports.md)第 4 阶段。下文"现状"以引用的源码行为准（2026-11 核对）；"目标"与"步骤"中未标注"已实现"的均为提议；§8 记录已定决定与仍待决的问题。Node／Docker 自托管是一等公民：每一步都必须先在 Docker 上独立成立，Cloudflare 只是后续可选装配。

## 1. 目的与范围

目标拓扑（[可选 Cloudflare 部署](cloudflare-deployment.md) §2）要求：

- **部署级 owner**：`AccountCore`（账号池、OAuth 刷新单写者、模型代理、计量）与 `InstallationCore`（服务器核心 SQL、成员与授权、Hub）。
- **每工作区 owner**：`WorkspaceHost`，持有 Codex Host 状态与本工作区容器的生命周期、连接。
- **工作区容器**：Brain（`codex app-server`、Pi、DSH）与 Hands（`exec-server`、终端、文件、浏览器）同处，独立 `CODEX_HOME`；容器内不保存模型或账号凭据。

本页设计 Node 侧所有权拆分与它在 Docker 上的落地，以及所有 provider（含 Cloudflare）必须满足的同一放置、持久化与空闲契约（§3.6、§3.7）；不设计 WorkspaceHost 的 DO 装配（第 5、6 阶段）。不改变已发布迁移、Hands 执行协议或沙盒 provider 契约（第 3 阶段由沙盒重构另行进行）。

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
| 中断恢复／provider 重试 | `interrupted-turn-recovery.sqlite`、`provider-turn-retry.sqlite`＋owner 驱动唤醒（2026-11-23 起不再自持 `setTimeout`，见 §4.3） | gateway（WorkspaceHost） | packages/host-recovery/src/index.ts、provider-retry.ts；workspace-host.ts；端口 codex-engine-adapter.ts:3714、3740 | WH（Node 为 owner 定时器，DO 为 alarm） |
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
2. **多工作区**：`docker-provisioner`（持有 Docker socket 的独立服务，只接受 WorkspaceHost 的签名请求；其授权边界作为单独的服务边界设计，Gateway 仍不持有 socket）与 `sandbox-cloudflare` 是第 7 步的两个实现，按 §7 后续顺序先 `sandbox-cloudflare` 后 `docker-provisioner`；其次 `e2b`（§8.3 决定 5）。

Brain 与 Hands 合并为一个工作区容器（第 5b 步）。合并后 Brain 发布会重启该容器内的浏览器（今天 README:9-14 的"Brain 发布不重启浏览器标签"性质不再保留）；浏览器为可选组件（§8.3 决定 4）。终端 PTY 由 `workspace-agent` 持有，WorkspaceHost 断开不结束 PTY（决定 2），但容器化身变化会结束 PTY。

### 3.3 放置：WorkspaceHost 只持有 `SandboxEnvironment`

Brain 与 Hands 放在哪里**是部署配置**：WorkspaceHost 只依赖[沙盒端口](../execution/execution-sandbox.md)的 `SandboxEnvironment`，provider（`static-docker`／`docker-provisioner`／`e2b`／`cloudflare`）由部署装配选择，差异只剩 provider 配置与镜像。此前设想的自建帧多路复用通道（`WorkspaceLink`，按 lane 信用流控）不再采用：provider 的进程流本身就是多路复用的字节流。已定前提：单位＝Workspace（默认每 Thread 专属，§8.1）；Brain＋Hands 同一容器；容器内无长期凭据（§8.3 决定 6）。

#### 3.3.1 现状：每个组件如何启动、如何被找到（2026-11-23 源码）

第 4b 步之后，`host.mjs` 与 hands-application 的监督已由 `workspace-agent` 取代，启动配置与原生 listener 移入容器私有目录（§7"第 4b 步现状"）；第 4c 步之后 Gateway 只经 `static-docker` provider 与命名端点到达 Brain、Hands（§7"第 4c 步现状"）。下表保留调研时的文件与行号与当时的到达方式。

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
  static-docker  docker-provisioner  e2b            cloudflare（provider 已实现）
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

**地址（第 4c 步）。** 地址只在配置与客户端边界以 URI 出现，进入系统即解析为类型化值（`@opencraft/sandbox/uri`），URI 中不得出现凭据、端口、query、fragment：

- 端点：`workspace://<workspaceId>/endpoints/<name>`，`name` 取自端点白名单（`control`、`codex-control`、`codex-native`、`pi`、`dsh`、`exec`、`terminal`、`files`、`browser`）。Gateway 与客户端只持有它；解析到哪个环境、经哪种传输由 WorkspaceRuntime 与 provider 决定。
- 环境：`<provider>://<target>`，scheme 即已注册 provider id：`static-docker://<Compose 服务>`、`e2b://<模板>`、`docker-provisioner://<镜像别名>`、后续 `cloudflare://<容器类>`。改变部署形态＝改这一个 URI（Docker 单机在 Brain／Hands 合并前是两个：`static-docker://brain static-docker://hands`）。
- 与现有约定对齐：Codex 的 `--listen unix://…`／`stdio://` 是进程监听地址，不是放置地址；`human://`、`session://` 是主体 id；`ws+unix://` 是客户端拨号地址。这些 scheme 被保留，不能注册为 provider。解析测试（往返、拒绝）对所有 provider 共用（tests/execution/sandbox-uri.test.ts）。

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
idle: 按 §3.7.2 判定 → drain →（captured）捕获快照 → backend.sleep(env)；不支持 sleep 即常驻
close: drain →（captured）捕获快照 → env.close()（删除实例；内容真源是 Git，§3.7.1）
```

执行租约身份＝`[environmentInstanceId, agentIncarnation, 原生进程化身(容器内计算)]`，不再读宿主 `/proc`。旧格式租约按 §3.4 规则失效。

**不重放未确认输入。** 端点连接不做重传。每个变更请求带现有幂等身份（`inputId`、`clientUserMessageId`、callback id）；连接断开时，未收到确认的变更在 WH 侧标记为 unconfirmed，重连后由所有者查询原生状态对账（沿用[中断 Turn 恢复](../execution/interrupted-turn-recovery.md)与 callback lane 15 s 断开窗口语义），而不是重发。只读请求可在重连后由调用方重新发起。

#### 3.3.4 provider 只是配置

| provider | create | 每进程流 | attach | 持久卷（缓存，不是真源，§3.7） | Gateway 需要 Docker socket |
| --- | --- | --- | --- | --- | --- |
| `static-docker`（默认单工作区，第 4c 步已实现） | 不创建：绑定 Compose 声明的容器（今天 `brain`、`hands` 两个），`workspace-agent` 在只挂载到该容器与 Gateway 的 link 卷（tmpfs）中提供共享 broker：一次性 ticket 换会话，`relay-only` 策略只放行到白名单端点的固定中继 | 每进程一条 link UDS 连接（broker 帧） | receipt＝agent 化身；只在同一化身时成功 | bind mount | 否 |
| `docker-provisioner`（多工作区，第 7b 步已实现，§8.3 决定 5） | 独立 provisioner 服务持 socket，只接受 Gateway 的签名请求（`ensure`／`inspect`／`stop`／`destroy`），镜像、命令、用户、`--cpus/--memory/--pids-limit`、工作区卷、私有 bridge 网络全部来自服务端策略 | 与 `static-docker` 相同的 link（每工作区一个 links 卷子目录，只挂进该容器与 Gateway；不用 `docker exec`） | receipt＝容器 ID＋agent 化身；容器仍在运行且同一化身才成功 | named volume（缓存） | 否（socket 只在 provisioner；其授权边界单独设计） |
| `e2b`（其次） | 现有 backend，template＝工作区镜像 | `commands.run(stdin)` | `Sandbox.connect`（新增） | 现有 privateVolume | 否 |
| `cloudflare`（provider 已实现，第 7a 步；WH DO 装配未做） | Container 由 WH DO 持有（`ctx.container`），`getByName` 稳定寻址；`start` 带自定义实例（预算映射）与化身标签，再以一次 `exec` 读 boot id、CPU 数、cgroup 内存、placement id 校验 | 每进程一次 `ctx.container.exec` 承载共享 broker（exec stdin＝控制输入，实测背压）；命名端点经中继，原始 TCP 未做 | receipt＝`<化身标签>.<boot id>.<placement id>`；`attach` 要求容器运行、`inspect()` 标签与 exec 读到的 boot／placement 一致 | 无：磁盘随销毁／崩溃丢失；`captured` 快照未做（§3.7） | 不适用 |

部署装配只写一份：`{backend, options, image, resources}`。Electron／本机 Host 不经过本设计。

**镜像固定（Generation Router 的后继）。** 工作区记录持有 `image`（digest）。升级＝改部署默认镜像：新工作区（默认每 Thread 专属＝新 Thread）用新镜像；已存在工作区保持旧镜像直到空闲回收或显式迁移（迁移＝drain 后以新镜像 create、同一卷、走恢复）。不需要 registry、路由库或多 `CODEX_HOME` 并存于一个进程。`static-docker` 只有一个镜像，升级规则保持 README 现状（先等待活动任务）。

#### 3.3.5 风险（如实）

1. **吞吐与编码。** broker 对 stdout 每块做 base64＋JSON（约 1.4×，单行上限 512 KiB）；E2B 每条流还过一层 gRPC。原生 AppServer 的历史读取、大 diff、截图会受影响。缓解：读路径已有 `CodexCoreReadIsolation`；必要时 broker 加二进制帧版本。模型流量不走 broker（决定 1）。
2. **连接数＝进程数。** 每个 callback lane、每次文件操作都是一个沙盒进程。第 4a 步之后的测量（§7）显示 `docker exec` 每进程约 115 ms：文件操作改为常驻进程；E2B 未测。
3. **浏览器媒体。** CDP 截屏／录屏帧经 stdio 中继可能成为瓶颈。浏览器为可选组件、不在第一里程碑（决定 4）；若不满足，浏览器保留独立 provider 端口（屏幕流）而不是硬塞进 broker。
4. **端点无输出流控。** 沙盒进程契约只有输出回调，没有暂停；本地监听对未被读走的输出设上限，超限关闭该连接（fail closed，不无界缓冲）。主机→容器方向逐块等待 provider 写入，形成真实背压。
5. **合并后的隔离。** 去掉 `hands-unix` 固定向量后，Brain 与执行代码同一信任域；靠不同 UID（cloudflare-deployment.md §2.2）与"容器内无长期凭据"（决定 6）保证。
6. **重启语义。** `attach` 只能在 receipt 可证明同一实例时成功；未知即视为丢失并恢复，不得重建后假装续接。Docker 主机重启后 named volume 仍在但实例是新的——这是"化身变化"，不是续接。

**不做：** 不自建 `WorkspaceLink` 帧多路复用协议；不把原生 `codex app-server` 改成 stdio，不改 Codex、exec-server 协议；不让 Gateway 获得 Docker socket；不按操作系统隐式选择 provider，provider 失败不回退本机；不保留 `$DATA/run` 描述符作为并行兼容通道；本阶段不做 provisioner 弹性调度（Cloudflare provider 已在第 7a 步实现，见 §3.6）。

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
| WorkspaceHost | `apps/opencraft-daemon/src/workspace-host.ts` 装配 `default`（已实现） | Gateway 内装配 `default`（已实现，第 2–3 步） | Gateway 内每工作区一个（第 7b 步：`provisionedWorkspaces` 按 id 解析配置的环境 URI，各自 placement 记录与本地端点；WH 本体仍只装配 `default`） | 同左（未实现） | 每工作区一个 DO（设计） |
| 工作区容器／provider | 无：本机 Host 直接执行（可选 `linux-systemd` 资源域）；不经过放置设计 | `static-docker`（已实现，第 4c 步）：Compose `brain`＋`hands` 各运行一个 `workspace-agent`，Gateway 经 link 卷到达 | `docker-provisioner`（已实现，第 7b 步，Compose overlay `compose.workspaces.yaml`） | `e2b` backend（已实现，承载 Hands；承载 Brain 未实现） | `sandbox-cloudflare` Container backend（已实现：同一一致性套件经 `ctx.container` 替身通过；真实 Cloudflare 经 `cf:rehearsal --containers` 通过；WH DO 装配未做） |
| 环境 URI `<provider>://<target>` | 无（不经过放置） | `static-docker://brain static-docker://hands`（已实现，Gateway `OPENCRAFT_WORKSPACE_ENVIRONMENTS`） | `docker-provisioner://<镜像别名>`（已实现：`acceptsTarget` 只接受部署的别名白名单，provisioner 再校验；Gateway `OPENCRAFT_WORKSPACE_PROVISIONED_ENVIRONMENTS`） | `e2b://<模板>`（已实现：provider `acceptsTarget`；生产装配仍按 Bot 配置的 templateId 选择，未改为读 URI） | `cloudflare://<容器类>`（已实现：provider 只接受其所在 DO 的容器类） |
| 端点 URI `workspace://<id>/endpoints/<name>`＋`createWorkspaceRuntime` | 不使用 | Gateway `default` 工作区的全部 Brain／Hands 端点（已实现） | 同左（未实现） | 一致性测试中经 E2B 适配器夹具解析（已实现）；生产 E2B 浏览器 owner 仍用 `{unix}` 目标，未接入 WorkspaceRuntime | WH DO 直接持有 runtime（设计） |
| receipt／`attach` | 不使用 | receipt＝agent 化身；Gateway 重启按 receipt 续接，化身不同即视为新环境（已实现，真实 Docker 验证） | receipt＝`<容器 ID>:<agent 化身>`；Gateway 重启按 receipt 续接（已实现，真实 Docker 验证） | receipt＝sandbox id，`attach`＝固定 SDK 2.64 的 `Sandbox.connect`（已实现，夹具验证；真实 E2B 未运行；SDK 的 connect 可能恢复已暂停实例，这不是新建） | receipt＝`<start 标签中的化身>.<boot id>.<CLOUDFLARE_PLACEMENT_ID>`，不是 DO 名；`attach`＝容器运行且标签、boot id、placement 一致（已实现，真实 DO 重置后验证）；agent 化身仍由 WorkspaceRuntime 经 `control` 比对 |
| 化身观察 | 本机 owner 直接监督 | `control` 端点 `probe`（化身、角色、端点名）＋`describe`（凭据、引擎描述符），WorkspaceRuntime 持久化并在变化时报告（已实现）；执行租约身份仍读 `/proc`（第 5a 步） | 同左（未实现） | 同左（未实现：E2B 模板尚无 agent） | 同左（设计） |
| 存储端口（SQL／State／Blob／Secret） | Node 适配器（`nodeSqlDatabase`、`fileStateDocumentStore` 等，已实现） | 同左（已实现） | 同左（已实现） | WH 侧同 Docker；容器内只有工作区卷 | `@opencraft/storage-cloudflare`（workerd 一致性测试通过，未接入部署） |
| 唤醒端口 `OwnerWakeTimer`（定时任务、中断恢复、provider 重试） | `boundedWakeTimer`（已实现） | 同左（已实现） | 同左（已实现） | 同左（WH 侧） | DO alarm（workerd 测试原型驱动中断恢复与 provider 重试；未接入部署） |
| 端点 `openSandboxEndpoint`＋`attached` | 不使用（本机 owner 直接连接本机 socket） | Gateway 到 codex-control／codex-native／pi／dsh／terminal／files／browser 全部经它（已实现，第 4c 步） | 同 `static-docker`，经同一 link（已实现；真实容器一致性 11 项通过） | 浏览器中继已使用（broker `attached`，已实现；真实 E2B 冒烟未运行） | `container.exec`＋broker 承载中继（已实现，真实 4 MiB 往返一致）；原始 TCP `connectEndpoint` 未做（契约无该位置） |
| 本地端点监听 `createSandboxEndpointListener` | 不使用 | Gateway 内，每个端点一个私有 UDS，连接经 WorkspaceRuntime 解析（已实现，第 4c 步） | 同左 | 同左 | 不适用：DO 直接持有端点连接，不需要本地 socket |
| 容器入口 `workspace-agent`＋命名端点 | 不使用（本机 owner 直接监督） | `brain`、`hands` 容器入口，并在 link 卷上服务 broker（已实现，第 4b／4c 步；角色是装配） | 同一入口作为 provisioned 容器主进程（已实现：默认别名 `workspace` 运行 `--role hands`；一致性夹具用 `--bare`） | 同一入口作为模板主进程（未实现；浏览器 owner 暂用 `{unix}` 目标） | Container 主进程（预演镜像以真实 `workspace-agent --bare` 为主进程验证；产品镜像未做） |
| 工作区内容持久化（§3.7） | 不经过本设计（本机目录） | Git 真源；bind mount 是缓存，声明 `retained` 快照形态（设计） | Git 真源；named volume，`retained`（卷随 sleep 保留、随 discard 删除；`snapshot` 声明未实现） | Git 真源；pause／resume，`retained`（设计） | Git 真源；`snapshotContainer`，`captured`（设计；平台 beta 能力，只加速、不兜底） |
| 空闲休眠（§3.7，默认 15 分钟，可配置常驻） | 不适用 | 不休眠：Compose 静态容器固定常驻（`static-docker` 不声明 `sleep`） | `docker stop`（provider 能力已实现：`SandboxBackend.sleep`；WH 空闲判定与定时器未实现） | `pause`（设计） | WH DO 停止容器（`sleep` 未做）；inactivity timeout 兜底已实现：start、attach、backend 初始化时设置，导出 `armCloudflareContainerTimeout` 供 DO 构造调用 |

**各形态如何映射到同一模型（第 4c 步核对）。**

- **Electron 桌面**：没有放置、没有 Gateway／Brain 分离；本机 owner 直接连接本机 socket。若将来需要同一模型，适配器是一个 `local` provider（本地子进程 backend，一致性夹具"local-process"已证明契约可满足）加本机 `workspace-agent`；缺：provider 定义、receipt（本机进程 id＋出生证据）与装配。不做。
- **docker-provisioner**（第 7b 步已实现，见 §7"第 7b 步现状"）：provisioner 服务持 socket 并按策略创建容器；backend 经与 `static-docker` 相同的 link（不是 `docker exec`）spawn 与开端点，receipt＝容器 ID＋agent 化身，`attach`＝provisioner 确认同一容器仍在运行＋link 确认同一化身；容器主进程即 `workspace-agent`。
- **E2B**：本步已接入同一模型：`e2b://<模板>` 经 registry 选择，`receipt`＋`attach`（`Sandbox.connect`）进入契约，端点 URI 解析在夹具中通过。缺：模板内的 `workspace-agent`（今天浏览器 owner 仍是 `{unix}` 目标）、真实 E2B 冒烟与延迟测量。
- **Cloudflare Containers**：`sandbox-cloudflare` backend 必须实现且通过同一一致性套件的契约要点——provider 定义（`id: "cloudflare"`、`acceptsTarget` 校验容器类）；`create(identity, resources)` 启动由 WH DO 持有的容器并报告实际 CPU／内存；`spawn` 承载共享 broker 帧并满足二进制往返、半关闭、两端关闭、写入背压、`attached` 失败只结束该进程、非 attached 失败回收环境；`SandboxEnvironment.receipt`＋`attach`（不能证明同一化身即 `SANDBOX_UNAVAILABLE`）；幂等 `close` 在实例消失后才完成；容器主进程是 `workspace-agent`，提供 `control`（`probe`／`describe`）与命名端点；WH DO 直接调用 `WorkspaceRuntime.connect`，不需要本地监听。建议形态：WH DO 持有容器；`spawn`＝`container.exec`；命名端点优先原始 TCP（`workspace-agent` 在容器内一个端口上按连接前导行路由到对应端点 UDS），中继作为通用回退；WebSocket 只作备选、不作端点传输。实现前置与同步项见 §7"Cloudflare provider 前置项"。

  **实现现状（第 7a 步，2026-11-23）。** `@opencraft/sandbox-cloudflare`（只依赖 `@opencraft/sandbox`，结构化声明 `ctx.container`，无 Workers／Node 类型）：`cloudflareSandboxProvider({containerClass, container, waitUntil})` 与 `cloudflareSandboxBackend`。create：先回收本 DO 内无法认领的运行中容器，再 `start({image, enableInternet:false, instance:{vcpu, memoryMib, diskMb}, labels:{oc-incarnation}})`（预算按 1/8 vCPU 步进、整 MiB 映射，超出账号上限即 not-created），再以一次 exec 读 boot id、CPU 数、cgroup `memory.max`、PID 1 的 `CLOUDFLARE_PLACEMENT_ID`；有效资源＝cgroup 内存＋（CPU 数等于 ceil(vCPU) 时）请求的 CPU，池拒绝不一致。spawn：每进程一次 `exec([python,-I,-u,-c,broker])`，broker 承担 PTY、进程会话与退出码（exec 的 kill 只到单进程）；exec 句柄在 DO 重置后丢失时 broker 读到控制输入 EOF 即 killpg（前置项 2 对 broker 进程由此满足）；失败的 broker 传输经新增的可选 `SandboxBrokerChannel.dispose()` 关闭 stdin，宽限后仅对**仍未退出**的 exec 发 SIGKILL（前置项 3）。close：只在容器仍带本化身标签时 `destroy()`，并等 `monitor()` 落定；幂等。`lost`：`monitor()` 在 owner 未 close 时落定即报告（`exited`／`crashed`＋退出码／`stopped`）。验证：一致性套件 `cloudflare-fixture` harness 11 项通过（替身见 tests/execution/fixtures/cloudflare-container.ts：exec 不继承 start env、kill 单进程且对已退出进程报错、DO 重置丢句柄）；tests/execution/sandbox-cloudflare.test.ts 9 项；真实 Cloudflare 见 [cloudflare-deployment §7.5](cloudflare-deployment.md#75-cloudflare-containers-组--containers)。未做：WH DO 装配、`captured` 快照与 `sleep`、原始 TCP `connectEndpoint`、产品镜像、同一测量 harness 的 p50／p95。

  **真实探测结论（2026-11-23，Workers Paid 账号，ewr14 机房；单账号单机房，样本量小，数字只作量级）：**

  | 方面 | 结论 | 对契约的含义 |
  | --- | --- | --- |
  | 进程 | `ctx.container.exec(argv,{stdin:'pipe',pty,cwd,env,user,signal})`：流式 stdin／stdout／stderr，stdin 有真实背压（约 2 MiB 未读后 write 挂起），PTY 可用，退出码保留，kill 只作用于单个进程；exec 以 root 运行、不继承 `start()` 的 env；exec 进程是 PID 1 的兄弟，不是其子进程。exec 启动 8–19 ms | `spawn` 可直接承载 broker（broker 自己 `setsid`／`killpg`，补上"kill 只杀单进程"）；`user`、`env` 由 backend 每次显式传入，不依赖 start 环境 |
  | 端点传输 | 现有固定中继经 exec 连容器内 UDS，4 MiB SHA 一致；9 个命名端点并发各 4 MiB 共 0.8 s。原始 TCP `getTcpPort(p).connect()` 有背压与半关闭，32 MiB 约 68 MB/s（4 vCPU）。WebSocket（`getTcpPort(p).fetch` 升级）帧正确但**无背压**（`bufferedAmount` 涨到 160 MiB 无信号） | 中继即可满足契约，不需要新原语；原始 TCP 作为可选 `connectEndpoint` 的候选；WebSocket 不作端点传输 |
  | 冷启动 | 新 DO 名中位约 625 ms（最大 745 ms，离群 2.3–2.5 s）；休眠后唤醒中位约 600 ms；代码部署后首次 3.9 s；快照恢复 498 ms | 15 分钟空闲休眠（§3.7）的唤醒代价在 1 s 量级，可接受 |
  | 生命周期 | 进程崩溃时 `monitor()` 抛错并带退出码，不自动重启；`destroy()` 100–930 ms；PID 1 不处理 SIGTERM 时 30 s 不停；没有挂起的 `monitor()` 时 DO 空闲 10–20 s 被驱逐（容器不随之停止）；inactivity timeout 生效但单样本早于设定；磁盘随 `destroy()`／崩溃丢失；`snapshotContainer` 2.4 s（增量 343 KB）可恢复，快照 30 天 TTL 且 Worker API 不能删除 | 需要契约级"环境丢失"信号（由 `monitor()` 驱动）；容器磁盘只是缓存（§3.7）；inactivity timeout 只作兜底，不作正确性依据 |
  | 化身身份 | 每次启动 env 带 `CLOUDFLARE_PLACEMENT_ID` 与 `CLOUDFLARE_DURABLE_OBJECT_ID`，hostname＝DO id；`start({labels})` 可经 `inspect()` 读回；同一 DO 名下会先后出现多个化身 | receipt 必须是化身 id（agent 化身，佐以 placement id 与标签），不得用 DO 名——与 `static-docker` 相同 |
  | 寻址与重连 | `getByName` 稳定；`ctx.abort`、自然驱逐、代码部署之后 DO 构造时 `running=true` 且 bootId／标签不变，可重连同一容器；exec 句柄不跨 DO 重置保留：读 stdin 的进程收到 EOF 退出，不读 stdin 的成为孤儿 | `attach` 在 DO 构造时按化身比对即可续接；孤儿须由 `workspace-agent` 按 link／端点连接结束回收 |
  | 资源 | lite 1 vCPU／256 MiB／2 GB；standard-4 4 vCPU／12 GiB／20 GB；自定义 `{vcpu:4, memoryMib:8192, diskMb:20000}` 被接受＝默认 4 vCPU／8 GiB；上限 4 vCPU／12 GiB／20 GB。容器内 `cpu.max`、`pids.max` 为 `max`，nofile 1048576 | CPU／内存可由 provider 报告；默认 4096 tasks／65536 FD 由 `workspace-agent` 自行设置，不能假定平台已限制 |
  | 出站 | `enableInternet:false` 时全部不通；`false`＋`interceptAllOutboundHttp` 时 HTTP 全部交给 Worker entrypoint（可带每工作区 props），HTTPS 失败 | "容器内不放长期凭据、模型流量走账号代理"（§5）可实现；HTTPS 拦截需容器信任 `/etc/cloudflare/certs/cloudflare-containers-ca.crt`（未测） |
  | 费用 | 4 vCPU／8 GiB／20 GB 运行约 0.11–0.37 美元／小时；空闲常驻约 75 美元／月；休眠不计费 | 默认空闲休眠（§3.7）；常驻是显式选择 |

  探测原始记录在协调会话的临时目录中，未入库；入库的结论以本表与 [execution-sandbox](../execution/execution-sandbox.md#provider-lifecycle-obligations-from-the-cloudflare-containers-probe) 的义务表为准。

### 3.7 工作区持久化与空闲（设计，2026-11-23 用户决定，未实现）

本节对所有 provider 成立（§3.6 规则）：领域代码只看能力声明，不判断是 Docker、E2B 还是 Cloudflare。

#### 3.7.1 持久化契约

- **Git 是工作区内容的持久真源。** 已提交并推送到工作区登记远端的内容是唯一保证存活的工作区内容；容器／沙盒（含其磁盘、卷与 `CODEX_HOME` 之外的工作目录）是**可重建缓存**。Docker、E2B、Cloudflare 同一语义。
- **未提交改动可能随化身丢失。** 契约明确承认这一点：化身变化（崩溃、主机重启、provider 回收、快照缺失或过期）后，工作区从快照或 Git 重建；能恢复多少未提交改动取决于 provider 能力，不作保证，也不以任何 provider 的 beta 能力兜底。
- **快照是 provider 的可选能力**，只用于加速恢复、降低未提交改动丢失概率；不具备该能力的 provider 仍正确工作（从 Git 重建）。
- Host 状态（队列、中断恢复、定时任务等）在 WorkspaceHost 库中，不在容器内，不受本节影响；引擎私有数据（`CODEX_HOME`、Pi、DSH）随容器缓存一起保留或丢失，丢失时按中断 Turn 恢复处理。
- 范围：本契约覆盖 WorkspaceHost 放置的工作区容器。Assets 工作区现有的 `PersistentWorkspaceProvider`（E2B 私有卷）语义不变，未来是否并入本契约另行决定。

**能力声明（契约形状，未实现）。** `SandboxProviderDefinition` 增加可选声明，`SandboxBackend` 增加对应可选方法；不声明即不提供：

```ts
type SandboxPersistenceCapability =
  | { snapshot: "retained" }   // 休眠／停止保留磁盘：Docker 卷、E2B pause；无需显式捕获
  | { snapshot: "captured"; retentionMs?: number; deletable: boolean };
                               // 显式捕获／恢复：Cloudflare snapshotContainer（30 天 TTL，Worker API 不可删）
interface SandboxSnapshotRef { backend: string; id: string; image: string; takenAt: number; expiresAt?: number } // 无凭据
interface SandboxBackend {
  sleep?(environment, signal): Promise<void>;                     // 见 3.7.2
  captureSnapshot?(environment, signal): Promise<SandboxSnapshotRef>;
  restoreSnapshot?(identity, ref, resources, signal): Promise<SandboxEnvironment>; // 新实例、新 receipt
}
```

**WorkspaceRuntime 何时请求。**

- `captured`：休眠前（3.7.2）与计划关闭／镜像迁移前的 drain 之后各捕获一次；可选地在 Turn 结算后按工作区配置的最小间隔补捕获，以缩小崩溃丢失窗口（默认关闭，费用与平台限制按 provider 评估）。捕获失败只记录并继续休眠／关闭，不阻止，也不重试成阻塞。
- `retained`：不捕获；休眠／停止本身保留磁盘。
- 恢复：`attach(receipt)` 失败（实例已不存在）后，WH 若持有与当前工作区 `image` 相同、未过期的 `SandboxSnapshotRef`，以 `restoreSnapshot` 代替 `create`；恢复失败、已过期或镜像不同则 `create` 并从 Git 重建。快照引用记录在 WH 的放置记录中（与 receipt 同一 StateDocumentStore 文档），先持久化再使用。

**恢复后与 Git 真源对账。** 恢复出的环境一律是**新化身**（新 receipt，`leaseEpoch+1`），走中断 Turn 恢复，快照不授权重放任何未确认输入。随后由 `workspace-agent` 报告每个仓库的 `HEAD`、分支与工作树是否干净，WH 与登记的远端提交比较：

| 情况 | 处理 |
| --- | --- |
| 快照 `HEAD` 等于远端，或是远端祖先且工作树干净 | fetch 后快进到远端提交 |
| 快照含未推送的提交或未提交改动 | 保留，不自动 reset、rebase 或 merge；远端已前进时向用户报告分叉，由用户或 Turn 处理 |
| 无快照、恢复失败、快照过期 | 从远端重新 clone／checkout；以非阻塞通知告知"工作区已从 Git 重建，未提交改动未恢复" |

**receipt 与化身变化的语义。** receipt 只证明"同一运行实例"；快照只证明"某一时刻的磁盘内容"。两者不能互相替代：`attach` 不会用快照伪装续接，`restoreSnapshot` 的结果永远是化身变化。

#### 3.7.2 空闲策略

- **通用配置**：每工作区 `idle: { mode: "sleep", afterMs } | { mode: "resident" }`，默认 `sleep`、`afterMs` 15 分钟；可配置为常驻。provider 不提供 `sleep` 时，工作区等同常驻（`static-docker` 的 Compose 容器即如此）。
- **"空闲"由 WorkspaceHost 判定**（provider 的活动计量不是依据），同时满足：
  1. 没有进行中或待派发的 Turn（以 WH 持有的队列与 Turn 状态为准）；
  2. 没有附着的端点连接（本地监听或 WH DO 上的客户端连接，含已附着终端；断开的终端会话不阻止休眠，休眠结束其 PTY，与化身变化一致）；
  3. 没有在空闲时长内到期的 owner 唤醒：中断恢复无待处理行，provider 重试无在窗口内到期的 `waiting` 行，定时任务的下一次到期不早于判定时刻＋空闲时长。
- **休眠不影响唤醒。** 定时任务、中断恢复、provider 重试的 `OwnerWakeTimer`（§4.3）都在 WH 侧（Node owner 定时器／DO alarm），不在容器内，因此环境休眠后照常到期。到期推进需要引擎时，经 `WorkspaceRuntime.connect` 按需打开环境：先 `attach(receipt)`（E2B 的 `Sandbox.connect` 恢复已暂停实例；Docker 启动已停止容器；Cloudflare 在 DO 内重新 `start`），失败则按 3.7.1 恢复快照或新建。化身是否变化由 agent `control` 报告决定，不按 provider 类型推断（E2B pause／resume 可能保持同一化身，Docker stop／start 与 Cloudflare 重启必为新化身）。空闲判定本身也用同一唤醒端口的一个 owner 定时器。
- **provider 映射**（`sleep` 的实现）：Docker（`docker-provisioner`）`docker stop`，卷保留；E2B `pause`；Cloudflare 由 WH DO 先按需捕获快照再停止容器，同时把容器 inactivity timeout 设为同一空闲时长作为兜底，且**每次 DO 构造都重设**（重启后不保留）。兜底停止或平台早停（探测中单样本早于设定）都走"环境丢失"路径，不影响正确性。常驻在 Cloudflare 上要求 WH DO 保持挂起的 `monitor()`，费用见 §3.6 探测结论（约 75 美元／月）。
- DO 只有一个 alarm：WH DO 把定时任务、中断恢复、provider 重试与空闲判定的唤醒合并到最早时刻，这是 DO 适配器的义务，领域代码仍各自持有 `OwnerWakeTimer`。

## 4. Codex Host 状态拆分

### 4.1 归属

| 数据 | 目标 | 端口 | 说明 |
| --- | --- | --- | --- |
| `codex_host_queue` | WH | SQL | 每线程队列，只与本工作区原生线程交互 |
| `thread-creations.sqlite` | WH | SQL | 暂定线程只在创建所在工作区有意义 |
| `interrupted-turn-recovery.sqlite`、`provider-turn-retry.sqlite` | WH | SQL＋owner 定时器 | 恢复 owner 必须与发出 `turn/start` 的 owner 相同；唤醒见 4.3 |
| `conversation-schedules.sqlite` | WH | SQL＋owner 定时器 | 见 4.3 |
| `codex_thread_catalog`、`codex_catalog_sync` | WH 持有真源；IC 持有跨工作区列表投影 | SQL | 侧栏"全部会话"需要跨工作区列表，投影可重建，不授予写权 |
| `message_senders`、`message_sender_origins`、`ioa_*`、`codex_bot_*` | 待定 | SQL | 与主体协作、Bot 房间相关；若 Bot 跨工作区，应进入 IC，否则留 WH |
| `token-usage.sqlite` | 待定 | SQL | 4.2 |
| `tasks.sqlite` | IC | SQL | 跨会话业务记录 |
| 会话资源生命周期（原 `conversation-resources.json`） | IC | SQL（服务器核心表 `conversation_resources`，迁移 v25 `0024_conversation_resources`） | 决定见下 |
| Git broker 账本（旧 PID 来源 broker 的 `ownerStateFile` JSON） | 暂不迁移 | —（保留原 JSON） | 暂不迁移：服务端 broker 当前无生产装配，保留供下一代使用；见下 |

**会话资源生命周期与 Git broker 账本的归属（2026-11-23 决定）。** 本表原未列出二者；[存储端口](storage-ports.md#32-statedocumentstore) 只写了"并入 SQL 核心"，[Gateway 拆分](gateway-split.md) 曾暂列为 WH。决定与理由：

- **会话资源生命周期归 IC。** 每行以 `(hostId, threadId)` 为键，同一 Gateway 的全部 Host（本机 Codex、Pi、DSH、SSH 等）共用一份投影；它是资源**准入**的栅栏（`assertActive`），不是资源本身。注册的 owner 中 `workspace` 释放的是 Assets 工作区分配（IC 的分配账本，见 gateway-split §2.3），且依赖 `browser` 先释放；若记录放在每工作区 WH 库内，回收该工作区就会回收记录自身的存储，"清理未确认前保持栅栏"无法成立。终端、浏览器、工作区的**释放动作**仍由 WH／容器执行，IC 只保存代次与待确认 owner。Node 上表由服务器核心 owner Worker 写入（已在 Worker，不增加主线程同步 IO），网络线程持有已提交行投影；DO 上同一领域代码在 InstallationCore DO 的 SQL 上运行（tests/storage/conversation-resources-workerd.test.ts）。
- **Git broker 账本暂不迁移。** 服务端 `GitIdentityBroker`／`GitBrokerOwner` 当前无生产装配，保留原 JSON 实现供下一代使用，不迁移也不退役。其内容是 broker 进程自己的围栏交接与未确认职责，唯一写入者是 broker 进程，将来迁移时也不能并入 IC 或 AC 的库，只能是独立库；而新增库一经发布就是不可删除的迁移，因此在下一代确定其装配之前不发布（§8.4 决定 9）。目标拓扑中 Git 校验移入 `workspace-agent`、凭据由 WH 签发（§8.3 决定 6）。

WorkspaceHost 的 SQL 库是**一个**按工作区的库，合并今天分散的 `opencraft-host-state`、`thread-creations`、`interrupted-turn-recovery`、`conversation-schedules`（推荐方案：各自迁移账本保留为同库内的独立 schema id；备选为在合并迁移中显式导入；不能改写已发布迁移）。这让 DO 上一个 DO 对应一个 SQL 库成立。第 2 步只要求"按工作区根目录"，合库排在 7a、7b 之后、4d 之前，待实施（§7 后续顺序）。

**第 2 步现状（2026-11-22）。** 生命周期核心在 `@opencraft/workspace-host`（packages/workspace-host/src/index.ts）：显式 `WorkspaceIdentity {id, root}`、可选锁端口、按登记顺序打开、失败按逆序回收并释放锁、两阶段关闭（`drain()` 逆序停止 `dispatch` owner 并等待其在途工作；`close()` 逆序关闭 `state` 存储后最后释放锁；单步失败不阻止后续关闭）、同一运行时内同一 root 只允许一个 owner。该包不依赖 Node（`types: []`），供日后每工作区 DO 复用。Node 装配在 apps/opencraft-daemon/src/workspace-host.ts：`openCodexWorkspaceHost` 以显式根打开 overlays 锁（仅在独立 core 之后）→ Host 状态库 → 暂定线程 →（执行租约挂起）→ queue（含内嵌模式旧原生队列一次性导入）→ 定时任务 → 中断恢复 → provider 重试；各 SQLite owner、文件名、迁移与线程位置不变，未改 schema。`CodexEngineAdapter` 只提供端口并消费 `stores`（codex-engine-adapter.ts:870），关闭时先 `drain()`（:2036），在 Thread 操作结算、token usage／附件／任务关闭后再 `close()`（:2084）。Gateway（headless-application.mjs:1101）与桌面 daemon（apps/opencraft-daemon/src/main.ts:163）各装配一个 `default`，根为今天的 `$DATA/codex`／`codexDataDirectory`，无数据迁移。

仍留在 adapter、未进入 WorkspaceHost 的：`token-usage.sqlite`（§4.2 待定）、`tasks.sqlite`（IC）、消息附件 `opencraft-message-attachments`、置顶／标题／thread identity、转录缓存、会话 MCP、维护准入；账号池与内嵌模式的组合 writer 锁（AC）；SSH 远程 Host 的本地 Host 状态镜像（`attachmentHistoryDirectory`，非本机工作区）。Host 状态库内 senders／Bot／IOA 表（上表"待定"）随整库由 WH 打开，归属未改。WorkspaceHost 的 SQLite 仍在 Gateway 主线程同步打开（存量，登记于 `config/main-thread-sync-io.json`）；改为 Worker 承载属方案 A 的后续工作，不在本步。

**SQL 端口现状（2026-11-23）。** WH 各存储的领域代码改为只依赖 `@opencraft/sql` 的 `SqlDatabase`，Node owner 仍用 `openManagedDatabase` 打开原文件并借出 `nodeSqlDatabase(connection)`；手写 `BEGIN`／`COMMIT`／`SAVEPOINT` 改为 `transaction()`（嵌套为 savepoint），已发布迁移、checksum、文件名与线程位置不变。清单：`SqlConversationSchedules`（Node 子类 `ConversationSchedules`）、`SqlInterruptedTurnRecovery`／`SqlProviderTurnRetry`（`InterruptedTurnRecovery`／`ProviderTurnRetry`）、`SqlProvisionalThreads`（`ProvisionalThreads`）借出 `ScopedSqlDatabase`；Host 状态库 `OpenCraftHostStateDatabase` 新增 `sql` 端口，`transaction()` 委托该端口，`SqlHostQueue`（Node 子类 `OpenCraftHostQueue` 保留自开库与旧原生队列一次性导入）、`InputDeliveryStore`、`ExecutionLeaseReader/Store`、`OpenCraftMessageSenders` 借用该端口（仍传 node 连接的 Hub thread-identity 库与测试在借用方边界经 `sqlPort()` 适配）。执行租约的启动时钟改为注入端口 `ExecutionBootClock`（Node 默认读 `/proc`）。tests/storage/workspace-host-sql-port.test.ts 在 `nodeSqlDatabase(:memory:)` 上以已发布迁移验证账本、schema 与 Node owner 文件一致并跑各存储关键操作；tests/storage/workspace-host-workerd.test.ts 在 Miniflare DO SQL 上原样执行五条迁移链（含 v13 改名、v17 重建队列与外键），重启保留账本、旧对象升级、篡改 checksum 拒绝，领域操作结果与 Node 逐项相同。DO 仍缺：五个存储各有一份 `schema_migrations`，同一 DO 库只能承载其一，需 §4.1 合库迁移（账本按 schema id 区分或显式导入）；`codex_thread_catalog` 的 `ThreadDirectory`（app-host-server）仍依赖 `DatabaseSync.location()`、`worker_threads` 快照读取与 read guard；中断恢复与 provider 重试已改为消费唤醒端口（§4.3），DO alarm 适配只在 workerd 测试原型中，未接入部署；执行租约启动时钟需由容器 `control` 端点提供（§3.4）；IOA 元数据工厂 `createThreadMetadata` 与 token usage 仍收 `DatabaseSync`；Node owner 的文件、writer 租约、旧库接纳与原生队列导入保持 Node 专属。

### 4.2 Token usage

今天 Gateway 记录 Codex 用量并提供查询（codex-engine-adapter.ts:992-1024）。用量属于计量与策略，最终消费者是 AC（配额）与管理界面（跨工作区汇总）。建议：WH 只记录本工作区的原始用量事件并可靠转交；AC 持有汇总账本。需要确认现有查询 Worker 的语义是否允许"事件先在 WH 落库、再异步转交"的延迟（8.2 节问题 7）。

### 4.3 定时任务

`ConversationSchedules` 原先每 2 s 轮询。拆分后改为 owner 驱动：WH 在提交计划后计算"下一个到期时间"，Node 上设置单个 owner 定时器（Worker 内），DO 上设置 alarm。轮询语义不变：到期判断仍以持久状态为准，定时器只是唤醒。Gateway 不在线（方案 B）或 WH 重启后，启动时先按持久状态补齐过期计划，不依赖定时器连续性。

**第 3 步现状（2026-11-22）。** 唤醒端口由 `@opencraft/workspace-host` 持有：`OwnerWakeTimer { arm(at), cancel() }`（`at` 为 owner 时钟的绝对时间，回调不早于该时刻；`arm` 替换上一次）与 `OwnerWakeTimerFactory`。Node 实现 `boundedWakeTimer(timeoutWakeClock(now), wake)`：每段相对延迟不超过 `MAX_WAKE_DELAY_MS`（60 s），到点重读墙钟，未到目标就续段——时钟回拨不会提前唤醒，前拨最迟一段内发现，远期目标不触及平台定时器上限；DO 将来以 alarm 实现同一端口。`ConversationSchedules` 在 `start()` 后不再轮询：每次提交的计划变更（save／action／suspend）与每次推进结束（含 flight 结算）都从持久状态（叠加内存中已有的重试退避）计算最早可推进时间并重新 arm；无待办时 cancel。唤醒只触发一次推进，是否到期仍在推进时读持久状态判断，过时或提前的唤醒不派发任何工作。`start()` 先按持久状态补齐过期与未完成的 occurrence（再次调用即再补齐一次，供 admission 重开／引擎重新 initialize）；`close()` 先 cancel 唤醒，再等待在途推进与 flight。admission 被 fence 时没有重开通知，若已有到期工作则按原 2 s 节奏复查而不派发，无到期工作则只在计划时间唤醒。持久 schema、occurrence ID 与并发 4 个 flight 上限不变。WH 装配经 `CodexWorkspaceHostOptions.scheduleWakeTimer` 注入（默认 Node 实现），`drain()` 关闭 schedules 时即取消唤醒。Pi 引擎（plugins/pi-engine）与 local-agent-host（DSH）共用同一 `ConversationSchedules`，以默认 Node 唤醒同样转为 owner 驱动；二者的 `resumeBackground()` 已调用 `start()`，即 admission 重开时的补齐入口，无需另改。测试见 tests/chat/conversation-schedule-wake.test.ts 与 tests/execution/workspace-host.test.ts。

**中断恢复与 provider 重试的唤醒（2026-11-23）。** `SqlInterruptedTurnRecovery` 与 `SqlProviderTurnRetry` 不再自持 `setTimeout`，改为与定时任务相同，构造时从 `OwnerWakeTimerFactory` 取得单个 owner 唤醒（默认 Node 实现 `boundedWakeTimer(timeoutWakeClock(now))`；WH 装配经 `CodexWorkspaceHostOptions.recoveryWakeTimer`／`providerRetryWakeTimer` 注入，默认 `nodeOwnerWakeTimer(now)`，Pi 与 DSH 沿用领域类默认）。唤醒只触发一次推进，是否行动仍在推进中逐行读持久状态判断，`expected` 快照比较、`admit` 前复核与 `preparing`→`dispatching` 写入边界不变；只在推进结算后（而非推进中）重新 arm，推进中到来的唤醒在结算后补一次推进。中断恢复的持久状态没有时间：engine owner 的 `wake()`（native initialize、重连、新证据）或无法结算的行（inspect 为 unknown、准备失败、推进出错）在内存中请求 owner 时钟 `now + delayMs`（默认 500 ms）的一次推进，仅当库中仍有待处理行时才 arm，否则 cancel；已续接且 live 的执行不轮询。provider 重试由持久行推导：`waiting` 行取持久 `retryAt`，其余待处理行按 30 s 对账，推进结算后最早不早于 1 s；显式 `wake(delay)` 只能提前；admission 被 fence 时没有重开通知，待处理工作按 1 s 复查而不派发。两者在 engine owner 首次唤醒前都不 arm（重启后由 initialize 的 `wake()` 补齐库中待处理行）；`close()` 先 cancel 再等待在途推进。时钟回拨：provider 重试不早于持久 `retryAt` 派发；中断恢复的内存请求最多延后回拨量，下一次 engine 唤醒以 `min` 纠正到当前时钟；迟到或重复唤醒只重复一次幂等读取。schema、迁移与文件不变。测试：tests/execution/interrupted-turn-recovery.test.ts、tests/execution/provider-turn-retry.test.ts 的 "wake-up" 用例（到期、重启补齐、回拨、关闭排空、迟到与并发唤醒、fence）；tests/storage/workspace-host-workerd.test.ts 以 DO alarm 实现同一端口，被驱逐后的新实例由 alarm 重开 owner、按持久行完成恢复与重试，且不重复派发。

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
| 4c | `static-docker` provider：`workspace-agent` 在私有挂载 UDS 上服务 broker；Pi/DSH 改听容器私有 UDS 并登记端点 `pi`/`dsh`；Gateway 的 `default` WH 改经该 provider＋命名端点访问 codex-control/native、Pi、DSH、terminal、files、browser，删除描述符读取（gateway-application.mjs:14-17、34-43） | 去掉私有描述符与 loopback 依赖 | 真实 Docker：Gateway 重建后续接同一化身；断开时未确认变更不重发（held-promise＋丢 ack）；callback lane 15 s 窗口语义不变。**已实现（2026-11-23）**，见下文"第 4c 步现状"；held-promise＋丢 ack 的定向测试与 15 s 窗口的真实测量未做 |
| 4d | 反向 RPC 进程：授权 socket、session-capability MCP、任务目录改经它；签名密钥留 WH，容器只拿短期 token | 容器不再连 Gateway loopback | 撤销授权后容器内请求被拒；WH 断开期间请求失败而非排队 |
| 5a | 化身与 Git peer 校验移入 `workspace-agent`，经 `control` 签名上报；删除 Gateway 的 `/proc` 读取；Git 凭据改为单次／短期、按仓库限定 | 删除 `pid: host` 依赖 | PID 重用测试；Git 来源租约在新格式下通过、旧格式失效走恢复；容器内无长期 Git 凭据 |
| 5b | 合并 `hands` 进 `brain` 为单个 `workspace` 容器；AppServer 容器内直接 spawn exec-server；删除 `hands-unix` 固定向量路径与 `pid: host`、`network_mode: host`（先 Brain＋Hands，浏览器可选、不在本里程碑） | 一个工作区一个容器 | 真实 Docker：去掉两项后执行租约、Git、恢复、终端冒烟；`/proc` 不可见检查；模型请求经私有网络到 AC 代理 |
| 5c | `CODEX_HOME`、Pi、DSH 数据移到工作区私有卷（与第 6 步冷迁移合并执行） | 共享 `$DATA` 不再被 Brain 写入 | 从上一版本数据目录升级、中途 kill 重跑、回退演练 |
| 6 | 冷迁移到 `$DATA/workspaces/default/` | 共享 `$DATA` 不再被 Brain 写入 | 从上一版本真实数据目录升级、中途 kill 后重跑、回退演练 |
| 7 | 多工作区：WH 按工作区装配，provider 由部署选择；实现为 7a、7b，其次以 `e2b` 承载工作区镜像＋`attach`；WH 代码不变；§3.7 的持久化与空闲契约随 7a 落地 | 一工作区一 Brain | 两个工作区并发 Turn、一方容器重启不影响另一方、凭据不可见检查、容量准入、空闲休眠后到期定时任务拉起环境 |
| 7a | `sandbox-cloudflare` provider（含下文"Cloudflare provider 前置项"）：WH DO 持有容器，`spawn`＝`container.exec`，命名端点优先原始 TCP；`captured` 快照与 `sleep` | Node 侧获得契约级"环境丢失"信号与 agent 侧进程回收，`docker-provisioner` 复用 | 同一一致性套件（Cloudflare harness 需要真实账号，按 `cf:rehearsal` 方式运行与清理）；化身 receipt、DO 重置后 `attach`、崩溃经 `monitor()` 报告丢失、休眠／唤醒、快照恢复后的 Git 对账。**provider 已实现（2026-11-23）**：一致性套件经替身通过；真实 Cloudflare（`cf:rehearsal --containers`）完成 create→spawn→端点往返→DO 重置后按 receipt attach→`monitor()` 报告丢失→新化身→close；`captured` 快照、`sleep`、原始 TCP 与 WH DO 装配未做 |
| 7b | `docker-provisioner`（其 Docker socket 授权作为独立服务边界设计）：link＋broker（复用 `static-docker`，不用 `docker exec`），`retained`（named volume）与 `sleep`＝`docker stop` | 自托管多工作区 | 同一一致性套件（真实容器 harness）；provisioner 拒绝未签名请求；Gateway 无 socket。**已实现（2026-11-23）**，见下文"第 7b 步现状" |
| 合库 | WorkspaceHost 五个库合为一个按工作区的库：账本按 schema id 区分（推荐方案；备选为合并迁移中显式导入），不改写已发布迁移 | 一个工作区一个 SQL 库，Node 与 DO 同形 | 从上一版本五个库升级并保留数据、checksum 不一致拒绝、workerd 上同一迁移链；**待实施** |
| 8 | 跨工作区会话列表投影与 token usage 转交 | 侧栏与计量跨工作区正确 | 投影重建、转交延迟与重复 |

沙盒端口的 `sandbox-cloudflare` provider（7a）只依赖已完成的 4a–4c 契约，按下文顺序先行；WorkspaceHost 的 DO 装配与 Cloudflare 部署（第 5、6 阶段其余部分）仍在 4d–5c 与合库完成之后。

**第 4a 步现状（2026-11-23）。** 契约：`SandboxCommand.attached?: true`（仅 pipe 进程；由 `createSandbox` 校验并原样交给 backend）。共享 broker 对 attached 进程的传输丢失、启动失败与终止未确认只结束该进程（`exited` 拒绝；`terminate()` 以 `SANDBOX_CLEANUP` 拒绝），不调用 `closeEnvironment()`；guest 侧 broker 在控制流结束时自行 kill 进程组，环境关闭回收残留；`attached` 不发送给 guest。非 attached 进程保持原有 fail-closed 语义。`@opencraft/sandbox/endpoint` 的 `openSandboxEndpoint(environment, {target: {unix}, onData, python?, cwd?})` spawn 固定 Python 中继（非阻塞 socket 写、1 MiB 待发上限、stdin EOF→`SHUT_WR`、目标 EOF→退出 0），返回 `{write, end, close, closed: "ended"|"failed"}`；路径须为绝对、无 `.`/`..` 段、≤107 字节。`@opencraft/sandbox-node/endpoint-listener` 的 `createSandboxEndpointListener` 在私有 0700 目录中监听 UDS，每条本地连接＝一条端点连接：每连接先 `authorize()`，本地→沙盒逐块等待 provider（背压），沙盒→本地超过 `maxBufferedBytes`（默认 8 MiB）关闭该连接，连接数上限默认 32，终止未确认上报 `onCleanupUnconfirmed` 并使 `close()` 拒绝；尚未接入任何生产装配。浏览器 `connectSandboxBrowserOwner` 改用 `openSandboxEndpoint`（同一解释器、`/workspace` cwd、帧与授权逻辑不变），删除私有中继副本；中继死亡不再回收整个 E2B 环境。一致性测试 tests/execution/sandbox-endpoint-conformance.test.ts 对 in-process、本地子进程、E2B 适配器＋共享 broker（vendor SDK 以本地进程替代）三个 harness 运行同一组断言；设置 `OPENCRAFT_SANDBOX_CONFORMANCE_DOCKER=<含 python3 的镜像>` 时追加真实 `docker exec -i`＋broker harness（本机 `python:3.12-alpine` 通过）。未做：真实 E2B 冒烟；Cloudflare 无实现。

**测量门禁数据（2026-11-23，4 vCPU 云开发容器，cgroup v1 Docker 29.10；每项先预热 3 次）。** "端点"＝`openSandboxEndpoint`＋1 字节回显往返＋关闭；"一次性进程"＝spawn `python3 -I -c pass` 到退出，对应今天每次文件操作一个 helper 的模式。

| harness | 端点 p50／p95 | 一次性进程 p50／p95 | 32 并发端点（全部完成） | 128 并发端点（全部完成） |
| --- | --- | --- | --- | --- |
| in-process（无真实进程，下限参照） | 0.1／0.6 ms | 不适用 | 13 ms | 21 ms |
| 本地子进程（无 broker） | 15／17 ms | 12／15 ms | 154 ms | 598 ms |
| E2B 适配器＋broker，本地进程替代 SDK | 37／39 ms | 35／47 ms | 379 ms | 1381 ms |
| 真实容器：`docker exec -i`＋broker | 116／142 ms | 114／135 ms | 1074 ms | 4596 ms |

所有并发连接均成功。结论（仅就已测 provider）：每条长寿连接一个进程可接受（callback lane 上限 32，冷建立约 1 s）；**每次文件操作一个 `docker exec` 进程（约 115 ms）代价过高**，第 4b 步应让文件操作走容器内常驻进程（一条 attached 连接承载多个请求），终端与浏览器保持每连接一个进程。**真实 E2B（含 gRPC 与网络往返）未测量**，以它为目标 provider 之前必须补测，测量方法即上述 harness。Cloudflare 的 `container.exec` 启动与中继建立见 §3.6 探测结论（exec 启动 8–19 ms，9 个端点并发中继各 4 MiB 共 0.8 s）；同一 harness 的 p50／p95 待 `sandbox-cloudflare` provider 实现后补测。

**第 4b 步现状（2026-11-23）。** `workspace-agent`（scripts/container-deployment/workspace-agent.mjs、`-application`、`-supervisor`、`-roles`）取代 host.mjs 与 hands-application 各自的子进程监督，是所有工作区容器的同一入口：通用 supervisor 不含 provider 或角色分支，角色（`brain`、`hands`、`browser`）只是装配。Compose `brain` 运行 `workspace-agent.mjs --role brain`；`hands` 运行 `native-hands.mjs`，即同一 agent 的 `hands`＋`browser` 角色（产品仍可经 `OPENCRAFT_CONTAINER_HANDS_ENTRY` 组合服务）。第 5b 步合并容器时只需一个 agent 选择 `brain`＋`hands` 角色。

- **监督。** 子进程按角色顺序启动并等待就绪（brain：等待 `proxy`→读 Hands 化身→AppServer（独立进程组）→DSH、Pi；hands：exec、terminal、files；browser 可选）。任一关键子进程退出或无法启动即按逆序停止其余子进程（`SIGTERM`，超时 `SIGKILL`），释放锁后以 1 退出；Docker 重启容器＝新化身，恢复交给中断 Turn 恢复，不局部重启（§8.3 决定 3）。Hands 化身变化引起的 AppServer 替换是有意替换，不算失败。
- **化身。** 每次启动生成随机 128 位 id，并带 `sha256(bootId:pid:starttime)` 出生证据；经 `control` 端点上报（`opencraft-health agent` 打印），`opencraft-health brain|hands` 要求 agent `healthy` 且角色匹配。化身尚未进入执行租约身份（第 5a 步）。
- **容器私有 run 目录。** `/run/opencraft-agent`（Compose 为 brain、hands 各挂 tmpfs，镜像内也预建 0700 目录；`OPENCRAFT_AGENT_RUN_DIR` 必须在共享挂载之外，启动时清空）。其中：`control.sock`、`endpoints/<名称>`、Pi/DSH/Codex sandbox 启动配置（此前在 `$DATA/run`）、AppServer 原生 listener `codex/native-internal.sock`（新增 `--private-directory`）。Brain 启动时删除旧版本留在 `$DATA/run` 中的这些文件。
- **命名端点。** `@opencraft/sandbox/endpoint` 定义 `SANDBOX_ENDPOINT_NAMES`（`control`、`codex-control`、`codex-native`、`pi`、`dsh`、`exec`、`terminal`、`files`、`browser`）与 `SANDBOX_ENDPOINT_DIRECTORY`；`openSandboxEndpoint` 接受 `{name}`，中继只连接 `<端点目录>/<名称>`；未列名称、同时给 `name` 与 `unix`、相对端点目录都在 spawn 前以 `SANDBOX_POLICY` 拒绝（一致性测试新增一项，各 harness 通过）。agent 只发布白名单名称，目标由角色固定。`{unix}` 只保留给尚未由 agent 监督的 E2B 浏览器 owner（E2B 承载 agent 后删除）。
- **终端 PTY。** 由 Hands 容器中 agent 监督的 terminal owner 持有：客户端断开或 Gateway 重建不结束 PTY（单测经 `endpoints/terminal` 断开重连仍是同一 shell；容器冒烟在 Gateway 重建后续接）；agent 化身变化结束 PTY。
- **文件常驻进程。** Docker 默认路径本来就是 Hands 中的常驻 files owner（`files.sock`）。经沙盒端口的 `SandboxWorkspaceFiles`（E2B 及后续 provider）改为每个绑定一个 **attached 常驻 helper**：一条 stdio 长连接承载多个请求（按 id 的 JSON 行，helper 8 线程并发，最多 64 个在途），整行按序写入、不交错；进程丢失只使在途请求失败、不重发，下一请求启动新进程；单请求 30 s 超时即退役该进程；绑定关闭时回收。
- **root Hands（合入 #522 后）。** root 模式是 `hands`＋`browser` 角色的一种身份／目录装配（scripts/container-deployment/root-hands.mjs），不绕开 agent：Hands 入口在 UID 0 时要求显式 `OPENCRAFT_ROOT_HANDS_*` 契约，通用 `workspace-agent.mjs` 入口拒绝以 UID 0 运行 Hands／browser 角色；agent 以 root 运行并监督 execution、terminal、files（root，私有服务端目录）与 browser（降权到声明的非 root 客户端身份），运行目录仍是固定的 `/run/opencraft-agent`（中继按该路径寻址端点），由 profile 换成 root 私有 tmpfs，link 的 socket 与 ticket 交给客户端身份，Gateway 仍只经命名端点到达。agent 只在端点 socket 属于该 owner 的运行身份时发布。#522 的 hardlink 桥只保留 Brain 仍直连共享执行目录的 `exec-owner.sock`、`files.sock`（第 5b 步前）及其每身份 0600 凭据副本；terminal 与 browser 只经 agent 端点，反向 browser hardlink 删除，健康检查改经 `endpoints/browser`。
- **发布与回退。** 服务入口仍是 `container-service.mjs brain|hands`；`compose-release doctor` 额外检查渲染后的 brain、hands 带私有 `/run/opencraft-agent` tmpfs 且未经卷共享。回退到旧镜像不需额外步骤：旧镜像忽略 tmpfs 与变量，并重新在 `$DATA/run` 写配置。`bin/opencraft-host` 改为 `workspace-agent.mjs --role brain`。

**第 4c 步现状（2026-11-23）。** Gateway 只经沙盒端口到达 Brain、Hands：`default` 工作区的放置是配置 `OPENCRAFT_WORKSPACE_ENVIRONMENTS=static-docker://brain static-docker://hands`，Gateway 只持有 `workspace://default/endpoints/<name>`。

- **契约（provider 中立，`@opencraft/sandbox`）。** `uri`：两种 URI 的解析／格式化（§3.3.3"地址"）。`SandboxReceipt`、`SandboxEnvironment.receipt`、可选 `SandboxBackend.attach(identity, receipt, resources, signal)`、`SandboxPool.attachSandbox`：attach 不创建、不替换，不能证明同一实例即 `SANDBOX_UNAVAILABLE`。`SandboxProviderRegistry.environment(installation, address)`＋定义级 `acceptsTarget`。`workspace`：`probeWorkspaceAgent`／`describeWorkspaceEndpoint`（经 `control` 端点）与 `createWorkspaceRuntime`（按环境 attach 持久化 receipt，否则 create；探测化身并先持久化 `{receipt, agentIncarnation}` 再使用；端点名解析到发布它的环境；中继无法启动时只重绑一次；`observe()` 报告化身变化；不重放字节；`describe` 结果按绑定缓存，agent 探测报告的 `endpointGeneration` 变化（同一化身内就地替换了被描述端点背后的 owner，如 Brain 因 ENV 签发密钥轮换重启 DSH／Pi）时 `observe()` 丢弃该缓存而不重绑）。
- **`static-docker` provider（`@opencraft/sandbox-node/static-docker`）。** 传输选型：（a）`docker exec` 需要 Docker socket，否决；（b）容器网络／loopback TCP 在 `network_mode: host` 下任何容器与宿主进程都可连，且需要另行分发密钥，否决；（c）**每容器一个 link 卷**（Compose 具名 tmpfs 卷，只挂进该容器 `/run/opencraft-link` 与 Gateway `/run/opencraft-links/<服务>`），agent 在其中监听 `link.sock`（0600）并写一次性 ticket：可达性由挂载决定（proxy 等其他服务看不到，`compose-release doctor` 检查），ticket 每次 attach 轮换，新 attach 撤销旧会话并杀掉其进程（隔离旧 Gateway），会话只活到 agent 化身结束；不经共享 `$DATA`。每个沙盒进程＝一条 link 连接，承载与 E2B 相同的共享 broker 帧；agent 默认 `relay-only`：只放行到白名单端点的固定中继，任意命令、终端与 `{unix}` 路径都被拒绝。有效预算＝agent 读到的 cgroup 限额，backend 要求与请求相等（因此 `brain` 也声明 `cpus`／`mem_limit`，默认 4 CPU／8 GiB，`OPENCRAFT_BRAIN_*`）。receipt＝agent 化身，`attach` 只绑定同一化身。
- **`workspace-agent`。** 设置 `OPENCRAFT_AGENT_LINK_DIR` 时在全部角色就绪后服务 link；`control` 新增 `describe`（端点客户端需要的凭据或引擎描述符，只经已认证的通道给出）；`--bare` 为无角色环境（一致性测试的真实容器 harness）。Brain：AppServer 控制面 `codex/control.sock`＋`codex/native.sock`、Pi `pi.sock`、DSH `dsh.sock`（及私有 owner-handoff `dsh-control.sock`）、引擎描述符全部在 `/run/opencraft-agent`；AppServer 控制令牌每化身新生成（`--control-token-file`）；Pi／DSH 新增 Unix socket 监听（`socketPath`；Pi 控制路由与 websocket 同一 socket，客户端支持 `ws+unix://`，TCP 模式保留给其他装配）；DSH 任务目录直接读本容器 AppServer。Hands：`terminal`／`files` 的 `describe` 给出令牌。启动时删除旧版本留在 `$DATA/run` 的 `engine-host.json`、`dsh-host.json`、`codex-app-server.sock`、`native.sock`。
- **Gateway 装配（scripts/container-deployment/gateway-workspace.mjs）。** registry 只登记 `static-docker`；每个被消费端点一个本地监听（`/run/opencraft-gateway/endpoints/<名>`，Gateway 私有 tmpfs），连接经 WorkspaceRuntime；引擎描述符经 `describe` 读取，websocket 地址改写到本地监听；Codex 运行面（`CodexNativeCoreTransport` 的新可选 `runtime`：控制端点、按化身取的令牌、原生 socket）与账号面（`codex-core.sock`）分开；终端、文件令牌复制到私有目录；placement 记录在 `$DATA/workspaces/default/host/placement.json`（StateDocumentStore）。`/health` 每次调用 `observe()`。删除了全部描述符读取与 `coreHealth($DATA/run/…)`。
- **proxy 的 `/native-health`。** 归属判定：AppServer 健康属于其 WorkspaceHost，不属于 AccountCore。`proxy` 服务改为 `--accounts-only`（无运行面，`/health`、`/native-health` 返回 404），不再转发到 Brain；只有恢复路径的内嵌 Core（在 Brain 容器内）仍转发到本容器 AppServer。
- **验证。** 一致性套件对 in-process、本地子进程、E2B 夹具、static-docker link（进程内）各 11 项通过（含 receipt 续接、`workspace://` 解析）；真实容器：static-docker（`opencraft` 镜像的 `workspace-agent --bare`，`--cpus 4 --memory 8g`）与 `docker exec`＋broker 各 11 项通过。URI 解析测试 5 项。Gateway 装配测试：真实 agent＋link（进程内），经端点完成 terminal、codex-native、browser 往返与 Pi 描述符；Gateway 重启后 `attached`；Hands 换化身后 `attach-failed`→`created`；`$DATA/run` 不存在仍工作；源码守卫禁止描述符与 Hands socket 路径。真实 Docker（cgroup v1，假上游、假密钥）：容器冒烟通过（终端探针改经 Gateway 的端点）；Codex Turn 含 Hands exec 经 Gateway；文件操作经 Gateway 的 `files` 端点（32 并发读，顺序元数据 p50 1.6 ms）；Pi Turn 经 Gateway；Gateway 重建后同一 PTY、Brain／Hands 容器与化身不变并按 receipt `attached`；kill Brain 的 engine-host 后容器以新化身重启，Gateway 记录 `attach-failed`→`created prev=<旧化身>`，进行中的 Turn 标记 interrupted 并由一次续接 Turn 完成，长命令未重跑、用户输入未重复；`$DATA/run` 只剩 `codex-core.sock` 与 `proxy-callers/`。
- **复验（2026-11-23，接手后以当前源码重建镜像）。** `npm run smoke:container` 通过；真实 Docker 验收（假 Responses 上游、假密钥、隔离数据目录与独立 Compose 项目）：Codex Turn 的 exec 在 Hands cgroup 中执行；Gateway 内经 `files` 端点 32 并发读通过（顺序元数据 p50 1.4 ms）；Gateway 只见 `/run/opencraft-links/{brain,hands}` 与自身端点目录，`$DATA/run` 只有 `codex-core.sock`、`proxy-callers`；`--force-recreate gateway` 后两个容器 ID、启动时间与化身不变，日志为 `released`→`attached`，无 `created`；kill Brain 的 engine-host 后 Brain 以新化身重启，Gateway 记录 `attach-failed`（重启期间每次 `observe()` 一次）→`created previous=<旧化身>`，placement 更新，进行中 Turn 标记 interrupted 并由一次续接完成，长命令只启动一次、用户输入未重复。真实容器一致性（`opencraft` 镜像 `--bare` 的 static-docker 与 `docker exec`＋broker）连同进程内夹具共 66 项通过。修复：新 attach 撤销旧会话时原先只 SIGKILL broker，broker 的子进程在独立 session 中会成为孤儿；改为结束 broker 控制输入（broker 随即 killpg），SIGKILL 只作兜底（tests/server/workspace-agent.test.mjs 回归测试）。

**第 4c 步之后剩余。**

- **AccountCore（§5，不属于 4c）**：`run/codex-core.sock`、`daemon.token`（Gateway、Brain 仍以它访问账号 Core）与 `proxy-callers/`。
- **第 4d 步**：Brain 到 Gateway 的反向请求（工作区授权 socket、session-capability MCP `http://127.0.0.1/mcp` 与 `$DATA/session-capabilities.json`、Git broker）仍经 loopback／共享目录；`/__opencraft_health` 仍回显 appServer 目标（既有行为）。
- **第 5a 步**：执行租约与 Git 来源仍读 `/proc`（`pid: host` 仍需要）；化身已经可经 `control` 读到，尚未进入租约身份。
- **第 5b 步**：Brain 经 `execution/exec-owner.sock`（`hands-unix`）到 Hands；`network_mode: host`；两个环境 URI 合并为一个。
- **第 5c 步／第 6 步**：`CODEX_HOME`、Pi、DSH 数据仍在共享 `$DATA`；Gateway 仍挂载整个 `$DATA`（服务器核心需要），只是不再读 Brain／Hands 的描述符与 socket。
- **未做**：held-promise＋丢 ack 的定向测试；callback lane 15 s 窗口的真实测量；真实 E2B（含 `Sandbox.connect`）冒烟；Electron／Cloudflare 只在 §3.6 给出映射（docker-provisioner 见第 7b 步现状）。
- **Cloudflare 探测得出的契约项**（状态表见 [execution-sandbox](../execution/execution-sandbox.md#provider-lifecycle-obligations-from-the-cloudflare-containers-probe)）：receipt＝化身 id、端点传输需背压与半关闭、PID 1 处理 SIGTERM、broker 在 stdin EOF 时 killpg 已满足；其余列为下文"Cloudflare provider 前置项"。

**后续顺序（2026-11-23）。** 4c 已完成（0c77df3）。下一步依次为：（1）`sandbox-cloudflare` provider（7a，同一一致性套件；provider 已实现，见 §3.6"实现现状"）；（2）`docker-provisioner`（7b，与 7a 同为第 7 步多工作区的实现）；（3）WorkspaceHost 合库（账本按 schema id 区分，推荐方案，待实施）；（4）4d、5a、5b、5c。

**第 7b 步现状（2026-11-23）。** 多工作区的第一个实现：`docker-provisioner`。

- **服务边界。** Compose overlay `deploy/docker/compose.workspaces.yaml` 新增 `provisioner` 服务：唯一挂载 Docker socket 的服务，以部署用户＋socket 所属组运行（非 root），`network_mode: none`、只读根文件系统、`cap_drop: ALL`、`no-new-privileges`。它与 Gateway 只共享私有 tmpfs 卷 `provisioner-control`（`provisioner.sock` 0600 与每次启动新生成的 `request.key` 0600）。Gateway 不挂 socket、无 `DOCKER_HOST`（真实 Docker 验证）。默认部署（不加 overlay）不变，仍只有 `default` 工作区。
- **协议 1（`@opencraft/sandbox-node/docker-provisioner`）。** 每连接一行请求一行应答：`{protocol, op, workspace, image?, nonce, issuedAt, mac}`，`op` 只有 `ensure`（按白名单别名创建，或启动已停止的容器）、`inspect`、`stop`、`destroy`；`mac`＝请求密钥对规范字段的 HMAC-SHA256；±30 s 时间窗、nonce 一次性；多余字段、非法工作区 id、非白名单别名在调用 Docker 之前拒绝；每个请求（接受或拒绝）一行 `docker-provisioner-audit` 审计日志（不含 mac、nonce）。调用方不能传任何 Docker 参数。
- **策略（`docker-provisioner-service`）。** 镜像、命令、用户、CPU／内存／pids、卷挂载点、网络、额外挂载只来自服务端策略（默认由环境变量生成一个别名 `workspace`＝部署镜像的 `workspace-agent --role hands`；或 `OPENCRAFT_PROVISIONER_POLICY_FILE` 严格校验的 JSON）：UID 0 需显式 `root: true`；Docker／containerd socket、`/`、`/proc`、`/sys`、`/dev`、`/etc`、`/run`、`/var/lib/docker` 等来源与覆盖 link／agent 运行目录的挂载被拒；从不拉取镜像；只操作带部署标签的容器、卷与网络，同名但非本部署的对象拒绝触碰。容器：`CapDrop ALL`、`no-new-privileges`、`init`、预算即 cgroup 限额（agent 读到的限额必须等于 Gateway 请求）、ICC 关闭的私有 bridge 网络、一个 named volume（缓存）、`unless-stopped`、私有 `/run/opencraft-agent` tmpfs。容量上限 `maxWorkspaces`。按工作区串行执行操作。
- **到达方式。** 不用 `docker exec`（否则 Gateway 需要 socket 或 provisioner 转发字节流）。links 卷挂进 provisioner 与 Gateway（`/run/opencraft-links/provisioned`）；provisioner 为每个工作区建 `<id>/`（0700，属部署用户），只把该 subpath（Docker `VolumeOptions.Subpath`）挂进该容器的 `/run/opencraft-link`，agent 在其中服务与 `static-docker` 相同的 link（一次性 ticket、单会话、`relay-only`）。`static-docker` 的 Host 侧绑定抽为 `bindSandboxLink` 供两者共用。
- **provider。** `create`＝`ensure`＋等待 agent 开始服务 link 后绑定（任何化身）；`attach(receipt)`＝`inspect` 确认同一容器仍在运行＋link 绑定预期化身，绝不启动已停止的容器；环境 `close()` 只结束 Gateway 的 link 会话（容器保留供续接，与 `static-docker` 一致）；`sleep`＝结束会话＋`docker stop`（卷保留，下次 `create` 启动同一容器＝新化身）；`discard`＝删除容器、卷与 link 目录。
- **契约（最小、可选、向后兼容）。** `SandboxBackend.sleep?(environment, signal)`（§3.7.1 草图的形状）与 `discard?(identity, receipt, signal)`；池暴露 `Sandbox.sleep?()` 与可选 `SandboxPool.discardSandbox?()`；`WorkspaceRuntime.sleep()`（不支持的 provider 保持常驻）与 `discard()`（不支持即 `SANDBOX_UNAVAILABLE`，保留 receipt）。"环境丢失"信号、`snapshot` 声明与 WH 空闲判定未在本步实现。
- **Gateway 多工作区（最小）。** `gateway-workspace.mjs` 的 `provisionedWorkspaces`：`default` 仍按 `OPENCRAFT_WORKSPACE_ENVIRONMENTS`（`static-docker`），其他工作区 id 按 `OPENCRAFT_WORKSPACE_PROVISIONED_ENVIRONMENTS`（如 `docker-provisioner://workspace`）放置，各自 `$DATA/workspaces/<id>/host/placement.json`、本地端点 `/run/opencraft-gateway/workspaces/<id>/endpoints/<名>` 与凭据副本；领域代码无部署分支。`OPENCRAFT_WORKSPACES` 列出启动即放置的工作区（失败只记录，不阻塞 Gateway）。运维入口 `runtime/workspace-admin.mjs open|sleep|discard <id>`（Gateway 停止时在一次性 Gateway 容器中运行，保持单写者）。
- **验证。** 进程内（tests/server/docker-provisioner.test.mjs，真实 provisioner 服务＋假 Docker Engine＋进程内 agent）：策略拒绝不安全配置；未签名、篡改、过期、重放、多余字段、非白名单别名全部拒绝且不触达 Docker；外部同名容器不被删除；创建参数固定；Gateway 放置第二个工作区：创建、重启后 `attached`、休眠／唤醒（新化身、同一容器）、丢弃（容器、卷、link、placement 清除）。一致性：真实 Docker 下 docker-provisioner harness 11 项通过，连同 in-process、本地进程、E2B 夹具、static-docker link／容器、`docker exec` 共 77 项。真实 Compose（cgroup v1，Docker 29.10，无浏览器的测试镜像，Hands 只跑 `hands` 角色）：gateway＋proxy＋brain＋hands＋provisioner 全部健康；Gateway 容器无 socket；Gateway 启动时经 provider 创建 `ws-two` 容器（用户 1000、2 CPU／2 GiB／4096 pids、`CapDrop ALL`、私有网络、只有 link subpath 与工作区卷两个挂载，看不到 provisioner 控制目录）；Gateway 经 `ws-two` 的 terminal 端点开 PTY 并执行命令（cgroup 路径证明在 `ws-two` 容器内）；`--force-recreate gateway` 后 `attached` 同一化身、容器 StartedAt 不变、同一 PTY 续接；Gateway 容器内伪造签名的 `destroy` 被拒（`unauthenticated`）；休眠后容器 `exited`、唤醒为新化身同一容器；丢弃后容器、卷、link 目录均回收；审计日志逐条记录。
- **剩余。** 产品／UI 创建工作区入口；WH 空闲判定与唤醒定时器（§3.7.2）；Docker 事件驱动的"环境丢失"信号；provisioner 重启轮换密钥时 Gateway 下一请求自动读新密钥（已如此），但进行中的请求会失败；Brain 角色（AppServer／Pi／DSH）进入 provisioned 容器依赖 4d、5a–5c；镜像固定（digest）与迁移；Docker 主机重启后续接（化身变化，走恢复）未做真实演练。

**Cloudflare provider 前置项（7a 的前置或同步项；前四项对 `docker-provisioner` 同样有用，不是 Cloudflare 专属）。**

1. **契约级"环境丢失"信号**（**已实现**：可选 `SandboxEnvironment.lost: Promise<SandboxLoss>`，只在 owner 未 close 时落定、永不 reject；池原样转交；`WorkspaceRuntime` 收到即释放绑定并发出 `released`／`lost:<reason>`，下次使用 attach 或新建；Cloudflare 由 `monitor()` 驱动；static-docker、E2B 不提供，行为不变；Docker 容器退出事件留给 `docker-provisioner`）：`SandboxEnvironment` 增加可选的丢失通知，由 provider 主动停止或崩溃触发（Cloudflare 由 `monitor()` 抛错驱动；Docker 由容器退出事件驱动）；`WorkspaceRuntime` 据此立即走恢复，而不是等下一次中继启动失败或 `observe()`。
2. **agent 侧进程回收**（broker 承载的进程已满足：每个 exec 都是读控制输入的 broker，句柄丢失即 EOF→killpg；`workspace-agent` 在 link／端点连接结束时回收其直接子进程仍未做）：DO 重置时 exec 的 stdin 不一定 EOF（不读 stdin 的进程成孤儿），`workspace-agent` 在 link／端点连接结束时主动回收对应进程 session，不依赖 stdin EOF。
3. **对已退出进程 kill 的防护**（Cloudflare backend 已实现：只对 `exitCode` 未落定的 exec 发信号；broker 内 killpg 的 PID 复用检查未改）：kill 前确认进程仍属同一 session 且未退出，已退出即视为终止已确认，避免误杀 PID 复用的进程或把已退出报告为清理失败。
4. **可选原生 `connectEndpoint(target)`**（未做：契约无该位置，中继已满足一致性套件）：backend 能直接连接容器内端点时优先于中继（Cloudflare 原始 TCP：agent 在一个端口上按连接前导行路由到对应 UDS）；不能连接时回退中继，语义（背压、半关闭、无重放）相同。
5. **每次 DO 重启重设 inactivity timeout**（§3.7.2），并在构造中按化身比对 `attach`（已实现：backend 初始化、start、attach 时设置；`armCloudflareContainerTimeout` 供 DO 构造调用；attach 按标签＋boot id＋placement 比对）。

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
5. **密度与成本。** 每工作区一个 AppServer＋Pi＋DSH＋浏览器的内存基线未测量；默认 4 vCPU／8 GiB 预算是按工作区还是全机共享，需要与 Assets 预算账本统一。空闲策略已决定（§8.4 决定 8，默认 15 分钟休眠；Cloudflare 冷启动／唤醒约 0.6 s，见 §3.6）。
6. **AppServer 共享还是按工作区。** 一个共享 AppServer 按线程路由到不同 Hands 环境（今天 `resolveWorkspace` 已支持）成本更低，但 `CODEX_HOME` 共享，不满足"工作区隔离 Brain"。是否接受"小部署共享、隔离部署按工作区"两种装配。
7. **Token usage 与 Bot／IOA 表的归属**（§4.1、§4.2）。
8. ~~Brain 与 Hands 是否合并~~：已决定合并为一个工作区容器（§3.2，第 5b 步）。

### 8.3 决定二：放置设计（2026-11-23，用户决定）

1. **模型流量不经 sandbox stdio。** 容器经网络到达账号代理／AccountCore，只持有短期令牌（§5）。
2. **终端 PTY 由 `workspace-agent` 持有**，WorkspaceHost 断开后仍存活；重连只是重新 attach（第 4b 步）。容器化身变化仍结束 PTY。
3. **任一关键子进程失败，`workspace-agent` 整体退出**＝容器化身变化；恢复复用中断 Turn 恢复，不做局部重启监督。
4. **浏览器为可选组件，不在第一里程碑。** 去除 host 网络先针对 Brain＋Hands（第 5b 步）。
5. **多工作区实现 `docker-provisioner`**；它持有 Docker socket 的授权必须作为单独设计的服务边界（Gateway 仍永不持有 socket）。其次 E2B。2026-11-23 调整顺序：`sandbox-cloudflare` 先行，`docker-provisioner` 随后，两者同为第 7 步的实现（§7 后续顺序）。
6. **边界是"容器内无长期凭据"。** Git 与模型访问得到单次／短期、按范围限定的凭据。

### 8.4 决定三：持久化、空闲与 Git broker（2026-11-23，用户决定）

7. **工作区持久化契约与 provider 无关**：Git 是工作区内容的持久真源，容器／沙盒是可重建缓存；快照是 provider 的可选能力（Cloudflare 容器快照、E2B pause／resume、Docker 卷），只加速恢复、降低未提交改动丢失概率；未提交改动可能随化身丢失；不依赖任何 provider 的 beta 能力兜底（§3.7.1）。
8. **空闲策略是通用配置**：默认空闲 15 分钟后休眠，工作区可配置为常驻；"空闲"由 WorkspaceHost 判定，provider 只负责映射（§3.7.2）。
9. **服务端 Git broker 保留原 JSON 实现**，不迁移、不退役，供下一代可能使用（§4.1）。

## 9. 与早期调查不一致之处

- `$DATA/codex` 并非只属于 Gateway：同一目录同时是账号 Core 数据根（`account-pool.sqlite`、`.codex-writer.sqlite`）、Brain AppServer runtime 根（`.codex-runtime.sqlite`、`runtime/`＝`CODEX_HOME`）与 Gateway Host overlays 根（host.mjs:122；proxy-core.mjs:13；headless-application.mjs:1099）。三个 owner 以三把不同的锁共存于一个目录，迁移必须逐项区分。
- 模型凭据不只在账号 Core：`$DATA/models/credentials.json` 被 Gateway、Pi、DSH 共同读取；`proxy` 模式也未覆盖所有 provider。
- `pid: host` 的依赖不止执行租约：Gateway 的 Git 身份来源校验也读取 Brain 进程的 `/proc`。
- 15 s 是 Brain 侧 callback lane 的断开窗口（orchestration-callback-lane.ts:374），不是 Gateway 的重连间隔。
- 已存在多 `CODEX_HOME` 机制（Generation Router）与按工作区 Hands 路由（`resolveWorkspace`），本设计应复用其语义而非另造。
