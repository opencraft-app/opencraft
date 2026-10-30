# Workbench invariants: Navigation and sidebar

[Invariant index](../invariants.md) · [Design index](../README.md)

## Desktop sidebar bottom navigation

The unified desktop sidebar has one full-width context column. Global destination
icons occupy its bottom row, with Settings and Account at the trailing edge in
normal flow. There is no independent vertical icon rail. The action track scrolls
horizontally if its destinations exceed the available width; accessory controls
remain reachable. Application routes keep the same sidebar width rather than
compressing this row into a vertical rail. Existing saved reading widths remain
valid; default and minimum widths no longer include an absent rail.

Applications has one desktop entrance in the persistent header, immediately before
the preview-window toggle. It uses the same navigation action and selected state
as the existing destination. Mobile retains its labeled scrolling navigation,
drawer-header Applications entrance and floating actions. Portal, conversation,
draft, scrolling, account and navigation owners remain unchanged.

Navigation glyph geometry belongs to the shared application-navigation role.
Destination buttons and accessory Buttons consume the same icon token, including
when Button inserts a label wrapper. Account avatars keep their own size role.
Header panel entrances instead consume the shared chrome icon token: narrow
layout and touch density project its size; nested cross-fade glyphs and portalled
sidebar controls do not define independent sizes.

## Persistent sidebar control beside the brand

Unified Shell navigation keeps its sidebar toggle in the persistent header,
immediately after any visible application brand, through expansion, collapse and
resize. The brand rail uses intrinsic content width in both states. Navigation
rails and floating sidebars do not add another toggle. Existing mobile gestures,
touch chrome, focus and draft owners remain responsible for their state.


## Sidebar Server filter continuity

The installation UI preference owns the Server filter's stable ID and display
label. Refresh, missing rows and physical reconnect never reset it to all Servers.
Within the same recipe and authorization scope, loaded rows retain identity and
placement through offline/reconnecting phases; only navigation and mutation
availability change. Logical phase transitions update controls immediately;
ordinary runtime notifications do not repaint the catalog. Cached management
`open` cannot bypass reconnect backoff. Ready refreshes the catalog. Explicit
removal, disablement and authorization/recipe changes still revoke cached rows.

## Mobile Sidebar theme surface

The mobile drawer owns one theme Sidebar/window composite. Context children do
not replace it with main-content surfaces; sticky headings and the floating
header use the same opaque composite to cover scrolling content. Changing theme
or mode updates every layer without remounting navigation. Desktop material,
geometry, scrolling and gesture ownership remain unchanged.

## Sidebar scroll ownership

SharedSidebarContent owns scroll receipts for its logical content throughout
AppShell's lifetime. Shell supplies an explicit keyed external viewport when
mobile layout scrolls outside the portal; descendant DOM receipts continue to
cover desktop lists. Layout coordinates are independent. A new viewport restores
its receipt in layout effect before paint. Empty, detached, hidden or exiting
viewports cannot overwrite receipts with clamped zeros; a deliberate scroll to
zero in a visible viewport is valid. Hidden selection updates do not auto-scroll.
No new persistence, polling or drawer keep-mounted policy is implied.
Acceptance: `OPENCRAFT_SIDEBAR_SCROLL_ONLY=1 npx tsx scripts/smoke/shell/smoke-mobile-sidebar-gesture.ts`
uses the actual AppShell/Sidebar and verifies reopen, zero, quick reversal,
hidden selection updates and desktop/mobile handoff in light/dark/reduced motion.

## Native conversation pinning

- PIN-01：置顶由原生 Server 持久化；OpenCraft 不维护第二份数据库或浏览器置顶集合，DSH 不支持时不补本地 fallback。
- PIN-02：接口准入不等于原生能力。当前连接成功发现支持后才显示置顶菜单；暂时失败不冒充不支持或空置顶列表。
- PIN-03：置顶读写只处理元数据，不 Resume/Start；Hermes 明确携带所属 profile，身份歧义拒绝写入，压缩链由 Hermes 自身处理。
- PIN-04：置顶目录返回完整摘要、独立于近期窗口；侧栏去重后单独分组，待处理优先于置顶且去重；置顶不占十条最近区预算。刷新/重连从后端重新读取。
- PIN-05：同一会话写入串行；操作前列表不能覆盖操作后状态；连接撤销拒绝晚到结果且不重放写入。菜单复用现有受控互斥 owner，不拥有存储或轮询。
- PIN-06：下游产品站点的外层会话侧栏只消费嵌入式 Workbench 投影的置顶状态、能力和动作；置顶会话不占近期分页名额，站点不持久化第二份置顶集合。

## Mobile sidebar gestures

Narrow browser Shells reveal the unified sidebar with a rightward touch drag from
content; a leftward drag dismisses it, following the iOS direction convention.
The Shell owns one progress MotionValue for direct manipulation, reversal and
settling. Short slow gestures return to the starting intent; distance or a
horizontal flick commits. Cancellation, multitouch and resize return to the
starting intent. Window blur, page hiding and replacement contacts also retire a
held gesture synchronously, even when the host omits its terminal touch event;
replacement editor/native contacts cannot strand a partial foreground.
Vertical scrolling, editors, exclusive gesture regions,
selection, menus and dialogs keep their own input. Unclaimed outer 24px contacts
remain reserved for browser/OS gestures. A Runtime adapter may hand the original
contact through the shared edge-input bridge; the same sidebar arbitration then
accepts it without checking PWA, Web, Electron or presentation markers. Ordinary buttons, links and clickable content (including
reasoning/tool disclosures and image previews) do not own horizontal input merely
because they are clickable. They may start a sidebar gesture; taps and small
unrecognized movement still activate the original control. A recognized swipe
suppresses its synthesized click without blocking the next deliberate tap.
The enabled mobile Shell discovers horizontal scrollports from the composed
contact path using actual overflow and scroll extent. Reading content participates
by default: Markdown, command output, raw details, future and dynamically mounted
readers need no registration or navigation handlers. Only true input owners opt
out via their semantics or `data-sidebar-gesture="ignore"`: editors, sliders,
scrollbar controls, draggable controls, interactive terminals, media/canvas/iframes
and foreground layers. Before committing, nested reading chooses the innermost
scrollport with capacity in the requested direction; an exhausted child does not
hide a readable parent. After committing, its movement owner stays fixed.
The existing touch controller arbitrates one contact:
`pending → sidebar | content | native`. Ambiguous diagonals remain pending;
committed ownership never changes on reversal or later acceleration. A competing
sidebar flick requires at least 28 CSS px, aligned recent speed 0.65 px/ms and
horizontal/vertical ratio 1.8 within 100ms of meaningful movement; speed is
averaged over the last 80ms. Stationary contact time does not consume this window.
A prompt first sample may establish fast intent; a low initial estimate cannot
establish reading because event delivery may include contact latency. Later speed
uses samples beginning at meaningful movement, excluding touchstart latency.
A rested first sample has unknown speed until the next timed segment. Passing
28px alone never commits reading: a non-winning contact keeps the observation
window and commits to content at 100ms of movement or on release. Pending, direction-locked horizontal contacts in discovered
scrollports cancel their first cancelable move to prevent native takeover without moving either surface; vertical and
ambiguous input remain available to the browser. A one-sample horizontal contact
finishes as local reading on release rather than disappearing or synthesizing a
click. A scrollport already
at the requested boundary can yield to the ordinary sidebar threshold. These are
initial tuning values, not physical-device or universal platform constants.
The Shell does not impose ancestor `touch-action` restrictions or maintain a
second DOM registration cache. Native vertical scrolling, pinch zoom, wheel and
keyboard remain available, including inside exclusive descendants of reading
scrollports. The capture listener drives `scrollLeft` only after content wins;
sidebar wins never write content offsets. A non-cancelable stream remains with
the browser instead of being seized or frozen. Desktop/standalone Chat stays native.
Content momentum is bounded, respects reduced motion and is revoked by a new
contact, modal, resize or unmount. Foreground layers, editors and explicit ignore
regions retain native behavior; unclaimed edge contacts never acquire the sidebar.
An image lightbox retains its own input. An ordinary horizontal gallery is reading
content; a gallery with custom gestures declares an exclusive owner at its boundary.
The entire foreground input layer owns the sequence, including image-preview
letterboxing/scrims and controls. Shell admission resolves the composed event
path and its presentation DOM root, so native dialogs and Shadow DOM portals
have the same priority as accessible modal surfaces. Opening a foreground layer
revokes any pending/held Shell gesture before its late move/end can commit.
Closing it permits a new Shell sequence, never resumes the revoked contact.

Acceptance: `OPENCRAFT_GESTURE_CONTENT_ONLY=1 npx tsx scripts/smoke/shell/smoke-mobile-sidebar-gesture.ts`
uses real reasoning, inspected/generated/sent-image renderers and CDP touch to
check held following, no activation on swipe, original tap actions, cancellation
and native input exclusions in light/dark and normal/reduced motion.
Mobile uses a page stack: the sidebar stays anchored behind the foreground page.
The moving page paints an opaque theme surface across its entire rectangle,
including the gaps around floating conversation chrome; rear sidebar content
must not show through it. Drawer settling has no bounce and the foreground
translation stays within the closed/open bounds, including cancellation,
interruption and the final frames before presence releases. The root remains
transparent so the uncovered part of the stationary drawer remains visible.
One progress translates the foreground and brings the rear layer from 90% scale /
45% opacity to its full size and clarity, with a left-center origin. A stationary, pointer-transparent theme veil fades
from 65% to zero with that same progress, stronger toward the foreground edge.
Light themes wash toward white; dark themes retain their own elevated surface.
The foreground has a pointer-transparent theme veil driven by the same progress from zero to 65%, reciprocal to the rear veil: opening clarifies the sidebar while fading the conversation, and closing reverses both, including held and interrupted gestures. Reduced motion disables both veils. It releases with panel presence/inertness. A stationary
full-viewport theme Sidebar/window material backs this animated layer while the
floating panel is mounted, including the top/bottom safe areas. The scaled
mobile panel surface is transparent: only the stationary owner paints the full
material, avoiding fractional-edge double compositing. Scaling/fading
content must never expose window-colored horizontal strips. The exiting/inert or empty portal
paints nothing when the foreground returns to its ordinary stacking order.
Mobile presence exit hides the retained content surface immediately: aria-hidden
and inert alone do not suppress painting. The surface has no CSS transition,
including the global reduced-motion duration, so hiding cannot wait one frame.
Both content and backing are checked
at DOM commits and animation frames through final removal; desktop exit motion
retains its existing lifetime. There is no
horizontal sidebar entrance, blur, separate depth timer or inherited animated
variable. The foreground retains its full
layout width, round leading corners and theme elevation; the untransformed root
continues to own viewport/gesture coordinates. At least 64px of the page stays
visible for tap-to-dismiss. Per-frame progress stays in MotionValues. During floating presence the page
uses a fixed theme radius, released once the page has returned home; interpolating
its radius repaints the full foreground/shadow during each drag frame. Mobile
foreground opts into transform compositing while present, so nested masked
composer scrollers do not repaint against the viewport on each translation;
rear depth opts into transform/opacity compositing only for its mounted floating
lifetime and normal motion. Neither changes content identity or freezes updates.
The moving page disables CSS transition properties: the global reduced-motion
minimum duration must not add a second transition to each MotionValue write.
Do not publish inherited animated CSS variables through the conversation subtree.
`OPENCRAFT_GESTURE_COMPOSITING_ONLY=1` records a real held/reversing touch trace
and checks that steady movement does not repeatedly paint either Shell layer.
While open or directly dragging, the original page is
inert and its exposed strip is the accessible close action. Closing intent
immediately releases its ordinary header entrance, including Escape focus return;
retained exit presence must never block reopening. No screenshot clone or second
conversation tree is created. Desktop floating panels remain overlays.
Dock/overlay continue sharing the same DOM, scroll and drafts. Browser safe-area
insets reserve notch/Home Indicator space in the drawer and toolbar. Reduced
motion skips settling animation and sidebar depth, but still follows direct touch movement.
Selecting a conversation in the narrow browser drawer dismisses it immediately,
including selecting the current conversation again. Shell owns this presentation
policy; selection does not toggle or collapse a docked desktop sidebar. Group
headers and row menus remain independent controls and do not dismiss the drawer.
Evidence: `mobile-sidebar-gesture.test.ts`, `smoke-mobile-sidebar-gesture.ts`;
real iPhone Safari and native Expo remain separate verification surfaces.

## Unified sidebar scroll

On desktop, unified navigation remains independent of list scrolling: docked and
floating sidebars retain the 60px vertical rail. Buttons retain at least 44px hit
areas. In the desktop list column, the heading and its filter button stay fixed;
`.sidebar-activity-list` is the conversation scroll owner. Mobile uses the shared
native viewport described below, rather than a separate fixed navigation strip. Selection reveal targets that
viewport. Moving the shared content portals preserves its DOM and scroll position.
Evidence: `scripts/smoke/shell/smoke-sidebar-thread-insets.mjs` (real AppShell/Sidebar).

Mobile navigation rows, including Home, scroll out with conversations in the shared native viewport. No Home-only sticky surface or top scroll offset remains; the floating New chat and settings actions remain reachable at the bottom. Desktop navigation is unchanged. Acceptance: FAB-only mobile sidebar smoke measures Home displacement against actual scrollTop and verifies it leaves the viewport while creation/settings stay fixed.

## Application navigation restoration

In the unified core Sidebar, application destinations and available Work tools
consume the same navigation actions in the desktop icon rail or mobile drawer stacked menu. They do not precede the
conversation groups in the list column or add a divider there. List controls and
conversation scrolling have separate slots; navigation restoration preserves
the list viewport and the existing application Router authority.

任务草稿保留：Application 级输入槽拥有原 Controller、File、预览与处理任务，View 只借用。桌面 20 个、移动端 4 个非活动页面的缓存淘汰不得删除非空输入；输入槽按 50 份非空草稿单独执行 LRU，空输入不计数，淘汰同时丢弃持久文档并释放附件资源。正在编辑或发送的所有者不可淘汰；全部受保护时拒绝新内容，不超限。侧栏完整 A→B→A 回到最后成功呈现的槽位，显式新 View 与 POP 仍独立。Scope promotion 必须更新无页面但仍保留的草稿；账号撤销清除全部槽位与目标缓存。验证：`test:task-draft-switching`、`smoke:task-draft-switching`。

浏览器草稿补充：任务输入槽由 ConversationDraftOwnerRegistry 保留，ConversationDraftContinuity 仍是唯一文档持久化写入者，不叠加另一套持久化写入者。Bot Composer 通过平台存储端口保存 document、context 与附件元数据，不保存提交回执、执行状态、临时听写或发送锁；存储按产品／账号和 Host + Conversation 身份隔离。只有显式内容编辑和接受发送后的清空写入存储，生命周期变化与卸载不能覆盖其他 View 的输入。账号作用域变化撤销并清除旧适配器，迟到写入不得复活旧内容；新应用实例绑定新账号。浏览器 File 字节及临时侧聊不在当前持久化承诺内；失效 Object URL 或未完成附件恢复为可移除、不可发送的文件卡片。验证见 `chat-browser-drafts.test.ts` 和 `smoke:browser-drafts`。

确定被拒绝的排队跟进由 Conversation Runtime 本地持有，尚无 Server 队列 ID；用户删除只撤销该本地记录，不请求 Host 队列删除，也不自动重发。投递结果未知的记录不得当作失败项删除或再次提交，直到同一 client message ID 出现在 Host 队列或权威历史中。提交中的记录不可删除，已确认入队的消息仍以 Server 队列 ID 删除。

历史记录只持有聊天引用，不拥有草稿的存活事实。启动与历史恢复必须先由 Host 配置、ScopeRegistry 和 BindingStore 校验/规范化，再让 Router 与激活层消费同一个目标；有效当前 entry 优先于跨标签页共享的最后使用偏好。失效 Draft 不按旧 ID 重建，已提交 Draft 经持久 alias 找回 Thread。Router 唯一写回纠正结果并保留 Settings/Extension 目的地；失效引用回到当前实际保留的 View 与输入，View 不能跨 Scope 复用。规范化为 REPLACE 的 POP 仍须被资源事务消费。

返回同一个保留 View 不依赖远端就绪：Chat、当前会话入口与 POP 共用本地呈现/后台续接语义，晚到结果受导航代次和释放约束；提交中的草稿仍拥有导航。侧栏只表达 `selectConversation`，不自行解释活动 Thread、pending 或设置页返回；重复目标合并、保留 View 复用与可见项早退都由导航事务决定。显式 `navigate` 不等于选择，不能按 Thread ID 合并独立历史 View 的输入。后台草稿准备、返回、POP 与提交转换共享 intent/释放/Router revision 资格及接受或释放路径；非活动草稿不得获得当前导航权。嵌入式 memory Router 不读写外层页面历史。责任与入口见 [Application Router authority](../../docs/architecture/platform/shell-and-navigation.md#application-router-authority)、`workbench-location-restoration`；验证使用 `test:application-route-restoration` 与 `smoke:application-route-restoration`，不将隔离 Host 替身验收冒充手机或完整账号启动实测。

## Application navigation glyphs

- Navigation contribution 只声明图标语义和当前目的地；Web/Electron 的 NavigationIcon 拥有轮廓/选中图形投影，Design System 拥有 20px 图标、36px 基础控件、圆角、间距和状态色。不得套用菜单行的 14px 图标或独立次要颜色，也不以收缩时整体 scale 改变图标物理大小。
- 选中态仅对明确支持的闭合图形填充；Bot 面部、Server 指示灯和 Gear 中心等内部细节保留轮廓，不能统一 `svg { fill }` 抹掉。不同状态共享同一 SVG 盒子，不改变页面意图；不恢复 Home，新增入口必须具备已接通的功能。
- Shell 的 compact/expanded 内容保持同一实例，应用行的视觉盒子与触控命中区分离；粗指针或当前触摸输入时至少 44px，仍容纳于原 52px 紧凑栏中。鼠标 hover、键盘焦点、当前目的地与菜单打开分别投影。账户菜单保持其独立密度与反馈。
- 证据：`workbench-navigation-icons.test.ts`、`smoke-navigation-icons.ts` 检查尺寸、图形、状态色继承、明暗/扩展主题、紧凑/展开、触控/鼠标、普通菜单负例与键盘/强制颜色；真实手机和当前预览替换须另行记录。

### Sidebar 折叠分组密度

等你处理、置顶、最近共享紧凑的分组节奏：折叠标题与更多/收起之间使用4px间距，展开列表与下一分组使用12px间隔。折叠内容不占位。触屏标题与更多/收起保留至少44px命中高度，SidebarSection角色在触屏密度下为16px/22px、500字重；桌面为13px/18px。密度由共享偏好与触屏能力决定，不按窗口宽度重新判定。计数继续使用metadata层次，分组标签与内容保持同一leading轴。

## Sidebar attention and read receipts

Execution and read state have separate owners. `waitingOnApproval` and
`waitingOnUserInput` project `review`; other active work remains `running`.
The attention group contains only backend waiting and error states. Completed
results, including unread replies and historical results, stay in pinned/recent;
unread remains independently tracked; the compact sidebar omits its blue dot. No manual acceptance lifecycle is inferred.
Reading never resolves a backend wait or error.

The Application owns `ThreadAttention`, whose receipts identify Host/Thread/Turn.
The browser adapter scopes persistence to provider-verified account identity;
account changes revoke pending reads. Selection alone is never a receipt. A
terminal Turn marker must intersect the actual foreground, focused scrollport
and pass an occlusion check. Old-turn receipts cannot clear a newer result.
History catch-up is a latest-Turn metadata-only read, bounded to 50 catalog rows
and three concurrent requests per admitted Host; it never resumes or executes,
never dials an idle SSH Host, and a failure cannot cause a retry loop. Local
receipts survive refresh; cross-device receipt synchronization is not provided.
Completed unread replies use a 5px theme-accent blue dot; review and error
dots remain 5px neutral tertiary marks in the shared activity/action lane after
product-owned participants. No separate status
column remains; distinct state labels and auxiliary text retain their meaning.
An active native Goal uses a neutral Target in that same slot, replacing
ready/running feedback, including gaps between Turns. Opening a Thread and
backend review/error feedback retain priority. Paused, limited, blocked, complete
or cleared Goals return to ordinary activity feedback. The icon is a read-only
projection, never a Goal scheduler or a read receipt.
The Target has a subtle 3.2-second mask shimmer with 65–100% opacity, without
rotation, scaling or row movement. The shared 15/16px glyph material samples the
200%-wide mask in 64 positions per cycle (20Hz), limiting visually redundant
subpixel repaints. This decorative cadence must never throttle Goal updates,
spinner feedback or directly manipulated drawer motion. Reduced motion renders the unmasked static
glyph; inert or aria-hidden hosts pause the animation.
The Composer Goal row uses the same Design System glyph motion while active;
paused, blocked, limited and completed rows remain static. The row's text and
geometry never animate with the Target.
Running spinners, Goal targets, pending indicators and dots share the same end
lane across rows; touch pairs the activity and action cue inside its44px target. The row target spans the grid, while the independent avatar
control occupies its own column without nesting buttons or moving on hover;
review/error and running feedback keep their own semantics. A product supplying
participation evidence must positively identify the viewer as creator or participant
before displaying unread; missing metadata or signed-out identity shows no dot.
This eligibility is independent of the personal-list filter and creator grouping.
A deployment may opt into `VITE_THREAD_UNREAD_RESET_BEFORE` (fixed Unix seconds).
Metadata catch-up acknowledges terminal results at or before this baseline before
publishing them. A missing completion timestamp uses the catalog update time.
The baseline is fixed across future builds and all accounts/browsers; it must never
advance on every build or first visit. Newer offline/live results remain unread,
and stale reads cannot acknowledge newer live results. Unset/invalid values
preserve normal read behavior; this is not a change to backend waits or errors.
Tests: `thread-attention.test.ts`, `thread-catalog-query.test.ts`,
`scripts/smoke/conversation/smoke-thread-attention.ts` (real DOM/intersection/occlusion; platform focus is substituted because Playwright forces tabs focused).

## Thread list typography (2026-10-15)

Web/Electron conversation list titles consume the dedicated `threadListTitle` role (13px, 20px line height, regular weight) and normal letter spacing, with body tracking also normalized by UI-TYPE-1. Header, chat, metadata and code metrics keep their existing roles; row heights, hit targets and theme colors are independent. The Native alias retains the existing thread-title metrics and has no new consumer.

### Small-screen unified sidebar presentation (2026-10-15)

The browser drawer uses `data-navigation-layout="mobile"` with its own
`shell-navigation.mobile.scss` presentation layer. Full-width application rows (44px minimum targets) and the conversation context
share one native scrollport. Home, the other application rows and filters
scroll away together. Mobile New chat and Settings float above the bottom of the
scroll track; the mobile account entrance is omitted. No horizontal navigation
scrolling. This replaces the earlier mobile horizontal strip, sticky Start and
bottom account track; desktop retains its icon rail and footer.
Actions, translated labels, account controls, list/filter state and portals are
shared; resizing must not recreate those owners. Mobile search and participation /
server filters belong to the same native scroll viewport as the conversations,
so an upward swipe scrolls them out and returning to the top restores them.
Desktop Start uses the same quiet navigation treatment as other destinations,
without a primary dark fill. Desktop keeps controls fixed and only its activity list scrolls. Selected-row
visibility checks consume the viewport actually used by the current presentation.


### Sidebar matching-results continuation

The footer offers only Load more when the current search/server/personal-filter
result has recent rows omitted by the ten-row display budget (selected-row
inclusion counts as visible). Filtered-out conversations do not count toward
continuation and never generate a hidden-people notice or Show all action. Loading
expands the matching rows without changing any filter; once all are visible the
footer disappears, with no Show less toggle. Product grouping owns its own rows
and does not receive the standard task-flow continuation button.

### Desktop navigation surface (2026-10-15)

Unified Shell uses a 60px icon rail with 36px desktop controls, 20px application glyphs, 16px footer glyphs, and 18px account avatars. Controls consume the shared application-navigation row/density token, expanding to at least 44px in touch-friendly density; labeled mobile rows retain their original 20px glyphs and neutral current-page highlighting. Home is the single conversation-area destination for both existing chat and draft routes, invoking openChat without creating a new draft. Desktop retains a full-width New chat row directly below Conversations. Mobile projects the same creation action into a Shell-owned floating pill over the bottom of the scroll track, with a circular settings button on its right. The floating settings button composites its secondary state tint over the existing theme opaque elevated surface in resting, hover and pressed states, so list content cannot show through. The mobile account/avatar entrance and bottom plate are omitted; desktop retains its rail footer. The list reserves space so its last row can clear both controls. New chat dismisses the mobile drawer. The generic Settings entrance retains the open mobile drawer while its shared left slot becomes settings-category navigation; only an explicit category selection dismisses it, including selecting the already active category. Desktop keeps its direct default Appearance route; route normalization and explicit deep links do not create a new drawer or a second navigation owner. Filters retain their existing scroll lifetime; mobile search is a floating header action. Real Shell browser coverage: `OPENCRAFT_GESTURE_FAB_ONLY=1` in `scripts/smoke/shell/smoke-mobile-sidebar-gesture.ts`. The toolbar exposes the sidebar toggle and preserves the measured native-window safe area; history remains in the router/browser without rendered arrow controls. A standalone managed site has a mascot/wordmark brand region in compact layout, sized from the default sidebar metric and capped by viewport space, with collapse at its trailing edge. Touch layout or a browser window whose unified sidebar has moved into its narrow drawer hides both the mark and wordmark in the persistent page header and releases the reserved rail width in visible and measurement copies, retaining navigation controls. The narrow browser rule also applies with compact density; wide compact browser and native desktop branding remain visible. Drawer headers retain the wordmark and a plugin-provided leading mark; plugins can opt out of their mark. The managed site retains its mascot there, replacing the internal mobile collapse button. The closed page retains its plain sidebar entrance, matching right-panel chrome. Search keeps its separate glass circular control. The existing data-ui-density preference owns interaction density; Shell owns the separate narrow-browser branding condition from its existing docking decision. The browser header uses the shared surface color, avoiding a separate gray empty strip. The context column and context-free main frame meet the toolbar and rail with square top-start seams; context presence changes neither saved width nor DOM ownership. Cards and modal surfaces retain their own semantic corner tokens. Tasks owns its single title above its Board/List toolbar; shell chrome omits duplicate management titles. Embedded shells retain their host presentation.

### Unified navigation conversation search

The unified desktop Shell exposes conversation search as a `shell.search` rail action, using the same navigation sizes and accessible tooltip as other actions. The mobile drawer projects that same action into a floating glass header button beside the wordmark, hiding the duplicate list row. It replaces the inline sidebar search input in that presentation. Cmd+K on macOS and Ctrl+K on Windows/Linux open the same app-level search from conversation and management routes, including while a composer is focused. Other dialogs and IME keep keyboard ownership. ModalSurface/Radix owns focus trapping, Escape, outside dismissal and focus restoration; search never rewrites the composer draft or sidebar filters/scroll state.

The modal searches titles in the existing multi-Host loaded catalog, explicitly labels its all-server scope, orders by recency and identifies each result's server. Host + Thread remain the selection identity; disabled interactions stay disabled. Arrow keys and Enter navigate through the existing `selectConversation` authority. Closing clears the ephemeral query; presentations without unified navigation retain their original inline filtering. Evidence: `tests/chat/conversation-search-shortcut.test.ts` and `scripts/smoke/conversation/smoke-conversation-search.ts`.

### Conversation group disclosures

Group headings omit counts and keep the chevron immediately after the label.
Opacity alone changes for fine mouse hover or keyboard focus; reserved geometry
and the full-row button remain stable. Mobile layout and coarse/touch input keep
the chevron visible, with a 44px mobile target. Existing aria-expanded/controls,
collapse persistence and plugin grouping ownership remain authoritative. Real consumer coverage:
scripts/smoke/shell/smoke-sidebar-thread-catalog.ts.

In unified Shell, each collapsible group heading sticks to the top of the current
native scrollport only while its own section passes through it. The next group
takes over without stacking headings. Desktop uses the activity-list scrollport;
mobile uses the shared navigation scroll track, so Home and other navigation rows
still scroll away. Its floating brand header is reserved once by the scrollport's
block-start padding; sticky headings retain zero additional block-start inset.
The active heading's visible top equals the real header's bottom, not the
scrollport origin plus a second toolbar height. Tests measure that chrome edge
independently and sample continuous scroll phases to catch blank gaps or row bleed.
The original disclosure remains the interactive owner, stacked below Shell
chrome. Opaque themes use their context surface; a continuous translucent Sidebar
plane keeps the disclosure transparent, without a local backdrop filter. Each
group's item container forms its own isolated stacking context and clips row
paint entering its own sticky heading. The list observes existing viewport scroll
only to project overlap; it introduces no scroll writer, scroll state or extra
scrollport. Row badges and avatar stacks cannot tint or paint over the disclosure.
Participant popover portals retain their existing floating-surface ownership.
There are no duplicate headings.
Historical Shell coverage used `OPENCRAFT_SIDEBAR_STICKY_ONLY=1` in
`scripts/smoke-sidebar-topology.ts`. That probe is absent from this standalone
checkout; this record does not establish a current passing sticky-geometry check.

### Consolidated conversation filters

The conversation heading's single Filters button contains the existing display-mode radios, optional Only my conversations checkbox, and server radios. The separate participation/server chips are removed on desktop and mobile. Checked items reflect the existing plugin participation preference and Shell server preference; the closed button emphasizes active filters through its foreground and summarizes them in its tooltip, without a resting fill. Missing identity still omits participation filtering, and a saved server absent during loading never broadens the result scope. Radix owns keyboard/focus/dismissal and viewport-constrained menu scrolling. Core probe: `scripts/smoke/shell/smoke-sidebar-thread-catalog.ts` (filter operation, offline continuity, reload persistence). Historical desktop/mobile/touch scroll-geometry coverage named `scripts/smoke-sidebar-topology.ts`, which is absent from this standalone checkout.

Conversations has equal block spacing from the existing navigation section token.
Desktop New chat is an unfilled quiet action with no extra top margin; the mobile
floating New chat retains its primary fill.

Conversation filter triggers use primary button fill and matching foreground while open or keyboard focused, rather than a persistent outline after menu focus restoration. Forced-colors mode retains the shared focus indicator; filter state and menu ownership remain unchanged.

Unified Shell sidebar controls share one SidebarToggleButton contract. Docked mode presents it at the sidebar navigation rail top; floating/mobile mode presents it in the fixed sidebar header and dismisses the drawer. The persistent Header only renders the closed-state entrance, with compact brand geometry. No duplicate floating pin/toggle or collapsed Write action is synthesized for unified Shell. Existing gesture, resize and stateful sidebar portal owners remain authoritative.

Application branding with a Home action is a native keyboard-accessible button. The mark and wordmark invoke the existing conversation-area Home destination, preserving the selected conversation or draft rather than creating a new task. Mobile drawers dismiss through the Shell selection owner. The hidden header measurement copy is inert; narrow-page brand visibility and rail alignment stay unchanged.

Desktop browser application branding centers the plugin-provided mark on the shared sidebar icon rail, deriving the offset from rail width, mascot size and leading chrome padding. Header measurement and collapsed routes use the same alignment; labeled mobile drawers and native window safe insets retain their own presentation.

Unified sidebar recovery: desktop visibility is explicit dock open/closed, with no
hover/edge preview. Small screens use one explicit drawer request and existing
mobile gestures; crossing back into dock capacity transfers that request into the
desktop dock. Resize restoration hysteresis never blocks an explicit expand.
Shell alone resolves sidebar commands (button and Cmd/Ctrl+B); route App shortcut
handlers do not write visibility. Layout-transition/exit states only retain physical
content ownership, never create a third user-selectable visibility state. Shared
portal content, draft and scroll survive fast reversals and responsive transfer.
Historical verification used `scripts/smoke-sidebar-topology.ts` for pointer
pauses after collapse, animated reversal, threshold+16px explicit recovery and
automatic drawer-to-dock. That probe is absent from this standalone checkout.

## Navigation preview author identity

The navigation hover/focus preview reads the selected prompt sender, never the viewer or a later steer author. Photo resolution reuses IdentityAvatarContext/AvatarImage. Known identities retain a fixed avatar slot on missing/failed images; unknown authors have no avatar. Existing Turn marker topology, preview caching and stale-result fences remain unchanged.

Goal time uses full days and remaining hours/minutes rather than unbounded hours. The server counter remains unchanged. Evidence: `scripts/smoke/conversation/smoke-thread-goal-ui.ts` (316h36m → 13d4h36m).

## Global conversation search

Title results remain available immediately; Message results add an escaped snippet and Server provenance. Closing/retyping/revoking a connection cannot publish late results or relocate another conversation. The dialog preserves keyboard ownership and drafts. Loading, per-Server failure/retry, title-only support, disconnected sources and remaining pages are explicit; incomplete coverage is never reported as an exhaustive empty match. Selecting a visible message reuses authoritative hydration and measured virtualized positioning, at the containing prompt for assistant matches. A raw-history match without a visible locator opens with a positioning notice; it does not claim an exact jump.


### Mobile search presentation

Mobile/touch conversation search is a full-page result view with the search field
and circular close control at the bottom, rather than a centered popup. The narrow
modal breakpoint and touch density select this presentation in CSS, preserving
one input/query/result tree across rotation and density changes. Radix continues
to own isolation, focus, Escape and restoration. The existing timeline viewport
port alone publishes software-keyboard/visual viewport geometry; search consumes
its dimensions/offsets and falls back to dvh without another viewport writer.
The keyboard inset is not deducted a second time. Result/source status stays above
the input. Closing or selecting returns to the original UI without changing draft,
sidebar scroll or search filter state. No empty-query label claims last-opened
history that the catalog does not own.

Mobile drawer wordmark and magnifier float above the existing scroll track with
a theme-derived translucent/blurred material. Top content reserves their toolbar
height; the closed page keeps its ordinary sidebar entrance. The managed site shows its
plugin-provided mark in the drawer leading slot instead of an internal collapse
button. Core and other brands remain neutral. Unsupported blur, reduced transparency and forced colors use an opaque
fallback. The existing bottom settings surface remains opaque.

Application brand artwork, favicon/install icons and public share metadata belong
to the active product plugin. Initial HTML and runtime project the same declaration;
unload/replacement removes its links and metadata and restores previous nodes.
Share cards use public product text, never the active conversation's private title.

Composer content bounds: the model-menu surface is the sole height budget; both
list/detail tracks and scroll panes shrink within it, including on narrow keyboard
viewports. All declared reasoning options remain scrollable and selectable. Empty
Newera placeholder copy belongs to its editor column and truncates to one line;
expanded copy wraps within that column, never over adjacent actions. Presentation
changes preserve the same editor, draft, native selection and focus policy. The
focused mobile layout smoke measures both bounds and actual option selection.

Process activity rows share stable list-owned grouped spacing across reasoning, command groups and image-view rows, independent of disclosure state. Detail reading space belongs inside the disclosure; prose boundaries retain content spacing. Semantic grouping and disclosure identity cannot be changed to achieve density.

### Sidebar rendering ownership

Shell open/close and animation bookkeeping do not invalidate the conversation
list. The list consumes only the stable dismiss-after-selection command; the
small New Chat control separately follows the transient action host. Normal
React props, local state and contribution subscriptions continue to update
selection, grouping, menus and busy feedback without a custom cache comparator.
Participant badge styles are a lazy module CSS dependency, shared by all rows;
embedded ShadowRoots consume the existing feature stylesheet mirror.

Historical acceptance named `scripts/smoke-sidebar-render-isolation.ts` for
zero list rebuilds during four mobile swipes, live business updates, selection
and New Chat dismissal, DOM/draft continuity, and document/Shadow badge styles.
That probe is absent from this standalone checkout; these invariants remain
requirements, and this record does not establish a current passing regression.

For the mobile drawer, offscreen conversation rows may skip layout and paint via
`content-visibility: auto`. The complete touch row reserves 56px before its
actual size is known, so opening/closing or scrolling cannot shift the list.
All rows remain in the same DOM, order and selection model; unsupported engines
render them normally. Held swipes still use the single Shell progress value.


## Sidebar presentation policy ownership

Sidebar presentation projections consume the existing Shell and intent-hook
state without acquiring pointer, timer, resize or content lifetime ownership.
Docked layout precedes outgoing layout presence/resize, which precedes floating
request/resize presence; hidden is the remaining state. Floating presence can
mount only after docked layout ownership ends. Suppression vetoes edge and peek
acquisition; retained intent uses the nonnegative live panel boundary.


## Sidebar menu rendering isolation

A Sidebar keeps one stable menu owner across row context, More and participant
badge menus. Subscriptions are keyed by Host/Thread; opening, switching or closing
a row menu only invalidates the previous and next row consumers, never the whole
Sidebar filtering/grouping projection. Stale close events cannot dismiss a
successor. Selection, grouping mode and hidden/removed/disabled targets still close
menus; Radix retains focus, keyboard, touch and dismissal. ThreadActionOwner keeps
dialogs and async action state across regrouping. Validate keyed notification
semantics in sidebar-activity tests and real Sidebar menu scalability smoke.

Conversation publications (send, queued Steer or streaming) must not invalidate
an unchanged Sidebar catalog through fresh command closures or equivalent catalog
arrays. Application bindings keep command identities stable while reading the
latest committed route. Render-time title and capability readers instead carry
explicit semantic revision dependencies; catalog status keys include admission,
Host phase, query status, fetch state and data revision. Title, permission,
selection, catalog and optional action changes must still repaint. Validate
30/200-row parent-publication isolation and latest-command semantics with
`smoke:sidebar-conversation-latency`; it measures unrelated Sidebar cost, not
end-to-end model or employee-device latency.

## Sidebar directory grid bounds

Directory grids and their groups use a bounded single column. Long unbroken project names or feedback must shrink inside the Sidebar rather than increase an automatic grid track's minimum. The existing saved/error message truncates within its slot and leaves the Retry action completely visible before interaction; activating it must not require automatic horizontal scrolling. Nested and grouped rows retain their existing owners and order.


## Sidebar modal target membership

Rename/delete dialogs dismiss when their exact Host/Thread leaves the complete Sidebar directory. Search, filtering, pagination and regrouping do not revoke a still-present target or lose its draft/focus. A same-ID Thread on another Host cannot preserve a removed target's modal. Cleanup does not submit actions or change selection. Existing `smoke:thread-management` verifies regroup continuity and both removal paths across desktop/touch and themes.


## Saved Sidebar directory refresh failures

A ready transport response with `cachedAt` is a saved directory after a failed refresh, not an authoritative successful refresh. Retain its rows and the existing failure/retry slot; error responses with that metadata use the same saved-directory explanation. In-flight reads stay quiet (`aria-busy` only), successful refresh clears the feedback, and Retry reads only that Host without selecting a Thread or remounting rows. Existing `smoke:sidebar-thread-catalog` covers ready/error saved results, timestamp zero, retry, quiet refetch and success on desktop/touch in both themes.

## Sidebar metadata badge placement (2026-10-20)

A thread badge contribution may select `metadata` placement to replace the visible
project line below the title. Shell owns shared row tracks and the existing
activity/menu lane; the title consumes the released trailing width. The badge
remains a sibling control, never a button nested in the navigation button.
Attention text may follow the badge; workspace identity remains in the row tooltip
and thread model. Missing/hidden contributions retain the default project line.
Default `trailing` placement and menu/popover exclusivity are unchanged. Products
own the content and select placement; Shell owns geometry across input modes.

## Single-line title badge placement (2026-10-21)
Thread badge contributions may select `title` for a single-line row. Shell suppresses
visible project/status metadata, keeps it in the navigation tooltip and retains
activity indicators, scheduling and the independent menu hit lane. Badge and title
are sibling controls, vertically centered; the title shrinks with ellipsis while
accessories retain intrinsic width. Default trailing and metadata layouts remain
unchanged. The real Sidebar consumer checks title-only geometry, narrow columns,
keyboard focus, menus and independent badge popovers in both input modes/themes.

## Compact title-accessory conversation rows

Single-line conversation rows with title badges use the shared sidebar title-row
height token: 36px with pointer input, at least the 44px shared touch target when
touch interaction is active. Keep participant artwork, count circles, independent
action lanes and section/list gaps at their existing sizes; compact density must
not change metadata rows or other navigation owners.


## Offscreen ordinary navigation rows

Fine-pointer, hover-capable clients may skip rendering offscreen, single-line
sidebar rows with no rendered contribution using native content visibility.
Empty optional contribution slots remain eligible. Their intrinsic block size
follows the existing minimum hit target, title line height and vertical padding;
previously measured size remains authoritative. Metadata and contribution rows
retain natural layout. Focused rows and rows with open menus retain ordinary
rendering so focus rings and overlays remain reachable. Native scrolling,
keyboard reveal, destination selection and drafts keep their existing owners.

- Shell content-plane shape is theme-owned and shared by the main reading Frame
  and RightPanel body (`data-app-shell-content-plane`). Toolbars stay outside;
  overflow clips child pixels and hits to that same shape. Active tab kind,
  maximizing or revealing a tool must not replace the plane with a square one,
  nor feed presentation shape into the tool's layout viewport or lifetime.


## Touch navigation glass groups

Touch Newera conversation chrome uses a leading circular sidebar control and one
trailing capsule for the existing conversation menu and preview action. The two
trailing targets remain independent, with no divider or nested glass. Other
routes/densities keep their existing presentation. Shell owns placement and safe
areas; the design system owns LiquidGlassBackdrop, semantic material tokens and
opaque accessibility fallbacks. A supported live backdrop lens uses a small
geometry-dependent map updated on resize; it never captures content or runs a
scroll/frame loop. Unsupported lens engines retain tint, softened transmission
and soft surface highlights. Navigation glass keeps softened directional edge
light/shade and a short neutral contact shadow, without a uniform perimeter
stroke or broad oval halo. Forced colors replaces the decoration with a system
boundary. Icons, focus rings and portalled menus are unfiltered.

- Navigation glass optics consume the live compositor backdrop: rounded-surface refraction, center scattering and local detail adaptation update with content frames. The geometry texture contains only normals/offsets, never conversation content. No per-frame DOM capture, scroll controller, random wobble or business-state ownership is added. URL-filter limitations retain a blur fallback; no Safari optical parity is assumed.
User and assistant message footer clocks are visible at rest for touch input
through the shared coarse-pointer/no-hover/current-touch policy. Desktop pointer
clocks remain hidden at rest and reveal on existing message hover/focus. Keep
time metadata, slot geometry, history cache and action-button availability;
elapsed work duration is separate.

Edge bridge acceptance: `OPENCRAFT_GESTURE_EDGE_ONLY=1 npx tsx scripts/smoke/shell/smoke-mobile-sidebar-gesture.ts` exercises the actual ClientRuntime and AppShell: Web native gutter, Apple PWA handoff and an injected host-neutral adapter, held open/close, cancel/reversal, full 24px boundary, resize, exclusions, disposal/rebind and draft identity. Synthetic host capabilities do not establish physical iOS native gesture acceptance.


## Live directory membership

A confirmed Server directory creation becomes a Sidebar row without waiting
for title generation, opening the Thread or completion of an existing multi-page
refetch. The directory projection applies Server changes over the current
snapshot and preserves them across older in-flight reads. Later snapshots and
changes converge into the existing query cache; the view does not own another
writable directory. Background reconciliation preserves row owners, draft,
focus, menus and scrolling. `OPENCRAFT_SMOKE_CATALOG_LIVE_ONLY=1` on the existing
`smoke-sidebar-thread-catalog` consumer checks blocked-page creation, late-read
retention, removal and draft/focus in both themes.
