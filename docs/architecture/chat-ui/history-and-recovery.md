# ChatUI: History and recovery

[Architecture index](chat-ui-architecture.md) · [Documentation index](../../README.md)

## Shared history backfill coordinator

The enhanced tool-side chat reads the same conversation timeline and existing
Thread lease as the main view. It renders the complete loaded window through
`Conversation` with natural scrolling and Turn virtualization; scrolling to the
old edge loads more history through the existing callback. User inputs remain
visible. A new Turn does not replace the reading surface or reset its anchor.
The main and overlay views retain independent reading checkpoints in their
existing view scope. Only the active reading surface binds history input and
viewport-fill requests; parking a view invalidates its fill generation without
discarding the shared history or cancelling another reader's Thread lease.
The overlay restores its checkpoint after disclosure/tool changes and keeps the
existing stable Composer host, draft and resource lifetimes. Its viewport uses
the existing keyboard/container budget. Cached display history remains paint-only;
execution and detail actions still use the existing authority gates.

A mounted `Conversation` consumes its restore checkpoint once, for the lifetime
of its keyed View. Later parent checkpoint updates cannot reposition that reader
or reseed a newly mounted scrolling-policy child with a different baseline.
Explicit navigation uses the scroll API; a new View consumes the latest saved
checkpoint. Scroll distance, disclosures and virtualizer restoration share this
same initial snapshot boundary.

### Display cache ownership and asynchronous receipts

Display continuity remains a paint-only projection; it never becomes the live
conversation authority. Its three lifetimes are independent:

| State | Owner and invalidation |
| --- | --- |
| Resident display | Bounded in-memory cache, including explicitly empty transcripts. Every authoritative observation can refill or refresh it, even when its serialized content has not changed. Equal resident content retains its timeline identity. |
| Storage read receipt | One in-flight read per conversation key. Every authoritative observation revokes its write-back permission, including empty or identical content. Completion releases the receipt. |
| Persistence projection | Write coalescing and deduplication only. A failed write permits retry; it cannot restore permission to an invalidated read or remove the current display. |

Late read success and failure return the current resident display after authority
has changed. Account namespaces keep their separate continuity owners. Memory
eviction is not a persistence failure, and persistence failure is not evidence
that older content is current. Navigation restore I/O likewise checks its intent
on both success and failure: abandoned operations return `false`, while current
restore and subsequent cold-activation failures still propagate to the caller.

A resident empty transcript suppresses storage reads even when removal failed;
it is distinct from a cache miss. It shares the cache's capacity and expiry,
and an identical later observation still retries a failed persistence operation.

The React adapter retains no second copy of a storage-read payload. A completed
read requests a render; that render selects from the current shared cache.
Otherwise an old hook-local payload could bypass an empty transcript or cache
expiry when authoritative history becomes temporarily unavailable. Read-completion
notifications remain fenced by account scope and conversation identity.

`TurnHistoryBackfillCoordinator` owns demand and serialized page reads for one
history/layout epoch. Viewport geometry (or visible retained-history gaps) decides
whether another page is needed; canonical pagination owns availability, loading
and cursor progress. A viewport's scrollHeight can stay fixed while short pages
add content below its minimum height, so geometry never proves page progress.

The React adapter rechecks demand when pagination becomes available or settles,
including when rows and viewport sizes are unchanged. Layout notifications during
an active read are coalesced into a pending recheck; they never overlap reads.
Every completed page reaches the existing platform layout barrier before the
next demand/progress check. Exhaustion, unchanged cursors, errors, hidden geometry
and retired owners stop automatic work. A stopped cursor is not retried by
incidental layout/loading updates: a new cursor, new owner, or explicit user
retry admits it again. Replacing the epoch waits for the prior read to settle and
fences late errors. Main chat and Side Chat consume the same pagination model;
platform adapters retain measurement and reading-position ownership.

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

Display-cache trimming treats messages and omitted-region descriptors as one
document. Regions with non-null anchors survive only with that assistant block
in the same Turn; they never fall back to the end of another response. Memory
paint and persisted reload share the same normalization and per-Turn identity
deduplication. The existing envelope character budget bounds descriptors; the
message-count budget must not discard an entire region array. An explicit region
list, even empty after trimming, suppresses legacy aggregate-clock inference so
omitted work cannot reappear as a synthetic header on the first retained reply.
Absent descriptors still allow compatible old duration-only cache entries.

Disclosure preference belongs to the Conversation View, not to cache provenance
or action authority. A retained activity region declares body availability
separately: missing tool bodies must not force a saved expanded choice closed or
disable its reading toggle. An expanded unavailable body uses the existing
content-window owner's measured height (or its estimate when never measured),
with separate expanded/collapsed geometry keys. Placeholders never overwrite
measured heights. View restoration carries those heights alongside disclosures;
display-cache descriptors carry neither pixel sizes nor interaction preferences.
Canonical body arrival fills that same flow boundary without a new entry event.
This preserves known geometry, not an exact prediction of previously unseen or
subsequently changed content. Fork and other execution actions still require
their independent authoritative callbacks.

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

### Local Codex source continuity

The connected Codex history Worker resolves the current rollout from the native
read-only state index on every read. A physical rollout node is distinct from
its logical Thread ID: a continuation can retain the Thread ID while changing
its filename. `session_meta.history_base` supplies ancestor node IDs and exact
byte/ordinal cutoffs. The reader follows those references in order, includes
only the valid ancestor prefix, and retains parser state across segment bounds.
It never concatenates every same-named file or selects a head by modification
time. Without an index, only an unambiguous source-lineage tip is accepted.

The parsed-history cache fingerprints the complete resolved ranges and current
head, so a rotated rollout invalidates an otherwise unchanged old file. Missing
ancestors, identity/cycle failures, partial cutoffs and ordinal mismatches fail
without substituting stale history. An unfinished final head record remains
uncommitted until its newline arrives. SQLite/filesystem work stays in the
existing history Worker; reading does not start a native Turn or rewrite logs.

### Bounded history recovery

A paginated provider may explicitly advertise `initialTurnsPage: true` and
`boundedRecovery: true` in its version-1 `opencraft/resume-history` capability.
Resume then returns the full initial page, avoiding a second Turn list and one
Items read per Turn. Older history is user-driven by default; the explicit legacy
background-drain option remains available to non-interactive callers. Navigation
seeds its loaded window and starts enumeration at the older boundary, not at the
tail already read by Resume.

Legacy Resume providers can return Turn headers followed by separate Item pages.
The initial Item budget is shared, but each Turn retains its own unread, partial,
or complete state. Received Item entries count before deduplication. The existing
older-history action can continue those Item pages after the Turn list reaches
its end. It preserves each Turn's cursor and commits a page only while the
admitting history source is current. Full Turn
pages can be displayed without loading the deferred Item reader.

When a passive preview cursor expires, the older-page owner starts at the current
history head and looks for the oldest loaded Turn by ID. It publishes only Turns
beyond that boundary in canonical order. Bounded requests retain the verified
search position for further demand, including a temporary workspace sleep.
The existing history source owns the search state and discards it when replaced.
A history that lacks the loaded boundary leaves the transcript visible and reports
that paging could not continue.

The older-page owner rejects cursors already consumed in the same history traversal
before committing the page. A validated checkpoint rebase starts a fresh traversal.
An embedded first page and a separately requested page use the same validation.
Both preserve the first occurrence of each Turn ID in provider order. An overlapping
passive page keeps the oldest boundary of the contiguous loaded range for recovery.
If the optional background drain settles coverage while a manual page is in flight,
the manual result or failure leaves the completed range in place.
Overlapping drain pages retain the first observation of each Turn in descending
page order before publishing the chronological transcript.

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

Recovery navigation caches bind to the effective history mode and provider
epoch **and nextSeq**. Unchanged reconnects retain the index. A mode or history
change retires the previous index and aborts its in-flight reads.
Enumeration checks that version before publication; a superseded read cannot
mark newer history complete. A continuation that revisits a cursor stops discovery
with an error before the index is published. Incidental View updates keep the
failed attempt settled at its generation. Explicit demand can retry, and a new
history generation can rediscover. Discovery begins when rail/search calls
prepare, not merely because a conversation is retained in the cache.
Loading notifications can share the scan that is already registered. When a
checkpoint supplies an older boundary, only the contiguous loaded range at
and after that boundary seeds the index. Older Turns located independently by
search take their position from the provider's pages.
When the View covers the complete Turn range, navigation can settle from its
ordered Turns and retire the old scan. Retirement settles its caller even if
the transport delivers a late reply. Locally indexed Turns carry an ID and
display order. Missing Items for those Turns are read by ID because local
ordering can contain live observations absent from native history pages.
Workbench admits navigation from the current passive `thread/read` or resumed
history View. The passive owner can search and position a tool-only Turn using
read requests. Retiring the connection removes the navigation View. Search
positioning owns its deadline and cancellation from the start of preparation,
and the body and occurrence queries carry the consumer's abort signal.
An occurrence can supply an opaque inclusive Turn cursor. After admitting a
readable View, navigation can use that cursor to fetch the matching Turn and
verify the Item before projecting it. An absent, stale or mismatched locator
can fall back to bounded discovery. The exact read does not advance ordinary
history coverage. While a Turn's position lies beyond that coverage and the
provider index, it remains outside the rail and ahead of the contiguous tail.
The View holds one such search selection. A later successful selection replaces
the earlier one unless provider order now places it in history. A newer exact
request cancels an older pending selection. The projected timeline carries the
unplaced Turn identity and the Turns outside the contiguous window. Display
continuity uses the ordinary history window to extend a proven cached prefix.
Opening an indexed Turn ahead of the boundary leaves the stored preview intact.
When an initial page is empty, the View records which Turns navigation added.
The first ordinary page keeps those independently read Turns outside its
coverage until a page admits their IDs. Navigation observations do not
establish an active or continuable task. A live Turn-start event can admit the
same ID and place it at the live tail if it had no established position.
An ordinary page that reaches an independently read Turn makes its hydrated
content eligible for preview retention. A Resume that installs a new page takes its oldest
boundary and continuation from that page together, even when the View retains
independently opened Turns ahead of it. Older pages can extend that boundary or
leave it in place. An overlap can advance the continuation without moving the
oldest covered Turn forward.

A complete ordinary traversal or a complete Resume baseline retires unchanged
navigation-only Turns absent from the ordinary history it admitted. Live Turns,
independent reads committed during the request, and explicitly unresolved
execution admissions in a Resume keep their respective ownership. The navigation
rail adopts the covered View and discards stale metadata locators. An earlier
exact response arriving after completion cannot restore an absent Turn.

A continuous snapshot refresh can preserve the loaded prefix and its cursor
when the refreshed page starts at a shared ordinary history anchor within the
same checkpoint epoch. A Turn opened independently by navigation cannot prove
that overlap. A refreshed page that admits only such an anchor establishes its
own boundary and continuation. Replacing the source retires its pending
derived reads before publishing the new cursor, while the snapshot follower
continues to own the baseline. Navigation discovery and exact reads use the
View's baseline revision as well as the provider checkpoint, so a local
snapshot replacement can invalidate navigation even on the same connection.
Message-window refresh publishes navigation completeness together with the
new pagination boundary.
Overlapping pages retain the first locator for each Turn in descending provider
order. The locator keeps the original request cursor and the row's offset
within that response. Target hydration replays the same direction, counts the
rows actually returned while seeking the offset, and checks the target Turn ID
before publishing the single full Turn.
Partial Item coverage preserves the marker ID while deferring its first-prompt
preview. A jump to an Item already present can use the current View. A jump to
a missing Item shares the preview's full-Turn read. A committed full Turn
settles its Item continuation in the same View revision, so an Item page
admitted by older coverage cannot replace those Items or publish its error.
When a full Turn exceeds the response budget, navigation reads its header at
the same position and verifies its ID before using adaptive Item pages. Preview
and jump share this read. A superseded navigation generation aborts its
transport requests. A single Item that exceeds the budget retains its typed
read error.


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

History directory reads retain only the authenticated routing owner's epoch after
initial identification. Each source read and completion check still fetches a
fresh directory, including route and HOME incarnation. An epoch mismatch rejects
the result and retires the pinned identity; the next attempt identifies the new
owner. Completed health results and directory snapshots are never reused. This
removes recursive health probes from every warm history validation without
weakening the source's end-of-read ownership check.

The browser's physical AppHost owner treats `freeze` and `pagehide` as suspended
demand even when `visibilityState` remains visible. Both events cancel the
foreground reachability probe. `resume` and `pageshow` wake the existing recovery
owner and start a fresh probe deadline; expired pre-suspension timers and late
responses cannot close or acknowledge that successor probe. Lifecycle state and
subscriptions belong to the connection factory and are released with it. A real
remote close or missing response on the new probe remains recoverable through
the existing Host policy.

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
Opening or reconnecting a conversation only reads that Thread. If its metadata
omits archive state, Workbench relies on that Thread's lifecycle receipts,
notifications or a typed read refusal. Archive directory pagination belongs to
the explicit archive browser.
The Browser Application clears only matching Host/account selection memory and
replaces an active invalid route with the existing Home and conversation list.
Late failures cannot clear a newer selection or replace a newer navigation intent.
This local draft does not create a remote Thread, unarchive it or replay input.

### Retained Web viewport measurements

A borrowed overview is not a new reading layout. The retained-view owner captures
its inherited CSS context before an atomic DOM move can invalidate Shell
`:has()` styles. Primary-chat footer reservation consumes that context from the
retained reading view, not from a physical `.main-content-surface` ancestor.
Safe-area/keyboard clearance, footer height and the reader's local position must
remain unchanged throughout the flight and handback; hiding controls does not
remove their layout. No second scroll writer, remount or delayed animation repairs
this invariant. `smoke-overview-chat-reading.ts` samples actual Shell/Conversation/
Composer frames for atomic and native-popover placement; WebKit is an explicit
optional run when its system dependencies are available.

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


Canonical rereads after overlapping snapshot notifications (including non-delta
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

In natural scrolling, only unmounted history owns synthetic spacer padding.
Mounted rows retain their natural block size; the measured total is not a
permanent minimum that can retain obsolete height after media/disclosure shrink.
When a render-window update retires row identities, ConversationTurnWindow takes
a pre-mutation React snapshot. The Web viewport owner temporarily protects the
old spacer extent, resolves replacement styles/layout with that protection, and
releases it synchronously in the layout commit, before paint. WebKit may perform
an intermediate layout while styling a rebuilt inline-size query container;
the handoff must not let that temporary tree clamp the native scroll offset.
Same-window content updates do not acquire this lease. Cancellation, viewport
retirement and failed layout release it without a stale geometry read; no timer,
retained floor or competing scroll writer is introduced. Genuine unreported
touch/momentum remains part of the physical reading position.
The viewport owner continues to own measurement transactions and reading-position
compensation; the query-container width contract is retained. The full-component
`smoke-history-window-handoff.ts` covers the geometry-matched history prepend,
diagnostics on/off, touch/pointer, unreported movement, later shrink and clearing.
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

### Composer connection recovery presentation

Host connection recovery paints the shared Composer recovery scan independently
of a committed Thread lease and retained history authority. Both the new-thread
draft and retained conversation consume the same pending recovery projection;
typed content keeps its document and remains visible during recovery. The
Composer does not append a separate connection explanation below its shell.
This presentation does not schedule reconnects or change input admission.

### Message timeline measurement and native scrolling

Direct and group message timelines use the shared Web viewport owner's mount
measurement queue before painting newly visible rows. ResizeObserver batches
commit through the same measurement transaction before paint, without an extra
animation-frame delay. The pending position belongs to the geometry commit;
measured heights and their scroll correction are not published in separate frames.
An unchanged physical distance is observed without issuing a scroll command, so
catalog refreshes and newly mounted history cannot interrupt native touch momentum.

### Continuous output during unsequenced history recovery

A read and live deltas from legacy providers have no common ordering token. One
immediate reread still obtains a quiet cut for short overlaps. If that read also
overlaps, publish its canonical snapshot and let the Session's single retained
Thread reader follow snapshots (at most one read per second, with bounded RPCs
and failure backoff). Do not append ambiguous buffered deltas. History changes
are coalesced to an invalidation bit; non-history observations keep their ordering.
A quiet snapshot restores normal live projection. Release, a fresh baseline,
connection retirement and disposal cancel the follower and fence late replies.
This is a compatibility fallback, not a claim of provider sequence support.

Channel directory authority is independent from optional Inbox summaries. A valid
directory is immediately usable while a lifetime-owned Inbox read updates unread
counts and latest-message projections. Transient Inbox failures retry with bounded
backoff; explicit identity/access revocation still invalidates directory consumers.

Within one snapshot-following source, an overlapping partial tail refresh preserves
the loaded prefix and backward-page cursor. It must not revoke an in-flight older
page merely because another tail read completed. A disjoint window, complete
snapshot, changed checkpoint epoch or explicit new baseline still replaces old
coverage; never concatenate histories without a shared boundary.

Channel membership checks distinguish explicit access denial from transient
storage/worker failure. Both may invalidate the consumer's read, but only explicit
denial removes the subscription. A temporary failure retains it so recovery and
subsequent changes do not require a browser reload.

### Cached presentation regions and action authority

A paint-only history preserves structural region identity independently of its
source and command authority. The shared Timeline presenter consumes
`presentationRegions` when omitted activity bodies need their collapsed header
retained. Region descriptors store semantic identity, insertion position, count
and completed clock data, never executable bodies or platform pixel sizes.
Future omitted region kinds extend this shared contract and its cold-handoff
geometry assertions. Cache size limits include these descriptors.

Host-supported action shape is declared separately from callbacks through
`ConversationDocumentContext.turnActions`. Read-only/cache rows keep the same
action slots with disabled controls; confirmation supplies callbacks without
inserting controls. Absence of a callback never grants execution authority.
The cold-history smoke compares activity, content and action geometry across
cache → mixed → history at touch/desktop widths and reduced-motion settings.

For settled providers that omit every message phase, chat-core derives missing
phases within each input segment; phase-aware histories retain deliberate
unqualified boundaries. The Anthropic bridge assigns phases only after its
message stop receipt, before releasing executable tool receipts. Live, async
and explicit provider semantics remain owned by their source.

### Cached Turn resources and layout-qualified measurements

Display continuity retains Turn resources once, after selecting retained messages:
Hook indicator counters and a settled diff's identity, file paths/statistics and
per-file preview line counts. It never retains Hook output/details, unified-diff
bytes, handlers or live running resource state. Both observed and persisted
metadata pass the same allowlist. These resources hydrate through the existing
HookStatsButton/TurnDiffBlock, not a second set of fixed-height skeleton cards.
Their contentAvailable=false means details are missing, not that the resource
or the reader's file-list disclosure vanished. The host's turnActions.reviewDiff
declares a stable action slot; body availability plus the authorized callback
control execution separately. Cached review/file actions stay disabled while
file-list expansion remains a reading operation.

Content-window measurements are qualified by actual boundary width, computed
typography, shared prose/code typography inputs and the document's font-load
generation. The View restore snapshot carries those qualified measurements
separately from its legacy numeric heights. Legacy numbers cannot establish
layout compatibility. Missing bodies reuse only compatible measurements;
otherwise they use the existing estimate, never invent a new exact height.
Resize observations include placeholder widths but never record placeholder
heights. Relevant ancestor class/style changes and font loading invalidate
affected measurements and notify their mounted boundaries. Replaced observers
are fenced so queued old-layout records cannot repopulate the cache. Pure
opacity/transform animation style changes do not trigger typography rescans.
No invalidation changes disclosure preference or acquires scroll ownership.

A resource-only Turn does not need a retained assistant message: the bounded
display document carries a read-only assistant resource surface alongside its
retained input. This surface never invents an assistant answer. Hook tooltip
details and the diff review dialog are demand-loaded; their indicator/header/file
list and declared action slots remain synchronous, preserving startup budgets
without deferring transcript layout.

### Refresh display handoff

A retained display envelope restores its bounded title/project together with its
message bodies. The Web header uses this account/Host/Thread-scoped presentation
until the catalog is ready; it does not acquire rename or appearance controls
from cached metadata. An unknown title stays unknown, rather than briefly
claiming that an existing conversation is an “Untitled task”. The React adapter
only associates header metadata with a timeline matching the committed View key.

Up to 64 nearby command/tool/patch summaries accompany the existing 24-message,
64-Ki-character envelope. They retain group identity, labels and shared row
geometry, not raw tool arguments/results, process/call IDs, approval records,
item-detail IDs or App resource URIs. A dedicated inert renderer takes precedence
over executable/detail renderers. Tool previews are shed before message bodies
when the size budget is reached. Omitted message boundaries cannot move their
preceding tools to another answer; canonical deletion/empty history always wins.
Old envelopes remain readable and acquire summaries/header after an authoritative
observation; this is not an unbounded history or output cache.

Recovery changes authority, not reading contrast. The transcript no longer dims
as a whole during warm recovery; Composer/status and the existing action gates
own pending feedback. Incomplete previews cannot delete visible retained tool
rows. Canonical data replaces the inert rows through the same Turn/activity keys,
without an extra fade or delayed reveal. View-owned disclosure/scroll state stays
with the mounted Conversation.
