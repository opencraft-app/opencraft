# OpenCraft Agent 入口

本文件只记录 `opencraft/` 相对 mono2 根规则的局部增量。先遵循仓库根 `AGENTS.md` 并运行其 Context Router；正式事实以当前源码、测试、生成契约和下列专题文档为准。

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
| `plugins/` | LightVela、Hermes 与其他产品接入 |

- DSH 是可替换的执行引擎，不是 Bot、模型、会话、凭据或产品配置的唯一真源。先确认对象身份、生命周期和唯一写入者，再修改页面或 adapter。
- 宿主只声明并呈现已接通的能力；不得用开关、菜单项或前端状态冒充协议、运行时或后端能力。
- 云桌面通用插件拥有桌面 contract、媒体和面板，不依赖 Vela 账号、Bot、TAT 或 CTL。产品 provider 只消费通用 contract/media 子入口，拥有授权绑定、资源准备和观看 attachment 交接，不拥有桌面 DOM、Shell 或 Chat 连接。依赖方向与回收顺序见 [云桌面插件边界](docs/cloud-desktop-plugin.md#cloud-desktop--vela-plugin-boundary)；客户端只读状态不得代替后端输入授权。
- 分布式工作台的顶层协议对象是 Client / Hub / Server：Hub 是多租户 attachment、route、subscription 与 lease owner，Client 和 Server 通过 Hub 多对多连接并可经 Hub 级联。Renderer 只是 Client 的呈现机制（包括静态 Web），Host 只是 Server 的部署和资源载体；二者不得进入 Server/Thread 的稳定身份。完整不变量见 [执行所有权](docs/execution-ownership.md#client--hub--server-拓扑)。

## 按需加载

| 任务 | 必读入口 |
|---|---|
| 平台、AppServer、Chat Runtime、Workbench、扩展 | [platform-architecture](docs/platform-architecture.md) 与命中的专题文档 |
| 工作区、工具面板、浮动聊天、Side Chat | [design](design/README.md)；实现变更同步维护 `design/invariants.md` |
| OpenCraft 架构、交互、布局、平台适配或预览 | [opencraft-maintenance](.agents/skills/opencraft-maintenance/SKILL.md)，按任务读取其验证清单 |
| iPhone 通过 Cloudflare Tunnel 打开 Expo Go 开发预览 | [opencraft-expo-cf-preview](.agents/skills/opencraft-expo-cf-preview/SKILL.md)；先核对外网 manifest 和完整 bundle，再给 `exps://` 链接，提醒用 Safari 打开。手机操作见 [Expo README](apps/workbench-expo/README.md#iphone-真机快速体验) |
| Android 内测、正式 APK，或 iOS 测试 IPA | 先读 [手机端路线](apps/workbench-expo/README.md#手机端路线) 和 [构建矩阵](docs/build-matrix.md)；按目标选择签名、包名及验证步骤 |
| Android 备案资料或临时内网下载 | [Android 正式 APK](apps/workbench-expo/README.md#android-lightvela-release-apk)；从最终 APK 核对包名、签名证书和文件摘要，只开放 APK 下载路径 |
| 承载当前代理的 headless 预览服务切换或重启 | [opencraft-self-hosted-preview](.agents/skills/opencraft-self-hosted-preview/SKILL.md)；由独立服务完成切换与回退，重连后核对实际进程 |
| mono2 Agent Console 共享实现 | [MONO2_MIGRATION](MONO2_MIGRATION.md)、`frontend/AGENTS.md`；同步边界还读 `../docs/context/project/upstream-subtrees.md` |
| Web、Expo、Electron 构建与交付 | [build-matrix](docs/build-matrix.md) |

- 根 `ref/` 是固定版本参考，只读。借鉴前核对版本和真实运行入口，说明借鉴的是交互、状态模型、组件 contract 还是视觉 token；参考代码和截图都不是产品事实。

## 手机端入口

- iOS 当前是 HeroUI Native 登录与底栏，加 LightVela 网站 WebView；Android 是独立 React Native 工作台。手机平台、构建方式和产物先按 [Expo 路线表](apps/workbench-expo/README.md#手机端路线) 选择，不能把 Expo Go 预览当作可安装包。
- iPhone 外网预览使用已核验的 `exps://` 链接，在 Safari 打开并跳转 Expo Go；Metro 与 Cloudflare Tunnel 必须持续运行，链接失效时重新生成并核验。
- Android 内测包为 `dev.vela.workbench`，使用开发签名；正式包为 `com.tencent.vela`，必须使用仓库外的正式密钥。iOS 测试 IPA 须在有 Xcode 和 Apple 签名的 Mac 上构建。更换包名或密钥后，从**新成品**重新提取备案值。
- 本地 APK/IPA 打包、备案资料和临时内网下载不等于 GitOps 发布。交接时分别报告源码 checkout、包名、签名证书摘要、APK 文件摘要、安装验证和下载进程状态；私钥与密码不得进入仓库、日志或下载目录。

## 代码与 Contract

- 在系统边界解析并校验未知数据，内部传递已收窄类型；一次性类型留在调用方，只有真实跨包 contract 才进入 `packages/`。
- Optional/nullable 字段必须表示真实缺失。默认值只在 authority 边界填充；声明但忽略的 capability、route、command 或 wire 字段必须删除或端到端实现。
- 协议变化必须同时检查声明、生成类型、Host/provider adapter、持久化/恢复、失败语义和兼容测试。共享 TypeScript 能编译不等于已部署 Host 兼容。
- UI Preferences 统一消费 `UiPreferencesRuntime`；React 不直接选择 localStorage、IndexedDB、SQLite 或远端存储。scope、adapter、CAS 和正式 key 以 [UI preference authority](docs/platform-architecture.md#ui-preference-authority) 为准。
- Desktop 路径必须消费 [Directory identity charter](docs/architecture/product-identity.md#directory-identity-charter) 的唯一 resolver：生产数据根不得含 `vela`，旧 `@vela/*` 只允许作为幂等迁移输入；Main/Daemon/DSH 显式使用 runtime cwd，Thread workspace cwd 必须来自 Project/Thread，禁止回退 `process.cwd()`。
- `plugins/lightvela-hermes/src/upstream/mono2/` 是机械生成层，不得直接编辑。修改 `frontend/` 真源后运行 `npm run sync:mono2-agent-console`，并提交生成副本与 `UPSTREAM.json`；只读漂移检查使用 `npm run check:mono2-agent-console`。

## UI 与设计系统

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
- 跨扩展边界传递 `value/options/action`、`local/remote` 等稳定语义，不传具体图标组件、像素尺寸或 Feature CSS class。Web、Electron、Expo 可有不同物理实现，但消费同一 contract。
- 用户可见的按钮、菜单、弹窗、通知和状态文案只描述用户任务、处理结果与可采取的动作；不得把内部类型、协议、方法、状态名（包括 `pending`）或原始诊断信息直接写到界面上。技术细节需要排障时放在显式的详情或日志入口，不占主要操作位。
- 处理中反馈在原控件或原反馈槽位使用简短、尺寸稳定的文案或图标；不得追加技术状态说明或动态长文案，撑大弹窗、按钮、菜单、列表项，或造成相邻布局跳动。窄屏和触屏也须验证该约束。
- 局部 loading、retry、badge 和错误反馈优先在既有槽位原位替换，不改变窗口、标题栏、正文起点或相邻布局；确需改变宿主几何时先说明影响并取得用户确认。
- Mutation 的状态与反馈作用域必须和用户操作一致：行级/控件级操作使用独立 pending key，并在原控件槽位反馈；不得借用父级表单的 `dirty`、全页 `busy` 或路由 loading，导致无关编辑区展开、折叠、禁用、滚动或焦点变化。只有用户实际编辑父级表单字段时，父级 draft 才能变脏；用 held-promise 测试断言请求进行中布局与 draft 不变。
- 菜单、Popover 和 Dialog 使用项目已有 Radix/Modal 基础设施，不手写键盘、焦点、关闭、遮罩或嵌套行为。新增共享视觉 contract 时，用测试证明业务层不再持有已上收规则。
- 列表、树和多行侧栏中的临时菜单先定义互斥范围与唯一 owner：若同一容器同时只能有一个菜单，就由容器持有按稳定实体身份与入口类型标识的打开项，逐行 Radix Root 受控投影；不要让每行未受控的 `open` 状态各自决定全列表可见性。右键与“…”可以有独立触发区和事件，但切换行/入口或选中会话须关闭旧菜单，容器卸载须释放状态；旧菜单迟到的关闭事件只能清除自身，不能覆盖新菜单。触控连续点击不同菜单、菜单项、空白处与键盘操作都要作为回归序列验证。

### Typography 所有权

- Terminal 是独立字符网格，不继承正文 tracking、word-spacing 或 text-transform；xterm 拥有字符测量、绘制及内部间距补偿。验收必须同时比较满行字符/末列光标、screen、host 与 PTY 网格，不能仅凭 `screen ≤ host` 判定正确。具体契约见 `design/invariants.md` 的 WSP-21。

- `packages/design-system/src/typography/typography.tokens.json` 是字体栈、平台度量和语义 Typography Role 的唯一数据真源。`typography.shared.ts` 是 TypeScript/Native 投影，`_generated.web.scss` 是生成的 Web 变量；不得直接编辑 `_generated.web.scss`，修改后运行 `npm run generate:typography` 与 `npm run check:typography`。
- 文件拓扑固定为 `registry → platform adapter → typography primitive → Shell/feature consumer`。业务组件不得反向导入生成脚本、读取 JSON、自建平行 role registry，或在页面 CSS 中复制一套 Sidebar/Toolbar 字体比例。
- FontFamily、TypographyRole、TextTone 和平台渲染策略是四个正交所有者。低层 TypographyRole 只包含 family role、字号、行高与规范字重；颜色由 TextTone 组合，`font-smoothing` 等由平台 rendering policy 持有，禁止把 hover/selected/disabled 颜色复制成新的字体角色。
- Shell、Sidebar、Settings 导航和平台扩展 Chrome 优先消费 `typography.web.scss` 的语义 mixin。新增或修改这些区域时，不得直接写 `font-family`、`font-size`、`line-height`、`font-weight`；确有新层级先扩展 registry。内容排版、代码和第三方嵌入有独立责任边界，不得为了统一而机械迁移。
- 只允许 `400/500/600/700` 规范字重；禁止 `520/550` 等任意权重进入新代码。除上游明确设计证据外不新增或局部修改 letter-spacing。主要导航与会话身份使用 primary TextTone，secondary/tertiary 仅用于说明、元数据和弱化状态，不能靠整体灰化制造层级。
- Web/Electron UI stack 采用 system-first 的统一 fallback；Native 使用平台 system face。统一指 role 与 fallback 所有权一致，不要求跨平台物理字形相同。字体改动必须在真实 Electron 上记录 computed family/size/line-height/weight/tone/smoothing，并同时检查中英文、浅深主题和无布局位移。

## 验证

| 改动范围 | 最小有效验证 |
|---|---|
| 单 workspace | `npm run typecheck --workspace <package>` + 相关聚焦测试 |
| 跨包 contract | 两端 typecheck/test + `npm run check:boundaries` |
| Bot/Host | `npm run test:bot-management`，再按风险补 adapter/runtime 测试 |
| Agent Console 同步 | `npm run sync:mono2-agent-console` 后执行 `npm run check:mono2-agent-console` |
| 广泛共享或交付矩阵 | `npm run gate` |

变更后至少运行受影响的聚焦测试。视觉、窗口、Main/Preload 或原生能力还需按 [维护验证清单](.agents/skills/opencraft-maintenance/references/verification.md) 选择真实组件与桌面验收。

## 开发与预览

开始前核对当前分支、dirty worktree 和已有预览。只在当前 checkout 安装依赖和构建，不借用其他 worktree 的 `node_modules`、输出或登录 profile。

| 目标 | 命令与边界 |
|---|---|
| Web 轻量预览 | 在 `opencraft/` 运行 `npm run dev:web`，使用终端实际 URL。固定地址时先运行 `npm run build:preview-bridge`，再运行 `npm run dev --workspace @opencraft/workbench-web -- --host 127.0.0.1 --port 5173`。不包含 Main/Preload、IPC、本机 DSH、原生 chrome 或系统能力。 |
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

- `opencraft/` 是独立 npm workspace，保留自己的 `package-lock.json`；不得与 `frontend/` 的 pnpm workspace 或锁文件合并。
- mono2 是 OpenCraft 唯一写入真源；旧 `wisp/opencraft` 只作迁移历史和回退证据，不建立双向同步。
- OpenCraft 校验或构建不得隐式触发 frontend、GitOps、发布、生产或云资源修改。
- 构建产物、`node_modules`、本地日志、隔离 profile 和机器路径不得进入 Git。
