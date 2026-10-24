# ChatUI: History and recovery

[Architecture index](../../chat-ui-architecture.md) · [Documentation index](../../README.md)

## Shared history backfill coordinator

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

Cold and retained-history recovery errors expose a collapsed native details
panel. Runtime composition projects the existing transport/activation/history
owners into an allowlisted presentation snapshot; it does not schedule retries.
Connection failures carry the same local attempt ID as the server diagnostic
report, a fixed occurrence time, socket phase/cause and optional close code.
History/activation errors expose only a bounded machine code (or UNCLASSIFIED)
and local observation time, never an error message, stack or payload. Runtime
and transport states report current observations; recoveryPolicy describes the
transport's existing automatic/manual classification, not proof a retry ran.
Navigation fences expanded/copy state; successful authoritative recovery removes
the panel. Copy uses the shared clipboard helper with legacy fallback and an
announced failure. Narrow and themed layouts wrap technical fields while retaining
history, scroll and drafts. Protocol mismatch still requires an update rather
than a retry loop. The clipboard-only package export avoids importing renderers
and their styles for this utility.

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
central spinner; activation failures retain their retry action. The empty Composer placeholder shows “Reconnecting…” while its Host connects or
retries, and “Loading…” while the connected conversation is being restored. The
existing recovery owner decides whether work is pending; stopped recovery and
required updates keep their existing actions. The editor owns emptiness, so a
draft (including transient IME text) hides this placeholder. Changing the
placeholder preserves the same editor, focus, selection and draft; readiness
restores the normal prompt. The border scan also retains its screen-reader label. No syncing/reconnecting notice is inserted into the transcript.
Only a stopped/blocked recovery or required client update presents
an actionable instruction in normal flow above the Composer, never over the
transcript. Its diagnostic report stays collapsed. Elapsed time, attempts, retry
deadlines and machine failure codes remain in the existing diagnostic snapshot;
they do not add visible progress chrome or schedule work. Both cold and retained-history
terminal failures render only the collapsed technical report and retry/update action;
no progress presentation clock is mounted after recovery stops. Opening or copying
the report consumes the existing allowlisted snapshot and never starts recovery.
Authoritative recovery removes any manual action row; invalidation fences late observations.
No remote error text, content, endpoint or credentials enter this report.
A fresh work item after a terminal failure starts a new history observation;
its correlation ID and attempt count cannot inherit the completed report.
Coalesced retries of an active work item still share the original observation.

### Recovery correlation and socket liveness

Recovery observations carry the local physical `attemptId` and `eventAtMs`; the server receipt time is not the client event time. `history-started`, `history-backoff`, and allowlisted slow/failed history RPC metadata are accepted by the diagnostic endpoint. A rejected metadata record is discarded instead of blocking later reports. No request params, conversation text, credentials, URLs or Thread IDs are added.

The renderer logs the full allowlisted clipboard diagnostic to `console.log` on recovery state transitions, without an elapsed-time logging timer. Copying details logs the exact copied snapshot. Loading UI stays concise and retains existing messages and drafts.

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
