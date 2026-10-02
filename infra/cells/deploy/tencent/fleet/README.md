# Rivet FDB/COS storage fleet

This directory turns the qualified single Beijing Rivet storage Cell into a
retireable fleet. It deliberately does not put Relay in the SQLite commit path.

The current clean-room A qualification/activation/adoption evidence and remaining
fleet gates are recorded in
[`beijing-rebuild-qualification-2026-09-15.md`](beijing-rebuild-qualification-2026-09-15.md).

```text
Actor SQLite -> Depot -> Cell-local FDB commit -> ACK
                              |
                              +-> COS cold tier / backup
```

The physical scaling unit is a `RivetCell`, not an individual Actor and not an
unbounded global FoundationDB cluster:

```text
one RivetCell = one exclusive FDB cluster + one COS policy domain + runtime hosts
```

Runtime hosts may scale inside a Cell. Adding storage capacity creates another
Cell. Existing Actors do not move merely because the pool grew.

## Bottomless SQLite contract

Rivet SQLite is **Bottomless**: there is no product-level fixed logical byte quota per database.
FoundationDB is the synchronous ACK authority and carries a bounded transient write debt; immutable
shards age into Tencent COS and are restored by exact key. The default branch target is 10 MiB of
FDB write debt with a 12 MiB admission boundary, not a 10/12 MiB database-size limit. A release gate
creates one approximately 12 MiB qualification database, proves its logical size crossed the 12 MiB
transient admission boundary while its exact branch became cold-only, then performs a synchronized
cold recovery wave.

“Bottomless” does not mean literally infinite physical resources. The SQLite format remains bounded
by its `u32` page-number space (about 16 TiB at 4 KiB pages), commits remain bounded to 320 dirty
pages, and a Cell closes new placement when latency, recovery, FDB, COS, disk, or backlog budgets are
at risk. These are operational/admission boundaries, not a fixed database storage plan.

The externally approved claim is therefore precise: **“Bottomless SQLite has no fixed per-database
logical byte quota; acknowledged state grows into COS while FDB retains only bounded transient hot
write debt.”** “Truly unlimited” means this product contract and automatic cold-tier growth, not
unlimited instantaneous write rate or free physical storage. A Cell may publish this claim only when
its immutable `production-qualification` receipt passes
`runtime/verify_bottomless_receipt.py`; an `e2e-fast` receipt is never claim-eligible.
For an autoscaling Cell, a `production-cell-qualification` receipt proves the
same storage path on its three fixed base Hosts but is also not independently
claim-eligible. It must be composed with the Cell's arrival-burst scale-out and
serial-drain and Engine HA receipts. Physical restore is a separate
operator-triggered DR exercise after storage-format, backup, or restore
implementation changes; it is not a placement-admission prerequisite.

Qualification boundaries matter: the cold recovery harness sets an explicit
test-database shard-cache retention override and requests bounded checkpoint/reclaim.
It proves the cold data path, not the default retention policy's natural sinking
latency. Likewise, a 100-object burst offered at 100/s after prewarming does not prove
sustained 100 Agent/s admission. See the q01
[evidence boundaries](qualification/actor-bj-q01/evidence-boundaries.md) before
publishing capacity or unattended-operation claims.

## Resource model

- `RivetCellProfile` fixes the driver ABI and the physical safety contract.
- `ShardClass` binds a profile digest to the `rivet-fdb-cos-v1` driver.
- `RivetCell` is one independently drainable and destroyable storage domain.
- `ShardPool` sets bounded admission, reservation, and scale-out policy.
- `RivetCellClaim` is one pending Cell-sized capacity request; it is not proof that cloud resources exist.
- `RivetCellReport` is one fresh, UID/generation-bound observation from a trusted Cell Agent or
  qualification publisher.

There is intentionally no per-Actor Kubernetes CRD. Kubernetes/etcd must not
hold one object per Actor at million or billion database cardinality. The hot
route uses a stable Cell hint plus a versioned exact-placement exception. Cell
and migration controllers operate exact IDs and bounded queues; they never scan
all FDB clusters or use COS `LIST` for recovery.

## Beijing topology

The historical qualification fleet reuses TKE cluster `actor` (`cls-0zvm1btp`)
as the regional management/runtime cluster. Its FoundationDB processes are
native supervised processes on dedicated CVMs. The next production substrate
uses nine dedicated TKE workers and the official FoundationDB Kubernetes
Operator; see [`fdb-operator/`](fdb-operator/). Existing native Cells are not
converted in place.

The qualification Cell uses six FDB machines distributed `2/2/2` across
Beijing zones 6, 7, and 8. It is the minimum shape used to demonstrate progress
after one AZ loss. It is not the final production shape: FDB's cloud operating
guidance calls for at least `3/3/3` when the contract includes one AZ plus one
additional machine failure. The former five-machine `2/2/1` shape cannot even
claim availability after losing either of the two-machine halls.

The official Operator imposes an additional hard constraint: for
`three_data_hall` it recruits nine coordinators and allows only one coordinator
per hostname fault domain. Therefore the native six-host shape cannot be
reused as a production Operator Cell. It stays native; the Kubernetes profile
starts at nine workers and nine process groups distributed `3/3/3`.

The production Kubernetes workers are declared through TKE's cluster-scoped
`node.tke.cloud.tencent.com/v1beta1` `MachineSet` API, not through Terraform.
FDB, Cell control, and Actor compute use three disjoint multi-zone pools. See
[`tke-native-nodepool/`](tke-native-nodepool/),
[`tke-native-control-nodepool/`](tke-native-control-nodepool/), and
[`tke-native-runtime-nodepool/`](tke-native-runtime-nodepool/). Every base contains no region or
AZ identity. A region/Cell overlay supplies candidate subnet IDs, cloud resource
IDs, Cell identity and the desired replica count. Terraform
continues to own regional substrate such as VPC/COS and the historical native
qualification Cell, while TKE owns node reconciliation and the FDB Operator
owns database Pods/PVCs. This avoids two controllers writing the same node
pool. `ZoneEquality` distributes node creation across the candidate subnets;
Pods use `topology.kubernetes.io/zone` with `maxSkew: 1` and hard scheduling,
plus required hostname anti-affinity. A three-Pod shape is therefore 1/1/1, a
five-Pod shape is 2/2/1, and the current nine-process production contract is
3/3/3. Compact shapes do not inherit the production three-data-hall failure
claim merely because their Pods are evenly distributed.

The Terraform module creates Cell B only. It reuses the existing Actor VPC,
three subnets, and internal-only security group. New FDB and three cross-AZ runtime instances
receive no public IP. The bounded control and FDB pools use HOST spread
placement; the elastic runtime pool deliberately relies on zone/hostname Pod
spreading instead, so one provider placement-group quota cannot cap scale-out.
FDB data uses a separate retained CBS
volume; destroying a CVM does not prove retirement of that volume. CBS encryption is a policy
option, not a fleet-readiness requirement here.

Engine is a six-replica Deployment over shared FDB/Gasoline state and a
three-member, non-durable NATS PubSub plane. Engine Pods have no stable
identity and are deliberately replaceable. Engine, NATS and Cell agents select
only the control pool. The three runtime hosts select and tolerate only the
tainted Actor compute pool and form a
StatefulSet for stable operational slots and controlled replacement, not for a
durable Actor-owner identity. Each host process receives a fresh Envoy UUID;
Actor generation fencing permits exactly one live owner and prevents a stale
process from reclaiming a restarted slot. Ownership is never bound to an
Engine Pod or StatefulSet ordinal. Three configured hosts are not sufficient
evidence by themselves: qualification requires exact host registries to show
Actor ownership across all three runtime hosts, while the separate Engine
fault drill proves that deleting any one steady-state Engine Pod does not
interrupt Actor traffic or lose durable state.

`enable_cbs_encryption` defaults to `false`. Operators that adopt an encryption-at-rest policy may
enable it for newly created disks; Terraform must never claim an existing unencrypted disk was
converted in place. The flag does not determine `readyForPlacement` in this deployment.

## Apply order

The repository-root `AGENTS.md` defines the operator safety contract. For a
same-VPC Tencent builder reached through TAT, use the checked-in helpers under
[`tencent/`](tencent/) for command execution and hash-verified transfers, then
use [`runtime/build-image.sh`](runtime/build-image.sh) and the runtime installer
and qualifier. These are the stable entry points for both humans and agents;
release procedures must not grow independent inline `tccli` polling loops.

1. Validate manifests locally:

   ```sh
   ./verify-manifests.sh
   ```

2. Install and verify the three-zone control MachineSet, then the tainted Actor compute MachineSet.
   Do not roll Engine/NATS to the control selector until all three control nodes are Ready. Standard
   TKE Native CVMs are not PVM-qualified; `rivet.dev/pvm=true` requires a separately verified
   `/dev/kvm`-capable node source.
3. Build `actor-fleet-controller` for the cluster architecture, push it to the authorized registry,
   replace the mutable development image with the registry-reported digest, and apply `controller/`.
4. Apply `crds.yaml`, then `beijing-fleet.yaml` through the private TKE API.
5. Run Terraform with short-lived credentials supplied only through provider
   environment variables. Never place credentials in `.tfvars` or state.
   Set `-var=enable_cbs_encryption=true` only when the selected storage policy requires it.
6. Bootstrap and qualify Cell B, then publish a fresh `RivetCellReport`. Never patch
   `RivetCell.status` by hand.
7. Close Cell A admission until it has six processes, `three_data_hall`, a
   dedicated data disk, and a real AZ-loss pass.

Both COS buckets must be newly created ordinary buckets whose versioning response has always been
empty (`NeverEnabled`). Tencent COS cannot turn a previously enabled bucket back into that state,
and multi-AZ buckets cannot satisfy the no-versioning contract. The old Cell A/B qualification
buckets are historical evidence only; never import them into the `*-nv1-*` Terraform resources.
Provider 1.83.11 deliberately does not manage `versioning_enable`: its false update means
`Suspended`, and its read path cannot distinguish that from `NeverEnabled`. The remote empty
versioning document from `verify_cos_no_versioning.py`, not Terraform state, is the admission proof
([provider source](https://github.com/tencentcloudstack/terraform-provider-tencentcloud/blob/v1.83.11/tencentcloud/services/cos/resource_tc_cos_bucket.go)).

## Retirement gate

A Cell may move from `Draining` to `Retired` only when one immutable receipt
proves all of the following:

- no new placement admission;
- exact placement count is zero;
- active writer and in-flight commit counts are zero;
- migration, compaction, GC, and reconciliation queues are zero;
- every retained cold object and backup generation is reachable by exact key;
- the target Cell rejects the old writer generation;
- the rollback retention deadline has elapsed;
- the dedicated FDB cluster, data disks, COS policy domain, and credentials are
  enumerated for explicit destruction.

Deleting a Deployment, a `RivetCell` object, or an FDB key prefix is not a
retirement proof.

The controller is deliberately unable to delete Claims, Cells or cloud resources. It adds a
retirement finalizer and only removes it after a trusted fresh Report carries every zero-count,
exact-key, fencing, retention and inventory proof. The controller checks the report binding and
completeness; the restricted Report publisher is responsible for measuring and hashing the real
FDB/runtime/COS evidence.

The real Beijing Cell B resource inventory, one-AZ failure trace, native runtime persistence gate,
exact COS publish/evict/refill proof, evidence hashes, production blockers, and cleanup record are
in [`beijing-cell-b-qualification-2026-08-16.md`](beijing-cell-b-qualification-2026-08-16.md).

The current hard limits, backpressure gaps, per-Cell admission watermarks, scale-out/retirement
rules, stop-the-line conditions, and active/cold/recovery qualification gates are in
[`capacity-admission-and-operating-policy.md`](capacity-admission-and-operating-policy.md). Values
in that document distinguish observed qualification evidence from product limits; neither a test
harness cap nor one successful load run is a production capacity promise.

The exact no-versioning, 1M dormant, 2K/4K multi-host, RSS convergence, FDB range/hotspot and
maintenance-drain execution order is in
[`beijing-scale-qualification.md`](beijing-scale-qualification.md). Its cloud receipts have not yet
been generated.

The bounded Cell creation contract is in
[`cell-provisioning-sop.md`](cell-provisioning-sop.md). The only human decision is the reviewed
Terraform apply for one exact Claim; Argo installation, public Durable Object qualification,
release-bound reporting, placement admission and resolver visibility are automatic. Terraform or
Argo health alone never opens placement, and Cell deletion is never automatic.

The Beijing three-source concurrency trace, 64/256/1024 cardinality stages, loopback admission
failure analysis, and exact cleanup evidence are in
[`beijing-cell-b-load-qualification-2026-08-16.md`](beijing-cell-b-load-qualification-2026-08-16.md).
The source-static FoundationDB client contract and its deliberately stricter ELF/real-cluster gates
are in [`../foundationdb-static-musl.md`](../foundationdb-static-musl.md).

## Cluster observability

Each TKE cluster runs one shared Prometheus and Grafana stack; Cells do not receive private copies.
The pinned, retained-CBS deployment, Engine ServiceMonitor, low-cardinality rules/dashboard, and
repeatable install/verification entry points are in [`observability/`](observability/). It remains
an operational view rather than a source of Actor ownership or release evidence, and it must not be
installed or upgraded during a production rollout or qualification.

The global tier federates only `actor_fleet:cell_*` recording rules from
those autonomous TKE stacks into one Hub Prometheus and mesh Grafana. It neither scrapes raw Actor
metrics nor mutates a Cell. Hub-owned Pools and Claims are observed directly from the Hub API.
Target loss and stale evidence fail visibly at the Hub while the local
Prometheus -> reporter -> Cell controller protection loop continues independently. See
[`observability/federation/`](observability/federation/).

## Autonomous production readiness loop

For the long-run claim "no intervention under normal degradation", pair
`observability/` with the Cell-level autonomous gate under
[`operations/`](operations/):

- `operations/autonomy_audit.py`: one-shot evidence collection (k8s/FDB health, Prometheus alerts
  and forecasts, receipt freshness).
- `operations/run-autonomy-audit.sh`: polling orchestrator for long-run proof collection.
- `operations/run-autonomy-ops-cycle.sh`: one serialized `pre-audit -> decision -> action -> post-audit`
  cycle. Without `--action` it is read-only; with an action it holds the shared risky-operation lock
  throughout and writes an immutable cycle receipt.

Suggested proof posture:

1. Run `run-autonomy-audit.sh --once` after each release/qualification to establish a clean baseline.
2. Keep it running with five-minute cadence:

   ```sh
   ./operations/run-autonomy-audit.sh --interval-seconds 300 --strict --max-failures 0
   ```

3. Production建议同时运行治理层面闸道：

   ```sh
   ./operations/run-autonomy-governance.sh \
     --receipt-dir /var/lib/actor/autonomy/decisions \
     --policy ./operations/autonomy-policy.json \
     --continuous --interval-seconds 300
   ```

   并按 `autonomy-control-*.json` 的 `control` 字段做机器决策：
   `allow`（放行）、`degrade`（限速）、`block`（阻断）。

4. Treat any non-passing receipt (or a continuous warning streak on critical counters) as a
   stop-the-line signal for risky placement changes.
5. Require the latest immutable `runtime` and `dr` receipts to be fresh before scale-up/scale-down or
   admission adjustments.

This gives you deterministic audit evidence for every interval instead of ad-hoc human checks.
The audit treats a missing Prometheus core attribution series as a strict-mode failure, so a blank
dashboard can never be interpreted as a healthy Cell.
