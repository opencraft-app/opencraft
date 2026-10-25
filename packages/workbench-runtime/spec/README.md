# Recovery model checking

This is an independent finite TLA+ specification, not production code or an
implementation refinement proof. The target contract is documented in
[connection recovery](../../../docs/architecture/platform/connection-recovery-contract.md).

## Scope and assumptions

The state space contains two Hosts (`a`, `b`), one shared socket, two connection
epochs, one representative Thread baseline, and one already accepted command.
It models one outage and a stable successor. Failed physical dials before that
successor are abstracted into the socket-open action; arbitrary repeated outages,
unbounded attempt counts and continuous-time latency are outside this model.
Old logical admission may never finish. Actual physical startup/close barriers
are separate and must eventually settle for conditional recovery to apply.

`SafetySpec` makes no fairness assumptions. `FairSpec` adds weak fairness for
network recovery, physical barrier release, socket completion, timeout/retirement,
current admission and Thread catch-up. Permanent manual rejection or disposal
removes that Host from the conditional progress obligation. The clock is a finite
old-attempt expiry abstraction; precise stage/total/validation budgets remain in
the earlier executable specification. Duplicate hints are represented by one
coalesced signal per Host. This model does not prove real retry-rate bounds.

Safety includes current-epoch authority, at most one lease per Host, preserved
wake signals, manual blocking, baseline authority, no duplicate command, physical
barrier admission and Host isolation. Conditional liveness requires eventual
current Host leases and the current Thread baseline. A final stuttering trace
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

Two positive configurations check safety alone and safety plus temporal
properties. Six mutants must fail at the exact invariant or temporal property:
dropping hints, retaining old logical gates, accepting old grants, cross-Host
revocation, replaying a command, and bypassing a physical barrier. A deliberately
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
`RECOVERY-GAP-04` (abort cannot settle while `beforeConnect` is pending) and
`RECOVERY-GAP-05` (a successor joins the same revoked `connectOperation`). These
execute as TODOs; strict mode makes them fail normally. A separate actual shared
socket test confirms that one Host's failure and late old-lease frames do not
revoke a healthy peer or the recovered lease.

```sh
npm run test:recovery
OPENCRAFT_RECOVERY_CONTRACT_STRICT=1 node --import tsx --test tests/protocol/websocket-app-host.test.ts
```

The reduced admission/abort/successor sequence is a causal reduction of the TLC
old-gate counterexample, not a claim that TLC proved a globally shortest trace.
The new gaps are not repaired by adding these tests. Model assumptions, exact
source and actual multi-layer behavior must all be checked again during repair.
