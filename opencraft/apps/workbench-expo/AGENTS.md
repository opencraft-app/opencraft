# Expo 手机端 Agent 入口

先遵循仓库根 `AGENTS.md` 和 `opencraft/AGENTS.md`。本文件只把手机任务路由到当前设计，不复制完整实现。

| 改动 | 先读 |
|---|---|
| iOS 抽屉、账号入口、页面返回与手势 | [Mobile shell](../../docs/mobile-shell.md) |
| 原生与打包的 frontend Bot DOM 通信、Bot 功能 | [Embedded Bot bridge](../../docs/mobile-bot-bridge.md)、`frontend/src/mobile-dom/entry.tsx`、`src/components/mobile-bot-host.ios.tsx` |
| iOS Bot「对话」、会话、输入框与传输 | `src/components/mobile-opencraft-chat.ios.tsx`、`src/components/workbench-frame.shared.tsx`、`src/runtime/runtime-context.tsx`、`@opencraft/chat-core` |
| 账号缓存、后台刷新、会话隔离 | [Mobile data architecture](../../docs/mobile-data-architecture.md) |
| 构建、Expo Go 预览、签名包 | [Expo README](README.md)、[build matrix](../../docs/build-matrix.md) |

修改导航前先写用户操作序列和语义目标，再改 `src/runtime/mobile-shell-model.ts`；原生手势只负责实时位移，不能再维护一份业务页面栈。Bot WebView 和抽屉须保持挂载，账号页返回要露出原抽屉。手机、iPad、折叠屏以实际容器尺寸和安全区决定几何。

自适应 Shell 的呈现由 `src/runtime/mobile-shell-layout.ts` 和集中视觉指标决定：窄容器用抽屉，能同时容纳侧栏与最小内容宽度时用可收起的常驻侧栏，账号按自身容量切换页面/面板。切换断点只改几何，不能重设 Bot、Thread、Draft、导航目的地或用布局模式当 React key；保持同一棵内容树，选择功能只收起浮动抽屉。嵌入 Chat 的断点必须读扣除外层导航后的实际容器宽度。面板安全区由外层一次处理，内容不重复补全屏 inset。验收分别记录模型测试与 iPad 真机横竖屏、分屏/窗口缩放、浮动/外接键盘证据，不能互相替代。

抽屉手势先核对当前安装的 Gesture Handler 2.x API：横向抽屉与 WebView 原生滚动须显式建立手势关系；本次触摸若已判给纵向滚动，不在中途抢夺，抬手后的新触摸重新仲裁。动画收尾期间仍可接收反向拖动：先取消旧动画，再从当前共享进度接续；旧完成回调不得覆盖新手势。保持横向激活距离和纵向失败阈值，避免网页竖滚被整页横滑吞掉。参考维护者的 [Gesture Handler 2.0 工程文章](https://swmansion.com/blog/introducing-gesture-handler-2-0-50515f1c4afc/)、[手动手势与触摸事件](https://swmansion.com/blog/introduction-to-manual-gestures-and-touch-events-a1dde7c98612/)、[2.x 手势组合](https://docs.swmansion.com/react-native-gesture-handler/docs/2.x/fundamentals/gesture-composition)、[Native 手势](https://docs.swmansion.com/react-native-gesture-handler/docs/2.x/gestures/native-gesture)、[Pan 阈值](https://docs.swmansion.com/react-native-gesture-handler/docs/2.x/gestures/pan-gesture)和 [Reanimated 动画中断](https://swmansion.com/blog/controlling-and-customizing-animations-in-reanimated-2-cee2d5d21285/)；不要直接套用 Gesture Handler 3.x 示例。验证序列包括打开途中立即反向、关闭途中立即反向、网页竖滚后不抬手横移、抬手后立即横滑，以及网页内横向控件。

修改 Bot 功能时保留 `frontend/` 原组件与领域逻辑，优先改共享源；原生侧栏只负责选择与容器。跨 WebView 的新命令或消息先改 `@opencraft/mobile-bot-bridge`，同时更新两端、协议测试和文档。未知 JSON 在边界验证；消息必须匹配协议版本及本次 runtime ID。不要把 token、账号 ID、URL 查询、正文或响应体写入开发者日志。
打包的 Bot HTML 虽在 WKWebView 中运行，站点 `baseUrl` 仍让它具备联网能力，不能称为严格沙箱。原生宿主只准首次加载本地文档；其后的主文档或 iframe 导航必须由导航策略拦截，并按 Bot 路由、外部页面或拒绝处理。绝不永久放行站点根路径 `/`；重试必须重新挂载打包 HTML，不能重载当前 URL。修改这条边界时覆盖“首次本地加载、跳到线上主页、功能路由、外部链接、iframe”的回归测试。

iOS「对话」由 OpenCraft 原生 Chat/Composer 呈现，连接侧栏选中 Bot 的物理实例和 Hermes Profile；打包 DOM 只负责其他 Bot 功能及目录，不得把 AgentChat 或网页 Chat 叠到原生 Chat 上。更改 Chat 时先分清 `chat-core` 共享模型、Web/RN 渲染与 `LightVelaHermesTransport` 传输三层，切换 Bot 要释放旧运行时。
草稿文档由共享 Conversation View 连续性模型保存，Expo 用 SQLite 适配并按凭证作用域隔离；前后台与网络事件只向共享返回探针报告状态，当前会话由 Host 运行时追平。iPad、折叠屏和手机沿用同一 Scope/View，不随断点生成第二份草稿或会话；几何只取容器尺寸和安全区。
修改 Chat 折叠、虚拟列表或定位前先读 [ChatUI architecture](../../docs/chat-ui-architecture.md) 的滚动契约。复现要覆盖宽度变化后的迟到测量、远处跳转、目标缺失、流式输出期间定位以及键盘/容器尺寸变化；修测量代次和几何事务，不另建滚动控制器、用固定延时判目标缺失或提前卸载仍可见的窗口。模型测试与 iOS bundle 只能证明各自边界，不能声称已经证明真机流畅度。
嵌入式 Chat 的键盘进度、占位和输入区容量由移动键盘布局层统一管理；iOS 跟随原生键盘动画，Android 消费系统 `resize` 后的容器尺寸。不得在输入框、页面外壳和列表各补一份固定键盘高度或叠加多个避让器；细节见 [Mobile shell](../../docs/mobile-shell.md)。

原生控件默认用 HeroUI Native 和既有设计 token。当前安装版没有抽屉容器，iOS 抽屉手势由 `src/components/interruptible-mobile-drawer.ios.tsx` 的 Gesture Handler/Reanimated 容器承担；不能把里面用了 HeroUI 按钮就描述成 HeroUI 抽屉。禁止 Unistyles。视觉例外要记在对应 Task Pack，并复用已有 token，不从截图抄散落色值。

复杂原生表单要分开草稿、服务端已确认值、验证、提交代次和冷却时间；收到后台刷新或过期响应时，不得覆盖用户正在编辑的草稿。表单提交先走共享 SDK 的操作和校验，服务端仍是实名、账号安全与支付的最终执行者。编辑器只维护输入与展示，不复制后端业务规则。

验证只选触及的路径：协议与状态模型测边界/迟到消息，DOM 功能运行 `build:mobile-bot-runtime` 和 `smoke:mobile-bot-runtime`，Expo 改动跑 typecheck 与相应 iOS bundle。交互变更要有可复现操作和实际运行时观察；不把每次改动都变成强制截图或全仓门禁。给新预览链接时使用完整明文 `exps://` URL，只轻量核验 manifest，告知 iPhone 用 Safari 和美区 Expo Go 打开。

LightVela 正式移动端按 `OPENCRAFT_LIGHTVELA_EDITION=cn|intl` 构建两包，包标识、URL scheme 和 OIDC 回调必须成套匹配；Expo Go 保留开发标识及旧回调。登录页不显示地区选择。站点覆盖只放在开发者模式，需登出后切换，不能将旧站点的凭证、Bot 或缓存带入新站点。改发行身份时同步核对 `app.config.js`、构建脚本、认证服务回调清单及 [Expo README](README.md)，并验证两包可同时安装且各自收到回调。

文档维护按“一个事实、一处权威”处理：改现有过时段落，再加必要的短规则；README 讲使用方式，本文件讲 Agent 工作边界，设计文档讲不变量，源码与测试讲当前行为。不要叠加一次性故障禁令或保留与现状冲突的旧描述。
