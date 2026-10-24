# Browser: Remote surface and lifecycle

[Architecture index](../../browser-workbench-architecture.md) · [Documentation index](../../README.md)

## 13. Remote Browser

### 13.1 远端实例身份

```ts
export interface RemoteBrowserInstanceRef {
  readonly profileId: BrowserAuthorityProfileId;
  readonly runtimeId: BrowserAuthorityRuntimeId;
  readonly engineInstanceId: BrowserEngineInstanceId;
  readonly generation: AuthorityGeneration;
}
```

协议消息使用 Remote Instance Ref；客户端 Runtime 将其绑定到逻辑 BrowserSessionId。

### 13.2 Observer 与 Controller

```ts
export interface BrowserControlSnapshot {
  readonly instance: RemoteBrowserInstanceRef;
  readonly holderClientId: BrowserClientId | null;
  readonly controlEpoch: number;
  readonly expiresAt: number | null;
}

export interface BrowserControlLease {
  readonly instance: RemoteBrowserInstanceRef;
  readonly holderClientId: BrowserClientId;
  readonly controlEpoch: number;
  readonly expiresAt: number;
}

export interface RemoteViewportDescriptor {
  readonly viewportRevision: ViewportRevision;
  readonly widthCssPx: number;
  readonly heightCssPx: number;
  readonly deviceScaleFactor: number;
}
```

Observer 不持有 lease。所有输入携带完整 instance ref（`runtimeId + engineInstanceId +
generation`）以及 `controlEpoch + inputSeq + viewportRevision`。服务器拒绝错误 runtime/
instance、旧 generation、旧 epoch、非 holder、重复 inputSeq 和旧 viewport。

`expiresAt` 只供显示；客户端不能凭本地时钟自行授予控制权。Authority 重启必须提升
generation，controlEpoch 只要求在同一 generation 内单调。

### 13.3 实时帧是数据面

Remote frame 携带 `frameSeq` 与 viewport descriptor。图片/视频本体走独立 media/data
plane，允许丢旧帧和背压，不进入 Replica、Journal 或持久资源索引。

Remote Presenter 将本地 `SurfaceLayoutFrame` 与当前显示帧 viewport 组合：扣除
clip/letterbox 后换算到 Authority viewport CSS px。显示帧、layoutEpoch 或 Authority
generation 在 pointer down 与发送之间变化时，丢弃输入而不是猜坐标。

## Linux Server 远程网页 Surface（2026-10-21）

Headless 包内置同版本 Electron，Gateway 的 RemoteBrowserService 惰性启动独立进程；不渲染工作台 UI、不公开 CDP。支持 H.264 的客户端使用 RemoteBrowserSurfaceHost（安全上下文优先 WebCodecs，HTTP/其他客户端使用原生 MSE），现有 Tab、Page、Presentation manager、BrowserDynamicToolHost 与线程归属检查保持；普通 Web iframe 与桌面原生 guest 继续使用原适配。渲染地点固定为所连 Server，不因 Thread 的执行 Host 或 SSH Host 改变。远程网页直接访问该 Server 的网络；不把 SSH loopback 代理 URL 交给另一个执行地点。

Headless CPU rendering keeps hardware acceleration disabled and explicitly selects
ANGLE SwiftShader for software WebGL. This lets pages obtain a real WebGL context
on GPU-less servers, including mobile device detection that assumes the context
exists. Chromium requires the explicit `--enable-unsafe-swiftshader` opt-in for
this software backend; it increases the graphics implementation exposed to
untrusted pages. The dynamic browser UID, Chromium sandbox, permission defaults,
and lack of a public debugging port remain unchanged. WebGL workloads consume
server CPU and memory; this does not promise hardware-level 3D performance or
change DPR, device identity, H.264 encoding, or idle frame suppression.

远程网页跟随 Presentation 的 `viewportSize`（CSS 宽高）；responsive 模式使用内容区实时尺寸，设备尺寸预设使用其逻辑视口，不取客户端 devicePixelRatio，远端默认 DPR=1。尚无 View 时回退1280×720。`open.input.viewport` 和同连接 `viewport` 请求传宽高，尺寸归一为偶数、最小64、最长边4096，并以H.264 level 4的8192个16×16宏块（约2百万像素）限制软件渲染资源；超限按比例收缩。worker返回并先发布实际 `viewport` 配置，再输出该代关键帧；调整同一WebContents内容尺寸，不导航或重建DOM。客户端100ms合并尺寸、至多一个请求进行中及一个最新待处理，拖动期间持续更新；编码器按新尺寸重建、旧代结果失效，WebCodecs/MSE及输入坐标使用已生效尺寸。设备预设由共享BrowserViewportMode派生deviceProfile并随同几何传递；手机/平板使用worker内部私有Chromium仿真同步一致的移动UA/Client Hints（含iOS profile）、viewport meta语义、screen方向及触屏，DPR固定1。移动/触控profile将有界鼠标按下/移动/抬起串行转为Chromium真实touch序列，指针取消/捕获丢失与设备切换撤销未完成手势。桌面预设恢复桌面UA、metrics和鼠标，关闭设备栏则恢复跟随客户端；自定义调宽与旋转保留所选profile，同尺寸profile变更也必须应用。能力声明deviceEmulation=full仅表示该Chromium仿真链路，iOS标签不表示Safari/WebKit内核。首次直接以移动profile建立Page时先初始化本地about:blank renderer，再应用设备身份，之后才允许目标导航；设备切换不刷新、不重建DOM；按UA生成的服务端正文在后续导航或用户刷新时应用。worker串行化设备重配，并在导航/输入前等待已提交的设备变更，客户端不暴露任意CDP/UA/JS。软件 H.264 text hint、实时编码、Annex B；30fps 是活动上限，1.2秒后10fps，再2.8秒后2fps。静态去重不编码；非交互小更新固定150ms合并；仅一帧编码中和一帧最新待处理。全服务共享一个可信编码 renderer，各页面编码器在隐藏时释放。队列丢弃发生在编码前；编码后的预测帧保序，慢客户端断开后请求新关键帧，显示端只留最新解码帧。WebCodecs 无周期性关键帧；MSE 按缓冲回收水位请求关键帧，只在实际编码媒体积累时触发，静态不产生额外帧。鼠标形状同步，位置使用客户端系统光标。

同源 WebSocket 复用 admission、actor身份、到期和撤权；每个连接只持有 actor+随机持久化 storage lease 的页面。服务器生成物理分区 ID；Page、storage ID 与瞬时连接分离。View park 只停视频；显式 close 释放页面，保留 Cookie 分区。观看连接断开或 Application dispose 仅取消活动输入并停流，远端 Tab 不因断线计时销毁；每 owner 最多16页、全服务最多64页，不静默淘汰驻留页面。重新挂接存活 WebContents 时同步原生 URL/title/导航状态，禁止初始客户端导航覆盖原 DOM/JS。Tab、分区恢复身份、Scope/Thread 关联与工具栏元数据由同源认证的 Server 持有，客户端同步投影启动时加载，写入按 owner 版本比较拒绝旧客户端覆盖，并以同一 mutation ID 处理丢失确认；既有本地元数据只在远端全空时晋升，原本地记录保留且不作为权限凭据。恢复文件在私有目录以600权限原子替换，损坏拒绝读取而不清空。服务端进程退出保留 URL、有效尺寸/设备语义、zoom 及原隔离登录分区，下一次挂接重新加载；这与运行中重连有明确 resumed/restored 区别，不声称恢复任意 DOM/JS/表单/内存历史。明确 close/discard 删除恢复记录并释放页面，Cookie 分区仍遵循原保留策略。所有操作继续按当前 owner 校验，元数据同步不授予页面操作权限。预览桥在目标文档内运行，只暴露已有类型化操作，敏感字段拒绝及 revision/ref 校验复用原实现，语义输入不声称 trustedInput。远程手动坐标输入作用于同一目标 WebContents。

站点权限默认拒绝、下载默认阻止、popup 转为当前 scope 的受管标签。远程站点权限设置、下载管理、音频、跨后端运行中状态迁移、原生设备模拟尚未提供。登录态保留在服务端隔离分区，不发送到客户端。


### Remote tab state and viewer lifecycle

Responsive remote tabs follow the viewing client's normalized device identity:
iPhone, iPad (including desktop-style iPad UA), Android phone/tablet or a desktop
with/without touch. This does not forward arbitrary UA strings, browser brands
or physical DPR. The remote worker retains DPR=1 and uses the measured content
aperture in CSS pixels. Explicit device/desktop presets remain authoritative;
closing the device toolbar returns to following the client rather than forcing
desktop mode. A new unmeasured tab receives the bounded default identity before
its first navigation, while an existing tab keeps its stored configuration until
presentation supplies a measured layout. Device changes preserve the live DOM;
server-generated UA-dependent markup updates on later navigation/reload.

Pointer input carries its actual device type. A hybrid desktop's mouse remains
a mouse and its finger produces native touch; mobile presets still support
mouse-driven touch emulation. Pending moves cannot coalesce across pointer types.
A worker advertising `multiTouch` accepts complete active-contact snapshots with
up to ten stable IDs, bounded geometry/radii/pressure and an explicit start,
move, end or cancel phase. The viewer merges movement into one complete snapshot
per animation frame, flushes it before contact changes and captures every finger.
The ordered worker queue coalesces only adjacent moves with the same contact set;
partial release and new contacts are never coalesced. Older workers/clients retain
the single-contact mouse-emulation path.

Viewer pointer IDs are opaque local capture identities, not native protocol IDs.
Each active finger receives a free wire slot from 0 through 9; it retains that
slot until release/cancellation, and a remaining finger never changes slots when
another is lifted. This includes iOS WebKit's random unsigned 32-bit IDs, which
can exceed the private Chromium protocol's signed integer range. Reset retires
both identities together; the worker continues to reject invalid wire IDs.

The private native adapter selects Chromium's per-contact DevTools dispatcher
(`SyntheticPointerActions` disabled in this dedicated runtime). Start/end send
only changed native contacts; releasing one finger never releases/represses its
peers. This is verified on the pinned owned runtime, rather than relying on the
protocol summary's different all-contact release wording. The target renderer
receives trusted native touch and decides page scrolling, pinch zoom and custom
multi-contact behavior. Target viewport meta/touch-action and OS-reserved gestures
remain authoritative; there is no local CSS/video zoom substitute. Remote DPR
stays one even when the target's visual viewport is pinched.

Touch coordinates on the wire identify the rendered widget, after the viewer's
object-fit inverse mapping. The private CDP touch injector instead accepts CSS
coordinates and multiplies them by native page scale and browser zoom. The
worker reads native layout metrics at each ordered dispatch and divides the
widget coordinates by that scale exactly once, including mid-pinch and partial
release. Scroll/visual viewport offsets are not added: Chromium owns that
projection. Contact radii stay in widget units in this dispatcher. Empty release
and cancellation need no geometry query. There is no DOM scale inference, stale
viewer-scale cache, local predicted page zoom or public CDP command surface.

Blur, capture loss, parking, hiding, viewport/device changes, navigation and
transport detach cancel owned contacts. A late move/release or an added contact
from a retired gesture cannot recreate it. Native failure cancels the owned set
and rejects the operation; no press is retried into another document. Resize
clears local pointers without discarding the IME transaction. Native input is
validated at the worker boundary; arbitrary CDP commands are never forwarded.

Each owner-scoped remote tab supports up to 16 concurrent viewing sockets.
Modern clients opt into `open.multiView`; opening/reconnecting only attaches a
viewer and snapshots the existing native configuration. It cannot navigate an
existing document, resize it or claim input. An initial URL is accepted only
when creating a new logical tab. Bootstrap remains serialized per owner+lease.
Different owners remain isolated even when their lease strings match.

| Resource | Authority and lifetime |
| --- | --- |
| Tab, WebContents, partition, recovery checkpoint | Server; detach/park keeps the live document, explicit owner close/discard destroys the page and all viewing attachments |
| Encoded H.264 output | One encoder per tab, fanout to visible viewers; paint while any viewer is visible, suspend when none are visible |
| Socket, decoder, local geometry and keyboard candidate UI | Each viewer; a short output backlog recovers independently at a new keyframe, sustained overload disconnects only that viewer |
| Remote viewport, zoom, mouse, keys, touch and composition | Current control lease; observers scale the shared frame and cannot change remote geometry |
| DOM result, focus, selection, native editor identity | Remote renderer; private IME/context-menu/new-window events go to the current controller |
| Browser-use authority and read inspection | Existing actor/thread/tool authorization; a viewing attachment grants no additional rights |

An actual human interaction or the toolbar Control action requests an explicit
human lease. Merely joining, measuring layout, hovering, reconnecting or viewing
never requests control. Human input may take control from another client or an
Agent. Release, hide and disconnect relinquish human control; Agent writes
request a transient agent lease and release it in finally, and fail retryably
with CONTROL_BUSY while another controller owns the page. Read inspection and
capture do not acquire control. Agent operations remain semantic preview-bridge
operations with the existing sensitive-field and document-ref restrictions.

Each grant has a monotonic epoch and a private random token. The service checks
viewer membership, current authorization and token at admission. The ordered
native input queue checks the token again at dispatch; queued old input cannot
cross a completed handoff. Pressed keys/buttons, touches, context menus and IME
transactions retire before the replacement grant. Clients drop input queued
under an obsolete connection/control generation. Viewer dimensions do not
reconfigure an existing tab; only a human controller submits its chosen viewport,
after the active touch gesture finishes.

Legacy viewers retain single-socket takeover only among legacy attachments;
code 4009 still stops a displaced legacy client's retries. A legacy attachment
cannot evict modern viewers and is asked to refresh. This is same-account
multi-view support, not a cross-account sharing or collaborative-editing ACL.

A remote tab outlives its display socket. Its renderer is authoritative for page
content and editing; local presentation owns video decoding, client geometry
and system input. Disconnect suspends that viewer and releases its owned pressed
keys, buttons and touch contacts; video production continues for other viewers without navigating or destroying the page.

Managed Linux gateways running with root service management attach to a separate
DynamicUser browser owner over a private mode-0600 Unix socket. The owner holds
Electron and its bounded native stderr pipe in memory; it has no public listener,
CDP endpoint or persisted stderr. A Gateway deployment closes its viewing
connections with retryable 1012, but does not stop this owner. The next Gateway
uses a versioned handshake, adopts only native IDs already authorized by its
durable logical-tab records, and destroys orphan native pages. Owner handoff
drains previously accepted commands once, revokes all old input tokens and
pressed/composition state, and pauses video before returning native snapshots.
It never replays unknown writes or navigates an adopted document. Native DOM,
forms, scroll, history and effective viewport/zoom remain in the same process.
Immutable runtime files are retained outside release cleanup. Existing tabs
keep their pinned runtime; incompatible owner protocol is rejected without
replacing the live process. The initial migration from a pipe-owned worker
requires one replacement. Unmanaged/direct process adapters and actual owner
failure retain checkpoint recovery, which does not promise live-DOM survival.

Viewer output above 128KiB enters a bounded prediction-gap state rather than
immediately disconnecting. That viewer skips video until its output falls below
64KiB and a new keyframe arrives; control/authorization messages still flow.
Keyframe refreshes are bounded, other viewers continue the original stream,
and no stale video queue is retained. An unrecovered gap after ten seconds or
output above 4MiB closes only that connection with retryable 1013 and a two-second
close-frame drain deadline. Per-event bounded diagnostics distinguish paused,
resumed, stalled, owner detach, shutdown and numeric peer close codes without
URLs, input payloads or arbitrary native stderr.

Input/control boundaries are ordered in the worker; moves are flushed before
release and local compositions are discarded across a connection change.
Continuous touch/drag movement keeps the active paint cadence. The worker
coalesces only adjacent pointer positions that have not reached Chromium;
all merged requests settle with that dispatch. Press/release/cancel, editing,
viewport changes and modifier changes remain ordering boundaries. A dispatched
native event is never replaced, and navigation/stop retain their independent
control path. Idle paint throttling must not accumulate stale gesture input. Clients negotiate `inputAcknowledgements` at open; opted-in input receives its
result only after native dispatch, while older viewers retain quiet input. The
local ordered input queue keeps at most two input requests in flight. Unsent
adjacent positions replace each other; wheel deltas add only at the same hit
point, with the same modifiers and direction, without exceeding native bounds.
Press/release/cancel, changed contacts, wheel reversals, editing/copy/capture and
viewport operations remain ordered barriers. Pending grants use the same bounded
queue rather than a separate wheel replay array. Cancellation, document/control
replacement and detach retire unsent input; a late ACK cannot advance the new
queue generation. This bounds transport/native work rather than increasing the
server overload limit or replaying stale input. Line/page wheel units are
normalized at the local presentation; the native phased CDP wheel path remains
unchanged.
This is still final-text input, not the complete native IME bridge described
above. Multi-contact touch is an independent native input path.

Durable metadata uses the existing authenticated WebSocket admission. Browser
records and conversation aliases are scoped to the gateway owner; their IDs
never grant access. Concurrent stale metadata writes fail with STATE_CONFLICT
and require synchronization rather than silently replacing another client's
tabs. Ordinary client cleanup detaches; explicit tab close deletes its remote
recovery record. A worker restart recreates the tab from the saved URL and
configuration using its persistent partition. In-memory selection, scroll,
forms, navigation history and JavaScript heap are preserved only while that
WebContents remains alive.

### Empty remote tab recovery

The worker bootstrap `about:blank` is represented as a null recovery URL, including
when reading older checkpoints. Reopening an empty tab never sends that sentinel
through the external HTTP(S) navigation command. A restored empty document does
not suppress the viewer's pending initial target URL; a resumed or restored
nonempty remote page remains authoritative and is not navigated again. Explicit
blank navigation still uses null, and external URL restrictions remain intact.


### Navigation acceptance and loading

Remote `navigate` acknowledges Chromium accepting a validated HTTP(S) target;
it does not wait for all resources or the native loadURL Promise. Native
navigation/loading/failure events remain authoritative. A stalled subresource
must not prevent video attachment, stop, replacement navigation or reconnect.
During process recovery, the saved remote URL remains authoritative before the
first document commits; a viewer's stale initial target cannot replace it.
Metadata may register a logical tab before its first native creation. A
generation-zero reservation still consumes the first viewer's initial URL when
there is no saved recovery target; metadata presence alone must not suppress
that navigation. Once creation has started, later viewers and reconnects cannot
replace even a blank native document with their local initial URL. A saved
recovery target takes precedence over the viewer's initial URL.
The WebSocket handshake deadline ends at transport open. The separate open RPC
allows bounded worker startup and creation; timeout messages identify the
operation without exposing the target URL or page content.

The private, typed automation bridge executes against the captured native main
frame, without WebContents' global did-stop-loading gate. Native document
generation checks still reject stale results. This permits browser inspection
and interaction in a committed document while a subresource is stalled; no
client JavaScript evaluator or CDP endpoint is exposed.

Temporary network, deployment and worker transport outages keep retrying with
exponential backoff capped at five seconds; they do not exhaust a five-attempt
budget. Worker transport/startup failures and RPC deadlines carry retryable
errors. Generic clean WebSocket closure is not a logical Tab retirement. The
explicit `1000 / Browser tab closed` reason, authorization `1008`, legacy transfer
`4009` and permanent open/admission errors stop retries. The permanent error
remains visible rather than being overwritten by a generic close message.
Late retry timers belong to their connection generation. Recovery opens only the
same lease, never navigates, replays input or acquires control; an authoritative
non-loading snapshot emits loaded; the shared page runtime clears its previous
error on that successful acknowledgement, including blank tabs whose navigation
does not create a history entry. A later failure remains visible.

Native per-page renderer termination is a different boundary from a viewer
transport outage. The worker destroys that dead WebContents and retires its
ordered command epoch before emitting `renderer-gone`. The gateway invalidates
that page's native requests and input grant, closes its viewers with retryable
`1011`, and retains the logical lease, saved URL and device/zoom configuration.
Reattachment recreates only that renderer and restores its saved navigation;
other live Tabs and the Electron worker stay intact. Lost renderer memory and
unsaved edits cannot be restored, and control/input are never replayed. Queued
commands from the dead epoch cannot reach the replacement, including old
control grants. Explicit logical close still takes precedence over recovery.

A gateway request backlog uses temporary `1013`, not policy `1008`. Its cap
continues to bound outstanding work; malformed binary requests and expired
admission still stop recovery. Terminal banners distinguish rejected requests,
expired authorization and explicit close instead of hiding them behind a generic
disconnection message. Diagnostics contain owned reason enums and exit codes,
never page content, URLs or raw native stderr.

A failed open or terminally disconnected transport does not make the tab's
ready promise reusable. Explicit reload or replacement navigation establishes
a new connection generation using the same persisted storage lease and current
server admission. It retires the old transport, pending RPCs, input and media
before connecting; late old results/closures cannot clear the new connection.
Healthy reload keeps its existing transport. Policy closure does not trigger
automatic retries; an explicit retry still requires server authorization.
Explicit navigation intent has its own sequence, so synchronizing the remote
URL during reconnect cannot drop a newer user navigation or revive an older one.
When reload recreates a physical page, its recovery navigation is already the
reload operation. Do not immediately reload that new WebContents: before the
first commit this would reload about:blank and cancel the intended navigation.
Reloading a resumed live page still issues the native reload command.


### Accepted remote tab closure

Explicit close/discard belongs to the server tab owner. Native destruction,
quota release and durable catalog deletion complete independently of the
viewer's socket lifetime; a disconnected reply cannot skip that work. Concurrent
retirement shares one operation and blocks reattachment. Discard during native
creation waits for creation before retiring the resulting page, rather than
acknowledging while an orphan WebContents can still appear. Native close is
idempotent so an uncertain acknowledgement can safely be retried. Cookie
partitions retain the existing policy. Ordinary detach/park still preserves the
live document. This fix does not introduce LRU or change tab limits.

The account browser resource catalog reports load, reconnect and close failures
through the existing Workbench notification owner, using localized task messages.
A failed action retains the catalog and dialog geometry; raw native or transport
errors never become list content. Dismissing the catalog retires late feedback
without cancelling an already accepted server-side close.

### Durable close intent and acknowledgement

A remote surface sends explicit closure over an independent discard connection,
validates its matching successful result and retries lost/error replies while the
application is alive. Disposing a presentation still detaches only. Removing an
existing lease from the authenticated, revisioned storage mapping is a second
explicit close signal; server metadata acceptance persists closing work before
acknowledging, then retires native resources independently. Failed destruction
is retried and pending work resumes after server restart. A persisted owner/lease
fence also prevents an open waiting on process startup from creating a page after
its discard already succeeded. Cookie partitions and ordinary parked tabs stay
under the existing policy. This does not infer closure from absence of a viewer,
from a missing/malformed historical mapping or from a resource limit. Old orphan
records without a known close intent are not swept. A client killed before any
close signal reaches the server still has no durable offline close guarantee.

### Remote frame presentation during viewport resize

The layout owner fits and centers fixed-device previews in visualBounds. The
remote adapter then projects each received frame at that rectangle's width,
anchored at the top left, and clips overflow at the live slot. It must not
contain-fit the old frame again against a newly shortened slot: during software
keyboard animation the native viewport and H.264 epoch arrive later, and this
second fit would temporarily shrink the entire page and add horizontal gutters.
Canvas uses its received intrinsic aspect ratio; MSE video uses the same epoch's
explicit aspect ratio, including before metadata arrives. Both remain undistorted.
A growing slot can expose unpainted space until its new frame arrives; it never
stretches old pixels vertically or predicts remote layout. Real viewport changes
continue through the existing bounded resize queue without a reveal delay.

Mouse/touch positions, contact radii, local menus and IME caret positioning use
the same width-derived frame projection. The invisible keyboard receiver is
clamped to the visible container. Native page zoom remains remote authority;
this is frame presentation, not an additional page-scale or DPR transformation.
Fixed-device preview padding and outer centering remain layout-owned.

### First-frame handoff within a remote page

A viewport notification updates the native input/decoder dimensions, not the
currently displayed bitmap. Canvas dimensions change only in the same render
task that draws the first complete replacement frame. Reset cancels queued
frames and retires their decoder identity; old callbacks cannot repaint a newer
epoch. Real native resizing continues while the last readable picture is held.

The MSE path copies its currently presented video into the existing canvas once
before disposing the old media source. An incoming video stays transparent above
the canvas until requestVideoFrameCallback confirms its first presented frame;
then the current video identity is checked, the canvas cover is updated and the
video is revealed. Older browsers use readable data, completed seek and one RAF
as the fallback fence. Cancelling a replacement removes callbacks/listeners.
An unready video never replaces the existing cover during a second reset.
Temporary snapshot storage is released immediately; a failed video read leaves
the earlier readable cover intact. There is no retained second decoder, permanent
video-to-canvas copy loop, frame-rate increase or new idle polling. Recovery
uses the same handoff; closing a page releases media and callback ownership.

This avoids the decoder-reset white interval, not legitimate white webpage
content or the new area exposed when a viewport grows. The held picture can be
stale until the remote page paints again; no local layout prediction is applied.

### Browser process transport failure isolation

The Gateway owns the worker process and its pipe/IPC generation. A worker exit
or stdin/stdout/stderr error retires that generation once, rejects its pending
requests and disconnects its page sockets so ordinary recovery can recreate the
worker. The persisted tab catalog is retained. Bootstrap pipe failure also
rejects startup immediately; a late failure from an old startup cannot clear a
new startup. Late process messages or errors cannot mutate a replacement.

Node Writable write callbacks do not consume a separate stream error event.
Listeners therefore remain for the transport lifetime, including after ready
and shutdown. This contains browser failures within their resource owner; it
does not establish the cause of a native Electron abort or promise DOM recovery
after that abort. Diagnostics expose only owned event enums and counters, never
visited URLs, page text or arbitrary Chromium stderr.

### Native state acknowledgements and client backgrounding

Visibility and viewport setters distinguish desired, in-flight and acknowledged state.
A failed or unknown result never advances acknowledged state. Setters serialize and
coalesce to the latest target, retry transient failures with bounded backoff, and
retire results with their connection/native generation. This mechanism never replays
clicks, keys or composition. Exhausted recovery remains actionable and can resume on
a new connection, control grant or presentation intent.

Remote viewing requires both Shell presentation and a foreground client document.
Hiding retires local gestures, composition, menus and pending human grants, releases
human control and stops viewing; it neither destroys the logical Tab nor revokes an
Agent's independent background use. Foregrounding resumes observation without
claiming control. Open/reconnect consumes current effective visibility.

Resize preserves the previous complete bitmap. Pointer injection waits for the
replacement geometry and its first complete frame; focused keyboard/IME editing
keeps its native target contract during the geometry handoff.

Clipboard capability invalidation follows its owning frame/document. Unrelated
subframe or same-document navigation does not globally cancel a menu's copy. Top-level
document replacement, owning-frame replacement, renderer loss and native token
rejection continue to fail closed, including while capture or Copy is in flight.

A live managed owner keeps its immutable runtime until its Tabs are explicitly
closed. On attachment, differing public scripts/assets can replace an empty owner
under its exclusive transport; active inventory always preserves the process. The
last explicit close releases a stale idle transport so the next open can upgrade.
An unknown script identity preserves the owner. This is not native binary hot swap:
existing live Tabs adopt native helper fixes after draining, not through DOM reload.


### Negotiated media credits and independent adapters

The remote interaction package owns credit accounting, media feedback and
bounded transport primitives. Resource creation, Server attachment, native
incarnation, controller/document fences and presentation ownership remain in
their existing owners. The wire contract and finite-model boundary are
[remote interaction protocol v1](../../../packages/remote-interaction/spec/protocol.md).

Negotiated WSS viewers distinguish received from Canvas rendered submission.
Each viewer has six media credits, 2 MiB ordinary bytes and a single empty-window
keyframe burst up to 4 MiB. Control replies/events bypass media admission. A
reset pauses output and retains old debt until the matching new-epoch ready
confirms decoder retirement. Old watermarks and duplicate ready cannot refund
new work. Three attempts without acknowledged frame progress terminate that
attachment; quiet screens and hidden viewers do not count as stalled. Viewer
capture requests are combined using the fastest visible consumer's rate.

Input credits track exact outstanding request IDs separately from caller
promises. Timing out an input returns unknown and starts reconnection without
refunding capacity or replaying the operation. Existing native authority remains
the execution boundary; disconnect does not undo dispatched input.

The independent WebRTC input adapter accepts an existing reliable ordered
DataChannel and the same authorized attachment contract. Browser signaling,
RTP video and automatic transport switching are not supplied by that adapter.
MSE viewers only acknowledge receipt until reliable render evidence is available.

### Capturing a document loaded while painting was parked

A completed visible document requests one fresh native capture through the
existing visibility setter, independently of decoder receipt/render ACKs. An OSR
bitmap cached before the hidden navigation is not evidence of the new document's
pixels. Repeated idle/title events for the same native document do not repeat the
capture. Refresh revisions share the visibility single writer: demands coalesce
behind an in-flight setter, and a late ACK cannot resume a page whose last viewer
has parked. The existing setter also works on retained native owners, preserving
their documents and control leases without a runtime restart.
### Sparse MSE seek progress

The MSE receiver catches up to a complete buffered sample on sparse updates.
A `waiting` event can itself be caused by a seek. Do not seek while a previous
seek is pending, or repeat an unchanged target (within 1 ms); otherwise the
video can remain in HAVE_METADATA despite a complete decoded page in its
buffer. A later waiting/update event may advance to a new buffered target.
This does not change the received-stage media credit contract for MSE.


### Demand-aware two-bucket production

The shared remote-interaction policy owns bounded feedback turnaround and
exactly two encoding buckets. Fast/slow are topology, not immutable codec
settings: both FPS and bitrate adapt within operator bounds, and attachments
move down on sustained pressure/decoder demand and recover only after stable
progress. Idle time is not capacity evidence. A single delayed feedback sample
does not change bucket. Per-attachment windows have a twelve-frame absolute
limit, a working limit derived from feedback delay, and the existing byte bounds.
Input peers explicitly advertising inputWindow:12 use two-to-twelve exact-ACK
credits, with editing barriers and unknown outcomes unchanged.

A productionDemand:1/mediaBuckets:2 native worker accepts an epoch/revision
plan with a renewable lease. The Gateway aggregates eligible visible consumers
per bucket; one slow viewer cannot revoke another bucket's permit. The native
worker checks permission and expiry before toBitmap, full-frame comparison and
encode. At most two encoders exist per page, with one in flight and one latest
raw frame per bucket. Both can reuse a captured bitmap. Rate/bitrate changes
start with a keyframe; bucket moves use the receiver reset/ready handshake.
Viewport and input authority stay with the shared page and original control
lease; changing bitrate/FPS never resizes the page.

Retained owners without these capabilities remain on the existing single-stream
path; they are not restarted merely to enable the new producer. Gateway window
adaptation and new-client input behavior remain compatible. Per-viewer
mediaDiagnostics returns only bounded counters/durations for that authorized
attachment plus native production counts. Receiver snapshots distinguish
received, decoded and Canvas-submitted counts; MSE claims received only. These
are diagnostic stages, not physical display or exact input-effect proof.

The ProducerDemand finite model composes two consumers and two bucket permits,
lease expiry and an isolated slow reset; healthy progress assumes persistent
healthy demand and strongly fair planning/production. Its negative controls
remove the lease gate or refund the other consumer. CreditWindow/MediaRecovery
remain separate models; this is not an implementation refinement proof or a
proof of arbitrary-client scheduling fairness.

The remote-interaction test entry includes producer/adaptation cases. Its real
browser smoke checks the absolute twelve-frame bound, not a fixed working
window; native ACK results and no-progress recovery remain required.

A retained worker rejecting display-rate as unsupported is probed only once
per native generation. Transport failures remain retryable; late old-worker
rejections cannot change the replacement generation.
