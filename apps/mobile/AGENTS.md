# Mobile container

Follow the core AGENTS.md, design.md and docs/architecture/mobile/mobile-workbench-container.md.
The only public entry packages the actual Web Workbench. Do not restore a parallel
RN chat, composer, settings or workbench state tree. Expo owns native lifecycle,
recovery, source selection and device adapters, never conversations or insets.

The default code is bundled. The user may explicitly select a self-hosted HTTPS
website in native settings. This is not an automatic fallback. Validate the URL,
keep source changes transactional and fence retired views/messages. Remote sites
must not receive the bundled document's privileged identity, credentials or native
bridge. The native source control must remain usable on network/process failure.
Preserve bundle IDs and user data.

Expo Go is a required development preview. Use compatible SDK modules; native
material/permissions have runtime capability fallbacks. Do not require a custom
native client for the basic workbench. Protocol tests, browser rendering, native
JS bundles, signed binaries and physical devices are distinct evidence.

Web owns keyboard geometry, safe areas and memory navigation. Every source fills
the screen; the container adds no inset and never branches on source or platform;
Android back uses Web navigation for bundled content and WebView history only in
website mode. Resize/foreground must not remount the working app.

There is no downstream product entry: no product router, account, Bot or
config hook, and no native dependency only a product needs. Products keep their
own Expo app; no private code enters core. Use shared self-drawn icon
components, never Lucide. Keep required third-party notices. Temporary assets, logs, dependencies and preview URLs stay out of Git.

Build: npm run build:web-workbench --workspace @opencraft/mobile.
Preview: npm run dev:expo -- --go. For external iPhone links use the core
opencraft-expo-cf-preview skill, verify the actual external manifest, and report
unverified hardware/auth/model paths honestly.

## 手机端细则

- 公开 Expo 位于 apps/mobile，只是承载完整随包 Web Workbench 的 WebView 容器；旧独立 RN 工作台已退役。apps/mobile 不再提供下游产品入口（Router、账号、Bot、产品 Expo 配置），原生依赖只保留容器自身使用的模块；下游产品如需原生账号、导航或 Bot 界面，自行维护独立的 Expo App。手机平台、构建方式和产物先按 [Expo 路线表](README.md#手机端路线) 选择，不能把 Expo Go 预览当作可安装包。
- 修改手机容器时先读 [Expo 局部 Agent 入口](AGENTS.md)。[Shell 状态](../../docs/history/mobile-shell.md)与[原生／DOM 桥接](../../docs/history/mobile-bot-bridge.md)记录的是下游产品 Shell 的历史设计，apps/mobile 不再承载；优先修改现有过时规则，避免把已失效方案追加成并列事实。
- 默认内置模式的 JS/CSS 与 Worker 必须预制在安装包中，远程只提供 API 数据和媒体。用户明确选择的自托管 HTTPS 网站模式遵循 [移动容器来源边界](../../docs/architecture/mobile/mobile-workbench-container.md)，不注入内置身份或原生权限桥接；不能在内置模式失败时自动切换远程网页。原生设备能力经平台端口接入，外部账号、实名与订阅页面交给系统浏览器。具体边界见 [Embedded Bot bridge](../../docs/history/mobile-bot-bridge.md#native-audio-and-packaged-code)。
- 手机端请求、缓存和离线写入先按 [移动数据协调契约](../../docs/architecture/mobile/mobile-data-architecture.md) 区分读取、在线事务与可持久化草稿；不得把 TanStack Query 的内存缓存、WebView 的独立 JS 环境或普通重试称为全 App 持久请求队列。账号展示缓存必须按会话与区域隔离，退出登录清除。
- 会话连续性按 [ChatUI 架构](../../docs/architecture/chat-ui/composer-and-drafts.md#跨桌面手机和平板的会话连续性)维护一个共享语义模型：Scope/View 身份、草稿保存与丢弃、前台追平条件属于共享包；桌面浏览器和手机/平板只适配存储、生命周期、手势与布局。V3 连接代次不能当持久 Replica 游标，旧消息缓存只可展示，不能授权发送或交互；任何私有缓存都要按账号和 Host 隔离，退出账号撤销对应作用域。不要因屏幕宽度另造一套业务状态机。
- 手机端读取状态按“可展示数据、最后成功时间、后台刷新、错误、会话有效性”分别建模：已有同会话数据时，后台刷新不得清空数据或切回全屏 loading；短暂失败保留旧布局并给轻量重试。只有冷启动且没有可用数据时显示与最终页面结构接近的静态占位，避免卡片消失、列表跳动和闪动菊花。缓存身份只能用于展示；实名、支付及账号安全操作在当前服务端状态核实前不可凭旧缓存放行。成功写入后精确失效相关查询，401、退出或切换账号/区域清除对应作用域。头像等媒体的缓存键只在资源确实改变时更新，不能每次普通刷新都强制重载。
- 修改手机读取页时先列出 `cold-loading / cached-refreshing / fresh / cached-error / session-expired` 五态，确认每态的数据来源、占位几何、可用动作和退出条件；实现中把 `data` 与 `isFetching` 分开，刷新只更新数据和轻量状态槽位，不能卸载整页、重置滚动位置或清空已渲染列表。重复进入时，首帧就从当前会话的内存缓存取值；不能等 `useEffect` 异步读取后才用缓存，否则仍会闪一帧占位。真正冷启动的占位按实际卡片和行高排布，禁用未核实的敏感操作。验收至少覆盖首次进入、30 秒内重复进入、后台恢复、断网再联网、刷新失败、401 与切换账号；逐帧查看是否出现短页、跳动或旧账号资料。细化策略见 [移动数据协调契约](../../docs/architecture/mobile/mobile-data-architecture.md)。
- 当需求指定 HeroUI Native/NextUI Native 的抽屉、弹层或其他交互控件时，要求涵盖**容器本身**的手势、遮罩、关闭、可访问性和动画；仅在手写 `Animated.View`、`PanResponder` 或普通 `View` 里放 HeroUI 按钮，不算使用该原生控件。实现前核对当前安装版本实际导出的组件及 Expo Go 支持；若库没有对应控件，选用可在 Expo Go 运行的成熟原生交互原语，并在 Task Pack 与交接中明确组件来源及例外，不能把它标为 HeroUI Native 抽屉。禁止引入 Unistyles。
- iOS 页面前进和返回统一经过可复用的原生导航页面容器：按钮返回与左边缘右滑必须走同一完成路径；拖动要跟手、未达阈值回弹、松手后补完动画。按当前**容器**宽度计算位移和阈值，窗口尺寸变化后重新测量，不能写死 iPhone 宽度或假定所有页面都是手机全屏 Stack。尊重系统减少动态效果设置，动画期间保留底层页面和 Bot runtime；从侧栏进入个人与设置时还必须保留侧栏的打开状态，返回应露出原侧栏，不能先关闭再推页面。状态栏与 Home Indicator 属于同一移动页面，不得留下独立横条。新增页面先复用这一层，再选择具体的手机、iPad 或折叠屏呈现方式。
- iPhone 外网预览提供完整明文 `exps://` 链接，在 Safari 打开并跳转 Expo Go；Metro 与 Cloudflare Tunnel 必须持续运行。为加快迭代，新链接只做轻量可用性检查（Metro 监听、隧道连接和 iOS manifest 响应），**不下载完整 bundle 校验**；源码的 Expo 类型检查和 iOS 打包仍按改动风险运行。链接失效时重新生成并做同样的轻量检查；不要把服务端检查表述为真机已验证。
- Android 内测包为 `dev.opencraft.workbench`，使用开发签名；正式包为 `app.opencraft`（与 iOS TestFlight Bundle ID 一致），必须使用仓库外的正式密钥。iOS 测试 IPA 须在有 Xcode 和 Apple 签名的 Mac 上构建。更换包名或密钥后，从**新成品**重新提取备案值。
- 本地 APK/IPA 打包、备案资料和临时局域网下载不等于 GitOps 发布。交接时分别报告源码 checkout、包名、签名证书摘要、APK 文件摘要、安装验证和下载进程状态；私钥与密码不得进入仓库、日志或下载目录。
