# 工作区不变量

## Native conversation pinning

- PIN-01：置顶由原生 Server 持久化；OpenCraft 不维护第二份数据库或浏览器置顶集合，DSH 不支持时不补本地 fallback。
- PIN-02：接口准入不等于原生能力。当前连接成功发现支持后才显示置顶菜单；暂时失败不冒充不支持或空置顶列表。
- PIN-03：置顶读写只处理元数据，不 Resume/Start；Hermes 明确携带所属 profile，身份歧义拒绝写入，压缩链由 Hermes 自身处理。
- PIN-04：置顶目录返回完整摘要、独立于近期窗口；侧栏去重后单独分组，置顶不占十条近期预算。刷新/重连从后端重新读取。
- PIN-05：同一会话写入串行；操作前列表不能覆盖操作后状态；连接撤销拒绝晚到结果且不重放写入。菜单复用现有受控互斥 owner，不拥有存储或轮询。
- PIN-06：LightVela 站点的外层会话侧栏只消费嵌入式 Workbench 投影的置顶状态、能力和动作；置顶会话不占近期分页名额，站点不持久化第二份置顶集合。

## Desktop input ownership

Desktop control presentation preserves the mounted control strip's geometry
while hiding and making it inert before current video/input readiness. Confirmed
ownership fades the shared action's solid decorative layer over 240ms; intent,
press feedback and reduced motion do not delay input retirement or cancel.

The mounted desktop interaction scope, confirmed backend grant and physical
gesture have separate lifetimes. Unknown mobile focusout does not prove leaving:
internal toolbar/media/editable handoff retains control; explicit outside presses
(including blank space), known outside focus, hidden page and window blur retire
it. The interaction owner never grants input or restores focus. Geometry changes
retire held input and queued samples without revoking the grant; old physical
contacts must lift before another gesture can start in the new geometry.
Managed-media native touch activation consumes a fixed Take command once on
single-finger tap release; movement, second contact, cancellation and capture
loss cancel it. It never emits a synthetic click or replays a compatibility
click. Ordinary toolbar buttons retain native click/keyboard activation.

Desktop visor shoulder masks preserve their exterior curve and world-space
origin while extending only the interior fill into the center background.
Independent raster edges must have opaque overlap, not a butt joint; moving
the entire shoulder to conceal a seam is not equivalent. Mobile and wide
container variants share this contract. Pixel regression distinguishes ordinary
rendering from simulated background-edge retraction; neither proves iOS Safari.

WSP-36 桌面输入补充：手势与坐标仅由媒体适配层一个owner写入，decoder显式关闭
原指针输出。观看缩放/平移不等于远端操作；捏合始终调整本地画面，只有确认授权
后单指点击/拖动与双指滚动才发远端输入。滚轮和触控滚动共用有界规则，双指按
同一帧采样，防止先后到达的事件造成错误分类。停止、失焦、新授权取消未消费帧、
按键和滚动；旧物理指针须抬起才可被后继授权消费。缩放后坐标从实际画面与留白
计算，不能拿Shell宽度当远端像素。手机文字入口在显式操作及确认授权下创建，
候选词不发送，确认一次发送一次；撤权销毁该DOM而非复用给下一次输入。
Take在用户激活时先取得媒体焦点而不提前启用输入；平台只读焦点归属在请求与确认
两端检查，迟到授权不得再次聚焦。文字事务短于控制授权：远端点击/拖动/粘贴前先
将焦点在Panel内交接，平台同步确认的组词先发到原目标；其余候选随原事务退休。
旧输入DOM不得在同授权下后继输入复活；交接中撤权/换代也不得发送原指针按下。
Surface消费Shell的同一逻辑active投影：隐藏立即退出模拟光标覆盖层及监听，不能
等待触屏不保证的mouseleave；隐藏中迟到光标形状只更新媒体状态，不能复活覆盖层。
本地控制光标资格复用输入授权投影与active，不另存控制开关；观看/申请中不挂载。
停止、撤权或失焦立即移除覆盖层与监听，并恢复普通鼠标；迟到形状或mouseover不得复活。
重新展开保留媒体连接但不抢焦点或恢复控制；只有新确认授权才挂载最新形状。
此规则不清除远端画面内已有的光标像素；重复启用不能清空仍有效的光标附件。
模型/真实decoder浏览器验收不等于iPhone系统键盘或原生执行器验收，详见
[桌面输入策略](../docs/cloud-desktop-plugin.md#pointer-viewing-gestures-and-mobile-text-input)。

## SSH connection management

- SSH-01：部署后端数据库是管理连接的配置/凭据唯一 authority，字段和 revision/CAS 同事务；秘密只写不回读，密钥留在私有后端文件。未知或冲突 schema 历史保留原数据并拒绝写入。
- SSH-02：安装管理员会话同时保护 HTTP 与远端 WebSocket；每帧/回传及过期撤销不能只依赖握手。匿名本机通道拒绝所有 SSH ID；Renderer ID、同源或界面登录投影不冒充授权主体。
- SSH-02 地址策略补充：固定 HTTPS Origin 是默认公开策略；部署 owner 可显式选择不固定地址，但每个管理员会话仍绑定解锁时的 Origin。不同地址独立解锁，不能复用另一 Origin 的会话；HTTP 模式不冒称传输加密，不能因为域名可变而取消凭据、会话或主机身份校验。
- SSH-03：信任绑定端点、会话、指纹和期限；扫描不是认领。服务器/用户身份变更建立新 Server ID，不把旧会话身份重定向到不同机器。
- SSH-04：AppHost 是物理通道 owner；重连屏障先撤销旧认领、完成关闭再准入新认领。显式管理连接通过同一后端通道准入，不伪造 Client、不取得 Thread 或执行权限；建立失败清理资源后仍保留失败状态。设置页不停止远端服务，失联回执不自动重放业务或文件写入。
- SSH-05：Application 只维护后端只读投影，View 只维护当前编辑草稿、单一菜单和行级操作；菜单复用共享 surface/item 契约，不依赖控件内部 DOM 属性定位布局。旧查询、认证失败或取消结果不得复活已锁定连接；暂时无法发现不等于不支持。
- SSH-06：物理连接就绪、逻辑读取就绪与 Thread 交互订阅分开。已认证且 revision 匹配的显式 open 连接允许侧栏通过唯一 registry 取得目录 reader；不能改 autoConnect 偏好、切换聊天目标或 resume/执行 Thread，idle 配置不能擅自拨号。目录读取在连接前、连接后和发布前核对配置有效性与认证代次；锁定、停用、删除、替换及 logout/unlock 不接受旧准入的迟到结果。
- SSH-07：SSH Codex 目录热读在 Runtime 唯一入口使用原生索引，不隐式扫描修复；显式修复仍可覆盖参数，provider/source 默认筛选不变。已准入查询的加载、失败与成功空列表不得合并，停用查询不能冒充加载；失败只重试当前 Host 的读取，不拨号、不选目标、不激活 Thread。失败保留有效缓存和其他 Host 成功行，撤销准入不显示缓存。默认十行之外的已读取远端行通过明确更多入口展示，不冒称全量历史。
- SSH-07 呈现补充：侧栏目录加载不渲染转圈、文字或占位行，既有历史的布局和 DOM 身份保持稳定；加载语义通过 `aria-busy` 保留，未完成时不显示成功空列表。目录失败保留对应重试入口；此规则不移除会话正文的加载提示。真实 Sidebar 明暗/鼠标/触屏回归见 `smoke:sidebar-thread-catalog`。
- SSH-08：管理目录恢复属于 Application/controller 生命周期，不依赖设置页挂载。手动重试、在线/可见恢复与周期读取共享单飞；完成后再调度，失败退避有上限，隐页/离线暂停，销毁清理并拒绝晚到回复。授权变更暂停后台读并撤销旧代次；显式操作后的核对不能复用操作前的旧轮询。尚无 SSH profile 时的管理读取失败仍有侧栏重试，不冒充成功空列表；正常后台读取无闪动，不支持/已锁定不冒充错误。读取不隐式连接、重连、切目标或执行 Thread。
- SSH-09：SSH 只拥有传输，不重定义原生 Thread 分页历史；共享 broker 唯一方法准入表同时约束执行、Runtime 与 UI，保留上游无关 metadata。准入不冒充上游实现保证；本机 store 与尚未映射的连接句柄不能被声明成远端能力。读取成功不推出写入能力，偏好不制造 Queue 等能力；跟进按钮和逆向快捷键仅选择可准入动作、不改保存偏好。不可准入提交在草稿/乐观队列收养前拒绝，草稿保留；后台读取也不得发出已拒绝的 queue/watch/search 方法。旧 Server 无声明保持兼容，畸形声明封闭拒绝。

证据/边界见 [SSH 管理 Task Pack](../../docs/context/tasks/2026-10-05-opencraft-ssh-management.md)，不以源码声明替代实际准入验收。

状态：实施及验证中。下表记录目标与责任，不把测试名称当成已运行的证据。最新结果在 [progress.md](progress.md)。

## Application navigation restoration

任务草稿保留：Application 级输入槽拥有原 Controller、File、预览与处理任务，View 只借用。20 个非活动页面的缓存淘汰不得删除非空输入；输入槽按 50 份非空草稿单独执行 LRU，空输入不计数，淘汰同时丢弃持久文档并释放附件资源。正在编辑或发送的所有者不可淘汰；全部受保护时拒绝新内容，不超限。侧栏完整 A→B→A 回到最后成功呈现的槽位，显式新 View 与 POP 仍独立。Scope promotion 必须更新无页面但仍保留的草稿；账号撤销清除全部槽位与目标缓存。验证：`test:task-draft-switching`、`smoke:task-draft-switching`。

浏览器草稿补充：任务输入槽由 ConversationDraftOwnerRegistry 保留，ConversationDraftContinuity 仍是唯一文档持久化写入者，不叠加另一套持久化写入者。Bot Composer 通过平台存储端口保存 document、context 与附件元数据，不保存提交回执、执行状态、临时听写或发送锁；存储按产品／账号和 Host + Conversation 身份隔离。只有显式内容编辑和接受发送后的清空写入存储，生命周期变化与卸载不能覆盖其他 View 的输入。账号作用域变化撤销并清除旧适配器，迟到写入不得复活旧内容；新应用实例绑定新账号。浏览器 File 字节及临时侧聊不在当前持久化承诺内；失效 Object URL 或未完成附件恢复为可移除、不可发送的文件卡片。验证见 `chat-browser-drafts.test.ts` 和 `smoke:browser-drafts`。

排队跟进的发送前失败记录由 Conversation Runtime 本地持有，尚无 Server 队列 ID；用户删除只撤销该本地记录，不请求 Host 队列删除，也不自动重发。提交中的记录不可删除，已确认入队的消息仍以 Server 队列 ID 删除。

历史记录只持有聊天引用，不拥有草稿的存活事实。启动与历史恢复必须先由 Host 配置、ScopeRegistry 和 BindingStore 校验/规范化，再让 Router 与激活层消费同一个目标；有效当前 entry 优先于跨标签页共享的最后使用偏好。失效 Draft 不按旧 ID 重建，已提交 Draft 经持久 alias 找回 Thread。Router 唯一写回纠正结果并保留 Settings/Extension 目的地；失效引用回到当前实际保留的 View 与输入，View 不能跨 Scope 复用。规范化为 REPLACE 的 POP 仍须被资源事务消费。

返回同一个保留 View 不依赖远端就绪：Chat、当前会话入口与 POP 共用本地呈现/后台续接语义，晚到结果受导航代次和释放约束；提交中的草稿仍拥有导航。侧栏只表达 `selectConversation`，不自行解释活动 Thread、pending 或设置页返回；重复目标合并、保留 View 复用与可见项早退都由导航事务决定。显式 `navigate` 不等于选择，不能按 Thread ID 合并独立历史 View 的输入。后台草稿准备、返回、POP 与提交转换共享 intent/释放/Router revision 资格及接受或释放路径；非活动草稿不得获得当前导航权。嵌入式 memory Router 不读写外层页面历史。责任与入口见 [Application Router authority](../docs/platform-architecture.md#application-router-authority)、`workbench-location-restoration`；验证使用 `test:application-route-restoration` 与 `smoke:application-route-restoration`，不将隔离 Host 替身验收冒充手机或完整账号启动实测。

## 工作区契约

| ID | 不变量 | 责任/验证 |
|---|---|---|
| WSP-36 | 云桌面标签属于 Conversation；短期观看连接属于桌面显式常驻视图；远端桌面与独占输入授权属于后端。隐藏/切换工具保留观看但立即撤销输入，关闭标签或更换 owner 回收观看，不影响 Agent；其他插件不隐式常驻。观看续期必须双端声明能力、后端重验身份并匹配确认，不能删除到期门禁、复用票据或重新接管。未接通真实适配器不发布入口；观看默认无输入，两项就绪与有效授权缺一不可，握手不能冒充首帧；关闭、换账户、取消后迟到结果只释放，不复活连接。自动恢复仅限 adapter 声明安全的新观看授权与已分类传输中断，有限退避，不继承控制权、不重放资源创建。反馈不替换媒体宿主；申请立即投影可用的停止意图，授权确认前仍不绑定输入。View 捕获一次原生激活的固定动作，controller 按连接/控制意图代次消费一次；失焦不能把停止 click 翻成接管，旧动作不能撤销后继授权。不补发 pointerup 点击、不延时撤销；剪贴板仅显式手势读取、按原 grant 失效；物理能力与输入授权分开，不支持粘贴不画无效入口。设计系统拥有空态/进度/紧凑控件尺度，短状态及本征槽位保持相邻几何稳定 | cloud-desktop / DesktopViewController；Host-wire-controller 跨期限组合、真实 socket 授权复核、React 与主题/窄屏 Shell 验证；本轮媒体/输入外部边界合成，公网授权和手机实机/弱网未验收 |
| WSP-01 | 同一主会话只有一个可交互主 Composer；普通/工具展开分支互斥，Side Chat 不叠加父输入 | ThreadComposerPresentation；Web smoke |
| WSP-02 | 显示位置不改变草稿/附件/提交目标；Host 相同裸 threadId 不得碰撞 | composer-core + ConversationScope；既有 composer/binding 测试及新 smoke |
| WSP-03 | 兼容恢复旧标签时不调用关闭资源；MRU/active 有效 | panel reducer/service；workbench-workspace-presentation.test.ts |
| WSP-04 | 重开/刷新不重复创建同一资源；旧 bottom 状态归回 right | WorkbenchPanelService + restoreRightPanelTabs；同上 |
| WSP-05 | 显隐、卸载、显式关闭各有语义；隐藏后入口可达 | AppShell/Panel type；Web smoke、browser/terminal 单测 |
| WSP-06 | Portal 位置消费当前 Shell 矩形，背景鼠标可达；不能逃出主题/模态层级 | Shell anchor + design-system layer；主题/缩放/拖动 smoke |
| WSP-07 | Side Chat 是源 Host 上独立 ephemeral fork 和独立 controller，不导航父任务 | SideChatService；聚焦单测 + 支持 Host 集成待验证 |
| WSP-08 | 已取消/已退出的 fork 结果不能重新挂载；释放原运行时订阅，不新建连接清理 | SideChatService 代次检查；聚焦单测 |
| WSP-09 | Side Chat 关闭确认绑定准确 owner/tab；取消确认不影响任务 | Shell ModalRequest；UI smoke 待验证 |
| WSP-10 | Browser 物理 slot 使用实际 region/visibility；旧 lease 不覆盖新 slot | BrowserPresentationCoordinator；迁移 smoke 待验证 |
| WSP-11 | 右侧/侧栏拖动实时改变几何；显隐 target、progress、mounted 分离。浮动侧栏与外侧命中层由 AppShell 共同 Portal 到 body 级覆盖宿主，成为窄屏唯一交互前景，盖过独立 Browser Surface portal；关闭时直到退出动画结束，其内容 Portal、导航投影与外侧命中层仍归浮动呈现所有，首次外侧触摸只关闭侧栏、不点穿浏览器或正文。右面板状态不因遮盖而重建，侧栏关闭后恢复呈现 | usePanelAnimation、FloatingLeftPanel、AppShell、BrowserPresentation；侧栏模型/真实组件帧采样及手机触摸验证 |
| WSP-12 | Thread 菜单与 Side Chat 只消费版本匹配、显式声明的 Host 生命周期能力；菜单 Fork 仅需 fork，Side Chat 须同时声明 fork/ephemeral/injectItems/unsubscribe。不支持时明确失败，不用空会话模拟或删除父历史。菜单 Fork 等待 Host 回执时有可见状态，收到 child ID 后不等待目录刷新即可打开；若用户已切换 route scope，迟到结果不得抢回导航 | 协议能力解析、Workbench 门控、forkAndOpenThread；Codex/DSH 真实 Host 与负例验证 |
| WSP-13 | ephemeral fork 返回结果是 baseline，不请求持久 Resume/queue；旧连接代次不能被采用 | Session.adoptFork + HostRuntime；appserver-session.test.ts 与 smoke-side-chat-appserver.ts |
| WSP-14 | 当前产品没有下方面板、移动到下方/Show bottom panel 入口或底部占位；旧标签无损归回右侧 | AppShell/RightPanel、restoreRightPanelTabs；类型、聚焦测试、Web/native smoke |
| WSP-15 | 账号登录或零云端 Bot 不接管本机/其他 Host 工作区；创建仅来自主动环境操作；只有选中 Host 的真实连接错误可请求干预 | App connectionIntervention、LightVela contribution；匿名/已登录零 Bot 回归 |
| WSP-16 | Skills 与 Cloud Storage 可作为 Workbench 侧栏中的 LightVela 独立路由；它们与 Start 消费同一导航行高度、leading slot、文字轴与分组间距，不显示额外的 “Work” 标题。导航只选择既有贡献页，不能创建/切换 Host、Bot 或会话 | LightVela Work navigation；聚焦路由/几何测试与 Web/Electron 验收 |
| WSP-17 | AppShell 窗口 chrome、原生拖拽区和侧栏 resize owner 跨路由常驻；独立管理页只替换内容区，不得通过 `header=null` 改变物理窗口结构 | AppShell/AppShellHeader；Skills、Cloud Storage 路由测试与桌面 held-drag 验收 |
| WSP-18 | `New chat` 是回到 Home 的本地导航事务，不是远端 Thread 创建：Draft、conversation application route 与 View 同步提交，Host/Workspace 在页面可见后异步准备；失败留在 Home 原位反馈，不得继续显示 Skills/Settings | `navigateToHome`、WorkbenchNavigationTransaction、Coordinator；慢/失败 Host 单测与桌面 Skills→New chat 验收 |
| WSP-19 | 扩展页面由 contribution 声明 `document/master-detail/edge-to-edge` 布局，Settings Shell 只解释一次；`edge-to-edge` 只移除 document inset，Shell viewport 仍是唯一纵向 scroll owner，只有 `master-detail` 将滚动下放内部 panes。Skills 的 catalog toolbar 不叠加 padding，安装目标与 tabs 同行 | SettingsPageContribution、SettingsContent、Hermes Skills；布局契约、Electron scrollHeight/scrollTop 与 Skills→Storage 验收 |
| WSP-20 | 路由可向持久 AppShell 注册 Header region，但不拥有物理标题栏；注册按 route scope + owner 清理，平台 portal 保留原组件 Context。Skills tabs/安装目标在 Header，搜索与目录留在 Content；切路由不能残留旧 Header | AppShellRouteHeaderRegion、PlatformViewRegions；Radix Context 回归、Skills→Storage 桌面验收 |
| WSP-21 | Terminal visual inset 与无 padding measurement host 分离；终端排版边界隔离正文 tracking/word-spacing/text-transform，字体与网格间距由 xterm 拥有，不覆盖其内部行补偿。测量、绘制、光标和 PTY 使用一致的 cell 度量，累计位置误差不能随列数增长；不仅 screen ≤ host，满行字符推进与末列光标也必须位于 screen 内（允许像素舍入容差）。字体/主题/zoom/隐藏后重显使旧网格失效；PTY resize 只发布变化后的最终 cols/rows | TerminalPanel、FitAddon、AppServerTerminalSession；真实字符 Range/光标边界、负/正正文 tracking、长 ASCII/宽字符、双向 resize、字体加载、隐藏重显与 PTY `stty size` 验收 |
| WSP-22 | Host 是 PTY/process 唯一 owner；Application 按 Conversation Scope 维护有序 terminal session 集合和最近激活项。Panel tab 只投影/更新 active session，切换到非 Terminal tab 不清空最近项。Agent 的 `read_thread_terminal` 仅通过调用 Host + Thread 的 binding 读取该 Scope 当前终端的有界输出，不接受 session ID、不枚举或跨会话读取 | ConversationTerminalSessionRegistry、ConversationBindingStore、Terminal Panel plugin、dynamic tool handler；多终端激活/关闭回退、Panel owner 与 resource owner 分离、非法参数/Host+Thread 隔离、UTF-8/截断测试 |
| WSP-22 | 导航 hover 与当前路由是不同状态：Theme Engine 定义统一 `navigation-hover/current/pressed` token，Design System `navigation-control` 解释 `aria-current="page"`/selected；Sidebar、Work、Settings 与平台 Shell 不得自定义停留背景 | Theme Engine/controls.web；明暗主题 token 测试、Skills↔Storage Electron computed-style 验收 |
| WSP-23 | Embedded Workbench 只拥有宿主右侧画布；外层 Sidebar、Explore/Chat 路由与 History 归宿主。嵌入 Composer 在 ready/show 前只读，hide 先撤销写 lease 但保留 Application、会话与 Panel；Host 侧仅消费 session snapshot/action，不复制会话真源 | EmbeddedWorkbenchElement、EmbeddedChatWriteAuthority、transient ConversationBinding；双跑/fallback 单测、真实 LightVela 页面与 Browser/Terminal Panel 验收 |
| WSP-24 | Sidebar Activity 由 Thread 规范 recency 排序并按本地日期分组；稳定来源是 `serverOrigin.serverId`，Hub route、tenant、Host placement 与 Thread 状态正交。Server 来源只决定稳定颜色，当前 route locality 仅决定默认本机是否隐藏；换路由或改名不换色。来源和状态各占固定尾部槽位，pending/status/menu 不得推动正文几何。触控与桌面共用同一 Activity 组件、状态与 Design System token，不分叉业务语义；仅瞬时 hover 与菜单命中区按当前输入能力适配。Activity 主行独占 hover/选中底色，“…”入口背景透明，指针移到入口时行 hover 不断开；文档级当前输入信号令触控滚动不产生鼠标 hover 底色。无 hover 或当前触摸输入时，独立“…”入口直接可见、有足够命中区，并为来源/状态槽位预留空间；鼠标 hover、键盘焦点和选中态各自独立 | client-hub-server.ts、MultiHost compatibility projection、SidebarActivityItem/ThreadRowMenu、同 Server 跨 Hub route/改名/状态正交测试、触控/鼠标浏览器验收与真实 Electron 窄侧栏验收 |
| WSP-25 | Web/Electron Sidebar 展开时由其 Start 独占新任务入口；收起时 persistent titlebar 在 Sidebar toggle 后注册 Write，并复用 `navigateToHome`。浏览器标题栏不再保留独立 Vela/Home 按钮；transient/floating Header 不复制 Write。动态 action 必须进入 Header rail 测量和 macOS safe area | AppShellNavigationControls、window-chrome；展开/收起、persistent/transient、首帧宽度、真实浏览器和 Electron 点击验收 |
| WSP-26 | Right Panel 显隐与宽度模式正交：全局 Header toggle 唯一负责开关；Panel toolbar 只负责用户显式 maximize/restore。空间不足导致 auto-full-width 时不得重复 `Back to chat` 或呈现无效 restore 动作 | AppShell、ShellPresentation、RightPanel；auto/explicit full-width 源码契约与 Electron 窄窗验收 |
| WSP-27 | Frost 是独立 Theme ID，Light/Dark/System 与其正交；浅色 Sidebar material 固定为 `rgb(226 244 250 / 35%)`，不得引用或动态推导 Codex 70% material | theme-engine、appearance-theme；主题目录、持久化、CSS token 与真实 Electron computed-style 验收 |
| WSP-28 | Lavender 是独立 Theme ID，以 LightVela frontend 的低饱和紫色语汇投影完整 window/sidebar/panel/input/popover 表面；只改变主题色与材质，不复制组件 CSS 或改变字体、密度、圆角和布局 | theme-engine、appearance-theme；浅深色 semantic token、主题目录、持久化与真实 Electron 验收 |
| WSP-29 | Conversation 可见恢复与执行 capability readiness 分离：`thread/resume` 和首屏历史完成即可退出全页 Restoring；动态工具/Connector 注册按 Thread + client generation 单 flight 预热，不得占住历史 authority。任何执行型 mutation 必须等待同一 capability lease；预热失败可在执行时重试，但不能清空或降级已恢复历史 | AppServerWorkbenchRuntime binding、Local Host capability broker；悬挂/失败注册、历史先呈现、发送门禁与重试测试 |
| WSP-30 | DSH engine plugin 的 capability register/unregister/release 按 native session 串行、跨 session 并行；两个相同并发注册必须幂等，不得各自创建 scope/Skill 后以重复工具 400 失败。Bridge 非 2xx 只回传插件生成的有界单行错误摘要，不回显 token 或请求 payload | DshCapabilityLink/plugin；真实 loader 完整 Workbench capability 并发注册与错误摘要测试 |
| WSP-31 | Electron 主窗口与 Renderer Shell 消费同一 `workbenchWindowMetrics.minimumWidth=480`；达到下限时进入 immersive fallback，临时隐藏 navigation/context/right，不改写保存的开关、Pin 或宽度。业务内容最大宽度不得反向成为原生窗口下限 | shell-space、Electron Main；320/480 几何矩阵、480px 真实 Electron Header/Composer/Settings/Skills/Panel 验收 |
| WSP-32 | 目录选择只消费当前 Server 的 browse root 与目录读取；选择器保留暂态路径/加载/错误，读取失败须清旧条目并禁用确认，Project 创建和 Draft 绑定仍归 Application。ModalSurface 与共享 Button 拥有焦点、按钮语义状态和主题前景/背景，不允许业务 CSS 推导反色或复制主按钮；浅深及扩展主题下启用/禁用/处理中/焦点均须可读 | WorkspaceDirectoryPicker、AppServer file/project port、Button/ModalSurface；目录模型与真实 Web computed-style/键盘/长路径验证 |
| WSP-33 | Web 文档唯一记录当前触摸/笔或真实鼠标输入；媒体 hover 能力不能代替当前输入。共享 quiet/navigation/menu/Settings 控件只在细指针且非触摸输入时显示瞬时 hover，键盘 `focus-visible` 与选中/菜单打开状态独立；粗指针 Settings 操作与菜单命中区至少 44px。Codex 账户行滚动不粘 hover，独立操作入口触控可见。所有主题只替换语义色，不复制交互规则；未迁移的功能局部 hover 不得声称全控件已验收 | pointer-modality、controls.web/menu.web、Settings/Codex Account、Activity；状态单测、Web CSS 构建、触屏/鼠标与明暗扩展主题真实呈现待验收 |
| WSP-34 | 面板插件注册标签不自动取得右侧标签栏图标；`icon` 仅指定图标语义，`showTabIcon: true` 才在标签栏及其切换列表显示。插件恢复的标签必须保留同一声明；缺失声明不画默认图标 | PanelTabDescriptor、RightPanel、各面板插件；类型检查、面板聚焦测试与 Web 呈现待验收 |
| WSP-35 | Conversation 活动折叠标题统一为“原生按钮覆盖独立呈现内容”：按钮拥有鼠标、触控和键盘激活，`aria-labelledby` 指向可见标题，内容层不接管指针；无可展开内容时不渲染按钮。`Worked for`、普通活动项和分组各自保留展开状态与动画 owner。触控设备上的 Worked-for 助手消息操作栏必须在首次触摸前稳定可见、无 hover 显隐过渡；桌面鼠标 hover 与键盘焦点规则保持独立。不以 `pointerup` 补发点击替代原生激活 | OverlayDisclosureTrigger、三个活动消费者、消息操作栏；DOM/状态测试与手机首次轻触对照 |
| WSP-36 | OpenCraft 自有 Web DOM 的焦点描边由 Design System 统一拥有，不露出浏览器默认蓝框：低优先级规则压住包括浏览器自动聚焦滚动容器在内的 UA outline；主题化兜底只在当前为键盘模式且 `:focus-visible` 时绘制。iPhone 触摸文本框或弹窗自动聚焦按钮也可能匹配 `:focus-visible`，不能单独用它判定键盘输入；触控模式必须压住组件后续自定义的 focus outline/shadow，硬件 Tab 恢复可见键盘焦点。原生预览弹窗共享打开来源模型：触摸打开时自动聚焦按钮不画键盘环，进入 Tab 导航后恢复；不能依赖全局最近输入方式始终正确。`:focus-within` 画在容器上的焦点环也必须受输入模式约束。非交互内容不添加无用途 `tabIndex`；Markdown 表格操作按钮可聚焦，滚动区与代码滚动区只保留键盘焦点的自定义内描边。触控按下、键盘焦点、选中态分别呈现；强制颜色模式仍有焦点轮廓。第三方 iframe 与浏览器 chrome 不属于应用 CSS 所有权 | focus.web、pointer-modality、Table/Image/Mermaid preview、CodeBlock；焦点契约测试、Web 构建、手机触控与键盘 Tab/浅深/强制颜色验收 |
| WSP-37 | Conversation 折叠交互期间，被操作标题的屏幕纵坐标保持稳定；Web 共享动画适配器将数值高度样本投影到整 CSS 像素网格，避免分数高度与滚动取整形成往返抖动，不锁定自然 auto/流式布局，不另加 DOM 高度写入者。控件报告动画完成，视口唯一拥有滚动锚点与补偿，最终布局连续稳定后才释放。快速反向或切换标题先撤销旧 lease，旧完成回调不能释放新交互；用户主动滚动、控件卸载与视口替换立即取消。减少动态效果与同步收起也须完成末帧测量，不以固定超时替代动画生命周期；验收测可见标题全程及往返振幅，不能只看最终位置或以每帧半像素误差放行一像素振荡 | useDisclosureHeight、DisclosureReflowContext/useDisclosureReflow、WebConversationViewportOwner、TimelineReflowLease；真实组件、多 Turn 测量、分数初始几何、鼠标/触控、长正文展开/收起、快速反向、减少动态效果、取消与视口替换验证 |

WSP-32 远端目录补充：目录选择与持久 Project 记录是独立能力。Server 明确返回方法不支持时，Application 可只将已浏览的同 Server 路径绑定到当前 Draft；不得构造本机 Project、伪造 projectId 或声称已保存远端项目。权限拒绝、网络失败与未知创建结果不能降级为成功，旧选择结果仍受原 Draft/Server/导航代次约束。真实界面验收包含无 Project API 的 SSH Server，以及选择期间草稿保持；整页刷新后的草稿持久化不是当前内存 Draft 的承诺。

## Conversation loading presentation

会话首次加载只在无可见历史的空槽中显示居中中性圆环，不显示加载文字；辅助技术可读取本地化状态名。Thread runtime 拥有加载/失败事实，视图不添加恢复计时器或第二套 authority。Design System 拥有共享圆环、主题色与减少动态效果规则；Conversation 拥有空槽几何和滚动。后台重连保留历史、输入和 View 身份，失败切换为可操作的重试而非永久转圈。

Bot 的空展示页与历史耗尽分开：仍有更早源记录时，视口可在没有滚动手势的情况下
按一次恢复意图最多推进三页，串行且有界；额度耗尽或失败在原状态槽提供继续／重试，
不呈现新会话欢迎页、不自动排空全历史。重同步保留有持久锚点的已加载前缀及独立
本地提交，不以展示缓存恢复执行权限。协议所有权见
[Hermes message windows](../docs/chat-ui-architecture.md#hermes-message-windows-and-bot-history-continuity)；
`hermes-bot-history-integration.test.ts` 和 `smoke-hermes-bot-history.ts` 验证真实组件与模拟远端端口，
不代表已替换运行预览或实测远端 Hermes。

## Application navigation glyphs（Codex 26.930.31428 参考）

- Navigation contribution 只声明图标语义和当前目的地；Web/Electron 的 NavigationIcon 拥有轮廓/选中图形投影，Design System 拥有 20px 图标、36px 基础控件、圆角、间距和状态色。不得套用菜单行的 14px 图标或独立次要颜色，也不以收缩时整体 scale 改变图标物理大小。
- 选中态仅对明确支持的闭合图形填充；Bot 面部、Server 指示灯和 Gear 中心等内部细节保留轮廓，不能统一 `svg { fill }` 抹掉。不同状态共享同一 SVG 盒子，不改变页面意图；不恢复 Home 或添加参考产品的未接通入口。
- Shell 的 compact/expanded 内容保持同一实例，应用行的视觉盒子与触控命中区分离；粗指针或当前触摸输入时至少 44px，仍容纳于原 52px 紧凑栏中。鼠标 hover、键盘焦点、当前目的地与菜单打开分别投影。账户菜单保持其独立密度与反馈。
- 证据：`workbench-navigation-icons.test.ts`、`smoke-navigation-icons.ts` 检查尺寸、图形、状态色继承、明暗/扩展主题、紧凑/展开、触控/鼠标、普通菜单负例与键盘/强制颜色；真实手机和当前预览替换须另行记录。

## 证据纪律

会话菜单仅呈现该会话的操作，不提供“在 Host 上新建任务”或“Host 设置”捷径；
这些能力继续通过应用原有的新建任务与设置导航进入，删除菜单入口不删除能力。

目标入口契约：无目标的可写会话通过 Composer 的“＋”菜单设置持续目标，
不保留独立创建胶囊或空白占位。Goal surface 拥有编辑草稿、弹窗和既有目标
进度；Composer 仅呈现标准菜单项。只读或没有有效会话时不提供创建入口，
切换会话撤销旧目标编辑但不得重挂载 Composer 或丢失输入草稿。

WSP-36 焦点视觉补充：普通焦点颜色独立于品牌 accent，使用共享中性 token；旧 focus-ring 别名投影同一颜色。全局兜底的整个选择器为零优先级，组件自己拥有焦点呈现，不能被兜底重画外框。Composer 编辑区只保留光标/选区，不画外框；键盘按钮仍有可见中性提示，强制颜色模式尊重系统配色。真实 Composer 的鼠标点击、Tab、触摸以及无局部样式按钮的 fallback 必须同时验收，不能仅凭源码中的 `outline: none` 判定成功。

桌面面板 motion：共享 Design System 拥有加载矢量、两秒60步旋转与 Document timeline 同相；减少动态效果只撤销旋转，不改反馈盒几何。紧凑 outline 按钮状态即时投影主题色，不新增缩放或文字/连接遮罩淡入；触屏保留44px命中区且不粘 hover。插件只投影状态，不在动画结束后确认授权或撤销控制。真实组件验收包括分离挂载的相位、采样中间帧、按住反馈、减少动态效果和接管/停止几何；不把源码参考称为 Mac/iPhone 逐帧等同。

WSP-29/30 所有权补充：Renderer 的 capability 声明接受与 Engine 挂载 ready 分开。执行准备与替换共用 Host Thread 队列，停止/审批回复/队列删除不等待工具准备；owner 先撤销后清理，迟到提交失效；首次 native setup 挂载失败不发布新会话，已有历史不参与回滚。Bridge 仅透传允许列表错误码，不以截断字符串代替脱敏。

## 听写输入所有权

- DIC-01：听写Footer由当前Composer瞬时输入事务拥有；切换草稿、清空、物理View替换或卸载同时释放文本与呈现。旧事务不能更新新Footer。
- DIC-02：普通与听写操作互斥；普通内容保持挂载但inert/aria-hidden，不重建编辑器。Composer拥有区域几何、主题控件和提交编译，插件只提供状态/采样/完成动作。
- DIC-03：停止只写入；Enter/确认发送必须等最终文本，并核对同一草稿与View。取消、失败或失去归属不能迟到发送；重复停止复用同一完成事务。
- DIC-04：平台录音适配器唯一拥有物理录音；Mac Main拥有原生录音，Web浏览器适配器拥有MediaStream，波形只消费有界数值采样。波形不发布草稿snapshot、不二次录音，没有采样时不伪造声音。
- DIC-05：单击与150ms长按分开；长按释放完成听写，合成click不能再次开始；Escape取消。真实权限/识别与合成UI验收分别报告。
- DIC-06：听写session与识别task/片段不是同一对象。真实task ID/sequence隔离final账本，片段确认不能终止Capture；用户stop后完整收尾才交付一次。录音保留原草稿/选区且只读，partial不参与编辑或提交；失败/取消不得自动写入部分结果。Browser result index是实际身份，不以文本长度/公共前缀猜分段。
- DIC-07：dictation追加文末并同步确认真实View已应用；泛用输入默认selection。原Draft/View/contentEpoch在写入前后须一致，replace-content/目标重置/View交接令旧lease失效；false/commit-rejected禁止自动发送，不用文字非空伪装成功。
- DIC-08：Web云听写的录音、转写attempt和草稿写入分属平台、应用服务、Composer。后端验证真实WAV字节和时长；凭据不进入Renderer，所选SSH/Agent Host不拥有语音输入。捕获结束后释放麦克风，完成/取消/失去所有权/过期释放临时音频。
- DIC-09：转写失败使旧发送意图失效；显式重试复用原音频、创建新attempt，不重启麦克风、不延续旧发送。重试/失败反馈使用原Footer槽位，仍受原Draft/View/contentEpoch约束。暂停等待上游不等于云端取消或退款。
- DIC-10：语音连接复用模型配置与凭据仓库，语音默认与聊天默认独立；转写模型/密钥不得进入聊天目录与引擎投影。应用服务绑定安装级配置，SSH/Thread/Bot 选择不得改变语音所有者；旧环境密钥不得作为运行时第二真源。
- DIC-11：录音与显式重试绑定开始时的语音配置票据；转写前比较当前模型/凭据，变更时拒绝，不静默转投。配置缺失、停用或删除保留不可用选择，不隐式选择目录首项。配置页面不得自动触发计费探测。
- DIC-12：启动不等于系统授权弹窗；启动反馈只在原Footer槽位显示共享进度图标，无可见授权文案，读屏使用中性准备提示。平台确认listening后才呈现波形并计时；启动中可取消，迟到就绪不能复活旧事务。反馈不增加最短等待、不预热或常驻麦克风。

本次证据与恢复源码边界见 [听写整改计划](dictation-interaction/task_plan.md)。

## Floating composer ownership

| ID | 不变量 | 责任/验证 |
|---|---|---|
| FCO-01 | Shell 的路由注册表持有显隐意图；各浏览器标签的 manual/auto-collapse 原因互不覆盖，自动策略不得改写用户手动选择 | floating-composer-state.ts；确定性状态测试、原生标签切换 |
| FCO-02 | 紧凑/聚焦展开、peek、最近轮次展开和显隐阶段分别派生；退出和 peek 内容不可交互 | ThreadComposerPresentation；焦点/键盘/动画回归 |
| FCO-03 | inline/overlay 共用同一 portal destination 和编辑器 DOM；草稿、附件、撤销、提交目标不随位置重建 | Stable editor host；native smoke 的 DOM identity、草稿和 WebContents identity |
| FCO-04 | 收起把手绝对定位，不增加 Composer 内容高度；唤回把手有独立 Shell 锚定宿主，背景区域不截获网页操作 | thread-workspace.scss；native pointer/hit area smoke |
| FCO-05 | 最近轮次预览不重复用户 intro；滚动只由预览视口拥有，Composer 手势排除预览内容和惯性事件 | ConversationTurn.startAfterTurnIntro、ComposerWheelSwipeController；真实组件长回复测试 |
| FCO-06 | 菜单/对话框属于 Composer 焦点边界；窗口失焦和布局迁移不误解释为用户离开；隐藏后的入口支持键盘 | focusin/focusout adapters、Radix popup recognition；native keyboard/menu checks |
| FCO-07 | 原生底边追踪由 Main 持有已登记 guest；事件按 guestId+trackingId 过滤；旧订阅清理不能撤销新的 tracking | browser-guests / ElectronBrowserSurfaceHost；真实 webview pointer smoke |

迁移基线：Codex 26.908.40834 的 `right-panel-composer-overlay-f770dcfd060a.js`、`right-panel-composer-overlay-c2ae7a9bcecb.css`，并以 ref/codex 可读恢复树交叉核对状态与手势。OpenCraft 的 scope registry、主题、标准 Electron tracking 是适配层，不声称为私有宿主源码。最终矩阵记录于 2026-09-14-floating-composer-replacement Task Pack。

## Shell pane ownership（Codex 26.908.40834）

| ID | 不变量 | 实现责任与证据 |
|---|---|---|
| SHL-01 | Pane 几何只投影一次；内容面板宽度、占位、聊天 Frame 均从同一 paneGeometry 读取 | workspace-pane-geometry.ts；纯函数矩阵及帧采样 |
| SHL-02 | Viewport 是 flex 裁切区域；Frame 宽度为 max(0,W-min(R,A))，并且 min-width:100%；聊天容器查询归 Frame | AppShell + app.scss；最大化中间帧 Frame≥普通并排下界 |
| SHL-03 | 显隐与全宽进度分离，由一个 Shell 事务入口写入；模式切换先终止残余显隐，scope/reduced-motion 直接落到端点；旧完成回调被清理 | useWorkspacePaneAnimation；快速反向及 reduced-motion native trace |
| SHL-04 | 退出阶段保留同 scope 的主布局描述，完成后更新；模式交接不卸载聊天草稿或浏览器 backing；普通 resize 仍实时改变排版宽度 | mainLayoutSnapshot；草稿/WebContents身份＋held resize验证 |
| SHL-05 | 不绘制 Sidecar/main 边缘渐变。Header 的主表面上沿随既有 primary/context 实时宽度与 context 显隐进度向左延伸，形成包含原生按钮预留区的连续标题栏；不得等 context 卸载再切换绘制，或另设 CSS 动画时钟。上沿下边缘消费同一主面板主题 elevation，连接边裁切避免重复接缝，flat 不额外加阴影。横向细线与 Sidecar 标题栏下方的竖分界共用绘制进度；内容生命周期仍由 pane exit owner 独立保留。safe-area/几何/命中区不改、不复制原生按钮；主面板主题阴影/描边/flat、expanded/context 材质与浮动阴影保留，强制颜色使用系统分界 | Header + Sidecar + live motion + Design System/theme tokens；真实 AppShell 前 100ms 与中间帧上沿跟手、native reservation、十种主题 shadow authority/下沿像素与白色接缝负例、快速反向/held resize/显隐与浮动回归 |

边界：当前 OpenCraft 普通并排使用自身 shellSpaceMetrics.mainMinimum（480），不是将 Codex regular 的352或 unified 的320暗中替换产品空间策略。这里迁移的是同版本 Wba/Xba 的几何与过渡所有权，不宣称旧 ref/codex 与新安装包的所有 API 相同。状态：63项聚焦测试、完整门禁、最终包556帧验收通过；Frame最低480而Viewport可到0，普通held resize及取消恢复通过。证据 /tmp/oc-pane-4aFgS4；草稿和WebContents ID保留。

## Browser 源实现迁移不变量

| ID | 不变量 | 责任/验证 |
|---|---|---|
| BRW-01 | Source BrowserSidebarStateManager 唯一管理 backing host、挂载 claim、持久化状态及交接；React 只提供 slot 与测量 | codex/browser-manager.js；原类体比对、codex-browser-manager.test.ts |
| BRW-02 | 上一个页面在新页面收到对应代次的 attachment ack、预热完成前继续承载画面；提交后一帧才释放旧画面与新页面交互 | codex/presentation-transition.js；确定性调度测试 |
| BRW-03 | 替换/取消 pending handoff 后，旧 ack、timer、frame callback 不得重新显示旧 incoming 或清理新页面 | A→B→C 和迟到回调回归 |
| BRW-04 | Claim release、presentation detach、logical close、backing dispose 相互独立；旧 reference/generation 不撤销新 claim | 源状态机＋标准 host port；原生多标签回归 |
| BRW-05 | Page storage ID 与 renderer/host/mount generation 分离；源管理器拥有 ephemeral→persistent 与 restore-expected 状态，平台负责持久化同一分区 | manager storage tests＋桌面重启 Cookie 回归 |
| BRW-06 | 弹窗请求经 Main 验证并按原 Page Scope 创建标签；不改写原页面、不生成不受管窗口 | native managed popup smoke |
| BRW-07 | 权限按 partition/origin/type 隔离；旧页面与撤销后的迟到授权不得生效 | browser-permissions.test.ts＋原生拒绝/撤销/清除数据回归 |
| BRW-08 | browser-use 与 UI 挂载独立；操作互斥且 finally 释放；隐藏页仍可渲染/截图，无面板激活副作用 | browser-background.test.ts＋原生后台读取/截图/关闭回归 |
| BRW-09 | 恢复未完成不是用户关闭；close 与清除站点数据分离，重启不因 localhost 端口变化丢失归属 | desktop metadata＋native restart smoke |

当前迁移状态：源类体哈希校验、66 项聚焦测试、完整门禁，以及最终打包应用的多标签/隐藏保活/分区重启验收通过（/tmp/oc-browser-MGEbk1）。没有新增 bottom-panel UI；Owl WebContents adoption 不在标准 Electron port 内伪装支持。标准宿主桥接与源类体分开验证，不将桥接代码声称为 Codex 原始宿主实现。

模型成立、编译通过、真实控件通过、真实 Host 通过、Mac 产物通过是不同级别。未经相应验证不得提升状态。恢复源码没有明确承诺的行为不得擅自增加约束；结构互斥、稳定前缀和同步移交本身可构成合法保证。
# 会话生命周期补充（2026-09-15）

文件更改呈现补充（2026-10-06）：Turn 变更汇总是独立资源，不是消息或工作结束边界。Web 实际 Composer 是指定 active Turn 的唯一运行中入口 presenter，主/浮动 mini transcript 按相同身份避免重复；结束卡再进入消息区。资源更新保留数字、展开与 Review 的身份，展开重排由 viewport lease 协调；卡片/悬浮用主题与成熟 Button/Radix，不新增 Host 写权。实现与真实组件验收见 [ChatUI Changed-file review](../docs/chat-ui-architecture.md#changed-file-review)，当前不是生产替换或 Native 实机验收。

Connector 交互不变量：Composer 入口消费应用级 Manager；授权完成、连接、会话选择与写审批分别表达用户意图。面板卸载不销毁已就绪共享连接；审批由共享 Modal/Radix 管理焦点和层级，配置恢复不恢复执行授权。见 [Connector 设计](../docs/platform-connectors.md) 与 `smoke:connector-controls`。

Connector 目录属于 Skills 能力页的同级 Tab；配置弹窗复用 Settings 原语，不引入 Octop 的 Antd/Less。共享 SettingsListItem 显式投影是否有图标，无图标不能保留空图标列挤压正文；配置弹窗内容按本征高度滚动，检测结果不能压掉必填字段。凭据不出现在会话、Skill 或持久 UI 状态里；第三方服务运行结果与静态目录说明分别呈现。

Connector 目录浏览不套用设置行：采用限宽品牌卡片，已配置实例单独管理，分类/搜索和返回位置不因打开详情丢失。详情的侧边/窄屏呈现由共享 Modal `inspector` variant 持有，业务不能手写 focus trap 或遮罩；正文滚动不带走操作区。不保留旧长列表模式或为测试专设的第二套管理入口。

- 持久 Thread 元数据、引擎上下文、逻辑订阅、View 是独立生命周期；普通退订不等于中断或归档。
- 临时 Side Chat 分支完整原生上下文，继承历史边界在获取 view 前提交；创建/关闭失败保留清理身份，旧失败不得覆盖主要错误。
- 两个 renderer 共享物理 Host 时，订阅和审批仍按逻辑客户端隔离；后台卸载与新订阅序列化，SDK 迟到退订必须重新订阅。
- 菜单和 Settings 归档页消费唯一 Host 命令及共享 Radix/主题控件；主 Sidebar 只展示活跃会话，不持有归档入口或撤销提示。归档是可恢复目录状态，不删除 workspace。
- Sidebar 会话行的右键菜单触发区与触控“…”下拉入口互不包含；两者共享操作项、各自处理输入事件，但整个 Sidebar 只允许一个按 Host/Thread/入口标识的菜单打开。切换行或入口须关闭旧菜单，旧入口迟到的关闭回调不得关闭新菜单。选择菜单项不能重新触发另一菜单，重命名/删除的后续交互由 Modal 持有。
- 当前证据：聚焦模型/SDK 测试、真实隔离 DSH Fork/边界/落盘审计、归档重启、完整门禁及实际签名桌面菜单/恢复窗口验收通过；不代表发行或生产发布。见 [本轮账本](thread-lifecycle/progress.md)。

## 会话权限目录（2026-09-26）

- 标准权限档位只能由 Host 根据引擎真实 profile/preset 投影；未验证的自定义 profile 保留为引擎原生选项，不因名字相似归类。
- 目录的 `openCraftMode`/`openCraftLabel` 只在 Host 声明 `opencraft/permission-modes` v1 时有效。缺失能力时，客户端不得自行猜测标准档位。
- DSH 的 Thread 创建、Turn 执行与 Fork 必须先校验所选 preset；新建 Thread 在创建时应用并回读生效值，不能等到首轮 Turn。DSH 的外部沙箱投影不能冒充 Codex 沙箱。
- 标准档位用稳定的 `opencraft:permission-mode:*` 提交值，Host 在每次提交时解析当前引擎目录并翻译为原生 profile；会话恢复后原生生效 profile 由目录重新映射为产品档位。产品级权限上限与独立的请求值/生效值持久对账尚未建立，不得声称已实现 bb 的完整权限策略。

## 会话顺序与展示分段（2026-10-05）

- 一个执行轮次可以有多个有序问答与活动片段；执行所有者唯一，不等于折叠组唯一。问答、追问与交互边界不得被“回答区/活动区”重新分桶。Renderer 只消费共享呈现计划。
- 异步提问的可见文字与原生 phase 不赋予最终回答资格；折叠边界、最终回答资格和执行完成相互独立。折叠只控制连续片段的显隐，不改变消息位置。
- 源消息与边界身份决定显示 key；流式、完成与补历史不按数组索引重建已有回复。历史片段保持结束状态，当前响应最多一个 Thinking owner；总用时与完成信息不因分段而重复。
- 引擎实际返回的思考摘要/文本与 Bash/Read 工具记录是同一连续响应工作容器内的独立 Item 折叠面，不是工具标题的正文，也不是与“用时”平级的工作区。各引擎默认接入且内层初始折叠；无实际内容不暴露空按钮，不切开工作区或制造“历史消息”标题。真实思考仅分开相邻内层工具组，不重建外层身份；有效最终回答授予该连续工作容器一个外层折叠，最终回答保留在外面。只有真实思考、没有工具也属于有内容的工作，完成后可在真实用时下折叠；不得伪造时间。用户输入、异步提问与交互边界保持原顺序，不同已完成响应保留独立折叠。Turn 用时与实时 Thinking 各只有一个 owner，不跨响应回派。流式、完成及外层收起不改内层用户选择；Web View 与 Native 稳定外层组件按 Item 身份保存选择，动画组件只管理过渡。共享 `chat-core` 选择一份非空内容、保留时序和唯一实时 owner，Web/Native 只消费；契约与证据见 [Returned thinking content](../docs/chat-ui-architecture.md#returned-thinking-content)。
- 回归须覆盖同轮次的异步提问→用户回答→工作→回答→多次追问，包含桌面/触控、折叠、刷新、补历史和正在输出期间的 DOM 身份。
- 2026-10-06 折叠资格补充：共享 `AgentActivitySegmentEnd` 只记录时序结束原因；插话、异步问题、审批、图片及 Turn 完成不赋予折叠资格，旧回答也不赋予后续工作段资格。普通任务段须到达自身有效非异步最终回答，才可默认折叠；取消保留正文。资格、默认值、用户选择与临时强制展开独立，显隐结果不得反写选择；禁止收起按钮的呈现必须保留完整有序正文，不丢失/重复 persistent 项。最终回答保留独立槽位，内层分区也不得隐藏有效最终回答。两端消费唯一 reducer，保留既有 ID、时钟与视口 lease。契约/测试见 [Activity closure and disclosure authority](../docs/chat-ui-architecture.md#activity-closure-and-disclosure-authority)。

## 图片附件呈现（2026-09-27）

- 草稿图片的语义身份和处理状态只属于 Composer Draft；浏览器 `File`、临时预览 URL 和处理任务属于 Controller 的草稿所有者附件会话，不写入可序列化 Draft。切换会话或页面缓存淘汰保留资源，晚到结果只能修改原 Draft；移除、清空或草稿所有者销毁须中止任务并释放 URL。新内容准入失败必须回收尚未被草稿接收的 File 预览，不启动孤立任务。
- 图片选中即在输入卡片内显示方形缩略图；处理中、失败和删除均原位反馈。触控删除始终可见，不能依赖 hover；处理中不宣称网络上传百分比，失败图片不允许发送。
- 已发送图片由 Timeline 及媒体加载边界投影。缩略图进入图片查看器，不绕过通用链接策略来打开 `data:` URL；查看器按原资源身份加载并在关闭后恢复焦点。

### LightVela 国内嵌入预览面板

国内控制台隐藏发布允许右侧浏览器标签与对话文件只读预览，默认收起，复用 Shell resize owner。只读预览不提供目录树、搜索、编辑与终端入口；权限仍由 Host 决定。新草稿保留面板开关所在标题栏；面板元数据与会话绑定由本次 Bot 的 Application 内存持有，销毁时释放，不从其他账号或独立站点的 localStorage 恢复。

## Markdown 文件预览
- 文件面板默认将 `.md` / `.markdown`（大小写不敏感）交给既有 WebChatDocument 排版，可切换到原始文本；不将原始 HTML 注入 DOM。相对文件链接与图片以当前文件目录解析，继续消费当前 Host 的资源接口和 Blob lease。
- 内嵌模式维持只读、无目录/搜索/监听/写入；写入执行入口必须先检查只读状态，拒绝后不得调用 Host 写入或失效 Blob 缓存。预览/源码是文件身份下的局部状态，不修改会话或源文件。

内嵌控制台主 Composer 的编辑区域最小高度为 74px；新会话与已有会话保持一致，增长由同一输入区域承担，工具栏继续位于底部。

Markdown preview entry: explicit `.md` / `.markdown` paths in completed inline code are clickable and use the same resource policy and Host-scoped right panel as Markdown links. Bare names, commands, external URLs, streaming paths and code within an explicit link retain their original semantics. No file is read before clicking.

国内嵌入聊天采用 compact 右栏初始宽度：既有默认宽度的 2/3，并继续遵守面板最小宽度和聊天内容保留宽度；拖拽调整由原 Shell owner 负责，独立工作台保持 standard 默认。

国内桌面嵌入聊天由控制台占满侧栏右侧的内容列，去除设置页外围 gutter 和宽度上限；宿主通过 `--lightvela-console-header-height` 对齐 68px 导航表头。嵌入根将其投影到 toolbar token（缺省 46px），消息正文保留内部间距；移动端与旧聊天入口沿用原布局。

只读 Markdown 文件预览的“源码”直接呈现转义后的原文，可选择复制和键盘滚动，不依赖按需加载的编辑器模块；可编辑工作台继续由 CodeMirror 持有草稿。
