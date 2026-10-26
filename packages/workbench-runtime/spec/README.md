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
