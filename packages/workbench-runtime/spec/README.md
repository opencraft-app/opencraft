# Recovery model checking

This is an independent finite TLA+ specification, not production code or an
implementation refinement proof. The target contract is documented in
[connection recovery](../../../docs/architecture/platform/connection-recovery-contract.md).

## Scope and assumptions

The state space contains two Hosts (`a`, `b`), one shared socket, two connection
epochs, one representative Thread baseline, and one already accepted command.
It models an initial socket outage and arbitrary repeated logical lease losses
on its successor route. A weakly fair `Stabilize` action eventually stops those
faults. Retired admission slots are reusable; an earlier successful lease or
baseline cannot discharge the obligation to recover after a later loss. Repeated
physical socket epochs and continuous-time latency remain outside this finite
model; they are exercised at the isolated physical boundary by the chaos runner.
Old logical admission may never finish. Actual physical startup/close barriers
are separate and must eventually settle for conditional recovery to apply.

`SafetySpec` makes no fairness assumptions. `FairSpec` adds weak fairness for
network recovery, physical barrier release, socket completion, timeout/retirement,
ordinary retry budget ticks, current admission, environmental stabilization and Thread catch-up. Permanent manual rejection or disposal
removes that Host from the conditional progress obligation. The clock is a finite
old-attempt expiry abstraction; precise stage/total/validation budgets remain in
the earlier executable specification. Duplicate hints are represented by one
coalesced signal per Host. This model does not prove real retry-rate bounds.

Safety includes current-epoch authority, at most one lease per Host, preserved
wake signals, manual blocking, baseline authority, no duplicate command, physical
barrier admission and Host isolation. Conditional liveness uses `[]<>` for current Host leases and the current Thread
baseline, under eventually stable eligibility. Disposal is an invariant terminal
state. Scheduler admission requires a retained wake or two normalized ordinary
retry ticks, so it is not assumed unconditionally enabled. A final stuttering trace
with a healthy socket but a retired lower-layer gate is a liveness violation.

## Reproduce

Use Java 17+ and the official [TLA+ v1.8.0 release](https://github.com/tlaplus/tlaplus/releases/tag/v1.8.0)
`tla2tools.jar`. The verifier pins SHA-256
`d15655eeaff4b3f7b3d65c46b838bc0f35d131b2ef4b1e473689b62c98d4726f`,
checked against the release asset's GitHub digest. It downloads nothing and
does not add Java or TLC to runtime dependencies.

```sh
npm run test:recovery-formal -- --jar /path/to/tla2tools.jar --output /tmp/recovery-formal
```

Three positive configurations check safety alone and safety plus temporal
properties. Nine mutants must fail at the exact invariant or temporal property:
dropping hints, retaining old logical gates, accepting old grants, cross-Host
revocation, replaying a command, bypassing a physical barrier, retaining a retired admission
across another loss, reviving disposal and dropping the only wake when ordinary
retries are disabled. `WakeFairSpec` assumes eventual lifecycle delivery for this
last counterfactual pair; the normal model does not assume such hints. A lost
wake can delay a normal retry without preventing eventual ordinary recovery. A deliberately
false witness invariant demonstrates that both healthy Host leases and the Thread
baseline are reachable. Removing fairness must break the temporal claim, showing
that progress was not established without scheduling assumptions.

The runner requires complete TLC exit status, exact violation classification,
counterexample JSON files and the intended blocked terminal state for the old-gate
mutant. A timeout, tool error, unexpected invariant or missing trace fails the
verification. Logs, trace JSON, model hashes and state counts go to the requested
external output directory. There are no state constraints, symmetry reductions or
depth bounds that prune liveness paths; the specification itself is finite.

## Implementation evidence

The actual Web transport tests replay the old-gate failure as
`RECOVERY-GAP-04` (local abort must settle while `beforeConnect` is pending) and
`RECOVERY-GAP-05` (a successor must own a new operation after revocation). These
former counterexamples now pass as ordinary assertions after the runtime repair. A separate actual shared
socket test confirms that one Host's failure and late old-lease frames do not
revoke a healthy peer or the recovered lease.

```sh
npm run test:recovery
node --import tsx --test tests/protocol/websocket-app-host.test.ts
```

The reduced admission/abort/successor sequence is a causal reduction of the TLC
old-gate counterexample, not a claim that TLC proved a globally shortest trace.
The implementation also checks late admission success/failure, synchronous
reentry, physical close serialization and initialization commit fencing. The
formal specification remains independent: passing TLC and these regressions
is not a full refinement proof. See the [runtime contract](../../../docs/architecture/platform/connection-recovery-contract.md)
for production stage observations, budgets and environmental limits.

## Deterministic implementation chaos

The [chaos simulator](../../../tests/protocol/fixtures/recovery-chaos.ts) drives the
actual connection owner, JSON-RPC client and Deferred transport against isolated
physical leases. It controls two Hosts sharing route availability, admission,
dial/initialize/response/close completion, frozen timer delivery, stale frames, cancelled
timers, manual blocks and disposal. It does not connect to a live service.

```sh
npm run test:recovery-chaos -- --seed 20261025 --cases 1000 --steps 160 --output /tmp/recovery-chaos
npm run test:recovery-chaos -- --replay /tmp/recovery-chaos/failure-minimal.json --output /tmp/replay
npm run test:recovery-chaos:unit
```

Every event checks current initialization authority, physical lease serialization,
local cancellation settlement, timer bounds, terminal disposal, manual blocking
and Host isolation. Each trace has a 300ms **virtual**, healthy suffix, with
25ms stages, 60ms attempts and 1/2/4/8ms backoff, to test recovery after faults stop.
These normalized test values are not production latency commitments. The hint
budget retains its actual 5s policy. Failures save the seed, explicit events and
a delta-reduced trace preserving the same violated rule (at most 100 shrink
trials). A reduced trace is not guaranteed globally shortest. Replay rejects
invalid event types, Hosts, boundaries and elapsed values.

`request`, `cancel-request`, `preparing` and `prepared` events drive real client
RPC handling with synthetic `turn/start` intents and context-compaction
notifications. The server applies each explicit intent on receipt, while
`hold response` delays its ACK independently. A network loss can therefore leave
an applied write with no received ACK. The oracle forbids a second send for that
intent, correlates replies and checks that a superseded timeout cannot reject a
request before its current deadline. The fault clock deliberately permits
retired callbacks; standard browser timers check cancellation themselves, so
this is adapter hardening rather than a reproduced browser race. Stale delivery requires its original
due time to have elapsed. Generated event counts and effective boundary coverage
are separate. Generator version 3 and source hashes accompany CLI artifacts;
explicit event traces remain replayable independently of generator changes.

Use `--mutant sticky-initialize` as a negative control: it retains the first client
operation, must exit nonzero and saves a replayable failure. Add that flag when
reproducing the mutant, omit it when verifying the fix against its trace. Coverage
includes effective held boundaries and physical opens, not just generated fault
requests. Normal recovery tests include a fixed seed corpus and shrink/replay
checks. Wider runs are explicit, reproducible and need no runtime dependency.
`--mutant replay-mutation` deliberately sends a user intent twice and must fail
with `NO_REPLAY`; replay its events without the flag to verify normal behavior.

This is finite fault sampling, not a refinement proof, a real phone or an actual
multiplexed socket implementation. Existing Web/AppHost tests exercise the real
shared-socket adapter. The send oracle admits initialization and explicitly
recorded synthetic writes. At-most-one send by this
client is not end-to-end exactly-once execution or safe retry of an uncertain write.

## RPC timer ownership

`RequestTimers.tla` separately models two request incarnations, extension and
shortening of a deadline, and an adversarial adapter delivering callbacks after cancellation.
Only due callbacks can run. The ordinary verifier also runs its positive
safety/liveness specification and three exact negative controls: stale timer,
stale request and missing fairness. The total suite has 60 configurations,
including the history and hydration checks below.
This small model is independent of `Recovery.tla` and is not a composition or
implementation refinement proof. The executable reduced regression holds an ACK,
starts context preparation, freezes past the original 30ms deadline and delivers
that retired timer; the earlier client rejects before the new 180s deadline under
this adversarial clock. It does not reproduce the phone's original slowdown.

## History work and observer reentry

`HistoryReentry.tla` independently explores two work identities at admission,
history-start, commit, invalidation and retry-decision boundaries. Observers can
remove, dispose, invalidate/replace, join or retry; a retained retry can predate
failure. Fair work completion is an environmental assumption. Six deliberate
mutants separately defer admission, read retired progress, commit through a
retired owner, clear successor reservations, lose retry intent or release a
successor during old cleanup. A seventh control removes fairness. These finite
transactions do not model full history payloads or prove composition with the
other two specifications.

The same CLI also runs a history suite against the actual scheduler:

```sh
npm run test:recovery-chaos -- --suite history --seed 20261026 --cases 1000 --steps 180 --output /tmp/history-chaos
npm run test:recovery-chaos -- --replay /tmp/history-chaos/failure-minimal.json --output /tmp/history-replay
npm run test:recovery-chaos -- --suite history --mutant lost-admission --seed 42
```

History artifacts carry their suite, generator version 1 and relevant source
hashes. Replay selects that suite automatically and rejects a conflicting
explicit selection. Old artifacts without a suite still select the Host suite.
`lost-admission` intentionally loses the returned local Promise and must fail;
omit the mutant when checking its reduced events against the normal owner.
Shrinking preserves the primary rule; secondary cleanup failures are recorded
without replacing it.

The history fixture has two resource keys, normalized 1/2/4/8ms retry delays,
controlled read completions and one-shot synchronous observer reactions. Its
healthy suffix completes reads and advances timers. It checks prompt local
settlement on cancellation, current read budgets, same-key coalescing, explicit
retry conservation, terminal disposal and eventual caller settlement. Physical
retired I/O is allowed to complete later and is counted separately; it cannot
claim current authority or release a successor's reservation. Effective observer
reactions and late replies with a live successor are recorded separately from
generated events. This suite does not exercise an actual Thread baseline or
server cancellation of a read.

## Remaining integration boundaries

| Boundary | Current executable evidence | Remaining coverage |
| --- | --- | --- |
| Host admission and initialization | Recovery model, real Web/AppHost regressions, Host/client/Deferred chaos | Full seeded chaos through the actual shared-socket adapter |
| RPC deadline replacement and uncertain writes | RequestTimers model, real client and synthetic ACK-loss oracle | Server execution deduplication / end-to-end exactly-once are outside this proof |
| History scheduling and reentry | HistoryReentry/DerivedHistory models; owner chaos; real Session derived cancellation regressions | Randomized derived strategy/observer faults beyond the targeted regressions |
| Thread baseline authority | Recovery/HydrationHandoff abstractions; seeded actual Workbench/Session/Replica baseline composition | Randomized notification/projection interleavings and provider-specific live data |
| Browser suspension | Installed full Web freeze/restart/draft smoke | Physical iPhone lifecycle and network behavior |

An accepted implementation increment does not close these broader audit items.

## Binding and Session hydration handoff

`HydrationHandoff.tla` checks two Threads and two logical revisions sharing a
client generation. Binding and Session gates are independent; a healthy current
request must progress without assuming an old reply ever arrives. Five exact
mutants retain either gate, accept a stale commit, clear successor slots or defer
local caller settlement. Removing current-work fairness is a sixth control.
There is no fairness requirement for old replies. The positive model has 169
distinct states. This is a finite independent ownership model, not a full
composition/refinement proof of the other specifications or TypeScript.

The new suite runs actual Workbench/Binding/Session/RPC/Replica composition:

```sh
npm run test:recovery-chaos -- --suite hydration --seed 20261026 --cases 1000 --steps 100 --output /tmp/hydration-chaos
npm run test:recovery-chaos -- --suite hydration --mutant sticky-read --seed 42 --output /tmp/hydration-mutant
npm run test:recovery-chaos -- --replay /tmp/hydration-mutant/failure-minimal.json --output /tmp/hydration-replay
```

Generator version 1 samples two Threads, acquisition/release, explicit retry,
logical reconnect and controlled replies. Its healthy suffix responds only to
new requests, asserts current baseline authority before releasing any held old
reply, then checks that late replies preserve it. The physical client generation,
initialization count and transport remain stable. Default reads perform no
execution writes; a separate regression covers legacy message-window Resume.
`sticky-read` deliberately removes initiating-signal retirement and memoizes an
old Session read; it must fail `HYDRATION_HANDOFF`. Replay without that mutant
checks the reduced input against the normal implementation. The suite records
source hashes, effective new-before-old and retired-reply counts. It does not
randomize all notification/projection actions or replace the actual shared-socket
adapter. Read/resume regressions also cover ignored cancellation, strategy late
success/failure, buffer isolation, abort reentry, joining-wait cancellation,
preflight cancellation and retirement of older/background history contexts.


## Derived history dependency order

`DerivedHistory.tla` models three operations alternating older/refresh kinds.
Admission reserves a per-kind slot before asynchronous preparation, and captures
only an existing predecessor. Same-kind work coalesces. The dependency must always
point to an earlier admission; recording it after an await can introduce a cycle.
Cancellation settles local callers and releases only their own slot. A retired
RPC/strategy may never reply, while fair current work can continue after its
predecessor settles. The next independently requested operation does not inherit
that predecessor's cancellation. Five controls introduce a future dependency,
silent local retirement, stale slot cleanup, inherited cancellation or missing
fairness. Each must fail at its named invariant/temporal property.

Real Session tests hold cooperative RPCs and deliberately uncooperative strategies,
then exercise baseline replacement, needs-resume, release, disposal, initiating
and joining signals, queued cancellation, same-source successors, late failures
and peer Thread isolation. The optional derived projection module is checked
outside the startup graph; a full built Web smoke opens a real conversation,
loads older history, preserves its draft and sends no execution writes. These
finite models and deterministic counterexamples do not extend existing seeded
chaos coverage to every notification, provider or physical device behavior.


## Elapsed and diagnostic clock domains

`ClockDomains.tla` independently checks one active fixed cap with wall-clock
jumps and elapsed advancement as separate actions. Its positive configuration
checks no extension, no early timeout and termination with fair elapsed progress
and due callback delivery. Three negative controls use wall time after a backward
jump, use wall time after a forward jump, or remove fairness. Each must violate
its exact named invariant/temporal property. The normalized cap is two ticks;
completed context preparation and its return to an ordinary shorter RPC timeout
are outside this fixed-cap abstraction. This is not a proof of physical OS sleep
behavior or TypeScript refinement.

Host generator version 3 adds signed `wall-jump` events while elapsed time and
native timer due times stay independent. The actual client receives both domains.
The oracle checks that an active preparation timer does not exceed its elapsed
cap (`RPC_DEADLINE_BOUND`), as well as the existing no-early-timeout rule. Effective
forward/backward jumps with live RPCs are counted separately. Use
`--mutant wall-clock-budget` as a negative control: it removes that separation and
must fail at the exact timer-bound rule; replay the saved explicit events without
the flag to verify the repair. History generation remains version 1; hydration
generator revisions are described below.
Existing seed values alone do not preserve an earlier generator's distribution;
the saved version, source hashes and explicit trace are the replay evidence.

Real default-clock regressions also hold a reread past its local quiet-cut cap,
probe expiry before timer delivery and synchronously admit a successor during
child abort. The healthy initial pagination and explicit-zero controls preserve
the existing allowance. These targeted Session regressions do not extend Host
chaos to every Session timer/notification interleaving.


## View demand and optional read residency

`ViewReadLease.tla` separates a pending View acquisition, admitted Views,
observers, optional history reads, cached baseline and execution commands. View
demand is reserved before publishing a binding to observers. The last View and
observer leaving revokes optional reads; a read cannot manufacture command demand
to pin itself. A pending replacement acquisition and peer View/observer protect
shared work. Cancelling a read preserves a cached baseline and execution owners;
ordinary cache eviction can still remove an unowned baseline.

The finite model checks five safety properties and acquisition progress with
fair binding publication and lease admission. Four exact mutants remove pending
acquisition protection, let a read pin itself, cancel a peer's read, or clear the
baseline during optional cancellation; the fifth control removes fairness.
Pending-acquisition failure, physical server effects and the full Runtime are
outside this independent abstraction. Real Runtime regressions hold old replies,
exercise zero-cache cold admission, concurrent/replacement Views, final observer
release and cancellation before module I/O. Session regressions hold all three
derived strategy kinds while retaining baseline authority. Existing seeded chaos
retains its advertised scope; this model does not prove implementation refinement.


## Execution activation and current presentation

`ActivationHistory.tla` starts with a valid read baseline and one user intent
waiting for execution activation. A logical reconnect can occur before the ACK
or after it while the old history strategy is pending. Current read completion
has weak fairness; the retired activation ACK, history strategy and cleanup do
not. Read recovery must therefore progress independently. A second positive
configuration adds fair activation/dispatch and requires the original intent to
be sent once. Still-current history work retains its fairness and must finish
before its command can dispatch; retirement does not erase that initial barrier.

Nine controls include two temporal gate mutants (ACK and retired strategy), stale
history commit, stale buffer cleanup, lost buffered request, premature dispatch,
write replay, cancelled original intent and absent current-read fairness. The
verifier checks the exact property and causal terminal state for both gate
mutants. There is one representative buffered request and one intent with a
second possible send to expose replay. This finite independent model does not
cover all metadata, permissions, failures or server execution deduplication.

The implementation contract separates metadata-only execution activation from
historical Resume. A command's activation uses the existing `excludeTurns` field;
it must preserve the read source and buffered projection. The final dispatch
still requires the current baseline after every preparation await. Legacy and
explicit historical Resume retain their combined history contract. Real Session
and Workbench held-ACK regressions and seeded composition must substantiate that
mapping; the normative specification alone is not TypeScript refinement.


## Snapshot history and buffered lifecycle

`SnapshotCut.tla` separates canonical persistence, an unsequenced start/delta
observation, read capture, reread and final release. Persistence may advance to
completion before an older start observation is released. The committed view
must not regress behind its captured snapshot. Snapshot notifications trigger
another canonical cut; settings and non-snapshot events are not in that set.
One admitted server request must survive supersession and be delivered once.
Four configurations check normal fair progress, the exact `CanonicalCut`
violation for delta-only invalidation, lost-request conservation, and progress
without scheduling fairness. This independent finite contract does not assert
notification completeness, stream sequence ordering or TypeScript refinement.

Hydration chaos generator v3 adds explicit `snapshot-overlap` events for item
start, turn start and Thread status on a current held Read. The real Workbench,
Session, client and replica must preserve canonical text, terminal frame state
and Thread status when authority is published. Coverage counts effective
injections, rather than merely requested faults. `--mutant delta-only` restores
the old invalidation boundary and must fail `SNAPSHOT_CUT`; the saved minimal
trace must replay normally without that flag. Existing explicit v1/v2 traces
remain accepted, while seed-only streams change with generator v3.

The real Session regression also covers item updates, buffered server requests,
settings and non-snapshot observations across rereads. Set
`OPENCRAFT_HISTORY_SNAPSHOT_OVERLAP=1` for the installed full-Web derived-history
smoke to inject the old empty start ahead of the complete answer. Its synthetic
physical endpoint does not stand in for a paid model or physical phone.


### Native execution channels

`ExecutionChannels.tla` adds a separate current contract for live settings, native
request handling/reply, Read cancellation, same-id replacement and retired handler
admission. Native fairness excludes ReadReply: a history server may remain held
forever while the native answer must progress. Eight configurations exercise the
positive contract, old history-gated admission, dropped settings/cancellation,
stale ACK, stale handler, successor cleanup and missing fairness. Older request
reservations in ActivationHistory/SnapshotCut do not prove this progress property.
This is an independent finite abstraction; actual Client/Session/Broker chaos and
Workbench regressions provide separate implementation evidence.

Run deterministic implementation chaos with `npm run test:recovery-chaos -- --suite
execution --seed 0 --cases 1000 --steps 120 --output /tmp/execution-chaos`. Controls
`--mutant buffer-native` and `--mutant buffer-settings` must fail with NATIVE_REQUEST
and LIVE_SETTINGS respectively. The ordinary replay command uses `--replay
/path/to/failure-minimal.json` and should pass after removing the injected control.
Artifacts include generator version, seed, original/minimal trace and relevant
source hashes. Deliberate controls require the same invariant during shrinking;
a harness failure is not a valid detected production regression.


Execution generator 3 strengthens the separate implementation evidence: typed id,
full human-answer correspondence and local native progress are distinct oracles.
New `wrong-native-answer`, `wrong-response-id` and `history-gated-response` controls
must fail NATIVE_CONTENT, NATIVE_RESPONSE_ID and NATIVE_PROGRESS respectively. The
wrong-id control preserves the textual value while switching numeric/string type.
Shrinking preserves the exact rule and normal replay must pass. Object key order
is not part of correspondence; answer-array order is. The cooperative memory
fixture drains event-loop turns instead of waiting forever for a broken native
answer; it does not establish a production latency bound. Existing finite models
are unchanged and their prior exact hashes retain their independent proof scope.


## Known-Turn stop ownership

`StopControl.tla` adds eight configurations (80 total). It keeps physical Host
identity, binding/permission admission, original target and an intent reservation
separate from historical reads and question delivery receipts. The positive model
has 1,088 distinct states; six mutants fail their exact safety/progress property
and the seventh removes native scheduling fairness. No history or prompt fairness
is assumed. This is an independent finite model with bounded physical churn, not
an implementation refinement proof or a native engine cancellation proof.

```sh
npm run test:recovery-chaos -- --suite stop --seed 0 --cases 1000 --steps 120 --output /tmp/stop-chaos
npm run test:recovery-chaos -- --suite stop --mutant history-gated-stop --seed 0 --output /tmp/stop-control
npm run test:recovery-chaos -- --replay /tmp/stop-control/failure-minimal.json --output /tmp/stop-replay
```

Stop generator version 1 drives the real Workbench/Session/Conversation/Client.
The controlled server can hold Reads and prompt receipts while native stops stay
fair. The oracle checks original input target, at-most-one frame per explicit
intent, final lifecycle admission, observed rejection/unknown result and local
settlement before unrelated held work is released. Other controls are
`prompt-gated-stop`, `retarget-stop` and `replay-stop`; each must fail at its exact
rule without a cleanup failure and replay normally after removing the flag.
Artifacts retain explicit traces, source/runtime identity and effective coverage.
This does not establish physical-phone behavior or all engines' target semantics.


## Shared native lane and Session projection subscriptions

`ProjectionNotifications.tla` adds eight configurations (94 total, including ResourceAvailability below). The positive
model has 29 distinct states. One native observation, two consumers, one optional
history buffer and two physical generations expose global gating, peer gating,
global replay, stale subscription/generation and lost projection. Read replies
have no fairness; current receipt has weak fairness. The seventh control removes
that fairness. This independent finite model is not TypeScript refinement or a
proof of arbitrary payload/observer/load behavior.

```sh
npm run test:recovery-chaos -- --suite projection --seed 0 --cases 1000 --steps 120 --output /tmp/projection-chaos
npm run test:recovery-chaos -- --suite projection --mutant global-buffer --seed 0 --output /tmp/projection-control
npm run test:recovery-chaos -- --replay /tmp/projection-control/failure-minimal.json --output /tmp/projection-replay
```

Projection generator version 1 drives real Workbench/Client and two independent
Session projectors on the same Client. Native input tokens/order, resource
availability, local restore settlement, per-Session projection and isolated
projector failure counts are checked before Read replies become fair. Only
Sessions completing their own Read are checked against that canonical snapshot.
The final suffix releases held history; cancellation may discard that consumer's
optional projection while native/peer delivery remains conserved. Source/runtime
identity, explicit traces and effective coverage accompany artifacts. Controls
`global-buffer`, `peer-buffer`, `native-replay`, `drop-projection` and
`missing-restore-wake` must fail at
their declared rule without cleanup failure and replay normally after removal.

The actual composition regressions additionally cover resource restoration, late
Read success, peer Thread isolation, raw/Cordis scoped continuation retirement
and generation, and Hook observations across a canonical reread. A full built-Web
smoke observes the archived state and explicit restoration before an old Read
reply, using an isolated synthetic native endpoint. No account or paid model is
needed; these checks do not establish physical-phone behavior.


`ResourceAvailability.tla` adds six configurations for one restore transaction
and fixed demanded/cached View cases. It checks that a captured ACK cannot
override a later native deletion, a demanded restored resource progresses without
the old Read, duplicate availability does not create a new epoch, and a cache
cannot manufacture Read demand. Four mutants violate native authority, wake
progress, idempotence or demand; a fifth removes action fairness. It does not
model later resource reincarnations, all demand interleavings or a TS refinement.
The projection chaos oracle also counts effective native-restoration Reads and
duplicate availability events; explicit requested reads and actual wire Read
requests are reported separately.
## Notification fanout audit

`NotificationFanout.tla` models one native notification with two consumers,
two registration incarnations per consumer, a transport-wide deferred gate,
one physical loss and optional reinitialization. Admission is a fixed finite
cut. Same-function replacement cannot inherit an old input, and old unsubscribe
tokens cannot remove a successor. Physical loss revokes immediately rather than
waiting for initialization generation to change. Seven safety controls and one
no-fairness control must fail their exact named property with a saved trace.

The positive graph has 2024 distinct states. Completion assumes finite callback
work and eventual invocation of continuations. This is separate from the
Session projection model and does not cover arbitrary callback programs,
preprocessing reentry, multiple simultaneous wire inputs, every observer bus,
or TypeScript refinement. Actual raw/Cordis tests and the real Client `fanout`
chaos suite exercise registration churn, global/scoped deferral, subscriber
failures and loss before the next initialization.

```
npm run test:recovery-chaos -- --suite fanout --seed 0 --cases 1000 --steps 120 --output /tmp/recovery-fanout
```

Native input count and consumer delivery count are reported separately. The
three test-only adapter mutations corrupt admission, unsubscribe targeting and
the guarded lost-connection continuation. They do not send fake extra native
inputs or run a substitute Client implementation. Each failure is reduced using
the same oracle and can be replayed without the mutation through the CLI.

## Non-authoritative observer admission

`ObserverAdmission.tla` models a finite cut for one emission, two consumers,
two registration incarnations per consumer and registry clearing. The positive
graph has 1763 distinct states; seven exact negative controls must fail their
named safety/liveness property. Completion assumes finite callback work.
Physical generation is deliberately absent: diagnostic and lifecycle consumers
must observe request failure after transport loss. Actual Client/Cordis tests
check that distinction, queued/started cancellation, exception isolation and
close ordering. Nested emissions and the complete TypeScript implementation are
not proved by this one-emission model.

The eighth CLI suite drives actual Client diagnostic/lifecycle emissions through
MemoryTransport, with two consumers per lane, registration churn, old tokens,
observer exceptions and synchronous self/peer/cancel/close reentry. An inert first
subscriber records the current admission cut before scripted observers; no
private registry state is inspected. Native diagnostic inputs, observer
emissions/deliveries and RPC intents/frames are counted separately. Three
test-only adapter corruptions cover admission, stale unsubscribe targeting and
dropping terminal observations. Ordinary replay removes these corruptions.

```
npm run test:recovery-chaos -- --suite observers --seed 0 --cases 1000 --steps 120 --output /tmp/recovery-observers
```


`HandlerRegistration.tla` distinguishes method-registration ownership from an
already-admitted response context. The positive model has 24 distinct states,
with one method, two registrations and one request; four exact controls reject
stale cleanup, registration-owned cancellation, retargeted completion and absent
handler fairness. Unlike observer deduplication, each handler registration call is
a replacement even for the same function. This model does not prove TypeScript,
interceptor scheduling or transport behavior.

The ninth CLI suite uses actual Client/MemoryTransport callbacks, native lifetime
signals and wire replies. Two stable callback functions, registration tokens,
held handler results, synchronous registration reentry, exceptions, withdrawal
and physical close are exercised against external admission/response owners.
No private handler registry is inspected. Three test-only adapter corruptions
cover stale cleanup, result retargeting and cancellation owned by registration.
A quiescent suffix probes the existing registration before installing a fresh one,
then resolves held results before the fresh-owner probe; the suffix does not
manufacture pending results crossing a registration change. Closed traces issue no
healthy native suffix.

```
npm run test:recovery-chaos -- --suite handlers --seed 0 --cases 1000 --steps 120 --output /tmp/recovery-handlers
npm run test:recovery-chaos -- --suite handlers --mutant stale-token --seed 0 --output /tmp/handler-control
npm run test:recovery-chaos -- --replay /tmp/handler-control/failure-minimal.json --output /tmp/handler-replay
```

Input events, callback entries, handler completions and native response frames are
separate counts. A completed handler for a withdrawn request is not a wire reply.
Seeds and selected source hashes identify the actual run; shrinking preserves the
exact rule and normal replay removes the test corruption. Existing execution and
fanout suites retain their separate history/connection/consumer scopes.


`TransportObservers.tla` distinguishes state snapshots, mandatory terminal
events and successor initialization admission. The positive graph has 2936 states:
one primary connection, three publication versions, one changing observer with
two incarnations, one persistent Client consumer, an optional held request and
one successor initialization. FIFO processing preserves cuts captured at enqueue.
Terminal invalidation survives a successor snapshot; a new Client slot is admitted
after the old publication drains. Finite callbacks, fair native open/processing and
fair successor initialization ACK are explicit assumptions. Twelve controls must
fail their exact properties, including terminal gating, early cleanup, early slot
allocation and missing initialization fairness. RPC timeout/history fairness is
not required for local failure delivery. This is not a TypeScript refinement or
an exhaustive model of initial samples, socket generations and all adapters.

The tenth CLI suite uses actual WebSocketTransport and a controlled socket, with
two consumers, independent public status/Promise observations and no private-map
inspection. Generator v2 adds terminal-callback successor-connect and peer changes.
Its oracle conserves terminal events, orders publications separately from requested
samples and retains enqueue cuts across reentry. Healing is an explicit saved event,
not an invisible suffix. Cleanup checks owned Promise settlement. Empty traces
allocate no connection. Physical inputs (including ignored late events and close
ACKs), intents, publications, deliveries and samples have separate counters. Every
suite records selected source hashes including its lockfile.

```
npm run test:recovery-chaos -- --suite transport --seed 0 --cases 1000 --steps 120 --output /tmp/transport-chaos
npm run test:recovery-chaos -- --suite transport --mutant orphan-connect --seed 0 --output /tmp/transport-control
npm run test:recovery-chaos -- --replay /tmp/transport-control/failure-minimal.json --output /tmp/transport-replay
```

Controls `orphan-connect`, `stale-token`, `stale-status` and `drop-peer` must fail
at their exact rule and replay normally without corruption. A dropped peer on local
close may fail with no socket allocation; it is a status-publication counterexample,
not a native RPC input. Separate actual Client/Memory/Cordis tests check held-RPC
loss, closing before ACK and successor initialization reentry. Five-adapter tests
also check initial samples, permanent cleanup and queued peer replacement.


`MemoryGenerations.tla` models one primary and one successor Memory connection,
one queued frame per origin, admission completion, retirement and per-peer cleanup.
Connect settlement is independent of uncooperative retired admission; cleanup is
conditional on admission settlement. Finite synchronous callback work is assumed. Only live admission and cleanup scheduling
have weak fairness, and open-close completion requires a cleanup ACK. Ten precise
controls remove admission/peer/queue/ACK guards, immediate cancellation, cleanup
ordering/uniqueness or those fairness assumptions. Terminal states permit
stuttering. This is an independent bounded model, not TypeScript refinement,
arbitrary generation coverage, callback-registration proof or a model of failed
cleanup ACKs. Concrete tests cover current and retired cleanup failures separately.

The eleventh chaos suite, memory, uses actual MemoryTransport with controlled
server admission/cleanup promises and queued native deliveries. Its intent/epoch
oracle has no private-map access. It distinguishes local cancellation from native
hook completion, old peer identity from global open state, and old close ACKs
from successor status. The generator saves explicit healing. Empty input allocates
no connection; final cleanup only retires existing work. Metrics count trace
native inputs/admissions/cleanup calls/deliveries, and connect settlement includes
final local cleanup. Selected hashes include source and lockfile.

```
npm run test:recovery-chaos -- --suite memory --seed 0 --cases 1000 --steps 120 --output /tmp/memory-chaos
npm run test:recovery-chaos -- --suite memory --mutant orphan-connect --seed 0 --output /tmp/memory-control
npm run test:recovery-chaos -- --replay /tmp/memory-control/failure-minimal.json --output /tmp/memory-replay
```

Controls orphan-connect, stale-peer and cleanup-retarget corrupt the test adapter's
promise observation or native callback binding. They must fail their precise rule,
shrink under that same rule and replay normally without corruption. They are
separate from reproducing the actual old implementation without a mutation.


`ClientRetirement.tla` separates local initialization admission from native activity
and idempotent retirement. Initial modes cover ready, preconnected without an
initial sample, and a native attempt revoked before the Client observer sees
connecting. It checks old request cleanup, initial/new activity revocation,
successor outcome and old completion. Positive: 76 distinct states. Nine controls
exercise repeated retirement, missing cleanup/re-arm/constructor snapshot/join
fence, stale catch, eager local admission and absent local/native fairness.
Terminal states allow stuttering. Provider generation fencing and publication
ordering are assumptions; finite scheduling, two activities and a cooperative new
response bound the progress claim. Concrete Client/Memory/WS tests additionally
cover real close ACK interleavings and snapshot recovery after missed loss.

The twelfth suite, retirement, composes actual Client and MemoryTransport with an
independent server epoch/intent oracle. It includes overlapping close/connect,
duplicate terminal samples, held requests, genuine new failure, old peer close,
cancellation and an explicit usable heal. Source and lock hashes bind results.

```
npm run test:recovery-chaos -- --suite retirement --seed 0 --cases 1000 --steps 120 --output /tmp/retirement-chaos
npm run test:recovery-chaos -- --suite retirement --mutant rearm-old-loss --seed 0 --output /tmp/retirement-control
npm run test:recovery-chaos -- --replay /tmp/retirement-control/failure-minimal.json --output /tmp/retirement-replay
```

Four adapter controls are rearm-old-loss, drop-current-loss, orphan-connect and
replay-request. Each must fail its exact rule, shrink under the same rule and
replay normally. They corrupt test delivery/observation/submission, not production
classes. Empty trace creates no native activity; cleanup creates no hidden probe.
Bounded microtask drains assume cooperative controlled callbacks, not arbitrary
network timing. Model and fuzz results do not establish TypeScript refinement.


RecordingLifetime separates native status subscriptions from recording tap
ownership. It covers old close ACK success/failure, reentrant successor taps,
captured old message retirement, initial sample provenance and sink/observer
continuations. Positive: 92 distinct states. Eight precise controls remove these
guards or local fairness. No old-close fairness is required for successor progress;
cooperative new work and finite synchronous callbacks remain assumptions.
Provider epochs/ordered native status and shared registration cuts are separate
contracts, not derived by this bounded model.

The thirteenth suite, recording, composes actual RecordingTransport + Client +
MemoryTransport. It compares status publication provenance, native frame records,
intent settlement, peer identity and one native submission; injects observer/sink
exceptions, stale tokens and reentry; and saves an explicit heal that initializes
and performs a usable RPC. Empty input performs no native connect. Final cleanup
only closes existing work and removes harness-owned registrations. Source/lock
hashes bind the CLI artifacts.

```
npm run test:recovery-chaos -- --suite recording --seed 0 --cases 1000 --steps 120 --output /tmp/recording-chaos
npm run test:recovery-chaos -- --suite recording --mutant retarget-cleanup --seed 0 --output /tmp/recording-control
npm run test:recovery-chaos -- --replay /tmp/recording-control/failure-minimal.json --output /tmp/recording-replay
```

Controls sample-echo, retarget-cleanup and orphan-rpc corrupt test observation,
adapter cleanup binding or Promise result observation, respectively. Each must
fail its exact rule, shrink under that rule and replay normally. They do not mutate
production classes or claim to defend an arbitrary lying provider. Separate
unchanged old-class runs establish real regression detection.


Replay has two independently checked ownership views. ReplayLifetime bounds an
old and successor native epoch over a four-position tape: current-frame authority,
cursor bounds, once-only reservation consumption, same-epoch matching, startup
retirement, old close completion and local-versus-native cancellation. Positive:
116 distinct states. Eleven controls remove those guards or current-clock/local
fairness. Retired clocks need not wake for local retirement or successor progress.

ReplayDrainAdmission bounds a finished empty drain and a new worker. Positive:
six states. Three controls exercise joining an already finished Promise, old
cleanup clearing new work, and absent worker fairness. The old completion need
not run for a newly admitted frame to have a worker. This closes a modeling gap
found by a real synchronous clock-failure/recovery test after the first model
passed. These bounded views do not establish their product, TypeScript refinement,
payload/ID semantics, clock-error handling or physical timer cancellation; actual
regressions and public Node timer-resource observations cover additional boundaries.

The fourteenth chaos suite, replay, runs actual ReplayTransport with a controlled
clock. Its independent oracle owns expected native epochs, tape positions,
reservations, frames and intent outcomes. Saved inputs include old/current clock
release/rejection, same-stack connect-send, startup and send cancellation, noisy
observers and message-time close. Heal explicitly connects and completes a matching
send/reply before releasing old held clocks. A compound event may contain multiple
API calls; connect/send intent and clock metrics remain separate from event count.
Empty trace creates no native work. Final cleanup only closes existing operations
and releases fixture clocks; cleanup has a distinct rule from trace failures.

```
npm run test:recovery-chaos -- --suite replay --seed 0 --cases 1000 --steps 120 --output /tmp/replay-chaos
npm run test:recovery-chaos -- --suite replay --mutant cursor-drift --seed 0 --output /tmp/replay-control
npm run test:recovery-chaos -- --replay /tmp/replay-control/failure-minimal.json --output /tmp/replay-replay
```

Controls orphan-connect, duplicate-frame and cursor-drift corrupt test observation
of a result, delivered frame or cursor. They must hit exact rules, shrink under
the same rule and normally replay. They do not mutate production or claim to
defend an arbitrary lying clock. Real old-class and retained candidate runs are
separate evidence, including separately retained teardown failures. Selected
source/lock hashes bind artifacts. Upper LCG bits select event families so a
single seed combines clock, cancellation and observer actions instead of retaining
a low-bit parity split.

NativeMessagePublication separates the native frame owner from the owner most
recently observed through queued status callbacks. It bounds one decoded frame,
two native owners and one peer registration replacement. Its 57 positive states
check decoded admission, each callback's native authority, a finite registration
cut, observer-versus-decoder failure classification and local completion after
decode. Seven controls include an observed-epoch fence: both status labels can
be open while observedOwner remains 1 and nativeOwner is already 2. That fence
must fail CurrentFrameOwner. Decoder completion itself has no fairness promise;
only the local work after a result is available is assumed cooperative.

HostTerminalPublication bounds one bridge retirement and two Host registries.
Its nine positive states check capture of all registries before callbacks,
exception isolation, terminal delivery after the bridge is closed and cleanup.
Four controls weaken exception isolation, use a late registry cut, gate terminal
on an already closed bridge, or remove local fairness. It does not model nested
FIFO publications, arbitrary port behavior or TypeScript refinement.

These are separate required contracts. Core implementations now compose native
captureMessageScope guards through forwarding wrappers; a queued observed epoch
cannot replace that authority. The capability is optional for legacy compatibility,
so an opaque provider without it still cannot prove invisible native open/open ABA
away. Actual tests add non-open Host states and grant/startup, nested FIFO, Blob
and real Client settlement boundaries outside these two finite models.

The fifteenth suite, message, uses an input-driven registration/order oracle with
explicit compound message actions and explicit fresh healing. It runs actual
Memory, raw WebSocket, Deferred, AppHost channel and exported browser AppHost
chains. Empty input creates no native work; cleanup only closes existing fixtures.
Frames, observations, opens, renewals and heals are counted separately from saved
events. Heal acquires a fresh fixture and proves native message delivery; actual
Client usable RPC progress is a separate concrete regression, not implied by
that synthetic delivery alone. Selected source/lock hashes bind CLI artifacts.

```
npm run test:recovery-chaos -- --suite message --seed 0 --cases 1000 --steps 120 --output /tmp/message-chaos
npm run test:recovery-chaos -- --suite message --mutant stale-observation --seed 0 --output /tmp/message-control
npm run test:recovery-chaos -- --replay /tmp/message-control/failure-minimal.json --output /tmp/message-replay
```

Three observation controls exercise dropped peers, stale delivery and hidden heal
settlement without changing production classes. They must fail exact rules,
shrink under the same rule and replay normally. Actual unchanged old-source runs
are separate evidence. The random suite does not cover arbitrary providers,
parent-terminal failure or queued status ABA by itself; deterministic actual
composition regressions remain required for those boundaries.

## Host native delivery lifetime

HostDeliveryLifetime separates a native per-claim grant from its observed open
label. Its 209 positive states cover own ACK, matching versus unrelated pre-ACK
terminal generations, local versus native retirement, old forwarding waits,
same-Host peer isolation and successor cleanup. Ten controls use observed
readiness, allow retired sends, wait for an old ACK, revoke a peer, retarget old
cleanup, retain a retired forwarding budget, grant on a shared open, revive a retired claim, or remove local/current
ACK fairness separately. Each must hit its named invariant or temporal property.
An old forwarding ACK is deliberately not fair; its cooperation is unnecessary
for retired local wait progress. Current own ACK and local Promise settlement
remain cooperative assumptions. One occupied forwarding control slot is explicitly freed on retirement before
successor admission. The model does not cover the complete multiplexed control
budget product, nested FIFO, arbitrary Port behavior or TypeScript refinement.

The sixteenth suite, host-delivery, runs actual MessagePortAppHostClient/channel
instances with a declared Port fixture. Saved events explicitly open, send,
withhold or acknowledge forwarding, lose or close a lease, admit a peer, reenter
from an early Host status callback, race a frame with native loss, retire the
bridge and freshly heal. An independent input ledger predicts each local wait,
send crossing and own-ACK settlement. Empty input performs no native work.
Fresh heal proves a new native claim and local forwarding completion, not remote
execution or RPC initialization. Three observation controls test exact-rule
detection and shrinking; they do not mutate production. Separate old-class runs
use this same oracle with the unchanged real class at fixture construction.

```
npm run test:recovery-chaos -- --suite host-delivery --seed 0 --cases 1000 --steps 120 --output /tmp/host-delivery-chaos
npm run test:recovery-chaos -- --suite host-delivery --mutant retained-wait --seed 0 --output /tmp/host-delivery-control
npm run test:recovery-chaos -- --replay /tmp/host-delivery-control/failure-minimal.json --output /tmp/host-delivery-replay
```

## Server native forwarding and queued admission

HostForwardingLifetime has 143 positive states. It distinguishes an old native
operation from the Server's local queue wait, native facts from delayed status
observations, old completion from successor settlement, and local retirement
from the physical close barrier. Eleven controls wait for an old ACK, gate loss
on observations, omit stop retirement, retarget old cleanup, reuse an aborted
owner, capture an old owner, bypass a physical barrier, cancel live FIFO work,
replay an old operation, or remove local/current-native fairness separately.
The old provider result is deliberately not fair. Fresh work still requires a
cooperative current native boundary and local work after an available result.

HostQueuedAdmission has 19 positive states. It captures native and claim identity
at incoming queue admission, then checks both again before physical forwarding.
Native close/open preserves the record generation in this abstraction. Six
controls admit on dequeue, trust an observed owner, check only record generation,
omit claim identity, drop valid work or remove local dequeue fairness. Queue
worker availability is a condition supplied by the first obligation, not an
assumption that an old native Promise eventually resolves. These two models do
not establish their complete product, arbitrary provider behavior or TypeScript
refinement; concrete tests cover the actual composition.

The seventeenth suite, forwarding, runs the actual AppHostServer, actual
MessagePortAppHostClient/channel and actual JsonRpcAppServerClient through only
declared Port and physical-adapter fixtures. A saved-input ledger predicts held
and queued frame admissions, local outcomes, initialization generations and
physical factory counts. Events explicitly hold/settle native operations, retire
native epochs, report late old results, renew the same page, test a fresh page,
hold/release a reset close barrier, reenter during a provider call and freshly
heal. Live FIFO may wait for its saved dependency; input-retired work cannot
excuse a production initialization stall. A heal proves actual initialization
and an echo RPC, not merely an open label or remote execution. Empty input makes
no native work. Cleanup and dependency releases are not counted as saved progress.
Three observation controls exercise exact-rule detection and shrinking without
mutating production. Separate unchanged-old-Server runs use the same oracle.

```
npm run test:recovery-chaos -- --suite forwarding --seed 0 --cases 1000 --steps 120 --output /tmp/forwarding-chaos
npm run test:recovery-chaos -- --suite forwarding --mutant queued-replay --seed 0 --output /tmp/forwarding-control
npm run test:recovery-chaos -- --replay /tmp/forwarding-control/failure-minimal.json --output /tmp/forwarding-replay
```

## Remote Host claim handoff and unknown grants

HostClaimHandoff has 22 positive states without a peer and 18 with a peer. Its
known reservation survives local delivery retirement until a fresh reservation
protects replacement. Ten negative controls isolate forgetting the old claim,
release before reservation, unordered control delivery, waiting for an obsolete
release ACK, lease ID reuse, retargeted old cleanup, peer deletion, release behind
writable FIFO, and missing local or Server fairness.

HostClaimGrant has 36 positive states. Eleven negative controls cover forgotten
unknown reservations, disposal before an own grant, dependence on a stale Promise
continuation, duplicate/reentrant release, generation-only cleanup, premature
release, granting from shared open, and missing grant/local/Server cooperation.
The missing-grant case deliberately refutes unconditional reclamation: with the
existing protocol, local cancellation does not reveal an unknown generation.
The positive guarantee is reclamation after the own grant arrives. Existing
bounded late-grant policy remains a separate implementation obligation.

Together these add 24 configurations. They describe finite protocol obligations,
not TypeScript refinement or failed physical close recovery. The eighteenth
suite, `claims`, runs the actual Server, bridge, channels and RPC Clients and
checks an input-owned reservation/FIFO/physical-lifetime ledger. It includes
same-record renewal, unique old releases, current cleanup outside ordinary
backpressure, same-page peers, other pages, native cycles, late forwarding
results and withheld release responses. Unknown startup grants are additionally
covered by actual component tests and HostClaimGrant; this suite does not claim
that entire combined state space.

```sh
npm run test:recovery-chaos -- --suite claims --seed 0 --cases 1000 --steps 120 --output /tmp/claim-chaos
npm run test:recovery-chaos -- --suite claims --mutant leak-old --seed 0 --output /tmp/claim-control
npm run test:recovery-chaos -- --replay /tmp/claim-control/failure-minimal.json --output /tmp/claim-replay
```

The three tool controls are `leak-old`, `retarget-peer`, and `wait-cleanup-ack`.
They corrupt observations solely to exercise detection and same-rule shrinking.
Separate tests inject unchanged old Server and Client constructors at the declared
fixture dependency and replay the minimized failures normally on the repaired
implementation; they do not mutate prototypes, private ledgers, or production
source. A successful local release is not a claim about remote Turn completion.


## Physical cleanup outcomes and admission after reset

HostPhysicalCleanup adds 13 configurations: normal/startup/shutdown positives
have 76/76/24 states; ten exact negative controls expose lost handles, false
shutdown success, late owner publication, timeout/label release, retry through a
new factory, stale cleanup retargeting and missing local/provider fairness.
A rejected close does not prove resource release. The owner remains until an
explicit retry of that same handle succeeds. No provider fairness deliberately
refutes unconditional close progress.

HostCleanupAdmission adds seven configurations. Its 19-state positive separates
a revoked pre-reset waiter from a fresh replacement intent. Six exact negatives
cover revoked admission, bypassing the physical barrier, retargeting the current
owner, waiting for an old waiter and missing local/current-intent fairness.
Together these bring the registry to 262 configurations. Current service-demand
validation around deferred factory entry is additionally covered by real component
tests; this finite reset model is not a full product of every admission source.

The nineteenth suite, `cleanup`, runs actual AppHostServer,
MessagePortAppHostClient/channels and initialized JsonRpcAppServerClient against
declared provider faults. Saved events select normal retirement, startup rollback
or shutdown; close can succeed, reject before/after release, throw synchronously
or wait on an explicit gate. Subscription failures, failing detachers, old status
callbacks, reset, ordinary reconnect and explicit repair/retry are inputs. A
separate resource ledger predicts factory/close/disposer counts, retained ownership,
physical exclusivity and caller outcomes. Healing is a saved event with an actual
initialize/echo when the Server remains open; shutdown healing proves resource
cleanup without inventing RPC readiness. Teardown is outside the assertions.

```sh
npm run test:recovery-chaos -- --suite cleanup --seed 20261027 --cases 1000 --steps 120 --output /tmp/cleanup-chaos
npm run test:recovery-chaos -- --suite cleanup --mutant orphan-handle --seed 0 --output /tmp/cleanup-control
npm run test:recovery-chaos -- --replay /tmp/cleanup-chaos/failure-minimal.json --output /tmp/cleanup-replay
```

Tool controls `orphan-handle`, `false-shutdown` and `bypass-barrier` corrupt
observations to check exact-rule detection and shrinking. Separate unchanged-old
Server runs supply production counterexamples; they do not alter private fields,
prototypes or production sources. Held-startup cancellation and service authority
revocation have component regressions, not a claim of exhaustive randomized
coverage. Resources hidden by a rejecting factory, dishonest successful release
and provider progress without cooperation remain outside the guarantee.


## Logical disconnect notification retirement

HostLogicalRetirement adds 15 configurations: four positive cases cover normal,
service-owned and peer-owned physical lifetimes plus physical-start progress
without a notification clock. Eleven negative controls isolate waiting for a
notification before physical cleanup, late owner publication, treating timeout
as physical release, duplicate unknown writes, admission despite failed cleanup,
stale completion retargeting, closing a peer/service Host, and missing clock,
local or physical cooperation. Positive distinct-state counts are 156/54/54/156.
They are finite obligations, not a refinement proof or remote execution semantics.

The twentieth suite, `notifications`, checks one saved logical retirement
transaction and explicit recovery through actual AppHostServer,
MessagePortAppHostClient/channels and initialized JsonRpcAppServerClient. An
input-owned ledger predicts notification attempts, local close/control results,
physical calls and released resources, admission failures, peer echo and fresh
healing. Provider writes can succeed, reject, throw or stay pending despite abort;
physical close outcomes are independent. Late notification results, local
deadlines, detach, provider repair, admission probes and actual physical release
are saved events. Teardown is outside the assertions. Saved `heal` may explicitly
reset a failed owner; it does not invent implicit provider progress.

```sh
npm run test:recovery-chaos -- --suite notifications --seed 20261027 --cases 1000 --steps 120 --output /tmp/notification-chaos
npm run test:recovery-chaos -- --suite notifications --mutant duplicate-notice --seed 0 --output /tmp/notification-control
npm run test:recovery-chaos -- --replay /tmp/notification-chaos/failure-minimal.json --output /tmp/notification-replay
```

The synthetic controls `wait-notice`, `duplicate-notice` and `admit-failed` test
exact-rule detection and shrinking; they are separate from unchanged-old-class
counterexamples. Component regressions cover synchronous reentry, multiple
failed owners and stale physical results. This random suite does not claim the
entire repeated-transaction/multi-Host product, a bound on uncooperative foreign
provider memory, remote handler acknowledgement, or physical phone validation.


HostLogicalNativeRecovery adds seven configurations (registry total 284). Its
positive success/failure cases have 6/4 distinct states. Five negative controls
isolate a logical fence masking native recovery, trusting the closed label as
release, stale logical cleanup retargeting, and missing local/physical fairness.
The abstraction starts with a failed logical cleanup and a non-open native record;
new native availability is abstracted by replacement, with its detailed admission
and observer deadlines covered by the existing models and real component tests.

Notification generator version 2 includes `native-loss` and `recover`, plus
ordinary admission after native loss. Its ledger distinguishes the old caller's
already-final result from later recovery and physical failure. Physical reject,
held cleanup, observer expiry, late release and explicit repair are exercised
without treating a status label or deadline as resource release. The fourth tool
control `block-native-recovery` checks the new composition under its exact rule.
A separate unchanged-first-candidate comparison exposes the implementation ordering
gap that passed the original suite, then replays on the corrected implementation.


### Host-scoped identity and repeated cross-Host chaos

`HostScopedIdentity.tla` has twelve configurations: shared, distinct and opaque
identity layouts, a failed-write positive case, and eight exact controls for
registration overwrite, wrong native notification, wrong failure fence, dropped
current response, lost detach cleanup, peer forgetting and missing local/provider
fairness. The positive finite state spaces each contain 36 distinct states.
The model uses proper tuples; escaped runtime-ID encoding is covered by actual
protocol tests, not inferred as a TypeScript refinement theorem.

`tests/protocol/host-scoped-identity.test.ts` uses actual Server/bridge public APIs
for two native providers. Both clients initialize and echo before a claim or
Renderer retires. A declared native disconnect revokes only its own initialized
client, so misrouting is observable both as an incorrect notification target and
as lost peer RPC. Trusted alias coverage is a separate composition-port test; it
is not described as a normal remote wire input.

The `scopes` generator repeats rounds on one Server across two Hosts and new
Renderer incarnations. Its one fresh grant per Host per round includes equal or
distinct lease names, opaque delimiter collisions, success/reject/hold, deadlines,
late results, detach, failure-fence challenges and explicit repair/reset. This
is a bounded combination with real native initialize/echo, not the full product
of arbitrary numbers of Hosts, grants and uncooperative providers.

```bash
npm run test:recovery-chaos -- --suite scopes --seed 20261027 --cases 1000 --steps 120 --output /tmp/host-scope-chaos
npm run test:recovery-chaos -- --replay /tmp/host-scope-chaos/failure-minimal.json --output /tmp/host-scope-replay
```

Synthetic observation controls `notify-peer`, `drop-reply` and `leak-native` test
detection, exact-rule shrinking and normal replay without mutating production
classes, prototypes or private fields. Actual-old-constructor comparisons are
recorded separately from these synthetic controls.

## Shared human answer attempts

`InteractionReplyOwner.tla` separates stable Entry identity from answer attempt
identity. Twelve bounded configurations cover pending/ responding producer replay,
successful and failed writers, validation reentry and Entry replacement. Controls
require the exact invariant failure for Entry-only or text-only late-result guards,
duplicate admission, publication after retirement and swallowed caller errors.
Validation and writer progress have separate weak-fairness assumptions and separate
missing-fairness temporal counterexamples. The model bounds two attempts and one
producer replay/replacement; it does not prove delivery, network fairness or remote
native execution acknowledgement.

The `replies` chaos suite executes the real `HostInteractions` public API against
an independent saved-input ledger. It varies producer state/route/object replay,
submission ID/payload, validation reentry/rejection/replacement, oldest/newest
writer success/failure, native resolution and clear across repeated lifetimes.
Checks include shared state, revision and subscriber counts, exact native write
routes/counts, caller outcome and original error identity. Same-text and same-object
replay prevent guards based on textual submission or source identity from passing.

```bash
npm run test:recovery-chaos -- --suite replies --seed 20261027 --cases 1000 --steps 120 --output /tmp/interaction-reply-chaos
```

Synthetic observation controls `late-state`, `duplicate-write` and `drop-error`
verify exact-rule shrinking and normal replay. Actual unchanged old/new constructor
comparisons use the same oracle separately; neither mutates a prototype or private
SUT state. The extended shared-interaction browser smoke uses real WebSocket,
Broker and cards at mobile/desktop widths to distinguish an old caller's failure
from the current shared answer state. It does not exercise a real user's account.

`InteractionSourceAdmission.tla` adds fifteen bounded configurations for the
availability/admission product: fingerprint and validation revocation, another
Thread's revocation, an admitted peer and authoritative producer replay. Positive configurations include
all three external boundaries crossed with both revocation targets. Seven
safety controls require exact failures for empty claims, wrong error classification,
global revocation, validation after fingerprint revocation, missing replay authority
and replay that improperly reopens an admitted peer. Two temporal controls remove
local or producer fairness. Caller rejection needs local continuation; a new native
answer after revocation additionally needs an actual producer replay. The model
does not promise automatic source recovery, writer completion or native ACK.

The `replies` generator v2 saves source-unavailable events, fingerprint/validation
revocation, peer-then-revoke and revoke-then-producer-restore callbacks. Its ledger
predicts source availability independently of response state, including exact
publication counts and caller error classification. The `empty-claim` observation
control shrinks separately from real old-constructor comparisons. Prior v1 traces
remain replayable; generated events are capped at the parser's 10000-event limit
so maximum-size failure artifacts can be loaded by the normal replay command.

`PortCleanup.tla` separates logical retirement from successful external Port
remove/close. Six positive configurations cover Client, connection, global shutdown,
peer, service and healthy cases. Seven exact safety controls exercise local-wait
stranding, short-circuit disposal, lost failed handles, repeated successful disposal,
swallowed errors, peer closure and late admission. Three temporal controls withhold
native retirement, local continuation or provider recovery. The sixteen configs do
not prove constructor transactions, TypeScript refinement or unconditional release
of a permanently failing provider; real component tests cover startup reentry and
combined native/Port failures.

```bash
npm run test:recovery-chaos -- --suite ports --seed 20261027 --cases 1000 --steps 120 --output /tmp/port-cleanup-chaos
```

The `ports` ledger drives real public constructors/Port callbacks and shutdown,
checking captured local waits, once-only terminal publication, native/peer lifetime
and per-handle retry counts. `orphan-wait`, `orphan-native`, `forget-handle` and
`duplicate-terminal` are observation controls with exact-rule shrinking and normal
replay. Separate old/new comparisons inject immutable real constructors without
changing prototypes, private state or SUT source. Generated saved inputs remain
within the parser's 10000-event limit.

`SocketDisposal.tla` adds nineteen finite configurations for layered WebSocket
cleanup: seven positive paths (including failure after a side effect, shutdown and
renewal reentry, and an accepted request with a held close event), nine exact
safety controls and three missing-fairness counterexamples. Adapter-reported
acceptance, actual raw close return, parent custody, local retirement and one
possible successor are separate facts. An accepted close permits renewal without
TCP-close fairness; eventual successful cleanup additionally assumes provider
recovery and an explicit retry. This is not a constructor-transaction, TypeScript
refinement, remote execution ACK or arbitrary failing-provider heap proof.

```bash
npm run test:recovery-chaos -- --suite sockets --seed 20261027 --cases 1000 --steps 120 --output /tmp/socket-disposal-chaos
```

The `sockets` ledger drives the actual public WebSocket factory/transport with
raw-Socket and recovery-event providers. Saved inputs vary close failure before
or after effects, accepted-but-held close events, native loss, two Host intents,
send, late frames, factory shutdown and reentrant cleanup. First successful
provider call counts are immutable observations, rather than a baseline reset by
later calls. `forget-debt`, `admit-before-close`, `drop-local-close` and
`repeat-close` are exact-rule shrinking controls; ordinary replay omits the control.
Unchanged old/new factories run against the same independent oracle separately.
Generated artifacts remain within the parser's 10000-event limit.
