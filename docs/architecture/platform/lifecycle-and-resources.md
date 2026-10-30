# Platform: Lifecycle and resources

[Architecture index](../../platform-architecture.md) · [Documentation index](../../README.md)

### Client cache and presentation resource policy

A client LRU eviction closes the entire unowned read chain: Conversation runtime /
Replica / navigation, Session ThreadView, history context and background history
ownership, buffered notifications and stream-role entry. If the initialized peer
declares read-unsubscribe, it also detaches that logical server readership. New
acquisition waits for the old detach reply before resuming, preventing an old
unsubscribe from detaching a new consumer. Late history results cannot recreate a
released View. Servers without this capability retain their own attachment policy;
local state is still released. Eviction never cancels a Turn or a remote desktop.
Observers, commands, accepted/streaming work, pending interactions, hydration and
non-durable ephemeral forks remain protected from cache eviction.

Platform adapters select resource policy once: desktop keeps at most 4 inactive
Thread runtimes / 20 inactive Views / 20 inactive Scopes / 128 catalog summaries;
Expo and coarse-pointer Web keep 1 / 4 / 4 / 32. Retained Views own Scope leases,
so total cached Scopes can include both View-owned and separately inactive scopes.
Inactive Thread content also has an estimated 64MiB desktop / 8MiB mobile budget;
it estimates UTF-16 strings and object overhead, not actual heap size. Active work
can exceed this cache budget. Catalog summaries never materialize every row as a
Session ThreadView. The separate 50 nonempty draft-owner budget is unchanged.

### Thread lifecycle ownership

Conversation pinning is native Server metadata, not a Sidebar preference or a
bridge database. The `opencraft/thread-pins` extension declares a discovery
adapter; its list response separately proves support for the current initialized
connection. Codex uses its reserved native pinned section and metadata-only
section moves; legacy peers without that section remain unsupported. Hermes
uses the already-authenticated Dashboard HTTP channel, passes the owning profile
in each PATCH, and preserves native compression-lineage persistence. DSH owns an
ordered, atomic pin index in its home; Pi owns pin fields in each durable session
record. Temporary Pi sessions cannot be pinned. Neither discovery nor mutation
resumes or starts a Thread.

Pi publishes pin changes only after the atomic record replacement succeeds.
A rejected write leaves the previous committed state visible and a repeated
intent retries storage. Metadata saves queued during a pin write preserve its
committed result; failed writes remove only their own temporary file. Concurrent
pin intents reserve ordered timestamps without making pending state authoritative.

The normalized pinned catalog returns complete summaries beyond recent pages.
Runtime merges them once into the initial Sidebar catalog; pinned rows have a
separate visible group and do not consume the recent-row display budget.
The native backend remains authoritative after reload. In-memory write tails
serialize each Thread's intents, and a metadata revision fences reads issued
before a write. A revoked connection cannot publish a late pin result or replay
its write on a successor. Discovery failures remain errors, not unpin-all or
unsupported success. Catalog notifications and connection recovery invalidate
the same shared queries; no menu owns a polling loop or persistent pin set.
The application paints a transient pin-intent overlay immediately, shared by
Sidebar, conversation header and embedded session projection. It survives old
catalog reads until acknowledgement/refresh, serializes each Thread's intents,
rolls back a rejected latest intent, and cannot project or write through a
replaced connection, recipe or authorization epoch. This overlay is not durable
pin authority; successful catalog refreshes and reloads still use native metadata.

The downstream site renders its own Agent sidebar around the embedded Workbench.
The embedded element passes each Thread's pinned state and the current Host's
discovered pin capability to that sidebar, and forwards pin commands to the same
Thread management resource. The site shows pinned rows outside its recent-page
budget and never persists a second pin list.

DSH display recovery uses [JIT history](../../../design/dsh-jit-history.md): native
message pages retain their original unit and are mapped to requested Turn
windows without a persistent event mirror. Reading a conversation does not
activate its Agent. A read-only native description supplies metadata; execution
acquires the runtime lazily. Older history-index databases are left untouched
and are no longer opened by the local Host.

Stopping a DSH Turn publishes its interrupted state before native
`session.cancel` acknowledges. The execution admission remains owned until that
acknowledgement. A new `turn/start` for the same Thread waits for the pending
cancel to release admission, then uses its original client message ID exactly
once. Other Threads do not wait. A failed cancellation still fails the new
submission; the Host does not replay an uncertain send.

Current model identity is a Thread configuration binding, not an execution-engine
label or merely the last request's model. Fork returns the acknowledged choice;
Catalog persists it for resume and lazy execution, including never-run children.
Dynamic tool wire declarations are retained separately from normalized engine
descriptors. Preflight precedes native creation; cold display registration accepts
the declaration without mounting an Agent, and activation installs it idempotently.

For DSH-backed Threads, OpenCraft owns persisted Thread names, archive state
and fork/subagent relation in `opencraft-threads.sqlite` under the Host product
data directory. Codex uses its native AppServer name and archive state, with
`thread/list` and `thread/read` projecting names, instead of duplicating them
in the DSH catalog. Engine
history remains behind the native execution port; metadata discovery never
overwrites a user name or revives an archived Thread. Temporary metadata,
native event logs and application history indexes remain in memory and are
expired on engine restart. Projection/checkpoint adapters must not persist
temporary content, including late disposal writes.

AppHost stamps a logical client identity at the trusted lease boundary and
routes targeted replies/server requests back to that client. Physical transport
sharing does not merge subscription or execution ownership. `thread/unsubscribe`
detaches one logical subscriber; another subscriber is unaffected. Idle durable
threads unload after a 30-minute no-subscriber activity grace; a temporary thread
releases after its final subscriber. Unload and resume transitions serialize.

The daemon’s native engine adapter has one physical AppServer stdio subscription per Thread, while
each browser lease owns a separate logical read subscription. A logical
`thread/unsubscribe` or lease disconnect removes only that Client; it never
forwards a native unsubscribe. A pending `thread/resume` is a provisional read
target so notifications arriving before its reply can enter that Client's
resume buffer. Detach/disconnect invalidates the provisional target, and a late
reply cannot reattach it or acquire the separate interaction-response owner.
The Host keeps the physical subscription while any logical reader, admitted
Turn, unsettled queue item or unanswered AppServer request still needs events.
Only an idle, demand-free native Thread is released (2-minute grace for
durable Threads, immediate for ephemeral Threads); release and new native work
serialize per Thread. This is live fan-out plus snapshot/replay during resume,
not a durable event log or multi-tenant authorization boundary.

The packaged Codex runtime is selected by `runtime/codex/package-lock.json`. Its loaded paginated-Thread
resume path can attach a new Client with `excludeTurns` without materializing
the full persisted history. OpenCraft still sends the physical `thread/resume`;
skipping it would lose atomic subscription and interaction ownership. A
server-rejected Resume is retained for the current connection generation so
automatic View reacquisition does not replay the same failed native request.
An explicit user retry and a new physical generation may retry; transport
failures are not memoized. A provider may explicitly declare a transient RPC
failure with `error.data.retryable: true`; it is also not memoized and the
Workbench's history recovery may retry it until its demand is released. Explicit false or malformed retryability retains the rejection behavior.
For legacy generic server/internal history errors without a hint, the Workbench
read-only recovery owner explicitly reissues Resume with capped backoff; Session
still memoizes other rejections and never retries ordinary commands. This does not enable
automatic replay of arbitrary commands. The shorter Host grace is an additional release
policy, not a substitute for Codex's own idle-thread cleanup.

Native Fork copies a complete, validated event/context prefix with opaque
provider state, not the currently loaded UI turns. Turn boundaries use logical
to-native generation coordinates. Fork gets a new logical identity; execution
recovery keeps the existing identity. Side Chat adds a canonical inherited-history
boundary before acquiring a view or accepting new work. It inherits the effective
model, roots and permissions without continuing the parent task. Its close
transaction retains cleanup ownership for retry and preserves primary failures.

The Thread menu and Side Chat read one versioned Host lifecycle extension,
`opencraft/thread-lifecycle`; an absent, unknown-version or omitted operation
is unsupported. Codex and DSH both use the generic `thread/fork` menu action
and navigate only after the Host acknowledges the child. The menu keeps a
visible pending state while that acknowledgment is outstanding;
once acknowledged, it opens the child without waiting for a background thread
catalog refresh. A changed route scope prevents the late result from stealing
navigation, while the catalog refresh still runs for eventual list freshness.
Ordinary menu Fork requests metadata only (`excludeTurns: true`); opening the child uses the normal paginated history path, avoiding a full-history response that the catalog would discard. Completed, failed and interrupted historical replies expose “Branch from here”, passing their native `lastTurnId` inclusively. Pending/streaming and cached non-authoritative views expose no executable turn fork. The parent history is unchanged; later turns are omitted from the child by the engine, never by slicing rendered messages. The action disables duplicate clicks while pending and reports failures without automatic retry.
Ordinary Fork keeps the native AppServer parameter semantics and has no
Workbench request deadline; unlike short reads, a large-history Fork must not
be declared failed after the generic 30 seconds. A transport loss still leaves
the outcome unknown, so the UI warns against blind retry rather than claiming
that the child was not created. Identical concurrent durable Fork intents
share one pending AppServer request within the Host runtime.
Temporary Side Chat requires explicit fork or ephemeralFork, plus ephemeral, inject-items and
unsubscribe support. Codex
Fork is only recoverable after the source's first Turn has been accepted;
paginated ephemeral Fork uses `excludeTurns: true` and its returned child is
adopted as the baseline rather than resumed from durable storage. The shared
Codex Engine adapter subscribes only the requesting logical client to the
child; a disconnected client's late Fork response cannot reclaim ownership.
Codex persists a blank durable Fork so `thread/read` can recover it after an
engine restart, but its native `thread/list` omits that child until the first
child Turn completes. The Host-scoped Workbench runtime temporarily projects
the acknowledged child into the default catalog and removes that projection
once the native list includes it; ephemeral children and filtered/archived
queries are never overlaid. The projection is in-memory, so a browser reload
before the child's first Turn retains direct-route recovery but not sidebar
discovery of that blank child.
`ephemeralFork` additionally declares temporary context forks without enabling
persistent Fork actions. Side Chat requires `fork` or `ephemeralFork` together
with ephemeral, injection and unsubscribe support, resolved for its parent Thread.


The SDK fences late unsubscribe responses, retains newly acquired views and
actually reattaches them. Naming uses per-Host/Thread acknowledgement queues and
optimistic-write generations; archive/unarchive modifies durable catalog state,
never deletes a workspace. Catalog notifications invalidate shared queries.
Codex Host exposes rename through `thread/name/set`; the native `thread.name`
is readable from list/read and survives an AppServer restart. The Workbench
title writer keeps optimistic edits scoped to the same Host/Thread until the
native acknowledgement or failure arrives.
The application shell alone projects the current page title to `document.title`
as `<page title> · <application name>`, sharing the header's task/extension title rather
than introducing a second title cache. The managed site Web uses `the managed-site brand`, including initial HTML;
Electron uses `OpenCraft`, and embedded workbenches leave the host title unchanged.
Draft and Settings pages use the application name;
background conversations and panels cannot overwrite the document title.
Codex Host advertises archive only when its native AppServer path is wired:
`thread/archive` and `thread/unarchive` pass through the logical-client adapter,
and archived Settings reads native `thread/list {archived:true}`. A Codex Thread
without a first accepted Turn has no rollout to archive; the existing
first-Turn durability rule keeps that blank Thread out of the durable sidebar.
The main sidebar offers only Host-declared operations for active Threads and
does not retain archive-management or transient undo state. Archived browsing
and restore belong to a capability-gated Settings page, scoped to the active
Host and backed by the same catalog query/invalidation owner. All menus and
settings controls reuse the existing Radix and theme primitives. Source and acceptance are tracked in
[the lifecycle plan](../../../design/thread-lifecycle/task_plan.md).

### Embedded connection recovery

The resident Host runtime remains the sole backoff/reconnect owner. Embedded startup
observes readiness across failures instead of disposing on the first rejection.
Hermes capability initialization overlaps independent control-plane Bot bindings,
native Profile discovery and hosted-room capability reads. It still waits for
their current-connection results before advertising capabilities; an unsupported
Profile API remains an absent Bot capability, while control-plane failures still
fail initialization. The first conversation list remains a fresh `session.list`
read after Host readiness, not a speculative cache that could mask session
changes during connection. Transport stage logs distinguish Host connection,
initialize and `thread/list` latency without recording conversation content.
Disconnects preserve Thread, Composer document and attachment owners; reconnect
rehydrates existing threads and does not replay user submissions. The console shows
a slow-connection notice after 30 seconds; fixed-Profile Hermes transport attempts
have a 90-second deadline. Timeout fences late bootstrap responses and releases the
physical connection; disposal cancels pending startup. Manual retry shares an active
attempt. Authentication/configuration/resource failures retain their manual-recovery
classification. Account or Bot changes retire the old component and credentials;
preservation applies within that owner, not across account changes or refresh.

Embedded browser metadata (pages, tabs and conversation bindings) uses storage
owned by one Application lifetime. Closing the panel parks its pages; switching
conversations selects that conversation scope. Bot or account changes dispose the
Application and do not restore the previous identity's browser metadata. This is
presentation isolation, not an OS filesystem or browser-cookie security boundary.

### Global conversation text search

The global dialog keeps immediate title matching over the complete admitted metadata catalog and debounces ephemeral Codex `thread/search` queries per Server. Shared-native SSH admission forwards this stateless read and `thread/searchOccurrences`; no local transcript mirror, persistent index, resume, execution or history reconciliation is performed to search. Admission does not establish upstream feature support: native method-not-found and the known DSH unsupported-method response retain title-only operation. Other failures, disconnected Servers and remaining cursors stay visible instead of becoming empty complete results. Each Server scan is serialized; obsolete queued queries are skipped, and query, recipe, authorization and connection-incarnation changes fence results. Pages are loaded explicitly with cursor-cycle protection, deduplicated by Server route and Thread ID, and retain other Servers' results on failure.

Results render escaped message snippets. Selection resolves the first native visible occurrence, opens its conversation through the existing navigation transaction, and uses ConversationNavigationSource hydration/projection plus measured virtualized prompt positioning. User hits select their prompt; assistant hits open the containing turn at its prompt, retaining the surrounding context. Raw-history matches without a visible occurrence still open the conversation with an explicit positioning notice; failures to locate can be retried in the dialog. Native keyword scanning speed is not an indexed-search latency guarantee.

## Startup resource ownership

启动按资源所有权分为四段，Web、Electron renderer 和嵌入 Workbench 使用同一个 Application，而不是为加快首屏再创建一份 Host 或账户。

| 阶段 | Owner / 进入条件 | 资源与退出条件 |
|---|---|---|
| Bootstrap | 页面/元素 owner | 主题、偏好与语言控制器；关闭页面取消后续安装 |
| Required | Application | 注册 provider、恢复当前 Host/路由/草稿、Shell/Composer；不得把当前 Host 连接降成后台功能 |
| Optional | Application 的 OptionalFeatureStartup | 首个可用页面提交并经过 paint 后启动；每项之间让出主线程，隐藏时等待 visibility 事件，dispose 取消并 drain 已开始的激活 |
| Demand | View 或连接尝试 owner | 设置/管理、连接器、文件预览、扩展解析器和 Hermes 协议实现；挂载或 connect 才导入，退役后不得安装迟到结果 |

显式打开 `/views/opencraft.tasks.board` 时，Tasks 的注册属于该路由的 Required 阶段，
在首个 Shell 呈现前完成；不能把尚在 Optional 队列的注册误判为扩展不可用并退回聊天。
从普通聊天启动时仍走同一 Optional owner 与加载/取消边界。此规则保留深链和刷新意图，
不提前加载所有管理页。

注册描述、业务服务和视图实现分开。下游产品/Hermes/内建 Agent 仍同步注册可发现页面及 provider；`createDeferredView` 只缓存成功的组件、合并并发加载，失败可重试，卸载屏蔽迟到呈现。页面离开不会销毁 Application 持有的账户、Host、会话或草稿。Hermes 使用 `DeferredDuplexTransport`，预先注册的同步 provider ABI 不变，只有 connect 才获取物理协议模块；转发消息、发送者 context、状态/失败分类和恢复提示，close 撤销尝试并关闭迟到 transport。

生成的 Agent Console 字典由同步器的 renderer 适配策略管理：保留全部语种的字面量动态导入，在管理页显示前准备当前字典；同一加载合并、失败删除 pending、语言代次屏蔽旧切换。不得仅设置区域编译常量而把国际站字典裁掉。Next SSR 真源行为不变，Metro 不引入 top-level await。

页面样式随页面代码进入；Shell 与会话样式由主入口持有。嵌入式 shadow root 通过 `bindShadowFeatureStyles` 镜像 Workbench 资源前缀下的延迟样式，文档副本服务文档级 portal；不复制宿主站点 CSS，随元素销毁断开 observer。包体门禁与静态协商见 [启动资源治理](../../startup-performance.md)。

启动装配入口是 `runtime/web-workbench-supervisor.ts`；命令、配置与共享服务类型在 `workbench-application-services.ts`，React Context/Provider/hooks 在 `appserver-runtime-context.tsx`。旧 Context 导入保持具名导出兼容，composition root 直接消费 supervisor。共享呈现 chunk 不再持有扩展动态导入映射，避免一个可选插件的新哈希让所有上下文消费者失去缓存。不得重新把插件装配放回跨页面使用的 hook 模块。

静态关键图显式包含HTML动态引导的main.tsx：异步语法本身不表示可选资源。主入口CSS属于Bootstrap；paint后的Optional功能样式则在实际请求测量中另计，不能用静态报告替代总加载成本。


### Recovery episode diagnostics

One outage retains a `recoveryId` across backoff and connection attempts. Host-ready
is a distinct stage from authoritative history and generation-scoped capability
declaration readiness. Deferred registration is not proof that an Agent is active:
execution still awaits its admission/activation contract. The owner emits safe
stage durations, recovery request/UTF-8 response bytes, compatibility projection
compute time (separate from Replica publication readiness) and extra conversation counts. DSH additionally returns actual native
history reads/events and projection duration for each Resume. Native and renderer
spans use their own clocks; do not subtract timestamps across processes.

Web forwards only an explicit metadata whitelist to the existing diagnostic
endpoint (1 KiB limit); it excludes content, IDs of conversations, request params,
credentials and raw errors. Offline reports retain at most 32 episode/stage entries;
new lifecycle events/online flush them, without a telemetry retry timer. Logs do
not claim UI paint or phone power measurements. Read-only query cache invalidation
remains an application adapter; its RPCs join episode request metrics while the
episode is active.

### Operation acknowledgement

Thread action acknowledgement and catalog revalidation have separate lifetimes.
Rename/delete UI settles after the native write; refreshing the complete catalog
continues in the background and cannot reinterpret a confirmed write as failure.
Deletion reports pending,
acknowledged or failed states through the existing notification owner. Conversation
menus are non-modal: the dialog they open owns the sole focus/pointer lock, which
must be released on confirm, cancel and Escape without editing body styles.
Turn interruption remains Thread-owned, coalesces pending requests for the same
Turn, and projects `interrupting` into Composer progress. Failure restores the
control and reports an error only for the still-matching visible owner.


Conversation resources use the same core Collaboration message/idempotency/handoff authority as Actor channels. Stable references, bounded untrusted native-history context, explicit model delegation and the existing Host queue are documented in [conversation interoperability](../conversation-interoperability.md). Renderer routes never supply execution identity.


### Token usage collection controls and account presentation

The optional Token usage Settings view consumes the trusted first-party Host
query capability. Its collection control appears only when the current snapshot
explicitly declares `canConfigure`; the Host requires the current instance
administrator and accepts only a boolean `enabled` on its configure method.
Collection and view lifecycles remain independent. Pausing retains acquired
amounts and exposes incomplete coverage; re-enabling admits only new turns.
Account scope changes remount the presentation before reusing any snapshot,
and pending controls fence their late effects to the original generation. The
Host remains the authorization authority; presentation scope never grants access.
Number/date formatting follows the app locale, with Chinese and English copy
using the existing Settings bilingual presentation convention.

The usage view retains its current content height while a filter or drilldown query is pending. Returning from a conversation restores the summary cursor, scroll position and initiating row focus within the existing Settings viewport; it does not create another scroll owner. Account changes still remount and clear the previous principal’s snapshot.

Each physical TokenUsageQuery owner retains its two immutable timezone/date formatters. Query filters and authority remain per request; no actor-keyed formatter or completed-response cache is introduced. This bounds repeated ICU allocation during long-lived read workloads.

Usage snapshots may include summary.threads, the distinct conversation count over the complete authorized filter intersection, independently of the detail page. Older Hosts may omit the additive field. The view highlights settled tokens, keeps provisional/pending/system/unknown amounts separate, and presents model aggregates as readable numeric rows as well as filters.

The Token usage view is a managed optional built-in (`opencraft.token-usage`) on Web/Electron. Its manifest is discovered without importing the dashboard; activation contributes the Settings page and deferred platform renderer through the existing supervisor. Disabling withdraws those contributions and preserves the Host ledger and collection configuration. Persisted installation intent is owned by ExtensionManager; no second lifecycle or metering state is introduced.

The physical Token ledger reuses parameterized SQLite statements in a SQL-shape map bounded to 128 entries, avoiding per-event native statement allocation. The database owner still closes the connection; exact allocations, transaction boundaries and authorization are unchanged. No actor-keyed or completed-result cache is introduced.

The read-only usage query owner also bounds native prepared statements to 128 SQL shapes and lends only its prepare port to team projections. Manual bulk iterators close before snapshot rollback on success and exceptions, allowing later reads to reuse that physical owner. This is statement reuse, not a completed-response or per-person cache.

Token metering has its own managed `token-usage.sqlite` physical transaction owner
and an atomic, read-only import from former shared Host tables. Sender/queue
storage remains independent; no collector writes two ledgers. A metering lock or
failed open cannot block native input admission, and unpersisted acquisition
gaps mark returned coverage partial. Query workers have a 64MiB old-generation
and 4MiB young-generation limit; scan failure rejects bounded reads and lazily
restarts the worker. Source rebuilds select only the four fields they consume,
reducing allocation without changing ordering or exact arithmetic. The limits
and narrow row shape require measured resource/latency acceptance, not just
successful compilation.


#### Token usage people presentation

The optional dashboard selects a person from the existing authorized, paginated people usage view. The Host decorates only authorized team people rows with current human Actor display names through its existing identity-directory port, then rechecks the original request authority before delivery. Names are presentation metadata, never a participant key, identity binding, allocation weight, or ledger column. The same signed paging/date/model intersection applies when browsing people; choosing a row returns to that person's allocated conversation totals, and clearing the filter restores the team view. Self queries do not resolve or expose other people's names. Missing directory entries remain explicitly unknown; no enterprise directory or statistics account system is introduced.


Unchanged native metering metadata is idempotent at the persistence boundary: reconciliation compares stored execution/completeness evidence before rebuilding, and repeated rollout references or metadata cursors avoid writes. Effective participant completeness can remain false due to unresolved admissions without triggering polling rebuilds. Fact and admission mutations retain their own projection updates; changed terminal/response evidence continues through the normal reconciliation transaction. This does not alter source identity, equal allocation, database schema or query authorization.


Dedicated metering store v2 adds a thread/date index so filtered thread/turn reads seek the selected thread before its date range. This changes query planning without changing allocation, snapshot revisions, query authorization or the former Host schema. The managed database migration and complete target validator own index creation; repeated opens do not recreate it. Thread/turn-filtered team reductions materialize their selected turn set before grouping, preventing grouped plans from bypassing the thread index; unfiltered projection reads retain their original path.


The bounded native usage replay reports each oversized line once through
`onOversizedLine(mayContainFact, bytes)`. This observation cannot invent a usage
gap: ordinary output remains a skipped non-fact, possible facts retain the
existing missing-source reconciliation, and the committed cursor resumes after
the complete line. The observer has one typed call shape, never a second
object-shaped compatibility invocation.


Pending View acquisition reserves residency demand before asynchronous binding
publication. A queue/view observer cannot evict that binding before its lease is
admitted, including with zero inactive-cache allowance. Optional older-history
reads do not count as execution commands. The last retained View and observer
leaving retires derived read waits while preserving the cached baseline, history
source, execution work and healthy Host. A pending replacement acquisition or peer
View/observer keeps a shared read alive. Local ABORTED retirement does not become
a cached history error; genuine read failures retain their existing error behavior.
A released lease cannot start another optional read. This is local cancellation,
not remote execution cancellation or an automatic write retry.


## Prepared offline Web shell

Production Web builds emit an application Service Worker, pristine offline HTML,
and a bounded public asset manifest. The shell includes emitted JS/CSS/fonts and
small build resources, excludes document-preview optional assets, source maps and
private responses, and fails its build if public precache exceeds 64 MiB. It is
registered after usable paint; Electron/embedded builds do not register it.

Each deployment scope/build has its own cache. Installation uses credential-free,
nonredirected requests and removes its own partial cache on failure. Normal worker
activation retires previous shell caches for that scope; no forced skipWaiting
mixes active application generations. Navigation is network-first and only known
application routes fall back on transport failure/5xx. Login/auth/API routes and
401/403 responses never fall back. Static cache hits only cover declared build URLs.
Startup configuration is an explicit sanitized allowlist, without credentials,
private runtime HTML, query tokens or API responses.

Remote-browser capability discovery cannot indefinitely block offline Chat.
A same-build backend hint can select only presentation while offline; unknown
never silently selects an iframe. Remote metadata initialization waits in the
background for a fresh authoritative capability and authenticated state. Before
that, metadata writes and remote surface admission are unavailable. On readiness,
owners re-read their original metadata without replacing already active identity;
server leases continue to arbitrate input. Online startup still probes normally.

The browser-local remembered account chooses an input partition only, never an
Actor or native proof. Explicit logout clears it. Full offline acceptance requires
an actual new document under network-offline conditions, saved draft/queue recovery
and no send before live verification; a cached HTML response alone is insufficient.

### Fork execution choices

A thread-ID Codex fork inherits the source's current model, provider, reasoning
effort and service tier from an acknowledged native snapshot. Explicit fork
overrides take precedence, including explicit null. Credentials, tool entries and
permissions are not copied by this policy. Path forks retain native semantics.
The Workbench adopts the fork response for durable and temporary children so
read-only history hydration preserves the newly acknowledged execution choices.
