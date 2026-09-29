# ChatUI integration architecture

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

### Changed-file review

The Turn's existing unified diff remains the read authority for its changed-file summary. ChatUI renders an in-progress inline Review entry and a completed resource card; it only emits an open intent. The Workbench owns the read-only Review dialog, keeps it tied to the active Thread, and projects the current Timeline block while streaming. File selection filters that existing diff for display; it does not create a second TurnDiff model or mutate the workspace. Undo/Reapply is not advertised until a real Host apply-patch capability is connected.

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

The Web recovery presentation does not equate non-authoritative with invisible.
When a Thread already has painted Timeline frames, reconnect and retry preserve
those frames, their scroll position and Composer draft; a small local connection
notice shows the pending or failed state while commands remain disabled until
authority returns. Only a Thread without visible frames gets a delayed skeleton
in the Timeline's empty slot. A definite restore failure replaces that slot with
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
and Timeline implementations. The embedded product does not project
OpenCraft's Right Panel or its toggle.

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
delete uses `thread/delete`, closes a live Hermes session, then invokes
`session.delete`. UI adapters must retain the operation Promise long enough
to expose pending and failure state.

All floating primitives in that canvas resolve through one Workbench
Presentation Root. This includes Composer model/effort menus, Draft project and
Host selectors and application modals. The root also owns the
semantic theme variables required by those primitives; a Portal must never fall
back to the embedding product's document body.

## Agent-originated async questions

Codex `agentMessage` Items with `delivery: "async"` and `questions` are not
`item/tool/requestUserInput` server requests. The former remain ordinary
assistant messages: their question cards are projected from the Item ID and
question index, stay visible in the Timeline, and do not replace the Composer
or suspend the Turn. The latter use the existing blocking interaction response
port. Device type must not select between these two protocol forms.

An async answer is a normal user submission carrying Codex's
`send_user_message_question_reply` envelope. The active Turn uses the steer
submission path; an idle Thread starts a normal Turn. The reply is rendered
readably in the user message, while its structured question ID resolves only
that card. Later ordinary user messages supersede unanswered cards. Pending,
queued, sending, uncertain and answered states derive from the shared Timeline
and follow-up queue so a second subscriber or a reconnect sees the same result.

## Current migration ledger

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
  data-URL path.

### Browser image attachment presentation

The Web Composer displays a selected image immediately from a browser-owned
object URL. The object URL and original `File` belong to the Composer
Controller's View-scoped attachment session, keyed by Draft ID and attachment
ID; neither enters the serializable Draft or AppServer input. The session owns
compression/resolve work across React mount changes, updates only the Draft
that initiated the work, and aborts/revokes on removal, clear or Controller
disposal. A retry uses the retained original `File`. `processing` means local
image preparation, not measured network upload progress. The existing
`canSubmit` rule remains the admission gate for unresolved or failed assets.
For iPhone camera HEIC/HEIF input, browser image decode and canvas encoding
produce a JPEG upload derivative. This is required format conversion, so it is
kept even if larger than the selected HEIC; the original File stays with the
View-scoped session for retry. A browser without that decode/encode path leaves
the attachment failed rather than sending HEIC under an unsupported MIME.
The post-conversion inline byte cap still applies before base64 allocation.
Failed image cards show the preparation error beside the thumbnail, so touch
users can identify a decode, size or encoder failure without a hover tooltip;
retry still uses the original selected `File`.

After acceptance, image presentation is derived from the authoritative
Timeline. Sent-image thumbnails resolve direct image data or Host-backed media
through the existing media source boundary; their click opens a modal image
viewer rather than generic link navigation, which deliberately rejects `data:`
URLs. No generic resource-policy exception is introduced. Full page reload
does not preserve an unsent browser `File`; that requires a separate durable
draft/blob storage contract. Native Expo has the same semantic Draft but not
this Web-only picker/presentation implementation.

### Production hardening, not architecture blockers

- Implement a fully rich Native text editor adapter rather than flattening rich
  display into the current native text-input surface.
- Add Remote RPC/SFTP and Cloud object-store attachment-staging adapters, plus a
  Native client-bytes producer, without changing Composer lifecycle semantics.
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
