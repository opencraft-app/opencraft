# OpenCraft Agent 入口

本文件是OpenCraft服务根入口，独立GitHub checkout也必须能直接使用。独立仓库不要求不存在的父级脚本或内部文档。正式事实以当前源码、测试、生成契约和下列专题文档为准。

## 跨端产品与适配认知

OpenCraft 同时面向触控设备与 PC：通过 Web DOM 和 React Native 技术，以移动 App、PWA 和 Web 形式覆盖手机、折叠设备、iPad 等触控设备；通过 Electron 提供桌面 App，同时提供 Web 桌面端。开发与设计必须同时考虑触控和鼠标／键盘操作，具体平台能力仍以实际实现为准。

- **技术载体、布局空间与输入方式分别判断。** Web DOM 不等于 PC 界面，React Native 不等于手机尺寸，Electron 也不能替代输入能力判断；大屏设备可以触控，窄窗口也可以使用鼠标与键盘。
- **触控呈现消费共享能力与偏好。** 复用项目已有的触控能力识别、用户触控偏好和输入模态投影，不按窗口宽度、操作系统、Web／Electron 宿主名称另造判断。触控呈现模式与当前一次鼠标、触摸或键盘输入分别建模，悬停、焦点和按下反馈沿用各自 owner。
- **布局按实际容器适配。** 手机横竖屏、折叠／展开、iPad 分屏与 PC 窗口缩放都可能改变可用空间；布局断点负责空间分配，不能代替触控与非触控交互的区分。
- **跨端共享业务语义，按能力适配呈现。** 复用领域状态、协议和操作意图，由平台适配手势、命中区域、键盘导航及宿主能力；切换尺寸、输入方式或呈现模式时保留草稿、焦点、选区、滚动和会话连续性。相关改动分别验证触控与 PC 路径，不用单纯缩窄浏览器窗口代替触控验收。

## 上下游迁移

GitHub `opencraft-app/opencraft` 是目标核心上游，产品身份来源、执行引擎和渠道经插件接入；核心仍拥有主体、授权和Hub分发。下游产品的业务装配（身份、品牌与企业服务）不属于核心。当前切换状态见[实际状态与来源清单](docs/history/upstream-transition.md)；不要用旧源码覆盖当前产品，也不建立两套可写核心。原贡献采用MIT-0，未核实第三方材料不因LICENSE自动获得授权。 当前交付范围见[上游切换记录](docs/history/upstream-transition.md#current-delivery-decision-2026-10-19)。

## 完成标准

- “分析、看看、先别改”只授权只读调查；行为修改必须完成实现、相关验证，并在用户可见结果依赖客户端时验证真实 Web/Electron/Expo 呈现。
- 验证范围与改动匹配。相关检查通过后，只有出现新改动、失败或未决风险时才扩大或重复验证。
- 交接分别说明源码、构建产物、正在运行的窗口以及未验证的登录、模型、Host 或外部服务链路；测试通过不能替代当前客户端证据。
- 调试以当前日志、进程、协议响应、数据库只读查询或客户端状态为依据，不从最终 UI 症状猜测根因。

## 责任边界

| 区域 | Owner |
|---|---|
| `apps/workbench-web` | Web 与 Electron 共用的 Renderer、AppShell 和路由呈现 |
| `apps/desktop` | 桌面窗口、私有存储、Preload 与 IPC |
| `apps/local-agent-host` | 本机执行、DSH 进程与 Host 能力适配 |
| `packages/` | 跨端领域语义、协议和稳定共享 contract |
| `plugins/` | 随核心提供的通用插件；私有产品插件由下游 workspace 持有 |

- DSH 是可替换的执行引擎，不是 Bot、模型、会话、凭据或产品配置的唯一真源。先确认对象身份、生命周期和唯一写入者，再修改页面或 adapter。
- 宿主只声明并呈现已接通的能力；不得用开关、菜单项或前端状态冒充协议、运行时或后端能力。
- 云桌面插件、产品 provider 与回收顺序见[云桌面插件边界](docs/architecture/extensions/cloud-desktop-plugin.md#cloud-desktop--downstream-product-plugin-boundary)；主体与 Hub 协作见[设计纲领](docs/architecture/identity/actor-collaboration.md)（目标设计）与[执行所有权](docs/architecture/execution/execution-ownership.md#client--hub--server-拓扑)；登录方式绑定同一自然人见[服务器登录](docs/architecture/identity/server-authentication.md)。

## 按需加载

| 任务 | 必读入口 |
|---|---|
| 新增功能含 UI，或界面、设置页、列表、表单、弹窗的实现/改版/评审 | [维护 Skill 的 UI 路径](.agents/skills/opencraft-maintenance/SKILL.md#ui-任务先进入设计路径) → [设计入口](design.md)；按需读取专项，不等用户另外提出设计要求 |
| 平台、AppServer、Chat Runtime、Workbench、扩展 | [platform-architecture](docs/architecture/README.md) 与命中的专题文档 |
| Browser 自动化、PreviewBridge、Electron CDP 与 harness 工具适配 | [自动化迁移清单](docs/architecture/browser/automation-migration.md)；实现 TODO 见 [browser-cdp](packages/browser-cdp/AGENTS.md) |
| 工作区、工具面板、浮动聊天、Side Chat | [design](design/README.md)；实现变更通过 `design/invariants.md` 索引维护对应专题 |
| OpenCraft 架构、交互、布局、平台适配或预览 | [opencraft-maintenance](.agents/skills/opencraft-maintenance/SKILL.md)，按任务读取其验证清单 |
| iPhone 通过 Cloudflare Tunnel 打开 Expo Go 开发预览 | [opencraft-expo-cf-preview](.agents/skills/opencraft-expo-cf-preview/SKILL.md)；先轻量核对 Metro、隧道与外网 iOS manifest，再给完整明文 `exps://` 链接，提醒用 Safari 打开；不为日常预览下载完整 bundle。手机操作见 [Expo README](apps/mobile/README.md#iphone-真机快速体验) |
| Android 内测、正式 APK，或 iOS 测试 IPA | 先读 [手机端路线](apps/mobile/README.md#手机端路线) 和 [构建矩阵](docs/develop/build-matrix.md)；按目标选择签名、包名及验证步骤 |
| Android 备案资料或临时局域网下载 | [Android 正式 APK](apps/mobile/README.md#android-release-apk)；从最终 APK 核对包名、签名证书和文件摘要，只开放 APK 下载路径 |
| 承载当前代理的 headless 预览服务切换或重启 | [opencraft-self-hosted-preview](.agents/skills/opencraft-self-hosted-preview/SKILL.md)；由独立服务完成切换与回退，重连后核对实际进程 |
| 已部署 OpenCraft 的小范围快速变更、局部构建与单服务更新 | [opencraft-fast-change](.agents/skills/opencraft-fast-change/SKILL.md)；以运行产物为基线，构建候选并验证实际行为，依赖/迁移/跨服务变化转正式流程 |
| 下游产品 Agent Console 共享实现 | [历史与消费契约](docs/history/upstream-history.md)；同步边界由下游产品工作区维护 |
| Web、Expo、Electron 构建与交付 | [build-matrix](docs/develop/build-matrix.md) |
| 公共 npm 发布、Web 更新部署 | [Web 发布与部署](docs/operations/web-deployment.md#公共-npm-发布流程)，含包名、Trusted Publisher、精确归档与验收约定 |
| 从源码打包替换服务器本地 Web | [本地替换指引](docs/operations/web-local-deployment.md)；先核对 `.local/README.md` 中的实际部署信息 |
| 开源提交、公开发布 | [安全与发布说明](SECURITY.md)；按 [opencraft-release](.agents/skills/opencraft-release/SKILL.md) 核对实际来源、隐私、依赖、固定tag和归档；贡献PR遵循仓库当前检查 |
| 手机容器的数据读取、会话连续性、导航容器与打包 | [Expo 局部 Agent 入口](apps/mobile/AGENTS.md#手机端细则) |
| 引擎命令、子进程、PTY、后台 worker 与取消路径 | [Sandbox 局部入口](packages/sandbox/AGENTS.md) 与 [CreateSandbox 契约](docs/architecture/execution/execution-sandbox.md) |
| 主事件循环、系统边界解析、协议字段、SQLite 与迁移 | [代码与 Contract 规则](docs/develop/code-contracts.md) |
| UI 控件、微交互、焦点、主题、菜单与异步反馈 | [UI 实现规则](design/ui/implementation-rules.md) |
| 应用 Router、PUSH/REPLACE/POP 与历史按钮 | [应用导航](design/application-navigation/task_plan.md#应用导航不变量) |
| 会话时间线的轮次、分段与排序 | [ChatUI 架构](docs/architecture/chat-ui/chat-ui-architecture.md#会话时间线所有权) |
| macOS 签名、公证与本机预览注意事项 | [构建矩阵](docs/develop/build-matrix.md#macos-developer-id-签名包运行手册) |

- 参考 checkout 应固定版本并只读使用；独立仓库不要求根 `ref/` 目录。借鉴前核对版本和真实运行入口，说明借鉴的是交互、状态模型、组件 contract 还是视觉 token；参考代码和截图都不是产品事实。
- 参考开源代码时必须先理解思路与原理，再独立设计和实现，不得直接照抄或机械改写，并核对许可证兼容性、避免引入不兼容的许可义务；独立新实现不添加参考来源注释，既有来源记录以及许可证要求的版权声明、署名与 NOTICE 仍须保留。

## 必守规则

各条细则在链接的 owner 文档中；动手前读对应专题。

- **执行沙盒**：引擎执行一律经 `createSandboxPool()` / `createSandbox()`；不得新增绕过已选沙盒的裸执行路径，后端缺失或创建失败时拒绝执行，不静默回退本机。见 [Sandbox 入口](packages/sandbox/AGENTS.md)。
- **主线程**：承载连接、路由和消息分发的事件循环不得执行阻塞 IO 或同步 SQLite；`async` 包装不算移出主线程。见[代码与 Contract 规则](docs/develop/code-contracts.md#网络主线程不得阻塞)。
- **SQLite**：表结构只由 owner 的迁移追加 N+1，不改写已发布迁移；所有自有库经 `openManagedDatabase` 打开；改表须有升级保数据与 checksum 拒绝测试。见[代码与 Contract 规则](docs/develop/code-contracts.md#边界数据协议与存储)。
- **国际化**：新增或调整的可见/无障碍文案消费 IntlRuntime/IntlPort 与稳定 ID，不为新增硬编码扩增 baseline。见[国际化约束](docs/develop/internationalization.md#贡献约束)。
- **图标**：界面图标禁止使用 Lucide（含适配包与搬用 SVG 路径），统一使用 `@opencraft/design-system-web/action-icons`。见 [UI 实现规则](design/ui/implementation-rules.md#界面图标禁止-lucide)。
- **UI**：新增或修改界面前先读[设计入口](design.md)与 [UI 专题索引](design/ui/README.md)，再按 [UI 实现规则](design/ui/implementation-rules.md)实现；共享控件消费 `@opencraft/design-system-web/button` 与 `navigation`，运行 `npm run check:controls`、`npm run test:controls`。
- **手机端**：apps/mobile 只是承载随包 Web Workbench 的 WebView 容器，默认内置模式的代码须预制在安装包中。见 [Expo 局部入口](apps/mobile/AGENTS.md)。

### Typography 所有权

UI 任务按需读取 [UI 专题索引](design/ui/README.md)，字体任务继续读 [字体语义与检查](design/ui/typography.md)。既有 `typography.tokens.json` 是唯一数据真源；Typography Role、TextTone、平台渲染策略分开，业务不得直接编辑生成的 `_generated.web.scss`。字体改动运行 `npm run check:typography` 与 `npm run test:typography`，可见变化按专题做真实呈现验收。

## 验证

| 改动范围 | 最小有效验证 |
|---|---|
| 单 workspace | `npm run typecheck --workspace <package>` + 相关聚焦测试 |
| 跨包 contract | 两端 typecheck/test + `npm run check:boundaries` |
| Host | `npm run test:host-connection`，再按风险补 adapter/runtime 测试 |
| Agent Console 同步（仅下游产品） | 在下游产品目录运行该产品的同步与只读漂移检查；公开核心不提供私有转调 |
| 广泛共享或交付矩阵 | `npm run gate` |

变更后至少运行受影响的聚焦测试。视觉、窗口、Main/Preload 或原生能力还需按 [维护验证清单](.agents/skills/opencraft-maintenance/references/verification.md) 选择真实组件与桌面验收。

## 开发与预览

开始前核对当前分支、dirty worktree 和已有预览。只在当前 checkout 安装依赖和构建，不借用其他 worktree 的 `node_modules`、输出或登录 profile。

| 目标 | 命令与边界 |
|---|---|
| Web 轻量预览 | 在仓库根目录运行 `npm run dev:web`，使用终端实际 URL。固定地址时先运行 `npm run build:preview-bridge`，再运行 `npm run dev --workspace @opencraft/workbench-web -- --host 127.0.0.1 --port 5173`。不包含 Main/Preload、IPC、本机 DSH、原生 chrome 或系统能力。 |
| Electron 当前源码 | 先运行 `npm run build:electron`；创建 `preview_profile="$(mktemp -d /tmp/opencraft-electron-preview-XXXXXX)"`；再运行 `npm run start --workspace @opencraft/desktop -- --user-data-dir="$preview_profile" --remote-debugging-port=9333`。端口仅为示例，启动前确认未占用。 |
| macOS 打包预览 | 仅在验证签名、打包资源、原生 helper、安装路径或最终桌面行为时运行 `npm run package:electron:mac:arm64:preview`；使用隔离 worktree/profile，按 `docs/develop/build-matrix.md` 验收。 |

- 测试工具链、Renderer 重建、Electron Main 启动与 `opencraft://` 回调的注意事项见[本机预览注意事项](docs/develop/build-matrix.md#本机预览注意事项)。

## 硬边界

- 本仓库是独立 npm workspace，保留自己的 `package-lock.json`；不得与下游产品的 workspace 或锁文件合并。
- GitHub 是目标核心上游，下游产品持有私有装配并固定版本消费；当前切换状态见 `docs/history/upstream-transition.md`，不要恢复旧单向镜像或双写。旧私有仓库仅为有界历史和回退证据。
- OpenCraft 校验或构建不得隐式触发下游产品构建、GitOps、发布、生产或云资源修改。
- 构建产物、`node_modules`、本地日志、隔离 profile 和机器路径不得进入 Git。
