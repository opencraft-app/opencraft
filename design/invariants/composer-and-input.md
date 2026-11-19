# Workbench invariants: Composer and input

[Invariant index](../invariants.md) · [Design index](../README.md)

## Terminal touch selection and copy

The terminal adapts the shared ContextMenu long press to public xterm buffer-cell
selection. It does not enable native selection on virtualized renderer rows or
introduce another gesture timer. The opening touch's compatibility mousedown
cannot refocus xterm's hidden input and dismiss the menu. Existing selected ranges
are preserved when pressed inside them; wide/combined glyphs use cell coordinates.
Copy reads the xterm selection, never sends PTY input, and exposes its action in
the existing touch toolbar. TUI mouse reporting retains native contact priority.

Select text opens a shared Radix utility dialog containing a readonly native
textarea. Its public-buffer snapshot joins soft wraps and contains no ANSI bytes;
incoming output cannot replace its native range. The control's mounted lifetime
owns selection listeners, including portal-delayed mounts. Clipboard denial offers
the same native selectable text with stable feedback space. Late clipboard errors
cannot reopen a dismissed reader, replace an existing range or cross a terminal
owner. Closing the reader preserves the same live terminal and input state.
The reader and its styles load on demand as a sibling of the retained terminal,
so neither first-paint CSS nor the terminal's DOM lifetime depends on that window.

## Native touch contact retirement

A native accepted trigger click is not rejected merely because an ancestor
scrolled during the contact. Pointer cancellation, multiple contacts and native
context menus still retire activation. Native touchend/touchcancel also retire
the microphone button hold, independently of derived pointerup delivery; lifting
a short contact cannot leave a delayed recording timer armed.

## Add menu reopen continuity

The Composer Add menu remains open across transient window blur from native
attachment surfaces. Outside contacts, Escape and selected actions still dismiss
it. Close cleanup from an earlier opening must not restore trigger focus after
the menu has reopened. Shared dropdowns expose an opt-in blur policy without
blocking the window event or changing other consumers' dismissal behavior.

## Conversation model display continuity

Existing conversation model and effort labels reflect its own execution or explicit draft choice before catalog hydration. Unknown settings never become a default effort. Completed model metadata may paint the matching label within one Host runtime, but cannot seed another Thread's selectable catalog or authorize submission. Historical views do not fetch new-conversation defaults.

## Composer input action icons

The shared voice action consumes the design-system composer input icon role:
20px at both regular and touch density, including the unavailable/error
glyph. Composer footer actions use centered 20px glyphs inside 32px buttons across
input densities. Composer height and dictation lifecycle retain their owners.
Home and Conversation consume the same action. Real-component verification
covers narrow/wide, light/dark/custom themes and recording transitions; browser
emulation does not establish iPhone microphone or recognition acceptance.

## Queued-message authors

The Composer assigns independent grid rows to floating content, the attached
queue rail and the editor. Navigation occupies only the editor's trailing column;
adding a queue cannot auto-place the file-change summary beside it or reduce the
input width. Empty slots collapse without replacing the editor or its draft.

Each queue entry displays its own submitter photo in a fixed 20px slot beside
an independent drag handle, with a neutral fallback. The handle remains visible;
hover, keyboard focus and dragging never overlay the grip on the photo or fade
its contents. Pointer activation belongs only to the handle. Its compact 24px desktop target
and the coarse-pointer 44px target stay within their own column and row, without
covering the photo or message text. Warning badges remain anchored to the sender.
The shared Composer receives generic name/avatar URL values resolved by the
identity contribution. Server sender, including explicit null, takes precedence
over exact-client optimistic hints. Current-account changes, edits and reorder
cannot reattribute old entries. Accessible pointer/keyboard sorting and existing
queue actions remain available.

Queue rows project Markdown through `chatDocumentPlainText` into a single-line
label. Links retain visible titles, code retains literal punctuation, and table
cells become text; the queued input remains unchanged. Activating the row preview
renders the complete source with `WebUserMessageDocument` inside the existing
bounded scrollport, preserving tables, lists and code. Touch, pointer and keyboard
activation must preserve the Composer draft and independent queue actions.

## Queue modified-Enter shortcut

In Queue mode, Cmd/Ctrl+Enter keeps draft content first: text, attachments,
context and provisional input use the existing inverse submit action. An
unsendable draft is not empty. Only an empty ordinary draft delegates to the
visible queue head's existing Steer/Send action. It never skips an unavailable
head or bypasses Host readiness, atomic capability, reconciliation or unknown
delivery. Queue edits and dictation keep their original paths. Autorepeat and
concurrent queue actions cannot consume additional rows; late completion cannot
clear a different conversation's input. Mobile software Return remains newline.

## Steer before queue acknowledgement

Healthy in-flight queue input accepts one immediate Steer intent. The runtime
owns that intent and waits for exact queue custody rather than disabling the
initial click or resubmitting the text. Add receipt and queue notification are
alternative confirmations; canonical client-message history is proof of prior
consumption. The operation indicator belongs to this row, leaving the next
draft editable. Editing another row, missing atomic capability, offline waiting
and unknown delivery retain their fences. Duplicate clicks join one operation;
late acknowledgements never restore already consumed input.

## Desktop input ownership

Desktop control presentation preserves the mounted control strip's geometry
while hiding and making it inert before current video/input readiness. Confirmed
ownership fades the shared action's solid decorative layer over 240ms; intent,
press feedback and reduced motion do not delay input retirement or cancel.

The mounted desktop interaction scope, confirmed backend grant and physical
gesture have separate lifetimes. Unknown mobile focusout does not prove leaving:
internal toolbar/media/editable handoff retains control; explicit outside presses
(including blank space), known outside focus, hidden page and window blur retire
it. The interaction owner never grants input or restores focus. Geometry changes
retire held input and queued samples without revoking the grant; old physical
contacts must lift before another gesture can start in the new geometry.
Managed-media native touch activation consumes a fixed Take command once on
single-finger tap release; movement, second contact, cancellation and capture
loss cancel it. It never emits a synthetic click or replays a compatibility
click. Ordinary toolbar buttons retain native click/keyboard activation.

Desktop visor shoulder masks preserve their exterior curve and world-space
origin while extending only the interior fill into the center background.
Independent raster edges must have opaque overlap, not a butt joint; moving
the entire shoulder to conceal a seam is not equivalent. Mobile and wide
container variants share this contract. Pixel regression distinguishes ordinary
rendering from simulated background-edge retraction; neither proves iOS Safari.

WSP-36 桌面输入补充：手势与坐标仅由媒体适配层一个owner写入，decoder显式关闭
原指针输出。观看缩放/平移不等于远端操作；捏合始终调整本地画面，只有确认授权
后单指点击/拖动与双指滚动才发远端输入。滚轮和触控滚动共用有界规则，双指按
同一帧采样，防止先后到达的事件造成错误分类。停止、失焦、新授权取消未消费帧、
按键和滚动；旧物理指针须抬起才可被后继授权消费。缩放后坐标从实际画面与留白
计算，不能拿Shell宽度当远端像素。手机文字入口在显式操作及确认授权下创建，
候选词不发送，确认一次发送一次；撤权销毁该DOM而非复用给下一次输入。
Take在用户激活时先取得媒体焦点而不提前启用输入；平台只读焦点归属在请求与确认
两端检查，迟到授权不得再次聚焦。文字事务短于控制授权：远端点击/拖动/粘贴前先
将焦点在Panel内交接，平台同步确认的组词先发到原目标；其余候选随原事务退休。
旧输入DOM不得在同授权下后继输入复活；交接中撤权/换代也不得发送原指针按下。
Surface消费Shell的同一逻辑active投影：隐藏立即退出模拟光标覆盖层及监听，不能
等待触屏不保证的mouseleave；隐藏中迟到光标形状只更新媒体状态，不能复活覆盖层。
本地控制光标资格复用输入授权投影与active，不另存控制开关；观看/申请中不挂载。
停止、撤权或失焦立即移除覆盖层与监听，并恢复普通鼠标；迟到形状或mouseover不得复活。
重新展开保留媒体连接但不抢焦点或恢复控制；只有新确认授权才挂载最新形状。
此规则不清除远端画面内已有的光标像素；重复启用不能清空仍有效的光标附件。
模型/真实decoder浏览器验收不等于iPhone系统键盘或原生执行器验收，详见
[桌面输入策略](../../docs/cloud-desktop-plugin.md#pointer-viewing-gestures-and-mobile-text-input)。

Confirmed coarse-pointer desktop control may expose a relative trackpad through
the mounted media capability. The pad interprets gestures only; media owns the
same pointer position/writer, bounded scroll, text handoff and backend grant.
It never duplicates a connection or resumes control. A stationary single finger
holds the left button after 300ms, then moves relative to the existing cursor;
release ends the drag. Movement reaching 8px before the deadline cancels arming.
Tap, two-finger scroll/right-click and double-tap drag stay available. The timer
is fenced by gesture lifetime, grant and geometry, including reentrant text
handoff. A second finger cancels pending arming; after a drag starts it releases
the button and quarantines contacts without another click. Cancellation fences retained
contacts, and an idle pad cannot release a direct media press. Design System
places picture, controls and neutral theme-derived touch surface in disjoint
rows, consuming Shell's existing visual viewport height when keyboards contract
it. Direct touch and fine-pointer layouts remain available. This fits the page
picture rather than moving remote OS windows; synthetic viewport coverage does
not establish iPhone system-keyboard acceptance. The panel consumes Shell's
existing Composer/latest-turn reserve once. Its trackpad must remain hittable
through the real full-width Shell, with the same editor, draft and media; an
isolated media fixture cannot establish freedom from Shell overlay occlusion.
The pad is an exclusive input surface through Shell's existing
`data-sidebar-gesture="ignore"` ancestor contract. Touches beginning on its
children cannot also acquire sidebar movement. Full-Shell native-touch coverage
checks held/released horizontal pad moves and two-finger scrolling, preserved
remote clicks and ordinary-content sidebar reveal.

Local cursor feedback aligns the decoded image hotspot with the same input
anchor used by managed touch/trackpad movement. The decoder owns hotspot
subtraction; the adapter never compensates by shifting RFB coordinates. Real
decoder tests include nonzero hotspots and shape changes, not just visibility.

## 听写输入所有权

底栏仅消费当前瞬时事务，独立呈现阶段、计时和有界音量历史；录音、重试、最终
写入与提交仍由原owner负责。采样源替换/卸载释放订阅、观察器及待绘制帧；停止
调用finish，发送交回Composer提交入口，不新增麦克风或草稿状态。

- DIC-01：听写Footer由当前Composer瞬时输入事务拥有；切换草稿、清空、物理View替换或卸载同时释放文本与呈现。旧事务不能更新新Footer。
- DIC-02：普通与听写操作互斥；普通内容保持挂载但inert/aria-hidden，不重建编辑器。Composer拥有区域几何、主题控件和提交编译，插件只提供状态/采样/完成动作。
- DIC-03：停止只写入；Enter/确认发送必须等最终文本，并核对同一草稿与View。取消、失败或失去归属不能迟到发送；重复停止复用同一完成事务。
- DIC-04：平台录音适配器唯一拥有物理录音；Mac Main拥有原生录音，Web浏览器适配器拥有MediaStream，波形只消费有界数值采样。波形不发布草稿snapshot、不二次录音，没有采样时不伪造声音。
- DIC-05：单击与150ms长按分开；长按释放完成听写，合成click不能再次开始；Escape取消。真实权限/识别与合成UI验收分别报告。
- DIC-06：听写session与识别task/片段不是同一对象。真实task ID/sequence隔离final账本，片段确认不能终止Capture；用户stop后完整收尾才交付一次。录音保留原草稿/选区且只读，partial不参与编辑或提交；失败/取消不得自动写入部分结果。Browser result index是实际身份，不以文本长度/公共前缀猜分段。
- DIC-07：dictation追加文末并同步确认真实View已应用；泛用输入默认selection。原Draft/View/contentEpoch在写入前后须一致，replace-content/目标重置/View交接令旧lease失效；false/commit-rejected禁止自动发送，不用文字非空伪装成功。
- DIC-08：Web云听写的录音、转写attempt和草稿写入分属平台、应用服务、Composer。后端验证真实WAV字节和时长；凭据不进入Renderer，所选SSH/Agent Host不拥有语音输入。捕获结束后释放麦克风，完成/取消/失去所有权/过期释放临时音频。
- DIC-09：转写失败使旧发送意图失效；显式重试复用原音频、创建新attempt，不重启麦克风、不延续旧发送。重试/失败反馈使用原Footer槽位，仍受原Draft/View/contentEpoch约束。暂停等待上游不等于云端取消或退款。
- DIC-10：语音连接复用模型配置与凭据仓库，语音默认与聊天默认独立；转写模型/密钥不得进入聊天目录与引擎投影。应用服务绑定安装级配置，SSH/Thread/Bot 选择不得改变语音所有者；旧环境密钥不得作为运行时第二真源。
- DIC-11：录音与显式重试绑定开始时的语音配置票据；转写前比较当前模型/凭据，变更时拒绝，不静默转投。配置缺失、停用或删除保留不可用选择，不隐式选择目录首项。配置页面不得自动触发计费探测。
- DIC-12：启动不等于系统授权弹窗；启动反馈只在原Footer槽位显示共享进度图标，无可见授权文案，读屏使用中性准备提示。平台确认listening后才呈现波形并计时；启动中可取消，迟到就绪不能复活旧事务。反馈不增加最短等待、不预热或常驻麦克风。

本次验收边界见 [听写整改计划](../dictation-interaction/task_plan.md)。

## Floating composer ownership

| ID | 不变量 | 责任/验证 |
|---|---|---|
| FCO-01 | Shell 的路由注册表持有显隐意图；各浏览器标签的 manual/auto-collapse 原因互不覆盖，自动策略不得改写用户手动选择 | floating-composer-state.ts；确定性状态测试、原生标签切换 |
| FCO-02 | 紧凑/聚焦展开、peek、会话历史展开和显隐阶段分别派生；退出和 peek 内容不可交互 | ThreadComposerPresentation；焦点/键盘/动画回归 |
| FCO-03 | inline/overlay 共用同一 portal destination 和编辑器 DOM；草稿、附件、撤销、提交目标不随位置重建 | Stable editor host；native smoke 的 DOM identity、草稿和 WebContents identity |
| FCO-04 | 收起把手绝对定位，不增加 Composer 内容高度；唤回把手有独立 Shell 锚定宿主，背景区域不截获网页操作 | thread-workspace.scss；native pointer/hit area smoke |
| FCO-05 | 增强聊天浮层复用完整 Conversation，按顺序呈现用户输入和各轮回复；当前可见阅读区负责历史分页。主区和浮层独立保留阅读锚点，最新轮次变化不重建浮层。滚动由各自时间线视口拥有，Composer 手势排除历史内容和惯性事件 | Conversation、ThreadComposerPresentation、ComposerWheelSwipeController；真实组件长会话、分页与收起恢复测试 |
| FCO-06 | 菜单/对话框属于 Composer 焦点边界；窗口失焦和布局迁移不误解释为用户离开；隐藏后的入口支持键盘 | focusin/focusout adapters、Radix popup recognition；native keyboard/menu checks |
| FCO-07 | 原生底边追踪由 Main 持有已登记 guest；事件按 guestId+trackingId 过滤；旧订阅清理不能撤销新的 tracking | browser-guests / ElectronBrowserSurfaceHost；真实 webview pointer smoke |

最终矩阵记录于 2026-09-14-floating-composer-replacement Task Pack。


## Mobile keyboard Composer budget

The mobile browser Composer uses the Shell's shared available extent.
Native focus pan stays an observation, not a second placement input. Queue and long editor content scroll within a
bounded stack; the action footer does not shrink or enter the editor scroll area.
Keeping the keyboard open must leave the Send hit target inside the visible
surface and permit the first touch to submit. Height changes preserve the editor
node and draft. Desktop and Native keep their own presentation rules.
Verification: `scripts/smoke/composer/smoke-composer-keyboard-viewport.ts` simulates iOS
VisualViewport with queue/long text, offsets, light/dark and keyboard dismissal;
physical iPhone/in-app keyboard verification remains a separate surface.

The Web viewport port is the only writer of the Shell viewport projection.
Native geometry events start a bounded one-second reconciliation window on mobile
browser hosts; unchanged samples neither publish a new snapshot nor rewrite CSS.
This covers a native transition finishing after its last event. Page restoration,
foregrounding, orientation and the next touch invalidate the same projection.
Hidden/disposed ports stop sampling, and desktop hosts retain event-driven reads.
Actual VisualViewport geometry remains authoritative even without editor focus:
blur never implies a closed keyboard, and recovery never forces layout height,
scroll, focus, selection or editor replacement. A browser reporting incorrect
native geometry still requires device evidence; synthetic timing is not physical
iOS/in-app verification.

The installed overlay PWA keeps its document-flow canvas at CSS `100vh` while
unoccluded. Status-excluded window/layout/VisualViewport readings do not reduce
that resting canvas; actual contraction consumes the existing available capacity
until native recovery, including after blur. No layout/visual difference becomes
additional Composer padding or a second canvas-height owner. Existing touch
conversation reading may extend through the Shell's allocated bottom edge while
the Composer overlay anchor stays inside its original protected rectangle. The
inline footer carries the same allocation as scrollable end spacing, keeping the
Composer above the Home indicator. Body-level browser portals keep measuring the
protected anchor; no independent device-inset lookup is added.
Shell SafeLayout consumes the main content bottom inset once. Existing, draft
and overlay Composer paths keep ordinary spacing inside that protected frame;
body-level browser portals measure the same Shell anchor. They do not claim
`safe-area-inset-bottom` independently.
The existing viewport owner publishes geometric contraction separately from
editable keyboard inference. A reduced visual viewport stays authoritative
through blur, theme changes and navigation. Document frames consume page-origin
coordinates; fixed overlays consume the existing measured fixed-reference basis.
Do not apply fixed-plane compensation to a document-flow surface or force-reset
window scroll to hide the mismatch. Preserve drafts, editor DOM and selection.

The Web viewport port is the only writer of the Shell viewport projection.
The browser owns native coordinate movement; the application owns layout capacity.
The shared snapshot retains raw visual offsets, sizes and focus observations.
`projectTimelineViewportLayout` derives an available extent, independently of
pageTop, document scroll and focus. Pinch magnification does not reflow layout.
The Web adapter measures a zero-inset fixed reference outside the Shell. The
reference never consumes application viewport CSS or participates in input. Its
client rectangle supplies the native fixed coordinate basis, separately from the
reported visual offset. The visible client origin is visual page position minus
window scroll; CSS placement is that origin minus the fixed reference origin.
This is a coordinate conversion, not an additive page-scroll correction or
feedback from the already-positioned Shell. Native reference changes invalidate
the shared projection even when raw VisualViewport values remain unchanged.

The Web port commits available capacity before measuring the independent fixed
reference: resizing a focused containing block can itself change the browser's
native coordinate plane. Origin projection and subscriber publication belong to
that same layout commit. Mobile native viewport events reconcile synchronously
before returning to browser paint, with the existing bounded rAF reconciliation
reserved for later native updates; they must not defer a known invalid origin to
the next animation frame. Unchanged CSS and data attributes are not rewritten.

Layout capacity comes from document client size and visual size; innerHeight may
already be visually reduced in WKWebView. Layout containment keeps internal
fixed descendants in the same frame without reapplying the conversion.
No Shell-rectangle feedback, per-feature compensation, forced scrolling or
focus/selection reset. Height-first/pan-later and reverse ordering must preserve
screen placement, not a constant CSS top. Bounded late reconciliation
belongs to this same owner; it does not infer keyboard completion from blur.
Browser-frame trajectories and physical iOS/WeChat keyboard acceptance are
separate evidence: endpoint reachability is insufficient to verify transitions.
Composer primary buttons preserve editor focus by cancelling mouse down only.
Cancelling touch pointerdown can suppress WebKit click synthesis, so it cannot
be used as a focus-retention mechanism for Send or Stop. Activation stays on click
for pointer, keyboard and assistive input; do not submit on touchstart.

Mobile new-thread pages use the same bottom input anchor as existing threads;
the welcome region owns flexible spare space, but its title stays at a stable
block-start inset below navigation. Focus expansion, model/tool content and
keyboard resize cannot recenter this title. The region clips before competing
with input capacity on short screens. Desktop retains the centered content group.
Keyboard changes cannot recenter the mobile input. The action region retains its controls. The route publishes its actual size-container capacity minus
its own block insets to the shared Composer budget; editor/preview content yields
before actions. Optional heading gaps are shrinkable space, not padding that
continues consuming a minimum after the heading collapses. No height breakpoint exchanges fractional grid rows,
negative margins and auto rows while the keyboard animates. A continuous change
of available height must produce continuous input placement while controls remain
reachable, including both sides of the former 540px threshold.
The outer mobile Composer stack owns one available-height budget. Its queue,
attachment preview and editor use intrinsic content caps and yield inside that
budget, never independent percentages of the viewport. Header, error actions and
the footer retain their intrinsic size. Input wrappers clip; editor content owns
native text scrolling. Diagnostics consume the Web port's post-commit observation
callback, including unchanged frames, without separate listeners or animation
frames. Observation cannot prolong reconciliation. The one-second grace remains
an explicit compatibility limit; stable early frames do not prove native motion
has completed. Removing it requires late-update and missing-final-event evidence
from affected hosts, separate from controlled browser trajectories.
Native geometry events start a bounded one-second reconciliation window on mobile
browser hosts; unchanged samples neither publish a new snapshot nor rewrite CSS.
This covers a native transition finishing after its last event. Page restoration,
foregrounding, orientation and the next touch invalidate the same projection.
Hidden/disposed ports stop sampling, and desktop hosts retain event-driven reads.
Actual VisualViewport geometry remains authoritative even without editor focus:
blur never implies a closed keyboard, and recovery never forces layout height,
scroll, focus, selection or editor replacement. A browser reporting incorrect
native geometry still requires device evidence; synthetic timing is not physical
iOS/in-app verification.

Full-width Terminal consumes two separate geometry owners: the Shell follows the
VisualViewport once; the Composer publishes its measured bottom occlusion,
including bottom padding and the visible latest-turn card, to the Shell anchor.
Terminal's inset consumes that reserve and its existing FitAddon/ResizeObserver
updates the PTY grid. Ordinary-tool overlays are absolute children of the Shell
anchor, so pan/focus and changes of containing-block origin move them with the
same viewport without copying client rects into another body-fixed viewport.
Browser overlays retain their separate body-level plane above native/iframe
guests; this exception does not give Terminal a second viewport owner.
Shell/document structural frames and Terminal's frame/inset/host use non-scrolling
clips, not hidden scrollports. A native focus reveal must not change their
scrollTop. Only the timeline, Composer text/preview and xterm viewport own content
scrolling. In particular, shrinking xterm can leave its invisible IME textarea at
an old row until the next cursor update; revealing that node cannot scroll the
application frame. Do not repair this by scrolling the window in a loop,
refocusing, clearing selection or remounting either editor. Expanded latest-turn content scrolls within the remaining
tool budget instead of taking layout-viewport `vh` space behind the keyboard.
A very short touch tool container hides optional turn history and limits the same
scrollable editor to one line, retaining its controls; more space restores it.
Inline presentation releases the reserve; editor, draft and terminal identities
survive all geometry changes. Browser floating presentation retains zero reserve.
Touch Terminal uses a lighter theme-derived glass; opaque accessibility fallbacks
retain priority. A docked keyboard uses a small gap, while keyboard dismissal
restores the Home-indicator inset. iPad desktop UA with touch is still iOS;
hardware/floating keyboards that do not shrink the viewport do not create a fake
full-width inset, and pinch zoom is not classified as a software keyboard.
`scripts/smoke/shell/smoke-terminal-keyboard.ts` exercises real Shell/RightPanel/Terminal and
Composer components with Terminal → Composer focus reveal, shrink/pure-pan/
dismissal, scroll ownership, a shifted fixed-containing-block origin and a hidden
scrollport negative control. The origin shift is an adversarial coordinate test,
not a native keyboard simulation; this cannot prove native
floating-keyboard occlusion when the browser supplies no rectangle.

- DIC-13：输入框仅用于文字编辑；触摸短点、重复点击和长按都不得启动语音，保留浏览器原生聚焦、光标、选区及上下文菜单。语音仅由专用麦克风按钮显式启动，沿用单击/150ms长按、松手完成、取消、权限竞态与草稿连续性契约。共享交互密度提供至少44px麦克风触摸框。 Composer scoped contact owner协调菜单与麦克风；取消、卸载和原生接触结束须释放自己的接触，不能阻断下一次操作。

- WSP-34：交互密度独立于窗口宽度、主题和当前 hover/focus 输入方式。共享安装偏好 `interface.touchFriendly` 为唯一“触控体验”偏好，SettingsSegmented提供 auto/on/off（自动/开启/关闭），默认按 any-pointer:coarse 自动启用；手动选择持久化，恢复自动后继续跟随能力变化。Document 的 data-ui-density 同时投影 shared hit-target/gap token、触控输入框、浮动顶栏与窄屏浏览布局；导航、菜单、Settings、共享按钮及 Composer 复用，不能按手机宽度重判或各自硬编码触摸尺寸。窄布局与可用空间仍由 Shell/容器模型拥有。输入框不提供听写手势，触控体验偏好仅影响共享呈现和命中区域。

## Conversation selection quote (2026-10-15)

Selection-to-chat is available only in compact layout. The existing `data-ui-density` authority disables its floating action and selection listeners in touch layout, including live preference changes; native text selection/copy and desktop quote insertion remain available.

Web/Electron Conversation owns one Radix selection menu for its timeline. Selection must remain wholly inside one assistant/user chat document; sender metadata, composer, controls and cross-message ranges do not qualify. Activation revalidates the range and current composer target before insertion; scrolling, resize, Escape or navigation releases the floating surface. Markdown presentation controls are excluded and partial code selections never expand to a full block. ComposerController delegates appendQuote to the physical editor; unsupported, submitting, transient or detached Views reject it. The editor appends literal text as an undoable quote block followed by a normal paragraph, focuses its end and preserves existing draft/assets/context. Selection never submits a message. AppServer compilation uses the existing quote serialization contract.

A submitted user message retains the quote boundary from its immutable document:
sending, acknowledged and reopened history all use the user-message quote rail.
The following request is a separate paragraph outside that quote. New-thread
pending presentation and existing-thread optimistic presentation share the same
core text projection. Plain queue previews and search remain flattened; quote
insertion availability and selection ownership do not change.

Selection quote anchors use a Range rectangle intersecting both the conversation scroll root and browser viewport. Long selections retain their full content while positioning at the first visible selected line; wholly offscreen selections expose no action. A DOM-visible but clipped/offscreen paragraph is not a valid floating anchor.
Sidebar icon rail uses the shared frame width (60px) with centered 44px action
targets, leaving about 8px on each side including the divider. Footer actions
share the same axis. Default/minimum combined widths continue to derive from
list width plus rail width; mobile stacked navigation retains its own geometry.

## Composer attached rail
The queue and goal remain in the attached rail. The active Turn's file summary is a separate, content-width pill centered above that rail and editor, with the shared floating-summary gap, full radius, theme opaque elevated material, subtle border and low elevation. It never shares the attached rail's perimeter, tuck or mask. Long labels truncate while diff counts remain visible; narrow/floating/keyboard placements follow the actual Composer. Empty summary adds no height. Approval replacement retains the same independent summary. File review, counters, draft and queue ownership do not change. Geometry and material consume design-system tokens. `scripts/smoke/composer/smoke-composer-attached-rail.ts` covers occupancy, separation, themes, review and draft identity.


## Touch Newera composer
The installation's single `interface.touchFriendly` preference owns touch interaction
and the Newera visual presentation together. Settings exposes Automatic / On / Off
through the shared segmented control in Appearance; Chat has no independent toggle.
Standalone and embedded entries both default to Automatic, and stored touch choices
retain their original value. Retired `chat.touchNewera` records remain untouched in
storage and are ignored; a separate large-target/ordinary-style mode no longer exists.
Only `data-ui-density` is projected. Components do not read storage or create a second
draft. Theme-derived Newera tokens own the translucent material, highlight, blur,
radius and geometry, with opaque fallbacks for unsupported/reduced transparency and
forced colors. The attached queue/goal rail keeps its independent translucent material.

An empty editing draft with no attachments, transient text or suggestions stays
one line through editor focus, autofocus, toolbar and portaled menu focus. Focus
is input ownership, not a layout expansion signal. Actual draft content,
attachments, suggestions and active submission workflows select the full layout.
Clearing content returns to the single row even while focused. There is no
separate editing-session state, focus-height animation or manual expansion toggle.
Dictation from an empty draft replaces the same single row during preparation,
listening, transcription and retry. Reserving a provisional selection does not
focus the editor; cancel restores its activation entrance and final text focuses
the same editable view. Grid presentation never reparents/remounts the editor or
command controls. Footer measurement supports display:contents using the existing
shell; circular touch targets remain 44px with clipped hit regions. Disabling
the touch experience restores standard presentation with the same draft,
selection and command owners. The backdrop sees scrolling content, with
independent attached-rail glass and opaque accessibility fallbacks.

Composer glass is a non-interactive background pseudo-element, never a filter on
an ancestor of the native editor/caret. The shell owns layout, border, shadow and
focus; material variables select ordinary/Newera and opaque accessibility fallbacks.
Scrolling or keyboard viewport updates must not rewrite the selection, recreate the
EditorView or blur/refocus it to repair painting.
The material occupies the shell background plane; editable rows and command boxes
have explicit foreground ordering. A compact `display:contents` footer has no
painted box: its actual child boxes retain that ordering. Positioned suggestions,
voice and recovery decorations keep their existing geometry and overlay owners.
Native transcript selection does not hide, remount or refocus the Composer.
The selection-paint smoke checks actual input/command pixels and selection/draft
continuity across projected viewport transitions; this is not a physical iOS
callout/compositor reproduction.

The Composer is a substantially filled editing surface, including touch and
frosted themes: `--color-background-composer-filled` has its own opacity role and
`--blur-composer-surface` is a small background-only blur. It must not inherit the
general glass-panel veil/filter, which is intended for less text-critical chrome.
Ordinary desktop themes remain opaque. Reduced transparency, unsupported backdrop
filters and forced colors retain the existing opaque fallbacks. Queue/goal rails
keep their independent themed surface; a live file pill stays opaque.

Neither pointer nor touch presentation fades, clips or covers the whole reading
viewport at the editor's top edge. Transcript paint continues above the editor,
around its upper rounded corners and through the inline gutters above its lower
arc. At the editor's lower arc, transcript paint stops: neither lower corners nor
the dock/safe-area strip below the editor may expose another line of transcript.
The existing viewport/footer observation projects `--thread-reading-bottom-inset`
from the actual editor bottom and computed lower radius, not from floating pills
or attached rails. A bottom-only geometric clip preserves physical native
scrollbar gutters; it never paints a page-colored cover or fades the upper edge.
The shell and its radius-inheriting material-only pseudo-element own the actual
rounded contour. No exterior white slabs, opaque gradients or compensating alpha
masks manufacture corners. A plain reading-plane stacking context keeps transcript
controls below the dock without filtering or masking that text.

The existing footer observation still publishes
`--thread-composer-occlusion-height` from `[data-composer-occlusion-surface]` and
`--thread-footer-height` reserves the complete dock. A floating file/status pill
changes only that reservation; an attached queue can change the physical dock
surface. Neither manufactures a full-width reading fade. The shared shell radius,
draft/selection, scrollbar insets, rail attachment geometry and existing shadows
remain stable; editable text and command layers stay outside every filter.
`scripts/smoke/composer/smoke-composer-bottom-corners.ts` checks actual exterior,
upper-corner, filled-interior and quiet lower-corner/below-editor pixels under
changing transcript paint.
The reading-material fixture also covers main/side chat, themes, pointer/touch,
queue/files and draft/focus continuity; selection-paint covers native input and
command pixels without remounting the editor.

Entry defaults are runtime fallbacks, never startup writes. Existing valid choices
win; reset/invalid-record fallback use that entry default. Explicitly choosing the
default is still a persisted choice. Only touch density enables the presentation.

Newera触控时间线浮动回底部控件：箭头与运行点共用ScrollToBottomButton的玻璃外壳和44px圆形触控区，图形放大15%并增强笔画；沿用主题Newera材质及减少透明/强制色彩/无滤镜实底回退。两态不得改变锚点、尺寸或滚动语义；紧凑布局与关闭触控体验时保留普通呈现。

Composer四角保持对称，共用shell radius token（普通16px/Newera28px）；附属rail以同半径互补圆弧mask适配shell肩部。结构tuck等于radius且padding/负margin相消，材料扣除shell范围，仅1px边界覆盖；不得压平shell上圆角或用整块双层玻璃掩盖接缝。验收包含实际像素覆盖、四角相等和编辑器/内容间距不变。

### Reasoning effort discrete slider

The first Composer picker layer projects only the selected model's declared, ordered
reasoning choices through the shared Web DiscreteSlider. Track/round thumb/ticks,
readout and endpoints consume shared geometry, typography and theme tokens.
Held drag changes preview only; release commits through existing selection and
remember-default actions. Escape/outside closes the existing menu, not each step.
Touch editing keeps its focus lease and native selection; keyboard adjustment is
Radix-owned and must not become menu navigation. No choices hides, one disables,
and an unset value remains explicitly unset until chosen.
The model title opens configuration; its optional Speed row projects serviceTiers
from the model catalog. A Standard choice sends null to clear Fast, including
queued/reloaded messages. Unsupported models hide Speed and clear incompatible
tiers; speed and reasoning never substitute for each other.

## Common workbench keyboard commands

The Web/Electron renderer uses `workbench-shortcuts.ts` as the binding metadata
and input-admission owner. Mod is Command on Apple platforms and Control on
Windows/Linux. Mod+Shift+O creates a new draft through existing navigation;
Mod+K only opens conversation search, including from the composer, and never
also navigates home. Mod+, opens settings; Mod+\\ toggles the sidebar (Mod+B
remains an alias); Mod+J toggles the existing right tool panel (Mod+Shift+I
remains an alias); Mod+Shift+C focuses the current conversation composer.
Settings → Keyboard shortcuts displays the shared binding list inside Settings;
the primary sidebar has no standalone shortcuts action. Mod+/ opens the existing
ModalSurface with the same list. Hints and accessible key metadata consume the same map.
No command is dispatched for repeats, composition/229, already handled events,
wrong/extra modifiers, or while a dialog/menu/listbox, terminal or cloud desktop
owns input, except search can reassert its own open dialog without losing the query. Commands only consume events when the corresponding surface is
available; actions keep their existing router, draft and panel ownership.


### First-submit presentation continuity

PendingConversationPage renders the immutable submitted input with UserMessageBlock and the normal thread viewport, width and top inset. It must not maintain an independent bubble surface, font scale or geometry. All submitted attachment names remain visible, including attachment-only input. Loading/failure/retry stays in the conversation, without redisplaying the submitted Draft or making any new identity fetch; a current account is never substituted for a message-author snapshot. Thread creation, receipt ownership and retry/promotion semantics remain unchanged. Real component coverage: `scripts/smoke/conversation/smoke-pending-conversation.ts`.

### First-submit Thread handoff

The first-send queue rail omits only the exact client message already painted by the visible transient handoff or live transcript; failed/unknown/paused or operating entries remain actionable, and other follow-ups are never suppressed by text equality. This projection does not mutate or dispatch the execution queue.

A successful creation receipt retains the immutable submitted message in the existing account-scoped display continuity service before Draft promotion. The handoff is synchronous, memory-only, bounded to 64 Threads and keyed by Host/Thread. Pending presentation and the retained message share submittedMessageDisplay. A newly mounted Thread keeps this paint-only message through an empty authoritative baseline until a canonical user message arrives, without a cold-history spinner or an extra syncing notice. Real recovery errors remain visible. Old cold Threads still use normal recovery presentation. Account changes replace the service and discard all transient handoffs. Preview data never authorizes commands, acknowledges reads, restores Replica cursors or persists unconfirmed input; Resume/Replica and first-Turn retry ownership remain unchanged.

### Explicit session model selection

- `user`, `host-default` and `session` are declared composition policies, not product-name checks.
- A session without an explicit model inherits the current Host default for creation and its existing model for continuation; choosing a model never writes deployment defaults.
- Product directory reads stay behind the model projection port. Ordinary sends do not depend on those reads; explicit sends use cached advisory data and the Host authorizes execution.
- Session menus retain cached labels, provider groups, backup badges, retry/empty states and the product-supplied configuration action without presenting a reasoning control.
- A Composer with machine/workspace context chrome uses stacked context, input and footer rows, including when empty. Model and permission controls remain in the measured footer; they never borrow an absolute slot from the context row. Empty composers without context chrome retain their existing inline touch presentation. Layout changes preserve the editor, selection state and menus.


### Authorized desktop Composer entry

The command-adjacent desktop entry invokes the existing filtered Panel action for
the current Conversation. No adapter or resolved target means no entry. Preview-only
embedded layouts may retain a desktop renderer without exposing file-tree management;
showing the entry never grants viewing or input authority.

## Product composer desktop entry

An installed desktop panel adapter does not imply a composer shortcut. Only an explicit containing-product presentation opts into that entry; adapter availability and launch authority remain mandatory. Full and generic embedded presentations leave it disabled.


## Composer model/depth hierarchy

Automatic native-Agent setup belongs to the conversation route. Opening Settings,
website management or an extension view does not show the initial setup gate or
mark setup as completed. Returning to the conversation retains pending setup;
an explicitly opened connection sheet may still be presented from model settings.

Standalone Composer opens one model browser. A new thread's first open shows
source tabs, search and a bounded model list. Choosing a model with declared
reasoning moves to the shared DiscreteSlider; later opens and existing threads
start there, and the model title returns to the tabs. Models without declared
reasoning stay on the list. Optional Fast stays on the slider when declared. Source browsing and search are local presentation state; neither
changes the active Host, model, draft or remembered defaults. Selecting a model
commits through the existing Composer/Host owner. Same-named models on different
Hosts/providers stay distinct. Long catalogs scroll inside their list while
source, search and related controls remain reachable; reduced motion preserves
all choices without depending on an animation.

Codex ACP's explicitly advertised `codex:<model>[<effort>]` catalog entries may
be presented as one family with separate effort choices. Each choice still
submits the exact advertised concrete model ID, without adding an unsupported
`effort` override. Names alone never infer capabilities for API or other Agent
models. Native reasoning and speed controls consume their declared catalog
capabilities. Switching model families retains a supported existing variant,
then uses an advertised default or the first advertised option. Opening the menu
never writes a choice. Session-only policy keeps Host-owned reasoning outside its
model-only picker.

The ACP adapter resolves a combined advertised model ID against the peer's
actual model options and submits the base model and native reasoning configuration
separately. Config-only replies retain the peer's full concrete model catalog.
Fast is published per model only after the peer declares its native speed option;
the selected on/off value is applied before input is accepted. Dedicated discovery
sessions may inspect those options without changing a user's conversation or
sending inference. Start/resume replies carry the adapter's real provider, working
directory and configured permission projection so the ordinary client resume path
does not depend on missing metadata.

Cursor negotiates its parameterized model picker at ACP initialization and uses
the peer's base model configuration as the catalog authority. Per-model
`thought_level` options supply reasoning choices; a native `fast` true/false
option supplies Fast. Model, reasoning and speed are applied separately before
input, preserving other native model parameters. Earlier parameterized model
IDs are restored only against options declared by the current peer. A live base
catalog replaces persisted variant catalogs without discarding old sessions.
Cursor's process-global model manager requires a conversation-owned transport;
discovery and other conversations cannot overwrite its active parameters.

Catalog failures retain cached choices, show localized task guidance and a scoped
retry, and never expose raw process errors or private paths. Retrying retains the
menu and draft. Empty catalogs and zero search results have distinct feedback.
Model configuration delegates to the existing Settings owner. Mouse, touch and
keyboard share the same model selection semantics. The auxiliary focus owner
retains the native editor selection on touch choice; explicitly focusing search
releases that editor focus lease. The editor itself is never remounted.

## Touch Composer content geometry

An empty idle auto-single-line touch Composer is one vertically centered row,
with no model entrance. An enabled Fast tier remains a compact status icon.
Entering the editor starts its local editing presentation and reveals the normal
model/depth/Fast footer before typing. Toolbar and owned portal focus retain the
session; focus leaving both ends it after menu close cleanup. Clearing while
editing stays expanded; clearing and leaving restores the idle row. Attachments
and editing use content-sized input with a one-line minimum, never flex-grown
blank space. The same editor and native Selection survive all transitions.

Vertical row alignment never centers the editor's inline text. The empty native
caret and placeholder share the paragraph's logical start; typing and deleting
the final character (also with the keyboard raised) must restore that origin
without replacing the editor, moving Selection or drawing a substitute caret.


### Engine identity in model selection

New-conversation menus use the Host's explicit `agentId/agentLabel` model metadata
for icon-only Agent tabs with accessible names and a visible selected-Agent label,
followed by only that Agent's models. Model vendor groups and
model-name suffixes cannot establish Agent identity. Older Hosts without metadata
retain one Host-level group. Selecting a tab browses; choosing a model commits the
catalog ID. The editor and native selection survive both operations; pointer-opened
model menus return to the existing editor on dismissal, while keyboard opening keeps
normal menu/trigger focus and navigating to another surface revokes the return.

`chat.agentAvailability` filters only new conversations, with the same scoped
preference consumed by Chat settings and onboarding. The new-draft menu applies
the active settings host's switches to every host's models, so an agent turned
off there cannot be chosen from another host. All-off is valid and offers
Manage agents; a populated model list does not repeat that action. A host-level
catalog is omitted when an Agent tab already uses that same product name.
Unavailable selections disable both the send button and submission.
Existing conversations retain their engine and unfiltered model catalog. See the
[Agent picker design](../agent-picker.md) for authority, onboarding and empty states.

Pi Side Chat uses the same WSP-07/WSP-12 lifecycle and inline `/side` surface.
Its explicit ephemeralFork flag does not enable persistent Fork menus. Capability
lookup names the parent Thread, preserving mixed-engine Host boundaries. The child
holds native model context in memory only; parent tasks and queues never execute
in the child. Closing releases the child without changing parent history or drafts.


### Side chat slash command

An existing conversation’s Composer advertises `/side` alongside its Host shortcuts. Selecting the standalone `/side` suggestion with Enter or a pointer immediately invokes the same Side Chat panel action as the toolbar, with the current conversation owner and working directory. It never sends or queues model input, including during an active turn. A stale owner, unavailable action or failed fork retains the command draft and reports failure. Arguments, attachments, context and code remain ordinary prompt content. New-thread composers do not advertise a fork command.

Side chats are owned conversations, not ordinary catalog entries. The ordinary sidebar
and conversation picker exclude known side-chat bindings, including retained close
tombstones, while independent forks remain visible regardless of title or native
fork provenance. Parent/child identity includes the Host; filtering never deletes
native resources or grants access. Acknowledged children are classified while their
boundary is being installed. Recovering catalog ownership does not start or resume
the child engine. See the platform [lifecycle contract](../../docs/architecture/platform/lifecycle-and-resources.md#thread-lifecycle-ownership).

### Inline command discovery

Composer commands are discovered directly from slash suggestions in the editor. A non-empty shortcut catalog must not introduce a command-library button or separate footer menu. Selecting a suggestion inserts editable text by default; explicit submission owns execution. The local `/side` action opts into immediate submission on selection when it is the entire draft without attachments or context. It consumes the command before the asynchronous action starts, without ever inserting a pending command token. Failure restores the command only to the same unmodified draft. It opens the side chat directly without a second Send gesture; other commands retain editable insertion.
Opening or activating a visible Side Chat panel transfers input focus to its Composer after mount. Inactive, hidden or disposed panels cannot claim focus. Parent submission cleanup respects focus already transferred to another surface; fork failure retains the parent draft and its retry focus.

### Side chat model display

Side chat displays its fork’s current execution model as compact, non-interactive Composer metadata. It offers no model menu and submits no model, effort or service-tier override; the child conversation retains execution ownership. Main conversation model controls are unchanged.

Side Chat inherited metadata groups the catalog model name, known reasoning effort and actual Fast state, using compact shared typography without interactive affordances. Identifier fallback uses readable words; missing settings do not invent defaults.

Side Chat also consumes the main conversation's `WorkbenchComposer` capability wiring, with its own controller and lease. In a touch full-width scene its Conversation footer owns the only input row and tab-overview entry; no generic tool dock or dock-height reservation is added. Composer styling does not imply primary-scene navigation: the side chat opens overview from its tools view. Hidden or non-authoritative side chat disables extension input and submission; no unsupported queue action is advertised. Coverage: `scripts/smoke/shell/smoke-sidechat-composer.ts` (real Shell/RightPanel/Conversation/Composer and voice action, synthetic Host/speech boundaries); physical-device validation is separate.

### Message continuity and dictation motion preference

Setup events preceding an initial user echo cannot discard its sender, attachments
or source identity. Worktree initialization alone cannot hide historical input.
Explicit steering server IDs join only earlier eligible local messages, survive
history gaps and never replace ordinary local text with enriched Host prose.
A live reduced-motion preference keeps dictation's signal static without
interrupting capture, controls or bounded sample collection; changing preference
and unmounting retain a single paint/listener owner.

Sidebar search may reuse unchanged row presentation. Parent props, grouping and action-owner/context changes must invalidate render-time readers; controlled menus, badges, locale and busy states remain live through their own subscriptions. Reuse must preserve input focus, Host/Thread identity and current capability/callback ownership; it must not cap semantic catalog membership.

Longing suppresses the conversation frame top-divider paint through the same recessed-material policy as the titlebar. Keep the frame border geometry so the theme switch preserves content position; other themes retain their strong divider color.

Longing pane and titlebar depth uses the shared diffuse prominent elevation without its hairline outline. Keep the original blur layers, geometry and existing separator suppression; other themes retain their own elevation policy.

Recessed Longing chrome paints its translucent blue once at the browser Shell root, shared by titlebar and Sidecar. Header and Sidecar do not re-composite it into rectangular tiles; the shared root highlight stays continuous. Keep native window ownership, pane geometry, toolbar apertures and mounted drafts.

Longing unified pane depth begins below the toolbar. Its paint-only Shell projection follows the existing live left slot, clips shadow above the toolbar and does not intercept input; the main surface no longer casts a vertical stripe through the titlebar. Preserve the reading plane upper lip, body diffuse depth, continuous blue chrome and mounted content.

Longing right-panel chrome consumes the same single Shell-root blue as the titlebar. Chassis layers and toolbar are transparent, divider colors are transparent without changing border geometry, and the vertical divider shadow starts below the toolbar. Panel body keeps its opaque reading surface and diffuse upper lip; tabs, resident tools, apertures, resize and controls retain their existing owners.

Longing reading-plane upper-left radius and shadow geometry share the theme's content corner token. Body depth is a paint-only sibling driven directly by the same current Sidecar width, never root's saved-width CSS fallback; held resize, collapse, reversal and reduced-motion snaps preserve the visible boundary without toolbar stripes. Sticky Pinned/Recent headings consume the theme-owned Sidebar-over-Window occlusion surface without a local blur, not the reading-surface fill. Keep disclosure hit/focus behavior, scroll ownership and mounted drafts.

Sticky Sidebar section labels use the theme-owned Sidebar-over-Window occlusion surface, not floating glass or the Chat surface. They have no local backdrop filter or per-scroll group clipping. Existing native dock/mobile scrollports and CSS sticky own the boundary. Rows, selected backgrounds and avatars cannot tint or show through the label; retain disclosure, row identity, focus/menu portals and pagination. See navigation-and-sidebar.md for the shared scroll/paint model and rendered regression coverage.

### New conversation follow-up input

After the first submit, the pending message uses the normal Conversation viewport and footer.
The follow-up Composer mounts immediately and receives focus, without waiting for Thread creation
or Resume. Sending remains disabled until a Thread lease is available. Pending-to-ready promotion
keeps the same Conversation View, physical editor, selection and follow-up document/attachments;
only its semantic target is rebound. The submitted first Turn stays immutable and retryable.
Other target switches continue to restore their own drafts. Validate with the first-submit handoff
smoke and draft-owner tests; synthetic Host evidence does not assert employee or native-device coverage.

### Personal speed defaults and conversation selections

- Fast uses the same account/Host default record as model and reasoning, including
  server CAS and scope fences. Standalone clients without account authority use
  the existing scoped installation preference; embedded policies remain unchanged.
- Missing legacy tier inherits Host policy, while null means explicit standard.
  Model/effort/speed actions snapshot the resolved combination in the draft and
  persist the default. Existing Threads use execution settings; later default
  changes cannot alter their speed or any explicitly chosen draft selection.
- The immutable submission carries the resolved tier, including null, through
  thread creation, turns and durable queues. Availability remains catalog-owned.

### Composer warning material

Continuation command failures use the Workbench's scoped non-blocking notification
owner with localized guidance. Raw RPC messages never become children of the
floating Composer region. Notifications preserve the editor, draft, focus,
selection and measured geometry, and never automatically replay an uncertain
continuation. Component coverage: `scripts/smoke/conversation/smoke-history-request-continuity.ts`.

An active conversation's existing recovery or connection failure may project a
static faint red material and rim to the shared Composer. Normal streaming, idle
and new drafts stay neutral. No Composer opacity breathing, blinking or scaling.
Draft text, caret, controls and geometry remain stable. The material is paint-only:
recovery diagnostics, scan, retry and submission ownership remain independent.
Forced colors retain a system outline and the existing textual recovery notice;
reduced-motion users receive the same static warning.

## Composer disclosure feedback

Composer disclosure feedback belongs to the shared Button owner, not each picker.
Model, permission, Host and project disclosures use the same accessory role and
rest/hover/press/open semantics. Opening keeps the trigger highlighted while the
pointer enters the menu; dismissing returns it to rest. Add, context, attachment
and dictation icon controls consume the shared icon action rather than inheriting
a feature class for geometry or paint. Menu state, focus leases, permission values,
dictation gestures and draft ownership retain their existing owners. Touch hit
targets follow the shared preference/capability projection independently of width.
Real-consumer regression: `scripts/smoke/composer/smoke-disclosure-feedback.ts`.

## Queue admission continuity

A locally submitted follow-up paints immediately in the existing attached rail.
The same client message retains its DOM and avatar across server queue admission;
authoritative queue IDs still own actions. Superseded reads and late RPC receipts
cannot clear or resurrect that row during handoff.
Queue message text is an independent native button using the existing queue
tooltip: tap/click or keyboard activation reveals the complete message and any
error detail; repeated activation, outside input and Escape dismiss it. Desktop
hover remains available. Long text wraps in a bounded native scrollport, and
opening/scrolling it never steers, edits, reorders or submits the message. The
Composer draft and queue row identity remain stable.
The task-link action uses two interlocking rounded links in its shared semantic glyph. Toolbar, overflow and customization consume the same artwork and localized accessible name; artwork changes do not change action identity, geometry, preferences or task transactions.

## Skill candidate ownership

Skill candidates belong to the existing Thread's execution engine or the new
draft's selected model. Changing that scope invalidates visible candidates,
cached directories and pending results while retaining the mounted editor,
document and focus. Pi discovers candidates and validates selected references
through its native Skill registry. Discovery exposes metadata only.


## Touch floating Composer continuity

A touch panel's floating Composer retains the shared editor and action layout
when focus leaves or the visual viewport recovers after keyboard dismissal.
Presentation mode is independent of on-demand visibility: Agent actions own
show/hide, while focus cannot select desktop compact chrome or reopen a hidden
panel. The shared Composer derives its empty idle single-line layout from its
existing draft and editing state. Pointer presentation retains compact behavior.
Viewport and focus changes preserve the editor node and draft.

A body-level floating Composer uses the Shell viewport owner's fixed-coordinate
origin plus Shell-local anchor geometry. Client rectangles must not be assigned
directly as fixed insets while the browser pans its native fixed plane. Keyboard
open capacity and pan preserve visible editor and send actions above the dock,
even when the layout viewport size remains unchanged.

## Mobile panel entry

Narrow touch conversation layouts host the Shell right-panel toggle before Add
in the Composer. Input actions use 20px glyphs within 32px buttons. Pointer
layouts and wide touch layouts retain the header entry; routes without a
Composer retain their existing entry. Opening tools and returning through
their mobile dock preserve the mounted draft and editor.

## Change summary in tools

The live changed-files summary belongs to the chat Composer. Suppress it when
the Shell presents a full-width tool panel, including the enhanced chat overlay.
Returning to chat or using a split panel restores the current summary. This
presentation change does not clear the diff resource, draft or tool session.

## Saved conversation navigation

A durable editor View is restored through the ordinary local presentation path,
never through the bootstrap-only initializer. Switching A → saved B → A keeps
each editor and unsent draft independent while readiness follows asynchronously.
A failed destination leaves the working conversation intact and reports a
nonblocking notice rather than silently closing the sidebar without feedback.

### Queue mutation authority

Queue presence is not permission to mutate an input. Hosts may project per-item
`actions` for edit, delete, start and reorder; clients retain them across refresh,
keep cancellation independent of editability, and apply them to buttons and
keyboard/programmatic commands. Hosts without this optional projection retain
the previous ordinary queue behavior. A managed item that forbids reorder also
prevents reordering the surrounding authoritative queue.

Incoming collaboration inputs remain immutable. Deletion by an authenticated
viewer invokes the collaboration cancellation owner, which checks the sender or
the receiving conversation's `execution.cancel` authority, rechecks it after
awaiting the queue receipt, and refuses already claimed or uncertain delivery.
Historical shared conversations retain their existing shared scope; owned
conversations require their owner or an explicit cancellation grant. Merely
reading a conversation grants no cancellation right. The ordinary queue store
must not bypass this protocol or cancel only its local replica.

Queue action failures use the Workbench notice owner, outside the queue layout.
The callback still rejects so an editor preserves its draft and a queue operation
can restore its row. A swallowed event-handler rejection is not user feedback.

## Queue preview row geometry

Queue rows own their compact accessory height through `height-composer-queue-row`.
The message preview is a row-sized link that stretches within that height; it
does not consume a square chrome action size. Shared chrome sizing must not
inflate the queue or its scroll budget. Drag handles, sender/image slots and
independent actions retain their geometry, while full text stays in the bounded
preview popup. Touch and compact density use the same row ownership.

## Shared image preview boundary

`chat-render-web/image-preview` owns the fullscreen image dialog, keyboard/focus,
loading/decode feedback and gallery controls; ZoomableImage retains zoom, pan,
pinch and page motion. Markdown, sent user images and IM group/assistant images
consume this same view. Callers retain image authorization, async source ownership,
URL disposal and gallery membership. Optional resolved neighbor content and action
slots do not give the viewer Host or directory access. Draft editing retains its
editor-specific lifecycle and consumes the same ZoomableImage gesture owner.

The viewer carries its own scoped styles, including in ShadowRoot hosts. Its
image gesture viewport mounts after native fullscreen admission. Page motion
transfers the painted offset to a new contact, and resynchronizes allocation
before settling after a resize; an internal animation value is not a visual receipt.

Queue identity and message content have separate spacing owners. The message
group owns separation from the sender and the smaller gap between attachment
thumbnails and text. Do not add text margins on top of the shared Button gap:
the preview Button hosts one message group in both image and text-only rows.
