# 工作区不变量

状态：实施及验证中。下表记录目标与责任，不把测试名称当成已运行的证据。最新结果在 [progress.md](progress.md)。

| ID | 不变量 | 责任/验证 |
|---|---|---|
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
| WSP-11 | 右侧/侧栏拖动实时改变几何；显隐 target、progress、mounted 分离 | 既有 usePanelAnimation；侧栏及浮层验证 |
| WSP-12 | 不支持 fork/unsubscribe 的 Host 明确失败，不用空会话模拟或删除父历史 | 协议适配/错误展示；负例及真实 Host 验证 |
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

## 证据纪律

## 听写输入所有权

- DIC-01：听写Footer由当前Composer瞬时输入事务拥有；切换草稿、清空、物理View替换或卸载同时释放文本与呈现。旧事务不能更新新Footer。
- DIC-02：普通与听写操作互斥；普通内容保持挂载但inert/aria-hidden，不重建编辑器。Composer拥有区域几何、主题控件和提交编译，插件只提供状态/采样/完成动作。
- DIC-03：停止只写入；Enter/确认发送必须等最终文本，并核对同一草稿与View。取消、失败或失去归属不能迟到发送；重复停止复用同一完成事务。
- DIC-04：客户端原生层唯一拥有物理录音，renderer只接收有界数值音量采样；波形不发布草稿snapshot、不二次录音，没有采样时不伪造声音。
- DIC-05：单击与150ms长按分开；长按释放完成听写，合成click不能再次开始；Escape取消。真实权限/识别与合成UI验收分别报告。
- DIC-06：听写session与识别task/片段不是同一对象。真实task ID/sequence隔离final账本，片段确认不能终止Capture；用户stop后完整收尾才交付一次。录音保留原草稿/选区且只读，partial不参与编辑或提交；失败/取消不得自动写入部分结果。Browser result index是实际身份，不以文本长度/公共前缀猜分段。
- DIC-07：dictation追加文末并同步确认真实View已应用；泛用输入默认selection。原Draft/View/contentEpoch在写入前后须一致，replace-content/目标重置/View交接令旧lease失效；false/commit-rejected禁止自动发送，不用文字非空伪装成功。

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

Connector 交互不变量：Composer 入口消费应用级 Manager；授权完成、连接、会话选择与写审批分别表达用户意图。面板卸载不销毁已就绪共享连接；审批由共享 Modal/Radix 管理焦点和层级，配置恢复不恢复执行授权。见 [Connector 设计](../docs/platform-connectors.md) 与 `smoke:connector-controls`。

Connector 目录属于 Skills 能力页的同级 Tab；配置弹窗复用 Settings 原语，不引入 Octop 的 Antd/Less。共享 SettingsListItem 显式投影是否有图标，无图标不能保留空图标列挤压正文；配置弹窗内容按本征高度滚动，检测结果不能压掉必填字段。凭据不出现在会话、Skill 或持久 UI 状态里；第三方服务运行结果与静态目录说明分别呈现。

Connector 目录浏览不套用设置行：采用限宽品牌卡片，已配置实例单独管理，分类/搜索和返回位置不因打开详情丢失。详情的侧边/窄屏呈现由共享 Modal `inspector` variant 持有，业务不能手写 focus trap 或遮罩；正文滚动不带走操作区。不保留旧长列表模式或为测试专设的第二套管理入口。

- 持久 Thread 元数据、引擎上下文、逻辑订阅、View 是独立生命周期；普通退订不等于中断或归档。
- 临时 Side Chat 分支完整原生上下文，继承历史边界在获取 view 前提交；创建/关闭失败保留清理身份，旧失败不得覆盖主要错误。
- 两个 renderer 共享物理 Host 时，订阅和审批仍按逻辑客户端隔离；后台卸载与新订阅序列化，SDK 迟到退订必须重新订阅。
- 菜单和 Settings 归档页消费唯一 Host 命令及共享 Radix/主题控件；主 Sidebar 只展示活跃会话，不持有归档入口或撤销提示。归档是可恢复目录状态，不删除 workspace。
- 当前证据：聚焦模型/SDK 测试、真实隔离 DSH Fork/边界/落盘审计、归档重启、完整门禁及实际签名桌面菜单/恢复窗口验收通过；不代表发行或生产发布。见 [本轮账本](thread-lifecycle/progress.md)。
