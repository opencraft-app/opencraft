# Workbench invariants: Shell and layout

## Shell navigation and page chrome coordinate ownership

The application Router remains the sole owner of destinations, parent paths and
history. Shell owns persistent navigation and native-control reservations; pane
geometry owns the space available to a page. A page owns its header, scrolling
content and page overlays. Route motion translates only that page presentation,
never the persistent brand, sidebar toggle or application entrance. Desktop
semantic Back belongs beside the page title, not in place of Shell's sidebar
toggle. Compact layouts place leading actions on the moving page; this is a
placement projection, not a second navigation or action owner.

`ShellPresentationContext` supplies that physical placement. `AppShellHeader` adapts
the same shared navigation controls into Shell and page slots. One intrinsic
measurement stays mounted across placement changes; only its single writer
publishes the Shell reservation. Page chrome reserves only the portion extending
past the sidebar, using the existing live pane geometry. Header paint is projected
into that same page-local basis. Spacing, materials and hit geometry keep their
existing semantic tokens; no screenshot-derived sidebar-width compensation is
allowed.

Page frames establish their layout containing block both at rest and in flight.
Adding or removing a route transform cannot change a fixed descendant's origin.
Browser safe top is allocated by the existing row; a scroll-under page's header
consumes only that page's exact bleed allocation. The Shell navigation rail has
its own stable home rather than a body portal chasing a measured placeholder.
Its input/focus and overview suspension retain the existing Shell ownership.

Portal mount location does not establish semantic ownership. Page overlays still
consume `ShellPageOverlayContext` and the existing route/drawer motion projection;
global modal placement stays with its current owner. Outgoing route snapshots may
contain page chrome, never persistent Shell controls. Readiness, interrupted
travel and gesture commit/cancel remain with `RouteStackMotion`; it neither
commits navigation nor creates another resource, draft or conversation owner.

`tests/shell/route-chrome.browser.ts` shares the actual Shell/Router/IM fixture
with the lifecycle test. It samples enter, return, rapid re-entry and pane resize
in docked/collapsed desktop, wide touch and mobile/reduced-motion layouts. It
checks stable local header bounds, unchanged Shell controls, snapshot membership
and retained unsent drafts. The fixture's account/RPC/storage are synthetic;
these checks do not certify a physical phone or production authentication.

## Sidebar reading width without an icon rail

The unified desktop sidebar measures one context column and a normal-flow
horizontal bottom action row. Default and minimum widths describe the reading
column itself, without an additional vertical icon-rail allowance. Saved user
widths remain valid. Applications follows the sidebar toggle in the leading
header rail, including its inert width measurement; the trailing rail keeps
page actions and the preview control. Narrow mobile drawers retain their labeled
Applications destination. Docking,
held resize, context portals and mobile gesture/safe-area owners retain their
existing geometry and lifecycle.
The docked desktop browser Sidecar paints its theme-owned background once across
the brand/header, list and bottom actions. Its nested column and child slots stay
transparent, avoiding separate color bands at either end of the list. Floating
desktop columns retain their own surface owner. Mobile floating controls retain
their existing material and safe-area ownership.


[Invariant index](../invariants.md) · [Design index](../README.md)

## Desktop first-use welcome preview

The developer Laboratory exposes the desktop welcome page manually. It uses
the existing fullscreen ModalSurface, preserving the mounted Workbench, drafts
and current Settings route. Normal startup is unchanged. Local setup opens the
enabled builtin Host's declared model-configuration Settings page through the
application Router. The server form delegates authentication to Main's desktop
server owner. Main probes the remote execution ingress, showing a temporary isolated
sign-in window when needed and closing it before a remote Workbench is rendered.
The target server and its plugins own identity and authorization; the desktop does
not require an Actor discovery endpoint or a private identity plugin API.
A scoped `opencraft.desktop-server` provider carries the existing AppServer protocol
through a native-held immutable credential snapshot, never a fabricated Human identity.
The application saves a profile only after protocol preflight, then opens a fresh
remote draft through its existing Router, retaining the previous draft. Closing,
leaving or cancelling configuration revokes pending authentication and preflight;
late results cannot save or navigate. Scope loss retires the profile/runtime and
private query projection. Startup reauthorizes the address under a fresh client scope
and drops prior cached identity, roots and query data. Network recovery reuses the
immutable credential snapshot; browser cookie changes cannot replace its account.
Authorization rejection retires the scope. Denial, HTML or execution
service errors never constitute admission. Renderer reload/crash cancels authentication
and releases all native bridges and credential snapshots.
Normal startup and onboarding-complete state are unchanged.

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

Requested standalone/fullscreen browser overlay documents keep html/body and the
main Shell in document flow. At rest, CSS `100vh` owns the complete canvas;
status-excluded `innerHeight`, `clientHeight` or VisualViewport reports must not
replace that resting extent. The existing viewport owner signals actual geometric
contraction separately from keyboard focus; only the contracted Shell uses its
available height. Pinch alone does not contract the canvas, and blur does not end
an observed contraction. No second measured-canvas variable is introduced. The row's interactive
content is also capped by CSS `100dvh`, so an oversized `100vh` paint canvas
cannot move the Composer beyond the dynamic window. This CSS cap does not
reinterpret status-excluded client/visual reports, add inset compensation, or
replace the viewport port's keyboard contraction.
The body-relative drawer portal uses an absolute document frame. Do not fix the
document roots or main Shell. SafeLayout allocates the main content bottom once;
independent drawer action surfaces keep their own allocation. Do not add a
CSS/client metric difference as padding or subtract a status strip from the full
canvas. Native overlay acceptance and physical pixels still require device evidence.

Any geometric contraction uses the existing VisualViewport capacity through
blur, independently of focus. The single Web viewport port projects origins for
both coordinate bases: document frames use the visible page origin; fixed
consumers keep the independent native fixed-reference correction. Neither may
consume the other's offset. Document scrolling, focus, draft and native selection
are preserved rather than force-reset. Ordinary tabs and native hosts retain
their fixed geometry. No screen arithmetic, fixed cutout size or new observation
clock is used. DOM dimensions and browser simulation do not prove physical native
painting; device acceptance remains explicit.

### Touch conversation scroll-under

For the floating touch conversation header, the reading surface may bleed upward
by the row's allocated top inset. That exact CSS inset is added to the transcript's
initial content padding (and the new-task layout's top reserve), not subtracted
from the scrollport. At scroll start the first content remains clear of system
and app controls; on scroll, the same mounted text can pass behind the status
area. Touch conversation chrome has no full-width Shell veil or backdrop-blur
overlay above this reading plane. The header hit targets retain their original
safe position. Adjacent preview tools retain that safe origin and the original
remaining height; only the reading plane extends under the edge. No scroll
threshold, duplicate transcript, screen arithmetic,
viewport owner or resize/scroll observer is introduced. Settings, other routes,
Sidecar and native desktop keep their existing allocations. Device status-bar
compositing still requires physical acceptance.

For existing touch conversations, reading also extends through the row's allocated
bottom inset. The main surface and reading viewport bleed by that exact CSS
allocation, while `main-content-body` retains its protected rectangle as the single
Composer overlay anchor. Its children may paint beyond that rectangle only within
the full-bleed main surface's clip. Preview tools and body-level browser Composer
portals retain the same protected geometry. The inline footer places the same
allocated space inside the expanded scrollport, preserving the Composer's original
bottom position while transcript paint can continue beneath it. This is not a
second device-inset lookup or a canvas/client metric tail. New-thread and ordinary
routes retain their protected frame; keyboard projection still owns when the
allocation becomes zero. Test full scrollport paint as well as Composer placement.

### Shared safe layout container

`@opencraft/design-system-web/safe-layout` owns device inset consumption inside
the surface border-box. Background/material remains on that same full-bleed box;
safe content does not move the paint origin or create a separate color strip.
Callers explicitly allocate `edges`; nested containers omit edges already consumed
by their ancestor. `minimumInsets` preserves ordinary spacing using max, not an
extra copy of the device inset. Unselected edges retain consumer styles.
CSS env is the geometry authority; a host may project `--safe-layout-inset-*`
at its viewport boundary. The container does not measure screens, guess cutouts,
observe keyboard geometry, or own theme/scroll/motion state. Shell's stable Motion
adapter uses the same DOM box. Browser hosts allocate the row's top and bottom edges regardless
of sidebar docking/transient presentation; a zero device inset is not a disabled
container. The fixed header consumes the same host top source. Electron keeps its
native window control reservations. Bounded diagnostics report the top-allocation
flag separately from resolved padding. The drawer frame owns top/left; its native
scrollport paints to the bottom edge, with end padding that lets the final row
scroll above the floating actions and device inset. Intermediate rows may scroll
behind those actions; their transparent hosts must not reserve an external margin
or a full-width bottom plate. Only the floating action
hosts allocate the bottom safe edge; moving that inset back to the whole drawer
would hard-clip the scrolling list above the physical bottom. The existing 16px
action clearance is retained in the hosts' minimum reserve, not duplicated by
an ancestor. Fixed header/hit-region offsets consume the same inset source.
The Shell row is the main content bottom owner. It consumes
`--shell-content-safe-bottom` once through SafeLayout. Routes and their measured body-level Composer portals retain ordinary
spacing only. The existing viewport keyboard signal makes the content device inset
zero while the software keyboard occupies the bottom edge. Drawer action surfaces
remain independent; full-screen modal surfaces allocate their own edges. Document geometry and
physical host drawing acceptance are separate: this primitive cannot promise
that an opaque system status strip becomes part of the document viewport.

In portrait Apple standalone browsers with Safari 27-era `:heading` support,
Shell adds 24 CSS pixels of content clearance below the device top inset. The
existing window-presentation projection identifies standalone mode, including
Apple's navigator flag; touch-callout and heading support bound the CSS adapter.
These capabilities are a compatibility proxy, not an exact iOS version. The
row, floating drawer, header and transcript's initial content consume the same
top allocation. Canvas extent, full-bleed background, scroll-under, status-bar
metadata and keyboard/bottom allocation are unchanged. Tabs, landscape, native
hosts and engines without these capabilities retain their existing spacing.
This avoids the native progressive-blur band; it does not disable the system
effect, and physical iOS 27 acceptance remains separate from browser simulation.

Touch Composer spacing retains the normal floating gap above the bottom safe
area. With an open software keyboard, existing keyboard gaps apply without
adding the Home-indicator inset. The overlay also respects landscape cutouts.
This padding leaves the timeline visible below the floating touch Composer.
The new-thread draft route uses the same Shell-protected content box and retains
its existing route gap. Its available Composer height measures that reduced
containing block; it never subtracts the device inset again.

The explicit public Expo Web-container entry packages the same complete Web
Workbench application/UI graph. Native owns safe area, lifecycle, back and
external navigation only; it must not duplicate Scope/View, drafts, navigation
or panel state. Viewport changes retain the mounted document. The packaged Web
container is the public default; the separate RN workbench has been retired.
Downstream product assembly remains independent. Packaged modules load lazily
through a fixed native asset registry, never an arbitrary file or remote-code
reader. The built-in ready surface uses the full safe-area viewport; source
selection lives in Web settings with independent native startup/error recovery. Packaging, bridge and acceptance boundaries are owned by
[Mobile Workbench container](../../docs/architecture/mobile/mobile-workbench-container.md).

A Settings destination invoked from the floating applications drawer uses the
same Shell `onInvoke` dismissal as other destinations. Do not leave the former
drawer covering the new controls on narrow displays. Category navigation remains
available through the ordinary sidebar action; no feature-owned overlay or
second navigation state is added.

## Internal projection metadata identity

OpenCraft message projection writes use `__opencraft*` keys. The five exact
legacy aliases remain readable for saved snapshots; canonical values take
precedence. Normalization removes only those legacy aliases from newly derived
message payloads, preserves opaque fields and never mutates the saved input.
Source identity, steering acknowledgement and native protocol parsing retain
their existing behavior. Compound-command projections use the same canonical
source-item key as message projections.

## Floating material ownership

Touch narrow full-width panels share one bottom material rail across every tab
kind. The rail consumes the same floating ControlSurface as Shell chrome, with
one shared LiquidGlassBackdrop for the group. Buttons use the shared Button and
IconButton owners; the feature does not repaint or resize their internals. The
all-tool overview uses ObjectActionSurface/ObjectTitleButton for card activation,
shared close/create actions and SettingsTextInput for search. Main chat and the
inline tool launcher are always the first two cards; neither is a closable tool
or included in the tool count. Main chat and opted-in resident tools reuse their
existing physical view through a Shell-scoped retained-view registry. A stable
portal target uses an atomic DOM move when available. Otherwise a native top-layer
placement keeps the DOM in its original home and clips its paint to the card and
scroll viewport. React, iframe browsing contexts, media, xterm and resources stay
mounted; plain append/reparent must not reload embedded content. This tested
capability adapter and the confirmation paint adapter are the only native
placement API callers allowed by browser compatibility lint. Older engines without either capability retain the main-chat
entry rather than reload live content. Canvas-only viewers explicitly opt into
`previewFallback: reparent-safe`. The card scales the original viewport by width
and clips overflow, preserving native typography, Markdown, media and terminal
colors. Original logical dimensions, terminal grid, scroll and selection remain
owned by the existing view. Preview placement is inert and disables presentation
activity/history backfill; dismissing or filtering restores the same view before
normal interaction resumes, without automatically focusing terminal input. No second renderer, terminal, session or history
request is created for an overview. Border-box measurements compensate visual
scale, while ResizeObserver remains in original layout coordinates.
Side chat uses the same retained conversation view as primary chat, anchored to
the latest visible content. Its Markdown and code retain their original styles;
the input footer is hidden during preview without dropping the draft or view.
Inactive previews cannot backfill history or focus input on handback. Engines
without supported native placement show the same return entry as primary chat.
Closing a side chat uses the shared, localized confirmation request. Its compact
surface owns wrapped body copy and a separate wrapping cancel/destructive action
row. Cancellation and Escape leave the same live tool instances mounted. On
engines with native popovers, the confirmation scrim and content acquire a paired
top-layer paint lease above retained previews, including previews raised later;
Radix still owns focus, modality and dismissal. Engines without popovers use the
ordinary modal layer. The capability adapter is covered by the confirmation mode
of `scripts/smoke/shell/smoke-tab-overview.ts` with forced native/legacy placement,
touch cancellation, keyboard focus and light/dark/extended themes.
Compact preview titles occupy a fixed single-line header; horizontal title
scrolling leaves the close action fixed and must not activate the card. Terminal
cards reuse the actual terminal viewer's paint, grid and font through the
`previewPresentation: retained-view` registration, paired with `while-tab-open`
residency. Cached providers for other tools observe changes only while overview
cards are mounted, coalesce bursts and preserve the previous value during refresh.
Reopening reads current content. Search matches tool titles and says so. Creation actions come
from the existing toolbar registry, scroll within their card, and never require
a second creation sheet. The empty touch panel renders this same overview,
without search/count or a floating Composer. Search is explicit (opening does
not focus it), and filters apply only to opened tools. Preview data remains
read-only and cached by the existing owner; returning to chat or another tool
preserves mounted resources and drafts. Overview geometry, card/message colors,
radii, elevation and summary line limits consume the design-system
`tool-overview` semantic tokens; icon sizes use `workbenchIconMetrics.overview`.
Typography stays on the shared role registry. Material/accessibility projection
remains shared, including custom themes, reduced transparency and forced colors.
Modal scroll isolation must choose the wheel axis from each wheel event rather
than retain the axis of a previous touch gesture; the version-guarded
`patch-remove-scroll-input-axis.mjs` compatibility patch preserves that boundary.
The visible inline overview selects one Shell canvas through the existing touch
full-width presentation; Shell paints the complete SafeLayout row, including top
and bottom insets. Shell also reserves its toolbar height above the first card
row for persistent navigation; cards do not compensate for chrome. Panel chassis and inline content stay transparent. A hidden
retained panel cannot select that canvas. Fullscreen ModalSurface consumes the
same `background-tool-overview-canvas` token; only cards and controls add material.
Touch full-width panels do not mount the desktop creation/tab menu. Desktop
split panels keep it. Shell header suppression belongs to eager Shell styles,
never the lazy mobile toolbar chunk; cold empty entry must match warm entry.
Utilities retain the shared ModalSurface material; no feature-level button paint
is layered on top. The latest-turn reading card consumes shared
panel material, and its localized disclosure uses Button. The leftmost action always returns to the workspace in one tap; browser
history back/forward remain browser utilities. A flexible center displays the
browser address or the active panel title. The icon-only Agent toggle and all-tab
selector remain available when switching between browser, terminal, file and
extension-defined panels. The selector reads the existing panel owner, including
all types, their close capabilities and the available creation actions; it does
not maintain a browser-only directory. Browser keyboard and more actions occupy
browser-specific slots. Address editing expands the same input in place; a
remote software keyboard does not hide its keyboard control. Mouse presentation
retains its desktop toolbar. Shell retains drawer, safe-area and visual viewport
ownership and hides duplicate top controls while the shared mobile panel chrome
is active. Native Safari controls remain outside the document's ownership.
The dock reserves a stable content area; software-keyboard state reuses the
existing viewport projection rather than adding another resize observer.
Agent is on demand in this presentation, retaining the original Composer node,
draft, footer and conversation owner. The existing latest-turn renderer floats
as a narrower separate card behind that Composer, including process and reply
content; there is no enclosing Agent sheet or extra heading. Both stay inside
the protected Shell extent and above the rail using the same dock allocation.
The preview owns bounded scrolling and its own content-window observer rooted
in that scrollport. Portalled rows must not inherit the main timeline observer:
its DOM root does not contain them. The same thread and Turn renderers supply
all process and reply content; long activity remains windowed against the preview
itself. The Composer remains in front and the rail remains reachable. Overview dialogs use the shared modal adapter.
Verification: `scripts/smoke/shell/smoke-workspace-presentation.ts` covers real
Shell/Browser/Composer touch consumers, rail capacity, keyboard/safe-area
projection, draft/editor/page identity and mouse presentation. `scripts/smoke/conversation/smoke-conversation-overlay-content.ts` also
covers a hundred-item active Turn inside the real Conversation footer, scrolling
through process and commentary, streaming updates and the original draft/editor
after returning to chat on pointer and touch. System keyboard
behavior on a physical phone remains device acceptance.

Shared floating surfaces consume design-system `material.web` and theme-owned
neutral frost roles. Backdrop color may show softly through the panel; a brand
fill or page-wide blur cannot substitute for glass. Menus/search are denser
than panels; circular touch chrome has inset-only shading. Geometry, Radix
focus and modal lifetime retain their owners. Solid accessibility/unsupported
filter fallbacks and explicit extension popover surfaces remain readable.
Independent floating Shell buttons share the same neutral veil and effective
blur, including the SVG enhancement path. Non-touch Web and Electron header
navigation and panel controls blend into the bar: their resting surface
is transparent, with no glass disc, capsule backdrop or raised shadow. Hover,
press, keyboard focus, hit targets and command ownership stay with the existing
chrome control. The Shell selects integrated or floating placement through shared
Button/IconButton/ControlSurface props; no global feature attribute paints controls.
Touch conversation actions retain their floating material regardless of viewport
width or window host, following the shared UI density preference. Ordinary
navigation rows remain integrated even on a wide touch device. Footer
geometry must not replace that material or clip its background as a text label.
The existing lens resize owner reads the shared scattering length for an explicit
SVG Gaussian stage; icons and focus remain outside it. Verify the optical path
as well as its CSS approximation against changing backdrop pixels.
See the workbench language and `scripts/smoke/shell/smoke-frosted-materials.ts` for real
consumer, backdrop and fallback verification. Native window material remains
owned by the host, separate from control material. The ownership check and its
negative fixtures run in the normal boundary gate; capability/override, loading
geometry, focus and draft preservation are covered by `smoke:controls`.

On macOS Electron, translucent Sidecar navigation and its context list share the
BrowserWindow's native material, without a Web Sidebar veil, another backdrop
filter or an opaque context sheet. Sticky disclosures alone use the theme's
Sidebar-over-Window backing to occlude rows; the rest of the plane stays native. The entire
titlebar exposes that same plane across the Sidecar boundary. Theme-declared
opaque Sidebar colors remain authoritative below the titlebar; forced colors
use Canvas. Native focus/minimize fallback stays owned by Main. The
right panel's clip, surface, content chassis and toolbar remain transparent
through the same titlebar; its opaque reading surface and clipped vertical
divider begin below that band, including full-width and resize transitions.
The preview reading surface meets the internal divider with a square corner;
only the main reading plane's outer edge consumes the theme's content radius.
Verify the active window against a real desktop backdrop, including resizing and Sidebar
collapse; a renderer screenshot cannot establish native translucency.

Longing is an optional built-in blue glass palette in both light and dark modes.
Its theme definition owns the translucent Sidebar, cool surfaces and diffuse
navigation-to-content edge shadow. That edge reuses the established prominent
elevation (hairline, near shadow and diffuse shadow), preserving the original
pane transition instead of a separate accent-colored stroke. Settings previews and the mounted Shell
consume the same palette; selecting it preserves drafts, layout and focus.
Shared material fallbacks retain their existing accessibility ownership.
The unified Shell also consumes the theme's optional unified surface elevation
and context background; it must not replace Longing's glass edge with a flat
surface. The desktop browser presents full-height left and right columns: the
Sidebar keeps its material through its header, while the main reading background
continues through its own header region. MainContentSurface owns the complete
right-column background, including the transparent header and preview toolbar;
their reserved slots do not expose the window background or paint over controls.
The preview body does not cast an inner shadow below its toolbar, including
when the panel fills the workspace; elevation stays on the outer pane boundary.
On the application desktop, the leading sidebar-toggle slot becomes Home. It
invokes the Router's openChat intent to restore the remembered conversation or
draft; it does not toggle an empty sidebar, create a draft or navigate back.
The desktop projects both docked and transient Sidecar closed, so its wallpaper
uses the full workspace. This route projection does not write the user's sidebar
open/width preferences; Home restores the prior workspace presentation.
The wallpaper plane suppresses theme reading-pane elevation and horizontal
dividers at the Shell surface owner, including header content-edge and depth
projections. This applies to every theme; application windows keep their own
surfaces and controls.
The vertical pane elevation reaches the top, without an inset corner below the
toolbar. The surface follows the existing live Sidebar and pane geometry during
resize, collapse and reversal. Mobile floating presentation and
native macOS titlebar material retain their existing ownership. Longing paints no
horizontal separator. Header paint follows existing live Shell geometry and
panel apertures without intercepting input. Other themes retain their existing
Header separator, flat unified shell and opaque context.


## Floating sidebar presentation boundary

Shell owns visibility, live width, mobile progress and content identity. The
floating container projects those ports into stable header/body/footer slots;
ordinary prop and width changes preserve drafts and mount identity. Exit presence
immediately becomes inert, aria-hidden and pointer-disabled. Desktop entrance
translates the surface by -8px while its header counter-translates, then settles;
exit translation keeps opacity. Reduced motion skips settling. Mobile depth
consumes the same Shell progress and clamps 90–100% scale, with no opacity
animation on the ancestor of glass controls and no separate exit animation.
Its stationary wash remains a sibling outside the scaled layer, consumes the
same progress from 65% to zero opacity, and stays transparent in reduced motion;
Shell CSS retains material and hit-test ownership. This separation keeps
`backdrop-filter` descendants in a stable opacity/compositing context.
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

应用目录的开关位于导航栏 Home 紧右侧，使用共享 grid 图标和 aria-expanded；开关仅折叠或展开同一侧栏目录，不导航或关闭触控抽屉。目录不再显示顶部重复「应用」按钮。sidebar-primary 扩展入口与 miniapp 同列显示，sidebar-footer 保留在导航栏；平台监控沿既有命令打开监控页，权限与能力探测不变。折叠、主题和路由切换保留聊天草稿及上下文实例。


2026-10-14 主工作台导航拓扑更新：Web/Electron 的应用入口与当前页面上下文合并为单个 Sidebar（由 `AppShell.navigation` 提供应用导航），桌面内部60px图标栏承载Home/扩展目的地，既有移动抽屉信号下同一组入口改为列表上方纵向全宽菜单（新建/设置在底部悬浮、列表全宽），桌面邻接列承载会话或设置列表，Settings/账户在竖栏底部。在任务等未提供上下文列表的桌面页面，Sidebar 仅保留图标栏宽度，主区域紧邻图标栏填满释放的空间；不显示空上下文的 resize 入口，不写回会话列表的保存宽度，切回会话恢复原宽度。窄屏保留完整抽屉与同一组应用导航动作，新建与设置在底部独立悬浮，隐藏个人头像/账号入口且不保留底板。整个 Sidebar 只有一个宽度、一个显隐入口；不显示独立 Applications 抽屉、Pin 或 compact 应用栏。旧 rail 偏好不参与该布局的空间预算，也不改写它们。浮动/固定呈现移动同一组 portal 内容，不复制上下文、草稿或滚动 owner；窄屏选择目的地关闭浮层。此条替代主工作台原有并排 Primary/Context 呈现，嵌入产品无 Shell 导航时沿用原契约。单一 leftPanelSlot 保留现有路由、扩展与空间策略。


| ID | 不变量 | 实现责任与证据 |
|---|---|---|
| SHL-01 | Pane 几何只投影一次；内容面板宽度、占位、聊天 Frame 均从同一 paneGeometry 读取。最大化／还原时工具内容与外框同步连续调宽，不预先切到终点宽度；显隐单独裁切，减少动态效果直接落点 | workspace-pane-geometry.ts；纯函数矩阵及帧采样 |
| SHL-02 | Viewport 是 flex 裁切区域；Frame 宽度为 max(min(W,mainMinimum),W-min(R,A))，并且 min-width:100%；Frame 由原生 layout 右对齐 Viewport，X=min(0,Viewport−Frame)，空间不足时保留可读排版并向左平移；聊天容器查询归 Frame | AppShell + app.scss；最大化中间帧 Frame≥普通并排下界 |
| SHL-03 | 显隐与全宽进度分离，由一个 Shell 事务入口写入；模式切换先终止残余显隐，scope/reduced-motion 直接落到端点；旧完成回调被清理 | useWorkspacePaneAnimation；快速反向及 reduced-motion native trace |
| SHL-04 | 退出阶段保留同 scope 的主布局描述，完成后更新；模式交接不卸载聊天草稿或浏览器 backing；普通 resize 仍实时改变排版宽度 | mainLayoutSnapshot；草稿/WebContents身份＋held resize验证 |
| SHL-05 | 不绘制 Sidecar/main 边缘渐变。Header 的主表面上沿随既有 primary/context 实时宽度与 context 显隐进度向左延伸，形成包含原生按钮预留区的连续标题栏；不得等 context 卸载再切换绘制，或另设 CSS 动画时钟。上沿下边缘消费同一主面板主题 elevation，连接边裁切避免重复接缝，flat 不额外加阴影。横向细线与 Sidecar 标题栏下方的竖分界共用绘制进度；内容生命周期仍由 pane exit owner 独立保留。safe-area/几何/命中区不改、不复制原生按钮；主面板主题阴影/描边/flat、expanded/context 材质与浮动阴影保留，强制颜色使用系统分界 | Header + Sidecar + live motion + Design System/theme tokens；真实 AppShell 前 100ms 与中间帧上沿跟手、native reservation、十种主题 shadow authority/下沿像素与白色接缝负例、快速反向/held resize/显隐与浮动回归 |

工具阅读面使用共享 `--material-reading-background`，与主阅读面消费同一主题材质及减少透明度／强制颜色回退；不另铺实色背景遮断渐变。`smoke-workspace-presentation.ts --pane-motion` 在真实 AppShell/RightPanel 上逐帧验证同步调宽、反向、无过冲、键盘／触控和减少动态效果；显隐仍允许独立裁切。

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

core unified Shell 桌面将60px图标栏与列表列分开，移动抽屉纵向菜单位于全宽列表上方；列表标题（含筛选入口）、日期标题与会话行消费同一列表列inset，头像按内容宽度右对齐、右边缘与菜单间距固定。一行/两行共享右边缘，工作目录置于标题下方辅助行，无独立底板，过长省略，不占用标题行宽度。unified默认335px、最小300px（原列表默认275px/最小240px加60px图标栏），旧保存宽度按新最小值夹紧，未保存时消费frame新默认值；手机抽屉独立按容器宽度分配，不借用桌面保存宽度；取容器90%与容器减64px的较小值并取整，保留右侧可点击关闭区域；不写回桌面宽度、不缩小字体或触控目标；独立/嵌入侧栏保持原宽度。图标行的 icon-label gap、会话层次、右侧状态与菜单命中区保持原语义。下游产品两面保持旧 consumer 留白。

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

Browser/PWA conversation actions include Share link for an existing conversation. The application supplies its canonical same-origin route with the deployment prefix and Host identity; recovery parameters, credentials and draft state are excluded. The original click invokes Web Share synchronously before any asynchronous work. Cancellation is silent, unsupported sharing copies the URL, and failures use the existing notice owner. Sharing a route grants no access; the destination still enforces its existing authentication and permissions. Embedded/native wrappers and non-HTTP desktop URLs do not advertise this Web action.

Personal intent uses validated UiPreferencesRuntime storage keyed by account scope and dock identity. Empty means intentionally empty, absent means defaults. Unknown/unavailable action IDs remain stored; temporary overflow does not rewrite preference. Customization supports cross-zone dragging, keyboard sorting, add/remove, explicit save/cancel/reset and visible persistence failure. Drag gestures do not execute actions. Dialog focus returns to the connected invoking icon or visible overflow after capacity change. Icons have localized accessible labels/tooltips; neutral theme tokens and touch hit targets are shared.

Customization drag keeps the source slot in layout and paints a noninteractive, unscaled DragOverlay in the presentation root outside modal transforms/clipping. The active source never uses another list's sortable transform. Pointer hit testing first selects a zone, then its rows; nonempty parent zones do not compete with their children. Keyboard targets rows or empty zones. Draft membership changes only on drop, cancellation leaves it unchanged, and release has no source-return animation.

- Sidebar More menus open on a completed touch tap, after the browser has retained
  the gesture as a click. Touch down alone never opens them; native dragging,
  ancestor scrolling, cancellation, another pointer, release
  outside the hit area or a native context-menu gesture invalidates that tap. These guards
  never prevent native scrolling. Row long-press/right-click and Radix keyboard,
  focus, dismissal and the single Sidebar menu owner remain unchanged.


Web dropdown consumers use design-system-web/dropdown-menu. Direct touch/pen
opens only after a valid completed tap; native dragging, ancestor scrolling, cancel,
multiple pointers, release outside or a native context-menu gesture invalidates it.
A press that the browser completes as a click remains usable despite tolerated
finger drift or duration; fixed pixel/time cutoffs must not silently discard it. Native pan remains
available. Radix owns mouse, keyboard, nested menus, focus and dismissal. Composer
model, permission and Add controls preserve the editor focus and selection on
touch; opening one retires the other picker without a delayed activation.
The shared trigger withholds Radix's eager touch handler without cancelling native
pointerdown, which must remain available for WebKit to complete its click. Editor
focus retention cancels compatibility mousedown instead, including menu items;
it must not suppress the native touch click. The Radix trigger retains its same
button, ref, accessibility, mouse and keyboard ownership through the shared Slot.


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

PwaRuntime suppresses native history traversal in iOS Home Screen apps
(`navigator.standalone === true`). A non-passive capture listener cancels
single-finger `touchstart` in either outermost 24 CSS pixels, before WebKit admits
its history recognizer. The right boundary follows current viewport width. The
adapter hands the original contact through the shared edge-input bridge, with
Window capture preceding document consumers even after rebind. Shell accepts the
handoff without host detection and retains its original gesture/progress/open
owner. The bridge and Shell use one 24px gutter; no synthetic event replay or
second sidebar state machine is introduced. Adapter disposal revokes handoffs.
Cancelling the initial contact
also reserves edge-origin taps/scrolls; normal content and controls are inset.
Middle contacts and simultaneous multi-touch retain native handling.
Ordinary browser tabs, embedded documents and Electron are unaffected. History
entries and URL changes remain real; explicit Back/Forward uses the original
router. Do not trap `popstate`, add dummy history entries or cancel every touch.
The owning ClientRuntime releases the listener on retirement/HMR and retains it across
persisted pagehide. Native Safari gesture acceptance requires a physical-device
check; synthetic DOM touch events only prove cancellation and routing isolation.


Client presentation is selected at bootstrap through WebRuntime, PwaRuntime or
ElectronRuntime. Shell consumes their document projection instead of owning PWA
or preload listeners. Shared appearance preference/catalog, real navigation and
viewport geometry retain their existing owners. See
[ClientRuntime](../../docs/architecture/platform/client-runtime.md).


### Menu outside-interaction contract

Dropdown and context command menus share design-system-web activation and Radix
outside dismissal. They do not mount a full-page dismiss surface, paint a scrim,
block background scrolling or consume the first outside contact. A native outside
click closes the menu and reaches its original target, including navigation,
another trigger or the editor. The release which opened a touch context menu
still belongs to its trigger and must not accidentally activate that row.

The shared Root does not expose Radix `modal`: command menus retain Radix's
nonmodal focus lifecycle, nested submenu selection, Escape and Dialog handoff.
There is no document-wide pointer lock, hidden-page state or focus trap to race
with a subsequent Dialog. Boundary checks reject raw Radix menu imports in
consumers. Editor auxiliary menus retain their focus lease, original editor,
selection, draft and software keyboard continuity; an explicit outside contact
can naturally focus its target. Ordinary action menus retain their Radix focus
policy. Tooltip/hover previews and editing autocomplete remain separate
interactions. This replaces the earlier first-contact-only dismissal policy.

## Destination navigation surfaces

Settings and sidebar destination rows consume shared NavigationList, NavigationGroup
and NavigationItem. The list's semantic inline padding keeps hover and current
surfaces away from the slot edges. The full row remains the hit target; no detached
hover overlay or label-width button is introduced. Keyboard focus has reserved
clearance in scrolling groups, and touch density retains its minimum target.
Icon/presentation style cannot remove list gutters. Shell/Modal owns available
space, orientation and scrolling; features cannot repaint or resize shared rows.

## Bootstrap recovery continuity

Before Shell mounts, resource recovery retains the current origin, route, query, hash and browser
storage. A selected installation owns its version checks and error reports. WebKit CORS module
failures may try one fresh resource graph; even a newer reported build must not repeatedly navigate
an already recovered document. Persistent failures retain the explicit retry surface. This does not
change viewport geometry or turn storage/evaluation failures into resource retries. The serving
contract is documented in [Web resource recovery](../../docs/operations/web-local-deployment.md#保留本地数据的模块资源恢复).


## Anchored footer surfaces in embedded presentations

Account popovers and anonymous sign-in dropdowns consume
`useWorkbenchPresentationRoot()` rather than the Sidecar footer. Full-page
Workbench uses the document portal; embedded Workbench keeps overlays in its
supplied local presentation root so style and focus stay within the presentation.
The physical overlay must escape sidebar clipping and material ancestors while
Radix measures the trigger and applies viewport collisions. This changes no Host,
account, navigation preference or draft owner. The application drawer retains its
local layout. See [footer overlay topology](navigation-and-sidebar.md#footer-overlay-topology)
for consumer hit-testing and resize/focus coverage.

Compact destination rails adapt the same shared NavigationList/NavigationItem
used for labeled destinations. Compact list gutter and button geometry belong
to that shared owner; Shell supplies track placement and density. Footer Settings
and account triggers use icon content layout on the compact rail, so an avatar
does not add row padding to the hit box. Moving to the labeled mobile drawer
retains the action identity, portal, current route and original conversation state.
See [navigation and sidebar](navigation-and-sidebar.md#consistent-compact-destination-controls).


## Terminal resource continuity and limits

The authenticated Host authorizes terminal access; a release-independent PTY owner
retains processes, output and resource-owner/thread/project metadata.
Renderer teardown detaches observers. Explicit tab close terminates the process;
returning to a panel or rebuilding a client restores live resources to the same
owner through list/attach. Unknown legacy ownership must never be guessed.
Panel resource hydration is asynchronous, preserves selection and visibility,
and rejects results after owner release or contribution replacement.
The PTY owner enforces account/Host and aggregate process caps, bounded output replay,
and bounded exited records. Detach, visibility and cache eviction do not reclaim
running PTYs. Explicit termination releases active capacity. This contract does
not provide OS process CPU/memory isolation or survival across the PTY owner's
own failure or a machine restart. Host shutdown only disconnects; a replacement
Host lists and attaches to the same owner. Managed Linux uses a separate systemd
unit, because a detached child still dies with its parent's control-group.
The private IPC and request queues are bounded; disconnected or timed-out
mutations have unknown outcomes and must not be automatically replayed.
Runtime JS and the native node-pty closure are retained outside release cleanup.
Old PTYs created inside a pre-upgrade Host cannot be adopted retroactively.


## Page-owned overlay presentation

Shell owns a stable page-overlay host alongside the physical page. DOM features
portal content into `ShellPageOverlayContext`; they do not select document.body
or write viewport-fixed bounds. Shell alone measures the content slot within its
frame and moves the overlay plane with the page's existing MotionValue. Its frame
uses the same visual-viewport projection and safe-area allocation as the page.
The overlay target remains stable across sidebar, panel and capacity transitions;
changing layout must not remount the composer or replace its draft/controller.

An external compositor plane is required above browser/native guests. Its use is
a Shell implementation detail, not a separate feature geometry owner. The same
page veil and dismissal boundary cover DOM overlays and external guests; the
page and its DOM-overlay host share input blocking. The Browser presentation
adapter projects its logical slot's inherited inert boundary onto the physical
guest, independently from staging and automation input ownership. Releasing one
boundary cannot release another or reclaim focus, and does not retire a page,
change its viewport or request input authority.

Desktop docked layout continues to allocate widths. Desktop floating navigation
covers page overlays. Touch sidebar travel instead puts the foreground above
the stationary drawer and applies the same translation to the page and overlay
plane. The Shell owns these layer relationships; features cannot compensate by
raising individual z-index values or listening for sidebar progress themselves.
Menus and dialogs retain their existing Workbench presentation root and input
priority. This contract does not move a browser resource between DOM parents.

Shared dropdown and context menus inherit the logical presentation activity of
their owner even when portalled outside its DOM subtree. With an active owner,
Radix keeps the usual dismissal and exit animation. When that owner becomes
inactive, the menu leaves in the same commit, retires its open request and skips
focus restoration from that presentation. Returning to a retained page restores
its content, while opening another menu requires a fresh request. The same
contract applies to Web, Electron, installed PWA and the Expo WebView.

Acceptance uses the real AppShell, Composer and Browser components in
`scripts/smoke/shell/smoke-workspace-presentation.ts --page-presentation`, alongside
the existing mobile and desktop workspace consumers. Held movement, reversal,
cancellation, safe frame, input blocking and retained editor/guest identity are
separate assertions; browser emulation does not establish physical iPhone input.

## Primary-route header ownership

AppShellHeader has a primary-route slot beside its title and a separate workspace
end slot. Conversation info, task links, sharing and More consume `primaryAction`;
only workspace controls such as the tool-region toggle consume the end slot.
The existing live tool aperture allocates both regions, so a split resize moves
the primary actions with their conversation rather than with the window edge.
Dock capacity is measured from the primary header, with the route declaring the
number of fixed slots; title and overflow budgets do not borrow space from tools.
Touch presentation hides title copy independently of the action slot. A tools-only
scene makes primary chrome hidden and inert. This placement does not change the
conversation, draft, resource or action identity owners.

Conversation summary popovers use the owning conversation layout as their Radix
collision boundary. Their portalled surface retires while that primary scene is
not presented, preserving explicit open intent for its return. It cannot paint
over a full-screen tool as if it described that tool. The host's same summary
controller still owns visibility and plugin view state. See
`smoke:conversation-header-ownership` for split geometry, held resize, primary
visibility, theme/input variants and retained editor/tool identity checks.

Transient conversation More menus close when their primary scene becomes hidden
and do not restore focus to a hidden trigger or reopen on return. Explicit task
dialogs and unsaved toolbar configuration retain their own modal lifecycle.

## Tab group toolbar slots

TabGroupToolbar owns the shared touch toolbar composition, with scene-supplied
leading/content/contextual action slots and a persistent trailing tab switcher.
Optional actions, More availability, tab type and address editing cannot move or
hide the switcher. Existing panel services remain the sole tab state owner;
the toolbar does not create another tab group model. Editing may hide contextual
actions while retaining the switcher's slot and shared touch target.

Terminal renderers contribute keyboard and paste controls through the public
PanelRendererProps touch-toolbar container. The Shell owns the bottom bar and
its trailing tab slot; the renderer keeps the live xterm instance, clipboard
request identity and paste draft. Keyboard focus is requested synchronously from
the user's gesture. Touch mode has no duplicate floating paste button. Paste reads the clipboard
and immediately uses xterm.paste; it has no intermediary entry form or send
step. Blocked access or an empty clipboard produces a short status notice;
system paste continues through the focused terminal and browser permission
requirements remain in force.

### Touch drawer navigation and detached footer controls

In unified touch drawers, the brand is the Home entrance and the in-sidebar
application catalog entrance lives beside Settings in the bottom action row.
New conversation, Applications and Settings keep separate shared Button surfaces
and a common baseline. Desktop retains Home and Applications in its rail.
The native list scrollport spans the entire drawer, including behind the glass
footer controls and safe bottom inset. Shell measures both action hosts and
reserves their maximum height as scroll content padding, so final rows and
pagination can clear the controls even when an update notice adds a row. The
footer hosts stay transparent with pointer events limited to their controls.
Retain existing portal owners, catalog state, draft and route semantics.
Use a common 16px leading edge for brand, catalog, group labels and root titles;
retain nested thread indentation. Group headings reset browser heading margins
and consume the shared metadata role, with touch hit targets preserved.

### Peer sidebar destinations and reachable exit

Conversation, Applications and Settings occupy the same physical sidebar as peer
lists. Applications opens a standalone full-height catalog, never a prefix above
conversation history or settings categories. Re-selecting Applications preserves
that destination instead of toggling a group. Home/brand and the bottom return
restore the remembered conversation; Settings selects its categories. The selected
entrance reflects the sidebar destination independently of the underlying page.
Opening an application still uses its declared existing route/action.

Back to app is a return to the conversation list, not a conversation-row selection.
It preserves the current drawer/split allocation and restores the remembered
conversation, View and draft as the default selection. The shared return button
does not dismiss the drawer; connected navigation carries `sidebar: preserve` on
that return transaction so Shell preparation cannot dismiss it indirectly. The
policy belongs to one intent, never to a sticky global preference: subsequent
conversation selection and history traversal retain their normal behavior. A
phone row selection dismisses its drawer; a docked tablet/desktop list remains
visible. Hostless return uses the same peer-list action without creating a Host.
`OPENCRAFT_SIDEBAR_RETURN_ONLY=1` in
`scripts/smoke/shell/smoke-sidebar-selection-handoff.ts` exercises Settings/catalog
return, actual Settings route return, retained View/draft identity, and subsequent
explicit selection with phone touch, reduced motion, tablet touch and mouse input.

Retain inactive conversation/sidebar content and its scroll state, but suspend its
primary action portal while Applications owns the slot. Only the active list can
publish the bottom primary action. Applications and Settings share Back to app;
Conversation owns New chat, using the same Button geometry and material. Narrow
capacity preserves the complete wording before its decorative icon.

Touch settings/applications exit through the bottom-left Shell action host. The
persistent Header does not add a duplicate return arrow; its sidebar trigger stays
reachable when closed. Direct settings entry can open the drawer and return without
browser history. Restore conversation/scope/draft through existing navigation
transactions; management dialogs retain their own close semantics. Desktop Home,
settings, application destinations and keyboard navigation remain reachable.

Choosing the Settings entrance selects only its category list and preserves the
current split/drawer progress, main route, conversation, draft and scroll. It does
not immediately open the last/default Settings page. Only an explicit category
selection commits the existing Settings route and dismisses the touch drawer.
Re-selecting Settings is idempotent. Keyboard/direct Settings routes retain their
existing behavior; direct settings entry still exposes categories and return.

Sidebar destination reading inset is Design System-owned:
`--padding-sidebar-content-inline` is consumed by `NavigationList inset="sidebar"`
for Applications and Settings, and by touch Shell brand/root/footer edges.
Do not accumulate an app wrapper gutter and a separate Settings breakpoint gutter.
The shared list derives `--offset-navigation-content-inline` from row/glyph metrics
for heading alignment; page/dialog navigation keeps its default inset.

Touch sidebar New chat, Applications and Settings retain their individual shared floating glass surfaces above the full-height list. The surrounding footer hosts paint no separate background. Desktop retains integrated ghost surfaces. Shell owns placement, safe-area spacing, hit geometry and measured scroll clearance.

### Application context list

Application pages use the existing context pane for the installed miniapp list.
Rows share NavigationList/NavigationItem, show icon and name, and obtain selection
from the Router. The same projection covers zero-Host and connected workbenches,
including standalone miniapp Settings pages. Chat keeps its conversation list;
general Settings keeps its sections. Transient selection uses the Shell dismissal
owner and preserves the retained conversation and draft. Catalog filtering and
retirement match the application desktop; scrolling stays inside the context pane.

The application frame retains both catalog and route context, with a shared
grid-icon button selecting the standalone catalog exclusively. Inactive context
is hidden and suspends its primary-action portal. Chat context retains its existing
scroll owner; selecting Home or the bottom return restores that list.

In the mobile shared scrollport, a Home/catalog navigation grid retains its
intrinsic block size even when the conversation list is long. Home and catalog
have separate adjacent touch targets; subsequent destinations stretch across
the available row and align their icon/text leading edge. The context starts
after the complete grid rather than underneath overflowing grid children.
Long labels wrap inside that row without widening the drawer. The floating
header keeps its existing reserved space and the list remains the sole scroll
owner. Regression coverage uses the real AppShell and an expanded Sidebar list:
`OPENCRAFT_GESTURE_NAVIGATION_ONLY=1` in
`scripts/smoke/shell/smoke-mobile-sidebar-gesture.ts`.

Touch panel workspace entrances reuse the same shared SidebarToggleIcon and
sidebarToggleGlyphs artwork as Shell navigation. The shared chrome icon token
owns dock glyph size independently of the touch hit target; action slots must
not introduce per-feature silhouettes or arbitrary per-icon touch sizes.

Touch main chat and tool scenes expose the same trailing tab-count overview action.
Composer navigation follows the input surface through the shared navigationActions
slot, outside its voice/submit controls. It is a separate floating circular control,
bottom-aligned beside the input or tool capsule with the shared dock gap. Input
expansion grows upwards; navigation retains its own material and remains usable
during dictation. Both scenes use the same stacked tab-count glyph and shared
floating navigation size, not CSS visual reordering. Shell owns one overview request scoped to the current
panel owner; tools retain the actual tab directory and creation actions. Opening
never implicitly activates a tool. Dismiss retains the prior destination, while
selecting a tool reveals it and selecting main chat closes the tool plane. Search
never receives automatic focus. The active floating Composer publishes its actual
presentation so only its trailing entrance is shown, rather than duplicating the
tool dock entrance. Counts exclude main chat and creation cards.

### Scene intent and adaptive presentation

ConversationPanelState retains primary/tools foreground per stable owner across
conversation and route switches. Tab identity and explicit visibility/maximize
are independent fields in that same owner. Shell holds no writable navigation copy. `projectShellScene` consumes the existing space resolver;
input density chooses chrome, never the content destination. No device-name or
767px branch decides tool navigation. Explicitly entering an empty tool directory
is allowed without manufacturing a tab or persisted region-open state.

Selecting primary in split view focuses its existing viewport without closing
tools; selecting primary in a single-pane frame changes foreground only. Explicit
hide remains a separate action. A transient sidebar drawer does not pin itself
when the window grows, and its dock admission reserves the visible split content.
Tool sidebar controls invoke Shell sidebar navigation, not region hide. Competing
sidebar/overview requests dismiss each other; dialog ownership stays with Modal.

Overview request identity is scoped to the panel owner and survives narrow/wide
reflow. The same content DOM moves from fullscreen to adaptive sheet;
wide touch panels expose an overview entrance in their toolbar. Focus restoration
chooses a currently visible entrance. Floating primary Composer remains gated by
actual full-width tool presentation; split view retains the ordinary primary input.

Evidence: workbench-shell-scene.test.ts exercises scene combinations, narrow/wide
roundtrips, empty directory, explicit close/maximize and scope changes. The real
Shell smoke-tab-overview adds 390/768/799/1024 transitions, sidebar dismissal,
retained tab identity and overview content DOM across resize. Physical iPad/iPhone
and real IME remain separate device acceptance, not inferred from simulation.

Explicit right-panel open/activation commands select tools even when the panel is already open; resource updates, passive hydration, resize, and close/MRU fallbacks preserve foreground. Shell consumes the owner directly instead of inferring navigation from activeTabId, open flags or revision pulses.

### Stable scene action region

Within the same protected viewport, touch chat navigation, tool navigation, and overview Done consume the existing scene dock inset and navigation control size. The trailing hit target has a stable center and bounds; multi-line editing grows upward. Overview owns a bounded flex content region with an independently scrolling card grid and a non-shrinking action row, including zero tabs. Fullscreen Modal consumes top/bottom safe insets once; the inline scene already inherits the protected Shell frame. Contained overviews anchor within their own container, not to an unrelated chat input. No cross-component measurements or Composer dependencies define overview geometry.

### Overview scene transitions

The overview borrows existing view instances; it owns only a short presentation
transaction, never a terminal, conversation, or browser resource. View keys identify
the retained source and its preview frame, but do not define scene allocation.
Shell supplies primary/tools target bounds for both retained and image previews;
compact bounds use the common content allocation, never a parked pane position. The existing Motion pane spring
moves that frame between its measured card and scene rectangles. Native top-layer
placement keeps DOM/iframe/canvas identity; unsupported placement or unavailable
geometry settles directly. No cloned interactive tree is mounted for motion.

The travelling surface is the complete selected card, including its shell and heading.
Its old slot is an invisible layout placeholder. An independently interpolated content
rectangle stays inside that surface; native retained paint consumes that inner aperture,
not the outer heading area. Reversal retains the shared card-to-scene progress before cleanup; both rectangles
and title visibility are derived from that progress.

One transaction writes the frame geometry. Stop its writer before sampling a
reversal; replacement/unmount revokes its completion. Selection commits through
the existing navigation owner when the presentation hands back the view. Search
editing cancels a pending selection. Resize settles the intended destination;
reduced motion skips interpolation. Compact scenes project a parked pane into the
visible scene's horizontal allocation; split scenes retain their actual pane bounds.
The shared bottom action region does not move with the preview.

Atomic and native-popover retained previews consume the same explicit geometry
invalidation during flight. The latter remains above the moving frame and stops
clipping to the old scrollport until the flight ends. Non-selected native top-layer
views project their cards’ opacity explicitly, since top-layer paint escapes ancestor
compositing. The placement adapter owns this projection and restores it on release. Cleanup restores card styles,
clipping and view placement; business state continues to belong to its original owner.

Primary chat preview framing follows the end of its rendered message content,
clamped to the original viewport. Short content stays at the top; long content is
cropped from the beginning so the visible tail is not lost below the card. Native
view size, scroll position and draft are not changed. Conversation turns mark
preview content; footer chrome is paint-hidden only while borrowed. Both atomic
and native-top-layer placement consume the same framing calculation, including
content resize while the preview is open. Tool previews retain start alignment.

Presentation interruption preserves radius and opacity as well as geometry. Only
scrolling the overview viewport invalidates scene bounds; live content scrolling
inside a borrowed view does not commit navigation. Floating composer completion
follows finite CSS animations and transitions, not a duplicate duration timer.
Superseded snapshots cannot settle newer intent. Modal presence uses existing Motion
retention and Radix closed-state animation; reopening revokes the old removal.

Overview scene handoff has one visual owner: after its card flight completes, the
Shell commits pane geometry without replaying a second horizontal transition.
Destination chrome (Shell header, side-chat title, resource controls and floating
composer/footer) consumes that same Shell's remaining scene progress, never a
per-view/document-global handoff animation or forced document reflow. Read-only
retained views hide their controls while preserving layout and DOM. Opacity is
applied once at the outermost chrome boundary, not multiplied by nested footers;
input leases follow the same membership and cannot acquire a nested Shell.
The handoff revision is presentation-only; ordinary pane navigation still uses
its shared spring. Lifted preview frames keep a flow placeholder, and cards with
live top-layer descendants must not use content-visibility skipping: title paint
and the measured destination must remain stable across lift/restore.

Motion's completion callback runs outside React. Scene handback must synchronously
commit the destination in the same presentation transaction that restores the
borrowed view; otherwise observers (and potentially paint) see a card-sized view
between the full-size flight and the actual scene. Completion regression coverage
must inspect this boundary, not only the stable frames before and after it.

The scene flight interpolates a visible aperture as well as frame geometry. A partly
clipped card contributes its scrollport intersection; native top-layer content and
atomic placement consume the same aperture and corner radius. Restoring normal
clipping cannot expose or cut away another region on the handback frame. Raster
previews scale by width without changing object-fit crop during the flight.

Overview has one prepare/transition/commit transaction. Preparing projects a
candidate renderer under the opaque overview without changing the panel's selected
tab. Shell allocates the destination without replaying its pane animation. Ordinary
DOM/retained renderers acknowledge the layout commit; asynchronous renderers opt
into onPresentationReady. Browser attachment and drawable media are distinct:
remote media acknowledges after an existing or first painted frame, not merely
WebSocket connection. The BrowserPanel scene acknowledges its mounted actionable
surface (address, loading/error and retry) independently of that media receipt;
missing frames cannot prevent selection or hold the overview animation. Cancellation
revokes only the temporary allocation; committed foreground never changed; late acknowledgements
cannot complete a replacement transaction. Retiring the target cancels preparation.

The same bounded Motion progress drives scene geometry, aperture, backdrop and
chrome visibility. Scene chrome stays hidden while overview controls are present;
after synchronous content handback, the presentation owner reveals the real controls
with the shared Motion spring. Reopening, owner replacement and reduced motion
cancel that final phase. Navigation commits before the transition layer is released. Reduced
motion skips interpolation but retains the readiness and ownership checks. Preparing
can be cancelled through the existing overview actions, without a duration timeout
pretending that an unready renderer is usable. Controls are never duplicated.
Start the spring's clock after synchronous geometry preparation, not at an earlier
task timestamp: allocation/measurement time must not consume unpainted animation
frames. Reversal retains the current value and velocity with that same clock rule.

The scene's surface paint and modal scrim consume the same bounded progress as
its frame and aperture, including interrupted/reversed transitions. The modal
container itself must not translate independently: it supplies the coordinate
basis for the retained content. Spring overshoot must not yield negative radii
or advance opacity beyond the geometric endpoint. Viewport and overview-scroll changes remeasure the flow slot and scene bounds;
they preserve the painted frame and converge to the new destination rather than
committing navigation early. Middle-frame
checks cover backdrop/scrim composition as well as content geometry.

Overview chrome belongs to a destination token, not merely the presence of a
panel host. Batched release/publish across conversations must reset hidden chrome
before paint even when the destination never renders as null. A modal overview
exclusively borrows retained views while open; the inline empty-tool overview may
remain mounted but must be inactive until the modal releases them. Closing the
last tool must not strand the inline chat preview in its unavailable fallback.

Overview filtering must keep its escape path while criteria are active. The tab
count threshold only decides when to initially offer type filtering; reducing
the count cannot hide an active type filter's All action. Likewise, closing the
last tab must not remove a nonempty search query's edit/clear control.

The overview flight uses one reversible card-to-scene progress. Frame and content
aperture allocate a heading band together. Measure its text ranges and icon bounds
in normal card layout, separately from padding and inert control hit areas. Center
the complete ink within the forming band, converging to its measured resting
position; derive its reveal from the space remaining around that ink. Waiting for
the entire control box makes a late threshold, even when driven by the same spring.
The title row's inline edges follow the current frame and measured card insets;
trailing actions stay at the travelling edge instead of jumping to the card width.
Do not hard-clip glyphs or grow them from zero. Title position and opacity join the
painted snapshot when reversing or rebasing; removing flight styles at the card
endpoint cannot change their geometry or paint. Rendered coverage samples the
forming band, whole-ink clearance, reversal and cleanup, not merely the existence
of one translucent frame (`overview-heading-geometry.test.ts` and the existing
overview smoke's `OPENCRAFT_OVERVIEW_HEADING_ONLY` path). Inner
and outer corner radii reach zero together at the scene endpoint. Preparation holds
the current progress, including a partially faded backdrop, rather than resetting it.
Raster previews lease their current image/title for the whole transaction; cache
updates continue independently and become visible after cancellation or completion.
Once the destination is drawable and scene geometry is reached, the frozen raster
cover dissolves only after geometry reaches the scene endpoint, into the actual viewer before commit. A readiness acknowledgement
is not a promise that a cached image and a live video frame have identical pixels.

The scene driver survives modal handback through an explicit playback lease held
by the presentation owner. Chrome consumes the remaining progress; handback never
starts another spring. New requests, owner replacement, reduced motion and unmount
retire that lease. A different-card selection returns the currently painted card
while preparing and expanding the new target concurrently. Only the foreground
transaction writes shared backdrop/chrome or commits navigation. Reselecting a
returning card adopts its painted geometry and progress. Responsive flow slots
remeasure heading, content and frame together; reversal anchors to the actual
painted rectangles before changing correction direction. Native top-layer
retained content consumes its travelling frame's opacity too.
Modal focus restoration waits until scene chrome releases inertness, resolves the
current visible overview button, and yields to later user focus/pointer/key intent
or scope replacement. It never restores an editor's IME.
Retained scroll restoration follows reading intent: preserve a history offset,
or follow the new end if the user was at the end. Restore after the home layout
is active, including scrollable containers initially at zero.

### Conversation navigation and scene allocation

ConversationPanelState owns foreground (primary or tools) alongside, but independently
of, selected tool tabs and pane preferences. A primary selection retains terminal and
browser resources. Returning to a conversation restores its foreground; application
route changes, resource hydration and window/input-mode changes do not infer it from
pane visibility. This memory is scoped to the client runtime, not reload persistence.

Shell projects the owner's intent into single or split layout. Split is not a
navigation destination. Composer overview originates from primary; tool controls
originate from their pane. Primary retained-view identity includes the conversation
owner, just like tool identity.

Overview preparation carries owner, target key and foreground only as a temporary
allocation. It cannot call navigation or update the selected tab. Commit updates the
owner once; cancel drops allocation without reverse navigation. Owner/route changes
retire preparations and late acknowledgements cannot navigate a different owner.
An empty right tool outlet remains a valid launcher after close. Explicit hide
returns to primary; transferring the final right tab to bottom also releases right
maximization and returns to the main workspace so the destination remains visible.

Read-only retained previews disable native scroll anchoring in their nested scrollports.
The retained portal's physical attachment follows its mounted lifetime. Changing
the conversation registry key revokes and rebinds the preview registration without
removing or re-appending the connected portal root. React identity alone does not
preserve embedded browsing contexts across a native DOM disconnection.
Scale and crop changes cannot write the borrowed view's scroll position; normal
scroll anchoring resumes when the preview lease ends.

Interruptible overview playback retains both position and velocity through the shared
physical Motion spring. Geometry has zero endpoint derivatives at the compositing
boundary. Entering and retiring overview flights return their original cards and
hit targets once all painted edges are within half a device pixel and opacity
within one alpha step of their endpoints; numerical spring tails cannot keep a
visually settled card unclickable. Destination handback still waits for readiness.
Chrome remains inert until its reveal completes, including controls
mounted during handback; the Shell releases its temporary inert lease on completion
or teardown. Modal focus ownership and domain navigation remain unchanged.

Chrome input suppression is a temporary presentation lease. It is acquired once
when opacity leaves its settled state, discovers only inserted subtrees while
active, and restores the latest external inert intent (including writes queued
in the same task as release). It never rescans the Shell on each animation frame.
Enabling reduced motion retires every outgoing card, even while the active
selection is awaiting renderer readiness; it must not bypass that readiness.

The unified overview has no text search field or query state. It opens directly
on the card grid (with type filters when needed); the shared dock continues to
own the Done action position independently of card count.

### Reduced motion must not create transitions

The global reduced-motion rule sets CSS transition duration **and delay** to zero.
A tiny nonzero duration applied to every element invents transitions on static
surfaces because the default transition property is `all`. In particular, local
SVG backdrop references can become animated during retained-view owner changes;
Electron 44.8.0 / Chromium 152.0.7977.167 hit a native StyleResolver DCHECK in this
sequence. The fix preserves SVG glass, atomic DOM moves and the shared motion
framework. Keyframe animation completion retains its existing short-duration
policy; transition-based semantic completion must handle reduced motion directly.
Regression: the subscriptions mode of `smoke-tab-overview.ts` checks absence of
invented transitions and switches owners in the actual retained-view Shell.

## Live mobile workspace preview

A mobile workspace preview loads the same application document and WorkbenchRoot
in a same-origin iframe. The iframe supplies its actual viewport and a temporary
`data-opencraft-preview="mobile"` presentation intent. Shared density binding
consumes that intent without persisting a device preference; pointer modality
and physical keyboard/gesture capabilities remain browser-owned. There is no
parallel Demo Shell, terminal renderer, fake chat or mobile business state.

The normal application owns authentication, routes, resources and transport.
Mutations are real; server state sync uses ordinary client protocols. Focus,
scroll and navigation stay local to each client, rather than becoming a screen
mirror. AnnouncementCenter validates the frame path and ModalHost owns dismissal
and focus. The parent sends theme selection to the child's existing appearance
owner; an unconsumed Escape returns to the parent ModalHost. Embedded clients
suppress the phone-guide contribution to avoid recursive frames.

The Join guide resolves the current route on open, keeps only hostId/draftId
routing query fields, and never transfers authentication credentials. Phone
access retains normal login and admission. Product smoke checks share the actual
WorkbenchRoot and production entry; synthetic identity/Host checks do not certify
real phone keyboards, WeChat scanning or external execution.
### PWA sidebar and page capacity

Installed browser overlay mode bounds the page row, stationary sidebar portal and page-overlay plane by the same dynamic viewport height. Full-bleed paint remains independent; footer SafeLayout allocates the bottom inset once and its measured height reserves list scroll clearance. Mobile drawer capacity comes from the current container, independent of the saved desktop width. This keeps the page preview narrow without scaling text or touch targets.

Shell bottom navigation and primary sidebar actions share ShellNavigationButton.
It projects design-system navigation size, ghost feedback and solid floating
material for avatar, sign-in, Settings, applications, updates, create and return.
Primary create/return actions retain their icon and label in the same capsule;
icon-only accessories retain circular navigation geometry. Shell owns available
row width and overflow, while the shared Button owns shape and control sizing.

### Overview presentation clock and geometry projection

Overview navigation readiness remains with `SceneTransitionOwner`; it is not an
animation start time. `overview-playback` samples the existing physical Motion
spring on the first admitted animation frame at time zero, in both directions.
Allocation/React commits cannot consume that first frame. Normal 60/120Hz frame
intervals are retained; a blocked/hidden interval admits at most one 30Hz step,
without catch-up debt. Under sustained load this deliberately trades elapsed
transition speed for spatial continuity; it does not guarantee device frame rate.
Cancellation stops writes without sampling unpainted wall time. Reversal inherits
position and physical spring velocity. The same driver survives scene handback
for chrome reveal; no second spring or navigation timer is introduced.

The flight owns frame/content/aperture geometry and publishes one projection to
atomic and native-popover retained views. Placement observers consume that
projection instead of reading back the layout just written by the flight. Content
end measurements are invalidated by content resize/replacement, borrowed scrolling
and destination reflow, not by each projected frame. Native decoration inherits
its frame's border tokens and active/theme state; it does not cache resolved theme
colors. Outside a flight, existing scroll/resize and CSS-anchor positioning remain
active. Sibling opacity and the overview surface opacity have explicit composition
leases: the native placement observer updates cached opacity factors without
remeasuring geometry for those owned writes. Any simultaneous non-composition
style/class/theme change still invalidates geometry; lease release restores the
original inline value and priority and resumes normal measurement. CSSOM opacity
rounding must not turn a compositor-only write into geometry invalidation.

Teardown releases the projection before normal placement resumes, except an
accepted handback that unmounts the overview in the same commit: there must be no
last thumbnail remeasure/re-raise immediately before release. A multi-root handback
uses the existing Shell chrome progress; it must not announce a document-global
control reveal or restart CSS animations. Shell viewport initialization is lazy; its existing ResizeObserver owns subsequent
sizes, not viewport getters evaluated on every React render. Existing selection
restoration and focus ownership are unchanged.

Retained scroll handback batches all destination reads before writes, in one
microtask after the final home layouts and before the next paint. The queue is
keyed by retained root, replaced/cancelled on reborrow, source rebinding and
unmount, and excludes detached owners. Historical reading and current tail-follow
intent remain distinct; renderer-owned scrollports stay with their renderer.

`overview-playback.test.ts` covers delayed first frames, slow-frame admission,
reversal, cancellation, pause/seek and completion. The actual Shell overview smoke
has `OPENCRAFT_OVERVIEW_CADENCE_ONLY=1`: primary/terminal/side-chat, both directions,
normal/6x throttled Chromium and native/atomic placement. It checks initial progress,
intermediate spring samples and retained draft/iframe/side-chat identity. Its
pre-application probe also counts MutationObserver, ResizeObserver and microtask
work, viewport/client/scroll reads, synchronous handback duration and frame gaps
through the final chrome reveal. The composition contract checks CSSOM rounding,
external writers, width/class invalidation and native content/decoration opacity.
`retained-preview-scroll.test.ts` covers batched restoration and cancelled owners.

`NODE_ENV=production OPENCRAFT_SMOKE_PRODUCTION=1` selects production React for
performance checks (use a distinct Vite cache). The controlled fixture budgets
handoff plus scroll restoration at 150ms × CPU slowdown and complete-frame gaps
at 175ms × slowdown, in addition to structural no-forced-document-layout and
steady opacity-observer no-read assertions. These are regression ceilings, not
smooth-frame targets. `OPENCRAFT_OVERVIEW_REVIEW_BASELINE=<fixed git ref>` loads the
previous implementation into the same fixture/probe without changing the checkout;
it reports metrics without applying candidate-only gates. Neither throttled
Chromium nor these budgets constitute physical-phone acceptance.

### Adaptive dialog input and queue hit geometry

Adaptive information dialogs (including Assets pickers) use the resolved shared
interaction-density preference and narrow capacity together for bottom sheets.
A narrow compact pointer window keeps the centered utility dialog; a wide touch
window may keep it too. Sheet dismissal accepts touch/pen contacts, never mouse
contacts, and resize/preference changes retire held drags without dismissal.
ModalSurface retains focus, Escape, scroll and content ownership throughout.

Queued-message Resume and drag controls consume shared semantic geometry tokens
and the existing control hit minimum. Compact row/glyph typography is unchanged;
touch targets are at least44px, including an explicit on preference on pointer
hardware. An off preference on coarse hardware retains compact geometry. Queue
state, permissions, delivery, native execution and reorder callbacks are unchanged.

### Composer utility and notification dismissal hit geometry

Queue Send/Steer, Edit, Delete, cancel/review actions, Resume, and inline send-error
dismissal share `--size-composer-utility-action`. Notification dismissal consumes
`--size-notice-dismiss`, including reserved text space and surface containment.
Both roles derive their minimum from `--size-control-hit-min`; no local pointer
media query may override the resolved touch preference. Explicit on/off and live
preference changes preserve the mounted controls and work in either hardware mode.
Compact visual defaults remain22px/32px respectively; touch is at least44px.
Glyphs, typography, delivery callbacks and authority are unchanged. Browser tests
cover pointer/coarse contexts, preference changes,52px token propagation, keyboard
activation, touch dismissal/action callbacks and narrow containment; not phone E2E.

### Attachment and transcript accessory geometry

Composer reference removal, file actions, image removal/retry, answer actions,
terminal copy and generated-image Edit all consume shared semantic hit tokens and
`--size-control-hit-min`. Glyphs and type scale remain unchanged. The answer lane
reserves its action height even while streaming. Terminal copy reserves matching
height and text clearance; enlarging a target must not overlap adjacent content.
These are existing actions and state owners, not new permission/delivery paths.


## Extension collection/detail regions

A trusted View may consume `regions.MasterDetail`. The Web/Electron host measures
its allocated route aperture and reuses `resolveShellSpace` with the shared collection-navigation
width and readable-main minimum, including hysteresis. Window size and
touch presentation are not layout authorities. The region owns frame, inactive
inert/focus handling and Header placement; it never writes navigation, draft or
resource state. Both slots retain DOM across capacity changes. A selected detail
uses the existing route Header when narrow and an inline Header when split.

Inbox directory and channel routes share one deferred renderer identity. The
route activation selects the channel; the directory remains mounted across those
routes. The existing ChannelRuntime, Composer draft leases and message display
checkpoints remain the only data owners. Empty Inbox does not auto-select/read a
group. Other platforms without this optional region retain single-route behavior.
