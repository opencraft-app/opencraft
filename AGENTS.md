# OpenCraft Agent 入口

本文件是OpenCraft服务根入口，独立GitHub checkout也必须能直接使用。独立仓库不要求不存在的父级脚本或内部文档。正式事实以当前源码、测试、生成契约和下列专题文档为准。

## 上下游迁移

GitHub `opencraft-app/opencraft` 是目标核心上游，产品身份来源、执行引擎和渠道经插件接入；核心仍拥有主体、授权和Hub分发。下游产品的业务装配（身份、品牌与企业服务）不属于核心。当前切换状态见[实际状态与来源清单](docs/upstream-transition.md)；不要用旧源码覆盖当前产品，也不建立两套可写核心。原贡献采用Apache-2.0，未核实第三方材料不因LICENSE自动获得授权。

## 当前上游化交付范围（2026-10-19）

公开核心独立运行、下游产品隔离、贡献/发布Skills、上下游固定版本与补丁链路是当前重点。清理自有主体中的旧品牌名称、额外来源注释和来源档案；保留第三方版权声明、许可证和必要NOTICE。法律来源权利核实与仓库内措辞分开处理，不把未核实项写成已核实。npm仍暂不发布；旧私有历史归档保留。真实权限、凭据、构建及受保护分支检查继续遵守。

## 完成标准

- “分析、看看、先别改”只授权只读调查；行为修改必须完成实现、相关验证，并在用户可见结果依赖客户端时验证真实 Web/Electron/Expo 呈现。
- 验证范围与改动匹配。相关检查通过后，只有出现新改动、失败或未决风险时才扩大或重复验证。
- 交接分别说明源码、构建产物、正在运行的窗口以及未验证的登录、模型、Host 或外部服务链路；测试通过不能替代当前客户端证据。
- 调试以当前日志、进程、协议响应、数据库只读查询或客户端状态为依据，不从最终 UI 症状猜测根因。

## 责任边界

| 区域 | Owner |
|---|---|
| `apps/workbench-web` | Web 与 Electron 共用的 Renderer、AppShell 和路由呈现 |
| `apps/workbench-electron` | 桌面窗口、私有存储、Preload 与 IPC |
| `apps/local-agent-host` | 本机执行、DSH 进程与 Host 能力适配 |
| `packages/` | 跨端领域语义、协议和稳定共享 contract |
| `plugins/` | 随核心提供的通用插件；私有产品插件由下游 workspace 持有 |

- DSH 是可替换的执行引擎，不是 Bot、模型、会话、凭据或产品配置的唯一真源。先确认对象身份、生命周期和唯一写入者，再修改页面或 adapter。
- 宿主只声明并呈现已接通的能力；不得用开关、菜单项或前端状态冒充协议、运行时或后端能力。
- 云桌面通用插件拥有桌面 contract、媒体和面板，不依赖产品账号、Bot 或企业云服务。产品 provider 只消费通用 contract/media 子入口，拥有授权绑定、资源准备和观看 attachment 交接，不拥有桌面 DOM、Shell 或 Chat 连接。依赖方向与回收顺序见 [云桌面插件边界](docs/cloud-desktop-plugin.md#cloud-desktop--downstream-product-plugin-boundary)；客户端只读状态不得代替后端输入授权。
- 主体与协作遵循[原生主体与 Hub 协作设计纲领](docs/architecture/actor-collaboration.md)：人类与持久 Agent/Bot/Session 都是主体，权限独立授予，Hub 负责准入与授权路由。该纲领是目标设计，不代表多租户已实现。现有 Client / Hub / Server 的连接、执行与 lease 契约见[执行所有权](docs/execution-ownership.md#client--hub--server-拓扑)；Renderer 是呈现机制，Host 是部署载体，均不能决定主体身份。
- 自然人身份是主对象，登录方式是身份绑定：[多种登录方式落到同一自然人](docs/architecture/actor-collaboration.md#多种登录方式绑定同一自然人)。本地账号、OIDC 与企业身份等身份来源共用核心 human Actor；权限、资源归属和审计关联 Actor，不随登录方式变化。绑定须验证身份，不按同名或相同邮箱自动合并；登录态与 Bot Session 凭据分开管理。Headless 随包提供每部署独立账号的官方服务端插件 `opencraft.account` 与可配置 OIDC，专用企业验证由可选插件接入；配置与已实现边界见[服务器登录](docs/server-authentication.md)。

## 按需加载

| 任务 | 必读入口 |
|---|---|
| 新增功能含 UI，或界面、设置页、列表、表单、弹窗的实现/改版/评审 | [维护 Skill 的 UI 路径](.agents/skills/opencraft-maintenance/SKILL.md#ui-任务先进入设计路径) → [设计入口](design.md)；按需读取专项，不等用户另外提出设计要求 |
| 平台、AppServer、Chat Runtime、Workbench、扩展 | [platform-architecture](docs/platform-architecture.md) 与命中的专题文档 |
| 工作区、工具面板、浮动聊天、Side Chat | [design](design/README.md)；实现变更通过 `design/invariants.md` 索引维护对应专题 |
| OpenCraft 架构、交互、布局、平台适配或预览 | [opencraft-maintenance](.agents/skills/opencraft-maintenance/SKILL.md)，按任务读取其验证清单 |
| iPhone 通过 Cloudflare Tunnel 打开 Expo Go 开发预览 | [opencraft-expo-cf-preview](.agents/skills/opencraft-expo-cf-preview/SKILL.md)；先轻量核对 Metro、隧道与外网 iOS manifest，再给完整明文 `exps://` 链接，提醒用 Safari 打开；不为日常预览下载完整 bundle。手机操作见 [Expo README](apps/mobile/README.md#iphone-真机快速体验) |
| Android 内测、正式 APK，或 iOS 测试 IPA | 先读 [手机端路线](apps/mobile/README.md#手机端路线) 和 [构建矩阵](docs/build-matrix.md)；按目标选择签名、包名及验证步骤 |
| Android 备案资料或临时局域网下载 | [Android 正式 APK](apps/mobile/README.md#android-release-apk)；从最终 APK 核对包名、签名证书和文件摘要，只开放 APK 下载路径 |
| 承载当前代理的 headless 预览服务切换或重启 | [opencraft-self-hosted-preview](.agents/skills/opencraft-self-hosted-preview/SKILL.md)；由独立服务完成切换与回退，重连后核对实际进程 |
| 下游产品 Agent Console 共享实现 | [历史与消费契约](docs/upstream-history.md)；同步边界由下游产品工作区维护 |
| Web、Expo、Electron 构建与交付 | [build-matrix](docs/build-matrix.md) |
| 公共 npm 发布、Web 更新部署 | [Web 发布与部署](docs/web-deployment.md#公共-npm-发布流程)，含包名、Trusted Publisher、精确归档与验收约定 |
| 从源码打包替换服务器本地 Web | [本地替换指引](docs/web-local-deployment.md)；先核对 `.local/README.md` 中的实际部署信息 |
| 开源提交、公开发布 | [安全与发布说明](SECURITY.md)；按 [opencraft-release](.agents/skills/opencraft-release/SKILL.md) 核对实际来源、隐私、依赖、固定tag和归档；贡献PR遵循仓库当前检查 |

- 参考 checkout 应固定版本并只读使用；独立仓库不要求根 `ref/` 目录。借鉴前核对版本和真实运行入口，说明借鉴的是交互、状态模型、组件 contract 还是视觉 token；参考代码和截图都不是产品事实。
- 参考开源代码时必须先理解思路与原理，再独立设计和实现，不得直接照抄或机械改写，并核对许可证兼容性、避免引入不兼容的许可义务；独立新实现不添加参考来源注释，既有来源记录以及许可证要求的版权声明、署名与 NOTICE 仍须保留。

## 手机端入口

- 公开 Expo 位于 apps/mobile，默认复用完整随包 Web Workbench；旧独立 RN 工作台已退役；显式下游产品入口由产品 runner 选择原 Router/账号/Bot。下游产品的 iOS 由 HeroUI Native 登录和操作控件、原生导航页面及 Bot 侧栏承载；账号与设置入口固定在侧栏底部，没有底栏。Bot 功能在 App 内打包的 frontend DOM runtime 中呈现；Android 同样使用产品已有随包 DOM 控制台，设备能力按实装声明。手机平台、构建方式和产物先按 [Expo 路线表](apps/mobile/README.md#手机端路线) 选择，不能把 Expo Go 预览当作可安装包。
- 修改 iOS Shell 或内置 Bot 功能时，先读 [Expo 局部 Agent 入口](apps/mobile/AGENTS.md)，由它路由 [Shell 状态](docs/mobile-shell.md)与[原生／DOM 桥接](docs/mobile-bot-bridge.md)；优先修改现有过时规则，避免把旧底栏、旧网页套壳等已失效方案追加成并列事实。
- 默认内置模式的 JS/CSS 与 Worker 必须预制在安装包中，远程只提供 API 数据和媒体。用户明确选择的自托管 HTTPS 网站模式遵循 [移动容器来源边界](docs/mobile-workbench-container.md)，不注入内置身份或原生权限桥接；不能在内置模式失败时自动切换远程网页。原生设备能力经平台端口接入，外部账号、实名与订阅页面交给系统浏览器。具体边界见 [Embedded Bot bridge](docs/mobile-bot-bridge.md#native-audio-and-packaged-code)。
- 手机端请求、缓存和离线写入先按 [移动数据协调契约](docs/mobile-data-architecture.md) 区分读取、在线事务与可持久化草稿；不得把 TanStack Query 的内存缓存、WebView 的独立 JS 环境或普通重试称为全 App 持久请求队列。账号展示缓存必须按会话与区域隔离，退出登录清除。
- 会话连续性按 [ChatUI 架构](docs/architecture/chat-ui/composer-and-drafts.md#跨桌面手机和平板的会话连续性)维护一个共享语义模型：Scope/View 身份、草稿保存与丢弃、前台追平条件属于共享包；桌面浏览器和手机/平板只适配存储、生命周期、手势与布局。V3 连接代次不能当持久 Replica 游标，旧消息缓存只可展示，不能授权发送或交互；任何私有缓存都要按账号和 Host 隔离，退出账号撤销对应作用域。不要因屏幕宽度另造一套业务状态机。
- 手机端读取状态按“可展示数据、最后成功时间、后台刷新、错误、会话有效性”分别建模：已有同会话数据时，后台刷新不得清空数据或切回全屏 loading；短暂失败保留旧布局并给轻量重试。只有冷启动且没有可用数据时显示与最终页面结构接近的静态占位，避免卡片消失、列表跳动和闪动菊花。缓存身份只能用于展示；实名、支付及账号安全操作在当前服务端状态核实前不可凭旧缓存放行。成功写入后精确失效相关查询，401、退出或切换账号/区域清除对应作用域。头像等媒体的缓存键只在资源确实改变时更新，不能每次普通刷新都强制重载。
- 修改手机读取页时先列出 `cold-loading / cached-refreshing / fresh / cached-error / session-expired` 五态，确认每态的数据来源、占位几何、可用动作和退出条件；实现中把 `data` 与 `isFetching` 分开，刷新只更新数据和轻量状态槽位，不能卸载整页、重置滚动位置或清空已渲染列表。重复进入时，首帧就从当前会话的内存缓存取值；不能等 `useEffect` 异步读取后才用缓存，否则仍会闪一帧占位。真正冷启动的占位按实际卡片和行高排布，禁用未核实的敏感操作。验收至少覆盖首次进入、30 秒内重复进入、后台恢复、断网再联网、刷新失败、401 与切换账号；逐帧查看是否出现短页、跳动或旧账号资料。细化策略见 [移动数据协调契约](docs/mobile-data-architecture.md)。
- 当需求指定 HeroUI Native/NextUI Native 的抽屉、弹层或其他交互控件时，要求涵盖**容器本身**的手势、遮罩、关闭、可访问性和动画；仅在手写 `Animated.View`、`PanResponder` 或普通 `View` 里放 HeroUI 按钮，不算使用该原生控件。实现前核对当前安装版本实际导出的组件及 Expo Go 支持；若库没有对应控件，选用可在 Expo Go 运行的成熟原生交互原语，并在 Task Pack 与交接中明确组件来源及例外，不能把它标为 HeroUI Native 抽屉。禁止引入 Unistyles。
- iOS 页面前进和返回统一经过可复用的原生导航页面容器：按钮返回与左边缘右滑必须走同一完成路径；拖动要跟手、未达阈值回弹、松手后补完动画。按当前**容器**宽度计算位移和阈值，窗口尺寸变化后重新测量，不能写死 iPhone 宽度或假定所有页面都是手机全屏 Stack。尊重系统减少动态效果设置，动画期间保留底层页面和 Bot runtime；从侧栏进入个人与设置时还必须保留侧栏的打开状态，返回应露出原侧栏，不能先关闭再推页面。状态栏与 Home Indicator 属于同一移动页面，不得留下独立横条。新增页面先复用这一层，再选择具体的手机、iPad 或折叠屏呈现方式。
- iPhone 外网预览提供完整明文 `exps://` 链接，在 Safari 打开并跳转 Expo Go；Metro 与 Cloudflare Tunnel 必须持续运行。为加快迭代，新链接只做轻量可用性检查（Metro 监听、隧道连接和 iOS manifest 响应），**不下载完整 bundle 校验**；源码的 Expo 类型检查和 iOS 打包仍按改动风险运行。链接失效时重新生成并做同样的轻量检查；不要把服务端检查表述为真机已验证。
- Android 内测包为 `dev.opencraft.workbench`，使用开发签名；正式包为 `app.opencraft.workbench`，必须使用仓库外的正式密钥。iOS 测试 IPA 须在有 Xcode 和 Apple 签名的 Mac 上构建。更换包名或密钥后，从**新成品**重新提取备案值。
- 本地 APK/IPA 打包、备案资料和临时局域网下载不等于 GitOps 发布。交接时分别报告源码 checkout、包名、签名证书摘要、APK 文件摘要、安装验证和下载进程状态；私钥与密码不得进入仓库、日志或下载目录。

## 代码与 Contract

- 在系统边界解析并校验未知数据，内部传递已收窄类型；一次性类型留在调用方，只有真实跨包 contract 才进入 `packages/`。
- Optional/nullable 字段必须表示真实缺失。默认值只在 authority 边界填充；声明但忽略的 capability、route、command 或 wire 字段必须删除或端到端实现。
- 协议变化必须同时检查声明、生成类型、Host/provider adapter、持久化/恢复、失败语义和兼容测试。共享 TypeScript 能编译不等于已部署 Host 兼容。
- 内建 UI Preferences 统一消费 `UiPreferencesRuntime`；插件的个人本地呈现偏好可消费可选 `api.localPreferences`，由平台隔离产品/插件/账号与激活生命周期、插件持有 schema；不代替业务文档 CAS 或共享账号 authority。React 不直接选择 localStorage、IndexedDB、SQLite 或远端存储。scope、adapter、CAS 和正式 key 以 [UI preference authority](docs/architecture/platform/storage-and-preferences.md#ui-preference-authority) 为准。
- Desktop 路径必须消费 [Directory identity charter](docs/architecture/product-identity.md#directory-identity-charter) 的唯一 resolver：生产数据根必须使用核心产品规范名称，旧产品目录只允许作为显式配置的幂等迁移输入；Main/Daemon/DSH 显式使用 runtime cwd，Thread workspace cwd 必须来自 Project/Thread，禁止回退 `process.cwd()`。
- Hermes 的 Console 适配源码和生成工具属于下游产品，不是独立核心的安装或默认检查依赖。下游产品工作区持有机械生成层；不得直接编辑，须修改其前端真源后运行该产品的同步及只读漂移检查，连同 `UPSTREAM.json` 提交。详见 [历史与消费契约](docs/upstream-history.md)。
- SQLite 表结构变更只在该库 owner 的 migrations 列表追加连续 version N+1；不得改写已发布迁移的 SQL 原文、名称或版本。生命周期与恢复契约见 [sqlite-lifecycle](docs/sqlite-lifecycle.md)。
- OpenCraft 自有 SQLite 的新增运行时 `CREATE TABLE` / `ALTER TABLE` 只由迁移执行；业务初始化与恢复不得另建表或按列探测补结构。测试 fixture 与下述保留的上游镜像不作为升级 authority。
- 所有 OpenCraft 自有 SQLite 库必须经 `openManagedDatabase` 打开并暴露 outcome；owner 负责独占生命周期、关闭和处置摘要，不得吞掉迁移失败后继续宣称 ready。
- 改表必须有从上一版本结构升级并保留业务数据的测试，以及已记录 checksum 不一致时拒绝打开的测试；空库测试不能替代升级测试。
- hypernode 的 `initializeSchema` 保持与 executions 基线一致，OpenCraft 不得依赖构造器建表或升级；改表同时维护 executions 基线迁移与初始化声明的一致性，运行 `tests/execution/dsh-execution-authority.test.ts` 指纹等价测试。已发布基线仍不可改写，后续版本追加迁移并让等价测试覆盖完整迁移链。

## 国际化

OpenCraft 所有自有客户端及内置插件的用户界面遵循[全项目国际化约束](docs/internationalization.md)与[locale authority](docs/architecture/platform/presentation-and-input.md#internationalization-authority)。新增或调整的可见/无障碍文案必须消费既有应用 IntlRuntime/IntlPort 和稳定 ID、英文 defaultMessage，包含动态状态、空态、错误和通知；不得把文案写死后依赖英文回退。用户内容/实体身份/协议/诊断不翻译。现有全项目检查与显式存量清单不表示所有旧界面已完成迁移，不为新增硬编码扩增 baseline。运行 check:i18n/test:i18n，并验证相关入口切语言保留草稿/焦点/选区；不要添加全局翻译器或重挂载编辑器。各客户端支持语言和原生 provider 接线以实际实现为准。

## 界面图标禁止 Lucide

OpenCraft 界面图标禁止使用 Lucide，包括 `lucide-react`、其他平台适配包及直接搬用其 SVG 路径。新增、替换与维护图标统一使用项目共享自绘组件（Web 为 `@opencraft/design-system-web/action-icons`，Native 为 `@opencraft/design-system-native/action-icons`，通用图形几何由 `@opencraft/design-system/action-artwork` 持有），缺少语义时在共享图标 owner 补齐，业务插件不另造一份。此要求覆盖此前允许 Lucide 的决定；既有残留应明确记录并迁移，不能以规则更新宣称已经全仓清除。

## UI 与设计系统

- 搜索/筛选及输入/提交组合先明确实际容器容量、关联分组与溢出优先级，遵循[集合工具栏约束](design/ui/collections.md#responsive-toolbars-and-related-controls)；共享布局复用现有 owner，验收保留触控、可读性及工作连续性。


新增或修改界面前，先读 [设计入口](design.md)，选择最接近的 Settings、任务/对象目录、Chat、Sidebar 或嵌入 App 范式，并查看对应真实消费者。执行方法见维护 Skill 的 [UI 工作流](.agents/skills/opencraft-maintenance/references/ui-design.md)：把范式落实为可见组合，从相关真实使用状态复核，记录实际看过的画面及判断；目录页继续按[组合规范与正反例](design/ui/collections.md)设计。默认延续 OpenCraft 现有设计语言，优先复用共享组件、交互原语和语义 token；缺少可复用能力时在正确 owner 扩展。用户明确指定视觉方向时按该方向调整，并保留可访问性与工作连续性。Token 数值仍由设计系统源码持有；隔离 App 的可用样式以实际宿主能力为准。不以无溢出、组件导入或生成截图代替视觉复核，不新增用户审批步骤。

### 微交互与交互动效的质量要求

- 微交互（Microinteraction Design）是触发、状态变化、反馈与结束/取消组成的完整交互；交互动效（Interaction Motion Design）是其随时间的呈现。将其视为功能完成度的一部分，不能以接入动画库、添加 `transition` 或静态截图好看代替打磨。具体设计与验收按 [微交互与动效](design.md#microinteractions-and-interaction-motion)。
- 实现前列出本控件实际涉及的状态、触发和退出条件，区分领域值、手势预览与视觉进度；明确唯一写入者及提交/取消边界。拖动、跨档、松手、恢复默认、异步确认等不能靠同一布尔值或任意延时串联。
- 共享动画基础设施与语义预设，按控件和交互阶段调参、编排。通用能力在现有共享 owner 扩展，局部特例留在控件内；不在业务中复制动画引擎、计时器或手势框架，也不把所有控件套用同一条曲线。是否采用弹簧、缓动或直接跟随由交互目的决定，不强制引入特定库。
- 按下反馈、拖动跟随、离散吸附与松手恢复分别设计。直接操纵期间保持响应，不让装饰动画拖慢有效值、布局或命中区域；反向/中断从当前实际呈现续接，旧动画及迟到回调不得覆盖新意图。数值、填充、刻度、标签和相邻表面的变化围绕同一状态协调，不能各自跳变或重复反馈。
- 精细度来自恰当的时序、层级和连续性；粒子、发光和最高档特效只在表达真实状态且有明确设计目的时使用，不作为默认质量标志。静止后应安静，不用持续装饰动画争夺阅读注意力。
- 动效不得成为交互成功的必要条件：减少动态效果时保留完整操作、明确反馈和最终状态；键盘、触控、取消、禁用及卸载路径同样完整。草稿、焦点、选区、滚动与承载业务的组件身份必须保持。
- 在真实消费者中查看全过程，至少覆盖本改动涉及的按住、跨档/边界、松手、取消、快速反向/重复触发和中断；核对减少动态效果、相关输入方式及主题/窄容器。记录实际看过的动态过程与问题，不能只检查终帧、CSS 参数、测试数量或截图。具体序列按影响选择，不建立每次修改都跑全站的门禁。

### 应用导航不变量

- 应用 Router 是路径、entry key、PUSH/REPLACE/POP 的唯一写入者；Electron 使用 Memory Router，Web 使用 Browser Router。入口在 `runtime/workbench-navigation.ts`，有无 Host 使用同一模型，不在页面手写 History API 或第二份 applicationRoute。
- `openChat`（回到记住的聊天）、`navigateToHome`（新草稿）、`openSettings` 与 `back/forward` 是不同意图；应用切换不得伪装成 `history.back()`。正常目的地进入历史，权限/失效路由纠正才 replace。
- Conversation 身份、View/routeScope 身份、历史 entry key 分开。相同会话不代表相同页面；路由或 View 改变必须通知消费者，POP 恢复目标 entry 的 View。
- 所有异步导航受意图代次与 owner 生命周期约束；新意图/销毁撤销旧准备及临时 lease。失败不能先修改历史再猜测回滚，迟到成功或错误不能抢回页面。路由显示不要求重建 Host/Thread/Draft。
- 历史按钮只是 Router 已知条目的投影，不是另一套导航权威。桌面内存历史不宣称跨进程持久化；Web 刷新回执不能替代实际 Router entry 校验。
- 修改导航必须测试真实 PUSH/REPLACE/POP 后的目的地、同会话多 View、hostless、快速切换/晚到结果、失败与失效页面返回；不能只断言调用了 go(-1)。正式行为和验收矩阵见 [应用导航](design/application-navigation/task_plan.md)。

| 层级 | 只负责 |
|---|---|
| Feature | 领域状态、语义选项和 action |
| Platform / Shell | 槽位、portal、拖拽区、碰撞、焦点和平台呈现 |
| Design System | 高度、圆角、间距、排版、颜色、图标尺度、菜单密度、状态和 motion |

- 按正确抽象层统一视觉，不按截图逐页补 CSS。发现参考产品差异时，先补缺失的语义 token、variant 或共享 primitive，再迁移消费者并删除旧局部实现。
- 文件夹等复合选择控件拆分三层：Host/Provider 声明可浏览范围并读取资源，Feature 只提交选择意图及业务写入，平台 Modal 与共享控件拥有焦点、键盘、按钮状态和呈现。组件样式留在组件边界；不得在 `app.scss` 为单个功能重造主按钮或把客户端目录误当成远端 Workspace。
- 主题色必须按语义成对消费（如主按钮背景与主按钮文字），不能拿正文色和页面背景色自行反推“反色”。修改复合控件时，在浅色、深色和至少一个扩展主题检查真实 computed 前景/背景及对比度，并覆盖正常、hover、键盘焦点、禁用、处理中和错误状态；变量未定义时不能依赖浏览器继承得到可读文字。
- OpenCraft 自有 Web DOM 不得暴露浏览器默认焦点描边。`focus.web` 压住 UA outline；主题化兜底焦点环只在键盘输入模式且 `:focus-visible` 时绘制，因为 iPhone 触摸输入框及弹窗自动聚焦按钮也可能匹配 `:focus-visible`。功能组件的 `:focus-visible`/`:focus-within` 描边或阴影必须服从触控模式，不能仅靠低优先级全局 reset；键盘 Tab 后须恢复可见焦点。原生 `showModal()` 预览统一记录打开来源，触摸打开时自动聚焦的按钮不画键盘环，Tab 导航后恢复。自动可聚焦的滚动容器也须检查；不要给不需要键盘/程序化焦点的内容容器添加 `tabIndex`。触屏按下反馈、键盘焦点与选中态分别建模。验收同时检查触控轻点、Tab 键、浅深主题和强制颜色模式；第三方 iframe/浏览器 chrome 不在此 CSS 所有权内。
- 焦点提示不使用蓝色或品牌 accent；普通键盘提示消费共享中性 focus token，强制颜色模式尊重系统配色。全局兜底选择器必须整体零优先级，不得压过组件自己的焦点呈现：Composer 编辑区保留光标/选区，不画外框。禁止用不断追加局部 `!important` 的方式争夺所有权；验收要在真实编辑器 DOM 上检查鼠标点击和 Tab，不能只断言 CSS 中出现了 `outline: none`。
- 跨扩展边界传递 `value/options/action`、`local/remote` 等稳定语义，不传具体图标组件、像素尺寸或 Feature CSS class。Web、Electron、Expo 可有不同物理实现，但消费同一 contract。
- 用户可见的按钮、菜单、弹窗、通知和状态文案只描述用户任务、处理结果与可采取的动作；不得把内部类型、协议、方法、状态名（包括 `pending`）或原始诊断信息直接写到界面上。缓存命中、旧数据、后台刷新和重试次数属于实现状态，不作为姓名、头像或业务状态旁的标签；仅在用户需要处理失败时给简短提示与动作。排障细节写入开发者模式可见的安全日志，不占主要操作位，也不泄露私密数据。
- 处理中反馈在原控件或原反馈槽位使用简短、尺寸稳定的文案或图标；不得追加技术状态说明或动态长文案，撑大弹窗、按钮、菜单、列表项，或造成相邻布局跳动。窄屏和触屏也须验证该约束。
- 局部 loading、retry、badge 在既有槽位原位替换。异步操作失败统一走 Workbench 非阻塞通知（`AsyncNoticesProvider/useAsyncNotices`），在右上角独立覆盖层呈现，不抢焦点、不阻挡操作；禁止在菜单、列表行、表单或附近追加错误块以致容器增高或相邻布局移动。通用 Toast API 支持 info/success/warning/error；业务按需通知，避免每个成功请求都弹窗。通知铃铛提供当前页面会话历史，不能充当审批任务或持久收件箱。同一操作/实体重复通知合并；通知按完整/嵌入 Workbench owner 隔离并随其释放。输入校验属于输入控件语义，使用稳定预留槽位；加载失败的空状态消费原内容区域，不追加第二块错误。
- Mutation 的状态与反馈作用域必须和用户操作一致：行级/控件级操作使用独立 pending key，并在原控件槽位反馈；不得借用父级表单的 `dirty`、全页 `busy` 或路由 loading，导致无关编辑区展开、折叠、禁用、滚动或焦点变化。只有用户实际编辑父级表单字段时，父级 draft 才能变脏；用 held-promise 测试断言请求进行中布局与 draft 不变。
- 菜单、Popover 和 Dialog 使用项目已有 Radix/Modal 基础设施，不手写键盘、焦点、关闭、遮罩或嵌套行为。新增共享视觉 contract 时，用测试证明业务层不再持有已上收规则。
- 列表、树和多行侧栏中的临时菜单先定义互斥范围与唯一 owner：若同一容器同时只能有一个菜单，就由容器持有按稳定实体身份与入口类型标识的打开项，逐行 Radix Root 受控投影；不要让每行未受控的 `open` 状态各自决定全列表可见性。右键与“…”可以有独立触发区和事件，但切换行/入口或选中会话须关闭旧菜单，容器卸载须释放状态；旧菜单迟到的关闭事件只能清除自身，不能覆盖新菜单。触控连续点击不同菜单、菜单项、空白处与键盘操作都要作为回归序列验证。

### 会话时间线所有权

- Conversation 中“执行轮次”与“展示分段”不是同一所有权：一个 Turn 可以包含异步提问、多次回答与 Steer，必须按原顺序投影连续片段，不能将用户消息、回答和工作记录分别全局收集后重排。折叠只改变片段可见性；异步提问不因原生 final phase 获得最终回答资格。顺序、片段身份和当前响应判定归共享 `chat-core`，Web/Native 不各自补排序。执行状态与总用时仍只有一个 Turn owner，Thinking 最多一个当前 owner；测试必须覆盖同轮次多次跟进、折叠、补历史、刷新和流式 DOM 身份。

### Typography 所有权

UI 任务按需读取 [UI 专题索引](design/ui/README.md)，字体任务继续读 [字体语义与检查](design/ui/typography.md)。既有 `typography.tokens.json` 是唯一数据真源；Typography Role、TextTone、平台渲染策略分开，业务不得直接编辑生成的 `_generated.web.scss`。字体改动运行 `npm run check:typography` 与 `npm run test:typography`，可见变化按专题做真实呈现验收。

## 验证

| 改动范围 | 最小有效验证 |
|---|---|
| 单 workspace | `npm run typecheck --workspace <package>` + 相关聚焦测试 |
| 跨包 contract | 两端 typecheck/test + `npm run check:boundaries` |
| Bot/Host | `npm run test:bot-management`，再按风险补 adapter/runtime 测试 |
| Agent Console 同步（仅下游产品） | 在下游产品目录运行该产品的同步与只读漂移检查；公开核心不提供私有转调 |
| 广泛共享或交付矩阵 | `npm run gate` |

变更后至少运行受影响的聚焦测试。视觉、窗口、Main/Preload 或原生能力还需按 [维护验证清单](.agents/skills/opencraft-maintenance/references/verification.md) 选择真实组件与桌面验收。

## 开发与预览

开始前核对当前分支、dirty worktree 和已有预览。只在当前 checkout 安装依赖和构建，不借用其他 worktree 的 `node_modules`、输出或登录 profile。

| 目标 | 命令与边界 |
|---|---|
| Web 轻量预览 | 在仓库根目录运行 `npm run dev:web`，使用终端实际 URL。固定地址时先运行 `npm run build:preview-bridge`，再运行 `npm run dev --workspace @opencraft/workbench-web -- --host 127.0.0.1 --port 5173`。不包含 Main/Preload、IPC、本机 DSH、原生 chrome 或系统能力。 |
| Electron 当前源码 | 先运行 `npm run build:electron`；创建 `preview_profile="$(mktemp -d /tmp/opencraft-electron-preview-XXXXXX)"`；再运行 `npm run start --workspace @opencraft/workbench-electron -- --user-data-dir="$preview_profile" --remote-debugging-port=9333`。端口仅为示例，启动前确认未占用。 |
| macOS 打包预览 | 仅在验证签名、打包资源、原生 helper、安装路径或最终桌面行为时运行 `npm run package:electron:mac:arm64:preview`；使用隔离 worktree/profile，按 `docs/build-matrix.md` 验收。 |

- Renderer 重建后旧窗口不会热更新；关闭旧预览并用新构建、隔离 profile 和新调试端口重启。
- Electron Main 必须由仓库 `start` 入口启动；不得用 `node dist-host/main.cjs`，也不得让父环境的 `ELECTRON_RUN_AS_NODE=1` 进入 Main。该变量只属于明确以 Electron 二进制承载 Node bundle 的 Daemon/工具子进程。若 `require("electron")` 返回二进制路径字符串、`app` 为 `undefined` 或模块找不到，先检查实际可执行文件、参数和 `ELECTRON_RUN_AS_NODE`，再用同一 Electron 二进制的最小正常 Main 对照；这类结果本身不能证明 Electron 版本回归或缓存损坏。
- `opencraft://` 是全机 scheme。发起系统浏览器登录前确认 LaunchServices 实际指向本次预览；浏览器打开不等于回调已进入当前窗口。不得为排查批量注销其他预览或读取回调 code/token。

### macOS 签名包交付

- “重新打包/签名”默认包含重新构建与本地验收，不包含覆盖 `/Applications`、终止用户实例或上传发布。先核对分支、未提交改动与目标架构；使用新的独立输出目录，保留旧包，记录 buildId 和实际包含的源码状态。
- 分发包与 ad-hoc 预览包分开。实时检查 `security find-identity -v -p codesigning`，选择有效 Developer ID 并强制签名；不可凭记忆写死身份。签名身份、公证凭据和公证结果是三件事，环境变量为空不能证明钥匙串里没有凭据。
- `.app` 签名不代表 DMG 已签名；最终 DMG 必须单独验证。签名/公证完成后再生成最终 ZIP、DMG 和 blockmap；封包后若修改或重签制品，须重建受影响的归档、blockmap 与校验和。
- 交付分别核验 App 深度/严格签名、DMG 签名及镜像校验、ZIP 完整性、Gatekeeper/公证状态和隔离启动。`Unnotarized Developer ID` 必须明确报告，不能称为已公证或 Gatekeeper 就绪。
- 隔离启动同时隔离 `--user-data-dir` 与 `OPENCRAFT_MODEL_STORAGE_DIRECTORY`，清除 Main 的 `ELECTRON_RUN_AS_NODE`；不复制真实凭据、不付费推理。核对包内 Renderer/Daemon/DSH 构建身份，避免验证了旧窗口。
- 详细命令和证据清单见 [签名包运行手册](docs/build-matrix.md#macos-developer-id-签名包运行手册)。保留未通过的质量门禁，不以签名或能启动替代完整功能验收。

## 硬边界

- 本仓库是独立 npm workspace，保留自己的 `package-lock.json`；不得与下游产品的 workspace 或锁文件合并。
- GitHub 是目标核心上游，下游产品持有私有装配并固定版本消费；当前切换状态见 `docs/upstream-transition.md`，不要恢复旧单向镜像或双写。旧私有仓库仅为有界历史和回退证据。
- OpenCraft 校验或构建不得隐式触发下游产品构建、GitOps、发布、生产或云资源修改。
- 构建产物、`node_modules`、本地日志、隔离 profile 和机器路径不得进入 Git。
