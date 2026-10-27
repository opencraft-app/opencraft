# Workbench invariants: Lifecycle and verification

[Invariant index](../invariants.md) · [Design index](../README.md)

## 工作区契约

| ID | 不变量 | 责任/验证 |
|---|---|---|
| WSP-36 | 云桌面标签属于 Conversation；短期观看连接属于桌面显式常驻视图；远端桌面与独占输入授权属于后端。隐藏/切换工具保留观看但立即撤销输入，关闭标签或更换 owner 回收观看，不影响 Agent；其他插件不隐式常驻。观看续期必须双端声明能力、后端重验身份并匹配确认，不能删除到期门禁、复用票据或重新接管。未接通真实适配器不发布入口；观看默认无输入；鼠标悬停不接管；点击桌面、H5单指轻点或接管按钮显式申请；媒体原生pointerup消费一次激活，拖动/取消/多指不触发，兼容click不重复消费；两项就绪与有效授权缺一不可，握手不能冒充首帧；关闭、换账户、取消后迟到结果只释放，不复活连接。自动恢复仅限 adapter 声明安全的新观看授权与已分类传输中断，有限退避，不继承控制权、不重放资源创建。反馈不替换媒体宿主；申请立即投影可用的停止意图，授权确认前仍不绑定输入。View 捕获一次原生激活的固定动作，controller 按连接/控制意图代次消费一次；失焦不能把停止 click 翻成接管，旧动作不能撤销后继授权。不合成补发 click、不延时撤销；剪贴板仅显式手势读取、按原 grant 失效；物理能力与输入授权分开，不支持粘贴不画无效入口。设计系统拥有空态/进度/紧凑控件尺度，短状态及本征槽位保持相邻几何稳定 | cloud-desktop / DesktopViewController；Host-wire-controller 跨期限组合、真实 socket 授权复核、React 与主题/窄屏 Shell 验证；本轮媒体/输入外部边界合成，公网授权和手机实机/弱网未验收 |
| EXT-01 | 可选内置扩展的启用意图由统一 ExtensionInstallationRepository 持久化，产品默认值只在首次发现时填充；Collaboration 默认停用，不加载实现或注册导航。用户启停驱动真实激活/资源释放，不影响平台账户与 Agent 会话；内置来源不能被 URL 安装覆盖或单独移除/更新 | ExtensionManager/catalog；启停、重启恢复、来源保护测试与真实 Web 组件验收 |
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
| WSP-11 | 右侧/侧栏拖动实时改变几何；显隐 target、progress、mounted 分离。浮动侧栏与外侧命中层由 AppShell 共同 Portal 到 body 级覆盖宿主，成为窄屏唯一交互前景，盖过独立 Browser Surface portal；关闭时直到退出动画结束，其内容 Portal、导航投影与外侧命中层仍归浮动呈现所有，外侧命中层显式恢复 pointer hit testing；首次外侧触摸（包括空白）只关闭侧栏、不点穿浏览器或正文。右面板状态不因遮盖而重建，侧栏关闭后恢复呈现 | usePanelAnimation、FloatingLeftPanel、AppShell、BrowserPresentation；侧栏模型/真实组件帧采样及手机触摸验证 |
| WSP-12 | Thread 菜单与 Side Chat 只消费版本匹配、显式声明的 Host 生命周期能力；菜单 Fork 仅需 fork，Side Chat 须声明 fork或ephemeralFork，并同时声明ephemeral/injectItems/unsubscribe。不支持时明确失败，不用空会话模拟或删除父历史。顶部会话菜单与侧栏 Fork 共用 forkAndOpenThread；顶部使用分叉图标，未声明 fork 时不展示，等待期间原位显示进度并禁用重复操作，未知结果不自动重试。菜单 Fork 收到 child ID 后不等待目录刷新即可打开；若用户已切换 route scope，迟到结果不得抢回导航 | 协议能力解析、Workbench 门控、forkAndOpenThread、smoke-conversation-header-menu；Codex/DSH 真实 Host 与负例验证 |
| WSP-12a | 普通菜单分支只请求元数据，子会话经既有分页读取；历史已结束的回复提供“从此处分支”，以原生 lastTurnId 包含当前轮并截断后续历史。流式轮及非权威缓存不提供执行入口；等待立即禁用重复点击，失败不自动重试，父历史不变，迟到结果沿用路由作用域保护 | ConversationDocumentContext、ForkTurnButton、threadManagement；专项协议与真实组件验证续录 |
| WSP-13 | ephemeral fork 返回结果是 baseline，不请求持久 Resume/queue；旧连接代次不能被采用 | Session.adoptFork + HostRuntime；appserver-session.test.ts 与 smoke-side-chat-appserver.ts |
| WSP-14 | 当前产品没有下方面板、移动到下方/Show bottom panel 入口或底部占位；旧标签无损归回右侧 | AppShell/RightPanel、restoreRightPanelTabs；类型、聚焦测试、Web/native smoke |
| WSP-15 | 账号登录或零云端 Bot 不接管本机/其他 Host 工作区；创建仅来自主动环境操作；只有选中 Host 的真实连接错误可请求干预 | App connectionIntervention、下游产品 contribution；匿名/已登录零 Bot 回归 |
| WSP-16 | Skills 与 Cloud Storage 可作为 Workbench 侧栏中的下游产品独立路由；它们与 Start 消费同一 Shell navigation action 模型，Web/Electron 桌面一级导航位于60px图标栏，底部为设置/账号，列表为独立列；既有移动抽屉信号下改为列表上方纵向全宽菜单、新建/设置在底部独立悬浮且不显示账号底栏、列表全宽，复用同一 action 与状态；内建与贡献入口按当前locale解析短标签和完整可访问名，不显示额外的 “Work” 标题。应用级工具入口由页面的 `management.entryPoint: "workbench"` 显式声明，核心不按产品 ID 判断；撤回贡献同时撤回入口。导航只选择既有贡献页，不能创建/切换 Host、Bot 或会话 | 下游产品 Work navigation；聚焦路由/几何测试与 Web/Electron 验收 |
| WSP-16a | 连接器管理入口消费已激活 View 的 `connector-management` role 与唯一可见 Settings Page；平台/audience/renderer 同时可用才呈现。无提供方不跳转默认设置，退役和同 ID 重激活撤销旧回调。原生连接器操作不因缺少管理页而停用 | Extension contribution projection；角色 owner、路由可达性和真实 Workbench 浏览器验证 |
| WSP-16b | 导航的完整/紧凑标签及徽标由贡献声明，随locale热更新和激活回收；Shell保留完整可访问名，既不按插件ID覆写文案，也不授予徽标权限。语言切换不重挂载工作页、不清空草稿 | NavigationContribution/SettingsPageContribution及Shell投影；冻结/非法声明测试、四语言真实工作台与浅深/宽窄截图 |
| WSP-17 | AppShell 窗口 chrome、原生拖拽区和侧栏 resize owner 跨路由常驻；独立管理页只替换内容区，不得通过 `header=null` 改变物理窗口结构 | AppShell/AppShellHeader；Skills、Cloud Storage 路由测试与桌面 held-drag 验收 |
| WSP-18 | `New chat` 是回到 Home 的本地导航事务，不是远端 Thread 创建：Draft、conversation application route 与 View 同步提交，Host/Workspace 在页面可见后异步准备；失败留在 Home 原位反馈，不得继续显示 Skills/Settings | `navigateToHome`、WorkbenchNavigationTransaction、Coordinator；慢/失败 Host 单测与桌面 Skills→New chat 验收 |
| WSP-19 | 扩展页面由 contribution 声明 `document/master-detail/edge-to-edge` 布局，Settings Shell 只解释一次；`edge-to-edge` 只移除 document inset，Shell viewport 仍是唯一纵向 scroll owner，只有 `master-detail` 将滚动下放内部 panes。Skills 的 catalog toolbar 不叠加 padding，安装目标与 tabs 同行 | SettingsPageContribution、SettingsContent、Hermes Skills；布局契约、Electron scrollHeight/scrollTop 与 Skills→Storage 验收 |
| WSP-20 | 路由可向持久 AppShell 注册 Header region，但不拥有物理标题栏；注册按 route scope + owner 清理，平台 portal 保留原组件 Context。Skills tabs/安装目标在 Header，搜索与目录留在 Content；切路由不能残留旧 Header | AppShellRouteHeaderRegion、PlatformViewRegions；Radix Context 回归、Skills→Storage 桌面验收 |
| WSP-21 | Terminal visual inset 与无 padding measurement host 分离；终端排版边界隔离正文 tracking/word-spacing/text-transform，字体与网格间距由 xterm 拥有，不覆盖其内部行补偿。测量、绘制、光标和 PTY 使用一致的 cell 度量，累计位置误差不能随列数增长；不仅 screen ≤ host，满行字符推进与末列光标也必须位于 screen 内（允许像素舍入容差）。字体/主题/zoom/隐藏后重显使旧网格失效；PTY resize 只发布变化后的最终 cols/rows | TerminalPanel、FitAddon、AppServerTerminalSession；真实字符 Range/光标边界、负/正正文 tracking、长 ASCII/宽字符、双向 resize、字体加载、隐藏重显与 PTY `stty size` 验收 |
| WSP-22 | Host 是 PTY/process 唯一 owner；Application 按 Conversation Scope 维护有序 terminal session 集合和最近激活项。Panel tab 只投影/更新 active session，切换到非 Terminal tab 不清空最近项。Agent 的 `read_thread_terminal` 仅通过调用 Host + Thread 的 binding 读取该 Scope 当前终端的有界输出，不接受 session ID、不枚举或跨会话读取 | ConversationTerminalSessionRegistry、ConversationBindingStore、Terminal Panel plugin、dynamic tool handler；多终端激活/关闭回退、Panel owner 与 resource owner 分离、非法参数/Host+Thread 隔离、UTF-8/截断测试 |
| WSP-22 | 导航 hover 与当前路由是不同状态：Theme Engine 定义统一 `navigation-hover/current/pressed` token，Design System `navigation-control` 解释 `aria-current="page"`/selected；Sidebar、Work、Settings 与平台 Shell 不得自定义停留背景 | Theme Engine/controls.web；明暗主题 token 测试、Skills↔Storage Electron computed-style 验收 |
| WSP-23 | Embedded Workbench 只拥有宿主右侧画布；外层 Sidebar、Explore/Chat 路由与 History 归宿主。嵌入 Composer 在 ready/show 前只读，hide 先撤销写 lease 但保留 Application、会话与 Panel；Host 侧仅消费 session snapshot/action，不复制会话真源 | EmbeddedWorkbenchElement、EmbeddedChatWriteAuthority、transient ConversationBinding；双跑/fallback 单测、真实下游产品页面与 Browser/Terminal Panel 验收 |
| WSP-24 | Sidebar Activity 按等你处理(review/error)→置顶→最近去重分区；running不独立分区，按置顶与最近归类且保留行内运行状态；等你处理组两行桌面最小48px、触屏密度最小56px；含工作目录的各组采用标题与辅助目录两行，桌面最小48px、触屏密度最小56px；无目录且无待处理状态时为单行桌面最小32px、触屏密度最小44px，最近内部running优先，运行行与其余行均按规范recency倒序（原生recencyAt优先、缺失时回退updatedAt），不再按对话创建时间排序；复用现有目录时间，不用输出片段或已读事件另造排序时钟，完成后退出运行优先，已读不参与排序。排序先于十条分页；日期标题按实际可见行连续日期段投影，不重排会话，不新增进行中分区或定时挪位。各区可折叠；只有最近区消费十条预算。可选产品参与筛选默认关闭，由插件判定与按账号存偏好，snapshot.data为空（loading/error/unsupported）时保留行；数据已就绪但creator/participants均为空时不匹配“我参与的”，仅在顶部筛选控件调整，不追加底部隐藏人数或显示全部入口；displayIdentity为null时插件不输出filter描述符，Shell隐藏菜单参与筛选组；身份恢复沿用账号mineEnabled偏好，身份消失不改写偏好。停用插件隐藏菜单参与筛选并恢复完整目录。标题搜索与稳定Server筛选由Shell持有。企业身份 badge按实际内容宽度右对齐，仅显示最近已识别发言人，未知时回退创建人，多人时追加总人数圆标（上限99+、tooltip保留精确人数），头像20px、间距4px、圆标24px，不保留空人数槽；无内容不占位，分组模式遵循hideRowBadge；稳定来源是 `serverOrigin.serverId`，Hub route、tenant、Host placement 与 Thread 状态正交。行内不显示Server图标/色点，Server身份仍供筛选与完整tooltip使用；项目目录位于标题下方辅助行，使用label/tertiary排版，弱于metadata/secondary日期分组；必要待处理状态仍使用metadata，无底板、色点或独立配置项；待处理状态与目录共用辅助行，以中点分隔，不重复运行中文字；长目录按正文可用宽度省略，完整目录保留在行tooltip。头像右侧仅保留原菜单尾槽，与头像间隔4px；pending/running/Goal/review/error/unread与菜单共用该槽，内容网格仅正文和头像两列，不再预留独立18px状态列；状态或菜单能力变化不得推动正文/头像几何，错误/待处理圆点保持5px中性灰，已完成未读通知点为5px主题蓝色（icon-accent）。触控与桌面共用同一 Activity 组件、状态与 Design System token，不分叉业务语义；仅瞬时 hover 与菜单命中区按当前输入能力适配；移动抽屉纵向菜单固定顶部，搜索与筛选随列表滚动；底部仅悬浮新建与设置，不显示个人头像/账号底栏。Activity 行容器独占 hover/选中底色，按钮与伪元素不得重复叠加背景，“…”入口背景透明，指针移到入口时行 hover 不断开；文档级当前输入信号令触控滚动不产生鼠标 hover 底色。无 hover 或当前触摸输入时，原44px菜单命中区保持可达；有状态时仅画pending/running/Goal/review/error/unread，无状态时仅画“…”；菜单打开或键盘焦点时以“…”替代状态，细指针hover同样切换，分支创建时只画瞬时spinner。三个点与状态不得并列或重叠绘制；鼠标 hover、键盘焦点和选中态各自独立 | client-hub-server.ts、MultiHost compatibility projection、SidebarActivityItem/ThreadRowMenu、同 Server 跨 Hub route/改名/状态正交测试、触控/鼠标浏览器验收与真实 Electron 窄侧栏验收 |
| WSP-25 | Web/Electron unified Sidebar 的桌面60px图标栏或移动抽屉纵向菜单只保留 Home，通过openChat恢复已有会话或草稿；桌面Conversations标题下的全宽New chat横条与移动端底部悬浮按钮复用navigateToHome新建草稿；移动新建与圆形设置按钮由Shell同排悬浮在滚动区上方，设置在右侧，不显示账号入口/底部底板，列表留出末尾空间；展开与收起时开关都属于 persistent titlebar，紧邻可见品牌右侧原地保留同一按钮；侧栏导航轨与 transient Header 不复制开关，不再追加 Write。浏览器标题栏不再保留独立下游产品/Home 按钮；transient/floating Header 不复制 Write。动态 action 必须进入 Header rail 测量和 macOS safe area | AppShellNavigationControls、window-chrome；展开/收起、persistent/transient、首帧宽度、真实浏览器和 Electron 点击验收 |



| WSP-26 | Right Panel 显隐与宽度模式正交：全局 Header toggle 唯一负责开关；Panel toolbar 只负责用户显式 maximize/restore。空间不足导致 auto-full-width 时不得重复 `Back to chat` 或呈现无效 restore 动作 | AppShell、ShellPresentation、RightPanel；auto/explicit full-width 源码契约与 Electron 窄窗验收 |
| WSP-27 | Frost 是独立 Theme ID，Light/Dark/System 与其正交；浅色 Sidebar material 固定为 `rgb(226 244 250 / 35%)`，不由其他主题的 material 动态推导 | theme-engine、appearance-theme；主题目录、持久化、CSS token 与真实 Electron computed-style 验收 |
| WSP-28 | Lavender 是独立 Theme ID，以下游产品 frontend 的低饱和紫色语汇投影完整 window/sidebar/panel/input/popover 表面；只改变主题色与材质，不复制组件 CSS 或改变字体、密度、圆角和布局 | theme-engine、appearance-theme；浅深色 semantic token、主题目录、持久化与真实 Electron 验收 |
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

## 证据纪律

共享 AppShell 标题栏不在会话标题前绘制装饰性代码／项目图标；会话标题、项目说明和导航操作保留，独立与嵌入模式遵守同一规则。

会话菜单仅呈现该会话的操作，不提供“在 Host 上新建任务”或“Host 设置”捷径；
这些能力继续通过应用原有的新建任务与设置导航进入，删除菜单入口不删除能力。

目标入口契约：无目标的可写会话通过 Composer 的“＋”菜单设置持续目标，
不保留独立创建胶囊或空白占位。Goal surface 拥有编辑草稿、弹窗和既有目标
进度；既有目标通过attachedContent进入Composer附属区，共享队列/摘要的边界与材质，不再独立悬浮反色胶囊。桌面一行显示状态/截断摘要/紧凑耗时与快捷操作；按Composer实际容器空间收起摘要和编辑按钮，菜单保留操作、触控最小44px；只读保留查看；complete为终态，立即退出附属区但不自动clear。已完成目标经“＋”菜单回看，可写Host保留显式移除及设置下一个目标，并允许编辑原目标或显式继续；已完成目标的编辑器预填原文，支持恢复原文，保存动作明确标为“保存并继续”，以同一原生目标 set(objective,status:active) 保留原周期计量，不清除重建。编辑期间收到完成事件保留草稿，只有用户显式保存并继续才恢复；只读Host仅可回看。新建经共享Runtime先读取并确认旧complete目标已clear，再set(active,tokenBudget:null)，新周期的耗时/token由原生从零计量；暂停/继续及编辑保持原周期。取消不写入；clear后新建失败保留只读完成摘要与草稿，不冒称原生旧记录仍在。摘要仅在当前资源/连接内存活，显式移除时清除；未知创建结果先读确认、不重复启动；连接更换阻止后续写入。普通消息和旧编辑不隐式重启。暂停/阻塞/受限态继续保留附属区入口。详情用Radix负责定位/外点/Escape/焦点恢复，编辑用ModalSurface与共享Button；切尺寸不重挂载Composer。Goal 文案、状态、错误与耗时通过现有 Intl/语言资源呈现；语言切换不重建编辑器、不清目标草稿，不翻译用户目标正文。新建草稿在 Host 支持可写 Goal 时同样提供入口，
确认后直接原生创建会话并设定目标，无需先发送普通消息；取消不创建会话，失败
重试保留已创建的 Thread，不重复开启目标。只读或无能力 Host 不提供创建入口，
切换会话撤销旧目标编辑但不得重挂载 Composer 或丢失输入草稿。

WSP-36 焦点视觉补充：鼠标/触屏按下由document统一记录指针来源；菜单/弹窗回焦保留真实焦点但非编辑控件不画残留outline。Escape关闭不切换输入来源；Tab/方向键/导航确认恢复键盘提示，单纯移动鼠标不抹掉键盘焦点。编辑字段自身的光标/选区/边框、按钮的选中/open/elevation保留；无强制blur。普通焦点颜色独立于品牌 accent，使用共享中性 token；旧 focus-ring 别名投影同一颜色。全局兜底的整个选择器为零优先级，组件自己拥有焦点呈现，不能被兜底重画外框。Composer 编辑区只保留光标/选区，不画外框；键盘按钮仍有可见中性提示，强制颜色模式尊重系统配色。真实 Composer 的鼠标点击、Tab、触摸以及无局部样式按钮的 fallback 必须同时验收，不能仅凭源码中的 `outline: none` 判定成功。

桌面面板 motion：共享 Design System 拥有加载矢量、两秒60步旋转与 Document timeline 同相；减少动态效果只撤销旋转，不改反馈盒几何。紧凑 outline 按钮状态即时投影主题色，不新增缩放或文字/连接遮罩淡入；触屏保留44px命中区且不粘 hover。插件只投影状态，不在动画结束后确认授权或撤销控制。真实组件验收包括分离挂载的相位、采样中间帧、按住反馈、减少动态效果和接管/停止几何；不把组件验证称为 Mac/iPhone 逐帧验收。

WSP-29/30 所有权补充：Renderer 的 capability 声明接受与 Engine 挂载 ready 分开。执行准备与替换共用 Host Thread 队列，停止/审批回复/队列删除不等待工具准备；owner 先撤销后清理，迟到提交失效；首次 native setup 挂载失败不发布新会话，已有历史不参与回滚。Bridge 仅透传允许列表错误码，不以截断字符串代替脱敏。

### 回迁后的固定嵌入与业务 SQLite

- Thread 记忆按现有 product/Host/Profile 加当前 account/region 作用域；未知账号归属的旧 selection 不转给新账号，不删原历史。账号撤销、路由/草稿代次及 Application 释放共同隔离晚到结果；隐藏/重新显示与重连不重建草稿或机器 authority。
- Node SQLite 一个物理文件只能有一个迁移/连接 owner；OpenCraft Host queue、sender、企业身份 presence/state 同库，metadata consumer 不再 CREATE 或独自关闭。Tasks/SSH 已发布 SQL/hash 不变，未知账本拒绝，已知旧记录在备份/原子转换中保留；没有空列表替代已知旧库数据。
- Local Agent 配置目录的 Tasks 属于启动 gate；可选 Codex Tasks/SSH 私有 owner 按功能真实使用打开，能力成功回执先验证数据。迁移 outcome 不代表全部可选引擎已初始化，不把失败库误报 ready。
- 验证：`tests/storage/downstream-sqlite-lifecycle.test.ts`、`tests/shell/workbench-product-icons.test.tsx`、`tests/chat/work-in-draft.test.ts`、下游 `products/<product>/tooling/smoke-product-isolation.mjs`。真实三面 release DOM、企业服务/RFC6455/AppServer bridge、浅深×DPR1/2 的外部边界为本地合成账号/Host；完整 gate、真实企业账号/推理/SSH/发布仍留后续阶段。

## Presentation power ownership

Hidden documents and explicitly parked embedded/settings conversation surfaces
stop Goal/command elapsed clocks without unmounting the Composer or stopping a
remote task. Reopening recalibrates elapsed time. A foreground command without a
reported start uses its first observation in that mounted view for the elapsed
label; a reported start takes precedence and completion uses the returned
duration. Observation time is presentation-only and never persisted as protocol
time. Background commands do not run an elapsed interval. Resident desktop viewers revoke
input and pause RFB pixel requests/continuous updates, retaining connection and
last frame; an in-flight frame may finish. Showing resumes observation, never
control. Native background shimmer also stops. Avatar 30Hz/ambient clocks use
their requested timer rate rather than a display-rate RAF polling loop; hidden
and reduced-motion policies still gate delivery. Visible running indicators stay.

## Startup and deferred presentation

The Application owns account, Host, navigation, drafts and optional activation.
A mounted presentation may acquire its code and styles, but cannot recreate those
owners or publish after retirement. Failed view imports remain retryable; successful
code may be cached without retaining a mounted View. Hidden pages do not advance
optional startup work. Deferred feature CSS must reach both standalone document
and embedded shadow presentations, and stop observing when the embedded owner
retires. Build graph, byte/request budgets, controlled cache probe and validation
boundaries are maintained in [startup performance](../../docs/startup-performance.md).

## Shared measurement transaction ownership

One measurement batch publishes a coherent height table, layout, viewport and
scroll decision. The synchronous controller distance and any pending transaction
own compensation; a callback's presence remains distinct from its current restore
value. Per-input baseline accumulation, latest-row notifications, pending restore
priority and platform-preservation/fast-path decisions retain their observed
boundaries. Web and Native keep their scheduling, lease and commit mechanics;
neighboring helpers and consumers are not rewritten.
