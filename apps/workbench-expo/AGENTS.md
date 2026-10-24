# Expo 手机端 Agent 入口

公开实验入口 `OPENCRAFT_EXPO_WORKBENCH=web` 复用完整 Web 触控工作台；Expo 只拥有原生容器能力，不能复制会话、草稿、导航或面板状态。当前默认仍为 RN；实验入口与下游产品选择互斥。改动先读 [打包 Web 工作台](../../docs/mobile-workbench-container.md)，区分浏览器/打包与双端硬件验收，不能在能力未对齐时切换默认或删除回退。

先遵循仓库根 [`AGENTS.md`](../../AGENTS.md)。本文件只把手机任务路由到当前设计，不复制完整实现。

公开默认入口装配既有 RN Workbench/Composer 与直连 Host。下述下游产品登录、Bot、Router 和发行身份规则属于显式下游产品，由下游产品 `products/<product>/run-expo.cjs` 选择；不能让公开构建隐式要求其账号或 Bot 生成物。通用入口的能力与本地产品选择见 [Expo README](README.md#public-and-downstream-product-entries)，私有源码与生成工具已由下游持有。

| 改动 | 先读 |
|---|---|
| iOS 抽屉、账号入口、页面返回与手势 | [Mobile shell](../../docs/mobile-shell.md) |
| 原生与打包的 frontend Bot DOM 通信、Bot 功能 | [Embedded Bot bridge](../../docs/mobile-bot-bridge.md)、`frontend/src/mobile-dom/entry.tsx`、`products/<product>/native/src/components/mobile-bot-host.ios.tsx` |
| iOS Bot「对话」、会话、输入框与传输 | `frontend/src/pages/marketing/opencraft-embedded-workbench.tsx`、`products/<product>/native/src/components/mobile-bot-host.ios.tsx`、`@opencraft/mobile-bot-bridge` |
| 账号缓存、后台刷新、会话隔离 | [Mobile data architecture](../../docs/mobile-data-architecture.md) |
| 构建、Expo Go 预览、签名包 | [Expo README](README.md)、[build matrix](../../docs/build-matrix.md) |

修改导航前先写用户操作序列和语义目标，再改 `products/<product>/native/src/runtime/mobile-shell-model.ts`；原生手势只负责实时位移，不能再维护一份业务页面栈。Bot WebView 和抽屉须保持挂载，账号页返回要露出原抽屉。手机、iPad、折叠屏以实际容器尺寸和安全区决定几何。

自适应 Shell 的呈现由 `products/<product>/native/src/runtime/mobile-shell-layout.ts` 和集中视觉指标决定：窄容器用抽屉，能同时容纳侧栏与最小内容宽度时用可收起的常驻侧栏，账号按自身容量切换页面/面板。切换断点只改几何，不能重设 Bot、Thread、Draft、导航目的地或用布局模式当 React key；保持同一棵内容树，选择功能只收起浮动抽屉。嵌入 Chat 的断点必须读扣除外层导航后的实际容器宽度。面板安全区由外层一次处理，内容不重复补全屏 inset。验收分别记录模型测试与 iPad 真机横竖屏、分屏/窗口缩放、浮动/外接键盘证据，不能互相替代。

抽屉手势先核对当前安装的 Gesture Handler 2.x API：横向抽屉与 WebView 原生滚动须显式建立手势关系；本次触摸若已判给纵向滚动，不在中途抢夺，抬手后的新触摸重新仲裁。动画收尾期间仍可接收反向拖动：先取消旧动画，再从当前共享进度接续；旧完成回调不得覆盖新手势。保持横向激活距离和纵向失败阈值，避免网页竖滚被整页横滑吞掉。参考维护者的 [Gesture Handler 2.0 工程文章](https://swmansion.com/blog/introducing-gesture-handler-2-0-50515f1c4afc/)、[手动手势与触摸事件](https://swmansion.com/blog/introduction-to-manual-gestures-and-touch-events-a1dde7c98612/)、[2.x 手势组合](https://docs.swmansion.com/react-native-gesture-handler/docs/2.x/fundamentals/gesture-composition)、[Native 手势](https://docs.swmansion.com/react-native-gesture-handler/docs/2.x/gestures/native-gesture)、[Pan 阈值](https://docs.swmansion.com/react-native-gesture-handler/docs/2.x/gestures/pan-gesture)和 [Reanimated 动画中断](https://swmansion.com/blog/controlling-and-customizing-animations-in-reanimated-2-cee2d5d21285/)；不要直接套用 Gesture Handler 3.x 示例。验证序列包括打开途中立即反向、关闭途中立即反向、网页竖滚后不抬手横移、抬手后立即横滑，以及网页内横向控件。

修改 Bot 功能时保留 `frontend/` 原组件与领域逻辑，优先改共享源；原生侧栏只负责选择与容器。跨 WebView 的新命令或消息先改 `@opencraft/mobile-bot-bridge`，同时更新两端、协议测试和文档。未知 JSON 在边界验证；消息必须匹配协议版本及本次 runtime ID。不要把 token、账号 ID、URL 查询、正文或响应体写入开发者日志。
当某个 Bot 功能要求原生化，先确认它的内容和操作链均不依赖 WebView/DOM；只把画面换成 RN 而继续向隐藏 DOM 发命令不算原生化。复用 frontend 的纯业务客户端，以随包构建和平台端口接入原生网络/认证；端口上下文必须逐请求绑定 Bot 实例、Profile、账号和区域，切换时屏蔽旧结果。原生 UI 的视觉无需逐像素复制网页，但能力缺口须在 Task Pack 标明，不能静默删除既有操作。
替换完整功能页前先列出原页能力矩阵，覆盖任务类型、创建/编辑/删除、筛选、历史、依赖、错误恢复及跨页返回；逐项对齐后才切产品入口。功能尚未对齐的原生页保留为未接线实现，不能让用户落入缺失操作的页面。跨页控制器或会话投影须持续挂载，切换「定时任务 → 会话」等相邻功能后仍能收到命令并保留原会话。
App 的运行时代码必须随安装包预制：禁止远程 JS、CSS、动态模块、脚本 Worker 或回退到线上页面；API 数据与代码资源分开。构建须内联或打包依赖，并用 CSP 禁止网络脚本、样式与嵌套文档加载，不能只拦截主页面导航。Expo Go 的 Metro 开发通道仅用于开发，不是正式包运行策略。
麦克风、文件等设备能力由平台适配器负责；内置 DOM 消费明确的原生能力端口，不自动回退到浏览器权限接口。跨端共享听写状态、取消/重试和草稿写入所有权；录音权限与设备生命周期各平台独立实现。原生系统权限不能绕过，Expo Go 授权主体也不同于正式 App。设计见 [Embedded Bot bridge](../../docs/mobile-bot-bridge.md#native-audio-and-packaged-code)。
打包的 Bot HTML 虽在 WKWebView 中运行，站点 `baseUrl` 仍让它具备联网能力，不能称为严格沙箱。原生宿主只准首次加载本地文档；其后的主文档或 iframe 导航必须由导航策略拦截，并按 Bot 路由、外部页面或拒绝处理。绝不永久放行站点根路径 `/`；重试必须重新挂载打包 HTML，不能重载当前 URL。修改这条边界时覆盖“首次本地加载、跳到线上主页、功能路由、外部链接、iframe”的回归测试。

下游产品 Agent Console「对话」复用 OpenCraft Web Chat/Composer，与其他 Bot 功能一起打包到本地 DOM 容器；此入口不挂载 RN Chat 或 AgentChat。原独立 RN Workbench 保留自己的入口。更改 Chat 时先分清 `chat-core` 共享模型、Web/RN 渲染与下游产品传输适配三层，切换 Bot 要释放旧运行时。
草稿文档由共享 Conversation View 连续性模型保存，Expo 用 SQLite 适配并按凭证作用域隔离；前后台与网络事件只向共享返回探针报告状态，当前会话由 Host 运行时追平。iPad、折叠屏和手机沿用同一 Scope/View，不随断点生成第二份草稿或会话；几何只取容器尺寸和安全区。
修改 Chat 折叠、虚拟列表或定位前先读 [ChatUI architecture](../../docs/chat-ui-architecture.md) 的滚动契约。复现要覆盖宽度变化后的迟到测量、远处跳转、目标缺失、流式输出期间定位以及键盘/容器尺寸变化；修测量代次和几何事务，不另建滚动控制器、用固定延时判目标缺失或提前卸载仍可见的窗口。模型测试与 iOS bundle 只能证明各自边界，不能声称已经证明真机流畅度。
DOM Chat 由 Web visualViewport 契约管理输入区和列表容量，外层只处理一次安全区；独立 RN Chat 由移动键盘布局层统一管理键盘进度、占位和输入区容量。不得在输入框、页面外壳和列表各补一份固定键盘高度或叠加多个避让器；细节见 [Mobile shell](../../docs/mobile-shell.md)。

原生控件默认用 HeroUI Native 和既有设计 token。 左右侧栏入口复用 `@opencraft/design-system/sidebar-toggle-glyphs` 的桌面图形，光学尺寸与触摸范围分开；不得恢复大块底色的汉堡菜单。当前安装版没有抽屉容器，iOS 抽屉手势由 `products/<product>/native/src/components/interruptible-mobile-drawer.ios.tsx` 的 Gesture Handler/Reanimated 容器承担；不能把里面用了 HeroUI 按钮就描述成 HeroUI 抽屉。禁止 Unistyles。视觉例外要记在对应 Task Pack，并复用已有 token，不从截图抄散落色值。
平台入口扩展 Metro resolver 时须委托已有 resolver，保留 Uniwind 的组件解析；样式扫描路径须覆盖依赖的实际安装位置。组件能导入、类型检查通过不代表库样式生效，验收应检查实际布局、选中态与指示器位置，不能用逐页手写样式掩盖基础接线错误。

侧栏功能/账号行复用 ListGroup 的前缀、正文、说明和后缀槽位，账号头像复用 Avatar 与 expo-image 缓存适配，加载和分隔线复用 Spinner/Separator。会话操作使用受控 Menu，整个列表只持有一个打开项；重命名草稿、删除确认与临时菜单分开持有。Web 键盘策略复用 `mobile-menu-focus.web.tsx` 的 Radix 原语，不能让旧菜单关闭覆盖新菜单或抢走编辑器焦点。HeroUI 1.0.10 的 [Menu 测量补丁](../../scripts/patch-heroui-menu-measurement.mjs) 在升级库时须复核是否可移除，不能在页面伪造坐标或强行开启透明菜单的点击。

复杂原生表单要分开草稿、服务端已确认值、验证、提交代次和冷却时间；收到后台刷新或过期响应时，不得覆盖用户正在编辑的草稿。表单提交先走共享 SDK 的操作和校验，服务端仍是实名、账号安全与支付的最终执行者。编辑器只维护输入与展示，不复制后端业务规则。

验证只选触及的路径：协议与状态模型测边界/迟到消息，下游产品 DOM 功能在 `products/<product>` 运行 `build:mobile-bot-runtime` 和 `smoke:mobile-bot-runtime`，Expo 改动跑 typecheck 与相应 iOS bundle。交互变更要有可复现操作和实际运行时观察；不把每次改动都变成强制截图或全仓门禁。给新预览链接时使用完整明文 `exps://` URL，只轻量核验 manifest，告知 iPhone 用 Safari 和美区 Expo Go 打开。

下游产品通过自己的发行配置选择地区包，包标识、URL scheme 和 OIDC 回调必须成套匹配；开发入口的安装标识与回调连续性由产品维护。登录页不显示地区选择。站点覆盖只放在开发者模式，需登出后切换，不能将旧站点的凭证、Bot 或缓存带入新站点。改发行身份时同步核对产品配置、构建脚本、认证服务回调清单及 [Expo README](README.md#native-sign-in)，并验证多包可同时安装且各自收到回调；公开默认入口不选择私有地区或账号。

文档维护按“一个事实、一处权威”处理：改现有过时段落，再加必要的短规则；README 讲使用方式，本文件讲 Agent 工作边界，设计文档讲不变量，源码与测试讲当前行为。不要叠加一次性故障禁令或保留与现状冲突的旧描述。

平台路由的默认文件也会被 Expo Router 扫描：`src/app/` 入口只委托给平台解析的组件，iOS Shell/SQLite/WebView 依赖放在 `.ios.tsx` 实现中，不能在默认路由显式导入 `.ios`/`.native`。Android/Web 消费各自运行时；涉及入口导入图的改动须运行 Expo Web 导出和 iOS bundle，避免仅凭 `Platform.OS` 的渲染条件误判模块隔离。

## 统一 Agent Console

聊天右栏的标签状态与资源生命周期归原 `WorkbenchPanelService`，Expo 只提供原生控件、触摸输入和实测容器几何，入口为 `mobile-agent-panels.shared.tsx`。原有标签栏、下拉菜单、空态和内容完整保留在同一个本地 DOM runtime 中运行；本轮不重写面板内部控件，不另造标签管理弹窗。不能为每个标签另开网页、另造 Application 或复制文件/浏览器业务；同一本地 DOM 父布局分配聊天与右栏的兄弟槽位：宽容量用真实并列列宽，窄容量才覆盖；内层 AppShell 必须消费自己的槽位宽度。按钮和拖动统一交给这个布局的可中断显隐进度，不在原生层再写一份右栏可见性。宿主与完整 DOM 面板的边界按 [面板宿主契约](../../docs/mobile-bot-bridge.md#chat-panel-host-presentation) 维护。命令须校验 runtime、实例/Profile 和当前会话 owner；尺寸变化只改几何，关闭标签和释放资源仍走原服务。

`/agents-next` 是并行的 Expo Web 入口，本轮不得替换官网 `/agents`。导航呈现真源是 `products/<product>/native/src/components/mobile-agent-navigation.shared.tsx` 和 `mobile-agent-sessions.shared.tsx`，Web 构建入口是 `products/<product>/native/src/runtime/agents-web-entry.tsx`。Next 只适配认证、资源加载和外部导航，不再实现 Bot/会话业务规则。侧栏采用 Bot 头像竖列＋当前 Bot 的功能/会话面板，创建是图标列末尾的加号；不得恢复旧 Bot 卡片列表。切换 Bot 保留侧栏展开，选择功能/会话只收起浮动抽屉。「日常 / 探索」使用 HeroUI Native Tabs 及其 Indicator/Content，保持库的选中语义和动画；分类栏固定在 Bot 标题下方，功能/会话列表在它下面独立滚动；分类切换只过滤导航投影，不选择功能或重建 Bot runtime。切 Bot 不清空功能树或插入整页 loading；消费共享导航连续性模型，复用目标 Bot 的显示快照、保持分类与稳定行 key，等待当前投影期间禁用旧操作。首次目标可保留非交互功能布局，但不能展示其他 Bot 的会话；缓存按运行时/账号/语言隔离并有上限，细节见 Mobile data architecture。侧栏内部不放重复的 X 折叠按钮；收起由 Shell 菜单开关与现有手势承担。

手机、折叠屏、平板、桌面 Web 与 Electron 是同一产品状态的不同宿主。折叠/展开、分屏、连续缩放只按实际容器空间改变几何；禁止以设备名/UA 分支创建第二棵业务树，禁止以断点为 key 重建 DOM、会话或草稿。系统键盘、文件和返回操作留在平台能力适配层。本轮不需要 Android 独立入口或 Electron 入口接线；通过共享组件和 mount/update/dispose 端口保持演进边界。未做硬件测试时不得宣称折叠屏、iPad 键盘等真实体验已验证。


## 设计约束：iOS 交互基线，OpenCraft 设计语义

本节约束选择与所有权，不授权每次任务重新设计配色、圆角或动效。正式契约见 [Workbench design language / Expo design constraints](../../docs/workbench-design-language.md#expo-design-constraints)。

- 动手前列出控件语义、现有所有者、安装版 API、表面上下文与需要保持的交互状态；不能以“用了 HeroUI”“看着高级”代替验收。默认保留库的组成、槽位和交互契约，再按真实平台需求适配，不机械复刻系统 Settings。
- 普通表单使用 TextField + Label + Input，按需 Description/FieldError；布尔项用 Switch，互斥项用 RadioGroup，折叠选择用 Select，内容分类用 Tabs。动作使用 Button，行和身份使用 ListGroup/Avatar，加载和分隔使用 Spinner/Separator。不要用带勾的 Button 冒充完整选择控件。
- 功能文件只分配布局、内容和槽位；视觉角色先进入已有 design-system/移动品牌适配，再投影到 HeroUI。禁止逐页覆盖输入描边、按钮圆角、字体、阴影和按压层，禁止新造第三套控件/主题 registry。已有 Workbench adapter 是迁移入口，不另开平行组件库。
- focus、invalid、disabled、pressed、selected、pending 分开建模。触屏输入的焦点处理走集中平台适配，保留光标/选区和 Web、外接键盘可见焦点；不能全局去掉 outline，不能给库动画再叠一份 opacity/transform 驱动。光学尺寸不替代至少 44pt 的触摸容量。
- 弹层先区分短编辑、确认、选择菜单和页面导航；菜单/弹层用库原语，Shell 继续拥有页面栈、持久面板、几何、安全区及唯一键盘避让。按实际窗口容量适配手机/pad/桌面，不按设备名硬切；表单不得因断点、键盘或刷新重挂载并丢失草稿/焦点。
- RichText/原生输入事务、虚拟列表和内置 DOM 保留专业适配边界；“原生化”不得复制业务逻辑或机械替换成普通 Input。库缺失能力的例外须在 Task Pack 说明缺口、所有者、覆盖范围和验收，不要求用户为常规可逆实现再审批。
- 验收看真实控件的静止/按压/焦点/错误/禁用/提交状态；编辑类再测选区、提交/取消、键盘、长文本、字体放大和窄/宽容量。区分源码审计、浏览器替身、真机证据；不要把现有债务描述成已整改，也不为每次修改新增全局截图门禁。
