# Headless Gateway 拆分与 Cloudflare 装配

[Architecture index](../README.md) · [可选 Cloudflare 部署](cloudflare-deployment.md) · [Gateway／Brain 按工作区拆分](workspace-host-split.md) · [存储端口](storage-ports.md) · [执行所有权](../execution/execution-ownership.md#client--hub--server-拓扑) · [Docker 三角色部署](../../../deploy/docker/README.md)

状态：**设计草案，部分步骤已实施，各步进度见 §5.1 状态列（2026-11-23 核对）。** 下文"现状"以引用的源码行为准（§2 的行号为 2026-11-22 核对，已随并行改动漂移；组合根的当前行号以 §4.1.1 为准）；"目标"与"步骤"均为提议，第 6 节列出需要用户决定的问题。Node／Docker（以及 Electron）是一等公民：每一步先在 Node 上独立成立并可发布；Cloudflare 只是另一组装配，不替换 Node 路径，也不为它另造领域实现。

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
| `OrchestrationRuntimeWorker` | 编排运行时、通信与自动化账本的异步门面；Headless 中在核心 owner 连接上执行（`orchestrationRuntimeOwnerMethods`），不再另开连接 | 无（门面）；独立 `worker_threads` 模式只留给测试与无 owner 的组合 | HA:278 | IC | 已与核心 owner 合并为单一写入者（G2） |
| `ServerSpacesRuntime` | Server space 账本的异步门面与投影；Headless 中在核心 owner 连接上执行（`serverSpacesOwnerMethods`） | 无（门面）；本机 Host 的 `directory` 模式仍是独立 Worker | HA:635-636 | IC | 同上 |
| `ActorStore`／`MembershipStore`／`InstanceAccess`／`ActorAccess`／`IdentityWrites` | 主体、成员、准入投影；写入经核心 owner | HTTP 处理签名为 `node:http` 类型（`actor-access.ts:1`、`access-control/src/index.ts:9`） | HA:476、481、535、589-608 | IC（状态）＋EW（无状态鉴权读取见 §3.2） | 部署级唯一写者；读取投影可在 IC 内存 |
| `HumanAuth`＋本地账号＋OIDC | 登录会话、身份绑定、OIDC discovery 与回调 | HTTP 经运行时中立交换端口（§3.4，已无 `node:http`）；本地账号 Argon2id，经组合根选择的 `PasswordHasher`（Node 原生 `node:crypto.argon2`；Workers 纯 JS `@noble/hashes`，见 §3.4）；setup token 私有文件 | HA:515-533；登录页 `human-login-page.ts` | IC（会话与账号写入）＋EW（页面与 OIDC 重定向） | 登录态是 IC 数据；外部 HTTP 往返适合 EW |
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
| `ConversationResourceLifecycle` | 服务器核心表 `conversation_resources`（2026-11-23 起；旧 `conversation-resources.json` 一次性导入）、释放终端／浏览器／工作区 | `setInterval`（`conversation-resource-lifecycle.mjs`；HA:1350）；持久化已经服务器核心 owner 端口，不再有文件依赖 | HA:937-954、1327-1350 | IC（行与准入投影）；释放动作由 WH／容器执行；周期对账改 alarm | 一行跨 Host 记录 Host＋Thread，且 `workspace` 释放会回收工作区本身，记录不能放在被回收的 WH 内；见 workspace-host-split §4.1 |
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
| `/appserver`、`/apphost`（:1067-1076、1180-1290） | EW 鉴权 → **Client DO**（按客户端实例，问题 1） | 见下 |
| 远程浏览器媒体 WebSocket | EW → WH → 容器 `browser` lane | 第一里程碑不提供 |
| `/__opencraft_im/*` 回调（:868、955） | EW 验签 → IC | 仅 webhook 型渠道；见问题 3 |
| Hub 升级（:1182） | EW → RH | 第一里程碑不提供 |
| `/desktop/connect`、`/ssh-apphost`、`/__opencraft_ssh*`、`/__opencraft_observe/*` | 不声明 | 沿用现有"服务缺席"分支（例如 :993、:953、:1063），不另造开关 |

**为什么需要 Client 会话层。** 一条 `/apphost` 连接经 `AppHostServer` 的 `logicalClientRouting` 同时访问多个 Host（`local-codex`、`opencraft-server`、`channels`，HA:989-1011），并携带每连接的 `ThreadAccessSession`（HA:654-685）与 resume 状态（`ResumeRegistry`，`serve-workbench-web.mjs:23`）。若在 Cloudflare 上把每个工作区做成一个 Host，同一连接要扇出到多个 WH，所以连接不能直接终止在某个 WH。两个选项：

- **A：终止在 IC。** 最简单，所有连接在一个 DO；代价是 IC 成为全部流量的单点，且 Thread 事件要经 IC 中转。
- **B（已决定，2026-11-22）：每个 Client 实例一个 Client DO。** 单位是已认证的逻辑客户端实例（现有协议的客户端实例／连接代次概念），不是单条 WebSocket：连接只在该 DO 上附着和断开，生命周期跨越多次断线重连。DO 持有该客户端的访问会话、`/apphost` 逻辑路由、订阅集合与 resume 游标／未确认事件，使断线重连不丢状态；它也是共享 owner 推送事件的可寻址目标（无状态 Worker 不能作为推送目标）。连接用 WebSocket hibernation 接受；客户端实例结束（登出、过期、长时间无连接）时由 DO 自行回收（alarm）。它承载已有的 Client attachment，不是新的主体或 Server 身份；DO 名取自现有客户端实例身份。hibernation 唤醒后的 resume 与访问会话持久化成本**需 PoC 确认**。

### 3.2 身份映射（不新增身份）

- **Server 身份不变。** 今天 Server 身份是 `server:<machineId>:codex`／`server:<machineId>:<engine>`（`packages/access-control/src/runtime/conversation-execution.mjs:294-295`），`machineId` 来自部署的 daemon machine identity（HA:477）。Cloudflare 装配把该 machine identity 存在 IC，所有工作区共享同一个 Server 身份；Thread 稳定身份仍是 `(serverId, threadId)`。
- **WH 是 Host placement，不是 Server。** execution-ownership.md 规定 Host 是部署载体，更换 Host 不改变 Server 或 Thread 身份。Thread→工作区由 `thread_placement` 投影解析（workspace-host-split §8.1，真源 WH，IC 持可重建投影），不进入 Client 可见的 Server 身份。
- **`hostId` 保持逻辑路由。** Client 仍只看到 `local-codex`／`opencraft-server` 等路由；`legacyDirectServerProjectionFromHost()`（`packages/workbench-runtime/src/client-hub-server.ts:152`）的"一 Host 一 AppServer 路由"投影保持成立，因为每工作区放置发生在 Hub 侧，不暴露为新 Host。若将来要把工作区暴露给 Client，必须先替换该兼容投影，而不是在消费者里推断。
- **协作状态不进 Client DO。** Client DO 只持有该客户端实例的身份、访问会话、逻辑路由、订阅与 resume 状态；Thread 执行、事件与队列由 WorkspaceHost 持有，频道、成员、协作命令与线程授权由 InstallationCore 持有。多人观看或协作同一对象时，各 Client DO 向同一共享 owner 订阅，由该 owner 扇出事件；这对应既有拓扑中多个 Client attachment 连接同一 Server。代价是多一跳与按观看者数量增长的扇出，而不是协作能力受限。对实时性要求更高的共享对象（例如多人同时编辑的笔记）可另设按对象划分的房间 DO，由客户端直连；这是扩展，不改变上述所有权。
- **Hub 角色。** 在 Client/Hub/Server 拓扑中，EW＋Client DO 共同扮演 Hub（准入、路由、订阅、扇出）；RH 只承载 HubLink 级联与流预算。tenant 作用域以 installation 为界（问题 2），不从 socket 推断。

### 3.3 Client DO 原型结果

本地原型（2026-11-22）验证 §3.1 选项 B 的状态划分与 resume 语义，只在 workerd／Miniflare 中运行，不是部署装配。源码：`tests/protocol/workerd/client-do-worker.ts`；测试：`npm run test:client-do:workerd`（`tests/protocol/client-do-workerd.test.ts`）。

**组成。**

- **EW（边缘 Worker）**：校验测试 token（HMAC，代替 IC 签发的访问会话），拒绝缺失、伪造与过期 token；按已认证的 client instance id 用 `idFromName` 选 Client DO，只通过边缘写入的身份头转发 WebSocket upgrade，丢弃客户端自带的同名头。
- **ClientDO**：每个客户端实例一个，用 Hibernatable WebSockets API（`ctx.acceptWebSocket`、`serializeAttachment`）接受连接。DO storage 持有访问会话、连接代次、订阅集合，以及每 Thread 的 `acked ≤ delivered` 两个游标；**不持有事件正文**，补发一律从 WorkspaceHost 日志读取。内存里只有串行化队列与计数器，丢失无影响。新附着关闭同一实例的旧 socket（4000 superseded）。
- **WorkspaceHostDO（假）**：每工作区一个，持有每 Thread 只追加的事件日志（单调 `seq`）和订阅者集合；先提交事件，再对每个订阅的 Client DO 发一次 `deliver` RPC。

**协议（原型帧，JSON 文本）。** 客户端 → DO：`client/hello {v, cursors: {"<workspace>/<thread>": lastAckedSeq}}`、`thread/subscribe {after}`、`thread/unsubscribe`、`event/ack {seq}`、`client/logout`。DO → 客户端：`thread/subscribed {head}`、`thread/event {workspaceId, threadId, seq, event}`、`client/ready {generation, subscriptions}`、`resume/failed {failures: [{thread, reason}]}`、`error`。规则：

- socket 在 `hello` 处理完之前不接收实时事件；`hello` 对每个已存订阅从游标起向 WH 读日志补发，再发 `client/ready`，之后转为实时。补发与实时 `deliver` 在 DO 内串行，重复（`seq ≤ delivered`）丢弃，缺口（`seq > delivered+1`）从日志补齐。
- 游标只在 `acked ≤ cursor ≤ delivered` 内接受：更低为 `stale`（客户端旧副本），更高为 `forged`（从未送达），未知 Thread 为 `unknown-subscription`；拒绝时不改任何状态，客户端须重新订阅。`event/ack` 越过 `delivered` 同样拒绝。已送达但未确认的区间正是"socket 半开、send 静默失败"时需要重发的部分，因此 DO 必须持久化 `delivered`，而不是只信 WH head。
- 无就绪 socket 时 `deliver` 返回 `detached` 且不推进游标；事件已在 WH 日志中，resume 时送达，不会丢失。
- 回收：alarm 取 `min(会话过期, 最后断开 + DETACH_MS)`；到期、长时间无连接或 `client/logout` 时，先逐个向 WH 注销订阅，再关闭 socket（4001）并 `deleteAll()`。已回收实例对迟到 `deliver` 答 `unsubscribed`，WH 据此再剪除一次。

**映射到现有 AppHost 协议。** 原型只验证所有权与游标语义，不替换现有线格式：

- `@opencraft/app-host-resume` 的 `ResumeLink`／`ResumeRegistry` 是**每传输会话**一条序列，在服务器内存中保留未确认帧（`RESUME_SESSION_MAX_BYTES`），进程重启即失效。Client DO 上它仍可作为 socket 级重传层（`connection/ack`、`connection/resumed` 不变），但 `ResumeSession` 的保留缓冲不能跨 hibernation；跨 hibernation／驱逐的连续性改由本节的每 Thread 游标承担，补发数据源是 WH 日志。原型复用了其 `RESUME_PROTOCOL_VERSION` 与 `isAcknowledgement` 校验。
- `resume-failed` 的 `unknown-session`／`gap`／`invalid` 原因分别对应 `unknown-subscription`／WH 日志截断（`read` 返回 null）／`stale`、`forged`。
- `/apphost` 逻辑路由（`LOGICAL_CLIENT_FIELD` 打标、`logicalClientRouting`）留在 Client DO：每个逻辑客户端（`local-codex`、`opencraft-server`、`channels`）的订阅按其 Host 路由到对应共享 owner；`ThreadAccessSession` 的授权判定仍由 IC 持有，原型对已认证客户端放行订阅，**未**接 IC。
- 连接代次对应现有"客户端实例／连接代次"：同一实例的新附着递增代次并淘汰旧 socket。

**已证明（本地）。**

- 两个 Client DO 观看同一 Thread，50 个事件双方均按序完整收到；稳态每事件每观看者恰好 1 次 WH→ClientDO RPC，无日志补读。
- 断线后事件继续，WH 对断线方得到 `detached`；以游标重连只收到缺失事件，补发在 `client/ready` 之前完成，转实时后无重复。客户端报告"已收未确认"的游标时不重发已收部分。
- `ctx.abort()` 驱逐与 Miniflare 整体重启（同一持久化目录）后，新实例从 storage 恢复会话、订阅与游标，WH 订阅仍在，重连后补发正确。
- alarm 在会话过期（socket 仍连接）与长时间断线两种情况下回收实例并从 WH 移除订阅；登出立即回收；回收后旧游标被拒为 `unknown-subscription`。

**本地测量（仅 workerd／Miniflare 单进程，不代表 Cloudflare）。** append→两个 socket 都收到：p50 约 5–9 ms，p95 约 13–25 ms（含 Node→Miniflare 的测试驱动请求与轮询）。每事件 RPC 跳数：边缘→WH 1 次（追加，真实系统由执行侧在 WH 内产生，为 0）＋ WH→ClientDO 每观看者 1 次；ClientDO→socket 不是 RPC。

**成本与限制。**

- **扇出**：每事件 N 个观看者＝N 次 DO 调用（请求计费）＋每个 Client DO 1 次 storage 写（持久化 `delivered`）。流式 token 增量若逐条走此路径，成本随"事件数 × 观看者"线性增长；真实实现应在 WH 侧合并增量批量 `deliver`，或改为只推送"head 已前进"通知、由 Client DO 按批读取。
- **hibernation**：Miniflare 不会自行 hibernate，原型用 `ctx.abort()` 模拟"新实例、同一 storage"；workerd 中 abort 会断开 socket，而真实 hibernation 保留 socket。设计上已不依赖内存（附着信息在 `serializeAttachment`，其余在 storage），但每次 `deliver` 都会唤醒 Client DO，活跃 Thread 的观看者实际上不会进入 hibernation；只有空闲客户端受益。
- **顺序**：WH 对不同订阅者的 RPC 并发，单个订阅者的乱序由 Client DO 的去重与缺口补读兜底；未测大规模并发追加。
- **未覆盖**：多 Host 逻辑路由、IC 线程授权、WH 日志截断与快照、背压与慢消费者、多个工作区的扇入、跨区域放置。

**需在真实 Cloudflare 上确认。** hibernation 后唤醒 `webSocketMessage` 与 alarm 的冷启动延迟；跨 colo 的 WH→ClientDO RPC 延迟与 Client DO 放置（首个请求就近放置，用户移动后不迁移）；每事件 DO 请求与 storage 写入计费在流式输出下的量级；单 WH 扇出上限（并发出站子请求数、CPU 时间）；`ctx.abort()` 与平台驱逐、部署更新对 hibernatable socket 的实际影响；alarm 的触发精度与重试语义。

### 3.4 登录入口原型结果

本地原型（2026-11-22）验证 §2.1 `HumanAuth`＋本地账号能否在 InstallationCore 上运行，并回答问题 7。只在 workerd／Miniflare（`nodejs_compat`，compatibility date 2026-07-30，workerd 1.20260730.1）中运行，不是部署装配。源码：`tests/identity/workerd/login-entry-worker.ts`（经生产 Fetch 适配器 `@opencraft/identity-core/http-exchange-fetch`，原型期的测试专用 `node-http-exchange.ts` 已删除）；测试：`npm run test:login-entry:workerd`（`tests/identity/login-entry-workerd.test.ts`）。

**现状事实（Node）。**

- 本地账号（`plugins/local-account/src/server.ts`）：原型时为 `scrypt(password, salt, 32, {N: 131072, r: 8, p: 1, maxmem: 192 MiB})`，salt 为 64 位 hex 文本，摘要存 hex。现已改为 Argon2id PHC 记录（见下文“密码哈希结论”与[服务器登录](../identity/server-authentication.md)）；无 pepper。未知用户名也对固定占位记录计算一次，之后复读账号确认 `enabled` 与 `version` 未变。单进程最多 2 个并发哈希，超出直接拒绝。
- 登录态（`HumanAccounts`）：`randomBytes(32)` base64url（43 字符）作为 token，库中只存 `sha256(token)` hex（`human_logins`，带 Actor 代次、本地账号 `version`、`expires_at`＝最多 8 小时）。验证时要求 Actor 当前、绑定未变，本地账号版本与登录时一致——禁用、改密都会使旧登录失效；登出删除该行。
- 浏览器载体（`HumanAuth`）：Cookie `oc_human`（`Path=/; HttpOnly; SameSite=Lax; Max-Age`，HTTPS origin 加 `Secure`）；OIDC 事务 Cookie `oc_human_flow`（`Path=/__opencraft_auth`）。CSRF 依赖：`Host` 等于配置 origin、POST 要求 `Origin` 精确同源且 `content-type: application/json`、拒绝带 `Authorization` 的请求、字段白名单、16 KiB 正文上限；登录尝试全局 60 次／分钟、每地址 12 次／分钟（内存计数）。
- 受保护请求走 `InstanceAccess.authenticate`／`admissionStatus`（204／401／403），`HumanAuth` 是其中一个 `IdentityProvider`。

**密码哈希结论（2026-11-23 改为 Argon2id）。** 原型首先确认了 scrypt 可在 workerd `nodejs_compat` 中互通（本地 workerd 约 250 ms、Node 约 280 ms），但 N=2^17、r=8 的工作区为 `128·N·r` = 128 MiB，恰等于 isolate 128 MB 上限，原生分配是否计入未见文档；WebCrypto 没有 scrypt，纯 JS／Wasm scrypt 必然计入 JS 堆而超限（纯 JS 约 1.16 s）。该风险以更换算法解决：

- 新记录为 Argon2id（m=19456 KiB、t=2、p=1，16 字节 salt，32 字节输出），PHC 字符串存 `password_digest`、`salt` 列为空串，无需迁移。旧 scrypt 记录只在 Node 上验证，Headless 成功登录时经 Server owner Worker 以 CAS（版本与原记录未变、账号启用）升级、不递增版本；Cloudflare 安装均为全新安装，不存在 scrypt 记录，便携实现遇到时明确拒绝。
- Node 使用原生 `node:crypto.argon2`（Node 26.7，回调形式在 libuv 线程池计算，不阻塞事件循环）。workerd `nodejs_compat` 不提供 `argon2`。
- workerd 候选（同一参数，Miniflare 本地，开发容器）：
  - `@noble/hashes` 2.4.0（MIT，纯 JS，`argon2idAsync`）：单次验证中位数约 170 ms（未知用户名约 167 ms，新建哈希约 168 ms；Node 原生约 26 ms），结果与 Node 原生逐字节一致；工作内存为一块约 19 MiB 的 `Uint32Array`（Node 中测得峰值增量约 20 MiB，两路并发约 40 MiB，远低于 128 MB）；进入 worker bundle 的哈希相关代码约 32 KB（未压缩，含 PHC 解析）。
  - `hash-wasm` 4.12.0（MIT，WebAssembly）：在 workerd 中运行即失败：`WebAssembly.compile(): Wasm code generation disallowed by embedder`——它在运行时从内嵌字节编译 Wasm，Workers 只允许上传时预编译的 Wasm 模块，需要改造打包方式才能使用；其 ESM 源约 266 KB。
  - 按“纯 JS 单次验证不超过 1 s 即优先纯 JS”的规则选用 `@noble/hashes`（`password-hash-portable`）。`argon2idAsync` 约每 10 ms 让出一次，所在 DO 仍需付出约 0.17 s CPU／次（Miniflare 读数）；真实 Cloudflare 上 Workers Logs 计量为 0.3–0.9 s CPU／次（`cf:rehearsal`，见[可选 Cloudflare 部署 §7.4](cloudflare-deployment.md#74-argon2id-登录的-cpu-结论)）。因此正式登录入口必须在哈希前做按来源与账号的速率限制和并发上限，并评估把哈希移到无状态 Worker；结论与依据只在该节维护。
- 交叉验证：`tests/identity/login-entry-workerd.test.ts` 中 Node 建的 PHC 记录在 workerd 验证通过、workerd 建的记录在 Node 验证通过，错误密码拒绝；当前参数记录不被重写；workerd 拒绝 scrypt 记录。升级、并发改密与解析上限见 `tests/identity/local-account-plugin.test.ts`。
- Cloudflare 限制（官方文档，2026-11 读取）：Workers 每请求 CPU，Free 10 ms，Paid 默认 30 s、可配置到 5 min；Durable Object 每个传入请求／WebSocket 消息把可用 CPU 重置为 30 s；每 isolate 内存 128 MB，含 JS 堆与 WebAssembly。结论：Paid 计划 CPU 余量约 170 倍，内存余量充足；**Free 计划仍无法运行**（单次验证超出 10 ms 约 17 倍）。

**登录入口原型。** `LoginCore` DO 以 DO SQL 迁移 Server 核心后，原样装配 Node 部署中的 `ActorStore`、`HumanAccounts`、`LocalAccountServerPlugin`、`MembershipStore`、`HumanAuth` 与 `InstanceAccess`。公开入口是 fetch：`/__opencraft_auth/*` 经 Fetch 适配器交给真实的 `HumanAuth.handle`（Node 侧经 `node:http` 适配器调用同一处理器），受保护探针 `/api/me` 走真实的 `InstanceAccess.admissionStatus`。同一请求序列分别打到该 DO 与真实 `node:http` 服务器（node:sqlite），归一化随机 id、token 与 Max-Age 后两边逐项相等：

- 错误密码、未知用户、已禁用账号登录 → 401 `invalid_credentials`；跨源或非 JSON POST → 403 `same_origin_json_required`；带 `Authorization` → 403 `origin_required`；多余字段 → 400 `login_failed`。
- 登录成功 → 200 `{ok: true}`，`Set-Cookie` 与 Node 完全同形（`oc_human=<43 字符>; Path=/; HttpOnly; SameSite=Lax; Max-Age=28800`，并清空 `oc_human_flow`）。
- 携带该 token：未授予成员时 403，授予后 200；篡改 token、登出后、账号禁用后（重新启用后仍失效，因版本已变）、8 小时过期后均 401。

**Node-only 胶水与 HTTP 交换端口（2026-11-23 已实现）。** 原型证明登录链路上的 Node 依赖只有 HTTP 形状；该形状现已收成运行时中立端口，处理器不再引用 `node:http`：

| 位置 | 原 Node-only 部分 | 现状 |
| --- | --- | --- |
| `human-auth.ts` `handle`／`issueSession` | `IncomingMessage`／`ServerResponse` | `handle(HttpExchangeRequest) → HttpExchangeResponse \| null`；`issueSession(principal, identity)` 返回要追加的 `set-cookie` |
| `local-account/src/application.ts` | 同上，另有 `nativeOwner(request)` | 同上；`nativeOwner` 接收 `identity` 视图 |
| `access-control` `InstanceAccess.handle`（成员管理）、`ActorAccess.handle`（Actor 管理） | 同上 | 同上 |
| `identity-core/src/node.ts` `readPrivateJson` | `node:fs` 读取 setup token 与认证配置私有文件 | 未变：应改由 Worker secret／绑定提供，不读文件 |
| `local-account/src/server.ts`、`human-accounts.ts`、`account-management.ts` | `node:crypto`（`randomUUID`、`randomBytes`、`createHash`）与 `Buffer`；密码哈希经 `PasswordHasher` 端口 | 未变：`nodejs_compat` 提供前者；哈希由组合根换成纯 JS `password-hash-portable` |
| `app-host-server` `WorkbenchRequestIdentity.handle` | 下游身份产品的 `node:http` 装配端口 | 未迁移：属于下游 ABI，随 G4 另行决定 |

端口在 `@opencraft/identity-core/http-exchange`（无运行时导入）。放在 identity-core 而非新包：它的消费者都是身份／准入处理器，且请求必须携带交给 `IdentityProvider` 的 `identity` 视图，而这些类型已由 identity-core 持有；新 workspace 包会改动锁文件却没有第二类消费者。G4 把其他 HTTP 服务迁过来时若出现非身份消费者，再把与身份无关的部分拆成独立包。

- 请求：`method`、`path`（含 query）、小写单值 `headers` 加原始头列表 `rawHeaders`（重复头检测）、`clientAddress`（Node 为 socket 地址；Fetch 由组合根从可信边缘传入，Cloudflare 为 `CF-Connecting-IP`，适配器自身不信任请求头）、`readBody(limit): Promise<Uint8Array>`（流式计数，超限抛 `HttpBodyTooLarge` 并停止读取）、`signal`（替代 `response.destroyed`）、`identity`（传输层同一请求对象，Node 即 `IncomingMessage`，使一次性中继断言与准入缓存仍按同一对象命中）。
- 应答：`{status, headers: [name, value][], body}`，允许多条 `set-cookie`；`null` 表示不拥有该路由；`HttpExchangeAborted` 表示已提交的应答无法完成（Node 断开连接，Fetch 让请求失败）。
- `Host`：Fetch 适配器取路由 URL 的 host（由平台按 zone／route 保证），Node 仍取请求头。
- 适配器：`http-exchange-node`（Headless `serve-workbench-web.mjs` 与桌面 `createDesktopAccountHost` 使用）按列表顺序 `setHeader`、再 `writeHead`／`end`，超限请求流在应答写出后释放；`http-exchange-fetch`（workerd 登录入口使用）把字符串正文按字节发送，避免 `Response` 隐式加 `content-type`。Fetch `Headers` 保持 `set-cookie` 顺序，其他头名按其规范顺序迭代。
- 等价证据：迁移前后对 Headless 网关同一 77 个请求序列（登录页、session、跨源／非 JSON／`Authorization`／多余字段／超长正文／坏 JSON、账号页与 `/setup`、初始化、邀请与接受、改密、成员与审计、Actor 管理、登出、两类尝试上限）抓取原始应答字节，归一化日期、token、nonce 与 UUID 后逐字节相同。共享一致性测试 `tests/identity/http-exchange-conformance.test.ts` 对两个适配器各跑 8 项（方法／路径／头／host／地址、头顺序与多条 `set-cookie`、空正文与 303、正文上限内读取与重复读取、跨块 UTF-8、超限 413、客户端断开触发 `signal`、`HttpExchangeAborted`）。唯一有意差异：`InstanceAccess` 原先逐块 `toString()` 拼接正文，跨块的多字节 UTF-8 会被拆坏，现在整体解码。

**放置建议。** 登录写入（`human_logins`、账号版本）必须在 IC。若 Argon2id 也在 IC 中计算，全局 60 次／分钟的尝试上限下最坏约占 IC 每分钟 10 s CPU（旧 scrypt 估算为 15 s），且 IC 是全部部署级授权的单点。可选的拆分：EW 向 IC 取 PHC 参数与 salt（未知用户返回由 IC 密钥派生的稳定占位 salt，避免枚举），在 EW 计算摘要，再交给 IC 常量时间比较、复核版本并签发登录；密码明文不进 IC，摘要不出 IC。这需要把 `LocalAccountServerPlugin.verify` 拆成"派生"与"比较＋复核"两步，属于后续工作，原型未实现。尝试计数目前是进程内存，在 IC 内可沿用；放在无状态 EW 时需改用 IC 计数或 Workers Rate Limiting 绑定。

**OIDC（未实现，Worker 需要的条件）。**

- `openid-client` 6.9.0（基于 `oauth4webapi`，只用 `fetch` 与 WebCrypto）可被 esbuild 打进 workerd bundle 并完成模块求值（原型 bundle 已包含 `human-auth.ts` 的顶层 `import * as oidc`）；discovery、授权码交换与 ID Token 验签尚未在 workerd 中跑通，需用模拟 issuer 测试。workerd WebCrypto 支持 RS256／ES256／EdDSA 验签；`timeout` 依赖 `AbortSignal.timeout`；`allowInsecureRequests` 只用于 HTTP 回环测试 issuer。
- discovery 结果与 JWKS 目前缓存在 `HumanAuth.#clients` 的 `Configuration` 内存中（按 provider，未知 `kid` 时由库重取）。DO 驱逐后重新 discovery 即可；若放在 EW，每个 isolate 各自缓存，需接受冷启动多一次 discovery＋JWKS 往返，或由 IC 缓存元数据。
- state、nonce、PKCE verifier 与发起浏览器摘要现存于 `HumanAuth.#flows`（内存，10 分钟，一次性）。Node 重启丢失事务是既定语义；在 Cloudflare 上必须由 IC（或专用 DO）持有，EW 不能保存，因为回调可能落到另一个 isolate。若要跨 DO 驱逐保留，需写入 DO storage 并保持"一次性消费"。
- 回调中 `response.destroyed` 判断已改用交换请求的 `signal`；`claims.exp` 与流程过期依赖 `Date.now()`，Workers 在请求内冻结时钟（I/O 后推进），对分钟级窗口无影响。
- 客户端密钥来自 Worker secret，而非 `readPrivateJson` 私有文件。

**需在真实 Cloudflare 上确认。** 线上纯 JS Argon2id 单次验证 CPU 时间（本地约 0.17 s）；IC 在并发登录下的排队延迟；`CF-Connecting-IP` 作为限流键；OIDC 对真实 issuer 的 discovery、出站超时与 JWKS 轮换。

## 4. 拆分方式

### 4.1 组合根按角色分开，owner 共享

把 `startHeadlessServer` 从"一个函数构造一切"改为若干**按 owner 分组的装配模块**，每个模块只接收端口与上游 owner，返回服务对象和 `close`：

| 模块（提议） | 内容 | Node Gateway | Cloudflare |
| --- | --- | --- | --- |
| `installation` | 核心 SQL owner、主体／准入／协作／编排／spaces、ServerInformation、MCP apps、connectors、push 订阅 | Gateway 进程内（现状） | IC DO |
| `account` | 模型策略、网关设置、凭据、订阅 | Gateway＋`proxy` | AC DO |
| `workspace-host` | Codex overlays、执行租约、capability MCP 签发、资源生命周期、终端／文件／浏览器转发、readiness | Gateway 内 Worker（workspace-host-split §3.2 方案 A） | WH DO |
| `client-session` | AppHost 逻辑路由、访问会话、订阅、resume、心跳 | Gateway 内每连接对象 | Client DO（按客户端实例） |
| `edge` | HTTP 路由表、静态资源、登录页、webhook 验签 | `createWorkbenchWebServer` | EW |
| `node-local` | SSH、本机桌面、relay、观测、可用性通知、匿名模式、本机文件 | Gateway | 不装配 |

`HA` 最终只剩 Node 组合根：读取 CLI 选项与私有文件、选择 Node 适配器、按配置调用上述模块，并保留现有关闭顺序（见 §4.1.1 第 2 部分）。Cloudflare 的每个 DO 类各有一个小组合根，调用同一模块的 DO 适配器版本。领域类（`access-control`、`host-schedules`、`host-recovery`、`CodexEngineAdapter` overlays 等）只写一份。

#### 4.1.1 现状映射（2026-11-23，main `0be3cf047`）

本节以 main `0be3cf047` 的 `apps/headless-server/src/headless-application.mjs`（1678 行，145 个 `import`）为准，`startHeadlessServer` 位于 320–1656 行；下文不带文件名的行号均指该文件。这是 G1 的第一步：只描述现状并给出抽取顺序，不改代码。"组合根"表示留在 Node 根的选项校验、配置读取与连线；"前向"表示闭包读取的对象在更后的行才构造，只因调用发生在构造之后才成立。

**1. 分段。** 按源码顺序列出连续段；同一段跨模块时在"目标模块"中写明拆分点。"需关闭"只列该段创建、由 `close` 释放的资源。

| 行 | 构造 | 目标模块 | 消费的上游 | 需关闭 |
| --- | --- | --- | --- | --- |
| 320–393 | 选项与 `composition` 校验；`readCodexBridgeConfiguration`（334）、agent bridge（344）、`loadLocalMachineAccess`（347）、`loadHeadlessExtensions`（359）、路径、SSH Server 绑定（376–379）、桌面访问策略（380–384）、`assertHeadlessWebRelease`（386）、`secureDataDirectory`（387）、`prepareProductPluginRelease`（391） | 组合根；347、376–384 的结果交给 node-local，386、391 交给 edge | `options`、`composition` | 无 |
| 394–407 | `createCommitFenceBuffer`、`installHeadlessExtensions`、`openServerCoreOwner`、`OrchestrationRuntimeWorker`、`releaseLock` | installation | 扩展（359）、`dataDirectory` | `serverStorage`、`orchestrationStorage`、扩展安装（均经 `releaseLock`，最后释放） |
| 408–483 | 约 60 个 `let` 前向槽；`terminalServices`（445）、`createHostFileSystem`（446）、`SessionCapabilities`＋`capabilitiesReady`（461–465）、`remoteExecutionAuthorities`（478） | 组合根（共享可变状态，见第 3 部分）；446 归 workspace-host | `options.fileSystemOwner` | `fileSystem`、`terminalServices` |
| 484–540 | `close` 组装 | 组合根 | 全部槽 | — |
| 542–546 | SSH 入口、relay、human auth、IM 配置读取 | 组合根（读取）；结果分属 node-local（SSH、relay、IM）与 installation（human auth） | `options`、`composition.relayAssertionOptions` | 无 |
| 547–549 | `createHubController`、`MembershipStore` | installation | `serverStorage`、human auth／relay 配置 | `hubController`（入口阶段）、`membership` |
| 550 | `readDaemonMachineIdentity` | installation（machine identity，所有模块消费） | `dataDirectory` | 无 |
| 551–552 | `modelPolicyPath`、`ModelPolicyStore` | account | `dataDirectory` | `modelPolicy` |
| 554 | `ActorStore` | installation | `serverStorage` | `actorStore` |
| 555–611 | ENV 交付校验、`composition.createIdentity`（562–576，含 capability provider 注册 575）、ENV owner 选择、工作区路由校验、外部 provider 与 `externalHuman` | installation | `membership`、relay 配置、`hubController`、`machineIdentity`、`actorStore`、`instanceAccess`（567–568 前向） | `identity`、`identity.executionEnvironment` |
| 612–640 | `HumanAccounts`、`LocalAccountServerPlugin`、`HumanAuth`、setup token、`HumanAccountManagement`、`LocalAccountApplication`、`openLoginAdmissionPolicy`、`InstanceAccess` | installation | `serverStorage`、`actorStore`、`membership`、`externalHuman`、`identity.admissionPolicy` | `humanAccounts`、`humanAuth`、`accountManagement`、`accountApplication`、`loginAdmission` |
| 641–670 | `openHeadlessAssetsStorage`、`WorkspaceNativeAdmission`、`createWorkspaceBotProvider`、`openWorkspaceExecutionService` | installation（分配账本与 vault Worker；分配动作是 workspace-host 的创建者） | `machineIdentity`、`instanceAccess`、`actorStore`、`conversationResources`（666 前向） | `assetsStorage`、`botAdmission`、`installedBotProvider`、`ownedWorkspaceRouting` |
| 671–732 | `authorizeExecutionHandoff`、`inspectExecutionHandoff`、`openHumanAssets`、`gitExecutionOwner`、`createHumanGitExecution`＋Git 状态能力、ENV launch／metadata／handoff、`coreCodexEnvironmentLaunch` | installation（`inspectExecutionHandoff` 读 workspace-host 的 `executionRecovery`／`resolveExecutionNative`，抽取时作为端口传入） | `actorStore`、`instanceAccess`、`humanAuth`、`assetsStorage`、`identity`、`serverStorage`、`capabilities` | `assetsService`、`humanGitExecution`、`withdrawGitStatus` |
| 733–761 | `authenticateHuman`、`ActorAccess`、`IdentityWrites` 与各 `useOwnerWrites` | installation | `providers`、`instanceAccess`、`humanAuth`、`actorStore`、`identityFence` | `identityWrites` |
| 762–791 | 引擎校验、`piEngine`／`independentEngine` 槽、`createRoutedConversationExecution` | workspace-host（Thread→Host／server 路由与 Host 输入提交；installation 的 `Collaboration` 消费它） | `machineIdentity`、`appHostServer`（前向）、`startDsh`（774，995 才声明）、`executionStore`、`resolveExecutionNative` | 无 |
| 792–795、808–809 | `ServerSpacesRuntime`、`ThreadAccessStore`（`permissionOwner` 为网络线程过渡连接）、`threadNotes` | installation | `serverStorage`、`actorStore` | `serverSpaces`、`threadAccess` |
| 796–807 | `anonymousDeployment`、`deploymentOperator`、`anonymousDriver`、`signExecutionCli` | node-local（匿名部署）；`signExecutionCli` 归 workspace-host | `membership`、`hubController`、`serverSpaces`、`actorCollaboration`（805 前向）、`capabilityKey`（803，937 才声明） | 无 |
| 810–842 | `accessServerForHost`、`createThreadPolicySession`、`createThreadAccessSession` | client-session | `threadAccess`、`serverSpaces`、`identity.isThreadCreator`、`instanceAccess`、`membership`、`threadNotes`、`appHostServer`（819、834 前向） | 无（每连接对象随连接关闭） |
| 843–865 | `Collaboration`、`attachSpaces`、`ThreadOrchestrationBroker`、`createProjectAutomations`、`CollaborationHttpApi`、三者 `start` | installation | `serverStorage`、`actorStore`、`conversationExecution`、`operator`、`orchestrationStorage`、`threadAccess`、`serverSpaces`、`appHostServer`（849、858 前向）、`codexAgentBridge`（861 getter，读 989 的重新赋值） | `actorCollaboration`、`threadOrchestration`、`projectAutomations` |
| 866–876 | `LocalDesktopService` | node-local | `desktopAccess`、`dataDirectory` | `desktop` |
| 877–882 | `HeadlessConnectors` | installation | `actorAccess`、`capabilities`、`instanceAccess`、`conversationExecution` | `connectorService` |
| 883–912 | `RemoteBrowserService`、`connectBrowserRouting`、`authorizeBrowserExecution`、`RemoteBrowserCapabilities` | workspace-host | `workspaceRouting`、`actorStore`、`instanceAccess`、`threadAccess`、`actorCollaboration`、`capabilities`、`remoteExecutionAuthorities`、`appHostServer`（910 前向） | `remoteBrowser`、`browserCapabilities` |
| 913–933 | `capabilities.resolveContext`、`CapabilityBindingProjection` | 解析器归 workspace-host；绑定投影归 installation | `conversationExecution`、`actorCollaboration`、`actorStore`、`humanGitExecution`、`serverStorage` | `capabilityBindings` |
| 934–978 | `capabilitySigningKey`、`SessionCapabilityMcp`（hostGit、hostEnvironment、orchestration 回调）、`listen`、`localExecutionCli` | workspace-host | `capabilities`、`capabilityBindings`、`humanGitExecution`、`gitExecutionOwner`、`environmentLaunch`／`environmentHandoff`、`actorCollaboration`、`threadOrchestration` | `capabilityMcp`、`connectedExecutionCli` |
| 979–993 | `startCodexEngineHost`、`createBridgeSessionMcp` | workspace-host | `capabilityMcp`、`machineIdentity` | `codexEngineHost` |
| 994–1062 | `startDsh`、`attachEngineHost`、`pi-owner` 锁、`PiEngine`、`startEngineHost` | workspace-host（引擎；目标载体是容器） | `connectedExecutionCli`、`modelPolicyPath`、`capabilities`、`fileSystem`、`identity`、`environmentLaunch`、`humanGitExecution`、`actorCollaboration`、`threadOrchestration`、`appHostServer`（1020 前向） | `agent`、`dshAgent`、`releasePiOwner`（Pi 附件随 `piEngine.close`） |
| 1063–1108 | 存储 outcome 表、`AppServerIdentityOverlay` 或 `ThreadIdentityDatabase`＋`ExecutionLeaseStore`、`resolveExecutionNative`（`/proc`）、`createWebSocketExecutionTurnInspector`、未定租约对账 | workspace-host | `agent`、`identity.createThreadMetadata`、`piEngine`、`startDsh` | `agentIdentity`、`executionDatabase`、`executionRecovery` |
| 1109 | `McpAppsService` | installation | `dataDirectory` | `mcpApps` |
| 1110–1121 | `TokenUsageQueryService` | workspace-host（AC 汇总待 workspace-host-split §4.2） | `machineIdentity` | `usageQueries` |
| 1122–1136 | 终端 owner 工厂 `terminalService` | workspace-host | `options.terminalOwner`、`identity`、`environmentLaunch` | `terminalServices`（445 的槽） |
| 1137–1174 | `workspaceLifecycleRouting`、`ConversationResourceLifecycle.open`、`resourceAuthority`、`terminalScope` | workspace-host（释放动作；行在 installation 的核心库，§2.3） | `serverStorage`、`remoteBrowser`、`terminalService`、`ownedWorkspaceRouting`、`identity` | `conversationResources` |
| 1175–1191 | `createCodexTransport`、SSH 远端 `createRemoteCodexTransport` | workspace-host；SSH 分支归 node-local | `remoteExecutionAuthorities`、`browserCapabilities`、`storageOpened` | 无（随 AppHost transport） |
| 1192–1396 | `AppHostServer` 与 `createTransport` 链：IM 频道（1197）、DSH／Pi（1199–1207）、预置／SSH 远端（1208–1213）、`local-codex` 的 `CodexEngineAdapter`＋bridge＋`CodexHostServices`（1214–1356）、ENV／工作区目录／模型网关设置／终端／文件／资源／Push 装饰（1357–1394） | 拆分：`AppHostServer` 与访问会话归 client-session；每 Host transport 链归 workspace-host；`ModelGatewaySettingsTransport`（1365–1371）消费 account | 几乎全部上游；`sshManagement`（1211 前向）、`turnPush`（1392 前向） | `appHostServer` |
| 1397–1405 | `ServerInformationStore`、`serverInformationHttp` | installation | `actorAccess`、`actorStore`、`instanceAccess` | 无 |
| 1406–1423 | `humanActorAccess`、`accountModelDefaultsHttp`、`ActorSshKeys`、`actorSshKeysHttp` | installation | `actorAccess`、`actorStore`、`instanceAccess`、`serverStorage`、SSH 入口配置 | `personalSshKeys` |
| 1424–1446 | `TurnPushService`（`openPushStore`） | installation（订阅；发送端待 `fetch` 端口） | `serverInformation`、`identity`、`imPlugins`（前向）、`actorAccess`、`humanAuth`、`humanAccounts`、`threadAccess`、`appHostServer` | `turnPush`（入口阶段） |
| 1447–1460 | `SshManagement`、`createObservabilityIngress` | node-local | `appHostServer`、`sshServers`、`instanceAccess`、`actorStore` | `sshManagement`、`observability` |
| 1461–1467 | `HostFileDownloads` | workspace-host（`"local"` 模式归 node-local） | `fileSystem`、`ownedWorkspaceRouting`、`remoteServers`、`sshManagement` | `fileDownloads` |
| 1468–1471 | `startHeadlessRuntimePlugins` | edge（声明的路由挂到入口） | `instanceAccess`、`humanAuth` | `runtimePlugins` |
| 1472–1582 | `createWebServer`：服务表、`createTerminalSession`、`getStorageOutcomes`、`modelPolicyService`（1538–1564）、`speechService`（1580–1581） | edge；1538–1564 与 1580–1581 归 account；`getStorageOutcomes` 汇总留组合根 | 全部服务对象 | `web`（`speechService` 由 `serve-workbench-web.mjs:1442` 随 Web 关闭） |
| 1583–1606 | `conversationResources.retry`、`reconcileResources`、60 s `setInterval` | workspace-host（G5 改为 owner 定时器） | `remoteBrowser`、`workspaceLifecycle`、`terminalService`、`appHostServer` | `resourceReconciliationTimer` |
| 1607–1627 | 监听：`web.listen`，或 `createSshNativeRpcGateway`＋`createSshHttpIngress`；`connectRelay`；`hubController.node.start`；`maintainHeadlessCodexHost` | 监听归 edge；SSH 入口与 relay 归 node-local；Hub 启动归 installation；readiness 归 workspace-host | `web`、`appHostServer`、`personalSshKeys`、`identity.sshAccess` | `ingress`、`sshNativeRpc`、`relay`、`codexReadiness` |
| 1628–1646 | `createPersonalAssistantHost` | node-local（§6 问题 5 待决） | `installedBotProvider`、`botAdmission`、`assetsStorage`、`identity`、`actorCollaboration`、`modelPolicyPath` | `personalAssistantHost` |
| 1647–1649 | `startImPlugins`、`startAvailabilityNotification` | node-local（IM 归属待决，§6 问题 3） | `capabilities`、`capabilityMcp`、`actorStore`、`actorCollaboration`、`actorAccess`、`appHostServer`、`instanceAccess`、relay 配置 | `imPlugins`、`availabilityNotification` |
| 1650–1655 | `capabilitiesReadyResolve`、返回值、启动失败时 `close()` | 组合根 | — | — |

**2. 关闭顺序（484–540）。** `close` 幂等（483–488：先发布共享 promise 再调用任何 disposer）；`settle` 收集失败而不中断后续步骤。下表按执行顺序列出；同一格内标"并行"的为 `Promise.allSettled`，其余串行。

| # | 行 | 内容 | 模块 |
| --- | --- | --- | --- |
| 1 | 493–495 | `capabilitiesReadyResolve()`；`clearInterval(resourceReconciliationTimer)`；`conversationResources.close()` | 组合根；workspace-host |
| 2 | 503 | `web.close(update, closeEntry)`：Web 停止接受后在载体阶段调用 `closeEntry` | edge |
| 3 | 497–502、505 | `closeEntry`（并行、只执行一次）：`hubController`、`turnPush`（installation）；`relay`、`ingress`、`sshNativeRpc`、`desktop`、`availabilityNotification`、`imPlugins`（node-local）；`codexReadiness`、`usageQueries`、`fileDownloads`（workspace-host）；以及串行一组 `withdrawGitStatus`（installation 的 Git 能力撤回）→`browserCapabilities`→`remoteBrowser`（workspace-host） | 多模块 |
| 4 | 508 | `runtimePlugins` | edge |
| 5 | 509 | `personalSshKeys.close()`（组合根前置 PR 起经 `settle`，此前为同步裸调用） | installation |
| 6 | 510 | `observability` | node-local |
| 7 | 511–515 | 逐个：`projectAutomations`、`threadOrchestration`（installation）→ `personalAssistantHost`（node-local）→ `appHostServer`（client-session）→ `codexEngineHost`（workspace-host） | 多模块 |
| 8 | 516–518 | `terminalServices` 逐个关闭并清空；`fileSystem.close()` | workspace-host |
| 9 | 519–520 | 并行：`threadOrchestration`（第二次）、`connectorService`、`actorCollaboration`、`threadAccess`、`serverSpaces`；然后 `orchestrationStorage` | installation |
| 10 | 521–523 | 并行：`agent`、`dshAgent`、`connectedExecutionCli`、`capabilityMcp`；然后 `releasePiOwner`；然后并行 `executionRecovery`、`agentIdentity` | workspace-host |
| 11 | 526–532 | 串行写入者：`executionDatabase`（workspace-host）→ `modelPolicy`（account）→ `mcpApps`（installation）→ `sshManagement`（node-local）→ `identity.executionEnvironment`、`identity.close`、`loginAdmission`、`ownedWorkspaceRouting`、`installedBotProvider`、`botAdmission`、`humanGitExecution`、`assetsService`、`assetsStorage`（installation）→ `composition.close`（组合根）→ `accountApplication`、`accountManagement`、`humanAuth`、`humanAccounts`、`identityWrites`、`capabilityBindings`、`actorStore`、`membership`（installation） | 多模块 |
| 12 | 533–537 | 有失败：抛 `AggregateError`，不释放写锁（进程退出才释放）；否则 `releaseLock`：`orchestrationStorage`、`serverStorage`、`releaseExtensions` | installation |

由此得出：installation、workspace-host 与 node-local 的关闭在第 3、7、9–11 步交错，任何模块都不能只返回一个 `close`。抽取后的模块应返回**具名 disposer**（按所属步骤分组），由组合根在原位置逐个调用，`close` 的结构与顺序保持字面不变。`threadOrchestration.close()` 被调用两次（512、519），依赖其幂等，照原样保留。509 原先的同步异常不经 `settle`，会使 `closing` 直接拒绝并跳过其后的全部步骤（与第 12 步一样不释放写锁）；组合根前置 PR 已把它改为经 `settle`，失败与其他 disposer 一样汇总进 `AggregateError`，其后的步骤照常执行（`tests/server/headless-composition.test.mjs` 覆盖）。

**3. 跨模块依赖、环与共享可变状态。** 以下各项决定抽取顺序；抽取相应模块时它们都要变成显式端口，而不是继续读组合根的 `let`。

1. **`closing`（483）。** installation（675、679、683、722、1262）与 workspace-host（891、897、953、1587、1602）的授权闭包直接读它。抽取 installation 或 workspace-host 之前需要一个由组合根持有的 `lifecycle.closing()` 端口。
2. **`appHostServer`（412 声明，1192 赋值）形成环。** installation 的 `Collaboration` 经 `conversationExecution`（771）、编排执行（849、858）与 Push 历史读取（1444）调用 AppHost；AppHost 的 transport 又调用 `actorCollaboration`／`threadOrchestration`（1205–1206、1278–1304、1325–1341）。client-session（819、834）、workspace-host（910、1020、1597、1627）与 node-local（1452–1453、1612、1619、1621、1647）也经前向闭包读取。在 client-session 抽取前，组合根需提供迟绑定的 AppHost 端口（getter），各模块只接收该端口。
3. **`conversationResources`（475 声明，1140 构造）形成 installation↔workspace-host 环。** Assets 的工作区执行服务在 666 用 `assertThreadActive` 读它；生命周期的 `workspace` 释放又调用该路由（1139、1153）。
4. **`executionStore`／`resolveExecutionNative`（419–420，1075–1092 赋值）。** workspace-host 的产物被更早构造的 installation 闭包（678–683）与 `conversationExecution` 输入提交（777–787）读取；installation 需要接收一个执行观察端口。
5. **TDZ 前向常量。** `signExecutionCli`（803）引用 937 才声明的 `const capabilityKey`；`getInputs`（774）引用 995 才声明的 `const startDsh`。两段移入不同模块后必须改为迟绑定端口，否则抽取本身会改变求值时机。
6. **共享 capability 注册表与就绪门。** `capabilities`（461）被 installation（575、706、877）与 workspace-host（901、915、938、999、1046）注册或使用；`capabilitiesReady`（464–465）在 493、1650 解决，在 Codex adapter 中等待（1229、1238、1246）。注册表与就绪门留在组合根，作为输入传给两侧。
7. **`codexAgentBridge`（334 `let`）。** workspace-host 在 989 重新赋值，installation 的项目自动化经 getter 读取（861），adapter 在 1324 读取。
8. **迟读的槽（不构成环，但需要 getter 端口）。** `turnPush`（1424）在 1392 被读；`imPlugins`（1647）在 1428–1431、1508、1516 被读；`sshManagement`（1449）在 1211、1464 被读；`instanceAccess`（640）在 567–568 被读（installation 内部）。
9. **`remoteExecutionAuthorities`（478）。** SSH 远端 transport（1180–1182，node-local）写入，浏览器授权与 capability 上下文解析（902–905、917–925，workspace-host）读取。
10. **网络线程过渡连接。** `ThreadAccessStore` 以 `serverStorage.database` 为 `permissionOwner`（794）；这是 G2 的剩余部分，在 installation 内部，不阻塞模块边界。

**组合根前置 PR 已移除的阻碍（2026-11-24）。** `apps/headless-server/src/assembly/lifecycle.mjs` 提供 `createHeadlessLifecycle()`（`closing()`、`shutdown(dispose)`）与 `createLateBinding(name)`（`bind` 只允许一次；`get()` 在绑定前抛出具名错误；`current()` 在绑定前返回 `undefined`，供原本就容忍"尚未构造"的读者）。各值仍在原来的位置、原来的时刻可用，关闭顺序不变。

- 第 1 项：`let closing` 删除；上列授权闭包与资源对账改读 `lifecycle.closing()`，ENV 交接的 `closed` 直接接收 `lifecycle.closing`；`close` 经 `lifecycle.shutdown` 发布同一个共享 promise。
- 第 2 项：AppHost 改为 `lateAppHost`；构造之前的闭包（771、819、834、849、858、910、1020）读 `lateAppHost.current()`，构造之后的组合根代码读同一常量。环本身仍在，留待 client-session 抽取。
- 第 3 项：`conversationResources` 改为 `lateConversationResources`；666 的 `assertThreadActive` 读端口，错误文案不变。
- 第 4 项：`executionStore` 与 `resolveExecutionNative` 合为 `lateExecutionObservation`（`{ store, resolveNative }`），在原 `resolveExecutionNative` 赋值处一次绑定（两者之间没有 `await`，绑定时机不变）；678–683、777–787 与身份覆盖层的回调读端口，绑定前仍按"无 native"处理。
- 第 5 项：`capabilityKey` 与 `startDsh` 改为 `lateCapabilityKey`／`lateStartDsh`，在原声明处绑定；803、774 经 `get()` 读取，过早调用得到具名错误而不是 TDZ `ReferenceError`。
- 第 7 项：`let codexAgentBridge` 改为 `configuredCodexBridge`＋`lateCodexBridge`：没有自有 Engine Host 时启动即绑定配置值，否则在 989 绑定 Engine Host 的 bridge；861 的 getter 与 1324 读端口。
- 第 8 项：`turnPush`、`imPlugins`、`sshManagement` 改为 `lateTurnPush`／`lateImPlugins`／`lateSshManagement`，在原构造处绑定（`sshManagement` 未配置时绑定 `undefined`）；前向读者与 `close` 读端口。1464 的文件下载在 `sshManagement` 之后构造，直接读常量。`instanceAccess` 在 567–568 的读取属 installation 内部，未改。
- 未处理：第 6 项（注册表与就绪门本就是组合根持有的常量，抽取时作为输入传入即可）、第 9 项（`remoteExecutionAuthorities` 是 `const Map`，不是前向绑定，随 workspace-host／node-local 抽取时作为共享端口传入）、第 10 项（G2）。`close` 自身读取的其余 `let` 槽是组合根内部的 disposer 汇总，按上文"具名 disposer"方案随各模块抽取替换。

**4. 推荐抽取顺序（每个 PR 一个模块）。**

1. **account**（理由见下）。
2. **组合根前置（不移动服务，已完成，见上）**：引入 `lifecycle.closing()` 与迟绑定端口（AppHost、`executionStore`／`resolveExecutionNative`、`capabilityKey`、`startDsh`、`codexAgentBridge`、第 3 部分第 8 项的槽），把直接读 `let` 改为读端口；行为不变。之后各模块只接收端口。
3. **node-local**：347、376–384、796–807、866–876、1447–1460、1610–1625 中的 SSH 入口与 relay、1628–1649。依赖 AppHost 端口与 installation 的 `instanceAccess`／`actorStore`；其 disposer 分布在关闭第 3、6、7、11 步。
4. **installation**：段落多，建议分两个 PR 落到同一模块：先身份与准入（394–407、547–761 中除 account 外的部分），再协作与部署级服务（792–795、808–809、843–865、877–882、913–933 的绑定投影、1109、1397–1446）。
5. **workspace-host**：762–791、883–1191、1196–1394 中的 transport 链、1461–1467、1583–1606、1627。依赖 installation 的全部输出；P4-2 已把 overlays 移入 `packages/workspace-host`，这里只是装配。
6. **client-session**：810–842、`AppHostServer` 外壳（1192–1196）与 `createWebServer` 中的会话工厂（1482–1503）；与 G6 一并考虑。
7. **edge**：1468–1582 与 1607–1624 中的监听；它消费所有服务，最后抽取。

**第一个模块：account。** 入站依赖最少：构造只需要 `dataDirectory` 与 Codex Core 端点／令牌；HTTP 鉴权需要的 `actorAccess`／`actorStore`／`instanceAccess` 在调用点（1538）已经存在，作为参数传入即可。它不读 `closing`、不读任何前向槽，不参与第 3 部分的任何环；被移动的行与频繁修改的身份、ENV、工作区段落不重叠；关闭只有第 11 步的一个位置。

- **移动的行。** 551–552（`modelPolicyPath`、`new ModelPolicyStore`）；1538–1564（`modelPolicyService` 的立即执行函数：`configuredModelGatewayPath`、`gatewayContributions`、个人订阅的 `CodexCoreControlClient`、`modelGatewayHttp`、`modelPolicyHttp` 与两者的组合）；1580–1581（`SpeechTranscriptionService`＋`SpeechModelConfiguration`）。527 的 `() => modelPolicy?.close()` 改为同一位置的 `() => account?.close()`；425 的 `let modelPolicy` 改为 `let account`。随之移出的 import：`ModelPolicyStore`（38）、`modelPolicyHttp`（39）、17 行中的 `modelGatewayHttp`、`gatewayContributions`（18）、`SpeechModelConfiguration`（122）、`SpeechTranscriptionService`（123）；`configuredModelGatewayPath` 与 `CodexCoreControlClient` 仍被 1352、1365、1640 使用，`ModelConfigurationRepository`／`ModelCredentialRepository` 仍被 1043、1205 使用，留在原文件。
- **不移动。** `ModelPolicyTransport`（1198、1356）、`ModelGatewaySettingsTransport`（1365–1371）、Pi 模型配置（1043）、DSH transport 内的模型仓库（1205）、`codexAccountsService`（1352）、个人助理模型源（1636–1643）：它们属于 transport 链、引擎或个人助理，随 workspace-host／node-local 抽取，届时消费 account 的输出。
- **签名（提议，`apps/headless-server/src/assembly/account.mjs`）。**

  ```js
  export function assembleAccount({ dataDirectory, codexCoreEndpoint, codexCoreAuthToken }) {
    // 返回：
    // modelPolicyPath   供 997、1046、1314、1356、1636 原样使用
    // modelPolicy       model-usage-policy.sqlite 的唯一写入者
    // createHttpService({ actorAccess, actorStore, instanceAccess }) → (request, response) => Promise<boolean>
    //                   在原 1538 位置调用，configuredModelGatewayPath() 与订阅客户端仍在 Web 构造时求值一次
    // createSpeechService() → SpeechTranscriptionService；关闭仍由 Web（serve-workbench-web.mjs:1442）负责
    // close()           = modelPolicy.close()，同步；只在关闭第 11 步第 2 位调用
  }
  ```

  组合根在原 551 位置调用 `assembleAccount`（仍在 `machineIdentity` 之后、`ActorStore` 之前），打开顺序与启动失败回滚路径不变。
- **现有测试。** 领域与 HTTP：`tests/execution/model-usage-policy.test.ts`（`ModelPolicyStore`、`modelPolicyHttp`、`ModelPolicyTransport`）、`tests/usage/model-gateway.test.ts`（`modelGatewayHttp` 与 contributions）、`tests/execution/personal-subscription.test.ts`（个人订阅经 Core）、`tests/composer/speech-model-configuration.test.ts` 与 `tests/composer/hunyuan-speech.test.ts`（语音服务）。组合根：`tests/server/headless-composition.test.mjs` 的"a disposal failure settles other resources but retains the writer until process exit"（403 行：`close` 幂等、失败不释放写锁）与 `tests/server/headless-server.test.mjs` 的启动与服务用例。**缺口**：没有测试在真实 `startHeadlessServer` 上请求 `/__opencraft_model_policy` 或 `/__opencraft_model_gateway`；该 PR 应补一个组合测试（匿名、成员、管理员三种响应，以及关闭后同一数据目录可再次启动，证明策略库写入者在写锁释放前关闭）。

### 4.2 需要成为端口的部分

| 端口 | 现状 | Node 适配器 | Cloudflare 适配器 |
| --- | --- | --- | --- |
| HTTP 处理 | 身份与准入处理器（`HumanAuth`、`LocalAccountApplication`、`InstanceAccess`、`ActorAccess`）已改为 `@opencraft/identity-core/http-exchange` 端口（§3.4）；其余服务仍是 `handle(IncomingMessage, ServerResponse)`（`collaboration.ts:22`、`app-host-server/src/index.ts:11`、`hub-network` 等） | `http-exchange-node`（已实现） | `http-exchange-fetch`（已实现，workerd 登录入口使用） |
| WebSocket 会话 | `ws` 对象直接进入会话逻辑（`serve-workbench-web.mjs:1180-1290`） | `ws` 包装 | DO hibernation WebSocket |
| 定时器 | `setInterval`（HA:1350；`conversation-resource-lifecycle.mjs:64`；`observability-ingress.mjs:49`；`serve-workbench-web.mjs:397`；host-schedules 2 s 轮询） | owner 定时器 | DO alarm（每 DO 单个，需要合并到"下一个到期时间"） |
| 单写者 owner | `worker_threads` Worker（核心 owner、编排、spaces、assets vault、token usage 查询、push） | `@opencraft/worker-owner` | DO 本身即单写者，`SqlDatabase` 同步调用（storage-ports §6） |
| 存储 | 模型策略、MCP apps、push、connectors 的领域存储已在 `SqlDatabase` 端口上（G3）；仍直接使用 `node:sqlite` 的部署级 owner 见 §5.1 G3 | 迁到 `SqlDatabase` 端口；Node 打开仍经 `openManagedDatabase`＋`nodeSqlDatabase` | DO SQL |
| 引擎与资源通道 | UDS、私有描述符、loopback URL、`/proc` | `WorkspaceLink` 的本地 socket 适配 | DO → Container 端口（workspace-host-split §3.3） |
| 出站 HTTP | `node:https`／`node:net`／`node:dns`（push、connectors SSRF 检查） | 现有实现 | `fetch`；SSRF 校验需另行设计 |
| 进程创建 | `child_process`、`proper-lockfile`（Pi、DSH、个人助理、Git Worker） | 不变 | 只在容器内 |

**不提供于 Cloudflare 的能力**（只在 Node 组合根装配，Cloudflare 不声明，Web 端按现有缺席分支呈现）：本机文件"local"模式（HA:1215）、SSH 管理与 SSH 入口、本机桌面观察与控制、relay-connect、匿名部署、同机托管访问文件、观测 ingress、可用性通知监听、读取服务器主机文件系统或进程的一切能力。

## 5. 依赖顺序与分步计划

### 5.1 步骤

每步在 Node 上独立可发布、可回退；"P4-n"指 [workspace-host-split §7](workspace-host-split.md#7-分步计划) 第 n 步。

状态列按 main `0be3cf047`（2026-11-23）核对；"完成"只指本表该步的内容，PR 号来自 `git log origin/main -- <路径>`。

| 步 | 内容 | Node 价值 | 依赖 | 状态（2026-11-23） |
| --- | --- | --- | --- | --- |
| G1 | 把 `HA` 按 §4.1 拆成装配模块，行为与关闭顺序不变 | 组合根可测、可读；嵌入方（Docker gateway）复用模块 | 无 | **进行中**：account 已抽到 `apps/headless-server/src/assembly/account.mjs`（#552）；组合根前置的生命周期与迟绑定端口在 `assembly/lifecycle.mjs`；其余段仍在 `startHeadlessServer`，现状映射与抽取顺序见 §4.1.1 |
| G2 | 合并 `opencraft-server.sqlite` 的编排与空间连接到核心 owner（已实施，见 [server-core-owner §4](../server/server-core-owner.md#4-分阶段实施)）；网络线程过渡连接随 server-core-owner 第 2–6 阶段移除 | 消除同库多 Worker 写入者；减少主线程同步 IO 登记 | G1 | **部分**：合并已完成（`orchestration-runtime-domain`、`server-spaces-domain` 注册在 `apps/headless-server/src/server-core-worker.mjs`，#511；身份写入 #463）；过渡连接仍在（`ThreadAccessStore` 的 `permissionOwner: serverStorage.database`，`headless-application.mjs:794`），server-core-owner 第 2–6 阶段未完成 |
| G3 | 剩余直接 `node:sqlite` 的部署级库（模型策略、MCP apps、push、connectors）迁到 `SqlDatabase` 端口 | 统一迁移与 outcome 报告 | 存储端口第 1–2 阶段（已实施） | **部分（2026-11-24 更新）**：四个点名的库已迁。模型策略见 `packages/model-usage-policy/src/index.ts`（#511）；push 领域 `SqlPushStore` 在 `packages/web-push-node/src/sql-store.ts`，Node owner `PushStore`／`openPushDatabase` 在 `store.ts`（仍只在 push 存储 Worker 内打开）；MCP apps 的 `AppStore`／`McpAppsService` 接受已迁移的 `AppStorage`，Node 打开在 `packages/mcp-apps/src/node.ts`；connectors 的 `SqlConnectorDatabase` 在 `packages/connector-host/src/store.ts`，Node owner `ConnectorDatabase` 在 `node-store.ts`。三者领域模块不导入 `node:*`，SHA-256 由 owner 注入，事务经 `transaction()`；库文件、账本与迁移不变。workerd 一致性见 `tests/storage/deployment-stores-workerd.test.ts`（`test:storage-ports:workerd`）。仍直接使用 `DatabaseSync` 的 Headless 部署级 owner：`app-host-server` thread directory（`thread-directory/index.ts`、`snapshot-reader.ts`）、`access-control` 的 `actor-admission-reader.ts` 与两个 owner Worker 入口、`execution-environment`（`execution-environment.ts`、`employee-git-vault-store.ts`）、个人 Git（`git-identity-origin.ts`、`git-execution-authority.ts`、`personal-git-worker.ts`）、`document-storage`、`native-history-node` 转录缓存、`plugins/login-admission`、`plugins/thread-participants`、`plugins/tasks`；`account-pool-host/src/store.ts` 只剩 Node owner 打开（领域 `AccountPool` 已在端口上），`model-usage-policy/src/native.mjs` 是跨进程只读读取（storage-ports §7.1） |
| G4 | HTTP 处理改为 `Request`→`Response` 端口，Node 包装（身份与准入处理器已完成，§3.4；其余服务待迁） | 服务单测不需要真实监听 | G1 | **部分**：`@opencraft/identity-core/http-exchange{,-node,-fetch}` 与身份、准入处理器已迁（#511；Web 入口经 `serveNodeHttpExchange`，`serve-workbench-web.mjs:22`）；协作、AppHost、Hub、模型策略／网关等仍是 `(request, response)` 处理器 |
| G5 | 定时器端口；资源对账、心跳、观测改为 owner 定时器 | 关闭排空与时钟回拨可测 | G1；与 P4-3 同一抽象 | **部分**：端口已有（`OwnerWakeTimer`／`boundedWakeTimer`，`packages/workspace-host/src/index.ts:171-246`，#511），仅定时任务使用；资源对账（`headless-application.mjs:1606`、`conversation-resource-lifecycle.mjs:62`）、观测（`observability-ingress.mjs:49`）、心跳（`serve-workbench-web.mjs:399、1196`）仍是 `setInterval` |
| G6 | 拆出 `client-session`：AppHost 逻辑路由与访问会话脱离 `ws` | 连接逻辑可用内存 transport 测试 | G4 | **未开始**：`AppHostServer` 仍在组合根构造（`headless-application.mjs:1192`）；只有 workerd 原型（`tests/protocol/workerd/client-do-worker.ts`，§3.3） |
| P4-2 | 抽出 `WorkspaceHost`（Codex overlays 以工作区根打开） | 见原文 | G1 | **完成（Node）**：`packages/workspace-host`（#511）；Gateway 只装配 `default`（`headless-application.mjs:1310`） |
| P4-3 | 定时任务 owner 驱动 | 见原文 | G5 | **完成（Node）**：`packages/host-schedules/src/index.ts` 经 `OwnerWakeTimer`（#511）；唤醒仍在 Gateway 主线程，DO alarm 未做 |
| P4-4 | `WorkspaceLink` 与 `workspace-agent` | 见原文 | P4-2 | **部分**：第 4a–4c 步已实现（`packages/sandbox/src/endpoint.ts`、`scripts/container-deployment/workspace-agent*.mjs`、`packages/sandbox-node/src/static-docker.ts`、`scripts/container-deployment/gateway-workspace.mjs`，#511；7b `docker-provisioner` #532）；第 4d 步（反向 RPC 进程）未做（workspace-host-split §7"第 4d 步"） |
| P4-5 | 化身经通道上报，去除 `/proc` 与 `pid: host` | 见原文 | P4-4 | **未开始**：执行租约仍经 `/proc` 观察化身（`headless-application.mjs:1090`）；`deploy/docker/compose.yaml:134、227` 仍有 `pid: host` |
| G7 | Node 组合根声明能力清单；Cloudflare 不提供的服务集中在 `node-local` | 能力声明与实现一致 | G1 | **未开始**：没有能力清单；Node-only 服务仍散在组合根（§4.1.1 第 1 部分中标 node-local 的段） |
| C1 | DO／Container 适配器（storage-ports 第 5 阶段剩余：`sandbox-cloudflare`、Secrets 信封加密） | — | P4-4 | **部分**：`packages/sandbox-cloudflare` provider 已实现（#531）；`@opencraft/storage-cloudflare` 适配器在本地 workerd 通过一致性测试但未接入装配（#511）；Secrets 信封加密未做（`packages/storage-cloudflare/src/secrets.ts:11-15`） |
| C2 | 第一个 Cloudflare 里程碑（§5.2） | — | G1–G7、P4-2–P4-5、C1 | **未开始** |

P4-1（`proxy` 默认、全部 provider 经代理）是 AC 的前提，必须在 C2 之前完成；P4-6～8（冷迁移、多工作区、跨工作区投影）对第一里程碑不是前提，因为 Cloudflare 是全新安装，不迁移 Node 数据。

### 5.2 第一个里程碑："最小可运行"

目标：Web 静态资源在 EW；IC 提供登录与核心数据；一个工作区的 Brain＋Hands 在 Cloudflare Containers 中由 WH 持有；模型调用经 AC。

**必需：**

1. EW：静态资源与发布清单、HTTP 路由表（§3.1 中 IC／AC／Client 会话三类）、模型出口流式转发。
2. IC：核心 SQL owner（合并后）、`ActorStore`／`MembershipStore`／`InstanceAccess`／`ActorAccess`／`IdentityWrites`、`HumanAuth`＋本地账号（OIDC 可选）、`ThreadAccessStore`、`ServerSpacesRuntime`、`Collaboration`（Codex 执行准入钩子依赖它，HA:1112-1119）、编排运行时存储（`Collaboration` 构造需要，HA:687）、`ServerInformationStore`、capability 绑定与签名密钥、Assets 工作区分配中"固定一个工作区"的最小部分、machine identity。
3. AC：模型配置读取、凭据、短期凭据租约（cloudflare-deployment §2.1）、模型策略。
4. Client DO（按客户端实例）：`/apphost`／`/appserver` 终止、逻辑路由、访问会话、订阅与 resume。
5. WH（一个）：Codex Host overlays（queue、中断恢复、暂定线程；schedules 可先禁用）、执行租约、capability MCP 会话签发、容器生命周期与 `WorkspaceLink`、readiness。
6. 容器：`codex app-server`＋`exec-server`（Hands 镜像＋Brain 运行时）、`workspace-agent`、`model-egress` lane；**只有 Codex 引擎**。

**可以缺席：** DSH／Pi／ACP／Claude 引擎；`ThreadOrchestrationBroker` 的子线程派生与项目自动化（`orchestration.available()` 为假，HA:1088；需核实 Collaboration 在无 broker 时的行为）；会话定时任务；token usage 查询；终端、文件下载、预览票据；远程浏览器；connectors；MCP apps；Web Push；IM／WeCom／Slack；语音；图像生成；个人助理；Assets Bot 与个人 Git 执行；Codex agent bridge；用户插件目录；Hub／RelayHub；以及 §4.2 列出的全部 Node-only 能力。缺席服务通过不装配表达，Web 按现有缺席分支呈现，不用前端开关冒充。

**里程碑验收（提议）：** 真实 Cloudflare 账号上完成登录 → 新建 Thread → Codex Turn 流式输出 → 容器重启后按中断恢复规则处理且不重放未确认输入 → 容器文件系统中不存在模型或账号凭据。本地 workerd／Miniflare 通过不等于该验收。

## 6. 待决问题

1. **Client 连接终止点**：已决定 B（每个 Client 实例一个 Client DO，跨重连存续；协作状态由共享 owner 持有）。PoC 验收：两个客户端同时观看同一 Thread，事件扇出正确、延迟可接受，任一方断线后 resume 不丢事件、不重复；hibernation 唤醒后 resume 与访问会话的持久化成本。
2. **租户模型**：已决定（2026-11-22）：一个 Cloudflare 部署＝一个 installation（一个 IC、一个 AC），与 Node 自托管语义一致；一个 Worker 承载多个 installation 需要多租户准入，不在当前范围。
3. **IM／webhook**：WeCom 是出站长连接（`plugins/wecom/src/server.ts:16`），在 DO 上会持续占用运行时长；Slack 与通用 IM 需核实是 webhook 还是长连接。选项：Cloudflare 上只支持 webhook 型渠道；或长连接渠道留在 Node；或接受 DO 常驻成本。
4. **有意保持 Node-only 的产品范围**：确认 SSH Servers、本机桌面、relay-connect、匿名部署、观测 ingress、可用性通知在 Cloudflare 上不提供；以及 DSH／Pi／ACP 是否在后续里程碑进入工作区容器。
5. **个人助理**：其 `codex` 子进程放进专属工作区容器，还是 Cloudflare 上不提供。
6. **远程浏览器**：媒体流经 EW→WH→容器会占用 DO 带宽与时长；是否在 Cloudflare 上提供、提供时是否让客户端直连容器暴露的端点（需要新的鉴权票据设计）。Chromium 沙盒可用性仍待 PoC（cloudflare-deployment §4）。
7. **本地账号密码哈希**：已决定并实现（§3.4）：改为 Argon2id（m=19456 KiB、t=2、p=1，PHC 记录），Node 用原生 `node:crypto.argon2`，Workers 用纯 JS `@noble/hashes`（本地单次验证约 0.17 s、工作内存约 19 MiB，避开 scrypt 128 MiB 与 isolate 上限相等的风险）；旧 scrypt 记录仅在 Node 验证并在成功登录时升级。Free 计划 10 ms CPU 仍不可行；线上 CPU 时间待真实账号确认。
8. **出站 SSRF 校验**：connectors 与 push 依赖 `node:dns`／`node:net` 做地址检查；Cloudflare 上用什么等价机制。
