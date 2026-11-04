# ChatUI: History and recovery

[Architecture index](../../chat-ui-architecture.md) · [Documentation index](../../README.md)

## Platform-owned conversation facts

The Headless gateway retains display history in its Server SQLite owner for the
built-in Host namespaces. Opening stored history does not require a running
Codex, Pi or DSH execution process. A new connection still discovers native
capabilities; if that discovery fails or exceeds its bounded deadline, stored
history remains readable with the gateway's reading capabilities. Native writes
always require a successful native initialization and the existing ingress
identity, access, execution and interaction checks.

The Server owner stores three core tables and one small directory head:

| Table | Authority and important columns |
| --- | --- |
| `conversation_threads` | `(scope,id)` preserves links. `revision` advances for visible changes; `epoch` invalidates incompatible view cursors. `model_version` distinguishes an explicit baseline from legacy indexes. `metadata`, `history`, `archived` and `recency` are projections; a deleted head is a durable lifecycle tombstone. |
| `conversation_events` | `(scope,thread_id,revision)` is the committed event identity and order, distinct from affected `event_key`/`record_id`. Immutable versioned bodies express baseline, metadata, put, remove, order, coverage and archive operations. Current/index columns are disposable lookups. |
| `conversation_payloads` | `(scope,hash)` addresses integrity-checked immutable bodies. Migrated baselines list their body references and original record revisions. |
| `conversation_catalogs` | One `(scope,revision,sync_state)` row owns persistent directory observation epochs, traversal coverage and unavailable sources by exact query, including archived/filter conditions. Native continuations remain connection-owned. It is neither a fake Thread nor an execution owner. |

Execution status remains owned by the execution Server. Stored metadata keeps
`notLoaded`; the history transport projects the current source status onto both
metadata reads and directory pages without persisting it. Live status facts
supersede directory snapshots, including later reads from a lagging directory
cache. Turn/Item activity and historical read replies cannot manufacture status
or erase approval/input wait flags. Source loss clears the volatile projection;
old-incarnation replies cannot restore it. A cached first directory page starts
bounded read-only source discovery in the background, and current authorized
catalog clients receive status patches even without watching that Thread. Stored
history stays readable when discovery fails; discovery never resumes a Thread
or starts a Turn.

New histories replay from an explicit empty/unknown baseline. Existing v1 data
cannot explain every old `current=0` row, so first access atomically seals the
known current projection as a v2 baseline and lowers unproven source coverage to
unknown. Original rows/bodies remain retained. Baseline plus semantic suffix can
reconstruct records, membership, order, metadata, archive and coverage without an
engine. `rebuild` is an owner recovery primitive, not a client execution method.
Recovery does not allocate a new revision or revive deleted content.

A transaction commits necessary bodies, facts, indexes, Thread version and
catalog version. Removal and coverage-only changes have facts and advance the
version. Adjacent equal puts are idempotent; A → B → A still records the final A.
There is no claim of native exactly-once capture when the source supplies no
stable event identity. No valid baseline/log prefix or referenced body is pruned.
True Thread deletion removes its content and retains a minimal rejecting head;
old native replies, directory entries and notifications cannot recreate it.
A persistence failure rolls back both versions and watermarks and is diagnosed
separately from native delivery. Delivery alone never promises persistence.

Headless lends a connection to one history Worker Thread after the managed
Server owner has acquired `server.lock` and completed migration/import. All
history scopes share that worker's FIFO; hashing, model replay, directory scans,
SQLite transactions and search indexing run there, outside the gateway event
loop. The existing consolidated database and schema remain authoritative. The
worker never migrates, acquires a second installation lock, or opens legacy data.
The account-domain connection remains with the Server owner; WAL permits its
reads during history writes. SQLite still serializes writers: account mutations
can contend with a history transaction. Worker-side busy waits use asynchronous
bounded retries after rollback, rather than sleeping the gateway. This change
does not move every account-domain synchronous operation off-thread.

Live notifications publish before entering the ordered persistence tail. Reads
and source imports await accepted writes; imports also enter the same mutation
tail. A queued source import rechecks its live source, client and read permission
immediately before worker execution, with no SQL transaction held while awaiting
authorization. Accepted live observations still drain if their source retires.
Each operation returns commit facts (including explicit deletion identities)
before its result; watchers are checked against their current gateway authority.
Search authorization is requested for FTS candidate identities outside the SQL
transaction and rechecked before returning results. No callback or database
handle crosses the thread boundary. Connection capability discovery stays in
memory in its logical client and cannot queue behind background indexing. Native
execution still requires its normal initialization and authority checks.

Closing a transport drains accepted writes and responses before releasing its
history handle. Headless then drains/closes the shared worker before releasing
its Server connection and installation lock, including startup/disposal error
paths. Worker failure rejects pending operations; it never silently falls back
to synchronous gateway writes or automatically replays unknown commits. The
packaged worker is a separate bundled runtime artifact; source checkouts use a
TypeScript bootstrap. Synchronous fixtures retain cooperative yielding between
complete operations, which is not the runtime isolation mechanism.

Groups are source associations for the existing Turn/Item compatibility API,
not a universal UI hierarchy. Summary/header input cannot remove missing members
or overwrite full detail. Explicit full source membership replacement records
removals. Indexed summaries read first user/last assistant records; presentation
previews defer large tools through `historyDetail`. Detail reads hydrate only the
requested record, and a stored Item prefix retains its native continuation.
Item source ranges retain their direction and visible source members. A request
in the opposite direction starts a bounded native scan in the current logical
connection; it never replays a stored native continuation from another direction
or connection. A successful source page is published only after its facts and
history version commit. Item entries must name the requested Turn. Lifecycle
clocks from notification/page envelopes are copied into the stored Item, and
missing clocks in a later snapshot cannot erase observed clocks; terminal Turn
status likewise cannot regress to an active status through a sparse snapshot.

Display order uses explicit membership lists and integer indexes, independently
of event ingestion order. Platform cursors bind to Thread epoch and object
anchors; backfill resolves surviving anchors to their current index. Removal or
reordering invalidates incompatible views. Source cursors only continue imports. Directory source continuations are
connection-local, consumable hints. New directory observations persist only
`hasMore` and `observed`; they never persist the native continuation. Legacy
`next` observations are read as a gap hint and never replayed. Each authorized
connection serializes native directory reads per query and owns its transient
continuation, initial metadata fence and evidence that its scan began at head.
A head revalidation merges directory facts without replacing that traversal.

The history owner separates three identities: `historyVersion.revision` reports
committed display changes, `historyCoverage.epoch` fences invalidated directory
observations, and the native cursor belongs to one connection's scan. Coverage
is monotonic within an observation epoch: a nonterminal head cannot undo a
previously observed EOF. A scan started from an untracked native continuation
cannot establish EOF for the whole query. An observed EOF is a historical
observation, not a guarantee of a current or permanent complete native snapshot.
Explicit catalog invalidation, physical source retirement/replacement and source
availability/coverage transitions retire prior observations while keeping saved
rows. Retryable cursor expiration retires that query's observation. Imports
capture the epoch before dispatch and verify it again in the writer transaction;
a late reply cannot merge facts or advance a replacement epoch. Invalidation
notifications deduplicate by producer source/revision. Query-local invalidation
preserves other query epochs; source invalidation applies to all queries.
Epochs survive reopen and never grant authorization or replace row-level fences.
A missing platform range starts a bounded read-only scan, preserving the platform
keyset position; a retryable expired source continuation restarts once. Directory
imports capture a per-record digest of directory metadata, archive and deletion
facts when a native scan starts, retaining that same fence across its pages.
Records changed since that snapshot retain their newer local values; unaffected
and newly observed records still import, without discarding the whole page.
This also observes writes from older connections. Item bodies, search indexing
and history coverage do not invalidate that metadata-only import. Capturing an
unchanged directory reuses an immutable digest map only when SQLite
`data_version` (other connections), `total_changes()` (this connection) and
`schema_version` (including same-connection DDL) match.
Any unknown write conservatively rebuilds the next capture; a transaction-local
capture is never retained because rollback does not restore `total_changes()`.
An outstanding scan keeps its original map rather than a mutated shared fence.
Native page reads reuse a supplied map without constructing and discarding a
second full-directory capture. Independent head revalidation takes its own fence.
Repeated archive observations skip an unchanged row update. This optimization
does not cache authorization, source results or directory completeness.
No new table or migration
is needed; ordinary history imports retain their per-Thread revision fence. Internal
older-range scans alone may merge after concurrent Item puts: immutable facts since
admission must contain only those puts, and each touched group keeps its entire
current header, membership, bodies and body coverage. Unaffected groups and source
continuation still advance, so continuous output cannot repeatedly discard older
pages. A full source page that omits a protected group is rejected. Metadata,
membership removal, group lifecycle, order, archive and coverage changes still
reject the stale import; no wire parameter enables this exception. Platform
directory cursors never cross the native boundary. Cached continuation pages do
not launch background source refreshes. Source-cursor/coverage rotation alone
does not invalidate directory membership and cannot create a refresh feedback
loop; metadata and source-availability changes retain their notifications.
Latest source pages expose their connected observed segment; sharing an existing
Turn does not join an unknown middle to older retained content.

Coverage reports structure separately from per-record body coverage. A complete
single source read is an observation at that read, not permanent completeness.
DSH beforeSeq, Pi/Codex transcript cache epochs and generic projection anchors do
not currently provide a universal native snapshot generation at this boundary.
Multi-page scans without that proof remain partial even at native EOF. Contents
remain readable; unavailable continuation is not converted to completeness.
An engine-host directory also retains `unavailableEngines`, even when its offset
cursor is exhausted. Directory coverage and invalidation epochs survive owner reopen; native scan
progress does not. It is not inferred
from the sum of Thread revisions. Imports use a conservative whole-Thread
revision fence, with only the protected-group exception for internal older-range
scans described above; ordinary snapshots cannot overwrite newer live content.

Read results carry persistent `historyVersion` and `historyCoverage` from the
same synchronous database transaction. Postcommit display updates use the durable
version and carry only changed presentation records, explicit removals and order.
They merge by stable identity without entering the open/reconnect read path,
retiring paging/detail work or replacing the loaded history range. Unmounted
older groups are not mounted by an unrelated import. An active source snapshot
cannot overwrite Items with locally observed streaming deltas; explicit Item
completion or a terminal Turn can settle them. Read baselines fence buffered
updates by revision. Native execution notifications retain their original order
and payload. Body/coverage commits do not invalidate the directory; metadata and
directory observations do. Metadata-only reads do not hydrate Turn/Item bodies.
Entering a Thread and reconnecting reread it; continuous-connection periodic
repair of a lost notification is not provided by this change.

The store stays below the existing Thread access session. Cached discovery or
content grants no execution permission. Account visibility is rechecked at
ingress and publication, including revocation. SSH bindings retain their existing
source/credential boundaries and are not silently imported into built-in scopes.

This is a display ledger. Codex rollout, Pi/DSH sessions, execution leases and
interaction ownership keep their owners. Only observed/imported content is
available offline. Completed Items and received lifecycle facts are retained;
raw token chunks do not acquire a durable recovery promise. No global history
scan, input replay, engine restart or migration is implicit in opening a page.

## Versioned stored snapshots and live output

The persistent history adapter declares `opencraft/read-history.versionedUpdates`.
Each committed transaction publishes its exact `baseVersion` and end `version`,
using the existing Thread epoch and revision. Rollback restores the transaction
base; publication freezes both versions before invoking external observers.
A revision can span several semantic facts, so adjacency means the next update's
base equals the installed version, rather than end revision increasing by one.

A full initial-page reply captures a synchronous receive cut owned by its request,
before later notifications or Promise continuations can run. The canonical saved
snapshot owns durable membership and lifecycle before that cut. Compatible active
Item text can retain transient native paint; a terminal saved snapshot wins over
older native lifecycle observations. Native observations after the cut replay
once. Raw chunks still have no additional durability guarantee. Providers without
this declaration, or replies requiring further page hydration, retain the quiet-cut
compatibility path and the applicable elapsed budget.

A missing or malformed committed range never advances the installed watermark.
The Session marks history as requiring synchronization, and Conversation withdraws
historical authority while retaining painted content. The existing Host recovery
owner issues a read-only repair; there is no second retry owner or execution replay.
The request carries `historyBaseVersion`. When the epoch matches, the existing
semantic ledger supplies a sparse `historyUpdate` through the snapshot version,
retaining loaded older pages and unchanged disclosed bodies. An epoch invalidation
falls back to a canonical replacement. No new table or full-history scan is needed.

## Shared history backfill coordinator

For providers advertising version-1 `opencraft/read-history.initialTurnsPage`
(or the older explicit `boundedRecovery` declaration), the initial read-only
history baseline uses the elapsed operation budget from admission,
including metadata, adaptive Turn pages, Item hydration and quiet-cut rereads.
Individually successful RPCs cannot renew that budget. Local
expiry retires the read even when a child ignores cancellation; a successor may
recover through the existing Host history owner and late replies cannot commit.
Previously painted Turns remain available. Zero explicitly disables the budget.
Legacy full-body readers retain their per-RPC progress budget until quiet-cut
rereads. Legacy message-window Resume and execution activation keep their own deadlines.

Session bounds each derived older-page load and optional history refresh by
the configured `requestTimeoutMs` elapsed budget (zero explicitly disables it).
The deadline starts at admission and includes waiting for the preceding refresh
or page, strategy work and all Item hydration RPCs. A per-RPC timeout alone
cannot bound this operation: message-window readers may disable that timeout,
and individually successful Item pages can keep an aggregate read pending.
Expiry settles the local owner before aborting children; superseded replies
cannot commit, the loaded timeline remains available, and an older-page caller
receives a retryable timeout. Optional refresh retirement retains its existing
`false` outcome. A joining caller's cancellation still does not cancel its owner.
Source retirement clears the old pagination loading flag before cancellation
observers may admit a successor, including when the source's slots have already
been removed. The Replica's local loading flag settles with the page promise.

`TurnHistoryBackfillCoordinator` owns one history-load operation and layout epoch
through the existing `timeline-react` adapter. Same-generation requests share the
operation; replacement generations wait for old work, including failures, before
starting another load. A completed page always reaches the platform layout
barrier, then current ownership/enabled state, explicit stop, missing geometry or
unchanged height ends continuation. Web and Native retain their own measurements
and frame scheduling.

## Shared Turn measurement transactions

`createTurnMeasurementTransaction` projects one measured batch into the height
table, layout, viewport and pending scroll/restore decision. It consumes the
synchronous controller distance, retaining already pending scroll and latest-row
height notifications across uncommitted batches. Callback presence grants its
existing ownership even when no restore target is pending. Web executes the
unchanged synchronous/pending commit paths; Native retains measurement leases
and frame scheduling. Neither platform adds another compensation policy.

### Scroll state and geometry reads

The scroll controller owns confirmed distance and animation state. State-only
controls use `getState` and `subscribeState`; rendering or subscribing a bottom
button must not sample DOM geometry. Measured snapshots remain available to
geometry consumers, and platform scroll events and imperative commands still
reconcile the physical, possibly clamped distance before publishing state.

Footer padding is established on the first measurable height without reading
post-write scroll geometry for compensation. Only subsequent eligible resizes
measure and compensate; parked routes, active animations and explicit preserve
suppression retain their existing rules.

### Initial history and display reuse

Durable paginated providers that explicitly advertise initial-page support may
return the newest five full Turns in Resume. The Session consumes that page once;
it does not issue another Turn/Item read for the same initial window. Providers without this advertisement keep bounded per-Turn Item reads:
a single large native full-Turn response can regress low-latency restoration. Headers-only replies
retain the existing per-Turn Item reader, and transport frame-limit errors fall
back to that reader's adaptive Item pages. An oversized merged Resume retries
without the page before using this reader. Legacy providers keep full-history
compatibility. Full pages retain all Items, older cursors and chronological order;
no tool output or interaction is truncated to improve timing.

Read-only opening and older-page loading halve an oversized full Turn page down
to one Turn before falling back to headers and adaptive Item reads. A successful
smaller page retains its native continuation cursor, so the remaining Turns load
on demand. This avoids eagerly hydrating every Turn in the rejected large page
over a shared remote connection. Only typed history-size failures trigger this
adaptation; other failures propagate, and no Resume or mutation is retried.

ConversationDisplayContinuity keeps at most 64 already-projected text displays
in its existing account/Host/Thread scope. `peek` exposes a synchronous paint-only
snapshot, including before an asynchronous persistence write finishes.
The current Turn's received input, partial answer, commentary and returned
reasoning text are retained as static paint-only blocks. Partial answers retain
their incomplete marker and commentary stays in Agent Activity; no streaming
animation, active clock, tool output or interaction is replayed. Slow storage
coalesces pending observations to the latest snapshot while memory updates
synchronously. A fresh authoritative baseline replaces the snapshot as usual.
User and assistant message timestamps and terminal work clocks/durations are retained
with the text. Footer sending clocks keep their metadata and slot geometry through
reload, independently of whether desktop pointer disclosure currently paints them;
touch input paints those clocks at rest, including before the first touch. A reload
therefore restores the date together with its message while the Host reconnects.
Live work clocks are never restored from this
cache. Legacy text-only entries remain readable with unknown clocks until the
next authoritative observation refreshes them. Timing-only changes update the
projection even when message text is unchanged. A retained terminal work clock
can render without cached tool bodies; it does not restore expandable tools. Web and
Native consult it during render before starting disk restoration. The same
seven-day age and 24-message/text limits apply; disk loads keep the original
expiry time, authoritative empty history removes a display, and a delayed disk
read cannot replace a newer observation. Account scope replacement discards the
owner. This memory is a projection cache, not a second history authority, Replica
checkpoint, execution lease, or source for tool/approval actions.

The Web Application resolves display identity from its committed View Scope
binding before a network Thread lease exists, and renders a nonempty display
while the initial lease is still being acquired. Display identity remains
separate from the active execution lease. The cold-stage spinner is reserved for a missing lease
and no visible history; it must not hide a valid account-scoped display behind
Host initialization. Persisted display restoration after a page reload follows
the same rule as the transient first-submission handoff. Canonical history still
replaces the display, and command admission still waits on the existing baseline.
A non-authoritative history preview retains missing static timestamps from the
account-scoped display only for the exact Host, Thread, Turn and block identity.
Its newer text and supplied clocks win; active frames never inherit terminal
work labels. The authoritative baseline can correct or remove all cached clocks.
This handoff remains paint-only and does not enable history or execution actions.
`scripts/smoke/conversation/smoke-session-cold-open.ts` exercises the built Application with held
initialization, canonical replacement and a separate uncached browser profile.

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
After assigning that clock, a work segment with no content units, inline
subagents or assigned duration does not occupy a presentation slot. Hidden
observations before an earlier response or asynchronous question cannot reserve
an empty layout gap. Source observations and boundary identities remain intact;
a clock-only segment, including a provided terminal duration, remains visible.
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

In the AppServer V3 compatibility reader, an established Turn/Item slot is not
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

## Restored baseline versus live entry motion

Web/Electron Conversation owns a narrow entry-motion context. Initial display,
Host/Thread changes and paint/sync recovery (including the first authoritative
live snapshot) establish a baseline, rather than a new work event. AgentActivity's
outer content and WorkStatusDivider consume that gate for their initial motion;
restored content is visible at its final geometry on the first DOM commit. Open tool details also consume that gate: the unmeasured height of a restored
open body is natural `auto`, then the existing observer supplies its pixel height.
Measurement is not a transition from zero. This also keeps the first painted frame
stable under reduced motion. Once
that baseline has committed, live insertion and user disclosure opening retain
existing transitions. This does not delay content, change elapsed-time authority,
add a cache or require backend protocol changes. A settled collapsed work header
remains synchronous. Lazy inner tool groups also restore directly into their
collapsed or explicitly expanded state. Mounting a folded Thinking group must
never expose command bodies before an effect closes them; only actual disclosure
changes have prior visible geometry to animate. Verification: `scripts/smoke/conversation/smoke-conversation-entry-motion.ts`
uses the real Conversation, checks first-commit opacity/height, repeated remounts,
in-place scope switches, progressive preview/authority promotion, live work entry
and manual expansion in light/dark and desktop/touch.



<a id="server-owned-native-codex-history"></a>

## Durable Host legacy history

A Durable Host placement does not imply paginated Item support. When a resumed
Thread explicitly declares `historyMode: "legacy"`, the Durable history strategy
reads `thread/read` with `includeTurns: true` and commits a complete history
baseline. It does not call `thread/items/list`; legacy providers need not support
that method. Paginated Durable Threads retain separate Turn and Item loading;
message-window history keeps its own higher-priority strategy. This applies to
normal navigation and to conversations opened from linked Tasks alike.

### Bounded history recovery

A paginated provider may explicitly advertise `initialTurnsPage: true` and
`boundedRecovery: true` in its version-1 `opencraft/resume-history` capability.
Resume then returns the full initial page, avoiding a second Turn list and one
Items read per Turn. Older history is user-driven by default; the explicit legacy
background-drain option remains available to non-interactive callers. Navigation
seeds its loaded window and starts enumeration at the older boundary, not at the
tail already read by Resume.

`ThreadView.historyCheckpoint` is a provider-owned epoch and native sequence,
independent of connection generation. A capable provider can return unchanged,
append or replace. Unchanged keeps the exact transcript array while control state,
permissions and stream ownership still reconcile. A gap/rewind/new epoch replaces
the old window, preserving observations made during the request and unresolved
admitted work through `reconcileRecoveryWindow`. Cached running status alone
cannot override a terminal snapshot or retain an old disjoint canonical range. The older cursor
exposes skipped history. Old-page results are fenced by the Resume context and
connection generation. A binding keeps a weak immutable projection cache across
Replica source replacements. The V3 compatibility Replica epoch remains honest
about its connection-local revision model; it is not a durable server journal.

Recovery navigation caches bind to provider epoch **and nextSeq**, so unchanged
reconnects retain the index while changed history revokes its completeness.
Enumeration checks that version before publication; a superseded read cannot
mark newer history complete. Discovery begins when rail/search calls prepare,
not merely because a conversation is retained in the cache.


### Recovery technical details

Cold and retained-history recovery keep failure codes and progress in the
allowlisted console/diagnostic snapshot. The conversation renders no reconnect
failure notice, retry button, technical disclosure or copy action. A client
protocol mismatch still shows the required update/reload instruction because
retrying cannot repair an incompatible client.

The Host-owned history scheduler continues retrying transient read failures while
the conversation has visible/open demand. Backoff grows to sixty seconds with
jitter; failures do not exhaust an attempt budget. Generic legacy server/internal
RPC errors are retryable for history reads unless marked permanent. Missing or
archived conversations, permission/validation errors and explicit non-retryable
failures retain their existing handling. This policy never replays writes,
reconnects a healthy Host or grants authority to cached history. Disposal, cache-only
demand and connection replacement cancel pending work and fence late results.

## External conversation presentation and history reads

Trusted local application composition may provide `conversationPresentation` to
both WorkbenchRoot and an embedded App. It receives scoped Host/Thread facts and
existing metadata-read/fork actions, and contributes a subtitle and content before
or after the Composer. Core does not interpret product channel metadata, disable
the Composer, change delivery, or grant fork permission. The product owns its copy
and the decision to opt a conversation into visible history refresh.

`AppServerThreadRuntimeLease.refreshHistory(signal)` is a read-only operation for
resumed message-window history. It skips disconnected, non-authoritative, streaming
and pending-command states; it never sends Resume or acquires execution ownership.
The coordinator serializes it with older-page loads, reads metadata first, and
loads a fresh tail only when the metadata revision changes. It retains observations
received during the read. Connection replacement, released ownership and abort
retire late results. Existing initial-page, legacy and bounded-recovery paths remain.
The Web hook polls every five seconds while visible, checks immediately on return,
backs failures off to sixty seconds, aborts on conversation retirement, and leaves
the transcript, draft DOM and reading position mounted. It is opt-in rather than a
second automatic refresh policy for all conversations.

### In-progress recovery observations

The existing recovery owner also projects read-only progress while a connection
or a conversation is still recovering. Connection, initialization, queued history,
active history reads, retry backoff and manual stop are separate stages. A Host
snapshot carries connection progress; each resident Thread carries only its own
history progress. UI never substitutes background Thread work for the current
conversation. Timestamps, actual starts, the scheduler's retry deadline and a
bounded machine-code failure are local metadata, with at most twelve stage events.
While the current conversation is recovering (including retained display-only
history and intermediate automatic retries), a thin, tapered scan travels along
the existing Composer border every 4.8 seconds. Its read-only `isRecovering`
projection is independent of Turn streaming and does not authorize commands. It
appears after 600ms, fades out in 350ms, uses theme colors, intercepts no input and
preserves the mounted editor, draft, focus and selection. Reduced motion retains
a static faint edge. Cold history uses the same Composer feedback instead of a
central spinner. The empty Composer placeholder shows “Reconnecting…” while its Host connects or
retries, and “Loading…” while the connected conversation is being restored. The
existing recovery owner decides whether work is pending; stopped recovery and
required updates keep their update/reload instruction. The editor owns emptiness, so a
draft (including transient IME text) hides this placeholder. Changing the
placeholder preserves the same editor, focus, selection and draft; readiness
restores the normal prompt. The border scan also retains its screen-reader label. No syncing/reconnecting notice is inserted into the transcript.
Routine failures remain silent in both cold and retained-history layouts. Progress,
elapsed time, attempts and machine codes remain diagnostic observations without
visible controls or a presentation clock. Only a required client update appears
above the Composer. Recovery and revalidation keep the same editor and transcript
mounted, preserving draft, focus, selection and reading position.
A fresh work item after a terminal failure starts a new history observation;
its correlation ID and attempt count cannot inherit the completed report.
Coalesced retries of an active work item still share the original observation.

### Recovery correlation and socket liveness

Recovery observations carry the local physical `attemptId` and `eventAtMs`; the server receipt time is not the client event time. `history-started`, `history-backoff`, and allowlisted slow/failed history RPC metadata are accepted by the diagnostic endpoint. A rejected metadata record is discarded instead of blocking later reports. No request params, conversation text, credentials, URLs or Thread IDs are added.

The renderer logs the full allowlisted diagnostic to `console.log` on recovery state transitions, without an elapsed-time logging timer. Loading UI stays concise and retains existing messages and drafts.

A WebSocket Ping queued behind a large frame does not start a peer response deadline. The full heartbeat interval starts when the Ping write callback succeeds. Queued writes with decreasing buffered bytes retain the connection; four heartbeat intervals without write progress terminate as `heartbeat-write-stalled`. Delayed write, actual send, recovery and peer timeout diagnostics include the attempt ID, queued duration, buffered bytes and relevant timing; healthy idle heartbeats stay quiet. Closing a socket fences late write callbacks. This mitigates a demonstrated disconnect mechanism without claiming all reconnect failures have the same cause.


### Legacy realtime envelope presentation

The exact lowercase outer realtime envelope still marks protocol data. Inner
input, source and transcript tags retain case-insensitive matching and the first
complete pair. Role markers consume at most one optional separator whitespace;
repeated bare CR or Unicode line separators cannot be swallowed into an assistant
entry. Preserve decoded text, ordinary multiline continuation, input deduplication
and handoff identity in the shared parser; Web and Native consume its typed block.

The code text renderer snapshots native selection endpoints before an append or
syntax-only DOM update and restores their text offsets afterwards. Preserve
selection direction and endpoints outside the code, without moving focus or
scrolling. A replacement that changes existing source does not restore stale
offsets. Streaming completion and theme recoloring keep the reader's selection;
source text, highlighting policy and the code surface keep their owners. When a range crosses code surfaces, capture both stable code roots and text offsets: a theme update may replace tokens at both ends in one commit. Resolve only roots whose existing source remains unchanged or extended.

### MCP App widget state continuity

The inline App surface sits outside the raw tool-result disclosure. Collapsing raw
details does not hide or dispose the App. Existing visibility, background and
manual Pause owners still control its resource lifetime.

MCP App widget data explicitly saved through `setWidgetState` lives in Application
memory, separate from an iframe or virtualized Turn row. The active App owner
selects the state by Host, Thread, source block, server, resource URI and call ID;
replacing the connection lease preserves that data but never restores its authority.
The bridge retains its existing 32 KiB JSON limit and lease/disposal checks.
Resource access is reacquired normally. Offscreen/background frames still dispose;
ordinary DOM, focus, model context and pending operations are not checkpointed.
The App restores its own controls from the saved data; an Application reload ends
the checkpoint. Display-name changes do not change the App identity.

Manual Pause is a separate host-owned view choice in the same App scope. Row
recycling and connection replacement keep the App paused, without loading its
resource or mounting its iframe. Only an explicit Open resumes it. App-authored
widget JSON cannot change that choice. A different App identity starts with its
own choice, and an Application reload ends this in-memory preference.

A different server, resource URI, call or source block starts a new document. The
old iframe and bridge dispose before loading its replacement; resource, error,
token and navigation-load state belong to that document alone. Late resource
results cannot revive it. A display-name update keeps the existing document.
Without an owner-provided store, the surface keeps separate local cells by port
key, source block, server, resource URI and call ID. Saved JSON and manual Pause
cannot pass to a different App; returning to the original identity in that surface
retains its own cell. These fallback cells end when the surface unmounts, and a
different port key starts fresh. Cross-row or connection continuity requires the
owner-provided Application store.

### Retained-history recovery presentation

With readable history, automatic connection/history recovery and intermediate failures
render no floating notice or spinner. Only terminal/blocked failure or required client
update presents an action row in normal flow above the Composer, with collapsed
copyable technical details. Existing recovery owners, cold-state presentation,
authority, outbox and command replay remain unchanged. The Application keeps its
Composer and transcript mounted. `tests/chat/conversation-recovery.test.tsx` checks
quiet automatic retry and actionable failures.


## History loading space

The Web conversation surface owns its block-start inset inside the reversed scroll
viewport. The normal reading gap is twelve spacing units; edge-scroll hosts add
their toolbar clearance. Older-history loading uses the same reserved gap,
projecting the current history owner's loading state without changing geometry.
The indicator never overlays message text or controls and respects reduced motion.
Short conversations, restored reading anchors and both scroll policies share this
surface; loading feedback does not introduce a second scroll controller.
### Archived and missing conversation restoration
A confirmed archive/delete receipt or notification retires that Thread's live
Replica authority and automatic recovery. A definite archived/not-found rejection
from Thread metadata/Resume does the same, even if a provider also marks it
retryable. Transport failures, missing models and unknown history failures never
imply a missing conversation. Standard invalid-request/params/protocol RPC errors
are deterministic and cannot opt into automatic history retries.
The Host stays ready for other Threads. Recovery hints, reconnect and manual
restore cannot resume a retired Thread; successful explicit unarchive reopens it.
An archive fences pending hydration, so late success cannot restore authority.
The Browser Application clears only matching Host/account selection memory and
replaces an active invalid route with the existing Home and conversation list.
Late failures cannot clear a newer selection or replace a newer navigation intent.
This local draft does not create a remote Thread, unarchive it or replay input.

### Retained Web viewport measurements

A parked conversation has a zero-height scrollport. Its Web viewport owner keeps
row, follow-content, footer and viewport observations registered but does not
publish those hidden geometry records or platform scroll events. Zero layout
cannot replace the controller's durable reading distance or the virtualizer's
measured rows. The same observations resume when the viewport is measurable;
visible measurements remain synchronous and explicit scroll-to-bottom intent
keeps its existing owner. Unmounting a parked View serializes the retained
checkpoint for the replacement View. The Web virtualizer captures its measured
rows and reading distance together. If View cleanup interrupts a measurement
commit before scroll compensation, its checkpoint uses that transaction's
projected distance with the new height table, rather than the controller's
previous distance. Before releasing a measurable port, its owner reports the
final physical geometry so a local reflow need not wait for a native scroll
event to enter the checkpoint. Hidden geometry retains the previous distance.
Scroll events from a detached port cannot overwrite the
retained distance before listener cleanup. Response placement retains its own
restore position.

### Cancelling a retired baseline

A logical Host reconnect can reuse the initialized client and physical socket.
Binding hydration and Session read/resume must release their local single-flight
slots on revocation, rather than await an old response or its deadline. Each
operation checks its own identity before publishing data, errors, previews or
notification-buffer cleanup. The scheduler's run signal reaches all initial
history RPCs and strategies; an uncooperative strategy cannot retain local
admission or later replace the new baseline. Cached transcript paint and drafts
survive this handoff, while authoritative presentation waits for the new cut.
A new baseline also retires old background/pagination context identities so an
old same-generation reader cannot append after replacement. Cancellation is
local ownership revocation, not a claim that remote execution stopped.


Derived older-page, refresh and tail-drain requests own cancellable local waits.
A new baseline, needs-resume transition, release or disposal settles those waits
without waiting for a provider that ignores cancellation. Cancellation retains
cached paint and clears the older-page loading indicator when its source is still
current. Older/refresh requests share their initiating owner; a joining signal
cancels only that caller's wait. Refresh cancellation returns false; older-page
cancellation rejects with ABORTED. A queued independent intent waits for a previous
operation to settle, including failure/cancellation, rather than inheriting its
outcome. Their projection code loads on demand after admission and checks ownership
again after module loading, so it is outside the mandatory startup graph.


For providers without a versioned snapshot receive cut, canonical rereads after
overlapping snapshot notifications (including non-delta
item/turn lifecycle and Thread status) have a local elapsed deadline from
the initial read start. Expiry settles the caller with a retryable TIMEOUT before
any held old reply arrives, then revokes children and fences their late data.
A new request checks expiry before joining, including before queued timer delivery;
synchronous abort observers may already have admitted its successor. Initial quiet
pagination keeps its per-RPC allowance, and explicit zero disables the configured
deadline. Wall-clock corrections affect diagnostic timestamps, not these budgets.


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

### Mounted content and virtual height

In natural scrolling, the Web virtualizer's measured total is a minimum height for its spacer, including
unmounted history. Mounted rows retain their natural block size: a renderer can
grow while its row measurement is queued, so stale measurements must never let
that content overflow the spacer and overlap the sticky Composer. Both the
latest-row fast path and React project the same minimum; the viewport owner
continues to own measurement transactions and reading-position compensation.
Response-placement policy retains its explicitly measured height because its
response spacer and follow transaction own the position during streaming.


### Native questions while history is unavailable

A received question/approval and its Host withdrawal remain live while history is
loading, retrying or cancelled. The Workbench binding projects current interactions
through nonauthoritative paint without replacing retained history or advancing its
cursor. Replying uses the original native request context; it does not require
reloading historical messages. A native withdrawal removes only its own prompt.
New input remains subject to current history/execution admission. See the
[native-channel contract](../platform/connection-recovery-contract.md#native-execution-channels-during-history-recovery).

## Long activity content within a Turn

Turn identity remains an execution/navigation boundary, not a limit on mounted
activity DOM. Long sequences retain all ordered source units and stable flow
placeholders. The existing Web conversation viewport owns shared visibility and
height observations; nearby ordinary activity renderers mount within that same
scrollport. Placeholder geometry never overwrites measured content heights. Turn
measurement and scroll compensation retain sole ownership of layout transactions.

Small lists, the current tail, explicitly expanded content, focus/selection and
persistent or interactive surfaces retain their existing lifetimes. Ordinary
activity details recover when scrolling back; reading choices remain in the
original Conversation View stores. Recovered content is not a new entrance
animation. Hidden/disposed viewport observations cannot evict active content.
User-message search targets remain independent of ordinary activity visibility;
browser find retains the existing virtualized transcript limitation.

Ordinary synchronous commentary inside activity sequences uses the same mount
window as tool/reasoning rows. Unchanged unit renderers preserve their committed
subtrees while the live tail updates; context and registry changes still
propagate. The original View restore receipt also carries measured content
heights, so returning to a long reading position does not discard known geometry.


### Search projection and historical backfill

Server schema v5 adds `conversation_search_documents` plus FTS5 external-content
`conversation_search` and transactional triggers. `search_revision` tracks projection
coverage independently from semantic Thread revision; bounded reindexing does not
invent Thread events. New content, removals and tombstones update search atomically.
Rebuilding the canonical baseline/suffix projection invalidates derived search; the
owner reconstructs it from verified stored payloads in bounded batches.

Built-in `thread/search` uses BM25 and checks current trusted Thread access before
page counting. `thread/searchOccurrences` locates all indexed Item text, including
tool output and commentary, with UTF-16 highlight offsets and platform-owned cursors. A hit in an
isolated saved range reads that known group without asserting adjacency or borrowing
an unrelated native continuation. Web keeps the selected Item identity through
Turn hydration, opens its activity disclosures once per selection, and positions
the matching row. Later manual disclosure choices remain effective. Query results state `indexedOnly`; they are no claim that native history is
fully imported. The existing dialog/navigation owners remain unchanged.

`opencraft/history/sync` reads source metadata and a bounded full history page through
the existing transport and original actor context. Its strict import path rejects
stale fences and write failures before reporting progress. `indexOnly` hydrates saved
payloads without contacting an engine. This supports one-off scripts outside the
repository, using the same access rules, resumable opaque cursors and no input replay.


### Committed history subscriptions and repair

The history owner publishes one change per outer committed transaction. Cached
`watch` subscribers receive the committed Thread revision independently of the
native notification's execution lane. Rollbacks and identical facts publish no
change. Publication rechecks each logical client and its current read authority;
no body or title is included in directory invalidations. Disconnect removes the
subscription. Header-only lifecycle or summary updates preserve an unfinished
Item source cursor; only verified full membership or source-page evidence can
replace it. The immutable semantic event carries that same cursor for rebuilds.

A cached watched read paints first, then performs independent read-only source
reconciliation. Failed live saves remain observable as native delivery, with no
false persistence acknowledgement. The transport coalesces repair per Thread,
reads metadata and bounded full source pages, and retries transient failures with
backoff capped at sixty seconds while the original client and authority survive.
Each pass reads at most eight pages of one Turn. At most 128 Threads and 128
explicit affected Turns per Thread are retained; ordinary authorized watched
reads also reconcile after reconnect. Concurrent failed observations invalidate
older repair replies before import. Strict synchronization acknowledgements still
require durable import and a matching revision fence. Repair never sends Resume,
input, tool calls or other execution writes. Close/disconnect/revocation cancel
or fence queued work. An unavailable or summary-only source preserves the existing
saved content and reports a bounded diagnostic, without upgrading coverage.

Repair intent is bounded in-memory state, not a durable delivery queue. A process
loss while storage cannot accept writes needs the next authorized watched read
to reconcile against its source; offline content retains only committed facts.
A no-op reindex does not advance the search version, so existing search and
occurrence cursors remain valid. Actual index changes still invalidate them.


### Stable cursors through non-destructive hydration

Full source snapshots and full lifecycle notifications compare the relative order
of previously retained Items before inserting newly discovered members. Appends,
prepends and middle backfill preserve the Thread epoch and stable-ID pagination
anchors; removing a retained member or reordering retained members still revokes
old cursors. Decoding resolves each anchor's current position instead of trusting
the position captured before hydration.

An expired ordinary group-page cursor still fails with `-32602`. If its Thread
is readable and its group anchor survives, the owner may attach structured error
data `{code: "HISTORY_CURSOR_EXPIRED", retryable: true, replacementCursor}`.
The replacement describes that group's position in the current order, rather
than validating the old view. Session explicitly retries once with this opaque
cursor and retains the loaded window until the page succeeds. Generic invalid
parameters, missing/cross-Thread anchors, Item/detail and isolated cursors receive
no replacement. Repeated expiry cannot form a retry loop; existing cancellation,
source fencing and the total derived-read budget still apply. This makes a live
Item correction compatible with continued group paging without clearing the
timeline or silently declaring the old token valid.

Partial Item-page refreshes place their ascending prefix or descending suffix at
the corresponding edge. Their persisted source-continuation observation also
retains the last scanned Item identity, so the next page inserts at that frontier
rather than behind unrelated live observations. New records first append to the
projection; explicit semantic ordering then positions them, keeping rebuilds and
live reads identical. Existing continuation observations without that optional
identity retain overlap/edge compatibility; they do not gain a stable-source
coverage guarantee. No new tables or execution authority are introduced.

An explicit retained Item detail is readable independently of an unread group
tail, including offline and after reopening the Server. Missing Items still report
unavailable; a partial group cannot be returned as a fully synchronized group.
Directory source-cursor/coverage rotation updates synchronization progress without
advancing the searchable catalog version. Actual indexed facts, metadata and
membership changes retain version fencing for search pagination.


### Explicit Goal activation after passive history

A readable transcript does not prove that the execution engine has loaded its
session. Before an explicit Goal change whose effective status is active, the
Workbench uses the existing execution activation owner and awaits metadata-only
Resume. A new or unmounted Thread seeds only its metadata first; already loaded
history, older-page cursors and presentation geometry retain their existing owner.
Editing a paused Goal keeps that status without activation. Goal reads, pause,
terminal updates and clear do not activate an idle session.

Preparation failure prevents the Goal write. The original Client, Session,
connection revision, capability and Thread availability are rechecked after each
preparation await and immediately before transport admission. Disposal or a
replaced connection cannot dispatch a late write, including synchronous request
lifecycle reentry. Unknown dispatched writes remain unknown and are not replayed.
Goal state and execution delegation remain owned by the existing native services;
this does not add a Goal table or authority to the conversation history store.

A physical reconnect on the same Workbench Client also replaces the Goal
projection. Once the new connection is usable, a Client/generation check resets
the replaceable cache and rehydrates subscribed metadata; catalog demand uses
its existing bounded reader. A logical recovery on an unchanged physical
connection retains the projection and its in-flight explicit operation. Recovery
only reads Goals; it never replays a Goal mutation or starts execution.

### Older-page progress and observed ends

Source EOF ends paging for the observed connected segment even when a multi-page
read lacks the stable generation needed to claim complete historical coverage.
A last page can therefore keep `historyCoverage.state=partial` with
`nextCursor=null`. Unknown coverage still exposes its unresolved range; isolated
search records and anchors outside the current segment do not bridge a gap.

If a newer head read replaces that segment, an older platform cursor still names
its original object anchor. The gateway rebuilds the requested range through
read-only native pages before replying; a recent native page is never substituted
for the requested older range. Recovery serializes per logical client and Thread,
reads at most eight source pages per attempt within an elapsed budget, and retains
connection-local progress for the next attempt. A coverage change invalidates
that checkpoint; body-only updates do not. Native loss, reinitialization, client
disconnect and unsubscribe retire checkpoints. An expired source cursor restarts
once, with unchanged platform position and access checks before each read and
import. Native header-only pages retain per-Turn Item hydration.

No additional table or execution activation is introduced. Deletion/reordering
still invalidates incompatible cursors, live-commit import fences remain in force,
and a failure settles the existing loading state so a later attempt can continue.


## Terminal recovery and local failure retirement

A legacy message window may replace a covered cached running Turn with its
canonical terminal snapshot. Only observations made after the captured baseline,
independently admitted live Turns, and active Turns outside the supplied window
retain their local projection. Cached running status alone is not newer than a
terminal snapshot for that same Turn. Native read-history recovery retains its
existing canonical cut rules.

When opening mid-Turn, completion duration can use the already-read startedAt
(seconds) or startedAtMs clock as well as the Session turnStartedAtMs observation.
A nullable start in the completion event does not discard that known start for
duration calculation. Unknown endpoints remain unknown.

A completed authority restoration or authoritative proof that no older page
remains retires the Conversation's old local paging error. Ordinary streaming
updates do not clear an outstanding paging failure. Goal write results remain
connection-fenced, while releasing their process-local mutation lock clears busy
on the current projection even when the result belongs to an older connection.

导航目录准入读取Replica的只读历史权威，不要求执行Resume/owner角色。权威撤销时不发枚举；当前历史权威恢复后唤醒已有目录需求，普通保留不主动枚举。Legacy适配器未提供独立权威端口时仍沿原resumed检查。


### Initialization and collaboration control replies

`initialize` and metadata/receipt actions of `opencraft/collaboration` use a separate receive path
from history imports. Initialization updates only the existing in-memory discovery
record; collaboration receipts do not write conversation history. Neither waits
behind unrelated history writes or queued content replies. This preserves the
original RPC deadlines without extending them. The path rechecks the logical
client, native publication guard, request ownership and current resource authority
before returning a result. The collaboration `read` action remains on the content path.
History reads, notifications and content imports keep
their original serialization and write barriers.


### Long directory scaling boundary

The current metadata digest map costs O(N) per newly started scan; reusing it
across pages removes repeated full captures, not that initial cost. It is a
conflict fence, not a content-completeness hash. The existing remote
`ThreadDirectory` owns its projection and periodic reconciliation; the local
native history path does not thereby inherit that service or its schedule.
Local cached-head revalidation now checks the age of its historical EOF
observation. Once due (the same one-hour policy as the remote directory), or
when resuming an interrupted reconciliation, one query-scoped coordinator starts
a new observation epoch and scans the source independently of foreground pages.
It releases the query queue after each eight-page batch, retains the native
checkpoint between batches, and bounds one job by the shared source-page budget.
Saved rows remain readable. Physical source retirement and cursor invalidation
retire the old observation/cursor while retaining unfinished reconciliation
intent, including legacy EOFs without a success timestamp. Failures preserve saved facts and reconciliation
intent; an uncertain consumed native cursor is discarded rather than replayed.
Only a successful current-epoch scan from head updates `observedAt` and clears
that intent. A legacy EOF without a success time is due on revalidation. This is
revalidation-driven anti-entropy, not a new idle connection or periodic daemon.
Missing native rows do not authorize deletion of retained history. Moving local
sources onto a shared synchronizer requires one explicit projection owner and compatibility with existing history/authorization, rather than layering
a second writable directory cache into this transport.

A future source contract should expose an actual source epoch, a committed
metadata revision and bounded delta continuation with deletion tombstones. A
revision gap or new epoch must trigger a staged reconciliation, retaining the old
readable projection until success. Sources without a lossless change feed need
owner-scheduled full reconciliation for out-of-band historical changes; a stable
head or the history observation epoch cannot prove those changes absent. The history fix adds bounded revalidation-driven reconciliation; a lossless
subscription and native snapshot generation remain separate source capabilities.
Persisted per-row directory versions can make conflict checking proportional to
the imported page, but require writer/migration compatibility, including older
SQLite writers. Chunk or Merkle digests may then accelerate reconciliation.
The [rsync algorithm](https://rsync.samba.org/tech_report/node2.html) provides a
useful recovery mechanism: the receiver describes old blocks with weak rolling
checksums and strong digests; the producer scans its new canonical stream for
matches at shifted offsets, then transmits references to unchanged blocks plus
changed content. This survives insertions/deletions that would invalidate all
later fixed page-number hashes. For directory synchronization, canonical record
order should be stable Thread ID order, separate from the recency display index;
records need unambiguous framing and metadata-only deterministic serialization.

### Resumable directory subscription and block reconciliation

Existing V1 `thread-catalog/changed` upsert/patch/remove notifications are live
facts, not a durable resumable feed. The remote adapter's V1 directory-updates
capability does not make the local native route resumable. A future source-owned
contract should provide:

- A source epoch, an authorized-view epoch, and an opaque checkpoint bound to the
  scope/query/view. Authorization change retires the view; reconnect does not by
  itself replace a valid data epoch.
- A snapshot boundary and a committed delta range through an acknowledged
  checkpoint, including view removals/tombstones. Rows absent from an authorized
  view must not be interpreted as authority to delete retained conversation data.
- Replay after the last acknowledged checkpoint. The owner states which range
  was covered, including ranges with no visible changes. Gaps between raw global
  V1 revisions may reflect filtering, so the client cannot infer loss by numeric
  revision subtraction alone.
- When retained deltas no longer cover that checkpoint, a versioned block-signature
  exchange on the same authorized view. Rolling checksums locate candidate
  reusable regions; strong digests confirm them. Copy/literal deltas and the final
  manifest commit against one source/view boundary before advancing the checkpoint.
  A changed boundary requires catch-up or restart, not merging unrelated snapshots.

The producer must implement this at its directory/storage owner. Fetching every
native row into the gateway and only then hashing it cannot eliminate native
reads; source-side rolling comparison itself still scans source bytes. Persisted
row versions/chunk summaries and a durable feed reduce repeated source work and
transmission. There is no new digest RPC, durable subscription, acknowledgement
log or Core upgrade in the current history fix. Hash equality never substitutes
for source coverage, epoch, view identity or authorization.

### Recorded-name CLI projection

Employee CLI `threadSearch` / `recorded-name-v1` does not consume the full-text
history index or UI content search. It reads only the existing ThreadDirectory's
recorded string names, with NFC case-sensitive literal matching, current
metadata discovery authorization, bounded rowid windows and revision-bound
opaque cursors. Preview, prompt, tool output and full-history counts are outside
this projection. Source coverage remains recorded-only even when traversal ends.

Local Codex now installs the same metadata directory owner on its existing Host17
connection and retires it with the physical source. Background metadata sync is
incremental/cooperatively paged and can update this derived projection; a search
request itself neither refreshes it nor hydrates Native/display history. Original
remote directory behavior remains supported. See [CLI contract](../../cli.md#recorded-name-search)
for read budgets, field bounds, unavailable and cursor semantics.

### Public CLI text search is a separate History projection

`publicTextSearch` / `public-text-token-and-v1` reuses this History worker and
connection but bypasses UI BM25 search and its all-candidate authorization.
A narrow read first enumerates a 128-wide document-PK window without index text;
Hub applies current admitted-human conversation.read/resource/orchestration
checks, then asks the same owner to project only allowed positions from verified
payloads. No transaction is held across ACL. Returned Items and source fences
are checked again before publication. Model preparation, Native reads, sync and
reindex are never entered by this operation.

The existing readonly worker processes window/project/validate operations with a
shared cancellation flag and original total deadline, checks between bounded
operations and yields every sixteen candidates. Disconnect, physical source
retirement and close cancel those reads. Per-payload/page/identity/coverage bounds
limit parsing and memory; SQLite IO remains cooperatively checked, not a hard
interrupt. The original immutable payload hash/envelope helper remains the sole
integrity owner. Current events, group coverage and visible history segments
must agree; retained FTS rows cannot revive an invisible or incomplete segment.

This public projection includes only user text content and agentMessage.text,
including phases ordinary CLI log can read. Existing UI FTS still intentionally
contains broader tool/structured/generated-prompt text. Public snippets never
use that broader text. Coverage is indexed-recorded-only, count unknown; see
[CLI text contract](../../cli.md#imported-public-message-text-search).


Recorded-name typed初始化仅消费原History已记录的初始化快照；尚无快照的冷态查询返回thread_search_unavailable，不为协商能力触发Native initialize。正文typed查询沿自身metadata-only能力协商。两者不以预暖掩盖查询副作用，普通非搜索初始化路径不变。

名称查询即使保留旧初始化快照，物理源退役后也不可由查询重建或connect；typed转发仅消费当前open源。logical初始化只可消费adapter已完成的physical初始化缓存，不能发起physical initialize；该专用协商不再发送额外initialized握手。普通初始化/恢复owner保持原语义。

### Composer connection recovery presentation

Host connection recovery paints the shared Composer recovery scan independently
of a committed Thread lease and retained history authority. Both the new-thread
draft and retained conversation consume the same pending recovery projection;
typed content keeps its document and remains visible during recovery. The
Composer does not append a separate connection explanation below its shell.
This presentation does not schedule reconnects or change input admission.
