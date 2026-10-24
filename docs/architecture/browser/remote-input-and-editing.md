# Browser: Remote input and editing

[Architecture index](../../browser-workbench-architecture.md) · [Documentation index](../../README.md)

### 原生远程编辑运行时

自有 Electron 源码定义与补丁由 [vendor/electron](../../../vendor/electron/README.md)
持有。首个补丁恢复 OSR 的 Chromium 文本状态管线，并提供只读原生选区、组合范围和
光标几何查询；它不是原子快照，不包含输入授权或跨文档唯一编辑身份，当前发行包
尚未消费此 fork。缺失的几何保持不可用，不由 DOM 或控件边缘推测。

第二个补丁是测试用途的原生目标绑定实验：通过每 frame 的 Mojo 通道取得单次
context token，在 renderer 内校验文档、焦点代次、组合代次和原生编辑快照，再调用
Chromium 的组合/提交/取消。Blink 编辑路径中的 scoped guard 在网站同步事件回调后
复核原始焦点和编辑根；取消还要求属于本轮创建的组合会话。不把已发生的网站脚本
副作用描述为可回滚，不将 renderer 断连后的未知结果自动重试。详见 vendor README
和 `probe-target-ime.cjs`；源码重放、原生编译与探针实测分别记录。

后续输入桥接保持远端原生编辑器为正文唯一写入者，本地系统输入法拥有候选会话。
严格目标绑定、焦点/文档代次、迟到提交/取消、原生客户端上下文、触摸及 DevTools
共存需要独立运行验证；不能用源码重放成功替代真实编辑体验或权限验证。

### Local menus and remote selection boundary

Remote selection and editing remain Chromium-owned. Context menus belong to
the client presentation: an Electron client may use a native Menu, while a
Web client renders its own local menu. A video surface does not supply the
mobile OS text-selection menu. Menu availability comes from the remote native
context, and commands must validate their page, document and target generation
again when executed. Opening a local menu must not blur or reset the remote
editor. Clipboard results must be scoped to the requesting browser session,
then written to the client clipboard under its user-gesture contract; the
server's global OS clipboard is not a remote clipboard transport.

Each offscreen page initializes a local blank renderer and a private native
page-focus context before remote navigation. Ozone headless OS-window focus and
injected mouse clicks alone do not focus its renderer. Chromium's existing
focus emulation lets independent page viewers retain their own native focused
element; it does not refocus an old editor when Copy executes. Parking video
does not toggle page focus or dispatch an extra editor blur. Cross-site iframe
renderers have separate focus contexts. A private, recursive iframe-target
attachment initializes each one before resuming its script; initialization
failure or detach always resumes a waiting target and cannot leave it paused.

The remote worker now exposes a narrowly typed copy-back operation and native
context-menu notifications. A client right-click or keyboard-menu intent must
still own the current presentation when the notification arrives. The local
Electron Menu or Web Radix menu offers Copy and, for HTTP(S) links, Copy link
address. Ctrl/Cmd+C uses the same copy-back operation. Opening a local menu
preserves the remote focus and selection. Website-owned menus remain in the
remote page when its context-menu event prevents the native menu.

Copy requires the owned Electron fork's target-bound clipboard capability;
stock runtimes advertise it as unavailable. The renderer issues a single-use
native document/focus/selection token. Executing Copy validates that token,
dispatches Chromium's real editor command, and captures the final ClipboardHost
text/HTML writes on the same ordered Mojo pipe, including website copy handlers
and existing policy callbacks. ClipboardHost does not flush these writes to the
server OS clipboard. A moved target, navigation, unsupported format, nested copy
or missing data rejects the result. Rejection after dispatch does not roll back
website event-handler side effects. The initial result limit is 65,536 UTF-16
code units across text and HTML; images/custom formats, cut and native paste
transactions are outside this capability.

Page/session permission checks and current presentation/connection generations
fence the result again before a local user intent can write the client
clipboard. Async Clipboard API clients create promised text/HTML items during
the local gesture; plain-only results receive an equivalent inert HTML
alternative. LAN HTTP uses the browser clipboard command and reports refusal.
Retiring the view rejects pending data. A final check immediately before the
desktop port call or promised Blob fulfillment also fences retirement between
remote-result validation and the next Promise reaction. No protocol can revoke a clipboard
write already accepted by the local OS/browser. Client clipboard permission and
activation rules still apply.

The fork source, worker, client menu and artifact-selection paths are connected.
Source integration alone does not enable native copy: a complete owned binary
must pass the native clipboard probe and be selected during packaging. Native
runtime adoption and physical desktop/mobile validation must be recorded
separately. This does not complete native IME or multitouch, and a video surface
still cannot provide the mobile OS's native text-selection handles.

### Remote surface keyboard activation

The presentation canvas is not an editor. A real local input receives native
composition events and stages only the current transaction; it never mirrors
remote text. Native Chromium metadata identifies text, search, password, email,
URL, telephone, number, textarea and contenteditable fields, their inputmode,
enter-key hint and virtual-keyboard policy. Number staging uses text plus the
native inputmode so local number validation cannot rewrite the remote edit.
Sensitive fields (including Chromium's previously-password flags) use a local
password input. Staging clears on commit, cancellation and field changes.

Ordinary tab, canvas and menu focus use inputmode none and manual keyboard
policy. A single small touch may promote the already-focused receiver only
after a different native editor is confirmed, within the short-lived tap intent.
Movement, multiple contacts, capture loss and blur disarm this intent. It never
asynchronously focuses a local field or steals focus from the local address bar.
The existing Keyboard action synchronously focuses the receiver in a local
trusted gesture, using the remote keyboard traits. Explicit Keyboard can override
inputmode none; automatic activation respects it and manual native policy.
Updating inputmode on an already-focused receiver is a best-effort mobile
WebView path; physical WeChat/iOS/Android popup behavior needs device validation.

The worker emits an opaque editor observation id and bounded caret geometry,
never field contents, native target identity or write capabilities. Begin binds
the observed id to the exact native document/node and input type. Each operation
uses a single-use native document/focus/selection capability; changed focus,
type, document or native context cancels rather than retargets delayed input.
Preedit, commit and cancellation follow Chromium's editor and website handlers.
The client keeps the original editor id throughout a composition, coalesces
preedit and queues terminal edits in order. Local blur, park, navigation,
disconnect and disposal retire the transaction.

Physical keyboard keydown/keyup/character events remain available on non-editable
pages, including arrows, Tab, Escape and shortcuts. Enter forwards the native
Return character as well as key edges so native form submission and textarea
line breaks can run; a non-editable page keeps the manual local key receiver. Composition/Process/229
keystrokes are excluded to avoid inserting both a key character and IME commit.
Browser/OS-reserved shortcuts, layout-specific dead keys and Bluetooth keyboard
behavior need platform validation; remote handlers can reject edits. Rejection
after dispatch cannot undo website side effects. Stock runtimes without the
native bridge advertise it unavailable.

This text bridge does not implement remote surrounding-text reconversion,
editor mirroring, mobile selection handles, native date/color/file/select pickers,
password-manager/autofill/passkey origin delegation or arbitrary EditContext
editors. Those are separate capabilities, not implied by password text entry.

### Native touch identities and private crash diagnostics

Wire touch IDs are arbitrary validated identities, not Chromium pointer slots. The widget CDP adapter allocates at most ten stable slots, commits allocation/release only after native ACK, preserves held fingers across partial release/reorder, and clears slots after cancellation even when cancellation fails. Browser-provided pointer IDs never reach VelocityTracker directly.

The Gateway consumes the browser stderr pipe with a bounded private in-memory parser. It retains only the most recent fatal code location, up to 24 argument-free stack symbols and counters, associated with the retired process and its exit code/signal. `lastBrowserFailure` is process-owner memory, not a client endpoint: no raw stderr/messages, console forwarding, file/checkpoint writes or page socket disclosure. Replacement workers cannot be retired by old pipe events. This evidence does not establish a cause for an unobserved native abort.

### Offscreen wheel injection

Remote wheel input uses the worker's private Chromium `Input.dispatchMouseEvent`
wheel injector. The pinned Electron OSR `sendInputEvent(mouseWheel)` path mutates
a phase-bearing copy but forwards the original event, violating Chromium's
wheel queue invariant and aborting the whole browser process. The CDP injector
provides native begin/end phases and frame hit testing. Viewer widget positions
are converted using current pinch scale and browser zoom; wheel deltas retain
their physical magnitude and convert from Electron to web direction. Native
modifier semantics, sandboxing, page leases and memory-only stderr remain intact.
No public debugger endpoint or arbitrary input command surface is added.

Media epochs are opaque, non-reused identities across renderer recreation, resize and parking. Encoder callbacks belong to their exact encoder instance; a late output/error cannot emit into, clear or release a replacement encoder for the same logical Tab. Worker accepts packets and failures only for the current media epoch.

### Remote input document and interaction fences

Raw input and text operations now carry the remote document identity, distinct
from the controller token and media epoch. The worker captures that identity at
admission for older peers, checks it again when queued commands dispatch, and
rechecks after viewport/reset/editing waits. Touch and wheel injection also check
after their asynchronous native metrics read. New viewers negotiate document
input and preserve the identity from event production through local coalescing,
transport and native execution; missing or obsolete identities are rejected.
Main-document replacement emits an input reset with its new identity, retires
local queues/composition, and releases pressed native state before new input.
Subresource loading alone cannot reset a document-aware viewer's editing state.
Already dispatched native events cannot be retracted; rejected edits are never
retried against another document.

Human control requests capture the viewer's visibility generation. Hiding a
viewer invalidates pending human requests even if it becomes visible before the
native grant completes. The service rechecks that generation before and after
the native acknowledgement; canceled grants clear their native token. This is
independent of Agent control, which can operate without a visible viewer.

IME navigation retirement follows the owned frame: main-document replacement
or replacement of the frame holding the editor retires it; unrelated iframe
and same-document navigation do not. Native target/document/focus checks remain
authoritative, including destroyed descendant frames.

The local input adapter interprets deletion and line-break intent by inputType
on both cancelable beforeinput and noncancelable input paths. It suppresses a
matching input after an already handled beforeinput, and commits fallback text
only when it remains in the staging receiver, preventing duplicate composition
commits. It does not mirror remote text or implement local autocorrection of
remote selections. A failed input acknowledgement retires pending interaction
work, cancels native pressed state and reports one current failure; obsolete
connection/control/document errors stay retired, and no input is replayed.
Transient owner attachment failures, including a still-attached prior Gateway,
are retryable browser-unavailable errors. Protocol incompatibility remains
terminal without replacing live tabs. Rejected private sockets drain their short
status reply and then close, without retaining unread attachment data.
