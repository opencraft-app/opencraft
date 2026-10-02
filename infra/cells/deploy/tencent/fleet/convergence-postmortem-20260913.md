# Fleet convergence postmortem — 2026-09-13

## Conclusion

The fleet did not repeatedly fail on one unstable subsystem. The rebuild was
using one word, "ready", for four different states:

1. Terraform resources exist.
2. Kubernetes workloads are healthy.
3. a Cell is qualified for new placement on one exact Runtime release.
4. the public product path is available and returns stable request-level
   errors when no Cell is admitted.

Later gates began checking all four and exposed ownership and lifecycle gaps
that earlier component checks could not see. Treating every newly exposed gap
as another bootstrap exception made the system appear unable to converge.

## Root causes

### Multiple writers for release-owned state

Bootstrap, Registry binding, the admission installer, and Runtime release
could all mutate the same static workloads. A valid release ledger therefore
drifted after a later helper ran. The supported order is now one-way:

```text
Terraform -> Argo platform -> bootstrap install -> Registry bind
          -> first Runtime release -> qualification -> activation
```

Once a release ledger exists, standalone Registry/admission mutation fails
closed. Runtime release is the only writer of its static objects; controllers
write only dynamic status and qualification writes only immutable evidence.

### Evidence was correct but its scope was misunderstood

Bottomless, DR, Engine HA, autoscaling, and Agent-arrival receipts bind an
exact Runtime release. Releasing a new Runtime intentionally invalidates old
qualification evidence. A successful receipt from release N and a failure on
release N+1 cannot be combined into one production claim.

This is why the current Cells remain `Qualifying` after the Runtime changes
even though B's strict 100 Agent/s exercise passed. Requalification is a real
remaining gate, not configuration drift to bypass.

### Hub readiness incorrectly depended on fleet-wide capacity

Workers API `/readyz` checked every Engine and the placement resolver. Closing
both Cells to new placement consequently made all three healthy, stateless Hub
replicas unready. The corrected invariant is:

```text
process readiness = facade + authoritative Worker Registry
placement/Cell health = request-scoped result
```

With no admitted Cell, `/readyz` remains 200 and new Object creation returns
retryable `no_admission_capacity`. An Object pinned to an unavailable Cell
returns a request-scoped availability error; another Cell is not withdrawn.

### Initial adoption and later release were one circular workflow

The original GitOps handoff required a candidate image to pass live public
admission before Argo could deploy it. That is possible only during first
imperative adoption, not during later releases. Later releases now bind:

- the exact prior Argo convergence receipt and Workers API revision;
- the current live Deployment, private Service, and external Secret UIDs;
- an immutable, tested product image and rendered manifest;
- a CAS publication against the current global management Git HEAD.

The global repository HEAD and the prior Workers API Application revision are
different identities. Publication now discovers the former by default and
Git push supplies the concurrency CAS; the installer separately verifies the
latter before advancing the Application.

### Deployment policy ignored finite topology

C has three control nodes and Workers API uses required hostname
anti-affinity. `maxUnavailable: 0` plus `maxSurge: 1` requires a fourth node and
cannot roll. The valid three-node policy is `maxUnavailable: 1`,
`maxSurge: 1`, with a PDB requiring two replicas. This failure was rolled back
through the bootstrap-owned Application and the corrected desired state was
then published through Argo.

### Internal and public error contracts were tested separately

The placement resolver returned `no_admission_capacity`, but the public error
allowlist did not preserve that code and collapsed it into
`upstream_unavailable`. The outer contract now has an explicit regression
test for `no_admission_capacity`, `placement_unavailable`, and
`worker_unavailable`.

### Tool versions were implicit

The management builder had an old `/usr/bin/python3` while the reviewed tools
use Python 3.11 syntax. Workers API Git publication and installation now pin
and validate Python 3.11 instead of inheriting the host default.

### Qualification producer and autonomy consumer used different schemas

The Cell-neutral Agent-arrival producer emitted
`actor-cell-agent-arrival-rate/v1`, while the autonomy audit still required the
old q01-specific `${cell}-agent-arrival-rate/v4` identity. Both local test
suites passed because each tested only its own side of the boundary. The live
B receipt had already proved 100 Agent/s and exact serial scale-down, but could
never satisfy governance.

The audit now consumes the canonical Cell-neutral schema and the static fleet
gate asserts that producer and consumer name the same schema. The promoted fix
made B's existing immutable receipt immediately pass; A now fails only the
intended exact-runtime-release binding and must be exercised again.

### Observation is automated, but qualification production is not one workflow

The five-minute autonomy timer intentionally audits and publishes an existing
`allow`; it does not repeatedly execute destructive DR restore, FDB scale, or
semantic rollback drills. `run-initial-cell-qualification.sh` composes the
generic Bottomless, Engine HA, and physical-restore gates, but the later FDB
autoscaling and release-evolution entrypoints are still q01-specific. A newly
created A/B Cell can therefore reach healthy Kubernetes and keep reporting
missing receipts forever unless an operator runs several unrelated legacy
commands.

This is the remaining construction-method gap, not a reason to weaken the
audit. Qualification evidence needs explicit ownership scopes and one bounded
orchestration entrypoint: per-Cell identity/DR/arrival evidence, per-Cell-class
autoscaling evidence, and per-Runtime-release upgrade/rollback evidence. Argo
and the autonomy timer should consume those immutable roots; neither should
manufacture them during normal reconciliation.

### Qualification was a collection of host-local scripts, not a product pipeline

The first attempt to reuse the FDB autoscaling proof on clean-room Cell B did
not expose five independent data-plane failures.  It exposed five implicit
inputs in the qualification launcher, all before an FDB mutation was issued:

1. it attempted to rebuild `actor-loadgen` and therefore depended on an
   unrecorded base-image build parameter and a fresh registry push token;
2. it derived a kubeconfig filename from the Cell name although Terraform had
   installed the exact path elsewhere;
3. after reading the operations inventory it failed to export the Cell identity
   to the child process, which silently fell back to the legacy q01 default;
4. source promotion and the periodic audit had no explicit fresh-control
   handoff, so an invocation could race the next five-minute audit;
5. the preceding physical-restore gate intentionally retained its diagnostic
   FDB target, while the autoscaling preflight assumed there were no foreign
   storage Pods in the namespace.

The source verifier also ran a unit test against the production operation-lock
path.  A timer firing during source promotion could therefore reject an
otherwise valid immutable source tree.  The test now owns a temporary lock.

These failures explain the apparent lack of convergence: each script encoded a
locally reasonable assumption, but no owner checked the composed lifecycle.
The bounded pipeline contract is now:

```text
Terraform/Argo inventory
  -> immutable product image inventory
  -> atomically promoted reviewed source
  -> fresh source-bound autonomy decision
  -> Cell-local prerequisite/retained-target cleanup
  -> one destructive profile qualification
  -> immutable profile-digest certificate
  -> non-destructive certificate hydration in every matching Cell
```

Every cross-process identity must be explicit; no production child may fall
back to q01.  A retained diagnostic resource is an owned workflow state, not
ambient namespace capacity.  Qualification entrypoints must either consume it
through an exact-UID cleanup transition or fail with that named prerequisite.

The same rule applies after evidence exists.  Evidence cache, hydration, and
activation are Cell-neutral operations, so they now reject a missing `CELL`
instead of inheriting `actor-bj-q01`.  A safe default for a single-Cell lab is
an unsafe cross-Cell mutation in a fleet: omitted identity must stop before the
first Kubernetes read, not silently select the historical qualification Cell.

The review also found that the q01 name had become an implicit production-tier
feature flag.  Reporter source identity and StorageProfile-backed Gasoline
retention were required only when `CELL == actor-bj-q01`; A/B could use the
same production installer while skipping those checks.  Production invariants
now key off the explicit production profile and production Cell identity, not
one historical Cell name.  Machine-repair qualification remains a separate,
identity-bound capability.  Its provider and automatic-replacement receipts
now take the expected Cell and MachineSet explicitly, bind the live cluster and
MachineSet UIDs, and use Cell-named canonical files.  This permits A/B to earn
their own delete authority without allowing either Cell to inherit q01's
destructive qualification.

The release-evolution path has the same ownership error at a larger scope.
Its launcher and verifiers still bind the retired `lightclaw-bj82` registry,
the q01 kubeconfig, one historical TKE cluster ID, and one q01 CAM role.  A/B
therefore cannot produce their currently required upgrade/rollback receipts at
all.  Release evolution is not a per-Cell capability: one regional canary Cell
must qualify the exact immutable Runtime/reporter/NATS/metrics image set and
issue an identity-bound Runtime-release certificate.  Matching Cells consume
that certificate; a new image set invalidates it.  Wall-clock expiry must not
force every healthy Cell to repeat the same disruptive release drill weekly.

The static release ledger now derives that Cell-neutral artifact scope from
the complete role-to-image and reviewed-source inventory.  A canary's verified
forward rollout plus semantic-failure rollback can be compacted into
`actor-runtime-release-qualification/v1`; its filename and payload bind the
artifact digest, it has no wall-clock expiry, and matching Cells can hydrate
the immutable certificate.  The legacy per-Cell receipts remain a temporary
fallback until the q01-only producer is replaced; they are no longer the
target fleet model.

### A healthy steady state did not imply a user-transparent release

The q01 release gate exposed two more composition defects that ordinary
functional and steady-state canaries could not see.  First, the direct builder
entrypoint preserved q01's `actor-q01-autoscaling` SSA owner while the TAT
entrypoint did not.  The generic autoscaling manager therefore became a second
writer only after Engine, NATS, Hosts, and Reporter had already rolled.  The
release correctly rolled back, but could never commit its first release
ledger.  Both entrypoints now carry the same bounded HPA settings and exact SSA
manager, and the contract test reads both scripts.

Second, continuous public traffic was healthy before and after the operation,
but not while a NATS member was terminating.  A 130-second no-mutation control
completed 4,700/4,700 requests, with p99 91 ms and maximum 181 ms.  During the
failed release, 138 of 7,859 requests failed; Kubernetes events align every
failure wave with a `NATS Pod Killing` transition, and the public error was
`route_subscribe_timeout`.  The Cell used async-nats' generic five-second
per-address connection timeout, longer than Guard's two-second subscription
deadline.  A terminating StatefulSet Pod IP can remain resolvable while its
socket blackholes, so cluster HA alone did not provide the request SLO.

The Runtime config now binds a 500 ms per-address timeout for its co-located
three-member NATS cluster while retaining the generic five-second default for
remote deployments.  The NATS StatefulSet also requires ten seconds of stable
readiness before removing the next member.  This is not considered qualified
until the same continuous public release test passes with zero failures; the
prior failed receipt remains negative evidence rather than being waived.

## Current evidence

- B strict arrival test: 100 Agents at 100 Agent/s; create p99 0.572 s;
  chat-ready p99 1.492 s; nodes scaled 3 -> 5 -> 7 and returned one at a time
  to 3; 180 Objects deleted; zero keepalive failures.
- Hub release image:
  `workers-api@sha256:94aa0213bc0dbf12039e7c66403f0210d10f29307cec0c92511ff0c8c7bee17e`.
- Management Git revision:
  `3ba571f57dcd1c2f204afb66e5d5b6ffb325d90e`.
- Workers API: 3/3 Ready, Argo `Synced/Healthy`.
- With the ShardPool deliberately closed: `/readyz` is 200 and Object
  creation is 503 with stable, retryable `no_admission_capacity`.
- Request-scoped readiness receipt SHA-256:
  `d2746e9c8ca3a4ed48c1831371ea93d9054ebd6d251d6a011650854c37e2851d`.
- Reviewed operations source on A and B:
  `39751a6cabe4129eeb387a188601bddcb9c94c27`, manifest
  `e16e00f39e4684fec73f82e1bf9a12a607c366066044fa2e67cc80739de429f7`;
  both autonomy timers are enabled and active. B now reports
  `agent_arrival.passed=true`; A reports only the expected release-binding
  mismatch for that gate.

## What remains

The discovered producer/consumer defect is closed, but the scalable
qualification-orchestration gap above remains. Full production admission is
still blocked, correctly, until the new A/B Runtime releases obtain their
required immutable evidence and both Cells return to the ShardPool admission
set. Alertmanager also needs an approved internal receiver; the rebuild must
not invent a no-op receiver. Long-duration soak is outside this qualification
by explicit decision.
