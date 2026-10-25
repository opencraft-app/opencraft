# Connection recovery transition contract

Status: implemented for foreground wake conservation, stage/absolute expiry,
revocable Web/client/Deferred waits, elapsed-time deadlines and initialization commit fencing. The tables
also express environmental constraints abstracted by the independent model;
they are not an implementation refinement proof or a phone latency guarantee.

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

A read that overlaps native history deltas needs another canonical cut. That
retry phase has an elapsed deadline measured from initial read admission. Its
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
