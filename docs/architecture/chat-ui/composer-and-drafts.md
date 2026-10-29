# ChatUI: Composer and drafts

[Architecture index](../../chat-ui-architecture.md) · [Documentation index](../../README.md)

## Browser reconnect outbox

Existing Web/Electron conversations can accept text while their Host is offline
or their Replica baseline is recovering. `ConversationRuntime` owns a local
outbox distinct from the Host execution queue. The platform injects
`ConversationOutboxStorage`; Web/PWA uses IndexedDB and Electron uses fixed Main
SQLite via the shared named local document port. Legacy `opencraft.outbox.v1:`
sessionStorage is an import source, partitioned by server, product, account, Host
profile revision and Thread. Local persistence must succeed before the Composer clears.
Storage denial, capacity errors and unsupported attachment/context handles retain
the draft. New Thread creation still requires a connection. Native/embedded
consumers without this port retain their existing admission behavior.

The original immutable message and client identity survive reload. Once the
existing recovery owner has restored an authoritative live baseline, one drain
moves never-attempted inputs FIFO into the existing Host next-turn queue. A
steer composed offline becomes a next-turn message, rather than targeting an
obsolete Turn. Server membership/method checks remain authoritative. Local
waiting rows can be deleted offline; they cannot be edited, reordered or
steered through server queue APIs. Their attached rail explains automatic
sending and does not expose a server Resume action.

Before transport dispatch the attempted state is saved. Reloaded attempts or a
lost acknowledgement become unconfirmed and block FIFO; only exact server queue
or timeline client-message identity retires them automatically. They are never
blindly replayed. Exact positive proof retires the local attempt and its
optimistic command together, then wakes FIFO after the authoritative snapshot
has been published; a queue-only confirmation needs no further timeline event
or page reload. Reconnect also refreshes the Host queue independently after
history authority returns: a lost queue notification must not leave an attempted
local input permanently unconfirmed. Old connection responses cannot publish
queue authority into a newer generation. If readiness is synchronously revoked when the saved attempt is
published, the transport has not been called: restore waiting custody before
exiting the drain. A confirmed pre-dispatch refusal can return to waiting. An
identity replacement revokes the old namespace and late completions; ownership
is rechecked after asynchronous compilation immediately before sending.
Reopening a document/process restores locally accepted input when its Runtime is
reacquired; this is not cross-device delivery, and Web storage may be evicted.
Background open conversations remain resident for recovery.

## Attachment staging during reconnect

Browser file preparation (including large pastes converted to `pasted-text.txt`)
waits for its original Host runtime to be ready with an open transport before
reading the negotiated staging capability. The existing attachment session keeps
the File and cancellation signal; no message is sent by this wait. On a staging
failure accompanied by a connection transition, preparation waits for recovery
and restarts with the same clientAttachmentId and content, whose staging contract
is idempotent. Stable capability, permission and format errors remain failures
with the existing retry action. Removal, cancellation or Host disposal ends the
wait; it cannot redirect to a replacement Host/account. Inline image processing
remains independent of Host readiness. This retains bytes within the running
Application, without changing the refresh persistence limits below.

## Browser-local input drafts

`ComposerStoreServices.drafts` is a platform-neutral content storage port;
the persistent browser adapter uses shared local documents for Bot input without
server or device synchronization. `BrowserComposerDrafts` remains the legacy
localStorage codec/import path. Task input slots use an account-bound
`ConversationDraftOwnerRegistry`; `ConversationDraftContinuity` remains their
sole document persistence writer.
Bot input is isolated by product/account and exact Host/conversation identity. Document, context and
attachment metadata are saved on explicit edits and cleared after an accepted
send. Lifecycle, selection and disposal changes never overwrite stored content.
Restore creates a fresh editing state, not a submitting lock, receipt or outbox
entry, and never sends automatically. Account credential-scope changes revoke
and clear the old Bot adapter; a fresh application creates the next account's
adapter. Task sidebar selection resumes the conversation's last successfully
presented input slot; explicit navigation and POP preserve independent Views.

Task presentation caching and input retention have separate budgets. A cached
View borrows its slot's original Controller and does not retain that draft owner.
Evicting the presentation after 20 inactive desktop Views (4 on mobile) releases Scope/UI resources,
not the Controller, original Files, previews or attachment jobs. The Application
retains at most 50 nonempty unsent input slots, evicting the least-recently-used
inactive slot and discarding its stored document. Empty inputs do not count.
Physical editing and in-flight submissions protect a slot from eviction; if all
50 are protected, new-content admission is refused rather than deleting live
input or exceeding the budget. Late attachment status changes do not refresh
recency. Promotion updates every slot of the Scope, including slots whose View
has been evicted; the owner holds no Scope, Thread or Host lease. Clear/accepted
settlement releases assets, failed settlement retains input, and account
revocation clears all slots and target caches. Tests: `test:task-draft-switching`
and `smoke:task-draft-switching` (real OpenCraftComposer, synthetic remote boundaries).
New-chat Scope metadata uses a separate 20-empty-record budget; records with
retained input and in-flight first submissions cannot be pruned by that budget.
It queries input ownership rather than retaining an execution lease. Evicted
input cannot rehydrate from its discarded document even while empty navigation
metadata remains.

Task continuity includes new-Draft placement in its existing document envelope,
not a second storage writer. Browser bootstrap can restore that exact client
Draft ID and configured, enabled Host before the View hydrates its document.
Canonical promotion aliases take precedence; old envelopes remain readable.
Browser edits enqueue local writes immediately rather than leaving the last
input behind a debounce window. No execution state is inferred from placement.
Account service disposal revokes asynchronous authority without rotating the
persisted credential scope. Only actual identity/credential transitions rotate
that scope; otherwise every ordinary browser refresh would orphan saved input.

Original browser File bytes survive Task conversation switching within the same
Application. File persistence across a full refresh and ephemeral Side Chat
reload restoration are not implemented. Expired Object URLs and unfinished attachment staging restore as
failed removable cards asking the user to re-add the file, never as ready files.
Storage corruption, denial or quota failures retain in-memory editing; diagnostics
do not log content. Mounted Views do not subscribe to cross-tab changes.
Tests: `tests/chat/chat-browser-drafts.test.ts`, `npm run smoke:browser-drafts`.

Thread identity, execution activation, capability leases and revocation follow
the [execution ownership contract](../../execution-ownership.md), including its
explicit distinction between implemented coordination and pending delivery guarantees.

## 跨桌面、手机和平板的会话连续性

Conversation Scope 是会话身份，View 是具体窗口或页面的呈现与滚动状态；任务输入槽位以 View ID 标识，但其 Application 级草稿所有权独立于页面缓存。`workbench-runtime` 的 `ConversationDraftOwnerRegistry` 保留原 Controller 与附件资源，`ConversationDraftContinuity` 管理同一输入槽文档的保存、恢复、发送成功后的丢弃和迟到读取仲裁；平台只提供本地存储。移动端用 SQLite，并以区域、凭证摘要和 Bot 实例/Profile 分区；Web/Electron 用浏览器本地存储，并以产品和账号服务的凭证作用域分区。退出登录或切换凭证时撤销旧存储、清除所有草稿所有者及其内部目标缓存，包括已无页面的草稿。附件与临时文件引用不从文档缓存恢复；会话切换保留内存附件不等于刷新恢复字节。

`recovery-policy.ts` 中的 `ConversationReturnProbe` 统一短暂离开、较长前台恢复和断网恢复的触发条件。iOS 把 AppState/Expo Network 事件交给它，Web/Electron 把 visibility/online 事件交给它；真正的追平仍调用当前 Thread lease 的 `retryRestore()`。追平不创建新会话，不重置可读历史。已经显示的内容是否权威，仍由 Replica/Session 决定。

手机、iPad、折叠屏和桌面共享上述身份及状态转换。屏幕宽度、安全区、键盘和指针决定各自布局，不决定另一套业务流程。V3 ThreadView 的 revision/epoch 属于连接代次，不能把它写进持久 Replica 检查点。`ConversationDisplayContinuity` 只从权威时间线保存有界的用户消息与回答文本，包括进行中已收到的文字、过程说明及推理摘要；冷启动重建 `painted / authoritative: false` 的只读 Timeline 供两端原有渲染器展示，当前 Host 恢复后整体替换。工具、审批、附件、交互以及 Replica 游标不进入展示缓存，不能从该缓存授权发送或其他操作。缓存按账号、Bot/Host 和 Thread 分区，并在退出登录时清除。

会话定位共享 Turn 身份、最小时间线 revision 和对齐意图。Web 与 Native 都先挂载目标 Turn，等平台实测高度进入虚拟布局后才滚动；用户接管或 View 卸载会取消等待。两端用户消息使用共享 `getTimelineUserMessageTargetKey` 的 Item 锚点；Web 注册 DOM，Native 注册当前挂载行的局部布局。投影确定目标不存在时返回 unavailable；目标存在但尚未测量时继续等待，不能用经过几帧或整条 Turn 的估计位置冒充精确命中。Native 行高度是否已测量与项内锚点是否已注册是独立事实。

Native 远处定位使用两个有界挂载窗口：保留当前可见行，同时挂载目标邻域测量；行按共享布局的绝对 top 放置，重叠行只挂载一次，窗口之间的历史不挂载。执行位置写入后才切换可见窗口。平滑定位只允许请求发起时已挂载且距当前位置不超过一个视口的目标，动画期间可见窗口跟随平台实际位置。`NativeTargetPositionTransaction` 持有语义目标的布局签名和本次请求坐标；内容、锚点、视口或底部占位变化时重新求值，已开始的动画使用瞬时校正收尾。完成依据当前布局与当前位置的匹配，不永久等待旧坐标；目标删除、取消和卸载均释放订阅及帧回调。

虚拟窗口在折叠、历史插入和恢复首帧时必须覆盖当前距离对应的可见 Turn；保存的窗口只能在仍覆盖可见区域时复用。测量批次一次提交高度表、窗口和滚动目标。Web 以当前 DOM 节点、Native 以当前挂载行的测量租约识别高度来源；卸载行及旧实例的迟到回调不能写入新窗口。Native 在内容高度改变而距底部数值不变时仍要于内容尺寸提交后重写物理偏移，保证插入于视口上方的历史不把屏幕推走。用户触摸会中断待执行的自动定位。
滚动帧只更新当前距离与有界可见窗口；完整 Turn 高度快照在离开会话时按需生成。Native 父容器持有可在虚拟列表卸载后调用的捕获函数，避免每次滑动都遍历整条时间线，也避免子组件 ref 先释放时丢失恢复状态。
Native viewport owner 在视口高度变化及没有位置写入的内容尺寸提交时发布同一份几何事实，控制器与虚拟列表不能等下一次滚动事件才同步；几何发布不消费待提交的内容恢复事务，也不触发用户接管。启动尚无内容尺寸时保留初始恢复意图。

用户消息折叠资格只由已确认的自然高度决定。Web 持续观察内层内容尺寸；Native 在内层未裁剪时接受后续 `onLayout`，折叠后只接受超过已确认自然高度的增长，拒绝可能来自裁剪的缩小值及旧内容身份的迟到布局。宽度变化会使旧自然高度失效并重新测量。Native 测量绑定内容、宽度代次、原生节点及挂载生命周期；`measure` 的异步返回使用启动时的观察器，并在回调和状态提交时复核代次。即使宽度由 A 变为 B 又变回 A，旧结果也无效；重测不依赖 RN 再次发送相同尺寸的 `onLayout`。

```text
WebSocket / Replay Transport
          |
Host AppServer protocol
          |
Conversation Read Model
V4 ReplicaClient or AppServer V3 compatibility projection
          |
Conversation Runtime
          |
Thread/Turn/Item -> Timeline Frame -> Timeline Block
          |
Web renderer                         Native renderer
          ^                               ^
ProseMirror adapter                 Native editor adapter
          |                               |
        Composer Document / Draft / SubmitIntent
```

### Outgoing message handoff

The Conversation Runtime owns the outgoing message from local submit until an
authoritative Composer input or UserMessage Item can actually render it. A Turn
receipt or an empty authoritative Turn is not a visible-message acknowledgement:
the optimistic item is projected into that Turn until its display owner exists.
The client message ID is the stable display identity of the user block, its
frame, and the React Turn row across optimistic, Turn.params, and server Item
phases; the virtualizer's Turn locator and protocol Turn/Item IDs remain
canonical for navigation, measurements, commands and anchors. Web may suppress
the transient sending label, but failed and uncertain
delivery retain visible feedback. This prevents a receipt from briefly removing
or remounting an outgoing bubble while ordinary text and attachments settle.
For Codex Host-staged files, the Host may add a model-visible locator after
`Turn.params` was captured. Once the matching server `UserMessage` acknowledges
that input with the Host-owned display span, its content owns presentation;
the unaugmented Composer params must not overwrite the span or the attachment
type. Ordinary messages continue to use Composer params. This is a projection
choice under one message identity, not a second sent-message branch.
The same acknowledgement rule applies to a locally owned steer: its matching
server `UserMessage` supplies a Host-staged file span to the steering input
projection, while the steering row retains its client identity and status.
The Codex Host now persists the validated attachment refs by Thread and client
message ID before direct or queued dispatch. Native Codex input retains its
supported `mention` plus model-visible locator, but those bytes are never the
display authority. The Host enriches live UserMessage Items and paged/resumed
history with typed attachment metadata from that durable record; a fork copies
the mapping to its new Thread identity. A sent file cannot be removed through
draft cleanup. Pre-existing messages without this record retain a narrow
exact-locator compatibility path, not a general path or filename heuristic.

Native 的实时 Thinking 在 Turn 等待占位与 Activity 组之间交接时使用同一文字 primitive、字重、行高、行容器及扫光呈现。交接只是状态所有者变化，不播放纵向进入动画；Activity 的位移动效只在可折叠历史的展开场景使用。不能用几像素的补偿偏移掩盖两条显示路径的几何差异。

### Embedded submission and recovery

Embedded workbench templates enter through `submitPrompt(requestId, text)`, not
through a legacy SDK sender or a DOM button. The embedded element deduplicates
admitted request IDs in its Bot lifetime. The App admits only into an empty,
editing new-Thread Composer belonging to the embedded Host after protocol
readiness; an existing Thread first navigates to a new Draft. An occupied Draft
is never overwritten. The site retains the pending template across cold startup,
failed admission and inactive routes, and removes only the matching record when
the Conversation owner accepts the immutable first Turn. Remote failure then
belongs to that Conversation's retry UI, never an automatic duplicate send.

A manual transport failure is a Host-attempt disposition: initialization cleanup
must not erase its code when disposing the physical transport/client. Workbench
snapshots retain the block through cleanup and clear it on an explicit new
connection attempt or a connecting/open successor. Recovery presentation must
not claim automatic retries when the Host is stopped for manual intervention.
An `APP_HOST_PROTOCOL_MISMATCH` disposition presents a localized update/reload
instruction in the existing cold-error or retained-history notice slot. It does
not show a reconnect spinner or offer the same-client retry button, and never
reloads the page automatically. The retained Timeline and Composer keep their
identity and drafts; protocol numbers and raw server errors stay out of the UI.

The Web recovery presentation does not equate non-authoritative with invisible.
When a Thread already has painted Timeline frames, reconnect and retry preserve
those frames, their scroll position and Composer draft; a small local connection
notice shows reconnecting or failure copy, while background synchronization uses
the shared neutral loading ring with a screen-reader-only localized status name
and no badge surface. Commands remain disabled until
authority returns. Only a Thread without visible frames gets a centered neutral
loading ring in the Timeline's empty slot (delayed 200 ms to avoid fast-load
flashes). It has no visible copy; the localized status name is screen-reader
only. The shared Web spinner owns its glyph and theme-aware, reduced-motion
presentation, not Thread authority, timeouts, focus or scroll writes. Startup
uses the same passive primitive. A definite restore failure replaces that slot with
an inline retry action. Neither state mounts an opaque page overlay or changes
the Conversation View identity.

Host protocol readiness is independent of each Thread's restore outcome. After a
new logical connection initializes, resident Threads restore independently with
retained Views prioritized and bounded concurrency. Missing Threads expose their
own error; transient transport/time-limit failures retry in the Thread owner.
Neither a failed Thread nor a slow terminal/file-watch restore keeps healthy
conversations behind the Host reconnect phase. Commands still require their own
Thread authority and execution capability lease. Composer catalog queries remain
Host-owned reads: reconnect revalidates them without requiring a menu remount,
preserves previous choices/data, and presents refresh failure as an error rather
than inferring that the Host does not support the capability.

Host execution preparation is coordinated by the existing Thread lifecycle
queue. Capability replacement and Turn admission share that queue; connection
revocation is synchronous and invalidates pending commits before asynchronous
engine cleanup. Renderer declaration acceptance (including cold deferral) does
not assert that engine tools are mounted. The Host checks exact mounting before
execution. Interrupt, approval replies and queue removal do not wait for tools.

For new local DSH Agents, initial capability mounting runs inside native Agent
setup alongside the preset, with an independently revocable capability scope.
The product catalog and `thread/started` commit only after preparation succeeds.
Setup failure rolls back its unpublished native resources. An attachment failure
after native persistence releases the new idle runtime but never deletes durable
history; response-loss idempotency is a separate delivery concern.

Engine release and mounting use the same session queue. Bridge responses expose
allowlisted error codes instead of arbitrary provider or filesystem exception
text. No warm reservation or speculative Thread identity is required for these
correctness guarantees.

### Native Composer input boundary

The Expo Composer uses the same Controller, Draft, attachment lifecycle, model
catalog and Host attachment-staging capability as the desktop renderer. The
Hermes bridge returns catalog timeouts as AppServer request failures, so a
later catalog read can retry without resetting the conversation. The Expo Host
records only a fixed failure category in its developer log; handled RPC
failures must not be reported through `console.error`, which Expo Go renders
as a full-screen development error.
workspace and permission controls consume the same AppServer project and
permission-profile catalogs; they appear only when the connected Host returns
actionable entries. The current the downstream product Hermes bridge returns empty catalogs
for both methods, so its iOS Bot chat has no workspace or permission choice
until that Host implements the corresponding capability. The renderer does not
manufacture selectable projects or permission profiles.

The platform picker produces a local `File` URI; supported images become bounded
inline data URLs, while non-image files use `client-bytes` staging only when the
connected Host advertises it. Pending work is bound to the initiating Draft ID.
The native attachment sheet exposes the file picker only while that Host
advertises `client-bytes`; the photo picker remains available independently.
An OS photo/file picker result is also bound to the Draft and mounted Composer
that opened it; a result arriving after navigation or unmount is discarded
before adding any attachment. After admission, a Controller-owned native
attachment session retains the local source URI and in-flight task across
input remounts and target switches. A failed attachment can retry from that
same source; removing it aborts the task and releases a late Host result.
Picker jobs are serialized within one Controller-owned session: a waiting file
stays pending in its Draft while only one source is read, encoded and staged at
a time. This bounds concurrent Base64 memory on iOS without changing Draft
ownership. Removing a waiting file takes it out of the queue; removing the
active file still waits for any in-flight Host response so its late ref can be
released before the next job starts.
The native image chip previews that same local URI while the attachment belongs
to its Draft; it does not decode the staged base64 payload for display. Switching
Drafts or removing the attachment removes its preview from the active input.
Disposing the Controller releases unsent ready Host refs. A Draft already in
`submitting` retains its staged refs until that asynchronous send settles, even
if the Controller is disposed during navigation. Acceptance transfers ownership
to the conversation; failure or rejection releases refs that can no longer be
retried from the disposed View. Picker metadata is
normalized before entering
the Draft: a photo with no MIME
uses its original name or URI extension, and an unidentifiable photo remains an
image for JPEG conversion. This avoids routing such photos through the Host's
ordinary file-staging capability.
Unsupported native image formats are converted into a temporary JPEG. The
resolver removes that conversion file after encoding, including on cancellation
or size failure; the Draft's preview continues to use the original picker URI.
The Hermes staging bridge decodes Base64 in bounded chunks and checks canonical
padding in the final quartet. This avoids keeping an extra full-size binary
string and re-encoded copy beside a large file before its Host write; its
platform SHA-256 provider must not mutate the supplied bytes.
Removing an attachment aborts the job; the Host release callback receives only
a ready ref, including one returned after cancellation, never a pending item.
Late completions cannot mutate a different conversation. Picker and staging
errors shown in the client remain generic and do not expose internal details;
the iOS developer log records only fixed failure events.
Once a `client-bytes` request reaches the Host, the native resolver keeps
waiting for its reply even if the local picker item is removed. Aborting only
the RPC wait would hide a successful Host write and leave no ref to release;
the attachment session instead receives the late ref and removes it.

Native text edit bounds use one full suffix scan to resolve ambiguous changes
in repeated text near the last native selection. This keeps per-keystroke
work linear in the draft length while retaining the existing mark ownership.
The mobile paragraph-format action transforms contiguous selected top-level
paragraphs, quotes and simple lists in the shared document without replacing
inline marks or list item identity. Its visible selection maps across generated
list markers and the separators between blocks. A
native Return inside a simple list item splits it into a new item; Return on
an empty item exits the list. Unsupported nested blocks remain unchanged rather
than being flattened. The same action can create a code block from plain text
or convert an existing code block to paragraphs, quotes or lists. Converting
marked or atomic inline content to code is rejected because code blocks cannot
retain those identities. The input's native buffer is reconciled to the new text
projection, and the caret update is scoped to the same Draft generation. A pure
native text transaction decides whether an input event is accepted, rejected or
rewritten by a structural list or quote operation before the View publishes it. The
iOS Fabric adapter records the native event count and text before invoking the
parent callback, so a synchronous Draft update uses that event's generation
when it writes the controlled projection back.

At the start of a simple list item, native Backspace changes the first item
to a paragraph or joins a later item to its predecessor. Both operations keep
surviving inline marks and untouched item IDs; ordered markers are regenerated
from the remaining items. A complex item still rejects marker deletion rather
than losing its nested blocks.

On a quote's trailing empty paragraph, a second Return moves that paragraph
outside the quote while preserving earlier quoted content and its inline marks.
The plain-text projection can remain unchanged even though the block structure
changes; the native input reconciles the extra Return to the shared Draft and
keeps the caret in the new paragraph. Other quote edits still use the normal
paragraph path.
Backspace at the beginning of a quote following an ordinary paragraph joins
its first paragraph to the preceding paragraph. The remaining quoted children
stay in the quote, and each inline mark stays with its original text. The
resulting projection already matches the native deletion, so it needs no text
buffer rewrite. A quote after another structured block remains protected.

An async send settlement carries the initiating Draft ID and immutable
`SubmitIntent`. The shared Controller clears or restores only that active or
target-cached Draft; a late A result never mutates the B Draft now on screen.
If A acquired new content while its submission was pending, a successful
settlement preserves that content and returns it to editing instead of
clearing it. The native input is noneditable during its Draft's submission.

The shared AppServer compiler lowers Composer strong, emphasis and code marks
to Markdown in `UserInput.text`, because the AppServer text-element wire type
does not carry those marks. Desktop and Expo therefore submit the same
formatting semantics, while unmarked text remains byte-for-byte unchanged.

The native TextInput edits a text projection of the shared `ComposerDocument`.
Its adapter preserves inline marks and untouched mention identities for edits
within a paragraph, supports one format selection across ordinary paragraphs,
keeps marks when joining adjacent paragraphs, and turns Return or pasted line
breaks into paragraph blocks without dropping surrounding blocks. A selection
inside a link edits its text and marks while retaining the link destination;
text replaced across the entire link without surviving linked characters
becomes ordinary text. Link text in nested quote/list paragraphs uses the same
shared document reconstruction. A selection entirely inside a quote or list
leaf can edit and format that leaf, including splitting its paragraph. Edits
across two paragraph leaves within the same quote
or list item can join them while retaining the parent structure and surviving
text marks. Generated list markers and separators between distinct parents
remain protected. The iOS attributed editor uses the same exact text projection
for paragraph, quote, list and code-block Drafts, so nested marks appear at
their input positions. Other platforms show those marks in a read-only preview.
The native selection toolbar also creates or removes Web links across selected
paragraph text, including quote and list leaves. It retains the selected text's
strong, emphasis and code marks, plus surrounding block and inline identities;
generated list markers, code blocks, dividers and atomic inlines stay protected.
A keyboard-aware
native sheet accepts only HTTP(S) destinations; it percent-encodes Markdown
destination parentheses before the shared AppServer compiler serializes the
link. The selected range is bound to its Draft ID while the sheet is open, so
switching conversations cannot write a link into another Draft. Linked runs
are underlined and tinted in the attributed input.
React Native 0.86.3's public iOS `TextInput` wrapper drops rich Text children,
although its Fabric multiline
shadow node accepts them. The pinned iOS adapter forwards document text runs
to that native component and tracks its event count, focus and selection;
this is the path for displaying strong, emphasis and code marks while editing,
pending device verification. It also provides React Native's `TextAncestorContext`
around the native component so nested runs render as virtual text. Without that
context Fabric treats the nested `Text` view as an inline attachment character.
Because this adapter bypasses the public `TextInput` wrapper, it also compares
the last native text event with the shared Draft projection after rendering and
uses the current event generation to restore rejected edits or apply external
Composer text changes. The native command temporarily uses default text
attributes, so the adapter then refreshes the attributed child tree to restore
the document's marks without remounting the input host. The visible native
buffer must not diverge from the document that will be submitted.
When its Draft or Bot unmounts, the attributed input also clears the focused
native host before release, mirroring React Native's own TextInput cleanup so
the keyboard and focus do not remain attached to a previous conversation.
Native text, focus and selection callbacks carry the Draft ID of the input
instance that produced them. A late event from an unmounted input cannot edit
the newly active Draft or replace its focus/selection; accepted selection
offsets are bounded by that Draft's current plain-text projection.
Shared Composer `insertText` actions replace the current native selection or
insert at its caret; when no selection has been reported, they append. The
view then asks the native input to place the caret after the inserted text.
Native undo and redo record the full shared document and caret for each edit,
format action and external text insertion, keyed by Draft ID. The history stays
with the Composer Controller across input remounts, is bounded, and refuses to
replay when another action has replaced the document. Attachment refs remain
under their separate Host lifecycle and are never restored by text undo.
Between native text and selection events, the view rebases its last known
selection across the accepted text edit. The document adapter also uses that
selection to distinguish edits of identical adjacent characters with different
marks, so the unchanged run keeps its formatting.
Rebuilding an atomic inline requires every projected character in its span;
editing inside a mention, command or resource converts only the edited span to
text instead of duplicating the full inline. Before a native edit enters the
shared Draft, the adapter checks that the rebuilt document projects to the
exact text received from the input; an unrepresentable edit keeps the previous
document. The auxiliary controls scroll within the Composer on narrow windows
while the send action remains visible.
Other platforms retain the controlled text input and a read-only format
preview. Changing Drafts remounts the input so an empty Draft
cannot retain the previous visual text. Text edits that cross distinct quote,
list item or divider boundaries are rejected with a simple editing prompt rather than
flattening the Draft. A format selection can cross paragraph and quote
boundaries or multiple paragraphs inside one list item; generated list markers,
dividers, code blocks and atomic inlines remain protected. Model effort, Host permission profiles
and AppServer projects are selected through the shared Draft and catalogs.
Project choices appear only for a new-thread Draft and retarget its execution
workspace without replacing its content. Existing threads keep their bound
workspace. The iOS adapter uses a private React Native component and must be
checked after React Native upgrades; inline behavior, Chinese IME and selection
still need device verification. Native editing across distinct structured block
boundaries remains an editor gap.

### Composer material and native caret

The shared shell paints ordinary/Newera glass in a pointer-transparent background
pseudo-element. Backdrop filters must not wrap the ProseMirror editing subtree;
layout, keyboard viewport projection and the browser's native selection remain
separate owners. User-selected model controls use one flex formatting context
and consistent padding/gaps in empty and nonempty touch layouts around
the mounted editor. Material variables consume theme tokens and opaque fallbacks.
Within the sticky conversation footer, desktop paints a rectangular safe-area
gutter with a straight upper edge below the shell. It does not fill the lower
rounded-corner cutouts. Touch paints no gutter cover, leaving the same Composer
floating above the transcript. Density changes affect only decorative paint;
shell radius, glass, shadow, scroll ownership and editor/menu subtrees remain
independent. There is no exterior contour sibling.
Scroll/viewport regressions verify selection and adjacent-character geometry without
writing a second caret or resetting focus. Chromium checks do not establish iOS
native caret painting correctness; device-only failures require device verification.

Within the sticky conversation footer, desktop paints a rectangular band whose
height combines the bottom safe-area inset and shell-radius token. The straight
upper edge starts at the lower corner arcs and spans the footer width, preventing
transcript paint from leaking outside the rounded shell. Touch paints no gutter cover, leaving the same Composer
floating above the transcript. Density changes affect only decorative paint;
shell radius, glass, shadow, scroll ownership and editor/menu subtrees remain
independent. There is no exterior contour sibling.

Queue/goal rails use independent theme glass tokens on desktop Web and touch,
regardless of Newera. Desktop editors stay opaque; touch editors use their own glass.
Both have non-interactive background layers and opaque accessibility fallbacks;
no footer gradient may mask the rail's backdrop. The rail glass ends at the editor
seam to avoid double tinting the tuck. Material choices do not alter queue ownership.

Queue rows and the independent live-diff pill have their own compact density: 28px on desktop,
36px for touch queue rows and 32px for touch diff summaries, with no block padding.
The queue viewport is bounded to three rows plus its optional status header and
scrolls internally. Keep text roles, count animation and queue actions intact;
do not compress the Goal surface or editor to obtain this density. The shared rail
uses 94% theme material coverage (editor glass is independent), so the moving
transcript does not compete with accessory text. Reduced-transparency and
unsupported-filter fallbacks remain opaque. The live-diff pill uses its own opaque elevated theme surface and does not share the rail glass.

Touch interaction and the Newera presentation use the one installation preference
`interface.touchFriendly`. Automatic / On / Off is selected in Appearance through
SettingsSegmented; Chat has no second switch. Both standalone and embedded default
to Automatic. Existing touch choices persist unchanged; old `chat.touchNewera`
records are retained but no longer read or written by the current preference schema.
Actual pointer modality and available container space remain separate inputs.

Newera触控时间线浮动回底部控件：箭头与运行点共用ScrollToBottomButton的玻璃外壳和44px圆形触控区，图形放大15%并增强笔画；沿用主题Newera材质及减少透明/强制色彩/无滤镜实底回退。两态不得改变锚点、尺寸或滚动语义；紧凑布局与关闭触控体验时保留普通呈现。

Composer四角保持对称，共用shell radius token（普通16px/Newera28px）；附属rail以同半径互补圆弧mask适配shell肩部。结构tuck等于radius且padding/负margin相消，材料扣除shell范围，仅1px边界覆盖；不得压平shell上圆角或用整块双层玻璃掩盖接缝。验收包含实际像素覆盖、四角相等和编辑器/内容间距不变。

Composer输入辅助菜单焦点策略独立于模型/权限业务和Radix基础设施：仅触控/笔且编辑器正在聚焦时保留其焦点lease及原生选区，取消自动focus转移；键盘/AT或非编辑入口仍由Radix导航。触控期间继续输入/Escape可关闭、ArrowUp/Down显式进入菜单；外部关闭/卸载不得迟到抢焦点。该策略按props可插拔，不冻结视口、不伪造光标、不承诺控制系统软键盘。

附属rail背景在结构tuck之外仅覆盖1px材料接缝（coverage-composer-material-seam），到输入框边框下方，避免两份伪元素背景的外/内缘留下亚像素未覆盖带。验收测材料绘制边界，不能只比容器bbox；独立材质与无缝约束保持，结构tuck按完整对称圆弧计算。

非空附属rail与shell连接处不重复绘制shell顶部边框/内侧高光；空rail恢复独立输入框完整边界。用户确认本轮对象为静止时中间横缝。

### Mobile viewport diagnostic measurement budget

The viewport port remains the only geometry commit and animation-frame owner.
Diagnostics observe Shell and focused-editor rectangles on every committed frame
so their extrema retain brief excursions, including recovery before transmission.
Root/body/fixed-reference rectangles, Composer/send rectangles, computed style
and send hit testing describe the sampled report frame and are read only within
the existing 80ms and token-credit budget. The detailed measurement clock advances
even when an unchanged report is deduplicated; network silence cannot reopen
frame-rate measurement. Diagnostics do not alter viewport positioning, the native
settling window, queue admission, input focus or drafts. This bounds confirmed
measurement overhead; it does not establish a queued-message paint failure's cause.

### Mobile Composer content bounds

OpenCraftComposer owns a local editing-focus presentation session, independent of
draft and auxiliary menu open state. Only entering the editor starts it; toolbar
and owned portal focus may retain it until focus leaves. Empty single-line Add
open/close, submenu and keyboard navigation keep the same shell/anchor geometry.
Radix close cleanup (including a host dialog continuation) finishes before the
session checks its final focus destination. Content/attachments and active
submission states keep their existing full presentation, with one EditorView.
The Add menu opts out of window-blur dismissal: a native attachment surface's
window focus transition is not an outside contact. Outside contacts, Escape and
item selection still close it. Auxiliary-menu close cleanup loses its focus lease
if that menu has reopened before cleanup runs; it must not focus the trigger and
dismiss the new opening. Other menus retain their default window-blur policy.
The shared dropdown delegates its Radix-specific blur workaround to the internal
`useRadixMenuWindowBlurGuard` hook. It can be replaced when Radix supports
cancellable window-blur dismissal; consumers continue to declare the same policy.
Dictation is an input interaction, not an implicit text-editing session: an empty
unfocused Newera composer gives its existing row to voice controls, including
preparing/listening/transcribing/failed/retry. Existing text or editing retains
the expanded geometry. Selection reservation records the activation entrance without
focusing the View; pointer entrance is captured independently of native button
focus, and keyboard activation uses its focused control. Cancellation restores
that entrance after inert is revoked. Focus settlement follows the final React
DOM projection on the next animation frame and is canceled on replacement or
unmount; controller and draft identity reject stale restoration.
Successful final text returns focus to the same editor only after the editable
projection commits. No recording state is inferred from CSS or a second draft.

The dictation footer is a presentation consumer of the current transient
interaction. Its independent module buffers at most 512 valid numeric samples,
coalesces paint requests and releases the subscription, resize observer and pending
frame when the source changes or disappears. It does not capture audio or write
draft content. Stop delegates to finish, retry to the failed transaction and send
to the existing Composer submission owner. Duration updates only while listening;
startup uses shared neutral progress and failure retains the existing retry slot.



The existing Radix model-menu surface owns the available collision height, including
its padding. Its shared inner grid and both scrollable panes have a zero minimum
height; a narrow single-column presentation allocates shrinkable tracks to the
model list and model details. Details (including every declared reasoning effort)
remain reachable by native scrolling, rather than extending beyond an outer clip.
The menu keeps the existing auxiliary-input focus policy and viewport authority.

Generated placeholder copy is positioned against its editable paragraph, bounded
by the editor column. Empty, unfocused Newera inputs ellipsize that copy on one
line; expanded inputs allow wrapping inside the editing area. The placeholder is
not document content and does not change native selection, draft or input size.
`smoke-composer-mobile-layout.ts` exercises initial Home chrome with long English
and Chinese copy, short/panned keyboard viewports, reasoning selection and desktop.
Chromium synthetic viewport evidence does not substitute for iPhone device testing.

Chinese elapsed durations use the shared chat-core formatter with a space between each number and unit (for example `3 分钟 17 秒`), including work dividers and tool durations. Other locales retain their native narrow-unit formatting.

## First-submit pending conversation

After the first submit, the pending conversation consumes the immutable SubmitIntent and reuses UserMessageBlock, the shared thread width, viewport and top inset. It renders the original text through the normal document renderer and lists every submitted attachment; attachment-only input has no fabricated “New task” text. Shared bubble colors and chat typography apply before and after the server binds the Thread. The root supplies the current render theme and resource context, without fetching identity or deriving an author from the current account. The pending status and retry remain owned by the existing draft submission phase; this presentation does not create Threads or replay accepted first Turns.


### First-submit Thread handoff

A successful creation receipt retains the immutable submitted message in the existing account-scoped display continuity service before Draft promotion. The handoff is synchronous, memory-only, bounded to 64 Threads and keyed by Host/Thread. Pending presentation and the retained message share submittedMessageDisplay. A newly mounted Thread keeps this paint-only message through an empty authoritative baseline until a canonical user message arrives, without a cold-history spinner or an extra syncing notice. Real recovery errors remain visible. Old cold Threads still use normal recovery presentation. Account changes replace the service and discard all transient handoffs. Preview data never authorizes commands, acknowledges reads, restores Replica cursors or persists unconfirmed input; Resume/Replica and first-Turn retry ownership remain unchanged.

OpenCraftComposer selects its layout from composition: context chrome requires stacked context, input and footer rows, independent of whether the draft is empty. Composers without context chrome retain the automatic single-line empty touch presentation. Editor focus expands the empty automatic touch presentation; context chrome still requires stacked rows. Model and permission controls belong to the normal-flow footer, whose real width owns progressive disclosure; they are not absolutely projected into the context row. The same editor, selection state and menus stay mounted across typing, clearing and viewport changes. Draft and Conversation share Shell floating chrome, so the Home does not retain a separate opaque toolbar band above the keyboard.
In short visual viewports, the Home grid reserves the Composer’s measured content height instead of fixed hero/composer row minima, keeping the send action above the keyboard.

### Product desktop composer shortcut

The desktop panel adapter owns availability and launch authority. Installing it does not opt the workbench into a composer shortcut. A containing product may explicitly enable `WorkbenchPresentationPolicy.composerDesktopEntry` and include `opencraft.cloud-desktop.open` in its panel actions; full and generic embedded presentations leave the shortcut disabled by default.


## Owned Composer naming

The shared editor lives in `@opencraft/composer-editor` and exports
`OpenCraftComposer`, `OpenCraftComposerHandle` and `OpenCraftComposerProps`.
Its DOM/style namespace is `opencraft-composer`. The naming migration changes
no draft, selection, queue, submission or lifecycle ownership. Runtime consumers
and existing smoke selectors move together; Codex AppServer wire identifiers
remain external integration contracts.

### Pasted multiline JSON

The shared document compiler recognizes complete multiline JSON objects, arrays
and a single named object/array member before Markdown indentation splits them.
Plain introductory and trailing prose remain separate reading content. The JSON
uses the existing code surface with the `json` language; its text and canonical
source remain unchanged. Recognition validates structure without repairing or
reserializing it. Explicit fenced code retains its declared language, while
inline, invalid and incomplete JSON keep ordinary Markdown semantics.

Program statement prefixes and call/statement suffixes are excluded from bare
JSON recognition. Failed outer candidates are scanned once, without repeatedly
parsing each nested suffix.

Streaming input containing object braces follows the existing full-parser
fallback: a later closing delimiter can promote previously separate Markdown
blocks into one JSON surface, so those prefixes cannot be frozen early.

### Initial user echoes and explicit steering acknowledgements

User-message normalization may associate the initial params input with an echo
following only allowlisted setup events (approval review, compaction, fork,
model/reroute/personality, remote task and worktree initialization). The first
other Item is an ownership boundary, even if a later message matches. Reuse
retains server sender, attachments and source identity while params own ordinary
composer content. Without params input, worktree initialization does not close
the leading historical user segment. Steering echoes may match an explicit
server message ID even when Host-enriched text differs and client ID is absent;
only earlier eligible local rows receive acknowledgements. A stored server ID
survives a history gap, and declined/backward rows remain separate.

The dictation waveform consumes the live `prefers-reduced-motion` media query.
Reduced motion paints a static minimum-height signal and suppresses sample-driven
repaints, while bounded sample collection and recording controls continue. A
preference change redraws once, and disposal releases the listener with the
subscription, observer and pending frame.


User-message acknowledgement preserves the saved params `clientId` alias when
`clientUserMessageId` is absent, and saved steering may use `content` when `input`
is absent. Host-staged display spans accept both `text_elements`/`textElements`
and `byte_range`/`byteRange`, as the typed message projector does. An enriched
server echo must remain one message with its original attachment card and
source anchors; accepting saved field spellings does not relax the exact UTF-8
span or legacy locator checks.


The shared user-input readers accept a single typed content part as well as an
array, matching the message projector and saved history input contract. Text
comparison and image counts must not collapse a typed object to an empty input;
unrelated local steering and server messages retain separate identities. The
same single-part form participates in exact Host display-span recognition and
realtime delegation parsing, so voice envelopes remain typed transcripts rather
than literal user markup. Unsupported part kinds remain ignored.



Ordinary Web code captions stay in the surface's normal stacking order so touch
scrolling repaints their language label and controls together with the code.
Only the explicit sticky-header variant receives an elevated stacking level;
source, wrap, copy behavior and surface geometry remain owned by the code frame.


### Composer model menu close continuity

The quick reasoning view and model list share one native Radix menu. Keep the
current view mounted while the menu closes so its exit animation can finish.
Reset the model-list view on the next opening, rather than changing the content
class during the closing animation. Escape, outside dismissal and touch editing
retain the same focus owner; reopening starts at the quick reasoning view.
The original Composer smoke exercises native menu close with motion enabled.

Keyboard reopening checks wait for the native close-focus cleanup to restore
the trigger before sending ArrowDown; menu disappearance alone does not signal
that deferred native focus cleanup has finished.

## Composer connection warning material

The shared Composer projects the host's read-only `isUnstable` state to its
`data-warning` shell attribute. Workbench derives it from the existing active
conversation recovery presentation and diagnostic: actual reconnection, an
observed transport/history failure being retried, or terminal failure. Initial
connection, ordinary history activation and cached-history refresh project the
existing `isRecovering` state to `data-loading` while no warning is present.
This routine loading uses a much fainter static red wash (1–2.5% semantic danger
color, 7% inset rim, no outer glow) than reconnect/failure (2.5–6.5%, 17% rim).
Warnings take precedence; ready conversations and new drafts stay neutral.
Normal AI execution does not activate either recovery tint.
Only the existing material pseudo-element receives a static low-saturation red
tint and faint inset rim using the semantic danger token. Background opacity is
constant: no breathing, blinking or scaling. Text, caret, controls and geometry
stay unchanged. Recovery scan and existing diagnostic/retry controls retain their
own lifecycle and meaning; the tint does not change admission or replay execution.
Forced colors use a system-color outline instead of relying on red. Existing
reduced-transparency material fallback remains in force. No timer, remount or new
mutable connection state is introduced.

## Composer execution material feedback

The shared Composer projects its existing `isStreaming` state to a paint-only
`data-breathing` shell attribute. In touch density, only its existing material
pseudo-element changes opacity from 1 to 0.92 and back over 5.6 seconds with
ease-in-out timing. Desktop input material remains fully opaque during execution
as well as idle; queue and goal rails retain their separate glass treatment.
Editable text, caret, actions, outline, shadow and layout stay fixed. Recovery
feedback takes precedence, so `isRecovering` suppresses execution breathing without
changing either lifecycle. Idle/settled, reduced motion, reduced transparency and
forced colors retain the ordinary static material. No timer, remount or execution
state is added; every existing Composer consumer shares the same projection.


The bounded display snapshot reserves half of its 24 message slots for recent
user messages, final replies and text with known clocks, then fills the remaining
slots from the latest activity. It retains source order. Long active reasoning
must not evict the question, dated replies or already completed work clocks;
activity remains static and never restarts a running clock.

An authoritative worked/stopped interval with an observed end is static even if
its final reply is still arriving and the Turn remains active. Preserve that
interval with the reply. Never persist a working interval or infer an end from
the active Turn's aggregate duration.


A provisional history window can regroup or omit cached messages. After exact
message metadata is merged, a preview that still loses a known cached date,
completed interval or static duration keeps the previous display until authority.
A compatible preview can update its text immediately; authoritative history can
always replace the display and correct or remove clocks. This selection is
account/Host/Thread scoped and never grants execution authority.

A completed history may provide only aggregate duration, without observed work
start/end clocks. The shared presenter retains a previously visible aggregate label through
paint-only displayDurationMs when tool/reasoning bodies were omitted. Hidden
activity cannot acquire a label on reload merely because Turn duration exists. Web and Expo render a
static label and the same full-width rule/header geometry as completed history,
without inventing a work interval or an empty disclosure. The static header has
no disclosure button or chevron; authoritative work bodies restore that action.
An active Turn's aggregate duration is still not persisted.


## Inherited Fast status in compact input

Read-only Side Chat model status follows the child execution snapshot, including
Fast. In the empty, unfocused touch layout, the metadata group is hidden and the
shared collapsed Fast slot preserves that status. Expanded and desktop layouts
use the metadata group, leaving exactly one visible Fast indicator. Enabled Fast
uses the shared LightningIcon `filled` variant; an SVG parent fill cannot override
the glyph's explicit path fill. Folding keeps the original editor and read-only
submission still strips local selection overrides. The existing model-hydration
smoke covers both layouts and actual light/dark appearance preferences.

Inherited Fast status uses the effective execution tier and the same selected-tier
metadata as the editable model status. Host tier IDs are opaque: a declared
tier named Fast keeps its indicator even when its ID differs. A retained local
draft choice cannot enable Fast when the effective read-only snapshot is off.

### New conversation submission presentation

While the immutable first Turn awaits authoritative Thread binding, the shared
PendingConversationPage shows the submitted message and attachments without a
startup status row or spinner. A rejected submission still exposes its error and
explicit retry action. This presentation does not change creation, binding,
queuing, or the Conversation footer's ownership of follow-up input.

## Composer image attachment preview

Draft image thumbnails open the shared zoomable image viewport in a Radix modal.
The gallery derives resources from the existing attachment session and identifies
selection by draft and attachment ID, rather than array position. Preparing and
failed uploads retain their local preview; removal and retry remain separate
controls. Opening, navigating and dismissing never stage, remove or submit an
attachment. Switching controller/draft, clearing, or removing the selected image
closes its view; late completion cannot reopen it. Preserve the editor instance,
ProseMirror selection and draft. Pointer entry from the editor returns focus to
that editor; keyboard entry returns to its thumbnail. Stale draft cleanup never
focuses a replacement editor. Embedded consumers supply their presentation root
through the existing Composer portal container.

## Optional browser image editing

The trusted `imageEditor` contribution supplies a View through `ImageEditorContext`.
The independent image-editor plugin owns local drawing, emoji/text placement,
crop/rotation, pixelation and operation history. Composer supplies only one image
source/name and a guarded File result port. It keeps the existing gallery/modal,
portal and return-focus ownership; absence or deactivation of the contribution
leaves ordinary preview available. The plugin has no controller, Host or submit port.

Done exports composited PNG pixels and replaces the selected draft attachment in
place through AttachmentPreviewSession. The session validates active draft,
attachment and source, retires its old upload/preview, clears old resource metadata
and starts normal preparation for the derived File. Failed preparation retains the
new local image for retry. Cancel, Escape, removal, source replacement or draft
switch discard the transient editor; late exports cannot write into another draft.
One completed stroke, text/sticker placement, crop or quarter turn is one history
step. New operations after undo retire the redo branch. Pointer cancellation drops
an unfinished gesture. Input coordinates use current image pixels; viewport fitting
does not change export resolution. Oversized/unsupported images fail locally while
preserving the draft; the editor does not load a remote/native editing fallback.

Touch editing separates document and viewport intent: one pointer edits; a second touch cancels the incomplete operation and begins bounded pinch/pan until all fingers lift. Text/stickers commit on release. Zoom/pan and fit do not enter undo history or change export pixels. The modal owner follows visualViewport for mobile keyboard placement; the plugin uses shared mobile-input typography, safe-area spacing and 44px minimum targets.

Image editor styles are delivered as trusted scoped CSS with the optional contribution and mounted only inside the preview presentation root, including ShadowRoot consumers. They do not enter startup app CSS; existing theme tokens still resolve from the host.


Image annotation text is entered at the tapped image position with a native multiline textarea for caret, selection and IME. It remains a local pending operation until confirmed or a tool/save action commits it once; Escape discards only pending text. View resize keeps native image coordinates and text. Normal editing shows tools without permanent instructions or a filename; accessible names and error feedback remain. Image editor interface glyphs use shared original artwork, including the pixel mosaic; sticker content previews are not interface artwork.


### Engine-owned Skill candidates

Composer includes the selected draft model in Skill catalog queries. Existing
conversations always name their thread, whose engine cannot change. Negotiated
`opencraft/scoped-skill-catalog` v1 Hosts route `opencraft/skills/list` to that
owner (or the Host default for an unselected draft), never combine directories.
The Host removes routing hints before calling native legacy `skills/list`.
Native single-engine Hosts retain their upstream request shape; older multiplexed
Hosts without scoped discovery report unavailable until upgraded.

Client cache and in-flight suggestion identity include the scope. A model change
invalidates the visible candidates while preserving the Composer document and
focus; late previous-engine results cannot replace the current list. Pi uses its
native `loadSkills` roots, precedence, diagnostics and paths; explicit-only skills
remain user-selectable. No skill body is included in the catalog. Selection
inserts canonical name/path, and Pi validates retained references against the
current native registry before loading instructions or admitting inference.


## Local document persistence and offline restoration

Conversation draft continuity and Bot Composer draft storage share the platform
client-resource adapter while retaining their independent existing input owners.
Web/PWA uses IndexedDB; Electron uses named Main SQLite ports. Async hydration
only replaces untouched initial content. Accepted write is the custody boundary;
quota, schema/CAS conflicts or revoked scope cannot silently clear input. Legacy
localStorage/sessionStorage is migrated per record only after accepted import.
Null tombstones prevent resurrection if a legacy removal failed. Web acceptance
is not a promise against iOS/browser eviction.

Persisted conversation keys retain editor-slot and semantic-target identity.
A fresh document with no history owner reference restores the most recently
accepted nonempty slot for that target, rather than cloning its document into a
new owner. Explicit valid history references and independent slots remain intact.
Local presentation can resume before Host recovery; reconnect never restores an
execution lock. Account changes fence pending restoration.

The existing message outbox now hydrates and serializes mutations asynchronously.
It awaits accepted waiting writes before reporting custody and accepted sending
writes before transport. Restored sending becomes unknown; exact proof may retire
it, but no automatic retry is permitted. Remembered account partitions only enable
local read/edit; verified identity, live Host/baseline and existing send admission
remain required. This does not add a generic command or background-sync layer.


### Native contact retirement for input actions

Shared menu triggers defer touch activation to native click. An incidental
ancestor scroll does not independently reject a click the browser accepted;
pointer cancellation, multiple contacts and context-menu gestures still cancel
activation. The microphone button retires its pending hold on native touch end
and cancellation as well as pointer release. A completed short contact must not
leave a timer that starts recording over the editor later.


## New Draft creation after rejected Host admission

A New chat creation may join its existing Host connection owner and retry once
when the Server explicitly rejected the request before native forwarding. The
same immutable intent, Draft and attachments survive this recovery. Capability
lookup preserves this typed rejection so a stale lease cannot leave the Draft
stuck behind a generic model-capability error.

The command port distinguishes a rejected first creation from a later rejected
Turn after `thread/start` or `thread/fork` already returned. The latter keeps
`SubmissionOutcomeUnknownError` and cannot restart creation automatically. Other
pending writes, timeouts, lost acknowledgements and legacy untyped failures never
inherit no-dispatch proof. Retry failures are presented by the Draft owner rather
than escaping the button handler as unhandled Promise rejections.

### Engine-scoped recovery prerequisites

A mixed Host advertises default-engine extensions and a complete extension set
for each alternate engine. Approval baseline reads and native wait reattachment
must resolve the original Thread's engine before using shared interactions.
An engine without shared interactions skips that read; it must not inherit the
default engine's capability and repeatedly fail history recovery. Engines that
advertise shared interactions still restore their pending approvals before the
Replica grants sending authority. Transport recovery, watched history, and exact
outbox acknowledgement remain owned by their existing services.
