## goal
持续比较 OpenCraft ChatUI 的 React Native 与标准 Web 呈现，修复滚动、Markdown、链接和内容约束的实际差异，保持共享文档与时间线语义；拿不准的移动交互参考 `ref/paseo` 的固定版本实现。

## non_goals
- 不复制 Web DOM 组件到 RN，不改变模型或 Host 业务规则，不发布客户端。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户目标："持续对比 ChatUI 里，RN实现和标准Web的差异，比如滚动效果，和markdown、连接渲染、约束等，让RN 尽量对齐web版的表现。如果拿不准，可以看看paseo的实现。"。

## interface_refs / data_structure_refs
- `@opencraft/chat-document` 的 `ChatDocumentNode` 是 Markdown 结构真源。
- `@opencraft/chat-render-react` 的资源决策、打开意图和流式状态是跨端契约。
- `@opencraft/timeline-virtualizer` 的滚动语义由 Web 与 Native Viewport Owner 分别消费。

## history_context
- current_design_refs: `opencraft/docs/chat-ui-architecture.md`。
- relevant_evolution: 当前工作树已经有 RN Chat、共享 Markdown 文档和原生滚动 Owner；不覆盖其未提交改动。
- superseded_refs: unknown。

## acceptance
- 同一 Markdown 输入在两端保留主要段落、标题、列表、代码、表格与链接语义；不安全或未接通的目标不能表现为可打开。
- 流式链接与 Web 一样，在目标稳定前不可打开；RN 链接在文本内保持行内排版。
- 对照滚动 Owner 的用户手势、跟随、恢复及几何提交；修复有证据的差异，不以强制滚底掩盖问题。
- 运行相关聚焦测试、受影响包类型检查和 iOS bundle；真机未观察的效果明确标记。

## affected_paths
- `opencraft/packages/chat-render-native/`, `opencraft/packages/chat-render-react/`, `opencraft/packages/chat-render-web/`
- `opencraft/apps/workbench-expo/src/components/`, `opencraft/packages/timeline-host-native/`，相关测试与设计。
- `opencraft/plugins/lightvela-hermes/src/hermes-appserver-bridge/`、`opencraft/plugins/lightvela-hermes/src/transport/`：iOS Chat 模型目录超时诊断。

## required_context
- Context Router 对此查询无匹配 Pack；随后有界搜索上述 ChatUI 路径。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `opencraft/AGENTS.md@worktree` | OpenCraft 改动边界 | 共享语义、真实呈现验证 |
| `opencraft/apps/workbench-expo/AGENTS.md@worktree` | RN Chat 入口 | 原生渲染与平台适配 |
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md@worktree` | 架构与交互任务 | 不复制第二套规则 |
| `opencraft/docs/chat-ui-architecture.md@worktree` | 当前设计 | Markdown 与滚动契约 |
| `opencraft/packages/chat-render-native/src/renderers/resource.tsx@worktree` | 当前 RN 链接和图片 | 差异定位 |
| `opencraft/packages/chat-render-web/src/renderers/resource-link/resource-link.tsx@worktree` | 当前 Web 链接 | 流式稳定和资源行为对照 |
| `opencraft/packages/timeline-host-native/src/native-conversation-viewport-owner.ts@worktree` | RN 滚动 Owner | 滚动比较 |
| `opencraft/apps/workbench-expo/AGENTS.md@worktree` | 手机工作边界 | 修改现有滚动 owner 与事务，保留跨端语义 |
| `opencraft/.agents/skills/opencraft-maintenance/references/verification.md@worktree` | 聚焦验证 | 区分模型、产物与真机证据 |
| `docs/engineering/domains/agent-gateway-runtime.md@worktree` | 正式责任设计 | 同步客户端定位/测量职责与 ChatUI 文档链接 |
| `opencraft/plugins/lightvela-hermes/src/hermes-appserver-bridge/index.ts@worktree` | 模型目录超时红屏 | 确认异常已转为 AppServer 失败响应，直接 `console.error` 才触发红屏 |
| `opencraft/plugins/lightvela-hermes/src/hermes-appserver-bridge/adapter.ts@worktree` | 重试状态 | 确认失败读 Promise 被移出临时共享表 |
| `opencraft/apps/workbench-expo/src/runtime/mobile-developer-log-core.ts@worktree` | 移动端诊断 | 固定事件与数字类别，不记录私密内容 |
| `/data/mono2/ref/paseo@3cc4ae28664493b2f1ad75a6a6ed1d318c76e944` | 固定参考版本，只读 | 横向子滚动与面板手势仲裁对照 |
| `/data/mono2/ref/paseo/packages/app/src/components/markdown-text.ios.tsx@3cc4ae2` | 固定参考版本，只读 | 图片段落与原生文字选择的容器边界 |
| `/data/mono2/ref/paseo/packages/app/src/components/markdown/fence/mermaid/host.native.tsx@3cc4ae2` | 固定参考版本，只读 | 内置离线图表宿主、预览与全屏职责分离；未引入其 Unistyles |

## evidence
- 用户授权“尝试全部建模解决”后整改五项滚动缺陷：视口大小变化同步 controller 缓存；自然高度测量绑定内容/宽度/节点/生命周期；远处目标以双窗口挂载保留可见内容；目标存在性与行高度分别判定；平滑定位持续重算语义目标，布局改变后瞬时校正。无效锚点不再等待新 onLayout，也取消了以两帧判断目标缺失的计时器。开发模式 Effect 重放会撤销旧异步测量，保留当前同步布局身份；取消/卸载释放定位订阅和帧回调。
- 入口核查：RN 与 Web 都使用 `ChatDocumentSessionView` 和共享 `ChatDocumentNode`；RN 链接当前在 `<Text>` 子树里渲染 `Pressable`，且没有 Web 的流式目标稳定等待。RN 列表渲染固定 `•`，忽略 `list.ordered/start`；Web 使用 `<ol start>`。RN 图片直接加载节点原始 URI，而 Web 先过资源策略。
- 滚动初查：RN `NativeConversationViewportOwner` 与 Web Owner 共享 `timeline-virtualizer` 的距离、测量、恢复和跟随算法；需继续对照触摸仲裁和实际设备表现。
- 本轮实现：RN 有序列表、任务标记、行内链接和图片加载先消费共享资源语义；流式 HTTP(S) 链接的 500ms 等待移至 `chat-render-react`，Web 与 RN 共用。无 Host opener/媒体 loader 时，本地资源保持不可操作/显示 alt，不再错误调用设备的 URL/文件加载器。
- 后续对比：RN 代码块曾显示原始语言别名、无换行/复制，且 Mermaid 回退额外出现技术说明；表格忽略列对齐，不同行列宽可分叉。代码块标签与换行策略已移动到共享模型，RN 增加换行/复制，表格按实际容器宽度统一列宽、对齐并复制规范 Markdown。两种复制反馈共用生命周期 Hook，旧剪贴板请求和卸载后的计时器不再更新页面。
- 滚动事件接线核对：RN ScrollView 的拖动、惯性、内容尺寸、视口尺寸和滚动位置均交由 `NativeConversationViewportOwner`；其用户接管、几何合并和虚拟列表恢复继续消费共享 `timeline-virtualizer`。静态审查尚未发现需要独立第二套滚动控制器的证据。
- 引用块曾将子节点强制放入 RN `Text`，引用中的列表/代码块会形成非法嵌套；改为块级容器，文字沿用子节点原本样式。标题层级对齐 Web 的 h1 / h2 / h3–4 / h5–6 四档尺寸与间距。
- Paseo 的横向 Diff 滚动在触摸开始时记录该子视图的滚动偏移，并在面板手势判定时让子视图保持本次手势所有权；其键盘收起也只消费现有列表滚动事件。OpenCraft 原生 Chat 代码块/表格现在通过可选宿主上下文报告当前横向触摸，iOS 抽屉在激活前让出该次手势；无第二个页面滚动控制器。需要真机验证回弹、反向滑动和文字选择时的仲裁。
- RN 原先把 `@文件` 作为普通文字、文件引用指令作为原始标记；Web 展示文件名、行号并通过 Host 打开。现将引用标签和目标解析移到共享层；RN 用行内样式呈现，有 Host opener 才可点击。`WorkbenchConversation` 把已有 opener 传给 Chat 文档，移动宿主未接通本地资源时仍安全地保持不可点击。
- RN 段落原先全部由一个 `Text` 承载；Paseo 的 iOS Markdown 实现对含图片段落改用块级容器，避免图片作为行内占位导致布局塌缩。RN 现在把含图片段落分成可选择的文字段与独立图片块，纯文字段落仍保留原有选择范围。
- Web 的 Markdown 缩略图保留自然比例、默认最长边 200px；RN 原先统一使用 360×220 固定框。RN 现在在加载后读取图片本身尺寸，再受实际容器宽度和 200px 上限约束；未知尺寸只保留有界占位。嵌套在文字内的图片仍走行内路径，避免把 `View` 放入 RN `Text`。实际图片加载与 iPad 分栏需真机验收。
- Web 的 Markdown 图片可全屏预览并在同一文档内前后切换；RN 原先只有静态图。RN 图片现在注册到文档作用域的原生预览层，依 `sourceRange` 排序，防止异步加载改变导航顺序；关闭后回到原会话，预览层只在打开时挂载。这里使用 React Native Modal 和设计系统颜色语义之外的黑色图片背景，是文档渲染器的媒体查看器例外；不建立第二个路由或网页。需在 iPhone/iPad 上核验安全区、横竖屏和关闭手感。
- RN 行间公式同样用横向 ScrollView；先前只有代码块与表格向抽屉报告本次横向触摸，公式区域可能被抽屉抢手势。已让公式复用同一横向触摸所有权。公式本身仍为 LaTeX 源码回退，未声称达到 Web KaTeX 呈现。
- Web 的滚动 Owner 在 pointer-down 就取消自动滚动，而 RN 曾等到 `onScrollBeginDrag` 才取消。原生 ScrollView 现把 touch-down 交给唯一 viewport owner：先中断自动滚动和待执行的布局恢复，仍须真正开始拖动才把物理滚动归为用户输入。一次触摸只发一次接管通知，拖动结束或触摸取消后下一次可重新接管；对应 owner 测试覆盖轻触、拖动及再次触摸。
- Web 区分外部 URL、文件/工作区链接、文件引用和禁用目标；RN 原先将所有可打开链接画成蓝色下划线、不可打开时直接退成普通文字。RN 现在让外链沿正文颜色呈现，文件/工作区目标使用行内代码样式，禁用目标使用弱化颜色与无可操作语义，文件引用改为单独的提示色。长按安全外链提供系统菜单以在浏览器打开或复制净化后的目标；菜单动作执行时复核当前已稳定 URL，流式改写或卸载后不再使用旧地址。原生 Chat 文档同时消费 App 的简体中文/英文偏好，菜单与图片预览的操作文案随之切换。Web 的 favicon、悬浮提示和文件图标在 Native 仍无等价呈现，长按与文本选区的竞争需真机观察。
- Web 用户消息通过 `WebUserMessageDocument` 编译 `user-message` 方言；RN 原先默认走 assistant 方言。RN 用户气泡现在传入相同方言，保持 Composer 链接与列表切换。共享渲染调用传递相邻节点种类，RN 用户消息按 Web 的相邻段落 20px、列表内段落 0px、末尾无多余空白处理；助手末段也不再额外留下底部 margin。RN 的十六进制颜色文字现在带行内色块。具体文字度量、选区和间距仍需真机对照。
- Web 的嵌套无序列表依次使用实心圆、空心圆、方块，RN 原先每层固定实心圆。RN 列表现在从文档树中的父级列表项推导深度，选择对应标记和嵌套间距；有序编号与任务勾选保持原样。列表聚焦测试 22/22、Native/Expo 类型检查、iOS bundle 与 diff 空白检查通过；实际字形和跨行缩进仍需设备观察。
- Web 任务项是 14px 的只读勾选框；RN 原先显示系统 Unicode 方框，多位有序标记也使正文起点不齐。RN 已用原生勾选框、共享标记列宽和 Web 接近的行间距替换；原生包与 Expo 类型检查、渲染聚焦测试 23/23、iOS bundle 通过。实际 iPhone 字形、无障碍朗读和视觉间距仍需核验。
- 富文本差异：Web 使用 KaTeX 排版公式、Mermaid 渲染图表。RN 行间公式已接入同参数的 KaTeX 离线排版并内嵌字体；行内公式仍在原生文字流中呈现源码，避免破坏选区和行内布局。Mermaid 已接入 App 内打包的离线 HTML/JS 渲染器，完成的图表显示有界预览和原生全屏查看，失败或流式内容回退源码。逐节点 WebView 会增加长会话内存与滚动成本，仍需设备观察，不能仅凭源码与 bundle 视为完全等价。
- 资源约束复查：Web 链接、图片、文件引用经 Cordis `chatResourcePolicies` 优先级解析，RN 原先直接调用默认 URL 解析器，导致 Host 自定义限制/重写只在 Web 生效。RN 四类资源渲染现消费同一策略服务；Web 与 RN 的标准策略注册抽成共享函数，保持高优先级 Host 规则优先，图片 data URL 仅在图片渲染器例外。共享策略测试覆盖不安全协议、受限外链、文件目标和高优先级 Host 覆盖；React Native 源码无法由 Node 直接加载，实际 UI 行为需设备验证。
- 排版复查：Web 顶层连续含汉字段落只留 4px 间距，RN 原先统一 10px；Web 首尾标题/分隔线去除外边距，RN 原先保留。现将含汉字判断移到共享渲染层，渲染位置携带下一文档节点；RN 按 Web 的根段落与块边界规则计算间距。相关间距测试 4/4、Web/Native/Expo 类型检查和 iOS bundle 通过；具体文字度量与滚动位置仍待真机观察。
- 资源宿主复查：RN 文档此前虽能解析文件引用，却没有从 Expo Workbench 传入 `onOpenResource` 和 cwd，因而文件引用、工作区链接与变更文件卡片在 App 中不可打开。现在会话宿主传入当前 Thread 的 cwd/Host 身份；Host 打开外链时沿用共享资源决策，通过 `fs/readFile` 读取文件并在原生资源面呈现有界 UTF-8 文本，不将 Host 的 `file://` 路径交给 iPhone。Native 增加宿主能力谓词，未实现的 app-route、资源 scheme 和无 cwd 的相对文件保持不可点击。切换 Thread/Host 关闭资源面并撤销读请求；只记录固定诊断事件，不记录路径或内容。纯模型测试 3/3、React/Web/Native/Expo 类型检查、平台边界和 iOS bundle 通过；真机打开/返回与 Host RPC 仍待验证。
- Host 图片复查：Web 已通过 AppServer 文件接口读取工作区 Markdown 图片，RN 虽有 `loadMediaSource` 契约，Expo 宿主此前未提供它。现把当前 Host 的媒体加载器接给原生文档；共享 MIME 提示，Native 对 PNG/JPEG/GIF/WebP 在读取后检查 10 MiB 上限并使用 `data:` 图片源，跨 Host、无效路径、SVG 与超限内容保持不可用。加载回执仍受文档卸载与 AbortSignal 约束；设备图片解码、长会话内存和真实 RPC 仍待验证。
- 原生 Host 图片现在在当前 runtime/Host 内按路径复用 10 秒，缓存权重按 Base64 字符串两字节估算并限制在 24 MiB；并发消息共享一次读取，单个消息卸载不会取消其他消费者，全部离开则撤销 Host 请求。Host 连接代次变化时清缓存并中止旧请求，防止重连后把旧文件当作当前内容。模型测试覆盖重连失效、并发与取消；缓存仅是内存优化，图片超过 10 MiB 的传输仍需 Host 返回后才能拒绝，因为 `fs/getMetadata` 不提供文件大小。
- Web 的用户消息图片、生成图片和 image-view 工具结果共用会话媒体解析；RN 原先对 image-view 绝对路径直接构造手机 `file://`，用户本地图片又没有加载器，造成空缩略图。现抽出共享会话图片决策，RN 三种内容均可通过当前 Host 图片加载器取得可显示的数据源；没有产品专属预览入口时，点击已加载缩略图打开原生会话图片预览。跨 Host 的缓存键不同，文件路径不再交给设备本地 URL 处理。
- Web 的完整代码围栏通过 Shiki 着色，RN 之前始终显示纯色代码。现将语言别名、按需语法加载和 Codex 明暗主题搬到共享无 DOM 引擎；Web 沿用 HTML 输出，RN 使用同引擎的 token 输出绘制原生可选择文本。RN 仅对不超过 12,000 字符且已完成的代码块延迟 120ms 着色，流式或大块保持纯文本，绝不改变复制源或横向滚动。共享 token 与 Web HTML 的主题/文本聚焦测试 2/2、现有 Chat 渲染测试 21/21、受影响包类型检查和 iOS bundle 已通过；真机文字选择与长会话响应仍待观察。
- 用户 iPhone 截图显示 `model/list` 的 `model.options` 超时触发 Expo 红屏；定位到桥接层已捕获异常却调用 `console.error`。现将其保留为 JSON-RPC 失败响应，移动端只记录固定的模型目录失败类别；桥接层不在 Expo 展示堆栈。模型目录的并发读缓存会在失败后清除，下次读取可重新发送 RPC。聚焦测试覆盖超时、无 `console.error`、再次请求成功；真实远端超时原因仍需 Host 运行时日志定位。
- 10 月 3 日 11:43 的红屏截图早于同日 11:48 的桥接层修复；当前 Expo 预览 manifest 已重新生成并通过外网轻量检查。截图不能证明新的 JS bundle 仍含 `console.error`，但 `model.options` 的远端超时仍可能发生；修复的是手机不会因此展示内部堆栈。
- Mermaid 的 Web `prepareMermaidSource` 已抽成共享规则，RN 对完成的围栏按需加载 3.5 MiB 的离线 HTML/JS asset。HTML 禁用网络请求、外部脚本和跳转；消息协议只收有界几何。未完成/失败图表保持可读代码；全屏查看由原生 Modal 承载。生成 asset 已随 iOS `export:embed` 打入应用，聚焦测试 23/23、React/Web/Native/Expo 类型检查、平台边界与 iOS bundle（4898 modules）通过。当前环境缺 `libgbm.so.1`，本地 Chromium smoke 未能启动；仍须真机检查 WKWebView 实际渲染、内存和滚动。
- RN 行间公式现在用 App 内离线 KaTeX HTML 排版，与 Web 使用相同的 `displayMode/throwOnError/strict/trust/output` 选项；20 组字体约 1.7 MiB 已作为 data URL 内嵌，CSP 禁用网络与外部脚本。字体完成后回传有界几何；失败时回到可读的 LaTeX 源码。行内公式仍处在 RN `Text` 子树，不能直接嵌套 WebView，本轮没有用牺牲整段选区与换行的方案冒充行内等价。原生与 Expo 类型检查、平台边界、许可清单 42 项检查及 iOS bundle（4901 modules，包含两个离线富文本 asset）通过；真机 WKWebView 文字度量、溢出手势和长会话内存仍待验证。
- 离线公式和图表的 WebView 初始 HTML 在平台上可能以 `about:blank` 或 `data:text/html` 命名；原先只允许前者，会在部分平台错误拦截本地文档。现在仅在桥尚未就绪时允许一次本地 HTML 导航，后续 `data:`、脚本 URL 与外网跳转仍拒绝；协议/导航测试 3/3。超长源码在进入 WebView 前直接回退，公式内容变化通过新实例清除旧桥接状态，避免失败后复用旧 ready 状态。真实 Android/iOS 导航事件仍待设备核验。
- Web 段落、标题和表格使用 `dir="auto"`；RN 表格先前把无显式列对齐的单元格强制靠左。原生段落/标题与表格单元格现使用自然书写方向和自动对齐，同时保留显式 Markdown 列对齐。Native 与 Expo 类型检查通过；双向文字的列顺序、列表标记与实际 iPhone/Android 排版还需设备对照。

## risks
- Web 的 `positionTarget` 可按 DOM 语义键实测 Turn 内 Item；RN 现已先挂载并实测整条 Turn 再定位，但对 `targetKey` 仍返回 unavailable。当前 Expo 没有调用项级定位的导航栏；未来接入搜索结果跳转前必须补原生语义目标注册，不能用整条 Turn 位置冒充 Item 命中。
- RN 文本宿主和 iOS Fabric 行为需设备检查；Node 单测与 bundle 无法证明触控及原位排版。抽屉与代码/表格/公式 ScrollView 的实际手势先后顺序、外链长按与文字选区、图片块宽度和原始比例、预览安全区、色块和用户消息段落间距仍未有真机证据。
- 折叠和历史插入的列表几何已有模型与 Native Owner 回归测试，但 iPhone 上快速连续折叠、滑动中的异步高度变化和 10,000 Turn 长会话仍缺少实测帧率与视觉证据。
- Web 的用户消息折叠会把跨越截断线的代码块完整露出；Native 目前按固定行高裁剪，仍可能切在代码块中间。需要以原生代码块相对消息容器的实际布局为依据补齐，不能按 Markdown 源码长度猜测视觉高度。
- Web 用户消息在未裁剪内容上用 ResizeObserver 持续刷新自然高度；RN 此前只接受第一次自然高度。RN 现在在未裁剪状态接受后续布局更新，折叠后仅接受超过旧自然高度的内层增长；图片、公式、图表已有的 `requestMeasurement` 通知也接到该消息内层的原生测量节点，同帧合并。内容身份和宽度切换会拒绝迟到回调。已折叠消息中的异步媒体仍需设备确认其内层是否保留完整自然高度；不能用裁剪后的缩小值覆盖已确认的自然高度。
- 长会话快速滑动时，Web `ResizeObserver` 只接受当前登记的 DOM 节点，RN 先前只以 Turn key 接受 `onLayout`，虚拟行卸载或同 key 重挂后的迟到高度可能写回旧几何。RN 现按挂载行租约过滤即时回调与待提交测量批次，卸载时清除该行的待提交/可见高度；历史已确认高度仍留在共享虚拟器估值中。实际快速滑动和异步媒体重排仍需真机观察。
- Native 虚拟列表先前在每个滚动位置更新后调用 `serializeTurnRestoreState`，遍历全部 Turn 高度并把完整快照交给父容器；Web 只在恢复状态被请求时序列化。Native 现把懒捕获函数交给父容器，滚动时更新状态、离开会话时才复制完整高度表；即使子列表 ref 先释放，父容器仍能从该函数取到最后的布局和窗口。无当前列表时保留初始恢复状态；当前列表真实返回 `null` 时不得回退到旧状态。
- 文件预览目前限 UTF-8 文本，最多 512 KiB；Web 资源面板更完整的二进制、图像、路由资源与定位滚动尚未在 Native 提供。`fs/readFile` 的远端 Host 可用性需真实会话核验。
- 原生本地图片已有短时内存缓存，但没有 Web BlobResourceService 的持久缓存或文件变更订阅；超过 10 秒仍可能重复读取。缓存内存上限不包含仍挂在可见消息和预览层里的图片。真机需检查大图、长会话内存与重连后的图像刷新。
- Shiki 使用 JavaScript 正则引擎，在 RN JS 线程上处理已完成代码块；12,000 字符是目前的单块上限，不等于长会话全局任务限额。需真机检查快速滚动时的并发、输入响应和深色主题；行内公式仍是 LaTeX 源码回退，行间公式和 Mermaid 在渲染失败时回退源码。
- 本次只修复超时后的呈现与重试边界，不保证 Hermes 远端一定能在下一次 `model.options` 请求前恢复；真机需观察模型目录在弱网恢复后的刷新。
- 当前分支落后主线且工作树有大量未提交改动，只编辑本任务路径，不重置或提交。

## validation
- 2026-10-03 五项布局整改：聚焦虚拟器、折叠、Native Owner 和新事务测试 90/90；Expo、Native Host、虚拟器、Chat Core、Web 工作台类型检查通过；iOS bundle（4908 modules）、差异空白检查和正式设计影响检查通过。外部 iOS manifest 与 bundle origin 轻量检查通过，未下载远端 bundle。没有真机动画、帧率或触摸采样；Native 项内定位目前仍无产品 UI 调用方。重 Markdown 的 JS 测量成本和真机验证方案见 `2026-10-03-opencraft-native-stream-performance-report.md`。
- 2026-10-03 滚动框架复查：Native `scrollTo({ animated: true })` 以前立即把命令目标写入物理指标，虚拟目标定位因此可在动画开始时误报完成；现平滑命令等待 `onScroll` 的真实位置，测试覆盖起点、中途与终点。Native 流式回复越界计算以前漏掉虚拟列表在聊天容器里的实际顶部偏移；现在由列表 `onLayout` 报告偏移，并在正文、列表、视口和输入区几何变化时重算。聚焦测试 73/73、Native Host/Expo 类型检查通过。待真机核验键盘开合、iPad 分栏、长回复连续输出和中断平滑定位。项内锚点和远距离定位的后续修复见下条。
- 2026-10-03 RN 项内锚点和定位动画：Native 用户消息现在按 Web 同一 `item` anchor key 上报实际 `onLayout` 坐标，目标定位等待已挂载 Turn 的高度事务完成；缺失锚点会返回 `unavailable`。平滑滚动仅用于请求开始时已挂载且距离不超过一个视口的目标，其余即时定位，以免虚拟窗口在远距离动画途中露白。相关虚拟器/Native Owner 聚焦测试 75/75、Expo 类型检查、iOS bundle（4907 modules）、差异空白检查及外部 iOS manifest 轻量检查通过；当前 RN 尚无调用项级定位的 UI，真实设备上的锚点精度和动画仍未验证。长会话流式输出的 JS 测量与重 Markdown 风险详见 [性能报告](2026-10-03-opencraft-native-stream-performance-report.md)，报告不声称已有真机性能数据。
- 2026-10-03 流式输出跟随：本地发送且发送前靠近底部时，Web/RN 共享状态机进入 `response_watch`；回复内容真正越过视口边缘才清除响应留白并跟随到底。预处理直接切正文也保留等待，用户主动上滑立即退出；恢复旧会话不会继承这次发送的等待所有权。共享状态机测试增加直接正文、越界、上滑及恢复场景，滚动/折叠/Native Owner 聚焦测试 78/78、虚拟器、Web 与 Expo 类型检查通过；设备上连续 token、键盘弹出及上滑后继续流式输出仍待观察。
- 2026-10-03 用户消息动态折叠测量：共享自然高度观察允许未裁剪内容从短变长，RN Hook 在未裁剪状态持续更新；折叠后若内层仍报告更大的自然高度则接受增长，缩小值与宽度切换前、旧内容身份的迟到布局均不覆盖已确认高度。Native ChatDocument 现在把异步媒体/公式/图表的测量通知接回用户消息内层 View，单帧合并读取，回调身份稳定以免重启媒体加载。用户消息折叠与滚动/Native Owner 聚焦测试 75/75、`chat-core`、`chat-render-native` 和 Expo 类型检查通过；真机异步图片加载时的内层测量行为仍待观察。
- 2026-10-03 折叠/滚动/虚拟窗口：历史插入使列表总高度变化但距底部不变时，布局协调器仍在下一次 Native 内容尺寸提交时重写物理偏移；旧窗口在折叠或删除后不再遮住新可见 Turn，恢复首帧也要包含恢复距离对应的 Turn。聚焦测试覆盖测量 Turn 折叠、历史插入、Native 偏移和恢复窗口，68/68 通过；共享虚拟器、Expo、Web 类型检查、iOS bundle（4904 modules）、`git diff --check` 和外部 iOS manifest 通过。`workbench-timeline-host` 另有一项旧模型弹窗标签的静态断言失败，与本次列表改动无关。真机视觉与手势尚未核验。
- 2026-10-03 虚拟行迟到测量：Native 与 Web 一样按当前挂载实体确认高度来源。RN 的行租约在卸载或同 key 重挂后失效，排队中的帧测量也在提交时复核租约，避免快速滑动时旧 `onLayout` 改写高度表和滚动目标。虚拟器、折叠和 Native Owner 聚焦测试 76/76、Native Host 与 Expo 类型检查、iOS bundle（4905 modules）、差异空白检查和外网 manifest 通过。此项无真机高速滑动证据。
- 2026-10-03 Native 恢复快照：移除逐帧完整高度序列化，改为卸载时懒捕获；父容器保留捕获函数以跨越子列表 ref 的卸载顺序。虚拟器/折叠/Native Owner 聚焦测试 76/76、Expo 类型检查、iOS bundle（4905 modules）、外网 manifest 和差异空白检查通过。设备上的长会话滑动仍需核验。
- 2026-10-03 Markdown 块间距：RN 列表项段落取消尾部间距，多段列表项只在第二段前加 11px；引用段落与 Web 一样无多余外边距并采用 24px 行高，文档末尾列表不留尾距。标题和分隔线的前距扣除上一块已有的 Native 尾距，模拟 Web 正常流的 margin collapse。段落间距与列表标记聚焦测试、Native/Expo 类型检查与 iOS bundle 已运行；复杂嵌套和真实字体度量仍需设备对照。
- 2026-10-03 RN 局部横滑仲裁：代码块、表格和行间公式现在用内容宽度与当前 viewport 宽度决定是否启用内部横滑及占用本次触摸；短内容释放抽屉手势，宽内容保留局部滚动。代码文本同时固定 LTR，匹配 Web 代码块的 `dir="ltr"`。横滑阈值与表格宽度聚焦测试 2/2、Native/Expo 类型检查、平台边界、iOS bundle（4904 modules）通过；iPhone 上短代码块起手开抽屉、宽代码块滚动及公式 WebView 内触摸仍待实机核验。
- 2026-10-03 RN 链接宿主约束：原生外链现先检查资源策略和 Host `canOpenResource`，明确拒绝时不会退到系统浏览器；只有没有 Host opener 且目标是系统可处理 URL 时使用系统打开。边界测试 2/2、`chat-render-native` 与 Expo 类型检查、平台边界、iOS bundle（4903 modules）通过。
- 2026-10-03 表格预览对齐：RN 表格增加原生全屏展开，预览按当前容器宽度计算列宽，并允许横向与纵向浏览；原有内嵌表格和 Markdown 复制继续共用同一节点内容。`chat-render-native` 与 Expo 类型检查、表格列宽测试 1/1 通过。预览旋转与触控仍需设备观察。
- 2026-10-03 RN Turn 定位对齐：Native 虚拟列表现在等待目标 `onLayout` 高度进入布局与内容尺寸事务，才执行整条 Turn 滚动；时间线 revision 不足时继续等待，用户触摸和卸载会取消。Expo 类型检查、滚动相关测试 63/63、iOS bundle（4902 modules）通过；项目当前没有手机端项级定位调用，实际滚动手感尚待设备核验。
- 2026-10-03 滚动/媒体复核：Web 由 `ResizeObserver` 与显式测量请求更新 Turn 高度，RN 由 Turn 外层 `onLayout` 更新同一虚拟布局；两端均在 content-size 事务中处理位置补偿。发现聊天附件、生成图和工具图片仍用较窄图片 key，现已和 Markdown 图片共用完整 Host/会话/cwd/文档资源身份。相关 4/4 测试、Expo/Web 类型检查、平台边界及 iOS bundle（4902 modules）通过；外部 iOS manifest 可访问。滚动手感和异步图片尺寸变化还需真机观察。
- 2026-10-03 图片资源作用域对齐：共享 presentation key 现在覆盖 Host、会话、cwd、文档和解析目标；Web/RN 的旧图片加载状态不会跨作用域复用，Web 预览在作用域变化时失效，RN Gallery Provider 按当前会话/文档过滤并收起旧预览。相关 4/4 测试，`chat-render-react/native/web`、`workbench-web`、Expo 类型检查，平台边界和 iOS bundle（4902 modules）通过。尚无真机切会话时的视觉证据。
- 2026-10-03 iOS 截图中的 `console.error [hermes-appserver-bridge] request failed` 发生于 11:43；当前桥接源码于 11:48 已将可处理的 `model/list` 超时改为开发日志和 JSON-RPC 失败响应。`modelCatalogReads` 会在失败后清理，下一次可重新请求。Expo 模型选择器现在在无目录时提供用户可见的重试入口，有缓存目录时保留已有模型并在选择页提供刷新；技术细节仅进入开发日志。模型超时重试测试 1/1、Expo 类型检查、平台边界、iOS bundle（4902 modules）通过；外部 iOS manifest 返回 200。仍须手机刷新 JS 后核验不再红屏。
- 当前代码已通过 `chat-render-react`、`chat-render-native`、`chat-render-web`、`workbench-web` 与 Expo 的类型检查；Markdown/渲染相关聚焦测试分别覆盖文档结构、资源决策、列表、图片、代码和表格。原生图片加载、缓存及会话图片接线的聚焦测试 7/7；共享 Shiki 新测试和现有 Chat 渲染测试合计 23/23。`check:boundaries`、iOS bundle（4898 modules）、变更影响检查、`git diff --check` 和外网 iOS manifest 轻量检查通过。Mermaid 消息/几何与现有 Chat 渲染聚焦测试 23/23，生成 HTML asset 已包含于 iOS 产物。此前资源策略接线改动后渲染策略测试 21/21；任务列表改动后渲染聚焦测试 23/23。登录流程的“正在打开 LightVela”独立过渡屏已不存在于当前 iOS 源码；只在登录按钮中保留等待反馈。模型目录红屏修复后，LightVela Hermes 插件测试 85/85、开发者日志测试 1/1、插件与 Expo 类型检查、平台边界和 iOS bundle 通过；外网 manifest 轻量核对通过。没有以 manifest、Node 测试或 bundle 代替真机手势与布局验收。

## decisions
- Chat 文档与资源决策继续由共享层所有；原生层只实现行内排版、可达性和平台打开动作。

## scan_scope
- `opencraft/packages/chat-render-*`, `opencraft/packages/timeline-*`, `opencraft/apps/workbench-expo/src/components/`。

## scan_output
- 有界 `rg` 和当前源码读取；无外部扫描文件。

## handoff
- 五项建模修复已完成源码与聚焦验证，待 iPhone/iPad 实机核对旋转/键盘开合、快速远处跳转、流式输出期间定位和上滑接管。预览沿用 `exps://calgary-metropolitan-outputs-concepts.trycloudflare.com`；未提交或推送本轮变动。
- 进行中；Markdown、引用目标、链接资源类型、用户消息方言、图片块布局与预览、代码块、表格和横向手势的静态实现已进一步对齐。代码块新增与 Web 共用的 Shiki 语法/主题输出，RN 对完整且有界的代码块绘制原生着色文本。Expo Workbench 现能打开 Host 文本文件与安全外链；Mermaid 与行间 KaTeX 使用内置离线渲染器，但尚无真机图表、公式和内存证据。真实 iPhone 上的行内排版、代码选择与长会话响应、外链长按、图片预览、用户消息间距和滚动观察仍待完成；二进制资源与行内 KaTeX 尚未达 Web 呈现。
