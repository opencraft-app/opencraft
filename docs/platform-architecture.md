# OpenCraft platform architecture

本页是架构入口。正式契约按职责归并在下列专题页中；实现状态、目标设计与验收限制保留在对应正文。修改行为时维护对应专题，避免继续在本页追加实现细节。

| 专题 | 范围 |
| --- | --- |
| [Architecture and topology](architecture/platform/architecture-and-topology.md) | 应用监督器、运行时拓扑、平台与产品装配边界 |
| [Identity and access](architecture/platform/identity-and-access.md) | 主体、认证、Relay 入口与账号数据权限 |
| [Connections and routing](architecture/platform/connections-and-routing.md) | SSH、远程目录、Host 配置、机器与连接诊断 |
| [Execution and models](architecture/platform/execution-and-models.md) | Provider 账号、Bot、模型服务、能力与执行边界 |
| [Storage and preferences](architecture/platform/storage-and-preferences.md) | 项目持久化、数据库诊断与 UI 偏好权威 |
| [Shell and navigation](architecture/platform/shell-and-navigation.md) | 嵌入式 Shell、工作区、路由与导航入口 |
| [ClientRuntime](architecture/platform/client-runtime.md) | Web/PWA/Electron 的文档级呈现、边缘输入与宿主订阅生命周期 |
| [Presentation and input](architecture/platform/presentation-and-input.md) | 跨端呈现、主题、字体、语音与原生输入 |
| [Lifecycle and resources](architecture/platform/lifecycle-and-resources.md) | Thread 生命周期、启动资源、恢复与观测数据 |
| [Build and deployment](architecture/platform/build-and-deployment.md) | 构建命令、Web 发布、部署与实现审计 |

## 章节索引

下列旧章节锚点继续有效；仓库内的精确章节链接直接指向专题正文。

### Architecture and topology

- <a id="package-ownership"></a>[Package ownership](architecture/platform/architecture-and-topology.md#package-ownership)
- <a id="deliberate-reuse-boundary"></a>[Deliberate reuse boundary](architecture/platform/architecture-and-topology.md#deliberate-reuse-boundary)
- <a id="next-feature-rule"></a>[Next feature rule](architecture/platform/architecture-and-topology.md#next-feature-rule)

### Identity and access

- <a id="shared-origin-relay-server-context"></a>[Shared-origin relay server context](architecture/platform/identity-and-access.md#shared-origin-relay-server-context)
- <a id="account-read-receipt-authority"></a>[Account read receipt authority](architecture/platform/identity-and-access.md#account-read-receipt-authority)
- <a id="authentication-ownership"></a>[Authentication ownership](architecture/platform/identity-and-access.md#authentication-ownership)
- <a id="authenticated-application-manifest"></a>[Authenticated application manifest](architecture/platform/identity-and-access.md#authenticated-application-manifest)
- <a id="account-model-defaults-authority"></a>[Account model defaults authority](architecture/platform/identity-and-access.md#account-model-defaults-authority)
- <a id="单-hub-主体协作"></a>[单 Hub 主体协作](architecture/platform/identity-and-access.md#单-hub-主体协作)

### Connections and routing

- <a id="backend-ssh-codex-connections"></a>[Backend SSH Codex connections](architecture/platform/connections-and-routing.md#backend-ssh-codex-connections)
- <a id="hub-owned-remote-conversation-directory"></a>[Hub-owned remote conversation directory](architecture/platform/connections-and-routing.md#hub-owned-remote-conversation-directory)
- <a id="machines-work-in-and-agents"></a>[Machines, Work in and Agents](architecture/platform/connections-and-routing.md#machines-work-in-and-agents)
- <a id="browser-host-profile-upgrade-recovery"></a>[Browser Host-profile upgrade recovery](architecture/platform/connections-and-routing.md#browser-host-profile-upgrade-recovery)
- <a id="configured-unknown-machine-display-names"></a>[Configured unknown-machine display names](architecture/platform/connections-and-routing.md#configured-unknown-machine-display-names)
- <a id="local-connection-diagnostic-propagation"></a>[Local connection diagnostic propagation](architecture/platform/connections-and-routing.md#local-connection-diagnostic-propagation)
- <a id="connection-conformance-and-external-waits"></a>[Connection conformance and external waits](architecture/platform/connections-and-routing.md#connection-conformance-and-external-waits)

### Execution and models

- <a id="host-side-provider-account-pooling"></a>[Host-side provider account pooling](architecture/platform/execution-and-models.md#host-side-provider-account-pooling)
- <a id="bot-management-ownership"></a>[Bot management ownership](architecture/platform/execution-and-models.md#bot-management-ownership)
- <a id="settings-owned-local-model-services"></a>[Settings-owned local Model Services](architecture/platform/execution-and-models.md#settings-owned-local-model-services)
- <a id="embedded-console-model-authority"></a>[Embedded console model authority](architecture/platform/execution-and-models.md#embedded-console-model-authority)
- <a id="host-owned-automatic-codex-conversation-titles"></a>[Host-owned automatic Codex conversation titles](architecture/platform/execution-and-models.md#host-owned-automatic-codex-conversation-titles)
- <a id="shared-codex-credentials"></a>[Shared Codex credentials](architecture/platform/execution-and-models.md#shared-codex-credentials)
- <a id="codex-subscription-windows-and-extra-credits"></a>[Codex subscription windows and extra credits](architecture/platform/execution-and-models.md#codex-subscription-windows-and-extra-credits)
- <a id="codex-model-capacity-retry"></a>[Codex model capacity retry](architecture/platform/execution-and-models.md#codex-model-capacity-retry)
- <a id="native-history-read-fault-boundary"></a>[Native history read fault boundary](architecture/platform/execution-and-models.md#native-history-read-fault-boundary)
- <a id="execution-observation-and-bounded-history-delivery"></a>[Execution observation and bounded history delivery](architecture/platform/execution-and-models.md#execution-observation-and-bounded-history-delivery)
- <a id="connector-http-recovery-and-consumers"></a>[Connector HTTP recovery and consumers](architecture/platform/execution-and-models.md#connector-http-recovery-and-consumers)

### Storage and preferences

- <a id="project-selection-and-persistence"></a>[Project selection and persistence](architecture/platform/storage-and-preferences.md#project-selection-and-persistence)
- <a id="read-only-sqlite-diagnostics"></a>[Read-only SQLite diagnostics](architecture/platform/storage-and-preferences.md#read-only-sqlite-diagnostics)
- <a id="ui-preference-authority"></a>[UI preference authority](architecture/platform/storage-and-preferences.md#ui-preference-authority)

### Shell and navigation

- <a id="workspace-file-explorer-ownership"></a>[Workspace file Explorer ownership](architecture/platform/shell-and-navigation.md#workspace-file-explorer-ownership)
- <a id="embedded-workbench-shell"></a>[Embedded Workbench Shell](architecture/platform/shell-and-navigation.md#embedded-workbench-shell)
- <a id="fixed-navigation-entrances"></a>[Fixed navigation entrances](architecture/platform/shell-and-navigation.md#fixed-navigation-entrances)
- <a id="application-router-authority"></a>[Application Router authority](architecture/platform/shell-and-navigation.md#application-router-authority)
- <a id="会话顶部信息"></a>[会话顶部信息](architecture/platform/shell-and-navigation.md#会话顶部信息)
- <a id="file-browser-launcher"></a>[File browser launcher](architecture/platform/shell-and-navigation.md#file-browser-launcher)
- <a id="shell-content-plane-shape-ownership-2026-10-22"></a>[Shell content-plane shape ownership (2026-10-22)](architecture/platform/shell-and-navigation.md#shell-content-plane-shape-ownership-2026-10-22)

### Presentation and input

- <a id="conversation-desktop-plugin"></a>[Conversation desktop plugin](architecture/platform/presentation-and-input.md#conversation-desktop-plugin)
- <a id="typography-ownership"></a>[Typography ownership](architecture/platform/presentation-and-input.md#typography-ownership)
- <a id="theme-surfaces-and-native-appearance"></a>[Theme surfaces and native appearance](architecture/platform/presentation-and-input.md#theme-surfaces-and-native-appearance)
- <a id="client-voice-input-ownership"></a>[Client voice input ownership](architecture/platform/presentation-and-input.md#client-voice-input-ownership)
- <a id="internationalization-authority"></a>[Internationalization authority](architecture/platform/presentation-and-input.md#internationalization-authority)
- <a id="terminal-character-metrics-boundary"></a>[Terminal character metrics boundary](architecture/platform/presentation-and-input.md#terminal-character-metrics-boundary)
- <a id="conversation-terminal-semantics"></a>[Conversation terminal semantics](architecture/platform/presentation-and-input.md#conversation-terminal-semantics)
- <a id="expo-webs-place"></a>[Expo Web's place](architecture/platform/presentation-and-input.md#expo-webs-place)
- <a id="read-only-office-resource-previews"></a>[Read-only Office resource previews](architecture/platform/presentation-and-input.md#read-only-office-resource-previews)
- <a id="mcp-app-webelectron-host"></a>[MCP App Web/Electron host](architecture/platform/presentation-and-input.md#mcp-app-webelectron-host)
- <a id="host-composer-command-adapters"></a>[Host Composer command adapters](architecture/platform/presentation-and-input.md#host-composer-command-adapters)

### Lifecycle and resources

- <a id="client-cache-and-presentation-resource-policy"></a>[Client cache and presentation resource policy](architecture/platform/lifecycle-and-resources.md#client-cache-and-presentation-resource-policy)
- <a id="thread-lifecycle-ownership"></a>[Thread lifecycle ownership](architecture/platform/lifecycle-and-resources.md#thread-lifecycle-ownership)
- <a id="embedded-connection-recovery"></a>[Embedded connection recovery](architecture/platform/lifecycle-and-resources.md#embedded-connection-recovery)
- <a id="global-conversation-text-search"></a>[Global conversation text search](architecture/platform/lifecycle-and-resources.md#global-conversation-text-search)
- <a id="startup-resource-ownership"></a>[Startup resource ownership](architecture/platform/lifecycle-and-resources.md#startup-resource-ownership)
- <a id="recovery-episode-diagnostics"></a>[Recovery episode diagnostics](architecture/platform/lifecycle-and-resources.md#recovery-episode-diagnostics)
- <a id="operation-acknowledgement"></a>[Operation acknowledgement](architecture/platform/lifecycle-and-resources.md#operation-acknowledgement)
- <a id="token-usage-collection-controls-and-account-presentation"></a>[Token usage collection controls and account presentation](architecture/platform/lifecycle-and-resources.md#token-usage-collection-controls-and-account-presentation)
- <a id="token-usage-people-presentation"></a>[Token usage people presentation](architecture/platform/lifecycle-and-resources.md#token-usage-people-presentation)

### Build and deployment

- <a id="commands"></a>[Commands](architecture/platform/build-and-deployment.md#commands)
- <a id="vite-web-release-invariant"></a>[Vite Web release invariant](architecture/platform/build-and-deployment.md#vite-web-release-invariant)
- <a id="managed-web-deployment"></a>[Managed Web deployment](architecture/platform/build-and-deployment.md#managed-web-deployment)
- <a id="managed-server-updates"></a>[Managed server updates](architecture/platform/build-and-deployment.md#managed-server-updates)
- <a id="server-owned-conversation-schedules"></a>[Server-owned conversation schedules](architecture/platform/build-and-deployment.md#server-owned-conversation-schedules)
- <a id="retired-implementation-audit-2026-10-16"></a>[Retired implementation audit (2026-10-16)](architecture/platform/build-and-deployment.md#retired-implementation-audit-2026-10-16)
