# 工作区放置作为部署配置（草案，待合并入 workspace-host-split.md）

状态：**调查＋提议，未实施。** 回答"Brain 和 Hands 放在哪里，是否是可变配置"。现状以 2026-11-23 源码为准；目标与步骤是提议，用于替换 [workspace-host-split.md](workspace-host-split.md) §3.3 的 lane 设计与 §7 第 4–5 步。已定前提：单位＝Workspace（默认每 Thread 专属）；Brain＋Hands 同一容器；容器内无凭据；Generation Router 已删。

**一句话结论。** 今天放置**不是**配置：Docker 上的 Brain／Hands 由 Compose 静态启动，Gateway 经 `$DATA/run` 描述符、UDS、loopback 端口和 `/proc` 找到它们；只有 Hands 侧（exec-server、终端、文件、浏览器）在 E2B 路径上已经是"`sandbox.spawn`＋stdio"。目标是让 Brain 也走同一端口：WorkspaceHost 只持有 `SandboxEnvironment`，provider（静态 Docker／Docker provisioner／E2B／Cloudflare）由部署装配选择，差异只剩 provider 配置与镜像。

## 1. 现状：每个组件如何启动、如何被找到

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

## 2. 已经是"经 sandbox.spawn＋stdio"的部分（E2B／普通会话）

- **端口**：`SandboxBackend.create → SandboxEnvironment.spawn(command) → SandboxProcess{writeStdin, exited, terminate, resize}`（packages/sandbox/src/contract.ts:20-55）。provider 由 `createSandboxProviderRegistry` 显式注册、按 installation `backend` 选择，不回退（providers.ts:83-118）。
- **共享 broker**：provider 只提供"启动 broker 并给一条双工"（`SandboxBrokerLaunch`，broker.ts:92-100）；帧、PTY（`pty.openpty`）、进程组、终止都在 broker（broker.ts:12-55、131）。E2B 用 `commands.run(stdin:true)`＋`sendStdin` 实现（packages/sandbox-e2b/src/index.ts:319-345）。Cloudflare 文档已规定复用同一 broker（cloudflare-deployment.md §1）。
- **exec-server**：`createSandboxConversationBinding` spawn `codex exec-server --listen stdio`，`createSandboxJsonRpcBridge` 把 stdio 换成 Gateway 进程内的 `ws://127.0.0.1:<port>/<capability>`，再经 `environment/add` 注册给 AppServer（apps/local-agent-host/src/sandbox-conversation-binding.ts:49-58；packages/sandbox-node/src/json-rpc-bridge.ts:16-130；codex-core/src/workspace-execution-policy.ts:39-41）。**这要求 AppServer 能访问 Gateway 的 loopback**（workspace-execution-channel.ts:43 校验 `ws://127.0.0.1`），即依赖 host 网络。
- **终端**：`SandboxProcessService` 以 `terminal` 维度 spawn（PTY 经 broker）（apps/local-agent-host/src/sandbox-process-service.ts:114）。
- **文件**：每次操作 spawn 一个 Python helper（sandbox-workspace-files.ts:56）。
- **浏览器**：spawn 浏览器 owner（容器内 UDS），再 spawn 一个 Python **stdio↔UDS 中继**连接它（apps/headless-server/src/workspaces/sandbox-browser-runtime.ts:83-101；apps/local-agent-host/src/sandbox-browser-owner.ts:5、117）。**这正是通用的"经 stdio 到达容器内 socket"原语，只是目前是浏览器私有实现。**

**Codex stdio 能力。** 固定版本 `@openai/codex 0.162.1`（runtime/codex/package.json:6）；`app-server --listen stdio://` 已在真实测试中使用（tests/execution/native-empty-thread-index.real.test.ts:20；session-mcp-native.test.ts:24）。但 stdio 只有**一条**连接，而 AppServer owner 今天对原生开 1 条 owner lane＋每个 callback lane 1 条（orchestration-callback-lane.ts:72、358-366）。因此**不应把原生 AppServer 改成 stdio**；应让容器内 Node owner 继续用容器私有 UDS 连原生，只把 owner 的对外面暴露到 sandbox 通道上。

**本地 backend 能否充当本地 provider。** `hands-unix` 每连接一个固定向量 exec-server、不支持 terminal（hands-unix.ts:101-102、202-205），`linux-systemd` 是本机 transient unit（systemd.ts:132-205）。二者都不能创建"带镜像的工作区容器"。可复用的是：`hands-unix` 的"容器内 owner 监听私有 UDS、token 握手、lease 帧"模式，以及 broker 协议本身。

## 3. 差距

| 现状 | 目标 | 可复用 |
| --- | --- | --- |
| Brain 进程是 Compose 服务，host.mjs 启动 | 容器内常驻 `workspace-agent`（即瘦身的 host.mjs）作为容器入口，被 provider 启动 | host.mjs 的启动顺序、就绪等待、AppServer 替换（:113-160） |
| Gateway 读 `$DATA/run/*.json`、`*.sock`、loopback | WH 经 `SandboxEnvironment` 打开**命名端点**的字节流 | 浏览器 stdio↔UDS 中继；`json-rpc-bridge` 的本地 capability 监听 |
| AppServer 经 Gateway loopback 连 exec-server | 同容器：AppServer 的 sandbox runner 在容器内直接 spawn exec-server（同 `include_local=false` 约束） | `configureCodexExecutionSandbox`（codex-core/src/execution-sandbox.ts:18） |
| 容器→Gateway：授权 socket、session-capability MCP、Git broker、任务目录 | 容器内 `workspace-agent` 提供这些 UDS，经一条**反向 RPC 进程流**转给 WH | 现有请求/应答协议不变，只换端点 |
| Gateway 读 `/proc` 得化身；Git broker 读 `/proc` 树 | `workspace-agent` 在容器内计算并签名上报；Git peer 校验在容器内完成 | `observeNativeExecutionProcess`、`readGitProcess` 原样搬进容器 |
| 化身来自 `bootId+pid+startTicks` 与 `hands-incarnation` 探测 | `{environmentInstanceId, agentIncarnation, leaseEpoch}`；environment 实例来自 provider receipt | E2B `onCreated` receipt（providers.ts:21-22） |
| `CODEX_HOME=$DATA/codex/runtime`，共享 `$DATA` | 工作区私有卷：`/workspace` 之外的 `/var/lib/opencraft-workspace/{codex,pi,agent}` | `PersistentWorkspaceProvider.privateVolumeId`（providers.ts:30-58） |
| broker 任一进程传输失败即 `closeEnvironment()` 回收整个环境（broker.ts:152-162、289） | **attach 类进程**（中继）断开只结束该进程；Brain 不随 WH 断开而死 | 在 `SandboxCommand` 增一个 `lifetime: "attached"` 语义，broker 只终止该进程 |
| 端口只有 `create`；Gateway 重启后无法重连已存在实例（E2B 注释"never resumes"，providers.ts:23-24） | 可选能力 `attach(receipt)`：按已登记 receipt 重连同一实例，不重建 | E2B `Sandbox.connect`；Docker 按容器 ID；静态 provider 天然可重连 |
| 每 backend 一个 `templateId`（providers.ts:13） | 每工作区记录 `{provider, image}`，create 时携带 | Router 的"按 Thread 固定版本"语义 |

## 4. 提议设计

### 4.1 组件图

```
 Gateway 进程（或独立 workspace-host 服务）
 ┌──────────────────────────────────────────────────────────────┐
 │ WorkspaceHost(ws-A)  ── Host 状态库／恢复／定时器（已完成 2–3 步）│
 │   └─ WorkspaceRuntime  ── 只依赖 SandboxEnvironment            │
 │        ├─ endpoint("codex-control") → 本地 UDS 适配 → CodexCoreControlClient
 │        ├─ endpoint("codex-native")  → 本地 UDS 适配 → CodexCoreSocket(+lane)
 │        ├─ endpoint("pi"|"dsh")      → 本地 UDS 适配 → engine/dsh client
 │        ├─ terminal / files / browser（现有 SandboxProcessService 等）
 │        └─ reverse RPC 进程 ← 授权／session-cap／Git／任务目录请求
 └───────────────┬──────────────────────────────────────────────┘
                 │ SandboxBackend（部署装配选择，WH 不 import vendor）
     ┌───────────┼───────────────┬──────────────────┐
  static-docker  docker-provisioner  e2b            cloudflare（后续）
 （私有 UDS broker）（持 socket 的独立服务）（commands.run）（container exec）
                 │ 每个"进程"＝一条 broker 流（stdin/stdout）
 工作区容器（镜像按 digest 固定；无凭据；工作区私有卷）
 ┌──────────────────────────────────────────────────────────────┐
 │ workspace-agent（容器入口，常驻 supervisor，不是 WH 的子进程）   │
 │   ├─ codex-app-server owner ─UDS─ codex app-server（CODEX_HOME 在私有卷）
 │   │     └─ sandbox runner：容器内 spawn exec-server --listen stdio
 │   ├─ engine-host(Pi)、dsh-host（监听容器私有 UDS）              │
 │   ├─ 终端／文件／浏览器 owner                                   │
 │   └─ 反向端点 UDS：authority、session-cap MCP、git-broker、model-egress
 │ relay（python 中继，按需 spawn，生命周期＝一条连接）             │
 └──────────────────────────────────────────────────────────────┘
```

### 4.2 最小新抽象（只三个）

1. **`openEndpoint(sandbox, name)`**（`@opencraft/sandbox` 层，纯函数）：spawn 固定中继命令 `relay <name>`（`lifetime:"attached"`），返回字节双工。WH 侧再用 `json-rpc-bridge` 同款的"私有 capability 本地监听"把它变成本地 UDS，让 `CodexCoreSocket`、`CodexCoreControlClient`、engine/dsh client 不改代码。**每条连接＝一个沙盒进程**：多路复用、背压与断开都由 provider 的进程流承担，不自建 `WorkspaceLink` 帧协议。名称→容器内 socket 的映射由镜像内 `workspace-agent` 固定，不接受任意路径。浏览器中继迁移到它后删除私有副本。
2. **`workspace-agent`**：现 host.mjs 去掉 `$DATA` 共享与描述符发布后的容器入口。职责：启动／监督 Brain 进程、AppServer 替换、在容器内计算化身与 Git peer 校验、提供反向端点。对外只有 `control` 端点（health、incarnation、引擎清单、drain）。它**由 provider 作为容器主进程启动**，不是某条 broker 流的子进程，所以 WH／Gateway 重启不杀 Brain（保留 README:13 的现有性质）。
3. **`SandboxBackend` 两个可选能力**：`attach(receipt) → SandboxEnvironment`（重连既有实例，未知即失败、不重建）与 create 参数里的 `image`（取代 backend 级 `templateId`）。broker 增 `lifetime:"attached"`：该进程传输失败只结束它自己，不 `closeEnvironment()`；默认仍是今天的严格语义。

**反向方向**不新建监听：WH 在连接建立后 spawn 一个长寿 `reverse` 进程（attached），容器内反向端点的每个请求作为一行 JSON 写到它的 stdout，WH 处理后写回 stdin。只承载今天已有的请求/应答协议（授权策略、session capability、Git broker、任务目录），都是小报文；断开时容器内调用方得到"不可用"，与今天 socket 不可达一致，不重放。**模型流量不走这里**（见 §6 风险 1）。

### 4.3 WorkspaceHost 如何使用

```
open(ws): rec = 读 WH 持久记录 {provider, image, receipt?, leaseEpoch}
  env = receipt ? backend.attach(receipt) : backend.create(identity, resources, {image})
  提交 receipt、leaseEpoch+1（先持久化再接纳）
  ctl = openEndpoint(env, "control"); 校验 {agentIncarnation, environmentInstanceId}
  化身不同于上次登记 → 走中断恢复；相同 → 续接
  按需 openEndpoint("codex-native"| "pi" | ...)，交给现有 adapter
close/idle: drain → env.close()（删除实例；卷保留由 PersistentWorkspaceProvider 管）
```

执行租约身份＝`[environmentInstanceId, agentIncarnation, 原生进程化身(容器内计算)]`，不再读宿主 `/proc`。旧格式租约按 §3.4 规则失效。

### 4.4 provider 只是配置

| provider | create | 每进程流 | attach | 持久卷 | Gateway 需要 Docker socket |
| --- | --- | --- | --- | --- | --- |
| `static-docker`（默认单工作区） | 不创建：Compose 声明的 `workspace` 容器，`workspace-agent` 在私有 UDS 上提供 broker（`hands-unix` 握手＋broker 帧，去掉固定向量，改为镜像内命令白名单） | UDS 连接 | 天然 | bind mount | 否 |
| `docker-provisioner`（多工作区，可选） | 独立 provisioner 服务持 socket，只接受 WH 签名请求；`docker run` 带 `--cpus/--memory/--pids-limit`、工作区卷、私有 bridge 网络 | `docker exec -i` 的 hijacked stream | 按容器 ID | named volume | 否（socket 只在 provisioner） |
| `e2b` | 现有 backend，template＝工作区镜像 | `commands.run(stdin)` | `Sandbox.connect`（新增） | 现有 privateVolume | 否 |
| `cloudflare`（后续） | Container 由 WH DO 持有 | `container.exec` stdin（PoC 项，cloudflare-deployment.md §4） | DO 内天然 | R2/快照（PoC） | 不适用 |

部署装配只写一份：`{backend, options, image, resources}`。Electron／本机 Host 不经过本设计。

### 4.5 镜像固定（Generation Router 的后继自然落出）

工作区记录持有 `image`（digest）。升级＝改部署默认镜像：新工作区（默认每 Thread 专属＝新 Thread）用新镜像；已存在工作区保持旧镜像直到空闲回收或显式迁移（迁移＝drain 后以新镜像 create、同一卷、走恢复）。不需要 registry、路由库或多 `CODEX_HOME` 并存于一个进程。`static-docker` 只有一个镜像，升级规则保持 README 现状（先等待活动任务）。

## 5. 分步计划（替换 §7 第 4–5 步；每步先在 Node／Docker 上成立）

| 步 | 内容 | 验证 |
| --- | --- | --- |
| 4a | 抽出 `openEndpoint`＋`lifetime:"attached"`；浏览器中继改用它。无部署变化 | broker 单测：attached 进程断开不触发 `closeEnvironment`，默认进程仍触发；浏览器 sandbox 测试；E2B 真实冒烟一次 |
| 4b | `workspace-agent`：host.mjs 改为在容器私有 run 目录发布 UDS（不写 `$DATA/run`），引擎 host 改听 UDS；提供 `control` 与命名端点；仍跑在现 `brain` 容器 | 现有容器冒烟（scripts/smoke/server/smoke-container.mjs）不变通过；端点名白名单拒绝任意路径 |
| 4c | `static-docker` provider：`brain` 内 `workspace-agent` 在私有挂载 UDS 上服务 broker；Gateway 的 `default` WH 改经该 provider＋`openEndpoint` 访问 codex-control/native、Pi、DSH，删除描述符读取（gateway-application.mjs:14-17、34-43） | 真实 Docker：Gateway 重建后续接同一化身；断开时未确认变更不重发（held-promise＋丢 ack）；callback lane 15 s 窗口语义不变 |
| 4d | 反向 RPC 进程：授权 socket、session-capability MCP、任务目录改经它；签名密钥留 WH，容器只拿短期 token | 撤销授权后容器内请求被拒；WH 断开期间请求失败而非排队 |
| 5a | 化身与 Git peer 校验移入 `workspace-agent`，经 `control` 签名上报；删除 Gateway 的 `/proc` 读取 | PID 重用测试；Git 来源租约在新格式下通过、旧格式失效走恢复 |
| 5b | 合并 `hands` 进 `brain` 为单个 `workspace` 容器；AppServer 容器内直接 spawn exec-server；删除 `hands-unix` 固定向量路径与 `pid: host`、`network_mode: host`（浏览器出网另评估） | 真实 Docker：去掉两项后执行租约、Git、恢复、终端、浏览器冒烟；`/proc` 不可见检查 |
| 5c | `CODEX_HOME`、Pi、DSH 数据移到工作区私有卷（与 §6.2 冷迁移合并执行） | 从上一版本数据目录升级、中途 kill 重跑、回退演练 |

此后 §7 第 7 步（多工作区）缩小为"实现 `docker-provisioner` 或启用 `e2b` 承载 Brain 镜像＋`attach`"，WH 代码不变。

## 6. 风险（如实）

1. **吞吐与编码。** broker 对 stdout 每块做 base64＋JSON（broker.ts:115-125、164-190），开销约 1.4×，单行上限 512 KiB；E2B 每条流还过一层 gRPC。原生 AppServer 的历史读取、大 diff、截图会受影响。缓解：读路径已有 `CodexCoreReadIsolation`；必要时 broker 加二进制帧版本。模型流量**不**走 broker：Docker 上容器经私有网络到 AC 代理并持短期租约 token；Cloudflare 上交给出站处理（与 §5 一致）。这是对"全部经 stdio"前提的有意例外，需确认。
2. **连接数＝进程数。** 每个 callback lane、每次文件操作都是一个沙盒进程。E2B 的进程创建延迟与并发上限未测；文件操作可改为复用一条 attached 进程。
3. **浏览器媒体。** CDP 截屏／录屏帧经 stdio 中继可能成为瓶颈；若不满足，浏览器保留独立 provider 端口（屏幕流）而不是硬塞进 broker。
4. **PTY。** broker 已支持 PTY 与 resize；但终端在 WH 断开时会随 attached 进程结束——与今天"Gateway 重连不结束 PTY"（execution-sandbox.md:207-208）不同。需要让终端会话由 `workspace-agent` 持有、中继只做 attach，或接受该退化。
5. **容器内监督。** Brain 不再由 Compose `restart` 单独拉起；`workspace-agent` 任一子进程失败时是整体退出（今天 host.mjs:59 的语义）还是局部重启，需要明确。整体退出＝容器化身变化＝所有 Thread 走恢复。
6. **合并后的隔离。** 去掉 `hands-unix` 固定向量后，Brain 与执行代码同一信任域；必须靠不同 UID（cloudflare-deployment.md §2.2）与"容器内无凭据"保证，Git broker 也不能把长期 token 放进容器。
7. **重启语义。** `attach` 只能在 receipt 可证明同一实例时成功；未知即视为丢失并恢复，不得重建后假装续接。Docker 主机重启后 named volume 仍在但实例是新的——这是"化身变化"，不是续接。

## 7. 不做

- 不自建 `WorkspaceLink` 帧多路复用协议（§3.3 原设计）：provider 的进程流已是多路复用。
- 不把原生 `codex app-server` 改成 stdio；不改 Codex、exec-server 协议。
- 不让 Gateway 获得 Docker socket；不按操作系统隐式选择 provider；provider 失败不回退本机。
- 不保留 `$DATA/run` 描述符作为兼容通道并行运行（会出现两套到达方式）。
- 不在本阶段做 Cloudflare 适配或 provisioner 弹性调度。

## 8. 待决问题

1. 模型流量例外（风险 1）是否接受，还是要求模型请求也经 broker 流。
2. 终端在 WH 断开时是否必须存活（风险 4）。
3. `workspace-agent` 子进程失败：整体退出还是局部重启（风险 5）。
4. 浏览器是否作为工作区容器的必需组件，还是独立可选 provider（风险 3；也决定 `network_mode: host` 能否完全删除）。
5. `docker-provisioner` 与 `e2b` 谁先作为多工作区 provider。
6. Git 凭据交付：broker 仍需向容器内 git 发放短期凭据，这与"容器内无凭据"的边界如何表述（短期、按命令会话、不落盘）。
