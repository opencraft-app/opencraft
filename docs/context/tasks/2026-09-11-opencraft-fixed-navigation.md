---
id: opencraft-fixed-navigation-2026-09-11
type: task
scope: OpenCraft 固定双入口与可停靠导航首版。
triggers: ["opencraft fixed navigation", "固定双入口", "导航 Pin"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - opencraft/packages/workbench-runtime/src/shell-navigation.ts
  - opencraft/apps/workbench-web/src/components/shell-navigation
status: active
reviewed_at: 2026-09-11
review_due: 2026-10-11
revision: 1.9.0
precedence: task
derived: false
---

# OpenCraft 固定入口与可停靠导航

## goal
应用与个人内容可分别 Pin，底部双入口归属 Sidecar Footer；Pin 切换保持局部锚点，全部侧栏收起时一起隐藏。

## non_goals
- 用户最新授权实现并发布应用入口快速切换，追加要求设置复用统一三栏容器；本轮一起发布既有轻柔条目/铺满宽度修正。不提交、不推送、不修改后端。定制字体尚未接入，继续使用已告知的临时 UI 字体。
- 用户授权先提交基线；后续实现保留在 mono2 工作区。
- 不根据示意图虚构业务目的地，不改写会话生命周期或原有侧栏弹簧动画。
- 本轮完成 Web 纵切；Expo 共享纯状态模型，原生视觉容器尚未接入。

## requirement_ids / requirement_refs / requirement_excerpt
外部需求编号为 unknown；以当前用户对话为直接需求来源。
当前用户对话：左侧应用、右侧个人；Pin 时应用栏与会话栏并排；取消 Pin 后会话栏回到最左；两个按钮必须一直待在原地。图标只在入口内叠放，展开内容仍为竖向列表。
追加要求：应用栏可调宽；对照 Codex 按钮原语收敛过大视觉，应用入口为正方形，应用与个人约 1:3。
用户线上反馈：没有可见的 Pin 按下效果，按钮透明而缺少实体表面；DevTools 压缩高度后底部入口覆盖列表。本轮修正此前错误的透明视觉验收和 Footer 布局所有权。
最新澄清取代上面的实体按钮视觉要求：不是独立 button，而是默认无底框的侧栏条目；两入口需充分占满分配空间。默认透明，悬停/展开/Pin 浅底色，去掉常驻描边、抬起和凹陷阴影；保留真实 Footer 布局占位。左侧正方形，个人入口填满最左栏剩余宽度，不再固定 1:3。
最新追加：应用入口点击即展开/收起，不弹菜单、无二次 Pin；个人入口独立。设置也应置于应用导航、设置分类、内容的共享三栏中，基于可复用容器而非为单个需求定制布局。
最新截图反馈：Footer 白底和旁边灰色缺口割裂；改由 Sidecar 统一材质，Footer 透明继承但仍占真实布局行。
追加要求：Home 图标改为 Vela 定制字体字标；修复横向移动侧栏时顶栏横线反复出现/消失。字体来源仍待用户确认，不把普通系统字体冒称定制字体。
最新反馈：应用栏收起时邻接会话栏形成硬裁切，文字与图标出现半截。三栏必须共享平台级 Frame/Viewport 原语，业务内容不得直接随动画宽度重排。
最新反馈：Primary 拖动时偶发整栏消失，松手后恢复，且没有复用既有侧栏的释放动画。要求参考 Codex 做一次有边界但彻底的交互层重构，不扩散到路由、内容树或整体 Sidecar 拓扑。
最新反馈：宽度动画已认可，但中间帧的条目文字与选中块仍有硬裁切感；要求利用现有 Motion 框架提升内容层动画质量。
合并 master 后线上反馈：Announcement Lab 的 Vite 小型 SVG 被内联为 `data:image/svg+xml`，但平台 URL 校验拒绝全部 data URL。用户确认平台应允许内联图片；修复必须区分图片 data URL 与任意 data 内容。
最新反馈：Primary 向右拖动时内部选中面落后于外框；账户浮层头像失去边界；打开账户入口时文字横移；compact 选中面为 28×34 而非正方形。修复必须从 Frame/Viewport、浮层尺寸与 Footer 锚点所有权入手。

## interface_refs / data_structure_refs
- `opencraft/packages/workbench-runtime/src/shell-navigation.ts`：跨端纯状态、动作与响应式投影。
- `opencraft/apps/workbench-web/src/components/app-shell.tsx`：物理几何唯一所有者。
- `opencraft/apps/workbench-web/src/components/shell-navigation/`：Web 固定入口、内容与 Radix 非模态容器。
- `opencraft/packages/extension-contract/src/index.ts`：复用现有导航贡献与目标。

## history_context
- current_design_refs：`opencraft/docs/platform-architecture.md`、`docs/engineering/domains/agent-gateway-runtime.md`。
- relevant_evolution：原 Sidebar 同时拥有账户菜单；现在 Shell 拥有固定入口，内容不再绑在会话栏。
- superseded_refs：移动底部按钮、蜂窝内容网格、增加第二套工具栏开关的草图均已淘汰。

## acceptance
- Pin 动画逐帧保持入口节点、父节点、左下锚点与应用正方形尺寸；个人入口右边缘可跟随栏宽变化。
- 应用/个人 Pin 偏好独立，临时内容互斥；关闭临时窗口不取消 Pin。
- 宽度压力只改变呈现，放宽恢复停靠，不抹除偏好。
- 使用现有扩展贡献与账户接口，没有模拟业务操作。
- 聚焦测试、浏览器几何测试、跨 workspace 门禁。
- 应用/会话宽度独立；拖拽、键盘、双击复位和刷新持久化通过，应用入口正方形，个人入口铺满最左栏剩余宽度，并保留对称内边距。
- 浅/深色下默认透明无描边投影，悬停/展开/Pin 有浅底色；矮窗口与长列表的滚动视口不得覆盖独立 Footer 行，最后一项可达。
- 页面只有一个 Sidecar；其 Primary/Context 两个可选 Pane 共用 Frame–Clip–Viewport 原语。Primary 收缩时 Viewport 保持 committed expanded width 供 Clip 裁切，向外扩张超过 committed width 时 Viewport 必须与 Frame 同帧跟随；resize 不得改写透明度，快速反向不得重挂载或出现整栏消失、半截字形、尾部空带。
- 应用栏调宽提供 `expanded → compact → hidden` 两段磁吸；compact 为纯 Icon 的持久语义档位，展开宽度单独保留。反向拖动遵循相同顺序，Settings 等业务导航必须铺满平台 Viewport，不得以固有宽度留下空带。
- 拖动预览不得写入 committed detent、Pin、持久化或 dock availability；pointerup 才原子提交相邻档位，cancel 恢复起点。
- 磁吸阈值只决定 pointerup 的目标档位，不量化按住阶段的物理宽度；释放后 Frame 以共享 spring 收敛到目标，hidden 在物理宽度到零后才提交语义隐藏。
- 内容编舞必须由 Primary Frame 的同一 MotionValue 派生：选中条目宽度先收缩、标签提前淡移、标题折叠、图标保持锚点并轻微聚焦。不得新增独立计时器或第二个手势动画 owner；compact 仍保留可访问文字与 tooltip，不通过 `display:none` 硬切。
- Vela、Sidecar toggle、前进和后退是完整的全局 Header 组，任何 Sidecar detent 都不得隐藏其成员。Pane 分隔线只绘制在内容区，不进入 Header/Footer。
- Footer 两入口始终处于同一个 Sidecar Footer DOM/坐标系；compact/hidden 与分隔线不得改变左下锚点、应用正方形或账户列起点。
- Announcement `image-url` 接受 HTTP(S)、blob、根相对 URL 及语法合法的 `data:image/*`；继续拒绝 `data:text/html` 等非图片 data URL。Vite 是否内联属于发布优化，不得反向收窄平台媒体契约。

## affected_paths
涉及 workbench-runtime、workbench-web、设计 token、测试和架构文档；不触及生成上游或生产。

## required_context
路由命中 frontend-product-surface；同时遵循 OpenCraft 平台所有权边界。

## context_receipt
| 文件 | 读取原因与用途 |
| --- | --- |
| `AGENTS.md` | 仓库权限、正式设计映射与验证要求 |
| `opencraft/AGENTS.md` | mono2 唯一写入真源，运行完整门禁 |
| `docs/context/project/services/opencraft.md` | 本轮路由必读，确认 Workbench 服务边界与门禁 |
| `docs/context/project/services/frontend.md` | 路由必读，生成前端代码不在本轮范围 |
| `opencraft/docs/platform-architecture.md` | 纯状态共享，平台拥有容器 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md` | 检查本地侧栏测试与样式邻居 |
| `docs/engineering/domains/agent-gateway-runtime.md` | 不改变 Host 与会话生命周期 |
| `docs/context/tasks/TASK-TEMPLATE.md` | 任务结构 |
| `docs/context/tasks/CHECKPOINT-TEMPLATE.md` | 续接检查点 |
| `docs/context/domains/site-environment-routing.md` | 追加发布时核对现有公开域名 |
| `docs/context/domains/release-gitops.md` | 确认 EO 直接发布区别于 GitOps，不修改集群 |
| `docs/context/project/adjacency/argocd-ci-secrets.md` | 发布邻居；核验现有静态发布测试 |
| `opencraft/docs/build-matrix.md` | 发布 Web 交付面，使用现有 LightVela Web 产品构建 |
| `frontend/src/styles.css`、`frontend/src/components/site/brand-mark.tsx` | 有界查找现有字体和品牌资产：官网字体与图片 Logo 不等同于用户所说的 Vela 定制字体 |

## decisions
- 双入口归属 Sidecar Footer；原先脱离侧栏的全窗底栏方案已被用户否决。
- 去掉重复图钉和额外装饰，复用共享按钮/菜单；通过入口按下态表达固定，展开菜单提供固定操作。
- Sidecar 只表示物理容器，不固化“应用 → 会话”的业务层级；用户继续授权后，将现有 leftPanel 变成可选上下文插槽，不增加新的扩展协议。
- 聊天保留会话列表，设置保留索引，扩展页面不提供上下文；无上下文时只有应用导航栏。顶部开关收起整个 Sidecar，不改写 Pin 偏好。
- 视觉按用户的轻柔、低存在要求收敛：应用行和原 Sidebar 共用 navigation-control；标题采用次级字号字重、分隔线用弱边框 token，入口无外框/阴影/图钉徽标。保留文字可读性，不对整个容器降低透明度。
- 默认固定应用，个人默认按需展开；偏好与当前路由/会话无关。
- 所有左侧宽度聚合为同一 MotionValue，标题栏、内容区及右侧面板共同消费。
- Radix 拥有临时窗口焦点、Escape 与外部点击，不添加手写焦点循环。
- Expo 不共享 DOM 或存储实现；原生适配验证前不冻结契约。
- Primary Pane 使用专用 `SidecarPrimaryResizeHandle` 事务；Context Pane 的通用 `SidebarResizeHandle` 恢复为纯两态实现，两者不共享三态分支。入口采用共享 sidebar-entrance 行按钮变种，不以常驻大底色表达固定。
- 最新澄清撤销常驻实体表面：sidebar-entrance 复用 navigation-control 的透明默认态和浅色状态底色，删除专用抬起/凹陷 token。Pin 仍绑定 aria-pressed，不另加图钉；语义 button 保留键盘可访问性。
- 取消 136px 固定宽度：纯模型提供左右等距 inset，Shell 用已有 MotionValue 提供当前最左栏宽；左入口保持正方形，右入口撑满剩余空间，Pin 不重挂载且左下锚点不变。
- Sidecar 新增可伸缩 Pane 视口和不收缩 Footer 布局行；FloatingLeftPanel 也通过独立 footer 插槽共用边界，取消用业务列表 padding 为零高度覆盖层让位。
- 顶栏横线资格改用窗口宽度减右侧物理面板宽度，两者由 Shell 动画所有者提供；移除主区 DOM 宽度与左栏动画宽度相加的跨帧反馈。保留正常窗口响应式和右面板影响。
- Home 改为 Vela 字符字标，并同步隐藏测量副本；预留独立品牌字体变量，字体文件/本轮重新设计意图尚待用户确认，不声称已完成定制字体。
- 应用 toggle 在跨端 reducer 中直接翻转宽屏停靠偏好，窄屏仅控制导航抽屉；Web 去掉应用菜单中的 Pin 操作，保留 Radix 对焦点/关闭的所有权及账户独立菜单。
- 设置原先已在 AppShell 中却显式禁用 docking、隐藏顶栏导航并启用私有响应式控制器。现删除这些例外及未再使用的 use-settings-presentation.ts；有 Host/零 Host 两条入口均以 SettingsNavigation 的 sidebar 内容变种替换上下文插槽。调宽、收起、窄屏瞬态仍由已有 Shell 原语统一控制，不创建新的三栏设置布局。
- Sidecar 绘制唯一连续材质，应用栏、上下文栏和 Footer 不再重复绘制背景与模糊，消除底部白条和邻栏灰块；临时侧栏 Footer 使用其已有容器表面。
- 用户重新确认平台模型为“一个 Sidecar、两个内部 Pane”，不是两个独立 Rail 拼接。删除 `CollapsibleRail` 与通用 ResizeHandle 的三态分支；`SidecarPane` 唯一拥有 Frame/Clip/Viewport，Primary 专用事务拥有三态手势，Context 继续使用独立两态事务。
- `railDetent` 与 application/account Pin 完全解耦；hidden 只改变 Primary Pane 的物理呈现并保留 `lastVisibleRailDetent`，入口重新打开时恢复该档位。
- Footer compact 不再改 inset 或改成等分列；两个入口的左侧坐标与应用方形帧保持稳定，仅账户入口尾部空间可伸缩。Primary/Context 分隔线改为从 toolbar 下沿开始的内容区伪元素。
- Header 删除对 compact 状态的后代选择器；全局窗口动作只由 Window Chrome/route policy 决定。
- Primary 交互层改为单一 motion owner：pointer transaction 只写 Frame MotionValue，Viewport 透明度只读 panel visibility，Footer 只读最后提交的 expanded width。compact/expanded 在 settle 开始时提交语义，hidden 在 Frame 弹簧到零后提交；新手势会停止并接管未完成的 settle。
- Primary 内容层使用 Motion 派生 CSS 变量而非语义档位 CSS 突变：Frame 在 compact 与当前 expanded Viewport 之间的归一化几何进度连续驱动 row width/padding、label opacity/x、heading height/opacity/y 与 icon scale；稳定 Viewport 复用 committed expanded width，因此选中背景和文字在 Clip 边界到来前已经完成收束。
- Application Primary Pane 的默认两档收窄约 30%：compact `52px`、expanded `182px`、expanded minimum `168px`。Context Pane 保持原宽；Footer 拆为独立最小 `260px` 几何，不能因 Primary 收窄而截断账户，也不能消费 held-pointer preview。旧版裸数宽度偏好升级为 v3 key，避免历史 `260px` 默认值覆盖新默认。
- Primary Motion owner 现同时拥有 live expansion 的 Viewport 写入：右拉超过 committed expanded width 时 Frame、Viewport 与 row surface 同帧扩张；左拉仍保持稳定 Viewport 并由 Clip 收束。cancel/settle 负责恢复或提交 Viewport，Footer 始终只读 committed width。
- compact action size 成为 runtime metric `34px`，独立于 `52px` rail width；Motion 同源派生 9px 居中 inset、34×34 row、收拢 gap 与 icon padding，保证图标和选择面共中心。
- 账户头像槽由 shell-navigation surface 自己声明 `28px` 变量和不可收缩 flex basis，不再借用 `.sidebar-panel` 的局部变量。Footer 入口以 `data-surface` 选择，不使用会被 Radix Portal 子节点改变的 `:first-child/:last-child`，因此打开账户浮层不改变 padding、gap 或文字 x 坐标。

## evidence
- 本轮修复的 source commit 尚待生成；`origin/master@c914eb43a` 与工作基线一致，无需冲突融合。完整 gate 与真实 Chromium 已在提交前通过，部署回执将在发布后补录。
- 最新 `origin/master@fc624a0dc` 已与 Sidecar 实现融合为 `eec248ae6`，并以非强制 fast-forward 同步到 `master` 与 `codex/hermes-create-guide`。master 的 Context leading-slot 对齐保留，已删除的旧账户触发器没有被冲突合并复活。
- 融合后的 master 已发布到 EdgeOne Pages 生产项目 `vela-cn`：部署 `dpr7x6zi8prk`，buildId `20260911091444-7cd09926ce24`。正式域名返回同一 buildId，包含 Announcement runtime chunk 的 10 项关键产物 SHA-256 与本地 release 完全一致；无存储的新 Chromium 会话确认根节点具有 `has-shell-navigation`，Primary Pane 为 182px，Vela/Chat 均可见且没有 page error。
- 本轮单 Sidecar/双 Pane、三态 Primary 交互、窄 Application/Footer 几何与 Announcement data-image 契约已形成实现提交 `791f25855`（`feat(opencraft): model responsive sidecar navigation`）；提交不包含部署凭据。
- Announcement Lab 线上异常已按平台契约修复并发布到 EdgeOne Pages 生产项目 `vela-cn`：部署 `dpi1y155gofn`，buildId `20260911080246-2bbab71fea53`。2.9KB SVG 保持 Vite 自然内联；运行时接受受限 `data:image/*`，拒绝非图片 data URL。正式域名返回同一 buildId，包含修复逻辑的 runtime chunk 及 HTML/JSON/入口/6 个 CSS 共 10 项 SHA-256 与本地 release 产物一致；真实 Chromium 已在正式域名打开 Laboratory、点击 Preview announcement，确认 dialog 与 data-image 正常呈现且无 page error。
- 当前工作分支已安全暂存本地改动后 fast-forward 合并 `origin/master` 至 `b4842ce2c`，随后完整恢复本地 Sidecar 工作；`app.scss` 冲突按结构同时保留 master 新增的共享 button 样式入口与本任务 shell-navigation 样式入口，Context catalog 由源任务包重新生成，不以冲突标记或单边覆盖收尾。
- 合并 master 后的 52/182px Application 默认宽度与独立 Footer 几何已发布到 EdgeOne Pages 生产项目 `vela-cn`：部署 `dp6wdka39vqg`，buildId `20260911075137-926661c84882`。正式域名 `chat.lightvela.com` 已返回同一 buildId；`index.html`、`version.json`、入口 `assets/a-03scuAA5.js` 与 manifest 汇总的 6 个 CSS 资源共 9 项 SHA-256 均与本地 LightVela Web release 产物一致。
- 当前本地窄 Application 几何在实际 AppShell 浅/深色截图中确认：52px compact 只保留完整图标，182px expanded 保留完整应用文字；275px Context 不变，260px Footer 跨越窄 Primary 并保持入口锚点及完整账户名。内容 Motion progress 改由实时 Frame 与独立 Viewport width 归一化，不再硬编码旧 240px 端点。
- Motion 内容编舞经用户明确授权发布到 EdgeOne Pages 生产项目 `vela-cn`：部署 `dpgojbqarwzs`，buildId `20260911071405-71ea9679ffe2`。正式域名 `chat.lightvela.com` 已返回同一 buildId；`index.html`、`version.json`、入口 `assets/a-DGvpJ8jl.js` 与 manifest 汇总的 6 个 CSS 资源共 9 项 SHA-256 均与本地 LightVela Web release 产物一致。
- 当前本地 Motion 内容编舞在真实 Chromium 半程 held-pointer 帧中确认：Viewport 整体 opacity 保持 1，条目宽度小于实时 Frame，标签 opacity 已降至 0.5 以下，避免选中块和文字触碰 Clip 后才消失；compact 终态标签 opacity 为 0，图标与 Footer 锚点保持不变。
- Primary 交互层重构经用户明确授权发布到 EdgeOne Pages 生产项目 `vela-cn`：部署 `dpa16nn1oxpd`，buildId `20260911065122-c9b0327a34e7`。正式域名 `chat.lightvela.com` 首次轮询即返回同一 buildId；`index.html`、`version.json`、入口 `assets/a-Chtf7Sss.js` 与 manifest 汇总的 5 个 CSS 资源 SHA-256 均与本地 LightVela Web release 产物一致。
- 有界检查本地 Codex renderer bundle 的 `SKa` resize owner 与 `nYa` left-panel 组合：pointermove 直接连续写 size，外层消费 animated width，稳定内层使用 visible width/min-width；内容 opacity 只来自 visibility progress，程序化收放使用 `{ type: "spring", duration: .5, bounce: .1 }`。OpenCraft 的重构只移植这条交互所有权，不复制业务内容。
- 当前本地 Primary 交互层已移除 `contentOpacity` preview 和 Footer preview 写入；新增 `useSidecarPrimaryMotion` 统一拥有 dragging/settling/idle、动画中断和语义提交边界。真实 Chromium 按住阶段确认 Viewport opacity 为 1、Frame/Clip 连续处于 detent 之间、Footer 两入口坐标不变；释放后采集到多帧 spring 并收敛到 72px。
- 单 Sidecar/双 Pane 与固定 Footer 重构经用户明确授权发布到 EO 生产项目 `vela-cn`：部署 `dphtn91nvexo`，buildId `20260911040727-e0e6830e850a`。正式域名 `chat.lightvela.com` 已返回同一版本；`index.html`、`version.json`、主入口与 manifest 汇总的 5 个 CSS 资源 SHA-256 均与本地 LightVela Web release 产物一致。
- 两阶段磁吸与 Settings stretch 修正版经用户明确授权发布到 EO 生产项目 `vela-cn`：部署 `dpgr68h4t895`，buildId `20260911025732-bafd722e0938`。正式域名 `chat.lightvela.com` 已返回同一版本；`index.html`、主入口与 manifest 汇总的 5 个 CSS 资源 SHA-256 均与本地 LightVela Web release 产物一致，`version.json` 规范化 JSON 内容一致。
- 当前本地实现新增 `expanded → compact → hidden` 两段磁吸：单次指针事务最多跨一档，展开态即使直接拖入隐藏区域也先提交 72px 纯图标栏；松手后第二次拖动才隐藏。展开宽度偏好与 compact 语义档位分别持久化，重新打开恢复上次语义档位。
- 单 Sidecar/双 Pane 重构的完整 `npm run gate`、202 项 Workbench 单元测试和真实 Chromium 111 帧导航门禁已通过。浏览器门禁逐帧确认 pointermove 不改变 committed detent、Preview 时 72px Frame/Clip 内仍保留 260px Viewport、Header 四动作始终完整、Footer 两入口保持固定坐标并显示完整账户内容、分隔线不进入 Header/Footer；当前重构尚未提交、推送或发布。
- 被本轮删除的前版 `CollapsibleRail` 曾向直接业务内容提供 stretch 契约；该契约已迁移到 `SidecarPane`，Settings 分类导航继续铺满 Context Pane。
- `CollapsibleRail` 平台容器重构经用户明确授权发布到 EO 生产项目 `vela-cn`：部署 `dp7k44ww7fr7`，buildId `20260911022213-b7597ec6c222`。正式域名 `chat.lightvela.com` 已返回同一版本；`index.html`、`version.json` 及 manifest 汇总的 6 个入口/CSS 资源均与本地 LightVela Web release 产物 SHA-256 一致。
- 本轮快速切换、设置共享容器、Footer 连续材质及前序轻柔/铺满修正已发布到 EO `vela-cn`：部署 `dpxck38pgkc7`，buildId `20260911012436-6674d55f8cd5`。正式域名版本一致，index.html、入口 `assets/a-6eiERoQc.js`、设置页面 chunk `assets/a-DA-ZkjNX.js` 和 manifest 中全部 5 个 CSS 资源的 SHA-256 均与本地 release 产物匹配。
- 当前按钮实体/Pin、Footer、Vela 文字入口和横线稳定性修正版已获授权发布：EO `vela-cn` 部署 `dpiiamdp4xhz`，buildId `20260911005755-4a8d38a6c809`。正式域名版本一致，HTML、入口 `/assets/a-7BPJ3sWv.js` 及 manifest 列出的 6 个 CSS 资源哈希均与本地 release 相同。发布前静态发布 6 项测试、release 构建与产品边界检查通过；Vela 仍为已告知的临时 UI 字体。
- 本地 Codex 解包的 `nYa` 左栏实现确认双层契约：外层消费 animated width，内层保持 target width/min-width 并将同一 progress 绑定 opacity。OpenCraft 已将该契约抽为平台 `CollapsibleRail`，应用与上下文两栏共同消费；尚未提交、推送或发布。
- 横线故障已在原实现真实浏览器中复现：启用正常动画、窗口 1536px、连续开合左侧栏时 `data-app-shell-thread-edge-divider` 同时出现 true/false。初次测试使用减少动画无法复现，已改成正常动画下重新加载页面后验证。
- 调宽/紧凑 1:3 入口版经本轮授权已发布到既有 EO 项目 `vela-cn`，部署 `dprofdaahxhn`，buildId `20260910180415-c4f357ca2e67`。正式域名版本匹配，index.html 和入口 `/assets/a-WWG5oS5o.js` 的 SHA-256 与本地 release 完全一致；发布前 6 项静态发布测试、release 构建和产品边界检查通过。
- 用户再次明确授权发布后，Sidecar/可选上下文/轻柔样式版已发布到现有 EO 项目 `vela-cn`，部署 `dpkn95rox7rp`，buildId `20260910174840-c33b94edec90`。正式域名版本、index.html 与入口 `/assets/a-6z2Ss_mR.js` 哈希均匹配本地 release 产物。发布前 6 项静态发布测试和 LightVela Web release 产品边界检查通过。
- EO 生产项目 `vela-cn`（`makers-trchezhsaa3t`）发布成功，部署 `dpovfdmxybv6`，buildId `20260910170537-7019c9f907f5`。公开 `chat.lightvela.com/version.json` 已返回同一版本，主入口 JS 的 SHA-256 与 mono2 构建产物一致。
- 追加发布前重新执行静态发布 6 项测试、LightVela Web release 构建及产品边界检查，全部通过；未变更本机服务或 GitOps。
- 开发前基线已按用户要求提交：`e9ceb92ba`。
- Web 类型检查与新增状态测试通过。
- 浏览器最近一轮连续 207 帧验证固定锚点、栏位总宽度、独立 Pin、焦点恢复、账户窗口交接、账户失败、草稿/路由保留、窄屏恢复及减少动画。
- 浅色和深色实机截图已检查；测试使用真实 AppShell/CSS，不连接线上 Host。

## risks
- 宽度变化需要覆盖浏览器/右侧面板几何。
- 原生视觉容器仍待第二阶段接入。
- 仓库 Context 全量测试存在其他历史任务元数据/语言等问题，不扩大本轮整改范围。

## validation
- 最新交互几何修复后完整 `npm run gate` 通过；18 项 Sidecar 聚焦单测及真实 Chromium Shell Navigation 门禁通过 119 个固定锚点帧。新增浏览器断言覆盖向右 held-pointer 时 Frame=Viewport 且 row 填满、账户浮层头像 computed size/flex-basis 为 28px、浮层打开前后账户文字 x 坐标完全一致、compact row 为 34×34 且图标中心偏差为 0。
- 融合 master 后 42 项 Sidecar/leading-slot/Announcement 聚焦测试和三个相关 workspace 类型检查通过；完整 `npm run gate` 通过，真实 Chromium Shell Navigation 门禁通过 122 个固定锚点帧。LightVela ultra-minified release 与产品边界检查通过，生产域名版本、10 项关键产物和应用栏实际 DOM/几何均已复核。
- Announcement data-image 契约修复后 Extension 全套 116 项测试、相关 workspace 类型检查、LightVela ultra-minified release 与产品边界检查通过；完整 `npm run gate` 再次通过，覆盖全部 workspace 类型检查/测试、Web 构建、Expo Web 导出及 Expo iOS bundle。回归测试同时确认合法 SVG data URL 可进入 Announcement snapshot 并正常结算，`data:text/html` 仍被拒绝；生产域名真实 Chromium 点击验收无 page error。
- 合并 `origin/master@b4842ce2c` 后完整重跑 `npm run gate` 通过，覆盖 master 新增的 announcement/release 测试、全部 workspace 类型检查/测试、Web 构建、Expo Web 导出及 Expo iOS bundle；真实 Chromium Shell Navigation 门禁通过 109 个固定锚点帧。LightVela release 构建与产品边界检查通过，静态发布测试 8 项通过；生产域名 9 项关键产物逐字节哈希一致。
- Application 默认宽度收窄及 Footer/Viewport 解耦后完整 `npm run gate` 通过，包括边界检查、全部 workspace 类型检查/测试、Web 构建、Expo Web 导出与 Expo iOS bundle；27 项聚焦测试及真实 Chromium 116 帧门禁通过，覆盖 52/182/168/260 四项几何契约、宽度偏好迁移、两阶段磁吸、Motion 中间帧、Footer 固定/铺满、账户不截断、Context 不变、长列表、窄屏、深色与 reduced motion。
- Motion 内容编舞后完整 `npm run gate` 通过，包括边界检查、全部 workspace 类型检查/测试、Web 构建、Expo Web 导出与 Expo iOS bundle；27 项 Shell Navigation/Sidecar 聚焦测试及真实 Chromium 最终 106 帧检查通过，新增断言覆盖半程条目收缩、标签提前淡移、稳定 Viewport、release spring、compact icon-only 终态及 Footer 固定。
- 发布前重新生成 LightVela 专用 ultra-minified release，产品边界检查及 6 项静态发布测试通过；EdgeOne 部署完成后正式域名版本与 9 个关键 HTML/JSON/JS/CSS 产物逐字节哈希一致。
- 本轮交互层重构后完整 `npm run gate` 通过，包括边界检查、全部 workspace 类型检查/测试、Web 构建、Expo Web 导出与 Expo iOS bundle；17 项侧栏聚焦测试及真实 Chromium 117 帧 Shell Navigation 门禁通过，新增覆盖 held-pointer 连续几何、内容不消失、Footer 不消费 preview、release spring 多帧收敛、hidden 延迟提交及 reduced-motion snap。
- 单 Sidecar/双 Pane 与固定 Footer 重构后，完整 `npm run gate` 通过，覆盖边界检查、全部 workspace 类型检查与测试、Web 构建、Expo Web 导出和 Expo iOS bundle。真实 Chromium 最终 111 帧检查通过，覆盖两阶段三态 Primary Pane、Preview/Commit 分离、稳定 Viewport、完整 Header、固定 Footer、Settings Context Pane 铺满以及分隔线只存在于内容区。
- 两段磁吸与 Settings stretch 修正后，26 项侧栏/导航聚焦测试通过；真实 Chromium 最终 139 帧固定锚点检查通过，覆盖单次拖动不能跳过 compact、第二次拖动隐藏、重新打开恢复 compact、反向恢复 expanded、键盘档位、刷新持久化以及 Settings 共享槽位铺满。最终完整 `npm run gate` 通过，包括全部 workspace 类型检查/测试、Web 构建、Expo Web 导出和 Expo iOS bundle。
- 应用快速切换、设置容器统一及 Footer 连续材质修正后，完整 npm run gate 通过，83 项聚焦测试和 6 项静态发布测试通过；最终浏览器 114 帧固定锚点、快速反向点击无应用菜单、设置分类真实组件替换上下文槽、窄屏抽屉、独立账户菜单、浅/深色同材质及铺满宽度、草稿保持等回归通过。初次门禁暴露一条仍要求设置隐藏顶栏的旧断言，已按新契约更新并完整重跑通过。发布产物构建及产品边界检查通过，EO 发布正在进行。
- `CollapsibleRail` 重构后 Web 类型检查及 24 项侧栏/导航聚焦测试通过；真实 Chromium 126 帧验证中间帧 Viewport 保持目标宽度、opacity 与 Frame 几何同源，同时覆盖快速反向、设置三栏、宽度拖拽、Footer 锚点、窄屏与深色；完整 `npm run gate` 通过，包含 Web 构建、Expo Web 导出及 Expo iOS bundle。
- 最新侧栏条目/铺满宽度修正后完整 npm run gate 通过（含 Web、Expo Web 和 iOS bundle）；68 项聚焦模型/几何测试通过。最终真实浏览器 135 帧固定锚点检查通过，覆盖透明默认态、无描边投影、悬停/展开/Pin 浅底色、拖拽过程中填满宽度、独立调宽与持久化、无上下文和临时侧栏铺满、正常账户名不被固定小槽截断、矮窗防覆盖及顶栏横线回归。截图来自实际 AppShell/CSS 测试夹具，不冒称登录产品端验收。正式设计映射和文档有效性通过；Context 仍为 26 项中 4 项既有失败、不涉及本任务，审计工具 33 项单测通过，仓库审计需人工评测，未宣称其评分通过。
- Vela 文字入口与横线资格修正后完整 npm run gate、Web 类型检查及 81 项聚焦测试通过；浏览器最终 136 帧固定锚点检查、Home 字标导航、1535/1536/1537px 下真实弹簧反复开合和双向拖拽期间横线不切换、右侧真实面板仍可改变资格均通过。定制字体未接入，不属于已验证交付。
- 按钮实体/Pin 反馈和 Footer 修正后，Web 类型检查及 81 项聚焦测试通过。最终浏览器 128 帧锚点检查通过，并覆盖浅/深色按下态差异、短窗口和长列表不覆盖 Footer、最后一项可达、临时侧栏独立 Footer；实际截图已核对。Footer 最终面板色调整后完整 npm run gate 再次通过，包括 Web、Expo Web 和 iOS bundle 构建。
- 追加调宽/紧凑入口后完整 `npm run gate` 再次通过，包含 Web、Expo Web 和 iOS bundle 构建；81 项聚焦测试通过。浏览器最终 101 帧固定锚点检查通过，并覆盖调宽后的锚点不变、键盘边界、双击复位、刷新持久化和按钮尺寸。
- 完整 `npm run gate` 通过：边界、全部 workspace 类型检查、扩展/AppServer/Chat/Workbench 测试、发布产物测试、Web/Expo Web/iOS bundle 构建。
- 聚焦状态与 Timeline 几何测试 65 项通过；真实浏览器测试通过，最近一轮 207 帧。
- 文档映射及文档有效性检查通过。
- `validate_context.py --build-catalog` 已重建 76 条目录记录；全仓校验仍因其他历史 Task Pack 缺少元数据及 5 条既有凭据扫描发现而返回失败，输出不包含本任务文件。未扩大范围修改历史文档。

## scan_scope / scan_output
有界检查 AppShell、Sidebar、账户提供器、扩展投影、相关测试；未修改生成代码。
追加调宽任务路由无匹配 Pack；有界检查 resize handle、共享 projection 及测试邻居。按 deobfuscate-javascript 技能只读检查本地 Codex bundle 的 rhn 账户按钮：透明 sidebar-item、xs 头像与行高；source map 缺失，未修改或重新还原参考代码。

## handoff
最新 master 与本轮 Sidecar 实现已融合为 `eec248ae6`，并同步到 `master` 和 `codex/hermes-create-guide`。融合产物已发布到 EO 生产项目 `vela-cn`，正式域名版本、包含修复 runtime chunk 的 10 项产物哈希及 182px 应用栏实际 DOM 均已核验。定制字体仍待资源确认，部署凭据未写入仓库。

## checkpoint
- stage：最新 master、Sidecar、leading-slot 与 Announcement 契约已融合到 `eec248ae6` 并进入 master；融合产物已发布。定制字体尚未接入。
- verified：融合后完整 `npm run gate`、42 项聚焦测试、真实 Chromium 122 帧、LightVela release 构建及产品边界检查通过。EO 部署 `dpr7x6zi8prk`，buildId `20260911091444-7cd09926ce24`；正式域名 10 项关键产物逐字节一致，应用栏/Vela/Chat 实际可见且无 page error。
- unverified：Expo 原生视觉未接入；Context 全仓仍有其他历史 Task Pack 元数据和 5 条既有凭据扫描问题，输出未涉及本任务文件。
- discard：全窗底栏、按钮必须在侧栏关闭后仍可见、所有应用必有会话栏。
- restore：本任务包及上述实现文件。
- next_action：等待线上视觉反馈；本地改动的提交与推送另行授权。Vela 定制字体接入仍待资源确认。
