# Workbench invariants: Shell and layout

[Invariant index](../invariants.md) · [Design index](../README.md)

## Owned DOM projection names

Shared Web chrome writes the current platform to `data-opencraft-platform`;
`data-opencraft-os` remains the explicit platform override input. Activity glyphs
use `data-opencraft-activity-icon`. These temporary attributes do not own
native engine protocol, persisted identities or glyph geometry.

## Experimental mobile Web container

The browser/PWA document paints its exposed edge from the appearance owner's
`edgeBackgroundColor` (theme surface), also projected as a system color hint.
The touch body consumes the same fallback edge token; the mobile drawer root stays
transparent. The translated foreground row paints the full viewport; its own
content padding reserves the top safe area and its header/dismiss hit region
starts below that inset. Do not pad the entire Shell root and thereby move its
background/rounding/shadow below the status-area boundary. The drawer's stationary
material plane is also full-bleed; only its content receives safe padding. Generated head bootstrap and runtime share the visible builtin
catalog and product fallback policy. A contributed theme unavailable at bootstrap
uses an explicit fallback until its provider loads, without persisting a new
selection. Manifest colors remain static installation defaults, not live theme
state. Native system pixels still require device acceptance. See
[Window appearance projection](appearance-and-controls.md#window-appearance-projection).
Desktop native-control reservations remain separate from CSS device safe-area
insets. The existing viewport owner and single content-inset application remain.

Touch Composer spacing retains the normal floating gap above the bottom safe
area. With an open software keyboard, existing keyboard gaps apply without
adding the Home-indicator inset. The overlay also respects landscape cutouts.
This padding leaves the timeline visible below the floating touch Composer.
The new-thread draft route likewise adds its device inset to its existing route
gap, and uses the original route gap above an open keyboard. Route-owned
available Composer height subtracts that same inset once.

The explicit public Expo Web-container entry packages the same complete Web
Workbench application/UI graph. Native owns safe area, lifecycle, back and
external navigation only; it must not duplicate Scope/View, drafts, navigation
or panel state. Viewport changes retain the mounted document. RN remains the
default until device/capability acceptance; downstream product assembly is
independent. Packaging, bridge and acceptance boundaries are owned by
[Mobile Workbench container](../../docs/mobile-workbench-container.md).

## Internal projection metadata identity

OpenCraft message projection writes use `__opencraft*` keys. The five exact
legacy aliases remain readable for saved snapshots; canonical values take
precedence. Normalization removes only those legacy aliases from newly derived
message payloads, preserves opaque fields and never mutates the saved input.
Source identity, steering acknowledgement and native protocol parsing retain
their existing behavior. Compound-command projections use the same canonical
source-item key as message projections.

## Floating material ownership

Shared floating surfaces consume design-system `material.web` and theme-owned
neutral frost roles. Backdrop color may show softly through the panel; a brand
fill or page-wide blur cannot substitute for glass. Menus/search are denser
than panels; circular touch chrome has inset-only shading. Geometry, Radix
focus and modal lifetime retain their owners. Solid accessibility/unsupported
filter fallbacks and explicit extension popover surfaces remain readable.
See the workbench language and `scripts/smoke/shell/smoke-frosted-materials.ts` for real
consumer, backdrop and fallback verification. Native appearance is unchanged.

Longing is an optional built-in blue glass palette in both light and dark modes.
Its theme definition owns the translucent Sidebar, cool surfaces and diffuse
navigation-to-content edge shadow. That edge reuses the established prominent
elevation (hairline, near shadow and diffuse shadow), preserving the original
pane transition instead of a separate accent-colored stroke. Settings previews and the mounted Shell
consume the same palette; selecting it preserves drafts, layout and focus.
Shared material fallbacks retain their existing accessibility ownership.
The unified Shell also consumes the theme's optional unified surface elevation
and context background; it must not replace Longing's glass edge with a flat
surface. Longing's browser titlebar shares the Sidebar background and recesses
behind the same reading-plane elevation at the top edge; it paints no horizontal
separator. The paint-only Header edge follows existing live Shell geometry and
panel apertures without intercepting input. Other themes retain their existing
Header separator, flat unified shell and opaque context.


## Floating sidebar presentation boundary

Shell owns visibility, live width, mobile progress and content identity. The
floating container projects those ports into stable header/body/footer slots;
ordinary prop and width changes preserve drafts and mount identity. Exit presence
immediately becomes inert, aria-hidden and pointer-disabled. Desktop entrance
translates the surface by -8px while its header counter-translates, then settles;
exit translation keeps opacity. Reduced motion skips settling. Mobile depth
consumes the same Shell progress, clamps 90–100% scale and 45–100% opacity, and
adds no separate exit animation. Its stationary wash remains a sibling outside
the scaled layer, consumes the same progress from 65% to zero opacity, and stays
transparent in reduced motion; Shell CSS retains material and hit-test ownership.
Existing resize transactions own bounds,
keyboard/default width, commits and cancellation; the floating resize port cannot
collapse the sidebar.
Other Shell, navigation, style and spring implementations retain their owners.

## Embedded panel host presentation

- Product-only draft heading decoration and its responsive rules belong to the
  explicit embedded product and are composed into its existing ShadowRoot. Shared
  styles do not select product artwork or reserve space for that artwork.

- Embedded panel viewport and its complete DOM content reuse the current conversation's panel service,
  renderer registrations and resource lifetime. Host commands must match the
  current runtime, Bot instance/Profile and conversation owner; unknown tabs or
  actions cannot bypass the product presentation policy.
- External container layout is explicit opt-in. Expo and standalone Web/Electron
  reuse the complete original toolbar, menus and content. Expo adds only host
  geometry and native shell controls/input, without a replacement tab manager,
  new Applications or per-tab WebViews.
- Host geometry uses available container space and the shared panel minimum/Chat
  reserve. A single embedded parent allocates sibling grid columns; Chat AppShell
  consumes its own containing viewport. Only narrow/full-width mode replaces Chat.
  One transient motion owner follows held input and completes/interrupts service
  intents; it does not own tabs or create a second persisted open state.
  Overlay makes only Chat inert; the same DOM plane remains accessible for
  panel content. Resize/full-width changes preserve tabs and drafts; closing
  releases resources through the original service lifecycle.

## Shell pane ownership

2026-10-14 主工作台导航拓扑更新：Web/Electron 的应用入口与当前页面上下文合并为单个 Sidebar（`ShellNavigationConfig.layout=unified`），桌面内部60px图标栏承载Home/扩展目的地，既有移动抽屉信号下同一组入口改为列表上方纵向全宽菜单（新建/设置在底部悬浮、列表全宽），桌面邻接列承载会话或设置列表，Settings/账户在竖栏底部。在任务等未提供上下文列表的桌面页面，Sidebar 仅保留图标栏宽度，主区域紧邻图标栏填满释放的空间；不显示空上下文的 resize 入口，不写回会话列表的保存宽度，切回会话恢复原宽度。窄屏保留完整抽屉与同一组应用导航动作，新建与设置在底部独立悬浮，隐藏个人头像/账号入口且不保留底板。整个 Sidebar 只有一个宽度、一个显隐入口；不显示独立 Applications 抽屉、Pin 或 compact 应用栏。旧 rail 偏好不参与该布局的空间预算，也不改写它们。浮动/固定呈现移动同一组 portal 内容，不复制上下文、草稿或滚动 owner；窄屏选择目的地关闭浮层。此条替代主工作台原有并排 Primary/Context 呈现，嵌入产品无 Shell 导航时沿用原契约。单一 leftPanelSlot 保留现有路由、扩展与空间策略。


| ID | 不变量 | 实现责任与证据 |
|---|---|---|
| SHL-01 | Pane 几何只投影一次；内容面板宽度、占位、聊天 Frame 均从同一 paneGeometry 读取 | workspace-pane-geometry.ts；纯函数矩阵及帧采样 |
| SHL-02 | Viewport 是 flex 裁切区域；Frame 宽度为 max(min(W,mainMinimum),W-min(R,A))，并且 min-width:100%；Frame 由原生 layout 右对齐 Viewport，X=min(0,Viewport−Frame)，空间不足时保留可读排版并向左平移；聊天容器查询归 Frame | AppShell + app.scss；最大化中间帧 Frame≥普通并排下界 |
| SHL-03 | 显隐与全宽进度分离，由一个 Shell 事务入口写入；模式切换先终止残余显隐，scope/reduced-motion 直接落到端点；旧完成回调被清理 | useWorkspacePaneAnimation；快速反向及 reduced-motion native trace |
| SHL-04 | 退出阶段保留同 scope 的主布局描述，完成后更新；模式交接不卸载聊天草稿或浏览器 backing；普通 resize 仍实时改变排版宽度 | mainLayoutSnapshot；草稿/WebContents身份＋held resize验证 |
| SHL-05 | 不绘制 Sidecar/main 边缘渐变。Header 的主表面上沿随既有 primary/context 实时宽度与 context 显隐进度向左延伸，形成包含原生按钮预留区的连续标题栏；不得等 context 卸载再切换绘制，或另设 CSS 动画时钟。上沿下边缘消费同一主面板主题 elevation，连接边裁切避免重复接缝，flat 不额外加阴影。横向细线与 Sidecar 标题栏下方的竖分界共用绘制进度；内容生命周期仍由 pane exit owner 独立保留。safe-area/几何/命中区不改、不复制原生按钮；主面板主题阴影/描边/flat、expanded/context 材质与浮动阴影保留，强制颜色使用系统分界 | Header + Sidecar + live motion + Design System/theme tokens；真实 AppShell 前 100ms 与中间帧上沿跟手、native reservation、十种主题 shadow authority/下沿像素与白色接缝负例、快速反向/held resize/显隐与浮动回归 |

边界：普通并排使用 shellSpaceMetrics.mainMinimum（480），保持既有空间策略。状态：63项聚焦测试、完整门禁、最终包556帧验收通过；Frame最低480而Viewport可到0，普通held resize及取消恢复通过。证据 /tmp/oc-pane-4aFgS4；草稿和WebContents ID保留。

### 下游产品国内嵌入预览面板

国内控制台隐藏发布允许右侧浏览器标签与对话文件只读预览，默认收起，复用 Shell resize owner。只读预览不提供目录树、搜索、编辑与终端入口；权限仍由 Host 决定。新草稿保留面板开关所在标题栏；面板元数据与会话绑定由本次 Bot 的 Application 内存持有，销毁时释放，不从其他账号或独立站点的 localStorage 恢复。

### Shared side-panel glyphs

Web/Electron and Expo consume one platform-neutral geometry definition in
`@opencraft/design-system/sidebar-toggle-glyphs`. The renderer owns SVG primitives
and platform hit testing; the 16-unit optical box does not dictate the touch
target. Mobile keeps 44-point targets with neutral, transparent toolbar buttons.
Panel visibility remains a projection of its existing owner, including after
a swipe; icon adaptation must not introduce a parallel navigation state.

### Header 首帧与浮动侧栏几何所有权

Header 的可见导航 rail 用 `max-content` 在同一次布局中保留真实控件宽度；面板动画只扩展外层槽位。Header 是控件测量值的唯一写入者，测量只投影给跨面板消费者，不反馈为该 rail 的最小宽度；Shell 不因侧栏或窗口 chrome 变化覆盖该测量值。

测量副本首次同步读取后，由同一 `ResizeObserver` 持续观察 border box；动作、品牌或字体改变实际尺寸时更新投影，等价 React 输入或侧滑状态不得重建观察器、重复同步测量。尺寸优先取 observer entry，缺失时回退几何读取；padding/border 变化同样必须更新，保留零尺寸保护与亚像素阈值。

浮动 Sidebar 的打开状态控制遮罩和切换按钮，不改变底层 Header 的导航动作集合和标题起点。只有停靠 Sidebar 接管展开导航时才移除底层新建动作。移动端打开、关闭、快速反转浮动 Sidebar 时，标题起点须逐帧稳定。停靠 Sidebar 仍按面板动画与动作集合变化调整标题位置。


## 受管站点品牌独立 Web 外观与导航

受管站点服务器显式启用 `join.server` 插件，插件拥有受管站点品牌名称、吉祥物、favicon 和安装清单；通用 Shell 通过 `applicationBranding` 独占贡献槽消费品牌，停用后恢复 OpenCraft。其他 Web 不隐式选择受管站点品牌。受管站点独立网页启用该插件时，吉祥物与受管站点品牌位于跨会话、任务和设置页面的统一 Header 左侧，侧栏开关在品牌区域右端；不显示左右历史箭头。紧凑布局品牌参与 Header 的真实测量，收起侧栏不隐藏品牌；触控布局的主页面Header隐藏图标与字标（侧栏Header保留），并从可见及测量轨道同时移除品牌宽度，让出会话标题空间。初始 HTML 与 Shell 文档标题使用受管站点品牌，当前页面/会话名仍前置；Electron 保留 OpenCraft，嵌入工作台不写宿主 document.title。中文开始入口为“开始整活”，任务与 Collaboration 的既有 action 保留；桌面图标栏仅显示图标，通过 aria-label 与 Radix tooltip 提供完整名称，不展开“玩一玩”标签；手机抽屉仍呈现完整文字行。

独立入口提供可选 Mist 浅深主题，侧栏与正文使用接近的中性底色，沿用主题偏好保存/恢复；下游产品嵌入不注册 Mist，现有默认主题不变。受管站点 Web 右栏初始使用既有 compact 档位，不改变已有拖拽或持久偏好。

有 Shell 导航的移动 Web 在 ≤640px 时，顶部栏 56px、按钮点击区 44px、图标 20px，标题使用既有 control-large 角色；固定与浮动导航 Portal、测量副本和正文顶部偏移保持同一高度。前进/后退保留在展开导航中，为顶部标题留出空间。宿主无 Shell 导航时继续拥有标题栏高度，桌面不变。

### Unified Shell 会话横向留白

触屏行高仅消费密度token：单行max(32px, --size-control-hit-min)，两行最小max(48px, --size-control-hit-min + 12px)；状态、头像与行菜单垂直居中。漏斗/右键的模式radio与filter checkbox共享indicator槽与文字轴，四种locale/桌面触屏均保留间隔。

core unified Shell 桌面将60px图标栏与列表列分开，移动抽屉纵向菜单位于全宽列表上方；列表标题（含筛选入口）、日期标题与会话行消费同一列表列inset，头像按内容宽度右对齐、右边缘与菜单间距固定。一行/两行共享右边缘，工作目录置于标题下方辅助行，无独立底板，过长省略，不占用标题行宽度。unified默认335px、最小300px（原列表默认275px/最小240px加60px图标栏），旧保存宽度按新最小值夹紧，未保存时消费frame新默认值；手机抽屉先按屏宽减64px保留关闭区域，再以共享frame.sidebarMobileWidthRatio（90%）收窄并取整；不写回桌面宽度、不缩小字体或触控目标；独立/嵌入侧栏保持原宽度。图标行的 icon-label gap、会话层次、右侧状态与菜单命中区保持原语义。下游产品两面保持旧 consumer 留白。

`scripts/smoke/shell/smoke-sidebar-thread-insets.mjs` 挂载真实 AppShell + Sidebar + ThreadRowMenu，以合成短/长标题、日期组、项目和状态测宽窄固定/浮动、选中/hover浅深几何；此前 Settings 列测试不代替会话消费链。

- Sidebar 会话行的产品徽标独立于共用状态/操作尾槽；运行、Goal、待处理、未读等仅用一个状态渲染器。桌面指向/聚焦/打开菜单时切换点号；触屏在同一44px菜单目标内并列状态与点号，不能另留状态列或重叠/挤动标题。

- Sidebar 共用尾槽沿用桌面28px、触控44px目标，与参与者内容间隔4px；头像不得占菜单点击框，状态画在同一框内。无菜单权限仍在相同位置呈现状态，不伪造操作。

- Sidebar 菜单占位由 ActivityItem 自身拥有，不依赖 ThreadRowMenu 或 Host 管理能力。断线、恢复、能力不可用和恢复不能改变标题、Server 来源、状态及徽标坐标；无授权时仍不呈现操作菜单。

- 受管站点品牌独立 Web 入口声明同源应用清单，固定 id/start_url/scope 为根路径，standalone 显示并提供 192/512 PNG 安装图标和 180px apple-touch-icon。Electron、嵌入式 Workbench 和下游产品 Web 不挂接受管站点应用清单；不通过 Service Worker 缓存会话、API 或页面来模拟离线能力。

### Shared floating material

Participant popovers and model/toolbar menus consume `menu.web.scss` `material`: elevated-secondary at 90%, 8px backdrop blur, shared border/radius/shadow. Page/sidebar backgrounds may be translucent and are not floating-surface tokens. Material is independent of menu geometry, typography and selection behavior; the participant popover retains its Radix and content ownership. Historical browser evidence named `scripts/smoke-participant-menu-material.ts` for computed material across Neutral/Frost/Lavender light/dark and desktop/touch. That probe is absent from this standalone checkout; the material contract above remains an acceptance requirement.

### Right-panel toolbar divider alignment

The right-panel toolbar consumes `--height-toolbar` as its content height. Its 1px bottom border is outside that height, aligning its top edge with the main content frame origin. The row must not flex-shrink; adding a border must not shorten the shared toolbar aperture or move its control centerline.

## Shell right-panel host replacement (2026-10-19)

The complete host is independently reimplemented after frozen requirements.
Shell owns visibility progress and content geometry; the host projects occupied
width separately from the atomic target surface width. Closed content becomes
inert immediately, while exit, keepMounted and an active resize can retain DOM.
Only the shared handle owns pointer capture and resizing feedback. Raw sizes
below the 160px shelf close without erasing the last preferred ratio; reaching
160 or above can reopen during the same held gesture. The parent and shared
geometry ports retain responsibility for actual width and minimums. Progress
and content-width changes publish invalidation ticks with effect cleanup.

Shared animation, resize, browser and geometry implementations are unchanged;
this disposition does not classify those dependencies or native platform behavior.

### Personal ToolbarDock

Conversation actions have stable IDs and a single Feature-owned handler, availability, label and pending state. ToolbarDock projects personal ordering into icon-only dock actions and overflow; it does not own task relations or conversation mutations. Default task linking uses the shared connected-object glyph (two rounded objects joined by links), with the localized link-task label retained for hover and accessibility, and is exposed when space permits. Shell owns capacity from independent context width, retained title budget, mandatory controls and shared density tokens; its inert sizing twin uses identical action availability, preference and capacity. Phone/mobile sidebar presentation always overflows; wide touch tablets may dock. Resizing never remounts a task dialog or discards search/draft.

Personal intent uses validated UiPreferencesRuntime storage keyed by account scope and dock identity. Empty means intentionally empty, absent means defaults. Unknown/unavailable action IDs remain stored; temporary overflow does not rewrite preference. Customization supports cross-zone dragging, keyboard sorting, add/remove, explicit save/cancel/reset and visible persistence failure. Drag gestures do not execute actions. Dialog focus returns to the connected invoking icon or visible overflow after capacity change. Icons have localized accessible labels/tooltips; neutral theme tokens and touch hit targets are shared.

Customization drag keeps the source slot in layout and paints a noninteractive, unscaled DragOverlay in the presentation root outside modal transforms/clipping. The active source never uses another list's sortable transform. Pointer hit testing first selects a zone, then its rows; nonempty parent zones do not compete with their children. Keyboard targets rows or empty zones. Draft membership changes only on drop, cancellation leaves it unchanged, and release has no source-return animation.

- Sidebar More menus open on a completed touch tap, after the browser has retained
  the gesture as a click. Touch down alone never opens them; movement beyond
  10 CSS pixels, ancestor scrolling, cancellation, another pointer, release
  outside the hit area or a hold beyond 500ms invalidates that tap. These guards
  never prevent native scrolling. Row long-press/right-click and Radix keyboard,
  focus, dismissal and the single Sidebar menu owner remain unchanged.


Web dropdown consumers use design-system-web/dropdown-menu. Direct touch/pen
opens only after a valid completed tap; movement, ancestor scrolling, cancel,
multiple pointers, release outside or holding invalidates it. Native pan remains
available. Radix owns mouse, keyboard, nested menus, focus and dismissal. Composer
model, permission and Add controls preserve the editor focus and selection on
touch; opening one retires the other picker without a delayed activation.


Keyboard acceptance must not manufacture a visible window by cropping at the
raw visual offset. Physical WKWebView capture has displayed Shell.clientTop=294
at screen y=294 while pageTop=scrollY=offsetTop=294 and visualHeight=394.
For that observed client frame, the Shell begins at zero and the send action
must fit within [0, 394]. An extra offset subtraction conceals double native-pan
compensation. Controlled browser geometry remains distinct from physical UIKit
painting; synthetic passing results do not establish device acceptance.


Keyboard diagnostics observe focused-Composer geometry, its local scrollport and
actual send hit target, rather than the first potentially parked submit button.
Capture-phase focus/touch/scroll and native viewport events open a bounded
read-only animation-frame observation window independent of port publication.
Brief editor/Shell position extrema survive the eight-per-second traffic budget;
touch screen/client and page/client differences remain separate numeric
observations. Reports contain no content or route, never drive layout, and all
listeners/frames are released with the host. These measurements do not establish
physical compositor painting or device acceptance.

### iOS Home Screen edge navigation

The Web bootstrap suppresses native history-back gestures in iOS Home Screen
apps (`navigator.standalone === true`). A non-passive capture listener cancels
single-finger `touchstart` in the leftmost 20 CSS pixels, before WebKit admits its
history recognizer. This strip remains inside the sidebar's reserved 24px edge;
it does not become a second sidebar gesture owner. Cancelling the initial contact
also reserves edge-origin taps/scrolls; normal content and controls are inset.
Middle/right contacts and simultaneous multi-touch retain native handling.
Ordinary browser tabs, embedded documents and Electron are unaffected. History
entries and URL changes remain real; explicit Back/Forward uses the original
router. Do not trap `popstate`, add dummy history entries or cancel every touch.
The bootstrap releases the listener on retirement/HMR and retains it across
persisted pagehide. Native Safari gesture acceptance requires a physical-device
check; synthetic DOM touch events only prove cancellation and routing isolation.
