# ChatUI integration architecture

## Browser-local input drafts

`ComposerStoreServices.drafts` is a platform-neutral content storage port;
`BrowserComposerDrafts` adapts browser localStorage for Bot input without server or
device synchronization. Task input slots use an account-bound
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
Evicting the presentation after 20 inactive Views releases Scope/UI resources,
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
and `smoke:task-draft-switching` (real CodexComposer, synthetic remote boundaries).
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
Tests: `tests/chat-browser-drafts.test.ts`, `npm run smoke:browser-drafts`.

Thread identity, execution activation, capability leases and revocation follow
the [execution ownership contract](execution-ownership.md), including its
explicit distinction between implemented coordination and pending delivery guarantees.

## Target

OpenCraft uses the latest Codex AppServer `Thread -> Turn -> Item` protocol. The
AppServer remains the business write authority. ChatUI consumes one normalized
Conversation Read Model: a V4 ReplicaClient for a V4-native Authority, or a
snapshot-oriented compatibility projection for Codex V3 Resume. Web and Native
surfaces share identity, projection, runtime commands, Composer documents and
design tokens. They do not share a renderer or editor implementation.

For a LightVela Hermes Host, the Web Composer offers `/new`, `/compress`,
`/status`, `/usage`, `/stop` and `/help` in its input footer and slash suggestions.
Choosing a shortcut inserts editable text into the current Draft; only explicit
submission executes it. Ordinary shortcuts use Hermes `prompt.submit`. A standalone
`/stop` uses the Hermes Host `hermes/stop` request instead: it interrupts the active
Turn through `session.interrupt` when one exists, then calls `process.stop` to kill
running background processes. An idle or new chat still calls `process.stop`.
The Composer Stop button continues to use `turn/interrupt` only. Other Hosts
retain their own suggestions and have no Hermes shortcut menu.

## 跨桌面、手机和平板的会话连续性

Conversation Scope 是会话身份，View 是具体窗口或页面的呈现与滚动状态；任务输入槽位以 View ID 标识，但其 Application 级草稿所有权独立于页面缓存。`workbench-runtime` 的 `ConversationDraftOwnerRegistry` 保留原 Controller 与附件资源，`ConversationDraftContinuity` 管理同一输入槽文档的保存、恢复、发送成功后的丢弃和迟到读取仲裁；平台只提供本地存储。移动端用 SQLite，并以区域、凭证摘要和 Bot 实例/Profile 分区；Web/Electron 用浏览器本地存储，并以产品和账号服务的凭证作用域分区。退出登录或切换凭证时撤销旧存储、清除所有草稿所有者及其内部目标缓存，包括已无页面的草稿。附件与临时文件引用不从文档缓存恢复；会话切换保留内存附件不等于刷新恢复字节。

`ConversationReturnProbe` 统一短暂离开、较长前台恢复和断网恢复的触发条件。iOS 把 AppState/Expo Network 事件交给它，Web/Electron 把 visibility/online 事件交给它；真正的追平仍调用当前 Thread lease 的 `retryRestore()`。追平不创建新会话，不重置可读历史。已经显示的内容是否权威，仍由 Replica/Session 决定。

手机、iPad、折叠屏和桌面共享上述身份及状态转换。屏幕宽度、安全区、键盘和指针决定各自布局，不决定另一套业务流程。V3 ThreadView 的 revision/epoch 属于连接代次，不能把它写进持久 Replica 检查点。`ConversationDisplayContinuity` 只从权威时间线保存有界、已完成的用户消息与回答文本；冷启动重建 `painted / authoritative: false` 的只读 Timeline 供两端原有渲染器展示，当前 Host 恢复后整体替换。工具、审批、附件、交互以及 Replica 游标不进入展示缓存，不能从该缓存授权发送或其他操作。缓存按账号、Bot/Host 和 Thread 分区，并在退出登录时清除。

会话定位共享 Turn 身份、最小时间线 revision 和对齐意图。Web 与 Native 都先挂载目标 Turn，等平台实测高度进入虚拟布局后才滚动；用户接管或 View 卸载会取消等待。两端用户消息使用共享 `getTimelineUserMessageTargetKey` 的 Item 锚点；Web 注册 DOM，Native 注册当前挂载行的局部布局。投影确定目标不存在时返回 unavailable；目标存在但尚未测量时继续等待，不能用经过几帧或整条 Turn 的估计位置冒充精确命中。Native 行高度是否已测量与项内锚点是否已注册是独立事实。

Native 远处定位使用两个有界挂载窗口：保留当前可见行，同时挂载目标邻域测量；行按共享布局的绝对 top 放置，重叠行只挂载一次，窗口之间的历史不挂载。执行位置写入后才切换可见窗口。平滑定位只允许请求发起时已挂载且距当前位置不超过一个视口的目标，动画期间可见窗口跟随平台实际位置。`NativeTargetPositionTransaction` 持有语义目标的布局签名和本次请求坐标；内容、锚点、视口或底部占位变化时重新求值，已开始的动画使用瞬时校正收尾。完成依据当前布局与当前位置的匹配，不永久等待旧坐标；目标删除、取消和卸载均释放订阅及帧回调。

虚拟窗口在折叠、历史插入和恢复首帧时必须覆盖当前距离对应的可见 Turn；保存的窗口只能在仍覆盖可见区域时复用。测量批次一次提交高度表、窗口和滚动目标。Web 以当前 DOM 节点、Native 以当前挂载行的测量租约识别高度来源；卸载行及旧实例的迟到回调不能写入新窗口。Native 在内容高度改变而距底部数值不变时仍要于内容尺寸提交后重写物理偏移，保证插入于视口上方的历史不把屏幕推走。用户触摸会中断待执行的自动定位。
滚动帧只更新当前距离与有界可见窗口；完整 Turn 高度快照在离开会话时按需生成。Native 父容器持有可在虚拟列表卸载后调用的捕获函数，避免每次滑动都遍历整条时间线，也避免子组件 ref 先释放时丢失恢复状态。
Native viewport owner 在视口高度变化及没有位置写入的内容尺寸提交时发布同一份几何事实，控制器与虚拟列表不能等下一次滚动事件才同步；几何发布不消费待提交的内容恢复事务，也不触发用户接管。启动尚无内容尺寸时保留初始恢复意图。

用户消息折叠资格只由已确认的自然高度决定。Web 持续观察内层内容尺寸；Native 在内层未裁剪时接受后续 `onLayout`，折叠后只接受超过已确认自然高度的增长，拒绝可能来自裁剪的缩小值及旧内容身份的迟到布局。宽度变化会使旧自然高度失效并重新测量。Native 测量绑定内容、宽度代次、原生节点及挂载生命周期；`measure` 的异步返回使用启动时的观察器，并在回调和状态提交时复核代次。即使宽度由 A 变为 B 又变回 A，旧结果也无效；重测不依赖 RN 再次发送相同尺寸的 `onLayout`。

```text
WebSocket / Replay Transport
          |
Codex AppServer protocol
          |
Conversation Read Model
V4 ReplicaClient or Codex V3 compatibility projection
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

## Non-negotiable boundaries

### Thread goals

Sidebar Thread menus contain Thread-scoped mutations only. Creating a new task
and opening Host settings remain ordinary application navigation; neither is
advertised as a Thread menu action.

A Goal is durable Codex Thread state, not a Composer draft or a Web timer. The
Codex AppServer owns objective, status, and usage counters. The Codex Host
advertises the supported Goal methods, keeps a replaceable index of active
Threads, and owns continuation after Turn completion, including when no browser
is connected. Queued user input has priority over autonomous continuation;
continuation is serialized with other per-Thread Host operations. The DSH Host
currently advertises read-only Goal support, never a simulated write path.

Workbench Runtime owns a per-Thread Goal resource: get-on-view activation,
notification projection, revision-fenced reads, reconnect invalidation, and
single-flight writes followed by a confirming read. A failed confirmation is
not reported as success. Web owns only disclosure and an unsaved editor draft;
its card cannot schedule a Turn or become a second authority for Goal state.

When a writable Thread has no goal, its creation entry is a standard item in
the Composer's Add menu, not a separate capsule above the editor. The Goal
surface supplies this action to the existing menu and retains ownership of
the editor draft and dialog. Existing goals keep their status and progress
surface. Read-only or unavailable Threads do not advertise creation; switching
Threads resets the local editor without remounting the Composer. Menu actions
can supply a scope-fenced continuation to the Add menu's close callback: Radix
finishes its focus cleanup before a target dialog opens, rather than racing two
focus scopes or relying on an arbitrary delay.


### User message code-block sizing

The Web user-message bubble owns its content-sized width and maximum width.
Fenced code inside it must participate in intrinsic width sizing, including
when the fence is the entire message; an inline-size containment used by the
shared code renderer must be lifted only at this bubble boundary. Long code
remains within the bubble's maximum width and scrolls in the code block's own
scroller. Empty-message presentation is based on actual text presence, not on
whether Markdown happens to produce visible inline prose. The shared code
renderer keeps its containment for assistant prose and other full-width hosts.

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

### Changed-file review

The Turn's existing unified diff remains the read authority for its changed-file summary. ChatUI renders a lightweight in-progress entry and a completed resource card; it only emits an open intent. In the Web Workbench, the actual Composer owns the active Turn's live entry above the editor, including when that Composer floats over a panel. Its exact Turn identity suppresses duplicate live resources in the main and mini transcript; it is presentation routing, not a second execution or resource owner. Standalone Conversation consumers retain inline presentation. On completion, the same resource appears as the transcript's completed card. The Workbench owns the read-only Review dialog, keeps it tied to the active Thread, and projects the current Timeline block while streaming. File selection filters that existing diff for display; it does not create a second TurnDiff model or mutate the workspace. Undo/Reapply is not advertised until a real Host apply-patch capability is connected.

The Web resource presentation follows Codex 26.930.31428/build 12913's original
Renderer, not recovered analysis modules: square-plus-minus glyph in a 40px
slot, 12px header padding, 10px gaps and theme-owned `radius-lg` (10px in its
default theme). The title uses chat typography; both signed counts are shown,
including zero, in chat-minus-one typography with tabular digits and 4px gaps.
Running counters retain columns and animate their transform, with reduced-motion
support. Completed multi-file cards show three 36px rows by default and an
explicit expanded state; disclosure reflow belongs to the viewport owner.
The shared outline toolbar Button emits “View changes”. Desktop hover offers
an interactive live file list or a bounded small-file diff preview after 800ms;
more than 5000 rendered/change lines bypass inline preview. File clicks close
the live list before opening Review. Modifier-click opens a file only when a
real resource opener exists. Touch does not force hover copy or browser rings.
Diff sections are indexed once per completed resource revision, not reparsed
for every filename. These are Web adapter details; Native preserves its own
touch surfaces while sharing the Turn resource and Review intent.

The aggregate is a **Turn-owned resource**, not an ordered transcript Item.
`chat-runtime` passes `unifiedDiff` separately from source Items; `chat-core`
projects it as `changeSummary` metadata and the assistant presentation plan's
fixed resource surface. Its stable identity is `${turnId}:turn-diff`, without
source Item anchors. Web and Native render that surface separately from ordered
slots. Arrival, update or removal cannot end an Activity segment, alter its work
clock, qualify a final answer, claim Thinking ownership, or move a response.
The live Review lookup includes this resource; ordinary transcript Blocks are
not a second read authority. A resource-only recovered Turn may have an empty
carrier Frame, never a fabricated message. Inline resource surfaces count toward
the virtualizer's top-level geometry; Composer-routed live resources count toward
footer geometry instead. Neither becomes a latest activity follow anchor.

Old `turnDiff` Items are lowered at the shared projection boundary and excluded
from transcript/work-status derivation. An explicitly supplied Turn value,
including null, wins over those compatibility Items; a null canonical `diff`
also wins over a stale `unifiedDiff` alias. This is a narrow compatibility path,
not a new generic resource registry or another persistence store. Regression
tests cover running diff updates, later work, saved collapse choices, reload,
final answers, resource clearing and completed Review cards. The browser fixture
uses the real Conversation and Review dialog in desktop/mobile-width light/dark
views; it is not a production deployment or native-device acceptance claim.

Changed-file row geometry belongs to its renderer: line counts retain their intrinsic width while the path consumes the remaining space. The directory yields first to the basename, but the basename is capped at its path slot and truncates when even the filename cannot fit. Neither path segment may paint over the counts. Truncation affects presentation only; the complete path remains the accessible row label and Review target. Regression coverage includes long basenames without directories, deep directories, both counts, narrow containers and expanding/collapsing the file list.

Skill autocomplete treats a bare `$` as catalog browsing, not an empty file
search. The Composer, runtime catalog and Skill search share this policy;
`@` remains query-gated. Skills are scoped to the current Host/root set,
enabled-only and deduplicated by authoritative path. Empty queries retain
source order; typed queries match canonical name, display label and path.
Discovery errors are rejected before query caching rather than stored as a
successful empty catalog. A Host returning no metadata is not supplemented
with renderer-local or fabricated Skills.

The picker displays loading, unavailable/retry and no-results states, supports
wrapped arrow navigation (and macOS Ctrl-P/N), Enter/Tab insertion and mouse
selection, and never submits while a Skill picker owns Enter. Escape/blur
dismiss the current match without deleting its text; changing the match may
reopen it. Unmatched queries containing whitespace dismiss as in the Codex
reference. Selected text and code blocks do not activate the picker, and IME
commit does not select or submit. Async results carry catalog, target, query,
retry and controller ownership; stale completions cannot become selectable.
Inserted resources retain canonical Skill name/path through the document
codec and native AppServer UserInput compiler.

`smoke:skill-autocomplete` tests the real ProseMirror Composer with a synthetic
Host catalog in Chromium or isolated Electron. This proves the interaction and
protocol payload, not remote Skill installation or model execution.

Model-response URLs are resources, not page-local anchors. `chat-document`
preserves the model-authored paragraph/heading/list/table structure and raw
Markdown label; `chat-render-react` alone classifies and sanitizes the target;
the Web renderer projects an allowed HTTP(S) target as a Codex-style inline
mention with origin favicon, globe fallback, URL tooltip and Radix context
actions. It never demotes a heading merely because its child is a link.
Restricted or unsafe targets receive no href, favicon request or open action.

During streaming, a changed URL remains inert for 500ms before it receives an
href or begins remote favicon loading, and the prior href cannot remain active.
Opening is a semantic `ChatResourceOpenIntent` (`target`, `disposition`,
`source`): the Renderer reports ordinary, modifier/middle-click and context-menu
intent while the Workbench Browser owner chooses the physical in-app or external
surface. Copying uses the sanitized target. Favicon pixels, tooltip state and
menu focus are presentation state only and never enter Timeline, Replica or
history. `smoke:url-presentation` verifies the real renderer, heading
preservation, fallback favicon, tooltip, menu, clipboard and delayed streaming
activation in Chromium.

React Native consumes the same list and resource decisions. Ordered Markdown
lists retain their authored start number; task items use checkbox markers.
Both renderers resolve links, workspace references, citations and images through
the same priority-ordered resource policy service. Their standard URL policy
is registered as a fallback, so Host restrictions and rewrites apply before
either platform performs an open or media load. Image-only data URLs remain a
local media exception and do not become navigable links.
On Native, a Host resource denial is final: a denied HTTP(S) link cannot fall
through to the system browser. The system URL opener is only a fallback when no
Host opener owns the action and the resource policy allows the target.
Nested unordered lists use the Web marker progression (disc, circle, square)
and nested spacing; user-message lists keep their compact Composer rhythm.
Tables keep the authored rows and column alignment on both surfaces. Web uses
its dialog to expand a wide table; Native uses a full-screen preview with its
own horizontal and vertical scrolling, sized from the actual container so the
same content works on a phone or tablet. Both keep the original Markdown copy
source available from the inline table.
Native task items use the same compact, read-only checkbox geometry as Web;
ordered markers reserve one shared column width across digit boundaries.
The shared renderer call also carries neighboring node kinds so Native can
apply the Web user-message paragraph rhythm without adding a trailing gap.
It also carries the next document node: Web and Native use one Han-text test
to tighten adjacent root paragraphs, while first/last heading and divider
margins follow the same document-edge rules.
Native Markdown images retain their intrinsic ratio within the current
container and use a document-scoped native preview for adjacent images in
source order. Its modal exists only while previewing; no browser page or
conversation route is created.
Native links stay inside the surrounding text flow and share the 500ms
streaming URL settle rule. The native shell can open HTTP(S), mail and contact
links directly; workspace files, app routes and other resources require an
explicit Host opener and are otherwise inert. Native images accept HTTP(S) and
image data sources directly. File and resource images require the Host media
loader; when unavailable or blocked, the renderer shows the alt text instead
of attempting to load a device-local path. Physical scroll, keyboard and
viewport geometry remain the Native viewport owner's responsibility. It receives
touch-down before `ScrollView` recognizes a drag, cancelling auto-scroll and
pending layout restoration as the Web owner does on pointer-down. Only a
recognized drag changes the origin of physical scroll events to user input.

The Expo Workbench now supplies a Host opener for resolved workspace files and
external URLs. It passes the active Thread's cwd and Host identity to ChatUI,
reads file bytes through `fs/readFile`, and displays bounded UTF-8 text in a
native resource surface. It never sends a Host `file://` target to the phone's
URL handler. The Host advertises which allowed policy decisions it can open;
app routes, unsupported resource schemes, unresolved relative files, binary
files and oversized text remain unavailable until an owning surface exists.
Changing Thread or Host closes the preview and aborts its read. These resource
capabilities are independent of the renderer's URL policy and must not be
inferred from whether a URL merely parses.
The same active Host supplies raster Markdown images through `fs/readFile`,
with a shared Web/Native MIME hint and a Native 10 MiB byte bound. Only PNG,
JPEG, GIF and WebP receive a Native data source; SVG and unknown formats stay
unavailable rather than being treated as device-local files. The renderer
aborts stale reads and drops its source when its document unmounts. The Expo
loader merges concurrent reads for one Host path, retains a 10-second,
24-MiB-weighted in-memory cache, and discards it when the Host connection
generation changes. The last departing consumer aborts an unfinished read;
the cache does not authorize file access or extend a session's lifetime.
Web and Native image presentation keys include Host, conversation, cwd and
document identity as well as the resolved target. A context switch cannot
reuse the previous image's loading result or keep its gallery open while the
new Host media request settles. This applies to Markdown images, user
attachments, generated images and tool image results.
User-message image attachments, generated images and image-view tool results
consume the same conversation-media decision and Host loader. A Host file path
is never rewritten to a phone-local `file://` URI; direct HTTP(S) and image
data remain direct sources. Native preview opens the resolved image source in
the conversation's gallery when no product-specific preview owner is supplied.

Web and Native derive file citation labels/targets and workspace mention
targets from one renderer-neutral model. Native presents workspace mentions
as inline code and file citations with a separate citation tone; it makes
either actionable only when the host supplies resource navigation. External
Native links use system long-press actions; a delayed action must still match
the current settled URL before it opens or copies anything.
Image-bearing Native paragraphs keep prose in selectable text runs and place
images in block containers so the text engine cannot collapse their layout to
an inline placeholder. In the iOS drawer host, code/table/math surfaces retain
a horizontal stroke only while their measured content exceeds the viewport;
short content leaves the stroke to the drawer. Before measurement completes,
the local scroller retains the stroke so wide content is not stranded.
Native user bubbles compile with the same `user-message` dialect as Web,
including Composer link and adjacent-list rules; assistant output continues
to use the assistant dialect.
Native list-item paragraphs and quoted paragraphs follow Web's child spacing:
the list or following block owns its own gap, and quoted paragraphs have no
extra margins. At the document level, heading and rule leading margins account
for the previous block's trailing margin because RN adds margins where CSS
collapses them. User-message paragraphs and lists have no trailing margin, so
their following heading or rule keeps its full leading space.

Code fence language labels, wrap policy and wrap preference come from the same
renderer-neutral model on Web and Native. Native keeps horizontal overflow
inside the code surface and offers code copying. Native tables retain Markdown
column alignment and one width per column across every row; columns fill their
actual container until the minimum readable width requires local horizontal
scrolling. Both platforms copy the table's canonical Markdown source, while
their preview controls remain platform-specific.
Unspecified table-cell alignment and prose/heading writing direction are
natural rather than forced LTR, matching Web's `dir="auto"` intent; explicit
Markdown column alignment remains authoritative.

Web and Native code fences now consume one Shiki grammar registry and Codex
syntax theme. Web turns that result into HTML; Native projects its token colors
and font emphasis into selectable `Text`, preserving exactly the original code
string, wrap mode and horizontal scroll geometry. Native delays enhancement
until a complete fence is present and caps tokenization at 12,000 characters;
larger or still-streaming fences remain plain text. Highlighting is presentation
only and never changes the copied code or Timeline content.

Complete Mermaid fences share Web's source preparation rule. Native reads a
bundled, offline renderer only when a diagram is present and runs it inside a
network-disabled WebView document; this is a document renderer, not a page
navigation or a second Bot runtime. The transcript keeps a bounded preview
slot, and a native full-screen viewer owns panning and source inspection.
Invalid, oversized, streaming or failed diagrams stay readable as source code.
The HTML asset and Mermaid library are packaged with the app; the document
cannot fetch scripts, fonts, images or data from the network. Each visible
diagram currently owns its own WebView, so long conversations with many
diagrams require device memory and scroll testing before calling it equivalent
to Web. Display math uses a separate packaged, network-disabled KaTeX document
with embedded fonts and the same `renderToString` safety options as Web. Its
horizontal overflow belongs to the formula surface and its measured height is
bounded in the transcript. Inline math remains in Native `Text` as readable
source because RN text cannot host the DOM typesetter without breaking inline
flow and selection; a true inline equivalent remains open work.

Open pickers subscribe to catalog invalidation. Host/root/revision query keys
prevent pre-change RPC completions from entering the new directory. Browsing
does not silently truncate at 50 entries. Search normalizes path separators and
Unicode compatibility forms and requires every query word to match a name,
display name or path. Icons accept explicit HTTPS or raster data URLs, never a
remote filesystem path interpreted as a renderer-local file; text and icon
fallbacks remain usable. Skill status/scope text uses the shared i18n port.

The Local DSH adapter validates explicit name/path against the executing Agent's
registry and user-invocation permission through the private capability bridge,
then lowers each reference to DSH's native `/name` user gesture. The installed
`dsh-tool-skill` pre-step hook loads and injects the full instructions. Missing
loader, unavailable Skill and changed path fail closed; `turn/start`, steer and
queue paths share this lowering. This uses native Skill semantics rather than
asking a model to infer instructions from labels. Native gesture history remains
owned by DSH. Tests execute the installed native pre-step handler without a
provider request; no live inference outcome is implied.

Profile-scoped Hermes Hosts implement `skills/list` using `/api/skills` plus
bounded-concurrency `/api/skills/content` reads for authoritative paths. Content
bodies are not returned in the directory. An unscoped instance Host requires
Profile selection instead of guessing a default. Submit/steer revalidate selected
Skill enablement and path in the owning Profile before invoking Hermes' existing
slash Skill behavior. Profile management change events invalidate Composer
catalogs; old dashboards that omit canonical paths report metadata errors.

DSH terminal adaptation follows the HyperNode reference contract: completion,
interruption and failure notifications are lifecycle summaries (`itemsView:
"summary"`), never empty full Item snapshots. Full membership belongs to
history reconstruction. Visible reasoning, assistant and tool Items settle
before the Turn; only explicit completed output receives final-answer phase.
Like Codex, `final_answer` is an optional Item rather than a prerequisite for a
completed Turn. A Turn with settled commentary or tool activity may complete
without fabricating an answer; a completely empty completed Turn still fails
closed as a provider/runtime contract violation.
Aborted/interrupted runs retain partial output with final-answer phase, blocked/max-token/unknown
terminal reasons fail closed, and failures emit a typed error before completion.
The same terminal policy is consumed by live and history projection.

DSH steering has three distinct ownership states. `queued` remains an editable
next-turn occurrence, `steering` is Host-accepted user input waiting for the
active Turn's next step boundary, and the matching durable `user/message` owns
the transcript after AgentLoop claims it. The Local Host returns a steer command
when the unary DSH RPC accepts it; it must not wait for a later `session/queue`
snapshot or claim event. Conversation Runtime moves a strict queued steer into
the active Turn immediately, then reconciles the optional authoritative
`steering` projection by client-message identity so reconnect and durable handoff
produce neither a blank interval nor a duplicate row. This does not redefine
steer as a hard interrupt: the current provider request and tool step remain
owned by DSH and may finish before the next-step inbox is consumed.

The standalone main conversation defaults fresh follow-up input to direct steering during
an active response. Chat settings can persist `queue` instead through
`UiPreferencesRuntime` (`chat.defaultFollowUpAction`, installation scope). The
LightVela embedded conversation defaults to `queue` while a response is active,
independent of the standalone preference.
Ctrl/Cmd+Enter temporarily chooses the opposite action; idle input still starts
a normal response. A preference change does not replace the Composer document,
editor or selections, and submission rechecks the actual active Turn. Side Chat
retains direct steering because it does not own a durable next-turn queue.

Queued-message steering is gated by the Host's
`opencraft/thread-queue: { version: 2, atomicSteer: true }` declaration. DSH
provides the one native `session.updateQueue(steer)` operation. Stock Codex
AppServer 0.156.1 has `turn/steer` for fresh input and `thread/queue/start` for
an idle Thread, but no `thread/queue/steer`; its queue also auto-dispatches at
idle. Therefore a Codex queued message cannot safely be converted to an active
steer by composing `turn/steer` and `thread/queue/delete` in the Client or Host.
The Codex Host now owns queued input in its own durable SQLite store. It claims
one item before sending the standard `turn/steer` to Codex, and reconciles by
client-message ID against paged Codex user-message history. A crash or timeout
with no conclusive acknowledgement leaves the claim delivery-unconfirmed,
outside automatic dispatch; the Host never silently resends it. The user may
explicitly discard an unresolved claim after reviewing the transcript. The
Host delete request requires the original queue ID, target Turn ID and an
acknowledgement flag, checks history and rejects while the Thread is active.
For Codex queued steering, a matching `turn/steer` acknowledgement is the
admission boundary: the Host persists `steering` before releasing the per-Thread
dispatch operation, so a later queued steer need not wait for the first input
to appear in Codex history. Accepted `steering` rows remain visible for history
reconciliation but do not occupy the dispatch head. Only `dispatching` or
delivery-`unknown` rows block later admission; an unknown claim is reconciled
by client-message identity and is never retried automatically. The Composer
disables later Send/Steer and reorder while such a claim is unresolved, and
must not offer a generic Resume action behind it. Editing and removing ordinary
queued rows remain available.
Queued-message action hints use a hover/focus tooltip mounted in the Workbench
presentation root, outside the scroll-clipped queue tray. The tooltip remains
hoverable and text-selectable; native `title` is not used for these actions.
This does not prove Codex never saw the input. `unconfirmedSteerDiscard` remains
a separate Host capability; DSH's `atomicSteer` does not imply it. A failed
history read also rejects discard. Ordinary direct steering and idle queue Send
remain separate. At upgrade, native Codex queue rows migrate before AppServer
starts so two independent dispatchers never own the same item.
After a DSH Host restart, a durable local queue row without a matching native
queue snapshot is marked `restored-after-host-restart`; that item cannot be
started or steered until native reconciliation confirms its identity. The Host
enforces this even if a client bypasses the disabled UI action.

Attachment staging is a Host resource, not a Renderer filesystem convention.
The `opencraft/attachment-staging` capability declares accepted source kinds,
returned location kinds and the byte limit; Composer consumes only the shared
`pending/processing/ready/failed` lifecycle and an opaque `AttachmentRef`.
Local v1 stages `client-bytes` beneath the Local Host data root and returns a
`host-file`; the Renderer never derives a directory from `codexHome` or calls
generic `fs/writeFile` for this workflow. Remote RPC/SFTP and Cloud object-store
adapters may later return `host-file` or `object-url` through the same contract,
but are unsupported until their Host advertises them. Failed or unresolved
attachments block submission and retain their precise error; removing an
unsubmitted ready attachment asks its owning Host to release the staged ref.
The local Codex Host uses the same staging service beneath its own data root,
intercepts `attachment/stage` and `attachment/remove` before forwarding to the
stock Codex AppServer, and advertises the capability only with that handler.
An ordinary staged file compiles to Codex's native `mention` path. That item
preserves attachment identity in Codex history, but Codex does not include it
in model-facing text. At direct or queued Turn dispatch, the Codex Host verifies
that each mention still belongs to its staging service, then adds a model-visible
text locator beside the mention. Its UI-only text-element marker explicitly
identifies the following `mention` as a staged file; the shared projector
renders a file card without exposing the Host path or duplicating an `@` chip.
Ordinary mentions remain context chips. The first preview's exact generated
locator with an empty placeholder is recognized for history compatibility,
but arbitrary paths or filenames are never inferred to be attachments.
The queue retains the original input; validation and
augmentation happen before claiming delivery, so a removed file cannot become
an uncertain claim. A ready file alone is valid input. A browser-selected file is not ready merely because its
name and byte count are visible. The Composer retains the original `File` for
retry within its Draft owner, shows ordinary-file preparation/failure in the
card itself, and does not expose raw Host errors in the primary UI. An ambiguous
response after disconnect is retried under the same attachment ID instead of
blindly deleting a potentially accepted resource.
Durable history treats `AttachmentLocation` as opaque resource identity. The
owning staging service persists a location-keyed metadata index and implements
an `AttachmentMetadataResolver` that restores the authoritative `AttachmentRef`
display name during hydration. Transcript projection never parses a Host path
or storage directory; history without indexed metadata degrades to a generic
basename without exposing the full location. The Hermes storage adapter can
also lazily backfill a missing index from its own pre-existing owned manifest;
that compatibility remains behind the resolver rather than leaking its layout
into the transcript model.

The source implementations live in `apps/local-agent-host/src/hypernode/`:
TurnManager, DSH tool projection and the engine event/terminal core.
`dsh-execution-record.ts` supplies local clock, replay-stable unique Item
allocation, notification and synchronous pacing ports. One ordered ledger is
used for live snapshots and native history replay, including active reasoning.
The local HTTP/mux transport, product-owned models and credentials remain host
ports; HyperNode SSH tenancy and per-workspace process launch are not local
execution policy. See [migration contract](../design/dsh-engine-migration.md).

1. A conversation is identified by `(hostId, threadId)`. A bare `threadId` is
   not a cross-host identity.
2. React components never import a WebSocket, JSON-RPC client, Electron bridge,
   Session View store or Replica Journal entry.
3. `appserver-session` may translate Codex V3 Resume/history into the common
   reader contract. Its local View revisions are snapshot continuity hints,
   not a server-sequenced V4 Journal.
4. A Transcript, Timeline Frame and Timeline Block are disposable projections.
   They never become a second persistence authority.
5. ProseMirror and Native editor documents are adapters. Persisted drafts use
   `ComposerDocument` from `@opencraft/composer-core`.
6. Submission freezes an immutable `SubmitIntent`; no UI calls
   `send(blocks): boolean` in the final architecture.
7. Unknown AppServer Item types render an explicit fallback Block. Protocol
   growth must not blank the conversation surface.
8. Visible restore authority and execution capability readiness are separate.
   `thread/resume` plus the initial history window may promote the Conversation
   immediately; connector or dynamic-tool registration prewarms independently
   and must never prolong the full-page restoring state. Every mutation that
   can execute Agent work still awaits the binding's generation-scoped
   capability lease, and a failed prewarm is retried there rather than
   invalidating already-restored history.

### History positions and concurrent observations

Execution ownership and transcript grouping are different boundaries. One
AppServer Turn may contain an asynchronous question, its user reply, multiple
answers and steering inputs. `chat-core` projects one ordered presentation
surface: only the contiguous initial user frames are an intro; later user and
interaction frames stay at their original positions. Adjacent activity forms
independent disclosure segments, ended by visible input, question, response or
interaction boundaries. Web and Native consume this plan without collecting
all answers first or appending earlier activity after later messages.

Asynchronous delivery is retained even when structured questions are absent;
neither its native `final_answer` phase nor its text gives it final-answer
eligibility. Displayability, disclosure closure and execution completion are
separate predicates. Stable rows/segments use source identity and boundary
anchors, not status, array indices or inferred timestamps. Collapsing a segment
never moves steering or other responses across that boundary. The Turn parent
arbitrates at most one live Thinking owner from the current response suffix;
closed earlier segments cannot inherit a later response's running state.
Only one segment presents the Turn's work interval/total-duration fallback,
and response-copy actions exclude questions and earlier inputs' answers.
Tests cover async-final questions, multiple answers and follow-ups, in-place
streaming, phase/completion changes, disclosure, history prepend and refresh.

The virtualizer separately owns the mounted window: when history inserts rows
inside that window, the intermediate render retains both the previous slots
anchored by a surviving row and every surviving mounted identity. Count alone
can evict the old last row during insertion; surviving keys alone can evict a
replaced edge when an optimistic Turn acquires its authoritative ID. The stable
client-message subtree and its measured height must survive that handoff;
changing a protocol locator cannot fabricate content growth or reset known
geometry to an estimate. The committed viewport is
reconciled for layout changes, including same-count identity changes and height
transactions, without requiring a platform scroll event. Persisted restoration
by anchor/count remains a different operation; neither rule sorts the transcript
or takes over response following.

In the Codex V3 compatibility reader, an established Turn/Item slot is not
derived from status, update time, or opaque ID. Live updates merge by identity
without moving that slot. Ordered history owns topology only within its fetched
window; a navigation locator index is a placement hint for one unloaded Turn,
not permission to globally sort the loaded conversation or move unindexed rows
behind the live tail. Session owns both policies; Workbench commits its result
without implementing a second ordering rule.

Background history and navigation reads capture their immutable pre-request
Turn baseline. On commit, Items and lifecycle fields observed since that
baseline take precedence over the delayed snapshot. Missing concurrent rows
retain their existing neighbour; unchanged covered membership may still be
replaced by full history. Resume continues to commit its ordered snapshot before
releasing buffered notifications. Baselines belong to that read and connection
generation, not to durable transcript storage. V3 supplies no comparable server
revision per Item: this protects observed updates, not a claim of server-wide
causal sequencing or a V4 Journal. Dot and task-chat renderers may differ while
consuming this same identity-versus-position distinction.

### Hermes message windows and Bot history continuity

Hermes REST pagination owns source-row offsets, not rendered Turn or Bot-message
counts. Each read adds one 120-row page to the scoped chronological window;
the bridge returns that complete loaded projection. AppServer `limit` must not
slice it again. A tail refresh grafts at a durable row anchor, accounts for the
preserved prefix in its next offset, and does not reopen a known exhausted edge.
Partial Turn regrouping can change execution/causal associations while retaining
message IDs. Bot backfill therefore refreshes covered durable message metadata,
rather than keeping stale associations merely because those IDs already exist.

The Bot Source keeps durable history separate from local/live overlays. Resync
may preserve an older prefix only within the same conversation incarnation and
with a shared durable anchor; descriptor, execution and interaction authority
always comes from the new read. A new cursor is opaque and cannot be calculated
from visible message count. Delayed older reads are generation-scoped and cannot
commit after resync, deletion or disposal. Old-epoch remote events are discarded;
unadopted local submissions retain their independent client-message ownership.
Once a durable row confirms that client-message identity, it adopts the local
overlay, whether obtained by refresh or backfill. A delayed send failure or
receipt then settles from the confirmed receipt; it cannot restore a failed
optimistic row or regress completed execution. Concurrent reuse of an in-flight
client-message identity does not issue another request.

An empty display projection is not proof of empty source history. Completed
tool-only rows can legitimately produce no Bot-chat units. The viewport requests
at most three older pages per recovery intent, one page at a time, without
requiring a physical top-scroll gesture. Remaining history or a failed read
offers an explicit load/retry action in the existing status slot; unchanged or
cyclic cursors stop automatic traversal. This is bounded display demand, not
eager draining, transcript persistence, or execution readiness.

### Activity closure and disclosure authority

`AgentActivitySegmentEnd` records why a contiguous slice ended (`user-input`,
`content`, `reasoning`, `final-answer`, `turn-terminal`, or still `open`). This is chronology
and live-header ownership, not permission to hide content. Ordinary task
disclosure is eligible only for the nearest meaningful work slice reaching its
own displayable, non-async final answer. Readable reasoning may separate physical
work slices, but cannot multiply that response's outer fold owners. Earlier
slices retain their ordinary tool summaries and their tools' independent choices.
A Steer, hook, question, approval, image, unphased text,
terminal Turn, or a final answer in an earlier response cannot grant eligibility.
No phase is inferred to make a disclosure work. Earlier completed commentary
therefore stays visible when the user follows up, rather than becoming a stack
of default-collapsed historical-message headings. Cancelled work stays visible.

Eligibility, automatic default, explicit View choice and temporary expansion
constraints are independent. `resolveAgentActivityDisclosure` is the shared
pure policy; `resolveAgentActivityLayout` applies `forceExpanded`/`disableCollapse`
before selecting partition regions. A no-toggle surface must not expose only
the collapsible subset or duplicate persistent items. Displayable non-async
final answers are persistent even if supplied to the inner partition, although
the ordinary ordered plan renders them in separate source-owned slots.

Only user actions write collapse choice. Defaults and constraints never write
it back; old saved choices cannot manufacture eligibility. Web's existing
View restore receipt and Native's component choice remain their presentation
owners, not Thread storage or an execution preference. Stable segment/Item
keys, the single Turn clock/Thinking owner and viewport reflow leases are
unchanged. No new scroll writer, timeout, renderer sorting or remount is added.

This ordinary task policy follows Codex 26.930.31428/build 12913's EO/DO
separation, adapted to OpenCraft's ordered multi-response slices. Codex's
Activity view may separately allow collapse before final; its continuous
transcript caller does not equate input boundaries with fold grants. The
distinct Bot chat renderer/viewport is not forcibly unified with task chat.
The portable reviewed EO oracle validates only the pure task-state contract,
not the complete original application. `chat-activity-disclosure` tests and
`scripts/smoke-activity-disclosure.ts` cover the input sequences and real
Conversation; deployment and native-device acceptance remain separate.

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

The Web recovery presentation does not equate non-authoritative with invisible.
When a Thread already has painted Timeline frames, reconnect and retry preserve
those frames, their scroll position and Composer draft; a small local connection
notice shows the pending or failed state while commands remain disabled until
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

## Package ownership

Sidebar 会话行只拥有选中/导航命中区；右键菜单触发区只覆盖行本体，触控常显的
“…”按钮是它的兄弟节点，独立拥有下拉菜单触发。两种呈现复用同一份按 Host/Thread
能力生成的操作项；Sidebar 是唯一的菜单打开状态 owner，用 Host/Thread/入口
标识当前菜单，切换行或入口时同步关闭旧菜单，迟到的关闭回调只能关闭自己的
标识。菜单触发区不互相嵌套；菜单项选择之后，由行级操作或
独立 Modal 接管，不能让下拉菜单的 Portal 触摸事件回流成行本体长按。浮动与
固定侧栏仍使用同一个 Sidebar 内容 owner，切换呈现不另建会话菜单状态。

Conversation 的活动折叠将点击语义与标题呈现分开。`OverlayDisclosureTrigger`
提供稳定的原生覆盖按钮、可见标题的 accessible name 关联及非交互内容层；
`Worked for`、普通 Activity 与 Activity Group 都消费它。按钮只把一次原生
`click` 交给调用方，不从 `pointerup` 合成第二次提交；展开状态、折叠偏好、
正文挂载和动画继续由各活动组件拥有。没有可展开正文的标题不暴露空按钮。
这是一套 Web/Electron 共用的 DOM 控件结构，而非触控设备专属分支。
与该标题同属助手消息的操作栏在触控设备上从首帧可见，不在手指按下后
才因 `:hover` 改变透明度。鼠标仍按 hover 显示，键盘仍按焦点显示；
这条输入呈现规则不改变按钮激活或折叠状态写入。手机预览的连续静止轻触
对照均收到原生 `click`，但此观察不等于对所有移动端浏览器的证明。

Composer model discovery is a model-only catalog. Product Bot identity is
owned by the Bot protocol and is not duplicated as a hidden Agent picker.
Bot execution failures keep the stable member and execution identity across
history replay and live updates. Their error category is shown beside the
failed execution; raw provider diagnostics stay at the Host and are never
converted into a fabricated Bot message.
Reasoning controls are derived exclusively from each model's declared effort
set: an empty set hides the control, `none` means disable only when explicitly
declared, and the model default must be a member of the same set. Hermes maps
its Session-owned effort through the existing AppServer model/Turn fields;
provider-specific wire clamping remains inside Hermes Runtime.
The Web Composer presents model and reasoning through one Radix menu but keeps
their hierarchy distinct. At desktop widths, models are the primary scrollable
column and the selected model owns an adjacent detail column; narrow surfaces
stack the same two regions without changing their state. The detail projection
shows only catalog-authoritative metadata: user-authored display name, custom
source, context/output limits, input modalities and declared reasoning efforts.
It does not infer capabilities from a model name or render catalog descriptions
in the compact picker. Selecting a model keeps the menu open so that this
projection can refresh in place; selecting an effort completes the interaction,
closes the menu and restores editor focus. Model changes preserve a compatible
effort and otherwise resolve through that model's declared default rather than
a global effort order. The detail column projects the declared effort set as a
horizontal discrete scale: the current effort is named explicitly, endpoints
show the available range, and every stop remains a Radix radio item for menu
keyboard semantics. Pointer hover and roving keyboard focus use the shared menu
highlight state; they do not introduce a feature-owned focus color. Track,
thumb, highlight and shadow consume the active Design System theme tokens.

The Composer permissions menu contains only declared permission profiles, without
an AppServer-default row or explanatory question. An absent or null draft choice
inherits the runtime's effective profile for display only; rendering never writes
that derived value into the draft. Until resolved, the trigger reads `Permissions`
and no profile is checked. Explicit choices still use the existing submit path.

Temporary Side Chat forks are adopted by `ThreadResumeCoordinator.adoptFork` from
the validated `thread/fork` response in its original connection generation. They
use the same metadata/notification projectors and Replica reader, but never issue
a rollout Resume or persistent queue query. Their history source is `fork` and a
lost connection expires that temporary baseline. See the [workspace design](../design/README.md).

| Package | Owns | Must not own |
| --- | --- | --- |
| `appserver-protocol` | JSON-RPC methods and Thread/Turn/Item wire types | UI state |
| `appserver-client` | connection and request lifecycle | conversation projection |
| `appserver-replica` | cursor, persisted replica, catch-up and mutation receipts | React |
| `appserver-session` | V3 Resume/history compatibility and normalized reader source | final ChatUI snapshots |
| `chat-core` | identities, Frames, Blocks and pure projector registry | transport and React |
| `chat-runtime` | Replica-derived snapshots and command/history ports | protocol storage and rendering |
| `composer-core` | portable document, draft, target and submit intent | DOM/Native editor state |
| `codex-composer` | Web ProseMirror adapter and Codex visual surface | authoritative drafts |
| `timeline-virtualizer` | Codex Turn window, restore, geometry, follow and response-spacer policy | DOM and React Native |
| `workbench-runtime` | per-Host runtime, Thread catalog, Replica/Session lifecycle and commands | platform views |
| `workbench-web` | DOM Timeline, ProseMirror adapter and precise Codex frame | JSON-RPC storage |
| `workbench-expo` | RN Timeline, Native editor adapter and iOS/Expo Web frame | DOM |

The Embedded Workbench keeps Sidebar presentation outside this table: the host
product renders its own session list, New conversation action and Explore/Chat
navigation, while the embedded surface exposes session snapshots plus
create/select/rename/delete actions backed by the ordinary AppServer Thread catalog. Thread IDs and
mutation capabilities remain AppServer authority. The host must not copy or
infer a second conversation model, and the embedded surface must not inject
Sidebar DOM or rewrite the host page route. The right canvas is an
OpenCraft-owned presentation and may reuse the standard Header, Composer,
and Timeline implementations. The embedded product projects a collapsed preview panel with a Header toggle.
The session snapshot also carries the AppServer Thread catalog's running state
for each Thread. The host Sidebar may show activity from that field; selected
Thread identity and session-list loading are not execution status.
Only webpage tabs and read-only files linked from the conversation are exposed.

For LightVela multi-Bot instances, one embedded Host is identified by
`instanceId + profileId`, not by the physical instance alone. CTL's root
`main` identity maps to native Hermes `default`; named Bot Profiles keep their
native identity. Every ordinary Thread operation is scoped at the Hermes
adapter boundary, and switching Bot disposes the old embedded Application
before publishing the replacement session list. The shared physical Dashboard
token is not conversation authority.

New conversation starts as a client Draft. The host Sidebar may mark that Draft
as selected, but it must not invent a Thread row or ID; the first accepted
submission promotes the Draft and AppServer then publishes the canonical Thread
into the recent-conversation list.

Hermes-backed session mutations stay on that same authority path. Rename uses
`thread/name/set` and the bridge's native `session.title`; irreversible
delete uses `thread/delete`. The bridge reads the live Hermes session first;
if it is running, it pauses queued submissions, sends `session.interrupt`, and
waits for `session.activate` to confirm `running: false` before closing the
session and invoking `session.delete`. An interrupt failure or missing idle
confirmation leaves the conversation intact. UI adapters must retain the
operation Promise long enough to expose pending and failure state.

### Returned thinking content

Engine-returned reasoning is a chronological Item-owned inner disclosure within
the response's work container, not the body of a tool group's live “Thinking” header. Codex, DSH and Hermes
consume the same default policy: nonempty explicit summary text wins; when no
summary is returned, the actual returned textual detail/content is available.
The body selects that content once, without concatenating duplicate summary
and detail. Empty Items and opaque/encrypted fields create no disclosure and
cannot be used to fabricate an explanation. This product policy intentionally
differs from the older recovered Codex tool classifier that hid reasoning.

Request policy and disclosure policy are different owners. The Codex Host's
single native request writer supplies `summary: "auto"` on `turn/start` only
when the caller omits that field. The same boundary covers normal/new/forked
conversations, empty continuation and Host-owned queued starts, over local
stdio or remote Codex transport. Explicit modes (including `none`) are retained;
explicit `null` keeps native thread/Host inheritance. Invalid explicit values
remain the native validator's responsibility. Each omitted-field start reapplies
the product default rather than inheriting a previous explicit `none`; callers
wanting native inheritance use `null`. No summary field is added to Steer,
Thread lifecycle requests or generic Hermes/DSH submissions. Codex's
native model capability gate still owns upstream support; asking for a summary
does not guarantee returned text. Existing running turns and historical Items
are not rewritten. The UI stays initially collapsed and only actual returned
text creates its disclosure.

Hermes already projects actual `reasoning.delta` and its durable reasoning
columns by default, without a separate display opt-in. Its ordinary Responses
transport asks for an automatic summary, but provider-specific transports and
explicit session/model/global reasoning settings can differ. “Enabled by
default” therefore means accepting returned text, not promising content on
every response or treating `reasoning.available` liveness as that content.

`chat-core` owns selection, chronological slots and single live Thinking
arbitration. Stable Turn/Item identity survives streaming, completion and
history updates. Reasoning and Bash/Read/tool groups have separate inner
disclosures inside the same contiguous response work container. The newest
current-response reasoning may own live feedback; later tools, answers,
questions or inputs retire that feedback without deleting readable content.
When no returned content exists, the existing noninteractive Thinking status
retains its current owner rather than becoming an empty expand button.

Both platforms initially fold reasoning, even while streaming. Only an explicit
View action changes that choice; new deltas or completion never automatically
expand, collapse or write a preference. Web reuses its existing View restore
receipt and disclosure reflow owner; Native keeps Item-keyed inner choices on
the stable outer work component. Collapsing the outer container may unmount its
body but must not reset either reasoning or tool-group choices. The header uses a short localized status plus the latest
nonempty visible document line when active, or first visible line when settled.
`chat-document` owns the shared assistant Markdown grammar and plain-text
projection: labels omit formatting controls and link destinations, but preserve
escaped literals and code identifiers. `chat-core` selects the line and keeps
the selected Markdown body unchanged; neither platform regex-strips content.
The expanded body uses the ordinary Web/Native document renderer, with stable
Item document identity, the existing Host resource/media policy and the Web
viewport measurement ingress. Block Markdown is never nested in a raw paragraph;
its renderer owns whitespace and narrow code/table overflow. Only current live
feedback animates the document. Rendering a resource or a stream update cannot
change either disclosure choice or take tool/final-answer ownership.
The full selected text is available during and after execution. It is not
copied into the final response's copy action or tool statistics.

Adapter event names are not content authority. In the inspected Hermes agent
revision `3c3ab69abb9b08683b5eb15b4e2b8be1198c875f`,
`turn_response_intake._relay_thinking` sends up to 500 characters of
`assistant_message.content` as `reasoning.available`; it is an assistant-body
preview, not returned reasoning. The Hermes bridge uses this only for liveness,
leaving body ownership to `message.delta/interim/complete`. Actual
`reasoning.delta` and durable reasoning columns own separate reasoning Items;
an answer with equal or prefix-continuous text cannot erase them. History
aliases select one returned representation instead of duplicating it.
An empty or opaque reasoning source Item remains a work observation; it does not
flush/re-key a work slice, close an adjacent tool group or create a history-count
heading. Actual nonempty text owns a source-identified chronological disclosure.
First returned text inserts a new inner disclosure, including when later Items
already exist in restored history; it never splits or re-keys the outer work
container. Source identity and existing valid View choices survive. Nonempty
reasoning separates adjacent inner tool groups, not responses or outer folds.
Within the same contiguous response, a real final answer grants exactly one
outer work disclosure containing both reasoning and tools in source order.
The final answer remains outside. Tools never move into the reasoning body.
Real user input, an asynchronous question or other content/interaction retains
its existing ordering boundary; separate completed responses keep their own
legitimate folds even though execution shares one Turn. Only one work container
owns the Turn-total clock; reasoning cannot redirect it across a response/input
boundary. Actual reasoning alone is meaningful work, so a completed reasoning-only
response has a real outer fold, even with no tools. Its Worked-for label uses
only the provided clock, never fabricated timing. Empty reasoning alone does
not create an empty toggle. Outer visibility and independent inner choices are
different authorities; streaming, completion and outer collapse never rewrite
those inner choices.

The interaction draws on DSH `ReasoningRow` in locally inspected
`@deepseek-ai/dsh-client-ui-conversation@0.1.1-rc.2`. Shared model and adapter
tests plus `scripts/smoke-reasoning-disclosure.ts` cover empty/summary/detail
content, first control activation, browser touch/mouse/keyboard, separate tool groups,
in-place streaming, completion, prepended history and View restoration. The
browser fixture uses synthetic engine text; it does not claim paid-provider
execution, hidden reasoning availability or iPhone OS acceptance.

The embedded canvas permits the existing `vela.voice-input.toggle` Composer
action. Dictation uses the platform speech provider and the same transient input
transaction as the full Workbench; no microphone starts until user interaction.
Unsupported browsers retain the provider's disabled-state explanation.

All floating primitives in that canvas resolve through one Workbench
Presentation Root. This includes Composer model/effort menus, Draft project and
Host selectors and application modals. The root also owns the
semantic theme variables required by those primitives; a Portal must never fall
back to the embedding product's document body.

Global type-to-compose resolves input ownership through the keyboard event's
composed path, including editable descendants inside the embedded Shadow DOM.
It never inserts printable keys owned by an editor or control, or IME keys
marked composing / keyCode 229 (including the initial composition key).

The Web renderer localizes the Thinking status through one `ThinkingLabel`
for turn placeholders, live reasoning and activity-group gaps between tools.
Core status strings remain renderer-neutral; real reasoning summaries are preserved.

## Agent-originated async questions

Codex `agentMessage` Items with `delivery: "async"` and `questions` are not
`item/tool/requestUserInput` server requests. The former remain ordinary
assistant messages: their question cards are projected from the Item ID and
question index, stay visible in the Timeline, and do not replace the Composer
or suspend the Turn. The latter use the existing blocking interaction response
port. Device type must not select between these two protocol forms.

An async question's title is model-authored Markdown, not a form-control label
string. Web renders it through the same Chat Document and resource policy as
assistant content, so safe links are usable and unsafe targets stay inert. The
card gives its fieldset an accessible name from the rendered title instead of
placing block Markdown inside a `legend`. Suggested answer strings remain
literal labels and submission values; presentation must not rewrite the answer
envelope or create a second Markdown/link policy.

An async answer is a normal user submission carrying Codex's
`send_user_message_question_reply` envelope. The active Turn uses the steer
submission path; an idle Thread starts a normal Turn. The reply is rendered
readably in the user message, while its structured question ID resolves only
that card. Later ordinary user messages supersede unanswered cards. Pending,
queued, sending, uncertain and answered states derive from the shared Timeline
and follow-up queue so a second subscriber or a reconnect sees the same result.

## Current migration ledger

### Disclosure scroll anchor lifetime

While a user expands or collapses an activity, its heading retains its screen
Y coordinate. Numeric disclosure height samples are projected onto whole CSS
pixels by the shared Web animation adapter before Motion commits layout,
matching the scrollport's conservative pixel grid. Otherwise rounded scroll
writes can leave the heading oscillating by almost a pixel even when its final
position is correct. Natural `auto` layout and later streaming growth are not
fixed or rounded by a second observer. The disclosure owns its
animation and reports completion through a View-scoped reflow lease; the Web
conversation viewport is the sole owner of scroll writes and observation. It
keeps the anchor through the animation and final stable layout frames, including
body removal and reduced motion. No fixed timeout decides completion for the
activity row, group or Worked-for controls.

Worked-for animates entry only. Its closed branch removes content in the same
React commit; it must not add an exit-presence owner that defers unmount after
the parent reports synchronous layout completion. Completing a reflow lease
applies the committed layout compensation immediately, then waits for stable
frames before retiring observation.

Each viewport has at most one interaction anchor. Reversal or a new heading
supersedes the old lease; delayed completion can only complete the lease from
its own render. User scrolling, control unmount and viewport replacement cancel
preservation immediately. Unmigrated expanders keep their separate bounded
compatibility policy and cannot create a second owner alongside an activity lease.

Browser regression measures the visible label's entire path and peak-to-peak
movement, not only final position or each frame's distance from the starting
point. It covers measured multi-Turn layout, fractional starting geometry,
mouse/touch input, reduced motion and interrupted/reversed animations. A
separate nonvirtualized control checks retirement of the interaction anchor;
normal virtualizer compensation during later growth is not evidence of a leak.

### Established

- AppServer client, WebSocket, memory and Replay transports.
- Resume strategies for legacy, tail, paginated and Durable history.
- V4 Replica authority/client/storage primitives and V3 compatibility source.
- Cross-host `ConversationKey` and opaque Turn/Item identities.
- Extensible Timeline projector registry with an unknown fallback.
- User, assistant, event and interaction Frames.
- Typed Blocks for text, reasoning, execution, patch, tools, plan, todo,
  subagents, approval, question, errors, compaction and images.
- Portable Composer Document/Draft/Target/SubmitIntent and target-scoped drafts.
- A Conversation Runtime that derives its snapshot from a Replica reader only.
- `AppServerWorkbenchRuntime` with per-Thread Replica clients, typed command
  ports, reconnect and stable Thread selection.
- Real WebSocket bootstrap for Web and Expo; IndexedDB on Web and Expo SQLite
  on Native cache only painted state beneath Replica authority.
- Web ProseMirror and Native input adapters controlled by the same
  `ComposerController`; submission freezes an immutable `SubmitIntent`.
- A typed Composer-to-AppServer compiler for new/fork/turn/steer/queue,
  interrupt, approvals and questions.
- Web and RN Timeline renderers consuming the same Turn/Frame/Block projection.
- Codex `VirtualizedTurnList` constants and algorithms: one full-height list,
  Turn-count overscan, measured-height anchor compensation, route restore,
  common geometry/scroll API, and parent latest-Turn follow reducer.

### Turn identity handoff and mounted window

The canonical `turnKey` remains the protocol locator. When a submitted Turn
acquires its authoritative ID, its primary user-message client ID owns the
stable React row identity. Known measured height transfers across that identity
handoff before estimating the new layout; an already measured target height
wins, and unrelated messages never inherit geometry.

The intermediate mounted window retains both its anchored slots and every
surviving mounted row. History insertion cannot evict its former last row, and
a same-count ID replacement cannot exclude a newly acknowledged edge. The
viewport refresh consumes layout identity, not only entry count or a later
platform scroll event. Natural and response-placement policies share this rule
without acquiring bottom ownership from a reader, forcing scroll, reordering
history, or remounting the Conversation.

### Compatibility boundary

- `appserver-session` currently materializes a Thread View before exposing it
  through the ReplicaClient-shaped reader. This is the compatibility ingestion
  boundary, not proof that Codex V3 has a V4 Authority or retained Journal.
- `DisplayTurn` remains exported only for older fixtures. Neither application
  host uses it as its conversation read model.
- Browser attachment blobs require a compatible Host attachment-staging
  capability before they can become server-readable AppServer attachments. The
  compiler remains a final fail-closed boundary, not the primary upload-state UI.
- LightVela Hermes advertises that capability only when its authenticated
  Dashboard filesystem exists. Client bytes are staged under the controlled
  `<codexHome>/opencraft-attachments/<client-id>` directory with a durable
  manifest, a location-keyed display-metadata index, replay/content checks and
  bounded recursive removal. Images may continue to use the independent inline
  data-URL path. Host-staged non-image assets, including audio files, compile as
  file mentions; their MIME type alone must not turn a server-readable file into
  an audio modality that the Host does not support. The staging service receives
  its SHA-256 digest from the Host platform: browsers use Web Crypto, while Expo
  supplies its native crypto module. It does not assume React Native exposes
  `crypto.subtle`.

### Browser image attachment presentation

The Web Composer displays a selected image immediately from a browser-owned
object URL. The object URL and original `File` belong to the Composer
Controller's draft-owner attachment session, keyed by Draft ID and attachment
ID; neither enters the serializable Draft or AppServer input. The session owns
compression/resolve work across React mount changes, updates only the Draft
that initiated the work, and aborts/revokes on removal, clear or Controller
disposal. A retry uses the retained original `File`. `processing` means local
image preparation, not measured network upload progress. The existing
`canSubmit` rule remains the admission gate for unresolved or failed assets.
For iPhone camera HEIC/HEIF input, browser image decode and canvas encoding
produce a JPEG upload derivative. This is required format conversion, so it is
kept even if larger than the selected HEIC; the original File stays with the
draft-owner session for retry. A browser without that decode/encode path leaves
the attachment failed rather than sending HEIC under an unsupported MIME.
The post-conversion inline byte cap still applies before base64 allocation.
Failed image cards show the preparation error beside the thumbnail, so touch
users can identify a decode, size or encoder failure without a hover tooltip;
retry still uses the original selected `File`.

After acceptance, image presentation is derived from the authoritative
Timeline. Sent-image thumbnails resolve direct image data or Host-backed media
through the existing media source boundary; their click opens a modal image
viewer rather than generic link navigation, which deliberately rejects `data:`
URLs. The viewer uses the Workbench Presentation Root so embedded Shadow DOM
keeps its modal styles and focus behavior; an explicit modal portal target
still takes precedence. No generic resource-policy exception is introduced. Full page reload
does not preserve an unsent browser `File`; that requires a separate durable
draft/blob storage contract.

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
actionable entries. The current LightVela Hermes bridge returns empty catalogs
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

### Production hardening, not architecture blockers

- Extend the native rich editor to structured `ComposerDocument` block types
  and edits across their boundaries without flattening them.
- Add Remote RPC/SFTP and Cloud object-store attachment-staging adapters
  without changing Composer lifecycle semantics.
- Tune platform-specific response-spacer animation curves while retaining the
  shared Codex placement and follow state machine.
- Split the large desktop renderer chunk at explicit capability boundaries.

## Evidence required for completion

Both apps have removed `createDemoWorkbenchRuntime`. Deterministic Memory and
Replay suites cover create/list/resume/page/send/stream/interrupt/retry,
interaction RPCs, cursor gaps and reconnect. The live 9988 gate deliberately
uses the existing canonical Thread read-only: it proves WebSocket → Session →
Replica authority, forced disconnect, reconnect and same-Thread recovery
without mutating a user's conversation. Production Web, Expo Web and iOS
bundles are independent quality gates; a static fixture alone is not accepted.

控制台内嵌的新会话由宿主选择 Bot，Shell 通过 showExecutionControls=false 隐藏整个项目/执行环境工具栏和连接状态点；独立工作台默认展示。连接生命周期与发送就绪检查保持由 runtime 负责。

内嵌新会话标题与新建/已有会话的差异化占位提示覆盖控制台 en-US、zh-CN（含 zh-SG）、zh-Hant、id-ID、es、ja-JP、ko-KR。额外五套文案由 embedded-companion-messages.json 提供，通过嵌入专用 catalog 注入 LocaleController，跟随宿主语言切换；这不代表其他工作台文案已完整翻译，未覆盖项继续使用 defaultMessage。独立工作台语言选择项保持原样。

内嵌新会话（draft 存在且尚无 submission）由 sessions bridge 显式发布 isDraft；启用右侧预览时保留顶部面板开关，已有会话继续展示标题与重命名。国内控制台内嵌聊天的加载、新会话和已有会话均无宿主圆角外框，内嵌主内容表面无阴影；保留标题重命名入口与输入框边界。预览面板默认关闭，网页标签随会话 scope 切换；文件只读预览不展示目录树、搜索或编辑。

内嵌会话列表由宿主分页呈现。OpenCraft 的 Thread catalog 仍以 30 条为一个后端分页单元，sessions bridge 将当前已取会话和 `hasMoreSessions` 一并发布，并通过 `loadMoreConversations()` 显式读取下一页；宿主初始展示最近 20 条，每次「查看更多」最多增加 20 条，「收起」逐批撤回。加载失败时不推进宿主的可见数量。
首次连接的 Thread catalog 在查询尚未开始或尚未取得结果时也报告加载中；Host 进入错误态后停止报告加载，由聊天主区呈现错误和重试。空列表只有在首次读取结束后才能作为已确认的空状态投影。宿主切换 Bot 时不显示短暂的「默认对话」或可见的加载文案，待目标 Bot 的会话结果到达后再呈现列表或空列表入口。

内嵌右侧预览面板的入口、标签列表/空态、缩放与关闭提示、宽度调整无障碍标签以及不可用状态均通过稳定消息 ID 跟随宿主语言；网页自身正文由目标站点控制，不由控制台翻译。

Embedded file previews retain the mutation-level read-only guard alongside snapshot-based saves in the standalone workspace editor. Markdown preview/source switching and lazy syntax editors share the same resource lifecycle. The read-only regression renders the real panel and invokes its captured Query mutation, asserting zero filesystem writes and cache invalidations.

Markdown preview entry: explicit `.md` / `.markdown` paths in completed inline code are clickable and use the same resource policy and Host-scoped right panel as Markdown links. Bare names, commands, external URLs, streaming paths and code within an explicit link retain their original semantics. No file is read before clicking.
Completed standalone Hermes `MEDIA:<path>` text or inline code for an explicit Markdown file uses that same click and Host permission flow. Non-Markdown media, embedded prose, malformed paths, streaming content and code inside an explicit link remain inert; the Renderer never treats `MEDIA:` as a browser URL or reads the file before clicking.
