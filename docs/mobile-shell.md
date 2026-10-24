# iOS mobile shell

本文描述显式下游产品产品的 Shell。公开默认 Expo 使用既有 RN Workbench 与直连 Host；下游产品通过下游产品 runner 选择原入口，见 [Expo README](../apps/workbench-expo/README.md#public-and-downstream-product-entries)。入口拆分不改变本文的导航、账号、Bot 或几何所有权。

## Ownership

`products/<product>/native/src/runtime/mobile-shell-model.ts` owns the semantic surface:
`agents` or native `account`. Gesture progress, drag cancellation, safe-area
geometry and animation belong to the native navigation surface and iOS mobile
drawer. Account management, identity verification and billing open the system
browser; external journeys do not create an App-owned remote WebView or change
Shell navigation. The App never injects credentials into those browser pages.

the downstream product mobile accents and drawer geometry live in
`products/<product>/native/src/runtime/mobile-visual-tokens.ts`, layered over shared
OpenCraft native tokens. Keep visual choices there instead of scattering
sampled colors or fixed phone widths through feature components.
Native account editors keep the local draft, confirmed server name, cooldown
and pending request ID in `mobile-account-editor-model.ts`. A background profile
refresh updates an untouched field but leaves an edited draft alone; stale
request results cannot replace the current form state. Field validation and
account operations remain in `@opencraft/mobile-account-sdk`.

The Bot WebView and drawer remain mounted behind account surfaces. Opening
Account from an open drawer does not close the drawer. Returning from the system
browser preserves native Account; dismissing native Account reveals
the original drawer. Do not use a new WebView or re-created Bot tree as a
transition animation. The native navigation surface measures its current
container, respects safe areas and reduced motion, and lets button Back and
right swipe complete through the same dismissal path.

## Presentation boundary

### Adaptive containers

`runtime/mobile-shell-layout.ts` derives presentation from each mounted
container's measured width and the centralized `mobile-visual-tokens.shell`
metrics. It does not own navigation, Bot selection, Thread or Draft identity.
An iPad in a narrow window uses the same drawer as a phone. Once the container
can fit the sidebar and minimum content width, navigation docks alongside the
content. The user can hide/reopen the docked sidebar. Selecting a feature,
creating or deleting a Bot dismisses only an overlay drawer, never the docked
sidebar. Compact drawer progress and the wide sidebar visibility preference
are independent; switching width does not overwrite either intent.

The same navigation and scene children stay in the same React positions across
resize. Docking changes scene bounds; it does not key or reparent the Bot
WebView, Chat runtime, conversation, Composer or account editor. Chat chooses
its inner conversation-sidebar layout from its own measured width after the
outer Bot sidebar has taken its space, not from the application window width.
Viewport remeasurement rejects older callbacks so keyboard overlap uses the
current screen rectangle.

Account presentation has its own capacity rule: adequate width presents a
centered, bounded panel with a scrim and safe outer spacing; narrow containers
present the existing full page. The native account body and controls retain
state while external browser journeys run. Dismissing Account returns to the
original Bot surface and navigation state. Entry changes invalidate old animation completion
callbacks; geometry changes do not create navigation entries or restart entrance
animation. Nested settings pages remain inside their parent surface. A panel
does not add the full-screen safe-area inset again inside its content.

Dismissal distance is measured to the host container's right edge from the
surface's resting left edge. A centered panel moving only by its own width
still leaves its outer margin visible and must not be released at that point.
Gesture release continues from the current progress with the release velocity;
button Back uses the same UI-thread completion, starting with zero velocity.
Use one clamped spring for completion/return, not a fixed-duration animation
that restarts easing after the drag. At completed exit the surface and its
shadow leave no visible pixels; only then may the current entry callback hide
or release it. Navigation is not switched at the swipe threshold.

Pure geometry and transition tests cover capacity and return contracts. They
do not prove WKWebView continuity, keyboard coordinates, gesture smoothness or
iPad behavior. Check those in Expo on portrait/landscape, narrow multitasking
windows, continuous resize, floating keyboards and hardware keyboards.

The drawer and account controls are native. Use HeroUI Native components and
`@opencraft/design-system/tokens.native` by default. The installed HeroUI
Native version does not export a drawer container; the iOS drawer uses a local
Gesture Handler and Reanimated container, with HeroUI controls inside it. Do
not describe this as a HeroUI drawer or bring in Unistyles.
The closed Bot drawer accepts a deliberate right swipe across the main
surface outside content-owned controls. Before the native pan becomes ACTIVE,
manual admission waits for a clear horizontal stroke (18 logical points and
at least 1.5 times its vertical displacement). Once movement reaches 10 logical
vertical points without that horizontal dominance, the Shell yields for the
rest of the contact. Small motion stays undecided; controls, unavailable pane
intents and multiple contacts yield without activating a no-op recognizer.
The thresholds use logical points where the native pan is mounted; panel
travel still uses the measured container. iPad Expo Go omits the full-scene
pan in all window sizes after a device-confirmed crash while swiping. Its
native navigation surface has a separate left-swipe-to-close recognizer; this
does not wrap Chat or WKWebView. Pane buttons remain available. Treat the
sidebar-local swipe as device-unverified until it is tried on iPad; restore
full-scene swipes only after a device-tested recognizer path or an identified
native crash cause.
The sidebar-local pan drives one native dock progress shared by the sidebar
and the content edge. A swipe follows the finger and settles with a spring;
toolbar toggles use the same progress and may reverse before completion. The
Bot/WebView tree stays mounted while the content width changes.
Admission and the chosen pane are
sticky until release/cancel, and a fresh touch starts a new decision immediately.
Do not reintroduce automatic X-only activation followed by an onStart direction
check: UIKit may already have cancelled the WebView's scrolling at that point.
The installed Gesture Handler 2.x manual-activation gate and synchronous state
manager own admission; the WebView native gesture remains simultaneous.
The drawer has one UI-thread progress
value. A new horizontal gesture can interrupt opening or closing, cancel the
old animation and continue from the rendered progress. An already vertical
WebView touch stays with scrolling; a fresh touch is eligible for horizontal
arbitration even while WebView scroll momentum is ending. Relate WebView's
native gesture to the drawer pan without remounting the WebView. Keep the
drawer behind account navigation and preserve its progress while account is
visible.
Bot settings pages are the existing `frontend/` components built into the local
DOM runtime; the shell does not reimplement those screens. Bot Chat is the
packaged OpenCraft Web Workbench, connected to the selected Bot instance and Profile;
its conversation model is shared with the OpenCraft Web Chat renderer.
The packaged Bot HTML is read once during iOS shell startup and reused when
the authenticated Bot surface mounts. The first embedded section is Chat,
so its data work can begin as soon as the Bot session is ready. The native
drawer uses a vertical Bot icon rail beside the selected Bot's feature/session
pane. Profile avatars, selection outline and lifecycle dots belong to this rail;
creation is the plus button at its end. The selected Bot name/status and deletion
action stay in the adjacent pane header. Daily/Explore navigation uses HeroUI
Native Tabs (List, Indicator, Trigger, Label and Content) with library styling
and indicator motion; it only filters the existing frontend group projection.
Switching categories does not select a feature or remount the Bot runtime.
The Daily/Explore tab list stays fixed below the Bot header, outside the
feature/session ScrollView. Only that list's body scrolls; the Bot rail scrolls
independently and the account footer stays fixed. Use bounded flex capacity,
not scroll-offset callbacks or a second overlaid copy of the tabs.
The Expo Web entry resolver delegates non-entry modules to the existing Uniwind
resolver. Replacing that resolver bypasses library component styles even when
the CSS and component imports compile. HeroUI style scanning covers both the
workspace-hoisted and app-local dependency locations.
On Web, `heroui-theme-color.web.ts` resolves theme values through the browser
color engine before HeroUI colorKit consumes them. CSS Color 4 (`lab`, `oklch`,
`color-mix`) stays in the theme source; the adapter produces RGBA, preserves
alpha and caches resolved values with a bound. Metro substitutes only HeroUI's
Web theme reader and keeps native resolution unchanged. Do not silence color
errors or substitute black for unsupported parser input.
Switching Bots keeps the navigation open;
choosing a feature/session dismisses only an overlay drawer. The account/settings
footer stays fixed below both independently scrolling columns. Frontend owns Bot
selection, creation, deletion and profile metadata. Cached Bot content stays
mounted when account surfaces open. No separate brand-title header is reserved.
Feature and account rows use HeroUI Native ListGroup slots; account Avatar
retains expo-image memory/disk caching and the primitive's failure fallback.
Spinner and Separator own sidebar loading and dividing lines. Session actions
use one controlled Menu owner for the list, separate from rename drafts and
delete confirmations. The Web focus adapter adds Radix keyboard/focus policy;
native Menu retains its portal and accessibility ownership. The pinned Menu
measurement patch in `scripts/patch-heroui-menu-measurement.mjs` accepts valid
measured dimensions rather than an offscreen probe position; review it on
library upgrades. It does not replace the primitive's positioning algorithm.
Session failure feedback comes from confirmed mutation, pin or pagination
failure in the frontend controller. A healthy loaded list projects no failure;
boolean error flags must retain their boolean meaning across the host port.
The Bot host applies the bottom safe-area inset once to all embedded pages,
including Chat; WKWebView automatic content-inset adjustment is disabled. The
packaged Web Chat manages composer/list capacity via its measured viewport and
Web visualViewport contract. Do not layer a native keyboard translation or a
second keyboard-avoiding wrapper onto this DOM Chat. The independent RN
Workbench keeps its existing native keyboard-controller model; this separate
renderer is not mounted in the Agent Console. Hardware keyboard and iPad
floating-keyboard acceptance remains device work, not proof from bundle tests.
Real-name, complete
account management, and subscription/payment remain first-party web routes.
During initial language and session restoration, the login surface remains in
place with its primary action disabled. Do not insert a separate branded
loading page between Expo startup and the authenticated workbench.

## Focused checks

The Chat right pane uses the shared native container in
`mobile-agent-panels.shared.tsx`. Expo measures content capacity and provides
one shell open/close button; it does not recreate tabs or a tab-manager dialog.
Below panel minimum plus Chat reserve, the pane overlays Chat; larger containers
place both beside each other. The original locally bundled `RightPanel` owns
all internal controls, menus and content, including full-width intent. Its DOM
toolbar has no reservation for the independent Web AppShell header. Account
navigation, Bot sidebar and Chat panel remain separate semantic surfaces.
Layout changes do not add navigation entries, reset tabs or replace the runtime.
No second WebView, Chat application or browser session is introduced. See
[Bot bridge](mobile-bot-bridge.md#chat-panel-host-presentation).

Exercise: open drawer → Account → Back; open drawer → Account → full account →
Back; Account → Subscription management → Back; rapidly switch Bot sections;
reload the Bot runtime; rotate or resize the container while a surface is
visible. Observe that the drawer selection, scroll, Bot state, safe-area fill
and status bar stay stable. The pure transition tests guard late web events;
they do not substitute for checking an Expo runtime after visual changes.
For gesture changes, additionally open → immediately close before the spring
settles, close → immediately reopen, drag vertically in the Bot WebView →
continue sideways without lifting, then lift → immediately swipe sideways
during scroll momentum. Check a WebView horizontal control separately.

## 平台入口与路由扫描

`src/app/index.tsx` 与 `_layout` 系列是薄路由，委托给 `mobile-home-route` 和 `workbench-route-layout` 的平台实现。Expo Router 的基础路由可能和平台 override 一起进入扫描；模块边界由 Metro 平台解析隔离，不能依靠 JSX 分支阻止导入。iOS 的 DOM 容器、账号 SQLite 与原生导航不进入 Web 模块图；Android/Web 沿用各自 Workbench 运行时。验证覆盖 Expo Web 导出与 iOS bundle。

### Unified console and folding geometry

The parallel `/agents-next` Expo Web entry shares native navigation/session
controls and the same local DOM controller with the downstream Expo console.
A foldable's current window is the layout input, not a device category.
`resolveMobileShellLayout` decides drawer/sidebar and page/panel geometry;
resizing never changes Bot, Thread, Draft or content runtime identity.
Bot selection preserves the navigation presentation instead of clearing its
rows while awaiting the DOM controller. Both hosts consume the bounded,
scope-isolated [navigation continuity model](mobile-data-architecture.md#bot-navigation-continuity);
cached display and current command admission are separate states.
Web uses ResizeObserver through RN `onLayout`, native uses measured container
layout. Account updates use the Web mount port's update operation. Platform
ports own navigation/authentication and DOM containment; business mutations
remain in the frontend controller. The DOM Chat consumes actual visualViewport
geometry; do not add the former RN composer keyboard offset to this Web view.
Embedded Chat must allocate the complete root/main/section/grid/content height
chain using elements present in embedded mode. Website chrome classes are
intentionally absent there and cannot supply its geometry. Verify the packaged
custom element has positive measured height after viewport resizing; module
registration alone cannot establish that the Chat is visible.

## Shared panel chrome and swipe intent

Toolbar panel glyphs share `@opencraft/design-system/sidebar-toggle-glyphs`
with desktop OpenCraft. Native SVG adapters keep a 16-point optical box,
rotate the right glyph 180 degrees, and retain separate 44-point touch targets.
Both controls use neutral icon color and transparent resting backgrounds.

The native pan admits a left stroke into the available Chat right pane when
navigation is closed; contacts on a presented or exiting pane stay with that
pane in either direction. A stroke closing navigation cannot also open the
right pane. Editable controls, selection, vertical scrolling and horizontal
DOM scrollers retain their contact through the runtime-validated ownership port.

The native pan reports start/move/end/cancel samples, coalescing moves without
changing the tab owner. The local `EmbeddedHostPanelLayout` captures its current
presentation on start, follows held displacement, and settles with one spring;
buttons and service-originated intents use the same spring. A new stroke stops
that spring before reading its live position. Release commits the chosen open
intent through the original panel service; cancellation restores its current
intent. Geometry/owner replacement retires the contact and rejects late samples.
The driver respects reduced motion and releases its animation/subscriptions.

The embedded parent is a grid with Chat and panel as sibling viewport slots.
Wide capacity reserves a real column for each, and Chat's AppShell consumes
its slot rather than the full document. Narrow/full-width presentation shares
one grid area and translates the pane over Chat; only this mode is a replacement
surface. A boolean presentation-active projection keeps closing content mounted
and lets native arbitration interrupt exit; it is not a second visibility owner.
The complete original DOM panel remains in the same runtime. Web component
motion evidence cannot prove iPhone bridge latency or iPad hardware performance.
