# Connection recovery transition contract

Status: implemented for foreground wake conservation, stage/absolute expiry,
revocable Web/client/Deferred waits, elapsed-time deadlines and initialization commit fencing. The tables
also express environmental constraints abstracted by the independent model;
they are not an implementation refinement proof or a phone latency guarantee.

## Notification dispatch admission and subscription identity

Each validated notification dispatch captures a finite set of subscription
registrations before calling transport-wide interceptors or consumers. A
consumer may synchronously subscribe, unsubscribe, replace another consumer or
close the connection. New registrations can receive the next native input;
they cannot inherit or repeatedly visit the dispatch already in progress.
Removing and re-adding the same function creates a new registration identity.
A retired unsubscribe handle can only revoke its original identity.

Native same-function subscriptions retain their existing deduplication behavior:
duplicate handles share one registration and retiring either removes that
registration. Scoped subscriptions remain independent. All consumers retain
exception isolation and subscription-local deferred delivery remains at most
once. A global interceptor retains this original admission cut rather than
looking up newly registered consumers when its continuation eventually runs.

Connection loss revokes pending delivery immediately, including the interval
before any successor initialization increments `connectionGeneration`.
Dispatch and scoped continuations check physical transport revision, open
status, initialization generation and Client lifetime. A deferred callback
cannot publish an old native observation through a new subscription or a lost
connection. This does not replay dropped retired observations or grant remote
execution authority.

`NotificationFanout` independently models one input, two consumers, two
registration incarnations each, one physical loss and optional reinitialization.
The positive model checks admission, retirement, token ownership, conservation,
at-most-once delivery and conditional finite completion. Eight exact negative
controls cover live/late admission, retired registrations, physical loss, stale
unsubscribe, duplicate delivery, dropping and absent fairness. Callback
termination and eventual invocation of admitted continuations are environmental
assumptions; recursively generating unbounded new native inputs, preprocessing
observer reentry, arbitrary callback programs and other observer buses are not
proved. The actual Client `fanout` chaos suite and raw/Cordis regressions supply
separate implementation evidence, not a TypeScript refinement proof.

## Diagnostic and request-lifecycle observer admission

Client diagnostics and request-lifecycle events are non-authoritative
observations. Their package-local `ClientObserverList` captures a finite set of
registration instances for each emission, keeps same-function deduplication,
and checks that each instance still owns its registration before invocation.
Synchronous re-subscription starts with a later emission, including a nested
emission, and a retired unsubscribe handle cannot remove a successor. Synchronous
observer exceptions remain isolated from peers and RPC admission or settlement.
Listener invocation retains the original bare-function calling convention;
registration records must never become the listener's `this` receiver. Separate
raw/Cordis tests cover that concrete JavaScript boundary, which is absent from
the abstract admission model.

These observers do not use the native notification connection fence. Transport
loss must still publish a pending request's failure before a successor
initializes. Client close publishes pending-request termination before clearing
observers; clearing retires the original in-progress admission cut. A queued or
started observer can synchronously abort or close the Client without crossing
the existing final native `beforeSend` boundary. Observability does not grant
execution authority or replay a request.

`ObserverAdmission` checks one emission, two consumers, two registration
incarnations each and clearing. Completion assumes finite observer work.
Seven exact negative controls cover growing admission, registration replacement,
stale unsubscribe, clear, repeat, drop and absent fairness. It has no transport
generation dimension; nested RPC termination and physical-loss behavior have
separate actual Client/Cordis regressions. The `observers` chaos suite drives
real diagnostic and queued/started/terminal emissions, checks registration
admission and conservation, and records RPC intent/frame counts separately.
This is bounded evidence, not proof of all observer buses or TypeScript
refinement.

The [finite TLA+ model and verifier](../../../packages/workbench-runtime/spec/README.md)
cover two Hosts, one shared socket, two connection epochs and one Thread baseline.
Safety and conditional recurring liveness are checked separately, including
arbitrary logical losses before eventual stabilization, deliberate negative
controls and an explicit reachability witness.

## Ownership and observations

One Host connection owner makes admission and retry decisions. The Web adapter
reports lifecycle hints and transport observations; it does not add a retry loop.
A physical WebSocket can carry several Host leases. A gateway probe proves only
that route, not the readiness of a particular Host or its Thread baseline.
Thread catch-up remains separate from Host connection admission.

The owner needs the current attempt identity, attempt start time, current stage,
last meaningful stage progress, unconsumed wake signal, retry escalation,
validation budget and any server not-before restriction. The physical resource
owner retains its own startup/close barrier. Expiring a local wait cannot declare
that barrier complete, terminate an execution engine, or authorize another
physical generation to bypass it.

Meaningful progress is an observed completion advancing the attempt's stage:
`services -> admission -> release -> bridge -> host -> initialize -> session`. Repeated lifecycle events,
unrelated traffic and repeated reports of the same stage cannot renew deadlines.
These local observations report completed boundaries, not network or Host
readiness. Repeated reports of a previously visited stage are ignored. The Web
adapter reports admission completion, release completion and bridge `ready`;
transport `open` begins initialization, and accepted initialization begins
session assembly. History still has its own resource owner.

## State transitions

| State / input | Guard | Required decision |
| --- | --- | --- |
| idle / demand to connect | physical admission permitted | Start one attempt with an absolute deadline. |
| attempting / foreground or online hint | stage and total budgets remain valid | Keep the attempt; retain a coalesced wake signal. Do not start a second dial. |
| attempting / meaningful progress | current identity; neither deadline elapsed | Advance stage and stage progress time; retain the original total deadline. |
| attempting / explicit connect, hint, tick or expiry | stage idle budget or total budget elapsed | Revoke local ownership; evaluate the retained signal and admission constraints for a successor. |
| attempting / retryable failure | current identity | Revoke ownership, advance retry history; consume an eligible retained signal for one timely validation. Otherwise wait for the next eligible admission. |
| backoff / hint | visible demand, validation budget available, server restriction and physical barrier permit | Start one validation without clearing retry escalation. |
| backoff / repeated hints | validation or server budget unavailable | Coalesce the signal; an eventual budget tick re-evaluates it. Do not spin. |
| attempting / successful initialization | current identity and both deadlines valid | Commit Host readiness, consume earlier weak hints, schedule separate Thread catch-up. |
| usable / foreground hint | validation budget available | Probe the route; never infer Thread authority from the probe. |
| usable / current authoritative Thread baseline | baseline belongs to the current generation | Grant that baseline's authority. Cached paint and probes cannot do so. |
| any live state / manual rejection | current identity | Revoke authority and remain blocked across automatic hints. Explicit retry may re-evaluate admission. |
| any / old completion, failure or timeout | retired identity | Cannot commit or revoke current ownership. Elapsed-time expiry of the current attempt is still independently enforced. |
| any / dispose | owner alive | Revoke ownership and stop recovery permanently. |

Hidden demand suspends new validation admission; retained signals can be
re-evaluated when demand returns. Logical-clock resumption must check absolute
deadlines immediately, even if suspended timer callbacks have not yet executed.
Success after the deadline cannot renew an expired attempt. A fresh successful
initialization covers earlier weak lifecycle hints; those hints do not require
another connection after readiness.

## Safety and conditional progress

- At most one **locally authoritative** attempt per Host; old work may physically
  finish later but cannot publish through a successor.
- Host readiness, gateway reachability and Thread baseline authority are distinct.
- Manual blocks, server not-before restrictions and physical barriers survive
  lifecycle hints. Validation consumes a finite budget; signals are not an
  unlimited reset of retry history.
- Recovery does not replay writes, discard drafts, restart engines, or add a
  second authority for cached messages. Those remain integration obligations;
  the bounded owner model alone cannot prove them.
- If visible demand continues, no manual block remains, the route and Host
  eventually respond, physical admission settles, and clock/event processing is
  fair, an eligible retained signal leads to validation without paying an old
  escalation delay again. The remaining wait is bounded by validation budget,
  server admission, stage/total attempt budgets and separate Thread catch-up.
  There is no unconditional recovery-time guarantee for an unavailable server.

## Runtime budgets and boundaries

The generic owner starts with a 30s stage budget and a 60s total budget. Runtime
assembly uses 30s; an opaque transport has 45s; Web admission/release/Host stages
have 35s, bridge has 15s (its physical handshake retains its own 10s timer), and
initialization has `max(30s, requestTimeout) + 5s`. The existing Runtime aggregate
budget remains `max(60s, requestTimeout + 15s)`. Every stage is capped by that
original aggregate deadline. These are local wait limits, not promises that
remote work has ended; physical AppHost admission and close keep their own
barriers and existing server classifications.

The five-second budget limits hint-driven validation, not ordinary retries or
explicit user retries. An early hint during backoff is retained until the first
eligible validation or earlier ordinary retry. Success consumes all earlier
hints; manual rejection/disposal discards them. Wake coalescing never resets the
outage counter. Only continuous usable time resets it under the existing policy.

`assertCurrent` also runs before the AppServer client caches an initialization
response: a late response after page freeze cannot seed readiness for a successor.
That cached result also retains the owning attempt's signal until its handoff;
revocation between client and owner commits invalidates it immediately. Generic
callers without an owner guard keep completed-connect cancellation semantics.
Local Web cancellation rejects and releases its Promise synchronously before
status observers can reenter. Old external admission can remain pending forever;
a successor performs its own admission while still waiting for actual prior
lease release. Cancellation/close never shuts down a shared socket's healthy peer.

The browser emits recovery hints only while visible; this change does not suspend
ordinary retry scheduling in hidden pages. Server not-before and demand gates in
the abstract specification are environmental constraints; this owner does not
invent a new server Retry-After protocol or bypass the existing physical owner.

## History recovery transactions and observer reentry

History scheduling has its own work identity and logical reservations. A work
item is registered before episode/queue observations can call back into the
owner. It becomes schedulable when its queued observation is installed. A
reentrant recover can join that item; remove, invalidate and dispose can already
settle its caller. Invalidation retires active reservations before notifying
observers. Every continuation rechecks work identity and generation after a
success, failure or retry observation.

Active reservations belong to work objects, not reusable Thread keys. Cleanup is
installed before history-start notifications. Removing a work item releases its
logical reservation, so an abandoned history cannot hold another Thread's
admission. A retired completion can release only its own reservation and cannot
clear a successor, including replacement under the same connection generation.
This does not claim that remote read I/O stopped: the hydration owner still
checks binding/revision authority, RPC capacity remains separate, and physical
transport close barriers are unchanged. Best-effort cancellation of underlying
reads and binding hydration's pending-operation handoff remain separate audit
boundaries.

Explicit retry joins an active read and retains one retry intent. Success covers
that intent; failure admits one successor without inheriting the old backoff.
The retry ticket is captured at actual read invocation, so a request already
covered by that read is not replayed. Retry observers cannot install an obsolete
timer after explicit retry, removal or invalidation. Removal/disposal takes
precedence over retained retry demand. Current logical reads remain bounded by
the scheduler's concurrency policy; retired remote I/O is not counted as current
authority or claimed to obey that local bound.

The independent `HistoryReentry` model checks two work identities at five
representative observer boundaries, with optional retained retry demand, six
ownership/order mutants and a missing-fairness control. The executable history
chaos suite drives the actual `ConversationRecoveryOwner` across two resources,
including one-shot observer reactions, late reads, demand, retry and cancellation.
A real Workbench subscriber regression also disposes Runtime during history
admission. These cover scheduling transactions, not a complete Thread baseline
or model-to-implementation refinement proof.

## Executable evidence

RPC deadlines have a second ownership level: a pending request owns its current
timer revision. Context preparation can extend `turn/start` / `thread/resume`
waiting, and preparation completion can shorten it again. The adversarial clock
contract permits retired callbacks to be delivered after cancellation. Such a
callback must check both the pending request object and timer revision before
rejecting anything. This is defense against an uncooperative adapter: standard
browser timers themselves check cancellation before invoking their handlers.
It is not evidence of a default-browser timeout race. The guard preserves the existing 180s
absolute preparation budget and ordinary request timeout policy.

The separate finite `RequestTimers` model checks replacement and completion
across two request incarnations, including adversarial due callbacks retained after clear.
Its positive specification checks timeout ownership, no premature timeout and
termination under fair clock/callback delivery. Negative controls remove each
ownership check or fairness. This is a timer contract, independent of the Host
model; it does not prove that every runtime request refines the specification.

The independent [test specification](../../../tests/protocol/fixtures/recovery-specification.ts)
uses normalized logical budgets (stage 10, total 25, validation 5). They express
ordering and expiry, **not proposed production timeout values**. Production
budgets and real boundary observations are described above. The model
abstracts one Host and one representative Thread baseline, not a full multi-Host,
shared-socket or UI simulation. A future adapter must replay these same traces
through real owners; passing the independent model is not implementation conformance.

The [contract tests](../../../tests/protocol/connection-recovery-contract.test.ts)
check each explicit transition and enumerate all depth-four prefixes over nine
events (7,381 states including the initial state). They also run assertions
against the actual `ConnectionLifecycleOwner`:

| Gap | Actual trace | Target assertion |
| --- | --- | --- |
| RECOVERY-GAP-01 | connect pending; hint at 5s; retryable loss | The hint remains available for one immediate eligible successor. |
| RECOVERY-GAP-02 | connect pending; clock frozen past 60s; foreground arrives before timer callbacks | Recheck absolute expiry and retire the expired attempt on wake. |
| RECOVERY-GAP-03 | opaque attempt reports no progress for 30s; foreground arrives; total budget is 60s | A stage-specific idle policy can retire the stalled attempt before aggregate expiry. The 30s probe is an investigative bound, not a chosen production threshold. |
| RECOVERY-GAP-04 | actual renewable Web transport aborts while `beforeConnect` never settles | Retire the local wait promptly without declaring the external operation complete. |
| RECOVERY-GAP-05 | the next `connect()` arrives after the prior caller aborts | The successor must not join the revoked `connectOperation` or inherit its rejection. |

All five former gaps now execute as normal passing assertions. Further real-owner
regressions cover repeated versus distinct progress, total expiry without timer
callbacks, hint storms, manual rejection, late initialization caching, cancelled
admission success/failure, synchronous reentry and retained physical barriers.

```bash
npm run test:recovery-contract
npm run test:recovery
node --import tsx --test tests/protocol/appserver-connection-lifecycle.test.ts
```

The normal suite also verifies immediate wake during backoff and preservation of
failure escalation. No model check here claims to reproduce a particular user's
phone incident or prove unbounded multi-outage implementation liveness.

## Repeated recovery, cancellation layers and elapsed time

Each new loss creates a fresh recovery obligation. A previous successful Host
lease or Thread baseline cannot satisfy a later obligation. The finite model
uses reusable local admission slots, explicit ordinary retry eligibility and
recurring progress under eventual environmental stabilization. Disposal is a
terminal invariant, including faults arriving after disposal. Ordinary retries
can still recover without a hint; a counterfactual configuration disables them
to verify the causal role of a retained lifecycle wake.

There are distinct Runtime attempt, client initialization, transport attempt and
physical release owners. Cancelling initialization releases its local shared slot
and settles callers even if an acquired provider ignores cancellation. Old
continuations check operation identity before sending initialize or caching its
reply. Closing/failing a client also revokes its initialization. Sharing a live
operation retains its initiating owner's cancellation policy; a revoked operation
is never shared with a successor. Successful ordinary callers keep their existing
completed-connect cancellation semantics.

Deferred transport cancellation detaches old callbacks, installs the physical
release barrier and releases the local slot before notifying abort/status
observers. A successor waits on that barrier using its own cancellable operation;
a late import closes only its dormant result. Factories must return dormant
transports: creation does not itself admit a physical connection. Physical close
may remain pending forever; local cancellation is still prompt, but progress is
conditional on actual release. No cancellation fabricates successful cleanup.

Every explicit connect/reconnect checks expired ownership before joining an
existing operation, including when a page resumes before overdue callbacks.
Reentrant disposal or successor admission during expiry retains precedence.

Default recovery budgets use nondecreasing performance elapsed time, separate
from diagnostic wall timestamps. Date edits cannot extend those deadlines.
Custom `RecoveryClock.now` must be nondecreasing and include simulated suspension;
manual test timers must advance that clock when fired. The wall-clock fallback
rebases on reversal instead of waiting for its previous value to return, but a
platform without an elapsed source cannot reconstruct unsampled elapsed time
across a clock edit. OS sleep behavior of the platform elapsed source remains an
environmental boundary; browser JS freezing and wall-clock reversal are covered
by deterministic tests, not claimed as physical iPhone sleep verification.

Client context-preparation caps, queue waits and RPC durations use the same
shared elapsed source. Absolute queued/started/ended timestamps remain wall-clock
diagnostics. Custom `AppServerClientClock.elapsedNow` separates those domains;
legacy adapters without it must supply elapsed semantics through `now` as well.
Changing the wall clock cannot extend the 180s preparation cap or end it early.
This does not change ordinary request timeouts or preparation-completion policy.

A read that overlaps native snapshot history notifications needs another canonical cut.
This includes non-delta item/turn lifecycle, item updates and Thread status; an
older buffered start must not overwrite the complete answer or terminal state
already present in the snapshot. The same notification classification triggers
the reread and supersedes observations represented by its new canonical cut.
Non-snapshot presentation observations remain buffered for one release and are
not discarded with superseded history. This is a Session projection buffer; it
does not intercept the shared Client notification lane or another consumer. Live execution settings and native server
requests have independent owners, as described below. That retry phase has an elapsed deadline measured from initial read admission. Its
local owner settles with TIMEOUT and aborts child waits when the deadline expires,
even if an in-progress reread ignores cancellation. Joining/continuing also checks
expiry before overdue timer delivery. Initial quiet pagination retains its
existing per-RPC progress allowance; this is not a new blanket timeout on a
healthy multi-page initial read. Explicit zero disables both configured client
budgets. Custom Session `readClock` must use elapsed time and coherent timers.
Timer tickets fence retired callbacks, and opaque handles are retained even when
the adapter returns undefined. Expiry clears only its own slot before child abort;
if synchronous callbacks admit a successor, the triggering caller rechecks the
slots and joins that successor rather than overwriting it.

The [chaos simulator](../../../tests/protocol/fixtures/recovery-chaos.ts) checks
real owners/client/Deferred composition and recovery after a healthy suffix.
It records effective fault coverage, deterministic seeds, replayable failure
files and bounded delta reduction. It samples shared route availability rather
than replacing the real multiplexed Web adapter or Thread baseline owner.
See the [model README](../../../packages/workbench-runtime/spec/README.md#deterministic-implementation-chaos)
for commands, normalized budgets and proof limits.

### Revocable Thread hydration

Host readiness does not discharge a Thread baseline obligation. A logical Host
reconnect may retain the same initialized client generation and healthy physical
transport. Its retired history work must therefore be fenced by operation
identity as well as connection generation.

The history scheduler passes a per-run `AbortSignal`. Removal, invalidation and
disposal release their logical reservation and settle local callers before
aborting children. Binding hydration owns a revocable local Promise and clears
its slot before aborting Session read/resume. Session installs its own read/resume
owner before I/O or observers; revocation settles that Promise even when an RPC
adapter or history strategy ignores cancellation. Late success, failure, preview
and cleanup cannot commit through a retired owner or clear its successor's slot
or notification buffer. Preaborted callers cannot join shared work. A joining
caller's cancellation ends only that caller's wait; the initiating owner retains
the shared operation's cancellation policy.

Signals reach the initial read, Resume preflight, Resume itself, adaptive window
fallback, Turn/Item pagination and history strategies. Cancelling local Resume
ownership does not stop a process-scoped engine activation or roll back remote
work. Default presentation recovery remains read-only; legacy message-window
providers retain their explicit Resume path. No cancellation closes a healthy
shared socket or replays user commands.

A fresh baseline also retires the previous source's history contexts, background
drain, refresh and pagination identities, including on an unchanged client
generation. Their late results cannot append to the new baseline. Cached paint
survives; current authority still requires the new baseline. Independent older
page, refresh and background waits have their own revocable owners. Replacing a
baseline, marking it needs-resume, releasing the Thread or disposing the Session
clears those slots and settles callers before aborting their children. Cancelling
one derived read preserves the current baseline and unrelated Threads. A cancelled
refresh returns false, a cancelled older-page request rejects with ABORTED, and a
background wait ends without a history error. Joining callers may stop waiting
without revoking the initiating owner.

Older-page and refresh work capture only an already admitted predecessor, after
checking for their own existing owner. Their dependency graph follows admission
order; settlement, including cancellation or failure, releases the next independent
intent. It does not require the predecessor to succeed. Optional derived history
projection is demand-loaded after installing the local owner; every module/strategy
await checks current ownership before using Session services. Tail history drains
accept an optional local AbortSignal; provider code may still ignore it.

`HydrationHandoff.tla` checks two Threads and two logical revisions with separate
Binding and Session gates. Old replies have no fairness assumption, while current
work does. Exact negative controls retain either gate, accept old commits, clear
successor gates, delay local settlement or remove fairness. It is an independent
finite abstraction, not a refinement proof of the TypeScript implementation.
The `hydration` chaos suite runs the actual Workbench/Binding/Session/client chain
with held replies, release/reacquisition, retries and logical reconnects. Its
healthy suffix completes only newly issued requests before releasing retired
replies. Physical iPhone behavior and full shared-socket seeded faults remain
outside this suite.


`DerivedHistory.tla` separately models three admitted operations alternating
older/refresh kinds. Exact controls introduce a future dependency, silent local
retirement, stale slot cleanup, inherited predecessor cancellation or absent
fairness. Current I/O needs scheduling/completion fairness; retired replies do
not. The finite model and targeted real-Session held-strategy regressions are
independent evidence, not a full implementation refinement proof. Existing Host,
history and hydration chaos suites retain their own advertised scopes; they do
not claim randomized coverage of every derived-history callback.


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


## Execution activation and current presentation

User execution preparation uses `ThreadResumeCoordinatorService.activate`, an
independently owned metadata-only Resume (`excludeTurns: true`). It neither
allocates a history strategy/preview/buffer nor replaces the transcript source.
A same-generation logical reconnect may complete its current readonly baseline
while that activation ACK remains held. Full historical `resume` retains its
combined contract and same-kind coalescing; message-window compatibility still
uses that path. Physical connection loss and disposal retire activation waits;
View release alone does not cancel a pending user command.

The accepted ACK changes execution fields and stream ownership, never the current
history body or cursor. Observed execution-field revisions preserve live settings
received after activation began, including explicitly supplied unchanged fields.
Readonly metadata seeds fields without overriding accepted activation or observed
live settings. These are local ordering guards, not a server sequence protocol.

Workbench rechecks binding identity, route revision, client generation and current
baseline after every execution-preparation wait. Replacement reads may be followed
only during preparation. The actual command runs once outside that retry loop.
Composer checks dispatch again at the first mutation's synchronous client-local
`beforeSend`, after lifecycle observers and serialization. Local rejection retains
the original policy error and sends no frame. This function is not a wire field or
a transport/bridge option. A creation/fork ACK followed by a disconnected Turn RPC
has partial effects and must never be classified wholly unsent. Unknown outcomes
remain ineligible for automatic replay. Other control operations retain their own
admission rules; this is not a universal replacement for server authorization.

`ActivationHistory.tla` separately checks read progress without old activation or
old-history fairness, current-buffer/request conservation, original-intent
preservation and write admission. Execution progress additionally assumes fair
activation and dispatch. Its finite states are independent of TypeScript.
Hydration generator version 2 exercises real Workbench/Session/client composition
with explicit user intents, held activation ACKs, current reads and queued/started
observer reconnects. Its two-stage healthy suffix first makes only current reads
fair, then activation completion. Only a proven-unsent attempt may retry with its
original identity; an unknown write never retries. Negative controls couple
activation to historical Resume or omit final client admission, and preserve the
exact violated invariant during shrinking and replay. This suite does not model
all server permissions, settings notifications, physical sockets or phone timing.


## Native execution channels during history recovery

Presentation Read owns history transactions and snapshot supersession. It cannot
own `thread/settings/updated`, native request admission, a user response to that
request, or its Host withdrawal. Settings are projected immediately; both the
metadata activation ACK and legacy combined Resume preserve fields observed after
their own admission. A cancelled history cannot erase that live observation.

Each incoming JSON-RPC request has one client-local response context with a native
lifetime signal and retirement outcome (`answered`, `resolved`, or `lost`). The
context settles and releases its owner before synchronous retirement observers.
Host resolution and loss iterate only contexts present at their own boundary;
same wire-id successors admitted by observers have independent owners. Every held
interceptor continuation rechecks that context before entering another interceptor
or handler. After response serialization, the client checks the exact context and
receiving connection again immediately before transport admission. Retiring an
already admitted send is best effort at the transport; this is not a remote
rollback or a guarantee that an already transmitted response can be recalled.

The interaction Broker owns the prompt through that exact context, not through a
possibly delayed Thread notification. Withdrawal frees its slot, forgets its old
choice and settles local work before publishing removal; late cleanup cannot clear
a successor with the same id. Connection loss retains the existing explicit-choice
ledger contract for actual server redelivery, including unresolved delivery. A
new interaction is distinguished by its full identity and parameters. No ordinary
execution mutation gains replay permission from this ledger.

Workbench projects current native interactions and changed execution metadata into
its nonauthoritative paint while retaining the existing transcript and cursor.
This listener belongs to the binding, so a failed/cancelled history operation does
not cancel it. Replying to a Broker-owned native interaction does not initiate or
wait for a historical baseline. Known-Turn stop controls use the current Host
contract below. New submissions and the remaining baseline-gated commands retain
their existing current-generation baseline and final beforeSend checks.

`ExecutionChannels.tla` checks native progress under fair handler/answer processing
without assuming the history server ever replies, plus cancellation conservation,
live metadata, stale handler and same-id cleanup safety. Its eight positive/negative
configurations include a missing-fairness control. Older independent activation and
snapshot models remain bounded historical/transaction abstractions; their request
reservations do not establish native-request progress during an indefinitely held
Read. None of these models is a TypeScript refinement proof.

The `execution` chaos suite drives actual Client, Session and Broker instances with
held and late Read replies, cancellation, settings, numeric/string request ids,
withdrawal and human responses. A native-only fair suffix answers questions before
releasing history. Deliberate old buffering controls must reproduce their exact
violations after shrinking and replay. The existing hydration suite and Workbench
regressions separately cover new-input baseline admission and unknown-write policy;
synthetic browser checks are separate from physical phone/network verification.


### Native response evidence and fixture progress

Execution chaos generator 3 derives expected wire replies from each human intent,
independently of the production response mapper. The oracle checks count, exact
typed request id and complete response structure, including ordered answer values
and unexpected errors. Object property order is immaterial. The fixture submits
answers sequentially and observes each delivery before its next intent; it does
not impose a general JSON-RPC response-ordering requirement on concurrent work.

An immediately cooperative in-memory native transport has no external response
wait. The harness drains its known event-loop turns and reports NATIVE_PROGRESS
if the local answer still waits, while history remains deliberately unavailable.
It observes rejection without an unhandled Promise, bounds local Read settlement
and cleanup in the same fixture, and preserves the original violation if cleanup
also fails. This is a fixture progress check, not a new production timeout or a
physical-network latency bound. Bootstrap and environmental fairness retain their
separate suite contracts.

Count-only controls previously accepted a wrong answer and wrong wire id; a held
native handler left the old harness waiting until an external release. These are
verified tool blind spots, not evidence that production currently emits those
wrong replies. New wrong-answer, typed-id and history-gated-response controls must
fail their exact rules, shrink without a cleanup failure, and pass normal replay.
Artifacts retain runtime version/platform/architecture with generator and source
hashes. The existing independent ExecutionChannels NativeProgress contract is
unchanged; stronger executable evidence does not turn it into a TS refinement proof.


## Known-Turn stop controls

An explicit stop names its original Thread and Turn. It needs a current usable
Host and physical client generation, the same live binding, a non-retired Thread
and execution permission. Historical baseline authority and an implicit question
dismissal delivery receipt are separate owners and cannot hold this control.
The final client-local admission guard runs again after request observers and
serialization; it grants no permission to a retired operation. A logical history
revision alone does not retire the usable physical Host.

Conversation reserves a per-Turn stop Promise before publishing its interrupting
state. Synchronous snapshot/request observers join that intent. Best-effort
question dismissals run with handled failures independently of the stop. Releasing
a View preserves an admitted user intent; disposing its Runtime prevents an
unsent command. Native rejection and an uncertain write outcome reach the caller;
there is no automatic replay, target substitution or claim that the engine has
stopped merely because a local wait ended. A later explicit user request remains
a new intent. The native engine must enforce its own exact-target semantics.

`StopControl.tla` independently checks current admission, original target,
at-most-one send and eventual local settlement under fair preparation/admission/
completion. Read replies and prompt receipts have no fairness. Its finite Host
churn and cooperative native completion assumptions do not promise progress for
a permanently unavailable Host. Eight configurations include exact history and
prompt gate, stale fence, target, replay, slot and missing-fairness controls.
This abstraction is not a composition or TypeScript refinement proof.

The `stop` chaos suite exercises actual Workbench/Session/Conversation/Client
composition with retained Reads, held prompt receipts, observer reentry, final
disposal, View release, server-head changes and ACK loss after native admission.
Its independent oracle checks the input target, frame count, caller result and
progress before unrelated work is released. Four deliberate controls must fail
at the named rule; shrinking preserves that rule and ordinary replay must pass.
The loopback server is cooperative and enforces exact targets for this fixture;
these results do not certify every provider or physical phone behavior.


## Projection subscription ownership

A Session owns its historical projection, not the shared Client's notification
delivery schedule. The Client fans out a native observation once; Workbench
resource owners, catalogs, completion subscribers and other Sessions may observe
it before this Session's Read finishes. In particular an archived/deleted Thread
can retire its local Read and unsent controls without waiting for that Read's
reply. Restoration remains an explicit resource action; a late old Read cannot
replace current unavailability or a newly restored baseline. A transition from
unavailable to available schedules current history only for an existing demanded
binding. Reselecting the same route is not required. Duplicate availability
observations are idempotent and cannot invalidate that new recovery. A restoration
ACK updates availability only if its captured resource revision and Client/physical
generation are still current; a newer native deletion must win.

`AppServerClient.subscribeNotification` accepts an optional client-local
`intercept` for that subscription only. Its deferred `next` delivers only to the
original live subscription on the receiving physical generation, at most once.
Consumer exceptions, including deferred failures, use the existing isolated
protocol-error channel. They do not prevent another consumer from receiving the
event or fail an unrelated history request. Cordis forwards this option. It is
not an RPC option and must never be serialized. Explicit transport-wide
`interceptNotification` remains available for transport-level policy; a Session
history buffer does not install one.

The coordinator registers its projection callback through this scoped option.
Buffer begin/release/discard and the existing snapshot classification still
control only that callback. Preview, execution settings and native withdrawal
retain their immediate projection behavior. Other projection observations retain
ordered release; only canonical snapshot observations are superseded by a quiet
reread. Hook start/completion and custom ephemeral projections are not silently
removed with old snapshot events. Release never republishes an event to native
resource owners or a peer Session.

`ProjectionNotifications.tla` independently models one observation, two Session
consumers, a held Read, local cancellation, subscription retirement and two
physical generations. Read replies have no fairness; receiving the current
native event has weak fairness for progress. Eight configurations check native
delivery, peer independence, no global replay, projection lease and conservation
with exact global/peer gate, replay, retired/generation, drop and missing-fairness
controls. This does not model full payloads, arbitrary load, every reentry or
TypeScript refinement; existing ownership/cut models remain separate.

The `projection` chaos suite runs actual Workbench/Client and two peer Sessions
sharing one Client. Input-derived token/order oracles check native delivery,
resource authority/retirement, per-consumer projection and isolated failures
before releasing Read replies. A controlled healthy suffix checks remaining
projection conservation and canonical cuts. The server enforces only fixture
behavior; these results do not prove physical-phone or provider behavior. Known
late replies to cancelled RPCs remain separate diagnostics and cannot be counted
as a deliberate projector failure. Five controls (`global-buffer`, `peer-buffer`,
`native-replay`, `drop-projection`, `missing-restore-wake`) must fail their exact rule, shrink with that
rule and replay normally without injection.


`ResourceAvailability.tla` separately models one restoration transaction and a
fixed View demand, native restore/delete ordering, the mutation's captured epoch,
idempotence and current Read admission. Old Read replies have no fairness. Six
configurations require current restoration progress or a later native deletion,
and reject stale ACK resurrection, missing wake, duplicate epochs and fabricated
Read demand; the final control removes scheduling fairness. Later resource
recreation and arbitrary demand changes are outside this finite transaction.
Executable held-ACK, no-View, reentrant restore and full-Web cases substantiate
the implementation mapping independently of that model.


## Native handler registration and admitted responses

Each `handleServerRequest(method, handler)` call creates a new method registration,
even when it reuses the same function. The latest registration admits future
requests; its unsubscribe handle can remove only that exact instance. Unlike
non-authoritative observer subscriptions, repeated calls are replacements, not
same-function deduplication. A held interceptor chooses the current registration
when it finally enters the handler. The handler is invoked as a bare function.

Once a handler is admitted, the native response context owns its asynchronous
result. Replacing or removing a registration cannot cancel that context or retarget
its result to a successor. Native withdrawal and physical Client loss still revoke
the context through the existing lifetime rules. `HandlerRegistration.tla` separates
the two owners for one method, two registration instances and one request;
completion assumes finite handler work under weak fairness. It does not model
interceptor or wire scheduling, prove the TypeScript implementation, or establish
physical-device timing. Raw/Cordis tests and the real Client `handlers` chaos suite
cover those concrete registration/response boundaries separately.


## Transport status observation and settlement

The adapter owns transport status and native connection settlement. Synchronous
status observers cannot fail a physical connection, orphan its Promise, interrupt
a peer or prevent Client cleanup after loss. WebSocket open settles the native
connection before notifying observers. Each publication captures its registration
cut when enqueued, preserves same-function deduplication and checks registration
identity before delivery or removal. An unused duplicate token cannot revoke a
later incarnation.

`TransportStatusObservers` is the narrow adapter primitive in the existing Client
transport entry. It reuses the Client observer registry, isolates synchronous
errors and drains publications in causal order. Obsolete nonterminal snapshots
can be skipped. Closing/closed/failed events must still retire the old connection
if a callback starts its successor; they precede successor publications. Permanent
observer cleanup drains after the queued terminal event. Client retires old
initialization and outgoing RPC work at local closing, independently of the remote
close ACK. A reentrant `Client.connect()` creates its initialization slot after the
current synchronous status publication, so the old failure cannot cancel a new slot.

Memory, WebSocket and Replay retain their initial sample per subscription;
Deferred and AppHost channels retain no initial sample. A requested sample is
separate from publication order and invokes the consumer as a bare function.
Client diagnostics/lifecycle continue without a physical/publication gate,
including failure after loss. Message, hint and interceptor contracts are unchanged.

`TransportObservers.tla` separates native open, observation, old retirement and
one successor Client initialization. It bounds one changing observer to two
incarnations, one persistent Client consumer, an optional held request and three
publication versions. Progress assumes finite callback work, bounded synchronous reentry, fair native open,
processing and successor initialization ACK; no RPC timeout or history reply is
needed for old failure delivery. Twelve controls cover callback escape, token,
admission, stale snapshot, repeat delivery, orphaned connect, lost failure,
incorrect terminal gating, early clear, early successor allocation and absent
native/init fairness. Initial samples, arbitrary generations and TypeScript
refinement are outside the model. Actual five-adapter/raw/Cordis tests cover
these concrete boundaries separately.

The `transport` chaos suite drives actual WebSocketTransport with a controlled
socket and two consumers. It exercises open/sample errors, token churn, self/peer
replacement, close, successor-connect reentry, abort, failure and late native open.
Public status/callback/Promise observations form its oracle; private registries
are not inspected. Samples, causal publication order, terminal conservation and
queue admission are distinct checks. Public getters at method and close-ACK
boundaries retain the cut before a queued publication is observed. Physical inputs,
ACKs, intents, publications, deliveries and samples are counted separately.
Healing is explicit in the saved trace; an empty trace allocates no connection.
Four adapter corruptions check exact-rule shrinking and ordinary replay. The suite
itself does not run a Client or real network; composed Client tests prove held-RPC
termination and initialization-slot reentry.


## Memory native connection incarnations

MemoryTransport allocates a distinct owner and peer for each connection attempt.
Concurrent connect callers join that attempt; the initiating signal owns its
pending cancellation. Cancellation after open is a no-op. Native peer sends,
scheduled deliveries and each next message consumer check that same open owner.
A retained old peer cannot send through, or close, a successor. The peer passed to
receive remains bound to that connection even when asynchronous server work ends
later. This provider boundary is separate from status-observer registration.

Local close, abort and peer close settle pending connect callers immediately and
revoke the owner before external callbacks can reenter. A connecting-status
callback can cancel before server admission starts. Old admission success/failure
cannot publish readiness or failure through a successor. For an already open
connection, close still waits for its own disconnected hook; its ACK or failure
only settles that close caller and cannot publish status through a newer owner.
A current cleanup failure remains a failed status and rejects that close caller.

Pending connected hooks are not local close barriers. Their eventual success or
failure starts disconnected cleanup for their own retired peer exactly once,
after admission settles. An attempt revoked before admission invokes neither
hook. This ordering prevents cleanup from running before a late admission has
finished allocating its resources. Local close completion during pending admission
does not certify external cleanup. An indefinitely pending admission Promise or arbitrary server
side effects remain server-owned; finite synchronous callback work is assumed.
Deferred cleanup failures cannot fail a newer
connection. An already open close retains its external cleanup barrier.

The independent MemoryGenerations model bounds one primary and one successor,
a single frame per origin, asynchronous admission and successful cleanup ACKs.
It checks publication owner, peer/queued-frame authority, local cancellation,
cleanup order and at-most-once cleanup. Live admission fairness applies only to
active owners. Retired hooks may remain uncooperative forever without preventing
local cancellation; cleanup progress is conditional on their eventual settlement
and a fair cleanup scheduler. Open-close completion additionally assumes a fair
cleanup ACK. Ten negative controls remove these guards or fairness assumptions.
Initial status samples, callback registration, receive internals, arbitrary churn
and TypeScript refinement are outside this finite model. Concrete tests cover
synchronous reentry, current/old hook errors, delayed receive and Client reconnect.

The memory chaos suite runs actual MemoryTransport with controlled connected and
disconnected promises, retained peers and an explicitly drained delivery queue.
An independent intent/epoch oracle predicts status, connection settlement, cleanup
counts and frame authority; it does not inspect private fields. It contains no
Client or actual network. Healing is a saved event, not a hidden probe. Trace
native inputs/admissions/cleanup calls/deliveries are separate from intents and
cleanup after the trace. Three test adapter corruptions exercise orphaned connect,
retargeted peer and retargeted old cleanup, with exact-rule shrinking and normal
replay. Existing actual-Client tests establish the composed request behavior.
ReplayTransport's separate delayed-frame/cursor lifecycle is not fixed by this
Memory provider change.


### Client native retirement and successor admission

A Client initialization slot and a native transport activity have different
lifetimes. Closing retires the current activity immediately; its later closed or
failed ACK must not revoke a successor slot that is still preparing native
admission. Retirement of initialization authority is idempotent until a new
connecting/open observation re-arms it. Every terminal observation still rejects
pending RPCs and invalidates incoming response contexts. The whole terminal
handler must not return early merely because retirement already occurred.

Client seeds that authority from the constructor's native status, including an
already open provider that emits no initial subscription sample. Connect retains
its microtask admission boundary and reconciles the current native snapshot before
allocating or joining a slot. This also retires cached initialization and held
RPCs when an intermediate observer missed a loss. It is recovery at the next
connect entry, not a replacement for reliable transport notifications.

Each initialization records whether its native connect has started. A subsequent
caller cannot join already issued work whose current native snapshot is terminal,
even if an earlier native observer revoked it before Client saw connecting and its
rejection continuation has not run. Preparing successor work remains eligible.
Cancellation and stale continuations retain slot identity checks; explicit caller
abort keeps its ABORTED cause. Successful recovery initializes once; failed RPCs
are never replayed implicitly.

The provider must fence native generations and order conserved terminal
publications before successor activity observations. Its accepted connect must
publish connecting/open or reject without leaving admitted work hidden behind a
terminal snapshot. Client cannot infer native epochs from a provider that falsely
labels a stale failure as current. Finite synchronous callbacks and a cooperative
local scheduler are assumed.

ClientRetirement independently models two native activities, a preparing versus
issued local slot, old closing/ACK, initial live snapshots, unseen revocation and
stale rejection continuations. Its positive configuration has 76 reachable states;
nine controls remove guards or local/native fairness. Progress assumes fair local
work and a cooperative new native connect/initialize response; old close ACKs need
not be fair. This is a bounded model, not TypeScript refinement or proof of every
intermediate observer, network or arbitrary callback schedule.

The retirement chaos suite composes actual JsonRpcAppServerClient and actual
MemoryTransport. Its server-owned epoch/intent oracle checks settlement, current
readiness, initialization count, held RPC authority and one wire submission per
admitted RPC. Renew closes and connects without awaiting close; repeated terminal
samples, genuine new losses, old peer callbacks, cancellation and explicit heal
are saved inputs. Empty input performs no native connect, and final cleanup only
retires existing work. Controlled callbacks are sampled after bounded microtask
drains; this does not model arbitrary native timing or infinite JavaScript work.
Four adapter corruptions test old-loss re-arming, dropped current loss, orphaned
result observation and extra request submission. They must fail exact rules,
shrink under the same rule and replay normally. These controls are distinct from
running the unchanged old Client through the same oracle.


### Recording observation and message tap ownership

RecordingTransport delegates status subscription to the wrapped transport's own
registry. Each subscriber receives that provider's initial sample and subsequent
publications under the provider's normal contract. Connecting a recording tap
does not broadcast an internal raw subscription sample to existing subscribers.
Closing a tap does not unsubscribe Client status observers or erase a queued
terminal notification. Native status ordering, generation fencing and synchronous
observer isolation remain provider responsibilities.

Only the message recording tap has an attachment lifetime. Close retires its
captured attachment before invoking the underlying close, so reentrant connect
acquires another tap. The old close retains its own native ACK/error outcome;
its finally block releases only its own registration, including after failure.
It cannot detach its successor. Registration publishes attachment identity before
calling the provider, and late return of a synchronously revoked registration is
released once. Message fanout uses the shared observer registration cut, instance
tokens and per-listener attachment guard. Retirement during an earlier callback
prevents delivery of that old frame to later listeners.

A recorded frame is appended before its optional sink is called. The sink is a
bare synchronous observation; a synchronous sink failure cannot block delivery,
prevent an outgoing native send or mask its actual error. An outgoing record still
describes an attempted send, as before, rather than certifying successful remote
submission. Clock input and arbitrary external callback side effects remain
trusted boundaries. The existing recording DTO/API is not made immutable by this
change. No failed RPC is replayed.

RecordingLifetime independently bounds an old and a successor tap, a queued
terminal notification, an already captured old frame, close success/failure,
native samples and sink/observer continuation. The positive model has 92 distinct
states. Eight controls remove cleanup ownership, terminal subscription,
sample provenance, sink/observer continuation, frame retirement, failed-close
cleanup or local fairness. Old close ACKs need not be fair for a successor to
work. New connect and finite callback continuation require cooperative local work.
This is not TypeScript refinement, arbitrary native timing, registration-cut
proof or Replay cursor verification; concrete tests and the existing shared
observer model cover additional boundaries.

The recording chaos suite composes actual RecordingTransport, Client and
MemoryTransport. Its independent server/intent oracle compares native status
publications with subscriber observations, verifies frame conservation, one
native RPC submission, current initialization identity and request settlement.
Inputs include status/message/sink exceptions, stale unsubscribe handles,
status/message reentry, held replies and old peer callbacks. Explicit heal both
initializes and completes an echo RPC. No hidden cleanup probe creates a new
connection. Trace metrics separate native admissions, tap deliveries/releases,
recorded frames and connect/RPC intents. Final teardown releases existing Client
work and harness-owned adapter registrations, including deliberate corruptions.
Three adapter controls duplicate a status observation, retarget a cleanup token or
orphan the observation of an RPC result. They must fail exact rules, shrink under
the same rule and replay normally; they are distinct from unchanged old-class
comparisons. Bounded microtask drains assume cooperative controlled callbacks.


### Replay native epochs, frame reservations and drain admission

Replay keeps a single ordered tape across close/reconnect. Its wire format has
sequence, direction, timestamp and payload, with no recorded native epoch markers.
It cannot infer the origin of every unreserved frame after a reconnect. Native
retirement consumes and drops only an already admitted delayed server frame,
exactly once. It neither resets the tape nor implicitly repeats a client mutation.

| Scope | Authority | Retirement boundary |
|---|---|---|
| Native connection | Connection instance | Close, startup cancellation or current delivery failure |
| Server frame | Epoch and reserved cursor position | Commit once or consume/drop once on native retirement |
| Joinable drain | Running drain instance | Release synchronously when work stops; Promise cleanup retains its own token |
| Send caller | Its AbortSignal and result observer | Ends local waiting while admitted native traffic continues |
| Startup caller | Its initiating signal | May retire startup; detached once startup completes |
| Default timer | Native owner and timer handle | Cleared on retirement; injected clock resources stay provider-owned |

A server frame retains its cursor reservation while recorded timing waits. A
same-epoch client send cannot skip it and match a later client frame prematurely.
After close, a successor can resume after that retired claim without waiting for
an uncooperative old clock. Every old continuation checks native owner, drain
identity and reserved cursor before writing state or delivering a frame. A
current clock failure consumes its own claim, rejects its own callers and
publishes failed; an old clock failure cannot affect a successor. Response ID
bindings belong to their native owner. Existing JSON-RPC envelope normalization
and exact domain-parameter matching remain unchanged.

A completed empty drain is no longer joinable, even while its Promise completion
is queued. The visible drain slot is released synchronously at the stopping
decision. A later same-stack or microtask send acquires fresh work, and old
completion only clears its own token. This distinguishes an active worker from a
settled Promise and prevents accepted frames from being stranded without a drain.
Closing/failure observers may start a successor before old cleanup returns;
neither the old closed publication nor old drain cleanup owns that successor.

Message fanout reuses the shared finite registration cut, replacement tokens,
bare synchronous invocation and per-listener owner predicate. A close in an
earlier callback stops the old frame before later observers. Finite synchronous
callback work is assumed; arbitrary external side effects are not controlled.
Replay's default timer has an actual cancellation handle. Closing clears it,
rather than only racing away from the sleep Promise. A custom ReplayClock remains
a trusted external port and may ignore retirement; local settlement still does
not wait for that clock. Its external resource cleanup is not certified by close.

Two independent bounded models cover different layers. ReplayLifetime bounds
two native epochs and four tape positions, separating retirement, old/new clock
wake, close completion, cursor commit and caller cancellation. Its positive has
116 distinct states and eleven precise controls. Progress assumes fair local work
and cooperative current clocks, with no fairness requirement for retired clocks.
ReplayDrainAdmission bounds one finished drain and one new worker: six states,
three controls for stale join, retargeted completion and absent work fairness.
New work does not depend on the old Promise completion. These views are not a
product/refinement proof of TypeScript and do not model arbitrary tape data,
payloads, clock errors or platform timer handles. Actual tests cover those
additional failure/reentry and timer-resource boundaries.

The replay chaos suite executes actual ReplayTransport with saved clock
release/rejection inputs. An independent epoch/cursor/claim/intent oracle checks
native status, exact tape accounting, one clock request per admission, observer
frames and caller outcomes. Same-stack connect-send is an explicit compound input.
Startup abort, local send abort, rejected/mismatched frames, noisy observers,
message-time close and old clock wake combine within generated traces. Explicit
heal retires old work, connects and completes a matching send/reply while retired
clocks remain held. Empty input creates no connection, send or clock wait.
Metrics distinguish events, actual connect/send intents, observed frame delivery,
clock waits/releases and retired claims; settlement counts include final local
cleanup. Teardown closes existing work and then releases fixture clocks, with its
own failure rule so shrinking cannot substitute hidden cleanup for a trace rule.

Three controls corrupt result observation, observer delivery or a reported cursor,
rather than production classes. Each must fail its precise rule, shrink under that
rule and replay normally. Unchanged old-class comparison and the retained first
candidate separately demonstrate real regressions, including a one-event compound
connect-send reproducer for the finished-drain gap. Secondary teardown failures
remain separately recorded. Controlled microtask drains and finite tapes bound
these tests; they are not arbitrary-network, physical-device or whole-program
correctness claims. Public Node async_hooks separately checks actual default timer
creation/destruction without reading or mutating class fields.
