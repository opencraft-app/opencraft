# OpenCraft platform architecture

本页是架构入口。正式契约按职责归并在下列专题页中；实现状态、目标设计与验收限制保留在对应正文。修改行为时维护对应专题，避免继续在本页追加实现细节。

| 专题 | 范围 |
| --- | --- |
| [Architecture and topology](platform/architecture-and-topology.md) | 应用监督器、运行时拓扑、平台与产品装配边界 |
| [Human workbench and Portal](workbench/human-workbench.md) | 当前 Human、跨 Hub 资源入口、账号切换与可选租户作用域（目标设计） |
| [Identity and access](platform/identity-and-access.md) | 主体、认证、Relay 入口与账号数据权限 |
| [Connections and routing](platform/connections-and-routing.md) | SSH、远程目录、Host 配置、机器与连接诊断 |
| [Execution and models](platform/execution-and-models.md) | Provider 账号、Bot、模型服务、能力与执行边界 |
| [Storage and preferences](platform/storage-and-preferences.md) | 项目持久化、数据库诊断与 UI 偏好权威 |
| [Storage ports](platform/storage-ports.md) | 运行时无关的 SQL、文档、对象与机密存储端口及适配器分层 |
| [Optional Cloudflare deployment](platform/cloudflare-deployment.md) | Workers／Durable Objects／Containers 部署形态（目标设计） |
| [Workspace host split](platform/workspace-host-split.md) | Gateway／Brain 按工作区拆分（设计草案） |
| [Shell and navigation](platform/shell-and-navigation.md) | 嵌入式 Shell、工作区、路由与导航入口 |
| [ClientRuntime](platform/client-runtime.md) | Web/PWA/Electron 的文档级呈现、边缘输入与宿主订阅生命周期 |
| [Presentation and input](platform/presentation-and-input.md) | 跨端呈现、主题、字体、语音与原生输入 |
| [Lifecycle and resources](platform/lifecycle-and-resources.md) | Thread 生命周期、启动资源、恢复与观测数据 |
| [Build and deployment](platform/build-and-deployment.md) | 构建命令、Web 发布、部署与实现审计 |

## 章节索引

下列旧章节锚点继续有效；仓库内的精确章节链接直接指向专题正文。

### Architecture and topology

- <a id="package-ownership"></a>[Package ownership](platform/architecture-and-topology.md#package-ownership)
- <a id="deliberate-reuse-boundary"></a>[Deliberate reuse boundary](platform/architecture-and-topology.md#deliberate-reuse-boundary)
- <a id="next-feature-rule"></a>[Next feature rule](platform/architecture-and-topology.md#next-feature-rule)

### Identity and access

- <a id="shared-origin-relay-server-context"></a>[Shared-origin relay server context](platform/identity-and-access.md#shared-origin-relay-server-context)
- <a id="account-read-receipt-authority"></a>[Account read receipt authority](platform/identity-and-access.md#account-read-receipt-authority)
- <a id="authentication-ownership"></a>[Authentication ownership](platform/identity-and-access.md#authentication-ownership)
- <a id="authenticated-application-manifest"></a>[Authenticated application manifest](platform/identity-and-access.md#authenticated-application-manifest)
- <a id="account-model-defaults-authority"></a>[Account model defaults authority](platform/identity-and-access.md#account-model-defaults-authority)
- <a id="单-hub-主体协作"></a>[单 Hub 主体协作](platform/identity-and-access.md#单-hub-主体协作)

### Connections and routing

- <a id="backend-ssh-codex-connections"></a>[Backend SSH Codex connections](platform/connections-and-routing.md#backend-ssh-codex-connections)
- <a id="hub-owned-remote-conversation-directory"></a>[Hub-owned remote conversation directory](platform/connections-and-routing.md#hub-owned-remote-conversation-directory)
- <a id="machines-work-in-and-agents"></a>[Machines, Work in and Agents](platform/connections-and-routing.md#machines-work-in-and-agents)
- <a id="browser-host-profile-upgrade-recovery"></a>[Browser Host-profile upgrade recovery](platform/connections-and-routing.md#browser-host-profile-upgrade-recovery)
- <a id="configured-unknown-machine-display-names"></a>[Configured unknown-machine display names](platform/connections-and-routing.md#configured-unknown-machine-display-names)
- <a id="local-connection-diagnostic-propagation"></a>[Local connection diagnostic propagation](platform/connections-and-routing.md#local-connection-diagnostic-propagation)
- <a id="connection-conformance-and-external-waits"></a>[Connection conformance and external waits](platform/connections-and-routing.md#connection-conformance-and-external-waits)

### Execution and models

- <a id="host-side-provider-account-pooling"></a>[Host-side provider account pooling](platform/execution-and-models.md#host-side-provider-account-pooling)
- <a id="settings-owned-local-model-services"></a>[Settings-owned local Model Services](platform/execution-and-models.md#settings-owned-local-model-services)
- <a id="embedded-console-model-authority"></a>[Embedded console model authority](platform/execution-and-models.md#embedded-console-model-authority)
- <a id="host-owned-automatic-codex-conversation-titles"></a>[Host-owned automatic Codex conversation titles](platform/execution-and-models.md#host-owned-automatic-codex-conversation-titles)
- <a id="shared-codex-credentials"></a>[Shared Codex credentials](platform/execution-and-models.md#shared-codex-credentials)
- <a id="codex-subscription-windows-and-extra-credits"></a>[Codex subscription windows and extra credits](platform/execution-and-models.md#codex-subscription-windows-and-extra-credits)
- <a id="codex-model-capacity-retry"></a>[Codex model capacity retry](platform/execution-and-models.md#codex-model-capacity-retry)
- <a id="native-history-read-fault-boundary"></a>[Native history read fault boundary](platform/execution-and-models.md#native-history-read-fault-boundary)
- <a id="execution-observation-and-bounded-history-delivery"></a>[Execution observation and bounded history delivery](platform/execution-and-models.md#execution-observation-and-bounded-history-delivery)
- <a id="connector-http-recovery-and-consumers"></a>[Connector HTTP recovery and consumers](platform/execution-and-models.md#connector-http-recovery-and-consumers)

### Storage and preferences

- <a id="project-selection-and-persistence"></a>[Project selection and persistence](platform/storage-and-preferences.md#project-selection-and-persistence)
- <a id="read-only-sqlite-diagnostics"></a>[Read-only SQLite diagnostics](platform/storage-and-preferences.md#read-only-sqlite-diagnostics)
- <a id="ui-preference-authority"></a>[UI preference authority](platform/storage-and-preferences.md#ui-preference-authority)

### Shell and navigation

- <a id="workspace-file-explorer-ownership"></a>[Workspace file Explorer ownership](platform/shell-and-navigation.md#workspace-file-explorer-ownership)
- <a id="embedded-workbench-shell"></a>[Embedded Workbench Shell](platform/shell-and-navigation.md#embedded-workbench-shell)
- <a id="fixed-navigation-entrances"></a>[Fixed navigation entrances](platform/shell-and-navigation.md#fixed-navigation-entrances)
- <a id="application-router-authority"></a>[Application Router authority](platform/shell-and-navigation.md#application-router-authority)
- <a id="会话顶部信息"></a>[会话顶部信息](platform/shell-and-navigation.md#会话顶部信息)
- <a id="file-browser-launcher"></a>[File browser launcher](platform/shell-and-navigation.md#file-browser-launcher)
- <a id="shell-content-plane-shape-ownership-2026-10-22"></a>[Shell content-plane shape ownership (2026-10-22)](platform/shell-and-navigation.md#shell-content-plane-shape-ownership-2026-10-22)

### Presentation and input

- <a id="conversation-desktop-plugin"></a>[Conversation desktop plugin](platform/presentation-and-input.md#conversation-desktop-plugin)
- <a id="typography-ownership"></a>[Typography ownership](platform/presentation-and-input.md#typography-ownership)
- <a id="theme-surfaces-and-native-appearance"></a>[Theme surfaces and native appearance](platform/presentation-and-input.md#theme-surfaces-and-native-appearance)
- <a id="client-voice-input-ownership"></a>[Client voice input ownership](platform/presentation-and-input.md#client-voice-input-ownership)
- <a id="internationalization-authority"></a>[Internationalization authority](platform/presentation-and-input.md#internationalization-authority)
- <a id="terminal-character-metrics-boundary"></a>[Terminal character metrics boundary](platform/presentation-and-input.md#terminal-character-metrics-boundary)
- <a id="conversation-terminal-semantics"></a>[Conversation terminal semantics](platform/presentation-and-input.md#conversation-terminal-semantics)
- <a id="expo-webs-place"></a>[Expo Web's place](platform/presentation-and-input.md#expo-webs-place)
- <a id="read-only-office-resource-previews"></a>[Read-only Office resource previews](platform/presentation-and-input.md#read-only-office-resource-previews)
- <a id="mcp-app-webelectron-host"></a>[MCP App Web/Electron host](platform/presentation-and-input.md#mcp-app-webelectron-host)
- <a id="host-composer-command-adapters"></a>[Host Composer command adapters](platform/presentation-and-input.md#host-composer-command-adapters)

### Lifecycle and resources

- [统一制品库：上传、AIGC 与资源回收（目标设计）](artifact-library.md)

- <a id="client-cache-and-presentation-resource-policy"></a>[Client cache and presentation resource policy](platform/lifecycle-and-resources.md#client-cache-and-presentation-resource-policy)
- <a id="thread-lifecycle-ownership"></a>[Thread lifecycle ownership](platform/lifecycle-and-resources.md#thread-lifecycle-ownership)
- <a id="embedded-connection-recovery"></a>[Embedded connection recovery](platform/lifecycle-and-resources.md#embedded-connection-recovery)
- <a id="global-conversation-text-search"></a>[Global conversation text search](platform/lifecycle-and-resources.md#global-conversation-text-search)
- <a id="startup-resource-ownership"></a>[Startup resource ownership](platform/lifecycle-and-resources.md#startup-resource-ownership)
- <a id="recovery-episode-diagnostics"></a>[Recovery episode diagnostics](platform/lifecycle-and-resources.md#recovery-episode-diagnostics)
- <a id="operation-acknowledgement"></a>[Operation acknowledgement](platform/lifecycle-and-resources.md#operation-acknowledgement)
- <a id="token-usage-collection-controls-and-account-presentation"></a>[Token usage collection controls and account presentation](platform/lifecycle-and-resources.md#token-usage-collection-controls-and-account-presentation)
- <a id="token-usage-people-presentation"></a>[Token usage people presentation](platform/lifecycle-and-resources.md#token-usage-people-presentation)

### Build and deployment

- <a id="commands"></a>[Commands](platform/build-and-deployment.md#commands)
- <a id="vite-web-release-invariant"></a>[Vite Web release invariant](platform/build-and-deployment.md#vite-web-release-invariant)
- <a id="managed-web-deployment"></a>[Managed Web deployment](platform/build-and-deployment.md#managed-web-deployment)
- <a id="managed-server-updates"></a>[Managed server updates](platform/build-and-deployment.md#managed-server-updates)
- <a id="server-owned-conversation-schedules"></a>[Server-owned conversation schedules](platform/build-and-deployment.md#server-owned-conversation-schedules)
- <a id="retired-implementation-audit-2026-10-16"></a>[Retired implementation audit (2026-10-16)](platform/build-and-deployment.md#retired-implementation-audit-2026-10-16)

## 领域目录

| 目录 | 范围 |
| --- | --- |
| [`platform/`](platform/) | 平台拓扑、客户端运行时、连接、存储偏好与呈现输入 |
| [`execution/`](execution/) | 执行所有权、沙盒、AppServer/DSH/ACP、Codex 核心、能力与模型网关 |
| [`identity/`](identity/) | 登录与自然人身份、主体协作、多 Human、Git 身份与托管 Bot |
| [`chat-ui/`](chat-ui/) | ChatUI 架构、会话呈现、滚动与视口、消息与附件 |
| [`workbench/`](workbench/) | Workbench 设计语言、页面框架、导航、通知与文件预览 |
| [`extensions/`](extensions/) | 插件内核与持久化、Connector、MCP App、云桌面、IM 与 Tasks |
| [`server/`](server/) | 服务器信息与协作空间、存储生命周期、服务器核心数据离开网络主线程（设计）、Web Push 与资源交付 |
| [`browser/`](browser/) | 浏览器 Workbench 与 Browser Use 契约 |
| [`mobile/`](mobile/) | 手机 WebView 容器与移动数据协调 |
