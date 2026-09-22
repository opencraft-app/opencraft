# OpenCraft Extension Platform 与插件内核架构

> 状态：R3 已落地 Trusted V1 内核；生态与 Restricted Channel 仍为 Proposed  
> 架构修订：R3（Extension-first 商业 Workbench）  
> 适用平台：Vite Web、Electron、Expo iOS/iPadOS、Expo Web  
> 本文同时包含已实现内核与后续公共扩展边界；以“实现账本”为准判断当前能力。

### 当前实现账本（2026-09-04）

已实现并进入仓库质量门：

- `packages/extension-contract`：renderer-free manifest V1、activation identity、Command、Settings、
  location-neutral View、Navigation、Sidebar Catalog、Settings Page、Workbench Surface、双明暗
  语义 Theme palette 与 disposer API；
- `packages/extension-runtime`：每 Activation 一个 Cordis Fiber、统一公开贡献快照、预检后单次发布、
  内部贡献 prepare/commit/逆序 rollback、generation fence、串行 activate/deactivate 和完整 dispose；
- 最小 Settings Value Store 已落地：只支持当前 Profile，只读写 manifest 已声明字段，提供
  default、运行时校验、`get/set/reset/subscribe`；Web 使用独立 IndexedDB Adapter；
- WebSocket Host provider 已从匿名 Cordis plugin 迁移为 `vela.websocket-host` first-party Extension；
  provider owner 是 activationId，卸载会先撤出 provider，再等待在用 Host lease 归还；
- `vela.theme-pack` 是第二个真实 Extension 切片：插件只登记 accent/ink/surface/contrast 与
  diff/skill 语义色，应用根统一派生完整 Token；选择被持久化，卸载时原子回退到内建 Codex 主题；
- Theme palette 现在还可选择性声明 `surfaces`（window/sidebar/panel/input/popover 的
  `#RRGGBB` 色值）、`material.window`（translucent/opaque）和
  `material.elevation`（soft/flat，主工作区表面阴影）。没有覆盖的值继续由原算法生成。
  注册层拒绝 CSS/URL、未知选项和不完整的明暗色板，并冻结嵌套数据。
  Web/Electron 已消费这些字段；Expo 动态主题不在本轮范围。完整链路见
  [Theme surfaces and native appearance](./platform-architecture.md#theme-surfaces-and-native-appearance)。
- 场景测试覆盖成功激活、激活失败零残留、内部 commit 中断回滚、旧代 API 拒绝、重激活代际、
  平台筛选、Theme palette 校验和真实 WebSocket provider lease retirement。
- Workbench 已采用 Obsidian 式 `entry -> semantic View -> host placement`：插件不再用一个
  `View.location` 同时表达侧栏按钮、设置页和物理容器；Sidebar 只消费声明式入口和目录，
  应用级导航事务统一拥有 URL、Back/Forward、激活态与卸载回退。

已实现第一阶段的 `module-url` Installation、启用意图持久化、刷新恢复、运行代际和声明式设置
页面，以及自包含 ESM 摘要固定和更新失败恢复。尚未实现：签名包/依赖 lock、惰性 activation event dispatcher、Extension Workshop、
Marketplace、restricted host/permissions，以及把 Chat/Panel/Composer 的所有既有内建项迁入
Supervisor。`internal.register()` 只供 first-party 适配器使用，不属于稳定社区 ABI。

Settings V1 刻意不包含 global/host/workspace 多层 scope、自定义 migration、远端同步或 Replica。
插件卸载只撤销 schema，不删除持久化值；重新安装同一 contribution 后原值重新生效。

### 插件平台补齐进度（2026-09-22）

- 扩展管理主入口为 Skills 的“扩展”Tab。应用通过 `PlatformViewRegions.ExtensionLibrary` 提供内容；不受技能 Host 选择影响。目录只读合并 Supervisor、Manager 与公开贡献，区分内建/安装、启用意图、运行故障和当前版本仍运行时的操作失败。列表搜索/来源筛选，详情复用 Manager 操作；内建项暂不开放停用/移除，URL 安装仅开发者模式。旧 Settings 插件路由保留兼容，导航不再展示入口。
- Web bootstrap 保留 WebSocket 基础连接扩展为关键依赖；主题、语音、模型管理、产品接入等第一方扩展使用可选激活，失败记录在 Supervisor，继续其他扩展。语音、Builtin Agents、HyperNode、Collaboration、Bot Chat/Management 的动态 import 和工厂也通过 `loadOptional` 有界执行；平台账户服务模块仍属于 Application bootstrap 的必需依赖。
- 持久化产物独立存入 `system/artifacts/<sha256>`；安装集合只保存引用，CAS 成功后才切换安装指针，候选写入失败保留旧指针。缺失产物不自动联网换版本，插件提示显式重新加载修复。旧产物暂时保留，后续 GC 不影响正确性。
- Module Loader、`activate` 工厂与每个内部 adapter prepare/commit 等待默认各 15 秒；subscription/internal disposer、rollback 与 command drain 默认每次 5 秒。超时撤销旧 API，继续剩余清理；工厂或 commit 迟到返回的 disposer 仍被调用，退休后命令结果不再成功返回。不隔离 trusted 模块同步死循环，也不能强制终止任意插件自行创建的副作用；prepare 必须无副作用。
- 公共 `OpenCraftExtensionDefinition` 只引用公共 API，第一方 Theme Pack 已消费；`api.signal` 在失败或停用时先于清理 abort，运行中的插件可继续登记资源 subscription（贡献本身仍只在激活期登记）。自包含示例见 `examples/extensions/hello.mjs`，测试覆盖注册导航、调用公告与卸载中的待决结果。
- Manifest V1 的格式解析保留合法的未来 `apiVersion`，当前 Supervisor 在执行 `activate` 前单独检查 API 与平台兼容性。未来 API 的安装记录不会被当作损坏记录删除；Manager 投影 `incompatible`，保留启用意图及配置。当前仅支持 API 1，不承诺旧 API 永久兼容。
- `reload` 与同 ID 重新安装共享替换流程：候选成功激活且保存成功才更新安装记录；失败重新激活本进程保存的旧定义，使用新 activationId，旧安装版本和 enabled 保持不变。已停用插件重新安装保持停用。
- 更新恢复不回滚插件自行产生的副作用。新 module-url 安装随记录持久化自包含 ESM 与 SHA-256；恢复先校验保存内容，不请求源 URL，只有显式 reload 才下载候选。模块上限 512 KiB，静态/动态 import 与 import.meta 在执行前拒绝，要求作者 bundle 私有依赖。旧的未固定记录仍走原 URL 加载，显式更新后固定。摘要用于完整性而非发布者身份认证；可信代码不是沙箱。完整版本范围、第一方隔离、公共接口扩展与客户端验收仍在建设，跟踪于 `docs/context/tasks/2026-09-22-extension-platform-completion.md`（仓库根）。

## 1. 结论

OpenCraft 是类似 Codex 的桌面/Web/移动商业 Workbench。它的公开生态和用户心智应当以
Plugin/Extension 为中心：安装、启用、设置、命令、面板、渲染器、Workspace 集成、升级和
卸载都属于稳定的 Extension Platform。

Agent Capability 是 Extension 的一个可选 Contribution，也是 AppServer/MCP 能力进入模型
的适配层；它不取代传统插件 API。完整 Agent 调用语义由
[`agent-capability-fabric.md`](./agent-capability-fabric.md) 定义。

OpenCraft 仍然不能把 Cordis 的 `Context` 直接作为公共插件 API。

最终方案吸收五套系统各自最强的一层：

- **Codex**：AppServer 负责插件目录、安装、启用、策略和可用性；客户端只激活已编译的
  first-party bridge，并把第三方 App UI 放入沙箱；
- **Obsidian**：插件、View 和子组件都有明确的 `load/unload` 所有权，注册操作自动归还
  disposer，开发体验非常好；
- **Chrome Extensions**：manifest-first、稳定 API namespace、package-contained code 和按需
  background lifecycle；权限与 isolated world 仅作为可选 restricted mode 的参考；
- **Firefox WebExtensions**：manifest-first、能力授权、执行域分离、受限 API 和消息桥；
- **Cordis**：作为 OpenCraft 内部的依赖注入、激活图、Fiber 生命周期和逆序清理内核。

一句话定义：

> **Cordis 是 OpenCraft 的内部扩展内核，不是安全沙箱、第三方 ABI 或 Agent 能力协议。**

公共插件以版本化 `OpenCraftExtensionApi` 为受支持边界。可信内建功能可以直接使用 Cordis；
用户明确启用的本地/Workspace Extension 可以采用 Obsidian 式可信执行。独立
ExtensionHost、Electron utility process、远端 Host 或 sandbox UI 是可选的故障/安全隔离
策略，不是所有插件的前置条件。

若发行渠道启用 Restricted Policy，Extension manifest 才申请安装级权限上限。普通可信
Extension 可以不启用细粒度权限 broker。无论插件采用哪种信任模式，Agent-facing
Contribution 仍不会因为安装或激活而自动进入模型上下文。

面向开发者的一句话定义是：

> **开发手感与信任方式接近 Obsidian，API 稳定性借鉴 Chrome，远端能力接近 Codex。**

这不会推翻现有的多 Runtime 设计。OpenCraft 仍然保留多个独立 Cordis Context；新增的
`ExtensionSupervisor` 用一个 Contribution Broker 跨域登记贡献，并把所有 disposer 挂到
同一个插件 Activation Fiber 上，从而做到“一次激活、原子贡献、一次卸载、完整清理”。

## 2. 参考系统复审

| 系统 | 已证明的优点 | 不能直接复制的部分 | OpenCraft 采用方式 |
| --- | --- | --- | --- |
| Codex | 插件目录/安装/启用属于 AppServer 产品面；first-party bridge 按可用性惰性创建；App Action 有 schema 和 lazy registry；MCP App 使用独立 sandbox | 尚未看到把任意第三方 React 组件加载进主 Renderer 的公共 ABI | 复用上游 Plugin 协议；客户端扩展只经 capability/action/sandbox 边界进入 |
| Obsidian | `Plugin extends Component`；`register*()` 自动清理；命令、View、编辑器扩展、Markdown、设置等贡献点成熟；Workspace 可按 View 类型恢复 | 公共 API 与内部实现边界仍会受 Renderer/Node 环境影响 | 复制生命周期手感、可信本地插件、命名空间、View 恢复和 SDK 体验 |
| Firefox/Chrome | manifest、版本化 API namespace、package-contained code；可进一步提供权限、执行分域和消息桥 | 完整 WebExtension 安全平台成本高且不是本地 vibe coding 的必要条件 | 首先采用 manifest/API/打包边界；restricted sandbox 和细粒度权限按发行渠道选配 |
| OpenCraft 当前 | Chat renderer、directive、resource policy、panel、session projector 等已经可通过 Cordis 注册；销毁已有 Fiber 语义 | 多个小 Runtime 各自暴露 `install(plugin, unknown)`；无 manifest、稳定 SDK、activation owner、迁移与兼容门 | 保留内部 registry，实现统一 ExtensionSupervisor 和公开稳定 SDK |

参考资料：

- Codex 恢复源码：`reference://codex/.runtime/partition-r2440-lifecycle-owner-adoption`；
- Obsidian 恢复源码：`/data/obsidian/recovered-standard-js/web/app/renderer.js`；
- [Obsidian 插件生命周期](https://docs.obsidian.md/plugins/guides/lifecycle-management)；
- [Firefox 扩展结构](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Anatomy_of_a_WebExtension)；
- [Firefox 权限模型](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/permissions)；
- [Firefox 沙箱页](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/sandbox)。
- [Firefox WebExtension API 执行域](https://firefox-source-docs.mozilla.org/toolkit/components/extensions/webextensions/basics.html)。

### 2.1 Codex 源码证据

| 证据 | 说明 |
| --- | --- |
| `shared/create-plugin-bridge-manager-07301.js` | 监听 installed/enabled availability；只在可用时创建 bridge，无订阅且无实例时释放 watcher |
| `shared/create-first-party-plugin-bridges-07300.js` | bridge 来自编译期 registration；当前策略仅为 local Host 上已安装、已启用的同名插件激活 |
| `shared/dispatch-app-action-01763.js` | 先解析 action envelope，再 lazy import action registry，未知 action 明确失败 |
| `lazy/app-initial/register-app-actions-DuIY2vIO.js` | 内建 action 逐类做 schema validation 和版本化 dispatch，不执行外部任意函数 |
| `service/mcp-app-sandbox-renderer-07461.js` | MCP App 通过独立 sandbox origin、CSP、资源代理、主题/尺寸 RPC 和失败状态呈现 |
| `service/renderer-mcp-schema-config-07344.js` | sandbox、theme、device/input、host/app capabilities 都有显式 schema |
| `shared/create-theme-registry-06923.js` | 内部 theme factory registry 有重复检查、lazy resolve 和 generation cache |
| `settings/appearance-settings-01201.ts` | 明暗偏好、Chrome 色板、代码主题、字号和动效是独立设置，不压成一个 theme blob |
| `shared/use-theme-value-07840.ts` | 只有 system 偏好才订阅系统主题，并通过 `useSyncExternalStore` 消费 |
| `shared/subscribe-to-system-theme.ts` | Electron 原生主题订阅优先，Web 回退到 `matchMedia`，由根服务持有订阅 |
| `shared/prose-mirror-extension-registry-03888.js` | 内部编辑器扩展按 Node/Mark/other 分类、解析依赖；它不是社区插件沙箱 |
| `packages/appserver-protocol/src/generated/v2/Plugin*.ts` | OpenCraft 已同步 AppServer 的 source/catalog/install/policy/interface 协议 |

这里最重要的不是“Codex 也有 Registry”，而是 **Codex 没有把这些内部 Registry 当成
第三方执行边界**。产品插件是否可用来自 AppServer；主 Renderer 的 bridge/action 是应用
已经知道的代码；任意 App 内容进入另一条 sandbox 路径。

### 2.2 Obsidian、WebExtensions 与 OpenCraft 源码证据

- Obsidian `renderer.js:63055` 附近的 `Component` 保存 children 与 disposer，并在 unload
  时逆序清理；`renderer.js:117057` 附近的 `Plugin` 给 command、view、editor extension、
  markdown processor、settings 等登记 disposer，并用 manifest ID 做 namespace；
- `/data/obsidian/ANALYSIS.md` 和加载器证明社区 `main.js` 在 `nodeIntegration: true`、
  `contextIsolation: false` 的 Renderer 中执行。这解释了它极强的插件能力，也解释了 OpenCraft
  不能照搬其安全边界；
- Firefox 的 manifest 声明入口和权限，content script 只获得受限 API，并通过消息请求
  background；sandbox page 使用不透明 origin，拿不到 WebExtension API；
- OpenCraft 的 `packages/chat-render-react/src/runtime.ts` 与
  `packages/workbench-panels-react/src/index.ts` 都新建各自 Context 并直接暴露
  `install(plugin, config?: unknown)`；这证明生命周期内核已存在，但公共治理层尚不存在。

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

因此 OpenCraft 不再发明一套与 Codex 冲突的 marketplace/install 协议。它增加的是客户端扩展
manifest、贡献协议与执行宿主；上游目录通过 adapter 投影进统一的插件管理页面。

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
  ├─ providerId              如何连接，例如 vela.websocket
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

OpenCraft 采用与 Obsidian `Ribbon/Command -> ViewType -> WorkspaceLeaf` 相同的所有权原则，但不公开
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
- `NavigationContribution` 定义 `sidebar-primary/sidebar-footer` 入口及语义 target；
- `SidebarCatalogContribution` 引用 View，由宿主保留标题、折叠、滚动和间距所有权；
- `SettingsPageContribution` 引用 View，由 Settings route 生成导航；
- `WorkbenchSurfaceContribution` 只声明特殊宿主 surface，目前仅有 `empty-workbench`。
- `BotContribution` 只声明 Bot 身份、头像、可用性和打开动作；它不拥有任何 Sidebar DOM 或坐标。
- `SidebarLayoutStore` 是 durable 置顶顺序的唯一所有者；Sidebar 根拥有拖拽事务、临时投影、磁力落点和滚动坐标系。
- AppServer Bot 目录先投影成带 `hostId/kind/entityId` 的 `SidebarEntity`，协议适配器负责创建与打开命令，React 不直接调用仓库。

Bot 提供方不能注入侧栏 DOM，也不能持有面板坐标。Bot 来源可以来自扩展贡献或任意
AppServer Host；两者进入同一个 Sidebar 实体投影后，才由平台分别呈现 pinned、row 或
collapsed rail。暂时离线的实体不会从 durable order 中删除。

桌面左栏、iPad Split View 和手机 Drawer 可以投影同一 Navigation/Catalog 声明；插件不得写死
侧栏宽度、左右方向或桌面 CSS 坐标。

## 7. 公共 Manifest 与 API

### 7.1 Manifest

公共 manifest 只描述静态、可验证的事实：

```ts
export interface OpenCraftExtensionManifestV1 {
  readonly manifestVersion: 1;
  readonly id: ExtensionId;
  readonly name: string;
  readonly version: string;
  readonly apiVersion: string;
  readonly engines: { readonly opencraft: string };
  readonly activationEvents: readonly ActivationEvent[];
  readonly requestedPermissions?: readonly ExtensionPermissionRequest[];
  readonly platforms?: readonly ("web" | "electron" | "ios" | "android")[];
  readonly dependencies?: readonly ExtensionId[];
  readonly entrypoints?: {
    readonly provider?: string;
    readonly sandboxUi?: string;
  };
  readonly contributes?: ExtensionContributions;
}

export type ActivationEvent =
  | `onCommand:${ContributionId}`
  | `onView:${ContributionId}`
  | `onResource:${string}`
  | `onLanguage:${string}`
  | "onStartupFinished";
```

默认不允许任意 `main` 进入主 Renderer。可信内建插件由应用编译清单登记，不通过公共
manifest 的 `provider` 入口冒充第三方。

### 7.2 公共 API

```ts
export interface OpenCraftExtensionApiV1 {
  readonly identity: Readonly<ExtensionActivationKey>;
  readonly subscriptions: DisposableStore;
  readonly commands: CommandsApiV1;
  readonly bots: BotsApiV1;
  readonly workspace: WorkspaceApiV1;
  readonly conversations: ConversationsApiV1;
  readonly resources: ResourcesApiV1;
  readonly storage: ExtensionStorageApiV1;
  readonly access: ExtensionAccessView;
}
```

公共 API 不导出：

- `@deepseek-ai/cordis` 类型；
- React/React Native Component 类型；
- TanStack Query client；
- AppServerClient/Transport；
- Replica mutable store；
- DOM、Electron IPC、Node `fs`；
- 应用内部 Store 的 `dispatch`。

公共 API 独立版本化。内部包重构、Cordis 升级和协议生成文件变化，不得强迫插件升级。

`storage` 的目标语义以 [插件持久化契约](./plugin-persistence.md) 为准：默认异步 JSON/KV，
宿主绑定插件命名空间与区域，Client-local 由 Electron SQLite / Web IndexedDB 投影，
Host 数据始终经该 Host authority 访问；SQL 不是跨端基础 API。物理 schema 与插件 payload
独立迁移，重载撤销旧 handle，停用/卸载不默认删除数据。当前 V1 已提供可空的
client-local 文档 storage 接口及 [Host 文档 API](./host-document-storage.md) 适配，
后者只绑定已初始化并实际支持协议的 Host。Host 仅提供 API，本期不建设
Host 插件装载器。插件可自建 Worker 并登记清理，Cordis 管激活/销毁和旧代次撤销。
本期不引入 Drizzle。

#### 7.2.1 稳定性契约

- manifest 用 `apiVersion` 声明兼容范围，Host 在安装前解析，不在运行到一半才失败；
- `OpenCraftExtensionApiV1` 在 V1 生命周期内只做向后兼容增加，删除或改变语义必须进入 V2；
- RPC envelope、错误码、资源 URI、Contribution ID 和持久化 state schema 都属于公共 ABI；
- 废弃 API 先产生开发诊断和迁移建议，经过公开兼容窗口后才能移除；
- SDK 只包含类型、schema、测试工具和 RPC client，不把应用内部实现打进插件；
- 每个 Host 发布机器可读 `supportedApiVersions + platformCapabilities`；
- Web、Electron、Expo 可以支持不同物理能力，但相同 API 的成功、拒绝、unsupported 和取消
  语义必须通过同一 contract suite；
- 每个稳定 API 都要有录制 fixture、错误码测试和至少一个旧版 Extension 兼容样本。

公开 API 的目标不是冻结所有功能，而是允许内部持续重构。Extension 依赖的是版本化 Port，
不是 Cordis Service key、React props、AppServer 生成类型或当前文件路径。

### 7.3 发行、解析与 Artifact

当前 V1 先提供明确标记为可信开发通道的 `module-url`。它用于团队内部和插件 SDK
成形前的快速迭代，不冒充正式 Marketplace 安装：

```text
module-url
  -> download bounded self-contained ESM + SHA-256
  -> validate dependencies and evaluate saved bytes
  -> validate manifest + platform + API version
  -> persist disabled InstallationRecord
  -> activate one Supervisor generation
  -> persist enabled=true only after activation succeeds
```

新安装把产物独立保存为摘要寻址文档、安装记录只保存引用；进程重启不重新下载已固定的源 URL。
该内容校验不是签名或发布者信任校验。只有显式 reload 请求候选版本；候选激活或保存失败保持
原安装指针，并尽可能恢复本进程旧定义。清理失败报告 failed，不能保留不存在的 active 状态。

它沿用 Obsidian 已验证的三层所有权：Installation Repository 保存用户意图，Module Loader
解析工件，Extension Supervisor 保存活跃实例；三者由 Extension Manager 串成唯一事务。
启用是“先激活、后保存 enabled”，停用是“先保存 disabled、后卸载”，所以刷新永远以明确的
用户意图恢复，而不会把半成功运行态误当成安装事实。损坏记录和单插件加载失败会隔离，不阻塞
Workbench 启动。Web 端记录保存在产品命名空间内的 IndexedDB；入口必须开启 CORS、使用
HTTPS（当 OpenCraft 由 HTTPS 提供）并自行 bundle 私有依赖。外部模块只得到冻结的公共
`OpenCraftExtensionApiV1`，不会得到内部 Cordis seam。

最小入口是一个无需私有 OpenCraft import 的自包含 ESM：

```js
export default {
  manifest: {
    manifestVersion: 1,
    id: "com.example.hello",
    name: "Hello",
    version: "1.0.0",
    apiVersion: 1,
    trust: "trusted",
    platforms: ["web"],
    activationEvents: ["onStartupFinished"],
  },
  activate(api) {
    return api.commands.register(
      { id: "com.example.hello.greet", title: "Greet" },
      () => "hello",
    );
  },
};
```

正式 Marketplace 仍采用下面的 Verified Artifact 链路；届时 `module-url` 保留为显式的
Developer Mode 来源，而不是自动升级为已验证包。

`local/git/npm/remote` 是来源描述，不是可直接执行的 URL。安装链路必须显式经过：

```text
CatalogEntry
  -> DependencyResolution + PlatformResolution
  -> VerifiedArtifact(hash/signature/manifest)
  -> ContentAddressedStore
  -> InstallationRecord
  -> Activation
```

规则：

- manifest、入口文件、资源清单和最终 hash 一起进入安装记录；
- 依赖图按 Profile/Host 生成确定性 lock，循环依赖和不兼容 API 在激活前失败；
- 社区扩展默认自行 bundle 私有依赖，只把版本化 OpenCraft SDK 视为 host-provided API；
- 插件不能共享主应用的 React、Cordis 或任意 npm 单例，避免 ABI/实例冲突；
- 正式 Marketplace 的 Web 安装不从任意 CDN `import()` npm 包；Verified Artifact 只能从
  受控独立 origin 加载；这不包含显式可信 Developer Mode 的 `module-url`；
- 更新先安装并验证新 Artifact，再创建新 Activation，贡献提交成功后才切换当前版本；
- 旧版本保留到新版本通过健康门，失败时回滚 Installation pointer；
- uninstall 先停用并撤销贡献，再删除 Installation；Artifact 的物理 GC 独立、可重试。

Artifact Store 是安装基础设施，不是业务状态，也不进入 Replica。远端 Host 的 Artifact
由该 Host 管理；浏览器客户端只取得 catalog/projection 和经过策略允许的 sandbox 资源。

## 8. 三种执行策略

执行策略是 Deployment Policy，不是 Extension API 类型。同一个 Extension 工程可以在本地
开发时以 `trusted` 运行，进入未知来源市场后按产品策略改用 `restricted`。

### Internal

- 随 OpenCraft 发布；
- 与应用同进程并可使用内部 Cordis/React；
- 用于核心 Chat presenter、协议 projector、浏览器 Adapter；
- 不属于公共 SDK 兼容承诺。

### Trusted

- 用户明确启用的 local/workspace/signed Extension；
- 默认使用公开 SDK，但可以在平台允许时获得 Node/DOM 等宿主能力；
- 可以同进程 Cordis scope 运行，也可以放进专用 ExtensionHost 做故障隔离；
- 不要求逐项文件/网络权限 broker；用户的信任对象是整个 Extension；
- 即便有完全权限，也仍必须遵守 Activation owner、generation fencing、稳定 ID 和 disposer；
- 导入 OpenCraft 私有包属于 unsupported 行为，而不是 Host 宣称能够安全阻止的攻击面。

这就是 OpenCraft 第一阶段最适合 vibe coding 的模式，接近 Obsidian：简单、直接、可调试。

### Restricted（可选）

- 面向未知 Marketplace 来源、组织受管环境或需要运行外部 App UI 的场景；
- 可以使用独立 origin、utility process、远端 Host、iframe/WebView 和受限 RPC；
- 可以启用文件、网络、终端、剪贴板、凭证和 Thread 级 permission broker；
- Host 可以设置 CPU、并发、消息大小和心跳预算。

普通同源 Web Worker 只能做线程/故障隔离，不能被宣传为安全沙箱。只有产品真的需要
Restricted channel 时，才建设和承诺相应安全边界。

UI 呈现位置与执行策略正交：Trusted 插件也可以选择 iframe；Restricted Provider 也可以
只贡献宿主原生声明式卡片。

## 9. 可选访问策略

本地 Trusted Extension 不强制启用细粒度 Permission。若组织策略或发行渠道需要 Restricted
Mode，可以把“请求访问”和“实际授予访问”分离。这里的 Permission 是 Artifact 安装上限，
不是 Agent-facing Capability Spec：

```ts
type ExtensionPermissionRequest =
  | { readonly kind: "workspace.read"; readonly roots: readonly string[] }
  | { readonly kind: "workspace.write"; readonly roots: readonly string[] }
  | { readonly kind: "network"; readonly origins: readonly string[] }
  | { readonly kind: "terminal.execute"; readonly hostScopes: readonly string[] }
  | { readonly kind: "conversation.read" }
  | { readonly kind: "conversation.write" }
  | { readonly kind: "clipboard.read" }
  | { readonly kind: "clipboard.write" };
```

Restricted Mode 下的不变量：

1. manifest 只是请求，不是授权；
2. 用户、组织策略和 Host Policy 的交集才是 grant；
3. grant 单独持久化，可撤销，可按 Host/Workspace 收窄；
4. API 每次调用在 broker 端校验，不能只在安装时校验；
5. `activeThread`/`activeResource` 类临时授权不扩展成全局权限；
6. 插件看不到原始凭证，只能调用被授权的操作；
7. 权限改变会使旧 generation 失效并重新激活。

## 10. Contribution 模型

### 10.1 所有登记都必须带 Owner

当前多个 Registry 只用裸 `string` 作为 key。目标接口必须携带来源：

```ts
export interface ContributionOwner {
  readonly activation: ExtensionActivationKey;
  readonly apiVersion: string;
  readonly trustTier: 0 | 1 | 2;
}

export interface ContributionRegistration<T> {
  readonly id: ContributionId;
  readonly owner: ContributionOwner;
  readonly value: T;
  readonly priority?: number;
}
```

规则：

- ID 必须位于 extension namespace；
- 完全相同 ID 不能静默覆盖；
- 只有明确定义的 replacement point 才允许 override；
- priority 只用于允许多实现的 provider，不用于绕过唯一所有者；
- owner 卸载时全部自动撤销；
- Registry snapshot 暴露 provenance，方便诊断“是谁注册了这个 View”。

### 10.2 公开贡献面

| 贡献面 | 社区扩展 | 可信内建 | 说明 |
| --- | --- | --- | --- |
| Commands / menus / keybindings | 是 | 是 | 执行经能力 API；冲突可诊断 |
| Workbench resources / views | 是 | 是 | 社区 UI 为 sandbox/declarative view |
| Settings schema | 是 | 是 | Host 生成字段 UI，值与页面位置分离 |
| Settings page / navigation / sidebar catalog | 声明式 | 是 | View 与入口分离；可信内建可登记平台 renderer |
| Bot identity / action | 是 | 是 | 数据提供方不拥有侧栏；Bot Panel 统一投影、置顶和拖拽 |
| Composer suggestion/provider | 是 | 是 | 返回 typed item；不取得编辑器实例 |
| Tool activity presentation | 受限 | 是 | 社区返回声明式卡片或 sandbox URI |
| Chat AST renderer | 受限 | 是 | 社区不能注册任意 React Component |
| Theme/icon/token extension | 受限 | 是 | V1 已支持双明暗语义 palette；不覆盖任意全局 CSS |
| Protocol projector / Resume strategy | 否 | 是 | 属于一致性和安全核心 |
| Replica reducer / Resume strategy / Auth | 否 | 是 | 属于一致性或凭据核心 |
| Connection provider factory | 否（V1） | 是 | 只产出 Transport；Application 持有实例并管理 lease |
| Browser engine / physical Surface | 否 | 是 | 社区只能请求 Browser capability |

### 10.3 View 恢复

Workspace checkpoint 只持久化：

```ts
interface ExtensionViewCheckpoint {
  readonly contributionId: ContributionId;
  readonly extensionVersion: string;
  readonly stateVersion: number;
  readonly state: unknown;
}
```

恢复时先解析 Extension，再做 state migration，最后创建 View。插件缺失、禁用或迁移失败
时显示稳定 placeholder，不能让整个工作台白屏。View 关闭只销毁 View instance，不自动
停用 Extension；Extension 停用会关闭或占位它拥有的全部 View。

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

Codex 当前的 first-party bridge 只对 `local` Host 生效，是产品策略证据，不应被泛化成
“所有插件都只能 local”。OpenCraft 的 bridge 必须显式声明 location policy。

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

## 14. 当前设计差距

### 14.1 已经正确

- Registry 与 runtime 行为分开；
- Chat renderer、directive、resource policy、Panel definition/renderer 已可插拔；
- Cordis Fiber 已提供 disposer 和失败边界；
- HostRuntime、Replica、Session、Renderer 没有被塞进一个全局 Context；
- Web 与 Native 已经按 semantic model / platform renderer 分层；
- AppServer 协议已经拥有最新 Plugin 产品面类型。

### 14.2 尚未完成的生态边界

- 部分旧 Chat/Panel/Composer Runtime 仍使用内部 Cordis install，尚未全部迁移至统一公开贡献协议；
- 公共贡献已有 namespace 与 Activation owner，但正式 Artifact provenance、内容锁定与跨重启更新恢复仍缺失；
- 已有 manifest 与活动依赖检查，activation event 调度、完整依赖解析及可选 capability grant 仍待建设；
- 没有 Web sandbox/utility/remote ExtensionHost；
- 没有 View state migration、失败 quarantine、crash-loop 防护；
- React Component registration 还没有明确标注为 Tier 0 only；
- 没有插件 API 兼容性测试和恶意/故障插件测试。

因此当前架构可以维护内部 feature，但不能安全地宣称“支持社区插件”。

### 14.3 Extension Workshop：Vibe coding 的产品入口

Vibe coding 不直接修改 OpenCraft Runtime。Agent 和用户共同维护一个真实 Extension 工程：

```text
my-extension/
  opencraft-extension.json
  src/
    extension.ts
    providers/
    ui/
  tests/
    activation.test.ts
    permissions.test.ts
    smoke.test.ts
  package.json
  tsconfig.json
```

标准闭环：

```text
scaffold
  → Agent 修改 TypeScript
  → typecheck + contract tests
  → bundle package-contained code
  → manifest/API/access diff
  → preview + hot reload
  → user installs as workspace/profile extension
  → optional sign/publish
```

不变量：

- Agent 可以创建、解释、修改和测试工程，不能绕过用户动作静默安装；
- Preview 与正式 Activation 使用相同 Host/RPC，只是 Installation scope 和信任级别不同；
- 每次预览钉住 Artifact hash，热更新创建新 generation，不原地替换正在执行的代码；
- 生成代码只能引用 `@opencraft/extension-sdk`，构建器拒绝内部包与路径导入；
- 发布包必须包含源码 provenance、依赖 lock、访问说明、兼容版本和可重复测试结果；
- `contributes.agentCapabilities` 是可选项。普通主题、View、Command 插件不需要理解 Agent
  Capability Spec、Lease 或 Invocation。

Harness 式 `inspect → define → run/update/stop` 可以作为 Workshop 的快速 Preview 实现参考，
但最终产物必须回到上述工程、构建和安装链，而不是永久保留一段进程内匿名代码。

## 15. 实施顺序

### Phase 0：冻结术语与边界

1. 新建 `extension-contract`；
2. 明确 `AppServer Plugin` 与 `OpenCraft Extension`；
3. 将公共文档中的“plugin”区分为 `builtin extension`、`server plugin`、`community extension`；
4. 标记现有 `runtime.install(Cordis Plugin)` 为 `@internal`。

状态：1-3 已完成；4 随各 Runtime 迁移逐步完成。

### Phase 1：可信内建扩展内核

1. 实现 `ExtensionSupervisor`、Activation Graph、Owner metadata；
2. 用 Contribution Broker 接入现有 Chat/Panel/Composer Registry；
3. 把现有内建扩展迁移到统一 Activation；
4. 证明一个 Extension 可原子注册 command + panel + tool presenter 并完整卸载。

状态：1 已完成；Contribution Broker 已覆盖 command/settings/declarative view；WebSocket Host 已完成
第一条真实迁移和 lease 验证。Chat/Panel/Composer 迁移与 tool presenter 组合证明仍待完成。

### Phase 2：惰性激活与恢复

1. manifest validator；
2. `onCommand/onView/onResource/onStartupFinished`；
3. Installation/Activation/Failure store；Restricted Mode 再增加 Permission store；
4. View checkpoint、state migration、缺失插件 placeholder；
5. TanStack Query 接入 AppServer marketplace/install mutations。

### Phase 3：Extension Workshop

1. `@opencraft/extension-sdk`、scaffold 与 TypeScript 模板；
2. typecheck、contract test、bundle、Artifact hash；
3. Trusted workspace/profile install 与热更新 generation；
4. manifest/API/access diff 和失败 rollback；
5. Agent 驱动的创建、修改、测试与 Preview UI。

### Phase 4：远端 Host 与 Agent Contribution

1. AppServer Plugin catalog adapter；
2. SSH/Durable 的 location-aware Activation；
3. `contributes.agentCapabilities` adapter；
4. Agent ModelView/Invocation/Receipt contract；
5. Web/Expo declarative UI fallback。

### Phase 5：Restricted Channel（按商业需求选做）

1. 独立/opaque-origin Web Host 或 Electron utility process；
2. iframe/MessagePort、sandbox webview、Expo WebView；
3. permission broker、revoke、预算和 generation fencing；
4. 故障、超时、崩溃、越权和 sandbox 测试；
5. 组织策略或未知 Marketplace 来源接入。

## 16. 质量门与不变量

### 生命周期

- 一个 Activation 只有一个 Cordis Fiber owner；
- 激活任一步失败时，已经登记的贡献全部逆序撤销；
- disable/uninstall/update/Host disconnect 都不会遗留命令、View、event、timer 或 process；
- View unmount 不等于 Extension deactivate；
- 旧 activationId 或旧 generation 的异步返回永远不能提交。

### 稳定 API

- SDK 构建与类型检查不允许依赖 OpenCraft private package/path；这是一条支持边界，不冒充沙箱；
- V1 Extension 在后续兼容 Host 中继续通过 contract suite；
- 内部 Cordis、React、AppServer 和 Replica 重构不改变公共 API；
- 用户生成 Extension 的 Preview 与正式 Activation 使用同一 API/RPC 语义；
- Trusted plugin 崩溃、更新失败或 disposer 抛错不会破坏 Activation 账本。

### Restricted Channel 安全门（启用时）

- 未授权 API 在 broker 端拒绝，而非只在 UI 隐藏；
- sandbox UI 无主文档 DOM、Cookie、令牌和原始 IPC；
- manifest 路径、包内容、签名/hash 与更新来源可审计；
- 权限撤销不需要重启应用。

### 一致性

- 公共 Extension API 不提供 Replica 任意写入口；
- server plugin availability 始终带 `hostId`；
- contribution ID 全局确定、可追踪、无静默覆盖；
- 缺失/故障插件不能阻断工作台恢复；
- Marketplace Query cache 失效不改变已经激活的运行事实。

### 跨平台

- 同一 manifest 在四端得到一致的 capability 与 contribution 解析结果；
- unsupported target 明确降级，不静默丢按钮；
- Web/Native 对同一个 declarative contribution 通过契约测试；
- sandbox 主题只使用版本化语义 Token。

## 17. 复审结论

OpenCraft 当前的方向没有错，真正的问题不是“Cordis 用少了”，而是还没有把内部插件机制和
公共插件生态分层。

如果直接把现有 `Context`/`Plugin` 暴露出去，虽然能快速得到 Obsidian 级开发便利，却会把
Web、Electron、Expo 和 SSH Host 锁死在一个不稳定的 TypeScript 内部 ABI 上。真正必须
隔离的是公共 API 与内部实现；安全沙箱是否启用由插件来源和商业渠道决定。

如果按本文实现：

- 内部功能继续享受 Cordis 的轻量 DI 和自动清理；
- 插件作者得到接近 Obsidian 的 `activate + subscriptions + registerContribution` 体验；
- 本地 vibe coding 可以采用简单的 Trusted 模式；需要时仍有 Restricted channel 演进路径；
- AppServer Plugin、Skills、Hooks、MCP Apps 与 Codex 协议保持原生兼容；
- React DOM、React Native 与远端 Host 不需要共享组件体或进程模型；
- 将来可以建立真正的 marketplace，而不需要再推翻 HostRuntime、Replica 和工作台布局。

这应当成为 OpenCraft Extension Platform 的正式目标架构；面向 Agent 的可选调用投影见
[`agent-capability-fabric.md`](./agent-capability-fabric.md)。
