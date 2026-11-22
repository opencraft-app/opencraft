# Headless Gateway 拆分与 Cloudflare 装配

[Architecture index](../README.md) · [可选 Cloudflare 部署](cloudflare-deployment.md) · [Gateway／Brain 按工作区拆分](workspace-host-split.md) · [存储端口](storage-ports.md) · [执行所有权](../execution/execution-ownership.md#client--hub--server-拓扑) · [Docker 三角色部署](../../../deploy/docker/README.md)

状态：**设计草案，未实施任何部分。** 下文"现状"以引用的源码行为准（2026-11-22 核对，行号随并行改动可能漂移）；"目标"与"步骤"均为提议，第 6 节列出需要用户决定的问题。Node／Docker（以及 Electron）是一等公民：每一步先在 Node 上独立成立并可发布；Cloudflare 只是另一组装配，不替换 Node 路径，也不为它另造领域实现。

## 1. 目的与范围

`apps/headless-server/src/headless-application.mjs`（约 1400 行，以下简称 `HA`）的 `startHeadlessServer` 是 Headless Gateway 唯一的组合根：它解析配置、打开全部存储、构造所有 owner、拼装 AppServer transport 链，并由 `createWorkbenchWebServer`（`serve-workbench-web.mjs:741`）在同一个 `node:http` 监听上提供 HTTP、WebSocket 与静态资源。Docker 的 `gateway` 角色也直接复用它（`scripts/container-deployment/gateway-application.mjs:4、28-37`）。

本页回答：这些服务在[目标拓扑](cloudflare-deployment.md#2-目标拓扑)中各归哪个载体；Client 连接在 Cloudflare 上如何终止；如何重构为"同一组 owner＋多个组合根"；以及第一个可运行的 Cloudflare 里程碑需要哪些服务。不设计 DO／Containers 适配器本身，不改变已发布迁移、协议或主体身份。

载体缩写：**EW**＝边缘 Worker，**IC**＝`InstallationCore` DO，**AC**＝`AccountCore` DO，**RH**＝`RelayHub` DO，**WH**＝每工作区 `WorkspaceHost` DO，**容器**＝工作区容器（Brain＋Hands），**Node**＝仅 Node 提供（Cloudflare 装配不声明该能力）。

## 2. 服务清单

"Node 依赖"只列阻碍 workerd 运行的部分；`node:crypto` 等 workerd `nodejs_compat` 可能覆盖的项单独标注"待核实"。

### 2.1 身份、准入与协作（部署级）

| 服务 | 持有 | Node 依赖 | 位置 | 目标 | 理由 |
| --- | --- | --- | --- | --- | --- |
| 服务器核心 owner `openServerCoreOwner` | `opencraft-server.sqlite` 单写者 Worker、identity commit fence | `worker_threads`（`@opencraft/worker-owner`）、`node:sqlite` | HA:276-277 | IC | 已经过 `SqlDatabase` 端口；DO SQL 适配器已在 workerd 通过一致性测试（storage-ports §6） |
| `OrchestrationRuntimeWorker` | **同一个** `opencraft-server.sqlite` 的第二条连接（编排运行时、自动化账本） | `worker_threads`（`orchestration-runtime-store.ts:31`） | HA:278 | IC | 必须与核心 owner 合并为单一连接（cloudflare-deployment §2 已要求） |
| `ServerSpacesRuntime` | **同一个** sqlite 的第三条连接（Server space 账本） | `worker_threads`（`server-spaces-runtime.ts:4`） | HA:635-636 | IC | 同上 |
| `ActorStore`／`MembershipStore`／`InstanceAccess`／`ActorAccess`／`IdentityWrites` | 主体、成员、准入投影；写入经核心 owner | HTTP 处理签名为 `node:http` 类型（`actor-access.ts:1`、`access-control/src/index.ts:9`） | HA:476、481、535、589-608 | IC（状态）＋EW（无状态鉴权读取见 §3.2） | 部署级唯一写者；读取投影可在 IC 内存 |
| `HumanAuth`＋本地账号＋OIDC | 登录会话、身份绑定、OIDC discovery 与回调 | `node:http` 类型（`human-auth.ts:2`）；本地账号 `scrypt`（`plugins/local-account/src/server.ts:1、10`，workerd 兼容待核实）；setup token 私有文件 | HA:515-533；登录页 `human-login-page.ts` | IC（会话与账号写入）＋EW（页面与 OIDC 重定向） | 登录态是 IC 数据；外部 HTTP 往返适合 EW |
| `ThreadAccessStore`／`ThreadAccessSession`／`ServerSpacesSession` | Thread 访问授权与每连接投影 | 无（经核心 owner） | HA:637-685 | IC（授权）；会话对象随 Client 连接（§3.1） | 授权是部署级；会话是每连接的 |
| `Collaboration`＋`CollaborationHttpApi` | 主体协作、输入授权、执行准入、用量提交 | `node:http` 类型（`collaboration.ts:22`） | HA:686-690、703 | IC | Codex adapter 的 `collaboration`／`collaborationInput` 钩子依赖它（HA:1068-1094），是执行准入权威 |
| `ThreadOrchestrationBroker`＋`createProjectAutomations` | 父子编排、助理线程、项目自动化 | 定时依赖 `automation-ledger.ts:5`（`isMainThread`） | HA:692-706 | IC（账本）；到期唤醒用 alarm | 跨工作区编排需部署级 owner |
| `deploymentOperator`／匿名驱动 `AgentDriverTransport` | 匿名部署的操作者上下文 | 无 | HA:640-650 | Node | 匿名模式只适合本机或显式公开；Cloudflare 装配必须启用账号 |
| Hub 控制器 `createHubController` | `hub-network*.json`、HubLink 入站升级 | `node:fs/promises`、`node:http`、`ws`（`hub-network/src/controller.ts:1-2`） | HA:474；升级 `serve-workbench-web.mjs:1182` | IC（节点状态）＋RH（链路与流预算） | 与目标拓扑一致；第一里程碑不需要 |
| `connectRelay`（relay-connect） | 出站中继隧道到本机端口 | `node:net`、`ws`（`plugins/relay-connect/src/server.ts:1-2`） | HA:471、1367 | Node | Cloudflare 本身是公网入口，无需把本机端口中继出去 |
| `ServerInformationStore` | 公开 URL 等部署信息 | `fileStateDocumentStore` | HA:1167-1175 | IC | 已是 `StateDocumentStore` 端口 |
| capability 绑定与签名密钥 | `CapabilityBindingProjection`、`capabilitySigningKey(fileKeyMaterial)` | `KeyMaterial` 文件适配器 | HA:755-758 | IC（绑定、密钥）；WH 签发会话（workspace-host-split §3.4） | 绑定已经过核心 owner；密钥用 DO `KeyMaterial` 适配器 |

### 2.2 账号、模型与计量

| 服务 | 持有 | Node 依赖 | 位置 | 目标 | 理由 |
| --- | --- | --- | --- | --- | --- |
| `ModelPolicyStore`＋`modelPolicyHttp` | `model-usage-policy.sqlite` | `node:sqlite`、`node:http` | HA:478-479、1305-1309 | AC（或 IC，workspace-host-split §8.2 问题 7） | 策略与计量同属账号 owner |
| `modelGatewayHttp`＋`CodexCoreControlClient` | 模型网关设置、个人订阅连接 | loopback HTTP 到 codex-core | HA:1285-1304 | AC＋EW | 凭据与刷新单写者是 AC |
| 模型配置／凭据 `ModelConfigurationRepository`／`ModelCredentialRepository` | `$DATA/models/` | `fileSecretStore` | HA:846、1002、1325 | 配置 IC；凭据 AC | workspace-host-split §5 |
| `TokenUsageQueryService` | 查询 Worker，读 `codex/token-usage.sqlite` 与原生 rollout | `worker_threads`、读 `codex/runtime` 文件 | HA:916-924、1060-1067 | WH 记录＋AC 汇总 | 待 workspace-host-split §4.2 决定；原生 rollout 只在容器内 |
| `SpeechTranscriptionService` | 语音转写请求 | 读 `models/` 凭据 | HA:1324-1325 | EW（流式转发）＋AC（凭据） | 与模型出口同一路径 |
| 图像生成配置 `ImageModelTransport` | AppServer transport 装饰 | `fileStateDocumentStore` | HA:1002 | WH（装饰）＋IC（配置） | transport 链随 Host 放置 |
| 个人助理 `createPersonalAssistantHost` | 助理环境与 `codexBinary` 子进程 | `child_process`（`apps/personal-assistant/src/runtime/host-supervisor.mjs`） | HA:1372-1383 | 容器或 Node（问题 5） | 需要原生 codex 进程 |

### 2.3 执行与 Host 状态（每工作区）

| 服务 | 持有 | Node 依赖 | 位置 | 目标 | 理由 |
| --- | --- | --- | --- | --- | --- |
| `AppHostServer`（逻辑客户端路由） | 每 Host transport、逻辑 Client 路由、thread directory 快照 | `node:sqlite`（`app-host-server/src/thread-directory/snapshot-reader.ts:9`）、`node:http` 类型 | HA:989-1166 | 拆分：路由归 Client 会话（§3.1），每 Host transport 链归 WH | 今天一个对象同时做 Hub 路由与 Host 装配 |
| `CodexEngineAdapter`（Host overlays） | queue、schedules、中断恢复、暂定线程、tasks、token usage，`$DATA/codex/` | `node:sqlite`、`setTimeout`／`setInterval`、`/proc` | HA:974、1012-1126 | WH（overlays）＋容器（原生 AppServer） | workspace-host-split §2、§4 |
| `createServerCodexBridge`（Codex agent bridge） | bridge 会话 MCP、准入 | 需要 Core 端点（HA:256） | HA:796-798、1111-1126 | WH | 只是 Codex transport 装饰；配置随 IC |
| DSH `startLocalAgentHost`／Pi `PiEngine`＋`startEngineHost`／`attachEngineHost` | DSH 进程、Pi 进程内引擎、`pi-owner` 锁、附件暂存 | `child_process`、`proper-lockfile`、文件系统 | HA:799-865 | 容器 | 需要 POSIX 文件系统与子进程 |
| 执行租约 `ExecutionLeaseStore`／`AppServerIdentityOverlay`／`ThreadIdentityDatabase` | 执行所有权与 Thread 元数据 | `node:sqlite`；化身经 `/proc`（`observeNativeExecutionProcess`） | HA:872-911 | WH | 化身改由 `WorkspaceLink` 上报（workspace-host-split §3.4） |
| `SessionCapabilityMcp`＋`localExecutionCli` | 引擎可调用的会话 MCP 监听与 CLI 文件 | `node:http` 监听（HA:794）、写 `thread-cli/`、`connected-execution-cli/` | HA:759-798 | WH 签发＋容器内端点（经 `WorkspaceLink` lane） | 引擎在容器内调用，不能直连 DO 端口 |
| `HostTerminalTransport`／`HostFileSystemTransport`／`HostFileDownloads` | 终端、文件、下载转发到 Hands owner | UDS／HTTP 到 Hands（`host-filesystem.ts:5`）；"local" 模式直读本机 | HA:925-936、1142-1158、1213-1219 | WH（授权与转发）＋容器（`files`／`terminal` lane） | 本机文件模式在 Cloudflare 不存在 |
| `ConversationResourceLifecycle` | `conversation-resources.json`、释放终端／浏览器／工作区 | 文件、`setInterval`（`conversation-resource-lifecycle.mjs:64`；HA:1350） | HA:937-954、1327-1350 | WH（每工作区资源）；周期对账改 alarm | 资源都在工作区容器内 |
| Assets 工作区 owner `openHeadlessAssetsStorage`／`openWorkspaceExecutionService`／Bot provider | vault Worker、工作区分配、沙盒环境 | `worker_threads`、文件 | HA:541-560 | IC（配置与分配账本）；分配动作创建 WH | 决定"Thread→工作区"放置，是 WH 的创建者 |
| `openHumanAssets`＋`createHumanGitExecution` | Git 授权、个人 Git Worker | `worker_threads`、文件、`/proc` 来源校验（`git-identity-origin.ts:24-62`） | HA:561-581、1044-1055 | IC（授权）＋容器（Git broker） | 待 workspace-host-split §3.4 决定 |
| `maintainHeadlessCodexHost` | Codex Host readiness | 定时 | HA:1369 | WH | 每工作区 readiness |
| `RemoteBrowserService`＋`RemoteBrowserCapabilities` | 浏览器 owner 连接、客户端媒体 WebSocket、状态库 | `ws` `WebSocketServer`（`remote-browser-service.mjs:13、75`）、owner socket | HA:724-753 | 容器（Chromium）＋WH（授权与流转发） | 媒体带宽经 DO 的成本待评估（问题 6） |
| `McpAppsService`＋`McpAppsTransport` | `mcp-apps.sqlite` | `node:fs`、sqlite | HA:912、1012 | IC | 部署级应用登记 |
| `HeadlessConnectors` | `connectors/` 状态 | `node:sqlite`、`node:dns`、`node:net`、`node:http`（connector-host） | HA:718-723 | IC（待端口化 SSRF 检查） | `dns`／`net` 用于出站校验，workerd 需替代实现 |

### 2.4 渠道、通知与本机能力

| 服务 | 持有 | Node 依赖 | 位置 | 目标 | 理由 |
| --- | --- | --- | --- | --- | --- |
| IM（`startImPlugins`：IM、WeCom、Slack） | switchboard／posts 库、渠道连接 | WeCom 是**出站长连接** `wss://openws.work.weixin.qq.com`（`plugins/wecom/src/server.ts:16、48`）；`fileSecretStore` | HA:473、1384；回调 `serve-workbench-web.mjs:868` | 待决（问题 3）；默认 Node | 出站 WebSocket 会让 DO 常驻，无法休眠 |
| `TurnPushService`（Web Push） | `web-push.sqlite`、订阅、发送 | `node:sqlite`、`node:https`、`node:net`、`worker_threads` | HA:1176-1198 | IC（订阅）＋`fetch` 发送 | 发送端需改为 fetch 端口 |
| `startAvailabilityNotification` | 独立 HTTP 监听 | `node:http` `createServer`（`availability-notification.mjs:1、29`） | HA:1385 | Node | 本机监听 |
| `createObservabilityIngress` | 观测查询代理 | 本机 socket（`socketRequest`）、`setInterval`（`observability-ingress.mjs:49`） | HA:1209-1212 | Node | 依赖本机观测栈 |
| `LocalDesktopService` | 本机桌面观察与控制 | 原生 observer／control、`process.getuid()` | HA:707-717 | Node | 本机桌面 |
| SSH：`SshManagement`、SSH Codex 适配、`createSshHttpIngress`、`createSshNativeRpcGateway` | SSH 连接库、SSH 入口监听、远端 Codex | `node:http`、`ws`（`ssh-native-rpc-gateway.mjs:3、6`）、TCP 监听 | HA:254-256、975-988、1005-1010、1201-1207、1354-1366 | Node | 需要入站 TCP 与本机 SSH 客户端 |
| `loadLocalMachineAccess` | 同机托管 Web 的私有密钥 | 私有文件 | HA:247 | Node | 同机信任 |

### 2.5 Web 入口与发布

| 服务 | 持有 | Node 依赖 | 位置 | 目标 | 理由 |
| --- | --- | --- | --- | --- | --- |
| `createWorkbenchWebServer` | HTTP 路由、`/appserver` 与 `/apphost` 升级、resume registry、心跳 | `node:http`（`serve-workbench-web.mjs:15、836`）、`ws`（:20、1180）、`setInterval`（:397） | HA:1220-1326、1351-1366 | 拆为 EW 路由＋DO 内会话（§3） | 唯一入口今天同时承担静态、API 与连接 |
| Web 发布校验与产品插件包 | `assertHeadlessWebRelease`、`prepareProductPluginRelease`、`index.html` | 文件系统、缓存目录 | HA:280-286 | EW（Workers 静态资源，构建期校验） | 静态资源随 Worker 版本发布 |
| 用户插件目录 | `user-plugins/` | 文件系统 | HA:265-268 | 待定（R2） | storage-ports §3.3 未迁移项 |

## 3. 协议入口

### 3.1 连接终止

| 入口（`serve-workbench-web.mjs`） | Cloudflare 终止点 | 说明 |
| --- | --- | --- |
| 静态资源、SPA 路由（:1084-1146） | EW 静态资源 | 构建 ID 与资源版本沿用现有发布清单 |
| `/__opencraft_auth*`、`/setup`、`/__opencraft_account*`（:879-886） | EW → IC | 页面与 OIDC 重定向在 EW，会话写入在 IC |
| `/__opencraft_actors*`、`/__opencraft_access/*`、`/__opencraft_server_information`、`/__opencraft_connectors`、`/__opencraft_push`（:887-931、964） | EW → IC | 均为部署级权威 |
| 模型网关设置与策略（:968） | EW → AC | |
| `/__opencraft_speech/*`（:971-986） | EW（流式）＋AC 凭据租约 | 与模型出口同路径（cloudflare-deployment §2.1） |
| `/__opencraft_files`、`/__opencraft_preview/tickets`（:933-950） | EW 鉴权 → WH → 容器 `files` lane | 按 Thread 的工作区放置路由 |
| `/appserver`、`/apphost`（:1067-1076、1180-1290） | EW 鉴权 → **Client 会话 DO**（问题 1） | 见下 |
| 远程浏览器媒体 WebSocket | EW → WH → 容器 `browser` lane | 第一里程碑不提供 |
| `/__opencraft_im/*` 回调（:868、955） | EW 验签 → IC | 仅 webhook 型渠道；见问题 3 |
| Hub 升级（:1182） | EW → RH | 第一里程碑不提供 |
| `/desktop/connect`、`/ssh-apphost`、`/__opencraft_ssh*`、`/__opencraft_observe/*` | 不声明 | 沿用现有"服务缺席"分支（例如 :993、:953、:1063），不另造开关 |

**为什么需要 Client 会话层。** 一条 `/apphost` 连接经 `AppHostServer` 的 `logicalClientRouting` 同时访问多个 Host（`local-codex`、`opencraft-server`、`channels`，HA:989-1011），并携带每连接的 `ThreadAccessSession`（HA:654-685）与 resume 状态（`ResumeRegistry`，`serve-workbench-web.mjs:23`）。若在 Cloudflare 上把每个工作区做成一个 Host，同一连接要扇出到多个 WH，所以连接不能直接终止在某个 WH。两个选项：

- **A：终止在 IC。** 最简单，所有连接在一个 DO；代价是 IC 成为全部流量的单点，且 Thread 事件要经 IC 中转。
- **B（已决定，2026-11-22）：每条 Client 连接一个会话 DO**，持有该连接的逻辑客户端路由、访问会话与 resume 状态，使用 WebSocket hibernation 接受连接；对 IC 做授权查询，对 WH 做按 Thread 的 RPC 与订阅。它承载的是已有的 Client attachment，不是新的主体或 Server 身份；DO 名取自现有连接身份。休眠唤醒后内存状态丢失，resume 窗口与访问会话需要持久化到该 DO 存储或视为重连，**需 PoC 确认**。

### 3.2 身份映射（不新增身份）

- **Server 身份不变。** 今天 Server 身份是 `server:<machineId>:codex`／`server:<machineId>:<engine>`（`packages/access-control/src/runtime/conversation-execution.mjs:294-295`），`machineId` 来自部署的 daemon machine identity（HA:477）。Cloudflare 装配把该 machine identity 存在 IC，所有工作区共享同一个 Server 身份；Thread 稳定身份仍是 `(serverId, threadId)`。
- **WH 是 Host placement，不是 Server。** execution-ownership.md 规定 Host 是部署载体，更换 Host 不改变 Server 或 Thread 身份。Thread→工作区由 `thread_placement` 投影解析（workspace-host-split §8.1，真源 WH，IC 持可重建投影），不进入 Client 可见的 Server 身份。
- **`hostId` 保持逻辑路由。** Client 仍只看到 `local-codex`／`opencraft-server` 等路由；`legacyDirectServerProjectionFromHost()`（`packages/workbench-runtime/src/client-hub-server.ts:152`）的"一 Host 一 AppServer 路由"投影保持成立，因为每工作区放置发生在 Hub 侧，不暴露为新 Host。若将来要把工作区暴露给 Client，必须先替换该兼容投影，而不是在消费者里推断。
- **协作状态不进会话 DO。** 会话 DO 只持有该连接的身份、访问会话、逻辑路由与 resume 状态；Thread 执行、事件与队列由 WorkspaceHost 持有，频道、成员、协作命令与线程授权由 InstallationCore 持有。多人观看或协作同一对象时，各会话 DO 向同一共享 owner 订阅，由该 owner 扇出事件；这对应既有拓扑中多个 Client attachment 连接同一 Server。代价是多一跳与按观看者数量增长的扇出，而不是协作能力受限。对实时性要求更高的共享对象（例如多人同时编辑的笔记）可另设按对象划分的房间 DO，由客户端直连；这是扩展，不改变上述所有权。
- **Hub 角色。** 在 Client/Hub/Server 拓扑中，EW＋Client 会话 DO 共同扮演 Hub（准入、路由、订阅、扇出）；RH 只承载 HubLink 级联与流预算。tenant 作用域以 installation 为界（问题 2），不从 socket 推断。

## 4. 拆分方式

### 4.1 组合根按角色分开，owner 共享

把 `startHeadlessServer` 从"一个函数构造一切"改为若干**按 owner 分组的装配模块**，每个模块只接收端口与上游 owner，返回服务对象和 `close`：

| 模块（提议） | 内容 | Node Gateway | Cloudflare |
| --- | --- | --- | --- |
| `installation` | 核心 SQL owner、主体／准入／协作／编排／spaces、ServerInformation、MCP apps、connectors、push 订阅 | Gateway 进程内（现状） | IC DO |
| `account` | 模型策略、网关设置、凭据、订阅 | Gateway＋`proxy` | AC DO |
| `workspace-host` | Codex overlays、执行租约、capability MCP 签发、资源生命周期、终端／文件／浏览器转发、readiness | Gateway 内 Worker（workspace-host-split §3.2 方案 A） | WH DO |
| `client-session` | AppHost 逻辑路由、访问会话、resume、心跳 | Gateway 内每连接对象 | Client 会话 DO |
| `edge` | HTTP 路由表、静态资源、登录页、webhook 验签 | `createWorkbenchWebServer` | EW |
| `node-local` | SSH、本机桌面、relay、观测、可用性通知、匿名模式、本机文件 | Gateway | 不装配 |

`HA` 最终只剩 Node 组合根：读取 CLI 选项与私有文件、选择 Node 适配器、按配置调用上述模块，并保留现有关闭顺序（HA:416-466）。Cloudflare 的每个 DO 类各有一个小组合根，调用同一模块的 DO 适配器版本。领域类（`access-control`、`host-schedules`、`host-recovery`、`CodexEngineAdapter` overlays 等）只写一份。

### 4.2 需要成为端口的部分

| 端口 | 现状 | Node 适配器 | Cloudflare 适配器 |
| --- | --- | --- | --- |
| HTTP 处理 | 各服务 `handle(IncomingMessage, ServerResponse)`（`human-auth.ts:2`、`actor-access.ts:1`、`collaboration.ts:22`、`app-host-server/src/index.ts:11`、`hub-network` 等） | `Request`/`Response` ↔ `node:http` 包装 | 原生 `fetch` |
| WebSocket 会话 | `ws` 对象直接进入会话逻辑（`serve-workbench-web.mjs:1180-1290`） | `ws` 包装 | DO hibernation WebSocket |
| 定时器 | `setInterval`（HA:1350；`conversation-resource-lifecycle.mjs:64`；`observability-ingress.mjs:49`；`serve-workbench-web.mjs:397`；host-schedules 2 s 轮询） | owner 定时器 | DO alarm（每 DO 单个，需要合并到"下一个到期时间"） |
| 单写者 owner | `worker_threads` Worker（核心 owner、编排、spaces、assets vault、token usage 查询、push） | `@opencraft/worker-owner` | DO 本身即单写者，`SqlDatabase` 同步调用（storage-ports §6） |
| 存储 | 仍有直接 `node:sqlite` 的 owner：`ModelPolicyStore`、`McpAppsService`、`openPushStore`（`web-push-node/src/store.ts:2`）、`app-host-server` thread directory、connectors | 迁到 `SqlDatabase` 端口 | DO SQL |
| 引擎与资源通道 | UDS、私有描述符、loopback URL、`/proc` | `WorkspaceLink` 的本地 socket 适配 | DO → Container 端口（workspace-host-split §3.3） |
| 出站 HTTP | `node:https`／`node:net`／`node:dns`（push、connectors SSRF 检查） | 现有实现 | `fetch`；SSRF 校验需另行设计 |
| 进程创建 | `child_process`、`proper-lockfile`（Pi、DSH、个人助理、Git Worker） | 不变 | 只在容器内 |

**不提供于 Cloudflare 的能力**（只在 Node 组合根装配，Cloudflare 不声明，Web 端按现有缺席分支呈现）：本机文件"local"模式（HA:1215）、SSH 管理与 SSH 入口、本机桌面观察与控制、relay-connect、匿名部署、同机托管访问文件、观测 ingress、可用性通知监听、读取服务器主机文件系统或进程的一切能力。

## 5. 依赖顺序与分步计划

### 5.1 步骤

每步在 Node 上独立可发布、可回退；"P4-n"指 [workspace-host-split §7](workspace-host-split.md#7-分步计划) 第 n 步。

| 步 | 内容 | Node 价值 | 依赖 |
| --- | --- | --- | --- |
| G1 | 把 `HA` 按 §4.1 拆成装配模块，行为与关闭顺序不变 | 组合根可测、可读；嵌入方（Docker gateway）复用模块 | 无 |
| G2 | 合并 `opencraft-server.sqlite` 的三条连接（HA:277、278、635）到核心 owner | 消除同库多写入者；减少主线程同步 IO 登记 | G1 |
| G3 | 剩余直接 `node:sqlite` 的部署级库（模型策略、MCP apps、push、connectors）迁到 `SqlDatabase` 端口 | 统一迁移与 outcome 报告 | 存储端口第 1–2 阶段（已实施） |
| G4 | HTTP 处理改为 `Request`→`Response` 端口，Node 包装 | 服务单测不需要真实监听 | G1 |
| G5 | 定时器端口；资源对账、心跳、观测改为 owner 定时器 | 关闭排空与时钟回拨可测 | G1；与 P4-3 同一抽象 |
| G6 | 拆出 `client-session`：AppHost 逻辑路由与访问会话脱离 `ws` | 连接逻辑可用内存 transport 测试 | G4 |
| P4-2 | 抽出 `WorkspaceHost`（Codex overlays 以工作区根打开） | 见原文 | G1 |
| P4-3 | 定时任务 owner 驱动 | 见原文 | G5 |
| P4-4 | `WorkspaceLink` 与 `workspace-agent` | 见原文 | P4-2 |
| P4-5 | 化身经通道上报，去除 `/proc` 与 `pid: host` | 见原文 | P4-4 |
| G7 | Node 组合根声明能力清单；Cloudflare 不提供的服务集中在 `node-local` | 能力声明与实现一致 | G1 |
| C1 | DO／Container 适配器（storage-ports 第 5 阶段剩余：`sandbox-cloudflare`、Secrets 信封加密） | — | P4-4 |
| C2 | 第一个 Cloudflare 里程碑（§5.2） | — | G1–G7、P4-2–P4-5、C1 |

P4-1（`proxy` 默认、全部 provider 经代理）是 AC 的前提，必须在 C2 之前完成；P4-6～8（冷迁移、多工作区、跨工作区投影）对第一里程碑不是前提，因为 Cloudflare 是全新安装，不迁移 Node 数据。

### 5.2 第一个里程碑："最小可运行"

目标：Web 静态资源在 EW；IC 提供登录与核心数据；一个工作区的 Brain＋Hands 在 Cloudflare Containers 中由 WH 持有；模型调用经 AC。

**必需：**

1. EW：静态资源与发布清单、HTTP 路由表（§3.1 中 IC／AC／Client 会话三类）、模型出口流式转发。
2. IC：核心 SQL owner（合并后）、`ActorStore`／`MembershipStore`／`InstanceAccess`／`ActorAccess`／`IdentityWrites`、`HumanAuth`＋本地账号（OIDC 可选）、`ThreadAccessStore`、`ServerSpacesRuntime`、`Collaboration`（Codex 执行准入钩子依赖它，HA:1112-1119）、编排运行时存储（`Collaboration` 构造需要，HA:687）、`ServerInformationStore`、capability 绑定与签名密钥、Assets 工作区分配中"固定一个工作区"的最小部分、machine identity。
3. AC：模型配置读取、凭据、短期凭据租约（cloudflare-deployment §2.1）、模型策略。
4. Client 会话 DO（或 IC，问题 1）：`/apphost`／`/appserver` 终止、逻辑路由、访问会话。
5. WH（一个）：Codex Host overlays（queue、中断恢复、暂定线程；schedules 可先禁用）、执行租约、capability MCP 会话签发、容器生命周期与 `WorkspaceLink`、readiness。
6. 容器：`codex app-server`＋`exec-server`（Hands 镜像＋Brain 运行时）、`workspace-agent`、`model-egress` lane；**只有 Codex 引擎**。

**可以缺席：** DSH／Pi／ACP／Claude 引擎；`ThreadOrchestrationBroker` 的子线程派生与项目自动化（`orchestration.available()` 为假，HA:1088；需核实 Collaboration 在无 broker 时的行为）；会话定时任务；token usage 查询；终端、文件下载、预览票据；远程浏览器；connectors；MCP apps；Web Push；IM／WeCom／Slack；语音；图像生成；个人助理；Assets Bot 与个人 Git 执行；Codex agent bridge；用户插件目录；Hub／RelayHub；以及 §4.2 列出的全部 Node-only 能力。缺席服务通过不装配表达，Web 按现有缺席分支呈现，不用前端开关冒充。

**里程碑验收（提议）：** 真实 Cloudflare 账号上完成登录 → 新建 Thread → Codex Turn 流式输出 → 容器重启后按中断恢复规则处理且不重放未确认输入 → 容器文件系统中不存在模型或账号凭据。本地 workerd／Miniflare 通过不等于该验收。

## 6. 待决问题

1. **Client 连接终止点**：已决定 B（每连接会话 DO，协作状态由共享 owner 持有）。PoC 验收：两个客户端同时观看同一 Thread，事件扇出正确、延迟可接受，任一方断线后 resume 不丢事件、不重复；hibernation 唤醒后 resume 与访问会话的持久化成本。
2. **租户模型**：一个 Cloudflare 部署＝一个 installation（一个 IC、一个 AC，与 Node 自托管语义一致，建议），还是一个 Worker 承载多个 installation（IC／AC 按 installation 命名）。后者需要 tenant 作用域在每个入口显式校验，现有代码未实现多租户准入（execution-ownership.md 已注明）。
3. **IM／webhook**：WeCom 是出站长连接（`plugins/wecom/src/server.ts:16`），在 DO 上会持续占用运行时长；Slack 与通用 IM 需核实是 webhook 还是长连接。选项：Cloudflare 上只支持 webhook 型渠道；或长连接渠道留在 Node；或接受 DO 常驻成本。
4. **有意保持 Node-only 的产品范围**：确认 SSH Servers、本机桌面、relay-connect、匿名部署、观测 ingress、可用性通知在 Cloudflare 上不提供；以及 DSH／Pi／ACP 是否在后续里程碑进入工作区容器。
5. **个人助理**：其 `codex` 子进程放进专属工作区容器，还是 Cloudflare 上不提供。
6. **远程浏览器**：媒体流经 EW→WH→容器会占用 DO 带宽与时长；是否在 Cloudflare 上提供、提供时是否让客户端直连容器暴露的端点（需要新的鉴权票据设计）。Chromium 沙盒可用性仍待 PoC（cloudflare-deployment §4）。
7. **本地账号密码哈希**：`scrypt` 在 workerd `node:crypto` 中的可用性与性能待核实；若不可用，登录校验需留在可运行 `scrypt` 的位置，不能更换已存储哈希的算法。
8. **出站 SSRF 校验**：connectors 与 push 依赖 `node:dns`／`node:net` 做地址检查；Cloudflare 上用什么等价机制。
