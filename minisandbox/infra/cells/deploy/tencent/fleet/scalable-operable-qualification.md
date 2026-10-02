# Fleet scalable and operable qualification

Qualification date: 2026-09-14

## Decision

**BLOCK until the current release-bound scale evidence passes.** The fleet
construction and operating method has passed repeatable construction,
desired-state convergence, release rollback, storage recovery, node
replacement, observability gates and fail-closed admission. The authoritative
q01 governance decision nevertheless remains closed while the current
release-bound FDB autoscaling and Agent arrival-rate qualifications are being
regenerated. Argo convergence is not permission to bypass that admission
decision.

The following are outside this qualification by product decision:

- long-duration soak;
- direct reachability from the operator workstation to private service or
  Kubernetes endpoints. Operators use the approved Kubernetes/API proxy path.

Those exclusions must not be used to waive an in-cluster readiness, image-pull,
storage, recovery or admission failure.

## Supported scale model

The unit of failure and expansion is a Cell, not one indefinitely growing
cluster.

1. Within a Cell, Actor placement, workerd Pod scale, runtime MachineSet scale,
   node admission, one-node drain and FoundationDB process scale are automatic.
2. The qualified q01 profile has a bounded runtime-node ceiling of 30. Raising
   that ceiling is a new capacity qualification, not an ordinary configuration
   edit.
3. Fleet growth beyond one Cell is an operator-reviewed Terraform operation.
   Terraform creates the isolated cloud substrate; central Argo installs the
   declared Cell state; the Cell remains closed until its joined qualification
   receipt passes and an operator performs the guarded admission CAS.
4. The resolver sends only new objects to a newly admitted Cell. Automatic Cell
   deletion and cross-Cell object migration are intentionally absent.

This provides fleet growth by adding bounded shards without making an
unverifiable claim about the size of one FoundationDB/TKE failure domain or the
maximum number of Cells the central plane can coordinate.

### Million-dormant / ten-thousand-active design envelope

The architecture can target one million durable Agents with ten thousand
simultaneously active Agents at fleet scope, but this is a scaling shape rather
than a qualified capacity number:

- a dormant Agent owns durable Registry/FDB metadata and Cell-scoped cold
  objects, but no Pod, process, Kubernetes object or runtime placement slot;
- only active Agents consume a workerd Host slot, and every Host publishes a
  hard capacity used by Pegboard's durable, capacity-aware bin-pack allocator;
- runtime Pods and their TKE MachineSet grow inside the bounded Cell envelope;
  a Cell approaching its qualified limit closes new placement, while a newly
  qualified Cell accepts only new Agent identities;
- central C stores desired state and the fresh placement/route view. Stable
  Object placement remains in Registry FDB, and execution stays on the selected
  Cell data path rather than proxying every invocation through a global Actor
  scheduler.

At the current 128 MiB per-invocation memory limit, ten thousand fully resident
limits represent 1.25 TiB before platform headroom. Real waiting-heavy Agent
RSS may permit a lower measured reservation, but only a per-node density
receipt may set that value. CPU-saturated Agents are sized independently by CPU
time. Operators therefore publish capacity as `active Agents per node`,
`dormant metadata/cold bytes per Cell`, and `wake rate per Cell`; they never use
one aggregate Agent count as a substitute for those three budgets.

No document currently claims that one Cell has qualified one million dormant
or ten thousand active Agents. Fleet-scale growth comes from adding qualified
Cells, and a new per-Cell ceiling requires a separate capacity qualification.

## Ownership and reconciliation

| Surface | Authoritative owner | Operating rule |
|---|---|---|
| VPC, TKE, subnets, TCR, buckets, CAM and Cell identity | Terraform state | Never recover from remembered resource IDs or copied node files. |
| Kubernetes desired state and Cell registration | Argo CD | Git revision and immutable image inventory are the only deployment inputs. |
| Runtime/FDB capacity, node admission and drain | Fleet controllers | Controllers own only their labels, annotations and taints; one destructive repair at a time. |
| Worker code/version/deployment and placement | Workers API, Registry FDB | Public `/v1` hides namespace, runner and datacenter identities. |
| Durable object state | Cell FDB plus Cell-scoped COS cold tier | FDB acknowledges hot writes; immutable cold objects and physical backup provide recovery. |
| Qualification and traffic admission | Receipt ledger and governance controller | Missing, stale or release-mismatched evidence closes admission. |

## Current evidence

| Requirement | Evidence | Result |
|---|---|---|
| Rebuildable source and Terraform | `terraform/create-first/verify.sh`, `verify-manifests.sh`, and the bundled workerd source verifier pass from the reviewed tree. | pass |
| Real clean-room construction | The Beijing C/A/B replay created both Cells, registered them through central Argo and completed public first placement. Historical immutable receipt hashes are recorded in `clean-room-rebuild-audit.md`. | pass |
| Current Cell governance | q01 authoritative autonomy control reports `control=block`, score 58. Its only failures are stale/current-release-mismatched Agent arrival-rate and FDB autoscaling evidence; the FDB qualification is currently running and Agent arrival follows serially. | pending |
| Cold tier | 48 Actors, 6,240 writes and 531 cold shards completed two production reclaim cycles; all object identities and states survived wake-up. | pass |
| Engine HA | One Engine Pod was deleted by UID during 1,500 public `/v1` requests; no request failed and three-zone topology recovered. | pass |
| Physical disaster recovery | An isolated three-AZ FDB restore recovered all 4,273 range blocks and verified 12/12 Actor SQLite states with `integrity_check=ok`. | pass |
| Release supply chain | The reviewed release Hook was built from a digest-pinned Beijing base, pushed by digest and emitted a validated product receipt. A promoted 28-image inventory containing it validates successfully. | pass |
| Blank-node image availability | The exact release Hook digest cold-pulled and executed its embedded approval verifier on all three q01 control-pool nodes using the production pull identity. | pass |

The detailed historical rebuild audit remains useful evidence, but its original
NO-GO sections describe gaps before the 2026-09-12 replay. This document is the
current decision record. It may return to GO only after the authoritative audit
consumes both new receipts and reports `verdict=passed`, score 100 and
`control=allow` for the exact reviewed source.

The first current-release FDB rerun failed closed after Argo self-heal reverted
the qualification's direct Profile/Class patches. No FDB topology or production
policy was left changed, and the failed receipt was retained. The workflow now
uses a bounded Application-UID recovery guard around each synthetic signal
window, immediately restores the Git policy after target selection, and makes
Argo convergence part of the qualification evidence. This removes the two-owner
race without excluding the autoscaling policy from desired-state management.

## Per-change gates that remain mandatory

The GO decision is not a permanent waiver. Operations must still enforce:

- every new Cell repeats Terraform-to-Argo registration, qualification and the
  guarded admission CAS before accepting placement;
- every runtime release binds the exact runtime/reporter/source identities to
  approved TAT commands, validates the candidate, and proves rollback;
- a changed runtime release refreshes release-bound Bottomless, Engine HA,
  physical DR and autoscaling evidence before governance returns `allow`;
- a new image repository or changed dependency advances the complete TCR pull
  credential/inventory generation and passes a new-digest cold-pull probe;
- all physical repair remains serialized and fail closed.

No long soak or public-network probe is required by this qualification, but a
failure in any mandatory gate above is a real production block.
