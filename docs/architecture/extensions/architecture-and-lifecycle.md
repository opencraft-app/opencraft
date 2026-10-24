# Extensions: Architecture and lifecycle

[Architecture index](../../plugin-architecture.md) · [Documentation index](../../README.md)

## 1. 结论

OpenCraft 是桌面/Web/移动 Workbench。它的公开生态和用户心智应当以
Plugin/Extension 为中心：安装、启用、设置、命令、面板、渲染器、Workspace 集成、升级和
卸载都属于稳定的 Extension Platform。

Agent Capability 是 Extension 的一个可选 Contribution，也是 AppServer/MCP 能力进入模型
的适配层；它不取代传统插件 API。完整 Agent 调用语义由
[`agent-capability-fabric.md`](../../agent-capability-fabric.md) 定义。

OpenCraft 仍然不能把 Cordis 的 `Context` 直接作为公共插件 API。

扩展系统按以下职责划分：

- **原生兼容**：Codex AppServer 负责原生插件目录、安装、启用、策略和可用性；客户端只激活
  已编译的 first-party bridge，并把第三方 App UI 放入沙箱；
- **客户端生命周期**：插件、View 和子组件都有明确的 `load/unload` 所有权，注册操作返回
  disposer，由对应 owner 清理；
- **公开扩展契约**：manifest-first、稳定 API namespace、package-contained code 和按需
  background lifecycle；能力授权、执行域分离、受限 API 和消息桥由可选 Restricted Policy 管理；
- **内部内核**：Cordis 负责 OpenCraft 内部的依赖注入、激活图、Fiber 生命周期和逆序清理。

一句话定义：

> **Cordis 是 OpenCraft 的内部扩展内核，不是安全沙箱、第三方 ABI 或 Agent 能力协议。**

公共插件以版本化 `OpenCraftExtensionApi` 为受支持边界。可信内建功能可以直接使用 Cordis；
用户明确启用的本地/Workspace Extension 可以采用可信执行。独立
ExtensionHost、Electron utility process、远端 Host 或 sandbox UI 是可选的故障/安全隔离
策略，不是所有插件的前置条件。

若发行渠道启用 Restricted Policy，Extension manifest 才申请安装级权限上限。普通可信
Extension 可以不启用细粒度权限 broker。无论插件采用哪种信任模式，Agent-facing
Contribution 仍不会因为安装或激活而自动进入模型上下文。

主体协作的目标设计还遵循[核心与插件边界](../actor-collaboration.md#核心与插件的边界)：主体、授权和 Hub 分发由必备核心拥有；身份来源、执行引擎与通信渠道由插件适配。插件安装权限与主体对目标资源的权限分别建模，可信执行模式不意味着调用主体获得额外资源权限。身份或渠道插件卸载不能关闭核心授权检查；目标资源的最终校验、延后执行与撤销约束继续有效。该边界不表示现有插件机制已实现主体准入或多租户隔离。

面向开发者的一句话定义是：

> **插件经显式贡献接口接入，由统一的激活与卸载生命周期管理资源。**

这不会推翻现有的多 Runtime 设计。OpenCraft 仍然保留多个独立 Cordis Context；新增的
`ExtensionSupervisor` 用一个 Contribution Broker 跨域登记贡献，并把所有 disposer 挂到
同一个插件 Activation Fiber 上，从而做到“一次激活、原子贡献、一次卸载、完整清理”。

## 2. 客户端扩展边界

原生 AppServer 插件的目录、安装和启用状态属于对应 Host/AppServer；客户端 bridge
按可用性惰性激活。OpenCraft 客户端 Extension 的安装和启用意图由
`ExtensionInstallationRepository` 持有，`ExtensionManager` 协调加载，
`ExtensionSupervisor` 持有实际激活；管理页目录只是这些状态的派生投影。
内部 registry、主题 factory 和编辑器扩展登记不构成第三方任意代码执行边界。
外部 App 内容经独立 sandbox、CSP、资源代理和主题/尺寸 RPC 呈现。

客户端贡献使用 manifest 身份、命名空间和由激活 owner 持有的 disposer；停止激活
按生命周期回收。命令、View、编辑器、Markdown 与设置贡献继续使用各自 registry，
统一 SDK/activation 编排不代替这些领域 owner。

明暗偏好、色板、代码主题、字号和动效是独立设置。system 偏好才订阅系统主题；
平台订阅由根服务持有，缓存和重复注册需显式处理。

现有 AppServer Plugin source/catalog/install/policy/interface 字段由生成协议定义；
客户端 Extension 与该原生协议的区别见下一节。当前 SDK、manifest 与安全边界
的实现状态以本文前述实现账本及后续正式契约为准。

## 3. 先区分两种“插件”

Codex AppServer 的 `Plugin` 与 OpenCraft 客户端的 `Extension` 不是同一个概念：

| 概念 | 权威方 | 典型内容 | 是否能改 OpenCraft 主界面 |
| --- | --- | --- | --- |
| `AppServer Plugin` | 某个 Host/AppServer | Skills、Hooks、MCP、Apps、提示词、远端能力 | 不能直接改；通过协议事实和沙箱 App 呈现 |
| `OpenCraft Extension` | OpenCraft Application/ExtensionHost | Command、View、设置、资源处理器、Composer provider | 只能通过声明式贡献点或受信任内建 renderer |

一个发行包未来可以同时提供两部分，但目录、安装记录、执行位置和权限必须分别建模。
上游 `PluginSummary` 不能被误当成客户端可执行模块清单。

现有协议已经包含：

```text
PluginSource = local | git | npm | remote
PluginSummary = install/enabled/policy/availability/interface
PluginInterface = metadata/capabilities/icons/screenshots/prompts
```

原生插件的目录与安装由 AppServer 协议持有。OpenCraft 提供客户端扩展 manifest、贡献协议
与执行宿主；原生插件目录通过 adapter 投影进统一的插件管理页面。

## 4. 第一性原理

### 4.1 安装、启用、解析与激活不是一件事

插件生命周期至少包含：

```text
discovered
  -> installed
  -> resolved
  -> activating
  -> active
  -> deactivating
  -> inactive

任何阶段 -> failed -> quarantined -> retry/resolved
```

- `installed` 只说明产物可用；
- `enabled` 是用户/组织策略；
- `resolved` 说明版本、依赖、平台和能力请求都可满足；
- `active` 才说明代码已经运行且贡献已经提交；
- `quarantined` 防止启动崩溃循环。

### 4.2 插件、Activation、Contribution 与 View 必须分离

- Plugin/Extension 是稳定发行身份；
- Installation 是某个 Profile/Host 上安装的版本；
- Activation 是一次可失败、可销毁的运行实例；
- Contribution 是 Activation 登记的命令、View 或 provider；
- View 是某个 Renderer 对贡献的呈现，不拥有 Activation。

推荐身份：

```ts
export type ExtensionId = `${string}.${string}`;
export type ContributionId = `${ExtensionId}.${string}`;

export interface ExtensionInstallationKey {
  readonly profileId: string;
  readonly hostId: string | null;
  readonly extensionId: ExtensionId;
}

export interface ExtensionActivationKey extends ExtensionInstallationKey {
  readonly activationId: string;
  readonly generation: number;
}
```

同一个远程 Host 上的插件与本机插件不是一个 Activation。`activationId` 是每次激活的
不透明随机身份，`generation` 表示同一激活内的授权/通道代次。迟到消息必须同时匹配
两者，不能写入新实例。

### 4.3 执行位置、权限和呈现位置是三条正交轴

一个插件可以在 SSH Host 执行命令、在本机 ExtensionHost 维护状态、在 iPad 的 WebView
呈现 UI。不能用一个 `hostId` 或一个 `platform` 枚举把三件事压在一起。

### 4.4 所有状态必须有权威方

- AppServer 插件安装、远端 Hooks/Skills/Apps：Host 权威；
- OpenCraft 本地扩展启用、授权、quarantine：Profile 本地权威；
- 插件 View 布局与打开状态：Renderer View Checkpoint；
- 插件业务事实：只能由明确的 Domain/Host 权威产生；
- TanStack Query：缓存 marketplace/install 等异步查询，不拥有 Activation 或实时状态机；
- Replica：不接受插件任意 key/value 写入。需要同步的数据必须先定义领域 namespace、
  schema、权限和迁移策略。

## 5. 目标拓扑

```text
ApplicationSupervisor
├─ HostRuntimeRegistry
│  └─ HostRuntime(hostId)
│     ├─ AppServerClient / Resume / Replica
│     ├─ HostPluginCatalogPort
│     └─ HostCapabilityPort
├─ RendererRuntime
│  ├─ CommandRegistry
│  ├─ WorkbenchResourceRegistry
│  ├─ ChatContributionRegistry
│  └─ ComposerContributionRegistry
├─ BrowserRuntime
├─ QueryClient
└─ ExtensionSupervisor
   ├─ CatalogProjection
   ├─ InstallationStore
   ├─ AccessPolicyStore (optional for restricted channels)
   ├─ ActivationGraph
   ├─ ContributionBroker
   ├─ TrustedBuiltinRuntime ── Cordis Fibers
   ├─ TrustedExtensionRuntime ── Cordis scope / local extension host
   ├─ RestrictedExtensionHost (optional) ── isolated realm / utility process / remote Host
   └─ SandboxedUiBroker (optional) ── iframe / webview / MessagePort
```

构造和销毁顺序是一个不变量：

1. Application 创建 Host、Renderer、Browser 和 Query 等核心 Runtime；
2. Application 用这些 Runtime 的窄 Port 创建 `ExtensionSupervisor`；
3. ExtensionSupervisor 完成 manifest 解析和惰性激活；
4. 退出时先销毁 ExtensionSupervisor，撤销全部贡献和借用；
5. 最后销毁它曾借用的核心 Runtime。

插件永远不能拥有 `HostRuntime`、Browser backing 或 React root。可信连接扩展可以贡献
`HostConnectionProvider`，但它只负责校验配置并构造 `DuplexTransport`；返回的物理连接从
创建成功起由 Application 持有。Provider Activation 通过 lease 等待全部 Host 释放后才
能卸载，不能越过 Application 直接连接、重连、恢复 Thread 或写 Replica。

### 5.1 连接类型不是 Host 类型

```text
HostConnectionProfile (IndexedDB / platform secure store)
  ├─ hostId                  稳定执行命名空间
  ├─ providerId              如何连接，例如 opencraft.websocket
  ├─ providerConfig          provider 私有、JSON 可迁移配置
  ├─ hostKind                local / remote-ssh / durable 等语义
  └─ presentation metadata  名称、roots、是否出现在侧栏

HostConnectionProviderRegistry (Cordis contribution owner)
  └─ acquire(providerId, platform) -> ProviderLease
       └─ validate + createTransport

HostRuntimeRegistry (Application owner)
  └─ HostRuntime(hostId) -> Transport + AppServer + Session + Replica
```

`providerId` 与 `hostKind` 正交：WebSocket 既可以通向本地 daemon，也可以通向 SSH
gateway 或 Durable 服务。动态增加 Host 先持久化 Profile、再注册惰性 Runtime；删除时
先阻止新查找并回收 Runtime，再删除 Profile。存在活动 View、流、命令、交互或 hydration
的 Host 不可删除。环境变量只在 Profile Store 为空时进行一次 bootstrap，不是第二个
配置所有者。

## 6. Cordis 的准确位置

### 6.1 Cordis 负责什么

- 服务依赖和激活排序；
- 一个 Activation 对应一个 Fiber；
- event/effect/service 的逆序清理；
- 插件失败状态和重新激活；
- 可信内建 feature 的配置 schema；
- 开发模式下的 reload/HMR。

Cordis 的 `FiberState` 已覆盖 `PENDING / LOADING / ACTIVE / FAILED /
UNLOADING / DISPOSED`，非常适合实现 Activation 内核。`ctx.effect()` 可把跨 Registry
取得的 disposer 统一挂回插件 Fiber。

### 6.2 Cordis 不负责什么

- 代码沙箱；
- OS/网络/文件权限；
- 跨进程认证；
- 公共 API 版本兼容；
- marketplace 签名与供应链校验；
- Replica 写权限。

`Context.isolate()` 只隔离服务解析，不隔离 JavaScript realm。把根 Context 传给第三方，
等于把当前 scope 能看到的服务全部交出去。

### 6.3 不合并成一个巨大 Context

云桌面第一阶段使用现有可信内建 Panel definition / renderer / toolbar 注册，
由 Workbench Application 显式注入后端与媒体适配器；不增加公共权限或新的全局 Context。
未接通适配器时不发布可用入口，桌面进程、观看连接和独占控制租约分开所有权。
框架及后续接入条件见 [Conversation desktop plugin](../../cloud-desktop-plugin.md)。

云桌面与下游产品插件保持单向依赖：通用插件拥有桌面 contract、面板和 noVNC
媒体适配，不读取账号或调用企业云服务；下游桌面 provider 只消费通用
contract/media 子入口，拥有精确绑定校验、资源准备及后端 attachment 交接，
不导入桌面 React renderer、noVNC 或 Hermes Chat 隧道。生产观看授权/输入门禁
尚未实现，缺失 viewer port 时不发布能力。源码和 package dependency guard
固化此边界；可信插件仍不是安全沙箱。

当前 Chat、Panel、Session、Replica 的 Context 可以继续独立存在。跨域原子卸载由
Contribution Broker 完成：

```ts
interface ContributionBroker {
  registerCommand(owner: ExtensionActivationKey, input: CommandContribution): Disposable;
  registerView(owner: ExtensionActivationKey, input: ViewContribution): Disposable;
  registerComposerProvider(
    owner: ExtensionActivationKey,
    input: ComposerProviderContribution,
  ): Disposable;
}

function activateBuiltin(ctx: CordisContext, broker: ContributionBroker): void {
  ctx.effect(() => broker.registerCommand(/* ... */));
  ctx.effect(() => broker.registerView(/* ... */));
}
```

所以“一个插件跨多个产品域贡献”不要求“所有产品域共享一个 DI 根”。

### 6.4 View、入口与布局不得合并

OpenCraft 将 Command、View 类型和持久 Workspace slot 的所有权分开，但不公开
任意 DOM 注入：

```text
Extension owns        View declaration, command, catalog data and business state
Navigation owns       entry activation and browser/application history
Workspace owns        View instance, placement, focus, resize and responsive projection
ExtensionSupervisor   activation generation, atomic publication and retirement
Presentation plugin   semantic contribution projection, layout preference and interaction grammar
```

公共贡献必须分开：

- `ViewContribution` 只定义“是什么”，不带 `location`；
- 承接 AppServer Bot 的 View 由 Bot 插件声明唯一语义角色 `bot-conversation`；Workbench 不知道插件的具体 View ID，角色冲突在扩展激活事务提交前失败；
- `NavigationContribution` 定义 `sidebar-primary/sidebar-footer/applications` 入口及语义 target，并可声明 `titleMessage/shortTitleMessage/badgeMessage`。贡献拥有文案，Shell按当前locale解析完整可访问名、短标签和徽标；不按产品/插件ID选择文案或徽标。消息在注册时校验并冻结，随激活回收。Settings Page 可声明 `shortTitleMessage` 用于应用级工具入口，未声明时回退完整title。平台仍拥有几何、紧凑显隐和交互；
- `SidebarCatalogContribution` 引用 View，由宿主保留标题、折叠、滚动和间距所有权；
- `ViewContribution.role: "connector-management"` 声明连接器管理能力，沿用唯一事务 owner 和激活回收契约。核心 quick picker 只在该 View 与唯一关联 Settings Page 同时满足平台/audience 且 renderer 可用时提供管理入口；不识别产品私有 ID。缺失、歧义或退役时不提供入口，旧菜单回调不得跨激活代次导航。原生 MCP 连接与选择仍由现有 manager 负责，不依赖该管理页。
- `SettingsPageContribution` 引用 View，由 Settings route 生成导航；
  目标管理页可声明 `management.entryPoint: "workbench"`，表示它拥有应用级工具入口；未声明的管理页保留上下文管理行为。核心按声明投影导航和独立路由，不识别产品页面 ID。平台仍决定容器、响应式几何与滚动；入口共用贡献的语言、平台、audience、排序与激活生命周期。
- `WorkbenchSurfaceContribution` 只声明特殊宿主 surface，目前仅有 `empty-workbench`。
- `BotContribution` 只声明 Bot 身份、头像、可用性和打开动作；它不拥有任何 Sidebar DOM 或坐标。
- `SidebarLayoutStore` 是 durable 置顶顺序的唯一所有者；Sidebar 根拥有拖拽事务、临时投影、磁力落点和滚动坐标系。
- AppServer Bot 目录先投影成带 `hostId/kind/entityId` 的 `SidebarEntity`，协议适配器负责创建与打开命令，React 不直接调用仓库。

Bot 提供方不能注入侧栏 DOM，也不能持有面板坐标。Bot 来源可以来自扩展贡献或任意
AppServer Host；两者进入同一个 Sidebar 实体投影后，才由平台分别呈现 pinned、row 或
collapsed rail。暂时离线的实体不会从 durable order 中删除。

桌面左栏、iPad Split View 和手机 Drawer 可以投影同一 Navigation/Catalog 声明；插件不得写死
侧栏宽度、左右方向或桌面 CSS 坐标。

## 11. 跨平台策略

OpenCraft 共享 manifest、command、resource、permission、activation 和 view state 协议，
不承诺共享插件的 React 组件体。

| 能力 | Vite Web | Electron | Expo iOS/iPadOS | Expo Web |
| --- | --- | --- | --- | --- |
| 可信内建扩展 | 编译进应用 | 编译进应用 | 编译进应用 | 编译进应用 |
| 本地能力扩展 | 独立/opaque-origin 执行域 | 受限 utility process；Worker 仅作内部调度 | 默认不支持任意本地代码 | 独立/opaque-origin 执行域 |
| Host 能力扩展 | WebSocket/AppServer | IPC/SSH/AppServer | WebSocket/AppServer | WebSocket/AppServer |
| 沙箱 UI | iframe | sandbox webview/iframe | 受控 WebView 或声明式 native fallback | iframe |
| 原生 View | 内建 React DOM | 内建 React DOM | 内建 React Native | 内建 React Native Web |

iOS 平台限制不是抽象失败。社区扩展如果只有 DOM UI，可以在 WebView 中运行；如果只
提供声明式贡献，则由 Native Host 渲染；如果要求本地任意代码，则该 target 明确标记为
unsupported。不能为了“100% 插件代码共享”把整个 Expo App 变成 WebView。

## 12. 与 AppServer / Multi-Host 的关系

每个 `HostRuntime(hostId)` 提供该 Host 的插件目录和能力 Port。应用级
`ExtensionSupervisor` 聚合它们，但不把远程代码拉入本地 Renderer 执行。

```text
Plugin catalog identity    = pluginId
Installed server instance  = (hostId, pluginId, version)
Client extension instance  = (profileId, hostId|null, extensionId, activationId, generation)
UI view instance           = (rendererId, contributionId, viewInstanceId)
```

- SSH Host 的 Skill/Hook/MCP 在 SSH Host 后面运行；
- Durable Host 的插件能力由 Durable Host 的 AppServer 投影；
- Renderer 通过统一 HostRuntime 路由命令；
- 一个插件在两个 Host 安装时是两个可用性/授权实例；
- 全局插件管理 UI 可以聚合展示，但不能抹掉 Host 来源。

OpenCraft 的 bridge 必须显式声明 location policy；单个产品的本机限制不得变成通用插件约束。

## 13. 包与模块边界

先建立最少两个新包，不一次拆出十个空壳：

```text
packages/
  extension-contract/
    manifest.ts
    identity.ts
    capabilities.ts
    contributions.ts
    rpc.ts

  extension-runtime/
    extension-supervisor.ts
    activation-graph.ts
    contribution-broker.ts
    permission-store.ts
    installation-store.ts
    trusted-cordis-runtime.ts
```

平台实现先放在对应 App 中：

```text
apps/workbench-web/src/extensions/
  sandbox-capability-host.ts
  iframe-ui-host.ts

apps/workbench-desktop/src/extensions/
  utility-extension-host.ts

apps/workbench-expo/src/extensions/
  sandbox-webview-host.tsx
  native-contribution-renderers.tsx
```

只有在 Web sandbox、utility process 和远端 Host 已产生两个真实实现后，再抽
`extension-host-*` 包。公共插件开发工具稳定后再发布 `@opencraft/extension-sdk`；它只是
`extension-contract` 的友好 facade，不依赖 Cordis。
