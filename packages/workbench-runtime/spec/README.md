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
are separate. Generator version 2 and source hashes accompany CLI artifacts;
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
stale request and missing fairness. The total suite has 26 configurations,
including the history checks below.
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
| History scheduling and reentry | HistoryReentry model, actual owner chaos, real Runtime subscriber regression | Underlying read cancellation and pending hydration handoff |
| Thread baseline authority | Independent Recovery baseline abstraction and Runtime/Replica regressions | Seeded chaos through complete baseline/notification/projection composition |
| Browser suspension | Installed full Web freeze/restart/draft smoke | Physical iPhone lifecycle and network behavior |

An accepted implementation increment does not close these broader audit items.
