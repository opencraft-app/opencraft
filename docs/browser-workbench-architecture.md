# OpenCraft 跨平台浏览器工作台实施设计

本页是浏览器工作台架构入口。状态说明、正式契约、目标设计与验收限制按职责保留在下列专题正文；修改行为时维护对应专题。

| 专题 | 范围 |
| --- | --- |
| [Overview and ownership](architecture/browser/overview-and-ownership.md) | 架构状态、身份、公开概念与状态所有权 |
| [Domain and runtime](architecture/browser/domain-and-runtime.md) | 领域契约、命令、Cordis、Host 与运行时接口 |
| [Platform and presentation](architecture/browser/platform-and-presentation.md) | 多端布局、导航、Host 呈现与视口几何 |
| [Remote surface and lifecycle](architecture/browser/remote-surface-and-lifecycle.md) | Linux Surface、观看与控制租约、媒体和生命周期 |
| [Remote input and editing](architecture/browser/remote-input-and-editing.md) | 原生触摸、键盘、IME、选区与交互失效边界 |
| [Persistence and recovery](architecture/browser/persistence-and-recovery.md) | Replica、Checkpoint、Bridge、查询与恢复 |
| [Acceptance and migration](architecture/browser/acceptance-and-migration.md) | 测试不变量、实施顺序、完成定义与复审状态 |

## 章节索引

下列旧章节锚点继续有效，并链接到对应正文。

### Overview and ownership

- <a id="1-结论"></a>[1. 结论](architecture/browser/overview-and-ownership.md#1-结论)
- <a id="2-第一性原理"></a>[2. 第一性原理](architecture/browser/overview-and-ownership.md#2-第一性原理)
- <a id="21-身份必须描述不随投影改变的事实"></a>[2.1 身份必须描述不随投影改变的事实](architecture/browser/overview-and-ownership.md#21-身份必须描述不随投影改变的事实)
- <a id="22-状态放在真正改变它的地方"></a>[2.2 状态放在真正改变它的地方](architecture/browser/overview-and-ownership.md#22-状态放在真正改变它的地方)
- <a id="23-生命周期通过句柄表达"></a>[2.3 生命周期通过句柄表达](architecture/browser/overview-and-ownership.md#23-生命周期通过句柄表达)
- <a id="24-跨平台共享行为不共享桌面布局"></a>[2.4 跨平台共享行为，不共享桌面布局](architecture/browser/overview-and-ownership.md#24-跨平台共享行为不共享桌面布局)
- <a id="25-抽象由第二个实现证明"></a>[2.5 抽象由第二个实现证明](architecture/browser/overview-and-ownership.md#25-抽象由第二个实现证明)
- <a id="4-产品级身份"></a>[4. 产品级身份](architecture/browser/overview-and-ownership.md#4-产品级身份)
- <a id="5-三种公开概念"></a>[5. 三种公开概念](architecture/browser/overview-and-ownership.md#5-三种公开概念)
- <a id="51-browsersession"></a>[5.1 BrowserSession](architecture/browser/overview-and-ownership.md#51-browsersession)
- <a id="52-conversationbrowserlink"></a>[5.2 ConversationBrowserLink](architecture/browser/overview-and-ownership.md#52-conversationbrowserlink)
- <a id="53-browserviewhandle"></a>[5.3 BrowserViewHandle](architecture/browser/overview-and-ownership.md#53-browserviewhandle)
- <a id="54-backing-owner-与关闭语义"></a>[5.4 Backing owner 与关闭语义](architecture/browser/overview-and-ownership.md#54-backing-owner-与关闭语义)
- <a id="6-状态所有权"></a>[6. 状态所有权](architecture/browser/overview-and-ownership.md#6-状态所有权)

### Domain and runtime

- <a id="7-browser-domain-最小契约"></a>[7. Browser Domain 最小契约](architecture/browser/domain-and-runtime.md#7-browser-domain-最小契约)
- <a id="headless-文件目录与原生预留"></a>[Headless 文件目录与原生预留](architecture/browser/domain-and-runtime.md#headless-文件目录与原生预留)
- <a id="71-正交状态"></a>[7.1 正交状态](architecture/browser/domain-and-runtime.md#71-正交状态)
- <a id="72-url-必须通过构造器"></a>[7.2 URL 必须通过构造器](architecture/browser/domain-and-runtime.md#72-url-必须通过构造器)
- <a id="73-能力只暴露有效结果"></a>[7.3 能力只暴露有效结果](architecture/browser/domain-and-runtime.md#73-能力只暴露有效结果)
- <a id="8-命令按责任拆分"></a>[8. 命令按责任拆分](architecture/browser/domain-and-runtime.md#8-命令按责任拆分)
- <a id="81-authority-命令"></a>[8.1 Authority 命令](architecture/browser/domain-and-runtime.md#81-authority-命令)
- <a id="82-不属于-authority-的动作"></a>[8.2 不属于 Authority 的动作](architecture/browser/domain-and-runtime.md#82-不属于-authority-的动作)
- <a id="9-applicationsupervisor-与-cordis"></a>[9. ApplicationSupervisor 与 Cordis](architecture/browser/domain-and-runtime.md#9-applicationsupervisor-与-cordis)
- <a id="91-组合原则"></a>[9.1 组合原则](architecture/browser/domain-and-runtime.md#91-组合原则)
- <a id="92-允许多个-context"></a>[9.2 允许多个 Context](architecture/browser/domain-and-runtime.md#92-允许多个-context)
- <a id="93-host-runtime"></a>[9.3 Host Runtime](architecture/browser/domain-and-runtime.md#93-host-runtime)
- <a id="10-browser-runtime-与-provisional-engine-spi"></a>[10. Browser Runtime 与 provisional Engine SPI](architecture/browser/domain-and-runtime.md#10-browser-runtime-与-provisional-engine-spi)
- <a id="101-browsersessionservice"></a>[10.1 BrowserSessionService](architecture/browser/domain-and-runtime.md#101-browsersessionservice)
- <a id="102-engine-spi-尚不冻结"></a>[10.2 Engine SPI 尚不冻结](architecture/browser/domain-and-runtime.md#102-engine-spi-尚不冻结)
- <a id="103-presentation-lease"></a>[10.3 Presentation Lease](architecture/browser/domain-and-runtime.md#103-presentation-lease)
- <a id="18-最小包结构"></a>[18. 最小包结构](architecture/browser/domain-and-runtime.md#18-最小包结构)
- <a id="browser-host-registry-contract-2026-10-20"></a>[Browser Host registry contract (2026-10-20)](architecture/browser/domain-and-runtime.md#browser-host-registry-contract-2026-10-20)

### Platform and presentation

- <a id="11-workbench-resource-与平台布局"></a>[11. Workbench Resource 与平台布局](architecture/browser/platform-and-presentation.md#11-workbench-resource-与平台布局)
- <a id="111-共享部分"></a>[11.1 共享部分](architecture/browser/platform-and-presentation.md#111-共享部分)
- <a id="112-renderer-local-部分"></a>[11.2 Renderer-local 部分](architecture/browser/platform-and-presentation.md#112-renderer-local-部分)
- <a id="113-关闭与迁移"></a>[11.3 关闭与迁移](architecture/browser/platform-and-presentation.md#113-关闭与迁移)
- <a id="12-平台策略"></a>[12. 平台策略](architecture/browser/platform-and-presentation.md#12-平台策略)
- <a id="121-vite-web"></a>[12.1 Vite Web](architecture/browser/platform-and-presentation.md#121-vite-web)
- <a id="122-electron"></a>[12.2 Electron](architecture/browser/platform-and-presentation.md#122-electron)
- <a id="123-expo-native"></a>[12.3 Expo Native](architecture/browser/platform-and-presentation.md#123-expo-native)
- <a id="124-expo-web"></a>[12.4 Expo Web](architecture/browser/platform-and-presentation.md#124-expo-web)
- <a id="embedded-preview-projection"></a>[Embedded preview projection](architecture/browser/platform-and-presentation.md#embedded-preview-projection)
- <a id="web-product-navigation"></a>[Web product navigation](architecture/browser/platform-and-presentation.md#web-product-navigation)
- <a id="viewport-drag-geometry-replacement-2026-10-20"></a>[Viewport drag geometry replacement (2026-10-20)](architecture/browser/platform-and-presentation.md#viewport-drag-geometry-replacement-2026-10-20)
- <a id="browser-presentation-transition-ownership-2026-10-20"></a>[Browser presentation transition ownership (2026-10-20)](architecture/browser/platform-and-presentation.md#browser-presentation-transition-ownership-2026-10-20)
- <a id="replaced-host-registration-completion-2026-10-21"></a>[Replaced host registration completion (2026-10-21)](architecture/browser/platform-and-presentation.md#replaced-host-registration-completion-2026-10-21)
- <a id="viewport-preset-compatibility-data-2026-10-20"></a>[Viewport preset compatibility data (2026-10-20)](architecture/browser/platform-and-presentation.md#viewport-preset-compatibility-data-2026-10-20)
- <a id="atomic-native-offscreen-resize"></a>[Atomic native offscreen resize](architecture/browser/platform-and-presentation.md#atomic-native-offscreen-resize)
- <a id="browser-layout-and-visibility-aperture-2026-10-22"></a>[Browser layout and visibility aperture (2026-10-22)](architecture/browser/platform-and-presentation.md#browser-layout-and-visibility-aperture-2026-10-22)
- <a id="shell-mode-transitions-and-browser-layout"></a>[Shell mode transitions and browser layout](architecture/browser/platform-and-presentation.md#shell-mode-transitions-and-browser-layout)
- <a id="browser-toolbar-input-action-artwork-2026-10-22"></a>[Browser toolbar input action artwork (2026-10-22)](architecture/browser/platform-and-presentation.md#browser-toolbar-input-action-artwork-2026-10-22)
- <a id="conversation-list-resource-management"></a>[Conversation list resource management](architecture/browser/platform-and-presentation.md#conversation-list-resource-management)

### Remote surface and lifecycle

- <a id="13-remote-browser"></a>[13. Remote Browser](architecture/browser/remote-surface-and-lifecycle.md#13-remote-browser)
- <a id="131-远端实例身份"></a>[13.1 远端实例身份](architecture/browser/remote-surface-and-lifecycle.md#131-远端实例身份)
- <a id="132-observer-与-controller"></a>[13.2 Observer 与 Controller](architecture/browser/remote-surface-and-lifecycle.md#132-observer-与-controller)
- <a id="133-实时帧是数据面"></a>[13.3 实时帧是数据面](architecture/browser/remote-surface-and-lifecycle.md#133-实时帧是数据面)
- <a id="linux-server-远程网页-surface2026-10-21"></a>[Linux Server 远程网页 Surface（2026-10-21）](architecture/browser/remote-surface-and-lifecycle.md#linux-server-远程网页-surface2026-10-21)
- <a id="remote-tab-state-and-viewer-lifecycle"></a>[Remote tab state and viewer lifecycle](architecture/browser/remote-surface-and-lifecycle.md#remote-tab-state-and-viewer-lifecycle)
- <a id="empty-remote-tab-recovery"></a>[Empty remote tab recovery](architecture/browser/remote-surface-and-lifecycle.md#empty-remote-tab-recovery)
- <a id="navigation-acceptance-and-loading"></a>[Navigation acceptance and loading](architecture/browser/remote-surface-and-lifecycle.md#navigation-acceptance-and-loading)
- <a id="accepted-remote-tab-closure"></a>[Accepted remote tab closure](architecture/browser/remote-surface-and-lifecycle.md#accepted-remote-tab-closure)
- <a id="durable-close-intent-and-acknowledgement"></a>[Durable close intent and acknowledgement](architecture/browser/remote-surface-and-lifecycle.md#durable-close-intent-and-acknowledgement)
- <a id="remote-frame-presentation-during-viewport-resize"></a>[Remote frame presentation during viewport resize](architecture/browser/remote-surface-and-lifecycle.md#remote-frame-presentation-during-viewport-resize)
- <a id="first-frame-handoff-within-a-remote-page"></a>[First-frame handoff within a remote page](architecture/browser/remote-surface-and-lifecycle.md#first-frame-handoff-within-a-remote-page)
- <a id="browser-process-transport-failure-isolation"></a>[Browser process transport failure isolation](architecture/browser/remote-surface-and-lifecycle.md#browser-process-transport-failure-isolation)
- <a id="native-state-acknowledgements-and-client-backgrounding"></a>[Native state acknowledgements and client backgrounding](architecture/browser/remote-surface-and-lifecycle.md#native-state-acknowledgements-and-client-backgrounding)

### Remote input and editing

- <a id="原生远程编辑运行时"></a>[原生远程编辑运行时](architecture/browser/remote-input-and-editing.md#原生远程编辑运行时)
- <a id="local-menus-and-remote-selection-boundary"></a>[Local menus and remote selection boundary](architecture/browser/remote-input-and-editing.md#local-menus-and-remote-selection-boundary)
- <a id="remote-surface-keyboard-activation"></a>[Remote surface keyboard activation](architecture/browser/remote-input-and-editing.md#remote-surface-keyboard-activation)
- <a id="native-touch-identities-and-private-crash-diagnostics"></a>[Native touch identities and private crash diagnostics](architecture/browser/remote-input-and-editing.md#native-touch-identities-and-private-crash-diagnostics)
- <a id="offscreen-wheel-injection"></a>[Offscreen wheel injection](architecture/browser/remote-input-and-editing.md#offscreen-wheel-injection)
- <a id="remote-input-document-and-interaction-fences"></a>[Remote input document and interaction fences](architecture/browser/remote-input-and-editing.md#remote-input-document-and-interaction-fences)

### Persistence and recovery

- <a id="14-replicacheckpoint-与安全"></a>[14. Replica、Checkpoint 与安全](architecture/browser/persistence-and-recovery.md#14-replicacheckpoint-与安全)
- <a id="141-可进入-v4-replica"></a>[14.1 可进入 V4 Replica](architecture/browser/persistence-and-recovery.md#141-可进入-v4-replica)
- <a id="142-本地-view-checkpoint"></a>[14.2 本地 View Checkpoint](architecture/browser/persistence-and-recovery.md#142-本地-view-checkpoint)
- <a id="143-永不持久化到普通-viewreplica"></a>[14.3 永不持久化到普通 View/Replica](architecture/browser/persistence-and-recovery.md#143-永不持久化到普通-viewreplica)
- <a id="15-iframe-bridge"></a>[15. iframe Bridge](architecture/browser/persistence-and-recovery.md#15-iframe-bridge)
- <a id="16-tanstack-query"></a>[16. TanStack Query](architecture/browser/persistence-and-recovery.md#16-tanstack-query)
- <a id="17-失败与恢复"></a>[17. 失败与恢复](architecture/browser/persistence-and-recovery.md#17-失败与恢复)
- <a id="171-iframe-拒绝"></a>[17.1 iframe 拒绝](architecture/browser/persistence-and-recovery.md#171-iframe-拒绝)
- <a id="172-hostauthority-断线"></a>[17.2 Host/Authority 断线](architecture/browser/persistence-and-recovery.md#172-hostauthority-断线)
- <a id="173-presentation-丢失"></a>[17.3 Presentation 丢失](architecture/browser/persistence-and-recovery.md#173-presentation-丢失)
- <a id="174-防-react-更新环"></a>[17.4 防 React 更新环](architecture/browser/persistence-and-recovery.md#174-防-react-更新环)

### Acceptance and migration

- <a id="19-测试不变量"></a>[19. 测试不变量](architecture/browser/acceptance-and-migration.md#19-测试不变量)
- <a id="191-身份与-runtime"></a>[19.1 身份与 Runtime](architecture/browser/acceptance-and-migration.md#191-身份与-runtime)
- <a id="192-browser-domain"></a>[19.2 Browser Domain](architecture/browser/acceptance-and-migration.md#192-browser-domain)
- <a id="193-view-与-presentation"></a>[19.3 View 与 Presentation](architecture/browser/acceptance-and-migration.md#193-view-与-presentation)
- <a id="194-平台-capability-contract"></a>[19.4 平台 capability contract](architecture/browser/acceptance-and-migration.md#194-平台-capability-contract)
- <a id="195-remote-与安全"></a>[19.5 Remote 与安全](architecture/browser/acceptance-and-migration.md#195-remote-与安全)
- <a id="196-appshell"></a>[19.6 AppShell](architecture/browser/acceptance-and-migration.md#196-appshell)
- <a id="20-实施顺序"></a>[20. 实施顺序](architecture/browser/acceptance-and-migration.md#20-实施顺序)
- <a id="phase--1修正现有横切边界"></a>[Phase -1：修正现有横切边界](architecture/browser/acceptance-and-migration.md#phase--1修正现有横切边界)
- <a id="phase-0vite-单标签纵切"></a>[Phase 0：Vite 单标签纵切](architecture/browser/acceptance-and-migration.md#phase-0vite-单标签纵切)
- <a id="phase-1electron-第二实现"></a>[Phase 1：Electron 第二实现](architecture/browser/acceptance-and-migration.md#phase-1electron-第二实现)
- <a id="phase-2冻结-v1-与多标签"></a>[Phase 2：冻结 v1 与多标签](architecture/browser/acceptance-and-migration.md#phase-2冻结-v1-与多标签)
- <a id="phase-3remote-browser"></a>[Phase 3：Remote Browser](architecture/browser/acceptance-and-migration.md#phase-3remote-browser)
- <a id="phase-4expo"></a>[Phase 4：Expo](architecture/browser/acceptance-and-migration.md#phase-4expo)
- <a id="phase-5inline-sandbox-与生产强化"></a>[Phase 5：Inline Sandbox 与生产强化](architecture/browser/acceptance-and-migration.md#phase-5inline-sandbox-与生产强化)
- <a id="21-迁移与删除"></a>[21. 迁移与删除](architecture/browser/acceptance-and-migration.md#21-迁移与删除)
- <a id="22-完成定义"></a>[22. 完成定义](architecture/browser/acceptance-and-migration.md#22-完成定义)
- <a id="23-r6-复审结论"></a>[23. R6 复审结论](architecture/browser/acceptance-and-migration.md#23-r6-复审结论)
