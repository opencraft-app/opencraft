# Workbench invariants: Composer and input

[Invariant index](../invariants.md) · [Design index](../README.md)

## Conversation model display continuity

Existing conversation model and effort labels reflect its own execution or explicit draft choice before catalog hydration. Unknown settings never become a default effort. Completed model metadata may paint the matching label within one Host runtime, but cannot seed another Thread's selectable catalog or authorize submission. Historical views do not fetch new-conversation defaults.

## Composer input action icons

The shared voice action consumes the design-system composer input icon role:
20px at regular density and 24px at touch density, including the unavailable/error
glyph. Density changes the vector canvas only; the existing centered button,
44px touch target, Composer height and dictation lifecycle retain their owners.
Home and Conversation consume the same action. Real-component verification
covers narrow/wide, light/dark/custom themes and recording transitions; browser
emulation does not establish iPhone microphone or recognition acceptance.

## Queued-message authors

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

## Queue modified-Enter shortcut

In Queue mode, Cmd/Ctrl+Enter keeps draft content first: text, attachments,
context and provisional input use the existing inverse submit action. An
unsendable draft is not empty. Only an empty ordinary draft delegates to the
visible queue head's existing Steer/Send action. It never skips an unavailable
head or bypasses Host readiness, atomic capability, reconciliation or unknown
delivery. Queue edits and dictation keep their original paths. Autorepeat and
concurrent queue actions cannot consume additional rows; late completion cannot
clear a different conversation's input. Mobile software Return remains newline.

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
| FCO-02 | 紧凑/聚焦展开、peek、最近轮次展开和显隐阶段分别派生；退出和 peek 内容不可交互 | ThreadComposerPresentation；焦点/键盘/动画回归 |
| FCO-03 | inline/overlay 共用同一 portal destination 和编辑器 DOM；草稿、附件、撤销、提交目标不随位置重建 | Stable editor host；native smoke 的 DOM identity、草稿和 WebContents identity |
| FCO-04 | 收起把手绝对定位，不增加 Composer 内容高度；唤回把手有独立 Shell 锚定宿主，背景区域不截获网页操作 | thread-workspace.scss；native pointer/hit area smoke |
| FCO-05 | 最近轮次预览不重复用户 intro；滚动只由预览视口拥有，Composer 手势排除预览内容和惯性事件 | ConversationTurn.startAfterTurnIntro、ComposerWheelSwipeController；真实组件长回复测试 |
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

The overlay PWA uses the CSS large viewport for its unoccluded document-flow
Shell. Its reported native height can exclude the status area; that difference
is paint-only capacity reserved once in the Shell row, so Composer content
remains inside the measured native visible frame. It is not a device safe inset.
SafeLayout and the existing route bottom spacing consume safe insets once.
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

- DIC-13：触控 Web 的触摸输入框长按450ms复用语音插件和现有瞬时输入事务；短点、触发前移动、已有文字选区、鼠标和能力不可用时不接管。松手完成识别并保留明确发送动作，上滑64px、系统取消、后台和卸载取消并保留原草稿。启动权限尚未完成时的松手只在实际listening后结束该代次。输入框节点和草稿身份保持；由共享交互密度提供至少44px麦克风触摸框；实际 touch 事件才可长按，屏幕宽度不限制入口，覆盖 iPad、折叠屏展开/分屏及混合指针设备。

- WSP-34：交互密度独立于窗口宽度、主题和当前 hover/focus 输入方式。共享安装偏好 `interface.touchFriendly` 为 auto/on/off，默认按 any-pointer:coarse 自动启用；手动选择持久化，恢复自动后继续跟随能力变化。Document 的 data-ui-density 投影 shared hit-target/gap token；导航、菜单、Settings、共享按钮及 Composer 复用，不能按手机宽度重判或各自硬编码触摸尺寸。窄布局与可用空间仍由 Shell/容器模型拥有。实际鼠标不能触发输入框听写；显式关闭撤销长按入口。

## Conversation selection quote (2026-10-15)

Selection-to-chat is available only in compact layout. The existing `data-ui-density` authority disables its floating action and selection listeners in touch layout, including live preference changes; native text selection/copy and desktop quote insertion remain available.

Web/Electron Conversation owns one Radix selection menu for its timeline. Selection must remain wholly inside one assistant/user chat document; sender metadata, composer, controls and cross-message ranges do not qualify. Activation revalidates the range and current composer target before insertion; scrolling, resize, Escape or navigation releases the floating surface. Markdown presentation controls are excluded and partial code selections never expand to a full block. ComposerController delegates appendQuote to the physical editor; unsupported, submitting, transient or detached Views reject it. The editor appends literal text as an undoable quote block followed by a normal paragraph, focuses its end and preserves existing draft/assets/context. Selection never submits a message. AppServer compilation uses the existing quote serialization contract.

Selection quote anchors use a Range rectangle intersecting both the conversation scroll root and browser viewport. Long selections retain their full content while positioning at the first visible selected line; wholly offscreen selections expose no action. A DOM-visible but clipped/offscreen paragraph is not a valid floating anchor.
Sidebar icon rail uses the shared frame width (60px) with centered 44px action
targets, leaving about 8px on each side including the divider. Footer actions
share the same axis. Default/minimum combined widths continue to derive from
list width plus rail width; mobile stacked navigation retains its own geometry.

## Composer attached rail
The queue and goal remain in the attached rail. The active Turn's file summary is a separate, content-width pill centered above that rail and editor, with the shared floating-summary gap, full radius, theme opaque elevated material, subtle border and low elevation. It never shares the attached rail's perimeter, tuck or mask. Long labels truncate while diff counts remain visible; narrow/floating/keyboard placements follow the actual Composer. Empty summary adds no height. Approval replacement retains the same independent summary. File review, counters, draft and queue ownership do not change. Geometry and material consume design-system tokens. `scripts/smoke/composer/smoke-composer-attached-rail.ts` covers occupancy, separation, themes, review and draft identity.


## Touch Newera composer
`chat.touchNewera` is an installation UI preference: absent a saved choice, standalone workbench defaults on and embedded workbench defaults off; only the conjunction of enabled preference and touch density selects this presentation. The existing density binding projects it to the document; components do not read storage or create a second draft. Theme-derived Newera tokens own the restrained translucent material, highlight, blur, radius and geometry, with opaque fallbacks for unsupported/reduced transparency and forced colors. The attached queue/goal rail has its own translucent material in both desktop and touch layouts, independently of Newera and editor material.
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
Newera or compact density restores standard presentation with the same draft,
selection and command owners. The backdrop sees scrolling content, with
independent attached-rail glass and opaque accessibility fallbacks.

Composer glass is a non-interactive background pseudo-element, never a filter on
an ancestor of the native editor/caret. The shell owns layout, border, shadow and
focus; material variables select ordinary/Newera and opaque accessibility fallbacks.
Scrolling or keyboard viewport updates must not rewrite the selection, recreate the
EditorView or blur/refocus it to repair painting.

Desktop Web keeps the editor opaque while touch editors use glass; queue/goal
rails use their own theme glass on both, independent of the Newera switch. The
separate live file pill uses an opaque theme elevated surface.
The footer must not put an opaque gradient between rails and scrolling content.
Desktop covers a rectangular band through the bottom safe-area gutter, starting
at the shell's lower corner arcs. Its height combines the existing safe-area
inset and shell-radius token. The straight upper edge spans the footer width;
transcript paint must not leak through the lower corner cutouts.
Touch keeps the Composer floating; transcript paint remains visible around the
shell and below it in the safe area. Neither mode paints an exterior contour.
The shell's own radius, glass, shadow and attached surfaces remain unchanged.
`scripts/smoke/composer/smoke-composer-bottom-corners.ts` compares actual exterior and gutter
pixels while changing transcript paint, including a live density switch that
preserves the same editor, draft and focus.

Entry defaults are runtime fallbacks, never startup writes. Existing valid choices
win; reset/invalid-record fallback use that entry default. Explicitly choosing the
default is still a persisted choice. Only touch density enables the presentation.

Newera触控时间线浮动回底部控件：箭头与运行点共用ScrollToBottomButton的玻璃外壳和44px圆形触控区，图形放大15%并增强笔画；沿用主题Newera材质及减少透明/强制色彩/无滤镜实底回退。两态不得改变锚点、尺寸或滚动语义；桌面与关闭Newera的呈现保持。

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

Standalone Composer opens its declared effort slider and an optional Fast lightning
checkbox at the left on first activation. Effort is centered above the full model name, which opens a compact model list
without capability details. The Composer shows enabled Fast beside the model name.
High frequency depth changes do not traverse a model list. Presentation never
adds unsupported speed/effort choices, remounts the editor or writes a default
by opening. The shared slider capsule variant retains Radix gesture/keyboard
ownership and previews effort until a completed choice. Desktop uses a compact surface with the shared slider metrics; touch targets keep the density minimum. The right reset commits only a declared model default effort, preserving model/tier/draft and native editor selection; absent defaults disable reset. Embedded session-only
policy keeps Host-owned reasoning outside its model-only picker.

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

Both standalone and session model lists preserve catalog engine/provider groups
inside their Agent group. Identical model labels cannot erase the engine boundary;
selection continues to submit the catalog model ID and keeps native thread binding.

Pi Side Chat uses the same WSP-07/WSP-12 lifecycle and inline `/side` surface.
Its explicit ephemeralFork flag does not enable persistent Fork menus. Capability
lookup names the parent Thread, preserving mixed-engine Host boundaries. The child
holds native model context in memory only; parent tasks and queues never execute
in the child. Closing releases the child without changing parent history or drafts.


### Side chat slash command

An existing conversation’s Composer advertises `/side` alongside its Host shortcuts. Explicit submission of the standalone command invokes the same Side Chat panel action as the toolbar, with the current conversation owner and working directory. It never sends or queues model input, including during an active turn. A stale owner, unavailable action or failed fork retains the command draft and reports failure. Arguments, attachments, context and code remain ordinary prompt content. New-thread composers do not advertise a fork command.

### Inline command discovery

Composer commands are discovered directly from slash suggestions in the editor. A non-empty shortcut catalog must not introduce a command-library button or separate footer menu. Selecting a suggestion inserts editable text; explicit submission owns execution.
### Side chat model display

Side chat displays its fork’s current execution model as compact, non-interactive Composer metadata. It offers no model menu and submits no model, effort or service-tier override; the child conversation retains execution ownership. Main conversation model controls are unchanged.

Side Chat inherited metadata groups the catalog model name, known reasoning effort and actual Fast state, using compact shared typography without interactive affordances. Identifier fallback uses readable words; missing settings do not invent defaults.

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

Longing reading-plane upper-left radius and shadow geometry share the theme's content corner token. Body depth is a paint-only sibling driven directly by the same current Sidecar width, never root's saved-width CSS fallback; held resize, collapse, reversal and reduced-motion snaps preserve the visible boundary without toolbar stripes. Sticky Pinned/Recent headings consume theme-owned transparent blur over the shared sidebar material, not the opaque reading-surface fill. Keep disclosure hit/focus behavior, scroll ownership and mounted drafts.

Sticky Sidebar section labels are part of the Shell plane, not floating glass surfaces. Longing uses transparent label backgrounds with no local backdrop filter. The existing Sidebar list projects each group's actual heading/row overlap into row clipping, observing the current dock or mobile viewport without creating another scroll owner. Rows, selected backgrounds and avatars cannot tint or show through the label; retain disclosure, row identity, focus/menu portals and pagination. This replaces the earlier local-blur heading treatment only.

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

An active conversation's existing recovery or connection failure may project a
static faint red material and rim to the shared Composer. Normal streaming, idle
and new drafts stay neutral. No Composer opacity breathing, blinking or scaling.
Draft text, caret, controls and geometry remain stable. The material is paint-only:
recovery diagnostics, scan, retry and submission ownership remain independent.
Forced colors retain a system outline and the existing textual recovery notice;
reduced-motion users receive the same static warning.

## Queue admission continuity

A locally submitted follow-up paints immediately in the existing attached rail.
The same client message retains its DOM and avatar across server queue admission;
authoritative queue IDs still own actions. Superseded reads and late RPC receipts
cannot clear or resurrect that row during handoff.
The task-link action uses two interlocking rounded links in its shared semantic glyph. Toolbar, overflow and customization consume the same artwork and localized accessible name; artwork changes do not change action identity, geometry, preferences or task transactions.

## Skill candidate ownership

Skill candidates belong to the existing Thread's execution engine or the new
draft's selected model. Changing that scope invalidates visible candidates,
cached directories and pending results while retaining the mounted editor,
document and focus. Pi discovers candidates and validates selected references
through its native Skill registry. Discovery exposes metadata only.
