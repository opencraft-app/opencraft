# ChatUI: Architecture and acceptance

[Architecture index](../../chat-ui-architecture.md) · [Documentation index](../../README.md)

## Target

OpenCraft models conversations as `Thread -> Turn -> Item` across Host engines.
The connected Authority owns business writes; native engine adapters translate
their protocols into that shared model. ChatUI consumes one normalized
Conversation Read Model: a V4 ReplicaClient for a V4-native Authority, or a
snapshot-oriented compatibility projection for AppServer V3 Resume. Web and Native
surfaces share identity, projection, runtime commands, Composer documents and
design tokens. They do not share a renderer or editor implementation.

Host providers may declare localized Composer shortcuts as ordinary prompts or
standalone actions. Commands are discovered by typing `/` in the editor; declaring
shortcuts must not add a command-library button or a separate toolbar menu.
Selecting a suggestion only inserts editable text; explicit send is
required. The core matches only a single paragraph with no attachments/context
and no arguments. Ordinary prompts and unmatched input retain normal submission,
including queue admission. The optional resident `composerCommands` port binds an
action adapter to the actual Host/profile and protocol, never the selected Host
or an engine ID. Disabled/revised profiles, disposed runtimes and retired or
replaced providers refuse new actions; accepted calls hold their own provider
leases until completion, even if the resident runtime is being disposed.

Engine plugins own command names, descriptions and action-to-protocol mapping.
For example, a plugin can give its standalone stop command stronger background
cleanup semantics while the Composer Stop button retains `turn/interrupt`.
A new Draft action need not create a Thread. The expected active Turn is captured
from the matching Conversation so an adapter can refuse to interrupt a newer Turn.

Turn interruption derives cancellation payloads from the typed server-request
policy. Responses decline approvals, dismiss dedicated pickers or leave questions
unanswered; dynamic tool calls remain owned by server resolution. Each invocation
returns its own payload. The conversation runtime selects only the target turn,
settles all response attempts before interrupt, carries the original provenance
and releases its transient interrupt state on failure. The helper does not grant
permissions or own pending-request removal.

## Non-negotiable boundaries

The related contracts are grouped in the [architecture index](../../chat-ui-architecture.md).

## Package ownership

Sidebar 会话行只拥有选中/导航命中区；右键菜单触发区只覆盖行本体，触控常显的
“…”按钮是它的兄弟节点，独立拥有下拉菜单触发。两种呈现复用同一份按 Host/Thread
能力生成的操作项；Sidebar 是唯一的菜单打开状态 owner，用 Host/Thread/入口
标识当前菜单，切换行或入口时同步关闭旧菜单，迟到的关闭回调只能关闭自己的
标识。菜单触发区不互相嵌套；菜单项选择之后，由行级操作或
独立 Modal 接管，不能让下拉菜单的 Portal 触摸事件回流成行本体长按。浮动与
固定侧栏仍使用同一个 Sidebar 内容 owner，切换呈现不另建会话菜单状态。
顶部筛选菜单也由同一owner管理，独立订阅自己的通道；会话/Host切换及浏览器后退在新页面绘制前关闭旧菜单。关闭回调按入口身份判断，不能迟到关闭或抢走新菜单焦点；开菜单不重建或重新分组会话列表。
行菜单的打开项在目录刷新、分组折叠或分页后仍须属于一个可见且可交互的目标；目标消失或禁用时在布局阶段释放owner，再恢复同一条目不能自行重开旧菜单。只在Sidebar父提交时检查当前打开项，保留行通道更新隔离；筛选菜单不依附任何行，普通目录刷新不能把它关闭。

行入口还须在申请打开owner时检查当前目标可交互性；不可交互行的头像等扩展入口不能只依赖主体按钮disabled或父提交时的清理。拒绝新打开时仍接受自身关闭，恢复可交互后允许用户主动重开；目录/重连本身不重开旧菜单。

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
The standalone Web Composer prioritizes frequent reasoning changes. Its current
model/effort label opens a focused capsule slider with only the selected model's
declared efforts. Its title opens a compact Radix model list without capability
or metadata detail panels. Model switching remains a second action. A lightning
checkbox at the header's left projects only a declared Fast serviceTier,
and the Composer label shows a lightning icon while enabled. Turning it off
explicitly clears the previous tier with null; Fast uses the server's declared ID.
Models without Fast hide the checkbox, and model switches clear incompatible
tiers. Explicit model, effort and speed changes snapshot the resolved combination
in the draft and remember it through the personal model-default authority.
New conversations consume that account/Host default; existing conversations
consume their Thread execution settings. Changing a personal default does not
rewrite an existing Thread or an explicitly selected draft. Standard is explicit
null, including on submission, so Host defaults cannot re-enable Fast. Embedded session-only policy retains its model-only
picker and Host-owned reasoning policy.

The shared DiscreteSlider owns the capsule geometry, tick marks and themed
selected fill/round thumb. The centered effort heading previews the held choice above the secondary full model name;
dragging never writes defaults until release. The right-hand reset commits only the current model's declared default effort through the existing selection owner; no default disables it. It does not reset the model or service tier. The focused surface is compact on desktop, while touch actions retain their density-owned hit areas. Its start-aligned anchor remains stable when the Composer effort label changes width; a stationary pointer must not steal keyboard slider focus. Cancellation discards preview.
Arrow/Home/End/Page keys remain slider-owned; ArrowDown from the title enters the
slider. Touch-origin adjustment preserves the editor's existing native focus and
selection through the auxiliary focus lease, including Fast toggles. Radix owns
menu keyboard navigation and dismissal. Opening either layer writes no
selection. No choices hides the slider; one choice is disabled. Model selection
continues to preserve a compatible effort and otherwise resolves through that
model's default. Catalog loading, failures, retry and Agent switching
retain their existing owners, as do account defaults and the mounted editor.



The Composer permissions menu contains only declared permission profiles, without
an AppServer-default row or explanatory question. A new-thread draft with no explicit
permission choice initializes to a Host-declared, enabled `full` profile when its
catalog arrives; the real draft selection travels through the existing submit path.
Existing threads, explicit choices (including null inheritance), and Hosts without
an available full profile retain their policy. Inherited runtime profiles remain
display-only. Until resolved, the trigger reads localized `Permissions` (`权限` in Chinese)
and no profile is checked. Standard Host-verified mode names, Chinese descriptions,
menu status and pending-change hints use the application locale catalog.
Native/custom profile names and descriptions remain engine-owned.

The empty Web Composer paints its placeholder from paragraph decoration attributes
and a noninteractive CSS pseudo-element. It must not insert a noneditable inline
widget or separator into the empty editing target, preserving native caret, selection
and clipboard behavior. Browser clipboard and DOM checks do not establish iPhone
system menu behavior.

Temporary Side Chat forks are adopted by `ThreadResumeCoordinator.adoptFork` from
the validated `thread/fork` response in its original connection generation. They
use the same metadata/notification projectors and Replica reader, but never issue
a rollout Resume or persistent queue query. Their history source is `fork` and a
lost connection expires that temporary baseline. See the [workspace design](../../../design/README.md).

| Package | Owns | Must not own |
| --- | --- | --- |
| `appserver-protocol` | JSON-RPC methods and Thread/Turn/Item wire types | UI state |
| `appserver-client` | connection and request lifecycle | conversation projection |
| `appserver-replica` | cursor, persisted replica, catch-up and mutation receipts | React |
| `appserver-session` | V3 Resume/history compatibility and normalized reader source | final ChatUI snapshots |
| `chat-core` | identities, Frames, Blocks and pure projector registry | transport and React |
| `chat-runtime` | Replica-derived snapshots and command/history ports | protocol storage and rendering |
| `composer-core` | portable document, draft, target and submit intent | DOM/Native editor state |
| `composer-editor` | OpenCraft Web ProseMirror editor | authoritative drafts |
| `timeline-virtualizer` | Shared Turn window, restore, geometry, follow and response-spacer policy | DOM and React Native |
| `workbench-runtime` | per-Host runtime, Thread catalog, Replica/Session lifecycle and commands | platform views |
| `workbench-web` | DOM Timeline, ProseMirror adapter and precise Workbench frame | JSON-RPC storage |
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

For the downstream product multi-Bot instances, one embedded Host is identified by
`instanceId + profileId`, not by the physical instance alone. The desktop service's root
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

## Current migration ledger

The related contracts are grouped in the [architecture index](../../chat-ui-architecture.md).

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
- Shared Turn virtualization: one full-height list, Turn-count overscan,
  measured-height anchor compensation, route restore and common geometry/scroll API.

### Compatibility boundary

- `appserver-session` currently materializes a Thread View before exposing it
  through the ReplicaClient-shaped reader. This is the compatibility ingestion
  boundary, not proof that AppServer V3 has a V4 Authority or retained Journal.
- `DisplayTurn` remains exported only for older fixtures. Neither application
  host uses it as its conversation read model.
- Browser attachment blobs require a compatible Host attachment-staging
  capability before they can become server-readable AppServer attachments. The
  compiler remains a final fail-closed boundary, not the primary upload-state UI.
- the downstream product Hermes advertises that capability only when its authenticated
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

### Production hardening, not architecture blockers

- Extend the native rich editor to structured `ComposerDocument` block types
  and edits across their boundaries without flattening them.
- Add Remote RPC/SFTP and Cloud object-store attachment-staging adapters
  without changing Composer lifecycle semantics.
- Tune platform-specific response-spacer animation curves while retaining the
  shared placement and follow state machine.
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

Document preview entry: explicit `.md` / `.markdown` / `.html` / `.htm` paths in completed inline code are clickable and use the same resource policy and Host-scoped right panel as Markdown links. HTML opens in a sandboxed, read-only page preview with a Source switch. Scripts cannot run; the preview's content policy permits inline styles and embedded data/Blob media while blocking external subresources. Before creating the frame, the preview removes link destinations, refresh redirects and SVG animation elements that can restore navigation because Chromium can navigate a sandboxed frame away from its original content policy. The Source view preserves the original file. This supports self-contained reports without granting page code access to the Workbench. Bare names, commands, external URLs, streaming paths and code within an explicit link retain their original semantics. No file is read before clicking.
Completed standalone `MEDIA:<path>` text or inline code uses that same click and resource policy flow regardless of the engine that produced it. This delivery directive is independent of file type: images, audio, video, PDFs and unknown files all open the existing resource preview. Absolute and relative file paths, quoted paths with spaces, and HTTP(S) addresses are recognized; external addresses retain the existing external-navigation policy. Embedded prose, malformed paths, streaming content and code inside an explicit link remain inert. The Renderer never treats the literal `MEDIA:` prefix as a browser URL or reads a file before clicking; ordinary bare inline paths retain the document-extension rule above.

The shared media classifier selects an image, audio, video, PDF or generic file
branch using the path's extension as a presentation hint. Actual decoders still
validate the bytes. Resource previews read through the Host filesystem and the
existing Blob cache. Audio and video use browser controls over a View-owned Blob
URL; this is whole-file playback, not an HTTP Range streaming contract. Unsupported
codecs and unknown binary files retain a download action.

PDF previews lazily load PDF.js and its build-owned Worker, CJK CMaps, standard
fonts and image codecs; no CDN or remote-file URL is introduced. PDF bytes bypass
the text editor's 4 MiB limit. One selected page is painted at a time, with
pagination, fit-width, zoom, text selection and original-file download. The
backing canvas has a bounded pixel budget. A View owns its document loading and
render tasks and destroys/cancels them on replacement or unmount; late results
cannot paint a different resource. Invalid or password-protected documents show
a generic failure with download available. Web and Electron share this Renderer;
this does not declare a native Expo PDF viewer.

### Owned projection metadata identity

Internal message projection metadata uses the `__opencraft` prefix. Normalized
message writes canonicalize only the five known saved projection aliases
(message kind, source item ID/IDs, turn-params marker and steering status).
Readers accept the exact legacy aliases for saved data, with canonical values
taking precedence; unknown external fields and native AppServer formats remain
unchanged. Message identity, acknowledgement matching and display policy retain
their existing owners.
