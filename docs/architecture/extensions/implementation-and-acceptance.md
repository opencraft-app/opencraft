# Extensions: Implementation and acceptance

[Architecture index](../../plugin-architecture.md) · [Documentation index](../../README.md)

### 当前实现账本（2026-09-04）

已实现并进入仓库质量门：

- 随标准 Headless 分发的 `opencraft.account`：每部署独立本地账号的服务端凭据插件，拥有密码策略、验证及凭据版本证明；通过核心提供的窄存储端口保留既有账号库，不依赖统一账号中心。核心仍拥有浏览器登录态、自然人绑定、成员与资源授权，停用插件不能绕过准入。由私有配置启用，非浏览器扩展安装；见[服务器登录](../../server-authentication.md#自部署账号插件)。

- 可信产品装配可提供外部身份 provider、账户入口和设置页；凭据验证、员工目录与
  企业界面由下游插件持有，核心保留主体绑定、成员与资源授权。
  详见 [外部身份与消息来源契约](../../enterprise-authentication.md)。

- `packages/extension-contract`：renderer-free manifest V1、activation identity、Command、Settings、
  location-neutral View、Navigation、Sidebar Catalog、Settings Page、Workbench Surface、双明暗
  语义 Theme palette 与 disposer API；
- `packages/extension-runtime`：每 Activation 一个 Cordis Fiber、统一公开贡献快照、预检后单次发布、
  内部贡献 prepare/commit/逆序 rollback、generation fence、串行 activate/deactivate 和完整 dispose；
- 最小 Settings Value Store 已落地：只支持当前 Profile，只读写 manifest 已声明字段，提供
  default、运行时校验、`get/set/reset/subscribe`；Web 使用独立 IndexedDB Adapter；
- WebSocket Host provider 已从匿名 Cordis plugin 迁移为 `opencraft.websocket-host` first-party Extension；
  provider owner 是 activationId，卸载会先撤出 provider，再等待在用 Host lease 归还；
- `opencraft.theme-pack` 是第二个真实 Extension 切片：插件只登记 accent/ink/surface/contrast 与
  diff/skill 语义色，应用根统一派生完整 Token；选择被持久化，卸载时原子回退到内建中性主题；
- Theme palette 现在还可选择性声明 `surfaces`（window/sidebar/panel/input/popover 的
  `#RRGGBB` 色值）、`material.window`（translucent/opaque）和
  `material.elevation`（soft/flat，主工作区表面阴影）。没有覆盖的值继续由原算法生成。
  注册层拒绝 CSS/URL、未知选项和不完整的明暗色板，并冻结嵌套数据。
  Web/Electron 已消费这些字段；Expo 动态主题不在本轮范围。完整链路见
  [Theme surfaces and native appearance](../platform/presentation-and-input.md#theme-surfaces-and-native-appearance)。
- 场景测试覆盖成功激活、激活失败零残留、内部 commit 中断回滚、旧代 API 拒绝、重激活代际、
  平台筛选、Theme palette 校验和真实 WebSocket provider lease retirement。
- Workbench 采用 `entry -> semantic View -> host placement`：插件不再用一个
  `View.location` 同时表达侧栏按钮、设置页和物理容器；Sidebar 只消费声明式入口和目录，
  应用级导航事务统一拥有 URL、Back/Forward、激活态与卸载回退。

已实现第一阶段的 `module-url` Installation、启用意图持久化、刷新恢复、运行代际和声明式设置
页面，以及自包含 ESM 摘要固定和更新失败恢复。尚未实现：签名包/依赖 lock、惰性 activation event dispatcher、Extension Workshop、
Marketplace、restricted host/permissions，以及把 Chat/Panel/Composer 的所有既有内建项迁入
Supervisor。`internal.register()` 只供 first-party 适配器使用，不属于稳定社区 ABI。

Settings V1 刻意不包含 global/host/workspace 多层 scope、自定义 migration、远端同步或 Replica。
插件卸载只撤销 schema，不删除持久化值；重新安装同一 contribution 后原值重新生效。

### 插件平台补齐进度（2026-09-22）

- Embedded Chat 在同一 Application 内将语音、Collaboration、Bot Chat/Management 呈现和 Terminal 面板模块放入延后启动队列，首屏可用并完成 `show()` 的可见帧后才按依赖顺序激活；Full Workbench 默认保留 eager 策略。必需 Host/provider、账户身份和 Terminal 协议服务不后移。队列不拥有第二份扩展 registry；销毁先撤销未完成 import 的工厂 scope，再排空已开始激活，最后释放其借用的服务。该计划不是通用 activation event dispatcher。
- 扩展管理在普通 Settings 的“插件”页与 Skills 的“扩展”Tab 共用同一个 `ExtensionLibrary`。应用通过 `PlatformViewRegions.ExtensionLibrary` 提供内容；不受技能 Host 选择影响。目录只读合并 Supervisor、Manager 与公开贡献，区分内建/安装、启用意图、运行故障和当前版本仍运行时的操作失败。列表搜索/来源筛选，详情复用 Manager 操作；关键内建项不开放停用/移除，可选内建项支持启停，URL 安装仅开发者模式。Settings 导航向普通用户展示入口，不要求开发者模式；同时在有 Host 和无 Host 的工作台传入应用级 Supervisor 与 Manager，列表不依赖当前技能 Host。旧的 URL-only 设置实现已移除，避免漏掉内建项。
- Web bootstrap 保留 WebSocket 基础连接扩展为关键依赖；主题、语音、模型管理、产品接入等第一方扩展使用可选激活，失败记录在 Supervisor，继续其他扩展。语音、Builtin Agents、HyperNode、Bot Chat/Management 的动态 import 和工厂也通过 `loadOptional` 有界执行；平台账户服务模块仍属于 Application bootstrap 的必需依赖。
- Collaboration 改为可管理的可选内置扩展，通用 Web 默认停用；由 `ExtensionManager` 有界加载并激活，启停意图与用户安装扩展共用持久化仓库。停用时不加载实现或注册导航；产品初始默认值不覆盖已有用户选择。内置来源只允许启停，随应用更新，不开放 URL 更新/移除。详细产品边界见 [Collaboration Workspace](../../../design/collaboration-workspace.md#扩展发现与启用)。
- 持久化产物独立存入 `system/artifacts/<sha256>`；安装集合只保存引用，CAS 成功后才切换安装指针，候选写入失败保留旧指针。缺失产物不自动联网换版本，插件提示显式重新加载修复。旧产物暂时保留，后续 GC 不影响正确性。
- 安装记录的公共规范化入口为内嵌产物补齐相同 SHA-256 的 `artifactRef`；显式引用与内嵌产物不一致时拒绝该记录。写入返回、当前内存快照和持久化通知重读使用同一规范，旧内嵌格式无需重写数据，失败更新也不会因通知时序改变原安装身份。
- Module Loader、`activate` 工厂与每个内部 adapter prepare/commit 等待默认各 15 秒；subscription/internal disposer、rollback 与 command drain 默认每次 5 秒。超时撤销旧 API，继续剩余清理；工厂或 commit 迟到返回的 disposer 仍被调用，退休后命令结果不再成功返回。不隔离 trusted 模块同步死循环，也不能强制终止任意插件自行创建的副作用；prepare 必须无副作用。
- Supervisor 退出从首次 `dispose()` 同步关闭激活准入并撤销尚未交接的 activation API 开始。所有退出调用共享同一个清理结果，包括失败；先排空已接纳的 activate/deactivate，再逆序释放已激活扩展，使等待中的消费者仍可借用提供方完成回滚。工厂和内部 commit 跨等待返回的 disposer 必须先归入事务，再检查退休状态；不能因 API 已撤销而丢失资源，也不能重复清理。已开始的清理失败会向退出调用传播，普通激活失败不等于退出失败。退出后 `deactivate` 返回 false，optional module 的迟到成功或失败不能重新发布描述符；动态 import 本身不由 Supervisor 强制终止，工厂和 commit 仍受上述原有期限约束。
- Installation Manager 的首次退出也同步关闭准入；已进入的安装/更新操作在既有期限内排空，排队与后续操作在执行 loader 前拒绝。随后只逆序退休本 Manager 管理的定义，不关闭共享 Supervisor 或无关内建扩展。所有退出调用共享清理结果，逐项失败不跳过其余定义，也不能被吞为成功；普通操作失败与资源清理失败分开。保存的 enabled 意图不因 Application 退出改变，新 Manager 可正常恢复。
- 公共 `OpenCraftExtensionDefinition` 只引用公共 API，第一方 Theme Pack 已消费；`api.signal` 在失败或停用时先于清理 abort，运行中的插件可继续登记资源 subscription（贡献本身仍只在激活期登记）。自包含示例见 `examples/extensions/hello.mjs`，测试覆盖注册导航、调用公告与卸载中的待决结果。
- Manifest V1 的格式解析保留合法的未来 `apiVersion`，当前 Supervisor 在执行 `activate` 前单独检查 API 与平台兼容性。未来 API 的安装记录不会被当作损坏记录删除；Manager 投影 `incompatible`，保留启用意图及配置。当前仅支持 API 1，不承诺旧 API 永久兼容。
- `reload` 与同 ID 重新安装共享替换流程：候选成功激活且保存成功才更新安装记录；失败重新激活本进程保存的旧定义，使用新 activationId，旧安装版本和 enabled 保持不变。已停用插件重新安装保持停用。
- 更新恢复不回滚插件自行产生的副作用。新 module-url 安装随记录持久化自包含 ESM 与 SHA-256；恢复先校验保存内容，不请求源 URL，只有显式 reload 才下载候选。模块上限 512 KiB，静态/动态 import 与 import.meta 在执行前拒绝，要求作者 bundle 私有依赖。旧的未固定记录仍走原 URL 加载，显式更新后固定。摘要用于完整性而非发布者身份认证；可信代码不是沙箱。完整版本范围、第一方隔离、公共接口扩展与客户端验收仍在建设；公开范围与未完成项见本文第14节，当前可执行贡献路径见 [Extension development](../../extension-development.md)。

## 14. 当前设计差距

### 14.1 已经正确

- Registry 与 runtime 行为分开；
- Chat renderer、directive、resource policy、Panel definition/renderer 已可插拔；
- Cordis Fiber 已提供 disposer 和失败边界；
- HostRuntime、Replica、Session、Renderer 没有被塞进一个全局 Context；
- Web 与 Native 已经按 semantic model / platform renderer 分层；
- AppServer 协议已经拥有最新 Plugin 产品面类型；
- 可信 `module-url` 已保存自包含 ESM 的 SHA-256 固定产物，支持离线重启和更新失败保留旧安装指针，见 [Artifact 链路](manifest-and-contributions.md#73-发行解析与-artifact) 与 [产物行为测试](../../../tests/extensions/extension-artifacts.test.ts)；
- 可信 V1 的 API/平台兼容拒绝、激活失败回滚、期限和退出故障已有行为回归，见 [安装测试](../../../tests/extensions/extension-installations.test.ts) 与 [Supervisor 测试](../../../tests/extensions/extension-runtime.test.ts)。这些测试覆盖受信任模块的合作式故障边界。

### 14.2 尚未完成的生态边界

- 部分旧 Chat/Panel/Composer Runtime 仍使用内部 Cordis install，尚未全部迁移至统一公开贡献协议；
- 公共贡献已有 namespace 与 Activation owner；正式发行的发布者签名、来源信任和依赖 lock 仍缺失，已有的摘要固定与恢复不提供发布者身份保证；
- 已有 manifest 与活动依赖检查，activation event 调度、完整依赖解析及可选 capability grant 仍待建设；
- 没有 Web sandbox/utility/remote ExtensionHost；
- 没有 View state migration、失败 quarantine、crash-loop 防护；
- React Component registration 还没有明确标注为 Tier 0 only；
- 现有可信模块故障回归不能替代隔离宿主中的恶意代码测试；同步死循环和模块自行产生的任意副作用仍不受强制终止。

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

Workshop 的快速 Preview 可以使用 `inspect → define → run/update/stop` 流程；
最终产物必须回到上述工程、构建和安装链，不能永久保留一段进程内匿名代码。

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

如果直接把现有 `Context`/`Plugin` 暴露出去，虽然能简化开发，却会把
Web、Electron、Expo 和 SSH Host 锁死在一个不稳定的 TypeScript 内部 ABI 上。真正必须
隔离的是公共 API 与内部实现；安全沙箱是否启用由插件来源和商业渠道决定。

如果按本文实现：

- 内部功能继续享受 Cordis 的轻量 DI 和自动清理；
- 插件作者通过 `activate + subscriptions + registerContribution` 管理贡献及其生命周期；
- 本地 vibe coding 可以采用简单的 Trusted 模式；需要时仍有 Restricted channel 演进路径；
- AppServer Plugin、Skills、Hooks、MCP Apps 与 Codex 协议保持原生兼容；
- React DOM、React Native 与远端 Host 不需要共享组件体或进程模型；
- 将来可以建立真正的 marketplace，而不需要再推翻 HostRuntime、Replica 和工作台布局。

这应当成为 OpenCraft Extension Platform 的正式目标架构；面向 Agent 的可选调用投影见
[`agent-capability-fabric.md`](../../agent-capability-fabric.md)。
