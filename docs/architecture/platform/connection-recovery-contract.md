# Connection recovery: proposed transition contract

Status: executable design and counterexample tests; **not implemented in the
production connection owner**. Existing timeout, retry and readiness behavior
remains as described in [connections and routing](connections-and-routing.md).
This contract makes the recovery decision reviewable before runtime changes.

The subsequent [finite TLA+ model and verifier](../../../packages/workbench-runtime/spec/README.md)
cover two Hosts, one shared socket, two connection epochs and one Thread baseline.
Safety and conditional liveness are checked separately, including deliberate
negative controls and an explicit reachability witness. This adds formal evidence
for the target contract; production recovery remains unchanged.

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
`dial -> bridge -> admission -> initialize`. Repeated lifecycle events,
unrelated traffic and repeated reports of the same stage cannot renew deadlines.
Production integration must select real observations at these boundaries;
the test model does not manufacture network or Host readiness.

## State transitions

| State / input | Guard | Required decision |
| --- | --- | --- |
| idle / demand to connect | physical admission permitted | Start one attempt with an absolute deadline. |
| attempting / foreground or online hint | stage and total budgets remain valid | Keep the attempt; retain a coalesced wake signal. Do not start a second dial. |
| attempting / meaningful progress | current identity; neither deadline elapsed | Advance stage and stage progress time; retain the original total deadline. |
| attempting / hint, tick or expiry | stage idle budget or total budget elapsed | Revoke local ownership; evaluate the retained signal and admission constraints for a successor. |
| attempting / retryable failure | current identity | Revoke ownership, advance retry history; consume an eligible retained signal for one timely validation. Otherwise wait for the next eligible admission. |
| backoff / hint | visible demand, validation budget available, server restriction and physical barrier permit | Start one validation without clearing retry escalation. |
| backoff / repeated hints | validation or server budget unavailable | Coalesce the signal; an eventual budget tick re-evaluates it. Do not spin. |
| attempting / successful initialization | current identity and both deadlines valid | Commit Host readiness, consume earlier weak hints, schedule separate Thread catch-up. |
| usable / foreground hint | validation budget available | Probe the route; never infer Thread authority from the probe. |
| usable / current authoritative Thread baseline | baseline belongs to the current generation | Grant that baseline's authority. Cached paint and probes cannot do so. |
| any live state / manual rejection | current identity | Revoke authority and remain blocked across automatic hints. Explicit retry may re-evaluate admission. |
| any / old completion, failure or timeout | retired identity | Cannot commit or revoke current ownership. Wall-clock expiry of the current attempt is still independently enforced. |
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

## Executable evidence and current gaps

The independent [test specification](../../../tests/protocol/fixtures/recovery-specification.ts)
uses normalized logical budgets (stage 10, total 25, validation 5). They express
ordering and expiry, **not proposed production timeout values**. Exact production
stage thresholds and progress callbacks remain implementation work. The model
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

The first three assertions and the two additional Web transport assertions execute as TODOs so the normal suite can carry
known gaps without describing them as successes. A strict run makes the same
assertions fail normally:

```bash
npm run test:recovery-contract
OPENCRAFT_RECOVERY_CONTRACT_STRICT=1 npm run test:recovery-contract
OPENCRAFT_RECOVERY_CONTRACT_STRICT=1 node --import tsx --test tests/protocol/websocket-app-host.test.ts
```

The normal suite also verifies the already-working immediate wake during backoff
and preservation of failure escalation. A TODO that unexpectedly passes must be
reviewed and promoted to a normal assertion; it is not automatic closure. No
model check here claims to reproduce a particular user's phone incident.
