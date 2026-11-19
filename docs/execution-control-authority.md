# Execution control is not credential custody

## Independent facts and owners

| Fact | Authority | Must not be inferred from |
| --- | --- | --- |
| Caller may participate/control Thread | existing ingress, Actor/ThreadAccess and current logical lease | a native PID, ENV cache or display author |
| Native Turn exists and accepts exact-target input | native read + atomic `expectedTurnId` admission | latest sender or cached Gateway `activeTurns` |
| Original input/executor provenance | immutable admitted submission and execution lease | a viewer, Goal editor, steer author or last known human |
| Personal ENV currently installed | acknowledged configuration snapshot | Thread creation metadata or presence of a durable lease |
| Payer/budget authority | exact durable model-gateway execution, current sponsor checks | the person steering or cached ENV |
| Goal intent/version/accounting | native Goal store | a second Gateway Goal database or matching text |

The operation-effects classifier is the single policy vocabulary:
`none`, `admit-input`, `queued-intent`, `thread-control`, `active-turn-input`,
`configured-execution`. Unknown execution methods stay conservative.
It does not grant ingress/Thread access and is not itself authentication.

## Input control

Trusted Headless composition explicitly delegates shared native Turn input.
Restricted compositions retain owner-only input/billing behavior. No Renderer
parameter can enable this delegation. Presence of an ENV provider or an entry in
its configuration cache is not the delegation policy.

Shared direct/queued steering verifies native active state using one bounded
read-only summary (no Resume, Subscribe, tools, ENV install or callback claim).
After asynchronous attachment/context work, queued steering verifies again and
rechecks caller/lease before admission. The native `expectedTurnId` transaction
remains the final race fence. A stale target is never replaced with another Turn;
existing native rejection/custody reconciliation remains authoritative.
A read failure or non-active native execution produces structured
`EXECUTION_CONTROL_UNAVAILABLE`, known non-submission and no account-mismatch
claim. Existing queued input remains in custody, not silently retried as a new
execution. A lost native write acknowledgement remains unknown as before.

Shared steering retains the exact model-gateway execution and checks its current
sponsor/budget both before admission and at the physical-send fence. ENV cache
loss does not revoke that sponsor, and a successor execution cannot inherit the
pending control. The steer author remains an input author, not the executor.

## Goal and queue intent

Goal set/pause/resume/clear are authorized native intent mutations, NOT read-only
operations. Activating a Goal can continue native work using its existing native
configuration; shared control intentionally permits influence over that work,
as shared steering does. It does not install the editor's ENV, acquire their
credentials or transfer payer/executor attribution. Native Goal identity,
conditional versions (when supported), accounting, acknowledgement and unknown
outcome reconciliation are preserved. No implicit clear/set replacement or replay.

Automatic native Goal continuations with unknown provenance stay unknown. This
change does NOT invent human provenance, add a native continuation credential
contract, or permit personal tools to borrow the last human's credentials.
Pause/edit of a Goal does not require a human-owned running Turn to exist.

Ordinary queue edits change intent/custody, not the originally admitted input
principal. Queue start/new Turn admission still prepares that principal's ENV.
Actor-owned immutable inputs and ambiguous/delivered claims keep their existing
fences. Shell/settings/review remain configured-execution operations; uncertainty
about installed ENV does not authorize them even for a participating viewer.

## Recovery and validation

Gateway configuration/active-Turn caches are projections. Their absence can
coexist with a live independent native Turn and a durable original submission.
Do not rebuild custody from an ENV cache or refill ENV from the reconnecting
viewer. Recover provenance through the existing lease/native reconciliation; do
not use an unknown automatic continuation as evidence of a human identity.

Regression fixtures exercise actual Codex adapter routing/queue/state, synthetic
native RPC and authenticated principals: cache eviction, lease reconciliation,
shared direct/queued input, exact target rejection, sponsor retention/successor
fence, idle/active/unattributed Goal control, anonymous rejection, failure to
confirm native state, failed ENV handoffs and direct-shell refusal. These are
not physical-device, employee-account or production-Goal mutation tests. Native
CAS/receipt limitations remain as documented in the Goal contract.
