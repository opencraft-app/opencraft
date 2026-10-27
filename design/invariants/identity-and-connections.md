# Workbench invariants: Identity and connections

[Invariant index](../invariants.md) · [Design index](../README.md)

## Employee account entrance

- The 企业身份 plugin owns stable browser-loaded `directory.example.com/photo/150` URLs for
  employee photos. The account menu/footer and each verified message sender use
  the same directory lookup; sender identity never follows the footer account.
  Failure preserves fixed geometry and the verified name/default visual.
  Account changes replace URLs; plugin unloading removes the sender resolver.
  Foreground revalidation must retain loaded avatar DOM and same-account display
  metadata while preserving authenticated expiration. Display-only caches belong
  to 企业身份, are bounded in memory, and clear on confirmed revocation/account change.
  Warm row remounts reuse metadata; notifications and connection changes revalidate.


- A configured enterprise OA identity provider automatically projects the verified
  request identity into the existing Sidecar footer. The label is the employee
  login name, or “员工身份” when anonymous; clicking opens details and refresh.
- Footer precedence changes presentation only. Product account credentials and
  resource authority remain independently owned; equal precedence is rejected
  and unloading an employee provider restores the product entrance.
- No fixed employee login URL, synthetic identity or unsupported logout control
  is presented. Authoritative 401/expiration clears the footer; details remain
  available for refresh. Historical product coverage named
  `tests/enterprise-identity.test.ts` and `scripts/smoke-enterprise-identity.ts`.
  Neither probe is shipped in this standalone checkout; this record is not a
  runnable core check. Live gateway evidence still requires a separate product run.

## SSH connection management

- SSH-01：部署后端数据库是管理连接的配置/凭据唯一 authority，字段和 revision/CAS 同事务；秘密只写不回读，密钥留在私有后端文件。未知或冲突 schema 历史保留原数据并拒绝写入。
- SSH-02：安装管理员会话同时保护 HTTP 与远端 WebSocket；每帧/回传及过期撤销不能只依赖握手。匿名本机通道拒绝所有 SSH ID；Renderer ID、同源或界面登录投影不冒充授权主体。
- SSH-02 地址策略补充：固定 HTTPS Origin 是默认公开策略；部署 owner 可显式选择不固定地址，但每个管理员会话仍绑定解锁时的 Origin。不同地址独立解锁，不能复用另一 Origin 的会话；HTTP 模式不冒称传输加密，不能因为域名可变而取消凭据、会话或主机身份校验。
- SSH-03：信任绑定端点、会话、指纹和期限；扫描不是认领。服务器/用户身份变更建立新 Server ID，不把旧会话身份重定向到不同机器。
- SSH-04：AppHost 是物理通道 owner；重连屏障先撤销旧认领、完成关闭再准入新认领。显式管理连接通过同一后端通道准入，不伪造 Client、不取得 Thread 或执行权限；建立失败清理资源后仍保留失败状态。设置页不停止远端服务，失联回执不自动重放业务或文件写入。
- SSH-05：Application 只维护后端只读投影，View 只维护当前编辑草稿、单一菜单和行级操作；菜单复用共享 surface/item 契约，不依赖控件内部 DOM 属性定位布局。旧查询、认证失败或取消结果不得复活已锁定连接；暂时无法发现不等于不支持。
- SSH-06：物理连接就绪、逻辑读取就绪与 Thread 交互订阅分开。已认证且 revision 匹配的显式 open 连接允许侧栏通过唯一 registry 取得目录 reader；不能改 autoConnect 偏好、切换聊天目标或 resume/执行 Thread，idle 配置不能擅自拨号。目录读取在连接前、连接后和发布前核对配置有效性与认证代次；锁定、停用、删除、替换及 logout/unlock 不接受旧准入的迟到结果。
- SSH-07：SSH Codex 目录热读在 Runtime 唯一入口使用原生索引，不隐式扫描修复；显式修复仍可覆盖参数，provider/source 默认筛选不变。已准入查询的加载、失败与成功空列表不得合并，停用查询不能冒充加载；失败只重试当前 Host 的读取，不拨号、不选目标、不激活 Thread。失败及物理 connecting/reconnecting/idle/error 保留同配置与授权作用域内的有效缓存和其他 Host 成功行；读取就绪不等于缓存展示资格，展示缓存不准入读取/执行。锁定、停用、删除、配置替换及授权代次变化不显示旧缓存。任务流最近区默认十行之外的已读取远端行通过明确更多入口展示，不冒称全量历史。
- SSH-12：自动连接重试按既有序列递增至 60 秒；只有持续就绪 60 秒才清零，短暂恢复不把频繁断线重置到 500ms。恢复提示遵守已排定退避，手动重试仍即时。瞬时连接状态不删除同授权目录缓存或改变列表身份、次序和几何；自动重试失败保持重连阶段，不反复切换错误/加载呈现。
- SSH-07 呈现补充：侧栏目录加载不渲染转圈、文字或占位行，既有历史的布局和 DOM 身份保持稳定；加载语义通过 `aria-busy` 保留，未完成时不显示成功空列表。目录失败保留对应重试入口；此规则不移除会话正文的加载提示。真实 Sidebar 明暗/鼠标/触屏回归见 `smoke:sidebar-thread-catalog`。
- Sidebar page reveal: Recent retains its ten-row display budget; click, scrolling to the actual scroll boundary (including scrollbar dragging, keyboard navigation and touch momentum), and a downward pull share the same page action. A pull may begin on rows or empty space belonging to the scrollport, while unrelated navigation controls stay excluded. Downward scroll movement advances it; mounting, resizing and background catalog updates alone never auto-drain pages. One held touch reveals at most one page. A React transition replaces the Show more label with the footer spinner and owns its disabled state, without a second fetch owner or artificial delay. Existing rows and scroll position survive expansion, including when the selected row is newly revealed. Pinned paging and product grouping remain independent; exhausted Recent shows a localized end label. Passive document capture resolves the retained Sidebar's current scroll root after Shell dock/drawer reparenting; it excludes unrelated input and respects native vertical scrolling, horizontal Shell gestures and reduced motion. This explicit pagination feedback is the exception to SSH-07's quiet background discovery. Verification: `scripts/smoke/shell/smoke-sidebar-recent-pages.ts` (mouse/touch, light/dark, English/Chinese); browser emulation is not physical iPhone acceptance.
- SSH-08：管理目录恢复属于 Application/controller 生命周期，不依赖设置页挂载。手动重试、在线/可见恢复与周期读取共享单飞；完成后再调度，失败退避有上限，隐页/离线暂停，销毁清理并拒绝晚到回复。授权变更暂停后台读并撤销旧代次；显式操作后的核对不能复用操作前的旧轮询。尚无 SSH profile 时的管理读取失败仍有侧栏重试，不冒充成功空列表；正常后台读取无闪动，不支持/已锁定不冒充错误。读取不隐式连接、重连、切目标或执行 Thread。
- SSH-09：SSH 只拥有传输，不重定义原生 Thread 分页历史；共享 broker 唯一方法准入表同时约束执行、Runtime 与 UI，保留上游无关 metadata。准入不冒充上游实现保证；本机 store 与尚未映射的连接句柄不能被声明成远端能力。读取成功不推出写入能力，偏好不制造 Queue 等能力；跟进按钮和逆向快捷键仅选择可准入动作、不改保存偏好。不可准入提交在草稿/乐观队列收养前拒绝，草稿保留；后台读取也不得发出已拒绝的 queue/watch/search 方法。旧 Server 无声明保持兼容，畸形声明封闭拒绝。

证据/边界见下游产品工作区的 SSH 管理记录（不在本仓库），不以源码声明替代实际准入验收。

状态：实施及验证中。下表记录目标与责任，不把测试名称当成已运行的证据。最新结果在 [progress.md](../progress.md)。

### 设置中的执行端归属

- 应用设置与执行端设置分别组织；已配置且启用的 Host 按独立身份呈现，同一物理地址不得合并逻辑 Host。
- SettingsPage 的 `targetHostId` 声明固定配置 owner。导航、概览、页面身份和传给 View 的 Host context 使用同一目标，不借用当前聊天 Host。未配置/已停用 owner 不挂载配置 View。
- Web 的 `local` 表示执行服务所在机器，不表示浏览器设备；呈现优先使用配置的 executionLocation，缺失时显示服务器端运行。状态只投影对应 Host runtime，不由页面制造连接。
- 执行端概览与配置入口走既有应用 Router，不改变聊天 Host，不新增服务器创建/编辑流程。主从页保持自身滚动，身份头由 Settings Shell 持有。
- Web 启动按 Host ID 补齐部署声明但尚未保存的连接；已有连接的地址、名称、停用与可见性偏好不被部署默认值覆盖。Codex 账户只有读取成功且为空时显示无账户，读取失败原位报错并允许刷新，不引导重新绑定。

- 验证：`tests/shell/settings-machines.test.tsx`、`tests/shell/settings-machine-navigation.test.ts` 检查当前机器入口、一级插件页面、高亮、PUSH/POP 与返回；`tests/extensions/extension-runtime.test.ts` 验证固定 owner 与无效 owner 原子拒绝。2026-10-12 已验证真实 Web 直连执行端及当前源码 Linux Electron 隔离 profile；macOS 桌面尚未实机验证。

- 执行端名称、位置和状态灯组成一个语义 button，点击名称行打开该 Host 概览；不再增加“概览”子项。概览只高亮名称行，配置页只高亮对应子项；所有入口继续使用同一 Router 路由，保留旧概览链接与 POP 恢复。

### 运行在（Work in）与机器分组

- 以下可选运行位置适用于完整工作台。嵌入的 WorkbenchPresentationPolicy 固定执行目标，关闭机器管理与 runtime Host 配置；不显示 Work in/Agent/机器设置，并在 action 边界拒绝选择、配置和 retarget 写入。固定 Profile 的观测只在 Application 内存，不能打开 standalone Host catalog。
- 机器分组只由 daemon 上报的 machineId 决定，不按 URL、域名、名称或 hostKind 推断；分组只影响呈现，不改变 Host 与 `(hostId, threadId)` 身份。机器显示名可由部署 `--machine-name` 设置，改名不改变 machineId。
- 运行位置和机器设置优先展示部署自有 local/durable 执行端 机器，其后为 SSH、WebSocket 等外部连接，最后为云资源；各层保持原有相对顺序。排序不依赖显示名、连接状态或选中项，不改分组与选择偏好。
- 读取机器身份不初始化引擎；未连接 Agent 的模型目录只在用户打开模型菜单时加载，加载与失败在菜单内原位反馈。
- 新的机器、Agent、项目选择撤销旧准备；晚到结果不得覆盖较新的意图。切换机器或 Agent 只读：目录在目标 Host 存在才保留，不创建项目记录。
- 切换运行位置保留草稿内容；暂不可用的附件原位标注，不静默删除。
- Web 不显示「这台…」；只有桌面端本机 daemon 所在机器显示「这台 Mac / 这台电脑」。云端资源生命周期与连接状态分开呈现。
- 设置的「运行 › 机器」使用同一 `groupWorkInMachines` / `workInMachineName` 投影：一台机器一行，未知身份 Host 独立成行，云端独立成组。机器内按 Agent 呈现目标 Host 的设置与连接，不在侧栏重复列 Host；旧 `execution-<hostId>` 以及身份晚到前的未知机器路由由 Router REPLACE 纠正。「运行」分组依次提供一级入口「模型服务」「Codex 账户」「机器」；前两项直达现有固定 targetHostId 的插件页，仅高亮对应入口，并以「用于」标签呈现机器归属。机器内入口与返回机器行为保留；idle 表示尚未启动，连接地址单行省略并提供完整 title。模型服务与 Codex 账户仍归各自 Host，不提供服务端统一中转或多机器选择器。
- 验证：`tests/shell/settings-machines.test.tsx`、`tests/shell/settings-machine-navigation.test.ts`、`tests/work-in-*.test.ts`、`tests/execution/opencraft-daemon.test.ts`；Web 与 Linux Electron 实测，macOS 窗口、真实多机器与下游产品云端链路尚未实测。

### 服务器更新范围与任务连续性

- 更新页消费部署状态声明；仅显式配置并接通受管执行端时呈现「更新网站和执行服务」，普通网站保持原更新范围。本地源码与 npm 只在归档获取上不同，共用一个安装事务和持久化版本权威。执行版本来自实际网关健康响应，目标版本由执行指针持有，不能用网站目标版本冒充执行结果。
- 下载/启动失败不提交新网站；执行切换失败恢复旧执行版本，回退失败原位呈现真实状态。异步更新不强制刷新页面，操作不修改其他设置 draft。
- 执行升级仅覆盖网关、daemon 与 capability adapter。Codex core/CLI 和 DSH 引擎独立维护；Codex 原 turn 经重连恢复，OpenCraft 活动任务可能中断，界面明确说明。
- 验证入口：`test:server-updates`、`smoke:server-updates`、`smoke:server-updates:systemd` 和既有 `test:web-updates:e2e`。隔离真实 CLI/打包 gateway/生产 SPA 验证不等于线上迁移或发布完成。

## Installed plugins in Settings

Web/Electron Settings expose Plugins without internal developer mode. Settings
and the Skills extension tab render the same application-owned catalog, combining
Supervisor runtime records, Manager installations and registered contributions.
Built-in, disabled and failed entries remain visible; opening Settings never
activates a plugin. Only Manager-owned entries expose enable/disable; critical
built-ins remain protected. URL installation retains its developer-only audience.
Hostless and connected workbenches consume the same runtime owners.

Panel chrome uses one paired outline glyph contract (`SidebarToggleIcon`): visibility changes the divider geometry rather than adding a chevron. Right panel chrome mirrors that pair within a fixed optical slot, retaining an opacity-only cross-fade without translation or scaling. The Header end-slot reservation is capped by its own context width: full-viewport panel geometry must never push the persistent trailing action beyond the viewport during expansion or reversal. Both entrances consume the neutral `chrome-button` foreground and transparent surface, without an independent selected background. Hover feedback requires a fine hovering pointer; touch feedback lasts only while pressed.

Collapsed sidebar entrance ownership follows requested visibility, independently of the floating drawer's retained exit/gesture presence. Closing restores the persistent Header control in the same render while the existing drawer exit animation and content lifetime finish normally.

Touch unified Shell keeps one persistent sidebar action and its measured Header slot across open/close. The same button node is projected into fixed chrome above drawer motion and below dialogs; drawer/rail copies are hidden and drawer branding reserves its leading space. The installation density preference selects this presentation at any viewport width, with compact ownership unchanged. Closing intent remains separate from retained animation presence.

- Schedule permission controls consume the Host-verified profile catalog. Saving preserves the explicit selection, and occurrence admission uses its durable snapshot across restart. Legacy schedules retain defaults; Full access is an explicit user choice.
- Conversation schedules are created only from a confirmed existing conversation's action menu, and appear only with explicit Host scheduling capability. Closing the View does not own the schedule lifetime. Edits keep their captured revision/draft during polling; mutation errors use the shared non-blocking notice owner. Pause/delete do not pretend to cancel already-admitted execution. Desktop and touch consume the same schedule protocol and existing adaptive Modal/Settings primitives.

Panel toolbar creation contributions (those carrying `creationLabel`) are available in creation/tab menus and the empty-panel launcher, without duplicate kind buttons on the bar. Non-creation toolbar actions and the fixed new-tab/tab-list slots retain their ownership on desktop and touch layouts.

实时文件变更数字的裁切框、每格高度和滚动位移共用继承行高，不能用字号裁切较高的行盒；连续更新、位数变化和隐藏再显示都收敛到完整可读的当前值。保留tabular数字、原始计数与减少动态效果。证据：`scripts/smoke/conversation/smoke-turn-diff-counter.ts`（真实字形范围及旧几何负例）。

Touch Header panel entrances use one shared outer-edge spacing token (2px), bounded by host safe-area insets. Their 44px targets remain intact; wide touch chrome retains its stationary sidebar placeholder, while narrow mobile chrome moves with the foreground page and drawer branding occupies its own leading slot. Compact/native chrome keeps its existing padding.

- Conversation list schedule markers consume the Host schedule summary rather than issuing row-owned reads. Active/paused use one neutral 16px clock after the truncating title and before participant chrome, with no animation, extra row height or independent touch target. The tooltip/accessibility label conveys next-run, paused or needs-checking state. Execution activity retains its separate owner and slot; configuring a plan never changes a conversation’s section; running is row feedback, not a section.

## Hub network settings

- The server owns the persisted node identity, policy, peer credentials, routes and
  audit. Settings holds an editable draft separately from the last confirmed
  snapshot; polling and failed reads never overwrite an unsaved draft.
- Only a core instance administrator may read or mutate this installation's node
  configuration. Losing that role clears the settings snapshot and invitation
  material. Network enrollment never creates a member or administrator.
- Inspecting an invitation precedes connection; accepting an identity issuer is
  explicit and distinct from accepting transport. Invitations are shown once and
  removed from UI memory when closed or their authority is lost.
- Revision conflicts refresh confirmed state and require an explicit retry of the
  user's change. No command automatically replays after a lost response. Peer
  status and route paths reflect live server state, not optimistic connected UI.
- The same Hub can connect outward and accept connections. Transit is explicit;
  an outgoing-only configuration does not imply an externally reachable listener.

### Relay server selection in Settings

Automatic root entry resolves its remembered/default destination before presenting
server choices. Successful automatic entry does not flash the chooser; unresolved
or unavailable targets and explicit switch requests keep the usable chooser.
URL authority, identity-scoped successful-entry memory and target admission remain
unchanged; JavaScript-disabled browsers retain the server links.

Relayed Web clients expose current deployment and Switch server under Settings →
Servers, including narrow layouts. Shell application/account navigation does not
duplicate it. Presence comes from validated browser deployment context, not an
administrator role or the Headless administration build flag. Direct deployments
without that context do not show an unsupported switch. Navigation uses the
context selector path, including legacy deployments; target admission, remembered
choice and per-tab execution ownership remain authoritative at their existing
owners. Changing pages does not stop execution.


## Account display identity

Codex account rows, details, action labels, confirmations and error text share
`maskAccountDisplayIdentity`. Keep the final two Unicode characters of the mailbox
local part visible (all available characters for shorter names). Keep its first
character only when more than three characters exist; mask the middle and retain
the existing private-domain masking. Presentation never changes Host identity or
credentials. The existing Codex reset-credit smoke covers these consumers.

Account menus hand modal input ownership to their confirmation or login dialog.
Cancelling a dialog must release its pointer lock so account actions remain
clickable; the menu retains Radix focus, keyboard and dismissal semantics.
