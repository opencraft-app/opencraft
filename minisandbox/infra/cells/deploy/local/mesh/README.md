# Local three-cluster Cell mesh

This environment runs one OCM hub and two independent k3s runtime environments on one development
machine:

```text
rivet-mesh-hub                 rivet-runtime-a          rivet-runtime-b
OCM hub + fleet controller -> OCM klusterlet        -> OCM klusterlet
Prometheus federation          spoke Prometheus        spoke Prometheus
Grafana                        k3s compute agent        k3s compute agent
```

It is the first real boundary above `internal/meshharness`: Kubernetes APIs, OCM registration,
`ManagedCluster` identity, `ManifestWork` propagation and feedback, Prometheus federation, Grafana,
and controller RBAC are real. The placement E2E obtains node readiness through each real spoke
Prometheus before publishing a real `RivetEnvironmentReport` on the Hub.

The base control-plane fixture does not require FoundationDB or the Cell data plane. Their readiness
and the final spoke Cell qualification are simulated there, and reports carry the
`local.fleet.actor.dev/simulated-components` annotation so this cannot be mistaken for production
qualification. Claim, placement, logical Cell and ManifestWork decisions always use the production
reconcilers.

An optional real-data-plane layer installs the pinned official FoundationDB Operator, one independent
three-process FoundationDB cluster in each runtime environment, Rivet Engine, Depot, and the custom
workerd runtime. It performs real FoundationDB transactions and real SQLite VFS traffic. Every
product installer resolves one complete `StorageProfile`; there is no unprofiled
`cold-tier.invalid` deployment fallback. The `local-workers/up.sh` product entry connects both Cells
to the persistent local S3 protocol double and qualifies cold publication and recovery.

Each spoke runs a narrowly permissioned local evidence simulator every 15 seconds so the steady
state behaves like a continuously reporting Cell controller. It may only read `RivetCell` and patch
its status subresource; the image is digest-pinned and runs non-root with no Linux capabilities.
The Hub also runs a narrowly permissioned environment reporter. It renews a report only after the
trusted federation endpoint confirms that spoke is up, and recreates the report when its immutable
ManagedCluster UID/generation fence changes.

## Prerequisites

- Docker with at least 16 GiB available memory.
- `k3d` v5.9.0, `kubectl`, and `clusteradm` v1.3.1. The extended setup installs the pinned Helm CLI.
- At least 1,024 inotify instances. `up.sh` raises `fs.inotify.max_user_instances` when run as root,
  or fails with an actionable message instead of allowing k3s containerd CRI startup to hang.
- `/dev/kvm` is optional. When present it is mounted only into each runtime agent node.

Versions are pinned in `versions.env`. Runtime kubeconfigs and the bootstrap join command are kept
with mode `0600` under `${XDG_STATE_HOME:-$HOME/.local/state}/rivet-local-mesh`, never in Git.
The OCM agents reach the Hub through the k3d load balancer's certificate-backed Docker DNS name,
not an ephemeral container IP. Re-running `up.sh` repairs legacy bootstrap and client kubeconfigs
and restarts only the OCM agents when the stored endpoint has drifted.

## Commands

```sh
infra/cells/deploy/local/mesh/up.sh
infra/cells/deploy/local/mesh/up-federated-placement.sh
infra/cells/deploy/local/mesh/install-real-fdb.sh
infra/cells/deploy/local/mesh/verify-real-fdb.sh
infra/cells/deploy/local/mesh/build-real-runtime-image.sh
infra/cells/deploy/local/mesh/install-real-runtime.sh
infra/cells/deploy/local/mesh/steady-state-e2e.sh
infra/cells/deploy/local/mesh/evidence-stall-e2e.sh
infra/cells/deploy/local/mesh/prometheus-outage-e2e.sh
infra/cells/deploy/local/mesh/failure-recovery-e2e.sh
infra/cells/deploy/local/mesh/hub-endpoint-recovery-e2e.sh
infra/cells/deploy/local/mesh/scale-in-retirement-e2e.sh
infra/cells/deploy/local/mesh/fdb-scale-down-e2e.sh
infra/cells/deploy/local/mesh/supernode-fdb-scale-e2e.sh runtime-a
infra/cells/deploy/local/mesh/qualify-cold-gc.sh
infra/cells/deploy/local/mesh/cold-gc-physical-e2e/run.sh
infra/cells/deploy/local/mesh/backup-restore-physical-e2e/run.sh
infra/cells/deploy/local/mesh/qualify-real-cos-backup-restore.sh
infra/cells/deploy/local/mesh/qualify.sh quick
infra/cells/deploy/local/mesh/qualify.sh full
infra/cells/deploy/local/mesh/status.sh
infra/cells/deploy/local/mesh/health-check.sh
infra/cells/deploy/local/mesh/verify.sh
infra/cells/deploy/local/mesh/down.sh
```

For the complete user-facing Workers product path, use the idempotent one-command entry point:

```sh
infra/cells/deploy/local/local-workers/up.sh
infra/cells/deploy/local/local-workers/verify.sh
infra/cells/deploy/local/local-workers/qualify.sh all
infra/cells/deploy/local/local-workers/down.sh --destroy
```

It assembles Hub C, runtime Cells A/B, observability, Registry, Workers API, ingress, independent
runtime FDB clusters, and the persistent local cold tier. FDB and cold-store identity comes from the
single `storage-profiles/local-workers.json` resource; installers, verification, and qualification
do not maintain separate path mappings. The same profile also declares the durable `ColdGcPolicy`;
the installer reconciles it by FDB revision CAS after Engine is ready. The checked-in profile keeps
physical retired-object deletion disabled and in dry-run until the deletion qualification passes.
The lightweight `qualify-cold-gc.sh` covers the deterministic fault matrix in process. The separate
`cold-gc-physical-e2e/run.sh` gate provisions an isolated FDB cluster and bucket, drives the deployed
Engine through backup certification, and proves one exact cold object is physically deleted with a
matching durable receipt and accounting transition. The destructive, low-frequency
`backup-restore-physical-e2e/run.sh` gate goes further: it uses the pinned real FDB tools, destroys
all source FDB processes and PVCs after deletion, restores the catalog's exact oldest supported
version into a fresh FDB cluster, and proves that version has no live reference to the deleted key.
`qualify-real-cos-backup-restore.sh` executes the identical state transition against an empty,
dedicated Beijing COS bucket selected by an independent qualification `StorageProfile`; it never
repoints an existing Cell or reuses its FDB metadata.

Hand-written Kubernetes and Helm inputs are grouped under [`manifests/`](manifests/README.md).
The mesh root contains only orchestration, rendering, qualification, and verification entry points;
runtime-generated manifests remain in `MESH_STATE_DIR`.

`up.sh` is idempotent. It creates a shared Docker network, three k3d clusters, installs the pinned
OCM bundle, joins and accepts both runtime clusters, installs the Rivet Cell CRDs, builds the local
fleet controller image, and sends one smoke `ManifestWork` to each spoke. `verify.sh` requires both
ManagedClusters to be Available and verifies the exact ConfigMap materialized in each spoke.
`status.sh` ends with a strict health verdict and exits nonzero for an unavailable or degraded OCM
connection, a stale or identity-mismatched environment report, or a ShardPool whose minimum Cells
are not ready and admission-open.

The real desired-state control loop is installed separately from
[`../argocd/`](../argocd/README.md). It runs upstream Argo CD in the Hub (cluster C), registers A/B
with namespace-scoped least-privilege credentials, and qualifies Git drift self-heal across an
Argo controller replacement without taking ownership of runtime replicas.

`hub-endpoint-recovery-e2e.sh` injects the former stale-IP kubeconfig state, repairs both agent
kubeconfigs, proves the OCM Pods reload it, and verifies that ManagedCluster, ManifestWork, Claim,
and Cell identities survive. The `full` qualification profile runs this recovery gate.

`up-federated-placement.sh` is the next, idempotent layer. It installs one lightweight Prometheus in
each runtime, exposes only its private Docker-network federation endpoint, and installs Hub
Prometheus plus Grafana. The Hub overwrites cluster identity and accepts only bounded
`actor_fleet:cell_*` recording rules. It then runs this real control path:

```text
spoke Prometheus Ready-node evidence
  -> RivetEnvironmentReport
  -> ShardPool
  -> deterministic RivetCellClaim
  -> OCM ManifestWork
  -> spoke RivetCell + OCM status feedback
  -> Bound Claim + admission-open Pool
```

The fixture has two one-Cell environments, so deterministic placement produces exactly one Bound
Claim in `runtime-a` and one in `runtime-b`. ManifestWork feedback uses OCM `Watch` mode. The setup
explicitly nudges the Work after the initial local qualification, then the continuously reporting
spoke simulator drives steady-state feedback without replacing OCM's propagation path.

An environment report is fenced by ManagedCluster UID and generation. OCM may advance generation
when a spoke reconnects, so the local reporter deletes and recreates the report instead of mutating
its immutable identity. Existing Bound Claims retain their historical placement generation.

A Bound spoke Cell uses different fencing semantics: its UID is immutable, while
`observedGeneration` is a monotonic high-water mark. Legitimate Work updates such as
`Ready -> Draining -> Retired` advance the same Cell's generation; the Claim persists the newer
generation and rejects only feedback older than that fence. Treating generation as immutable would
deadlock every post-bind lifecycle transition.

`install-real-fdb.sh` adds the optional local data plane. It installs the digest-pinned official
FoundationDB Operator and creates the two FDB 7.3.79 clusters selected by the active
`StorageProfile`. The default profile selects `local-runtime-a-storage-v1` and
`local-runtime-b-storage-v1`. Each uses three storage process groups with real 2 GiB `local-path`
PVCs and single redundancy. `verify-real-fdb.sh` requires Operator reconciliation, availability,
full replication, the exact profile annotation, and a real `set -> get -> clear` transaction on
both clusters.

For a bounded replacement drill, copy `storage-profiles/local-workers.json`, assign a new profile
ID, FDB cluster names, and buckets, then pass that complete document through
`RIVET_LOCAL_STORAGE_PROFILE_FILE`. Individual FDB suffix, cluster, endpoint, and bucket overrides
are not a product deployment interface; changing only half of the immutable identity can strand
authoritative cold-object references. The previous FDB, buckets, and PVCs remain untouched until a
separate, audited retirement.

`build-real-runtime-image.sh` first builds Engine and workerd-host with the `local-e2e` Cargo profile,
including the required `rivet-engine/foundationdb` feature, then packages them with the
repository-locked custom static-musl workerd and the same FDB client library supplied by the
Operator. The profile keeps release optimization but uses thin LTO, 16 codegen units, and incremental
compilation for short local deployment loops; set `RIVET_LOCAL_RUNTIME_CARGO_PROFILE=release` to
exercise the production fat-LTO profile. The script imports the content-derived local image into both
k3d runtimes and never packages a stale pre-existing Engine binary. `install-real-runtime.sh` renders the production
Tencent runtime manifests through a narrow local profile, then starts one NATS, Engine, workerd host,
and pool initializer per Cell. It also exposes Engine's port 6430 root metrics endpoint through a
Cell-scoped ServiceMonitor; a failed cold upload is therefore observable as
`rivet_sqlite_compaction_jobs_total{operation="cold_upload",result="failed"}`. The local profile removes only unavailable deployment constraints:
FDB TLS, three-AZ hard scheduling, cloud image credentials, and real COS credentials. It does not
replace FDB, Depot, SQLite, Engine, or workerd with fakes.

After the v4 Workers API is installed, the persistent Durable Object chaos gate keeps one native
workerd Counter alive across sleep/wake, workerd Host, Engine, Registry, and all three Workers API
replicas. It creates one temporary k3d compute node for a real drain, restores the Host to the
original node, then removes both the container and Kubernetes Node object. Its lost-response case
retries one stable caller-provided `Idempotency-Key`; this proves the documented at-least-once HTTP
contract without claiming arbitrary `fetch()` calls execute exactly once:

```sh
python3 infra/cells/deploy/local/mesh/workerd-durable-chaos-e2e/run.py
```

The automatic residency gate deliberately does not call the Actor sleep API. It waits for the
workerd Host's idle policy to propose a generation-fenced sleep, requires Host and SQLite bridge
counts to return to their pre-test baseline, then wakes the same Durable Object and proves both a
new Actor generation and continuous Counter state:

```sh
python3 infra/cells/deploy/local/mesh/workerd-auto-sleep-e2e/run.py
```

FDB clients are process-local, so the Host, Engine, and Registry replacements are the client-restart
gates. FDB server-process loss and replication repair remain in the separate storage chaos suite.

For the real Tencent COS qualification, install `cos-python-sdk-v5` outside the repository and inject a
root-owned mode `0600` env file containing only `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`.
The following sequence creates two independent ordinary Beijing buckets, keeps versioning in the
`NeverEnabled` state, enables default SSE-COS AES256, creates fresh FDB clusters so the immutable
cold-tier identity is never rewritten, and switches both runtime Cells. The explicit
`qualification` context prevents this test-only path from being confused with a deployable Cell
profile:

```sh
set -a
. "$MESH_STATE_DIR/tencent-cos-root.env"
set +a
python3 infra/cells/deploy/local/mesh/provision-real-cos.py --appid 1388575217
RIVET_LOCAL_STORAGE_CONTEXT=qualification \
  RIVET_LOCAL_STORAGE_PROFILE_ID=local-tencent-cos-qualification \
  RIVET_LOCAL_FDB_SUFFIX=-cos \
  infra/cells/deploy/local/mesh/install-real-fdb.sh
RIVET_LOCAL_STORAGE_CONTEXT=qualification \
  RIVET_LOCAL_STORAGE_PROFILE_ID=local-tencent-cos-qualification \
  RIVET_TENCENT_COS_CREDENTIAL_FILE="$MESH_STATE_DIR/tencent-cos-root.env" \
  RIVET_TENCENT_COS_APP_ID=1388575217 \
  infra/cells/deploy/local/mesh/install-real-runtime.sh
```

The credential file and qualification receipts remain outside Git. A runtime already bound to the
fault-injection endpoint must not be pointed at COS in place: Depot deliberately rejects that
cold-tier identity mismatch. The `-cos` FDB clusters preserve the old databases and establish a new
identity instead.

The local cold-tier qualification is intentionally independent of Tencent COS. It first verifies
the persistent S3 protocol double, then runs the same Actor data path in both runtime Cells. The
natural scenario sends no checkpoint and no force-reclaim request: Actor sleep wakes the bounded
Depot planner, and the existing retention, pin, generation, hash and transaction fences remain in
force. The remaining scenarios inject post-commit PUT response loss, Engine restarts at published
and cold-only boundaries, and bounded HTTP 429/503 failures. Every run emits per-Cell receipts plus
one summary outside Git:

```sh
infra/cells/deploy/local/mesh/qualify-local-cold-tier.sh
```

An isolated storage drill changes the complete identity, never only the FDB cluster or bucket.
Copy `storage-profiles/local-workers.json`, change the profile ID and both Cells' mappings, then
point every entry point at that one file. The double renders and verifies its explicit bucket
allowlist; it never accepts an arbitrary bucket on first use:

```sh
RIVET_LOCAL_STORAGE_PROFILE_FILE="$MESH_STATE_DIR/storage-replacement.json" \
  infra/cells/deploy/local/mesh/qualify-local-cold-tier.sh
```

The receipt reports the exact Actor count exercised. The lifecycle gate deliberately does not claim
1,000/10,000-Actor fairness coverage; that is a separate load qualification with a larger local
capacity profile. To repeat the same non-local lifecycle path against Tencent COS, invoke
`qualify-cold-lifecycle.py` with `--endpoint-kind tencent-cos`; deterministic local fault points are
then recorded as not applicable rather than silently simulated.

The real-COS outage qualification keeps Actor writes running while a Cell-scoped NetworkPolicy
blocks only Engine egress to public COS, checkpoints the database, and proves the durable FDB
hot/staged backlog grows. It then restarts Engine while COS remains blocked, restores egress, waits
for `hot_shards=0` and `staged_hot_shards=0`, sleeps the Actor, and verifies all acknowledged writes
after a cold wake. A separate full BLOB scrub compares every restored payload with its expected
zero-filled contents so cold-wake latency is not conflated with verification cost:

```sh
python3 infra/cells/deploy/local/mesh/qualify-real-cos-outage.py \
  --kubeconfig "$MESH_STATE_DIR/runtime-a.kubeconfig" \
  --cell local-runtime-a \
  --output "${AGENTS_DIR:-$HOME/.agents}/benchmarks/local-mesh/real-runtime/runtime-a-real-cos-outage.json"
```

The `rivet_sqlite_compaction_backlog_*` gauges describe only currently executing compaction
activity; their guards return to zero after a failed attempt. They are recorded as operational
evidence but are not a durable outage-backlog oracle. The qualification uses exact FDB-backed
`hot_shards + staged_hot_shards` counts for outage persistence, and requires both those counts and
the activity gauges to be zero after recovery.

Grafana includes the Chinese `Actor Mesh / 冷层运营` dashboard. It shows cold-down throughput,
per-operation bounded concurrency and queueing, p99 queue/cold-read latency, 4 MiB object fill,
window-correlated PUT/GET requests per GiB, retries, cache paths and refill-versus-reclaim
oscillation. Federation
exports only Cell/operation/outcome aggregates; Actor, database, branch, bucket and object labels do
not cross the Cell boundary. FDB pressure is represented by the durable write-debt backpressure
counter. The dashboard does not label the currently unsampled shard-cache gauge as exact FDB hot
bytes.

The gate also fences the recovery proof itself: the Engine Pod UID must change, the database branch
ID must not change, the outage head must be newer than the requested checkpoint, and the recovered
cold and hot watermarks must exactly cover the final head. This catches a superficially healthy
recovery that silently rolls back post-checkpoint ACKs or attaches the Actor to the wrong branch.

The SQLite export crash gate creates a 256 MiB Actor database, settles every shard to real Tencent
COS, and starts a rate-limited export while writes continue. It restarts Engine after response bytes
have arrived and requires the old connection and truncated SQLite image to fail closed. After the
short qualification-only export lease expires, it downloads the new head and checks
`PRAGMA integrity_check`, the acknowledged counter, and every payload byte. The script temporarily
raises only the test Cell's write-debt allowance, verifies the running Engine loaded that allowance,
and restores the original ConfigMap even on test failure:

```sh
python3 infra/cells/deploy/local/mesh/qualify-sqlite-export-crash.py \
  --kubeconfig "$MESH_STATE_DIR/runtime-b.kubeconfig" \
  --cell local-runtime-b \
  --output "${AGENTS_DIR:-$HOME/.agents}/benchmarks/local-mesh/real-runtime/runtime-b-sqlite-export-crash.json"
```

Additional destructive data-safety gates should remain separate from this availability test:

- mutate one test-owned immutable COS object and require cold wake to fail closed, then restore the
  exact bytes and prove recovery;
- cold-drain two Actors with distinct payload digests concurrently and prove no cross-Actor reads;
- inject `PUT` success followed by client timeout and prove exactly one published reference after
  retries and Engine restart;
- hold restore-point/fork pins while deleting an Actor and prove exact-key GC cannot remove any
  reachable cold object.

Run the destructive data-safety suite against the configured Beijing COS bucket with:

```sh
RIVET_TENCENT_COS_CREDENTIAL_FILE="$MESH_STATE_DIR/tencent-cos-root.env" \
  infra/cells/deploy/local/mesh/qualify-real-cos-data-safety.sh
```

The suite mutates and deletes only content-addressed keys obtained from its own published FDB refs;
it never uses COS LIST as an oracle. It covers corrupt-object fail-closed and exact repair,
post-PUT/post-publish response loss converging to one ref and marker, reverse-order concurrent reads
of two distinct Actor branches, independent fork and restore-point pins, and branch deletion racing
an in-flight cold PUT. Logs and a machine-readable receipt are written outside Git under
`${AGENTS_DIR:-$HOME/.agents}/benchmarks/local-mesh/real-cos-data-safety/` with `RUST_LOG=warn` so AWS
SDK debug output cannot expose credential identifiers.

`failure-recovery-e2e.sh` is the destructive-but-self-recovering production-behavior gate. It
restarts the Hub controller, stops the complete `runtime-b` k3d cluster, waits for federation and
OCM to report the outage, and requires stale Cell evidence to close Pool admission. It then starts
the same cluster and proves that ManagedCluster, Claim, providerRef, ManifestWork, logical Cell and
spoke Cell identities are unchanged. A trap restarts runtime-b if the test is interrupted.

`steady-state-e2e.sh` observes longer than the 45-second local freshness window and requires both
Hub Cell timestamps and both environment-report timestamps to advance while Pool admission stays
open. This catches a broken simulator, environment reporter, OCM feedback watch or Hub mirror even
when all Pods still report Ready.

`evidence-stall-e2e.sh` stops only one spoke's Cell evidence producer while Kubernetes, OCM and
Prometheus remain healthy. It requires the freshness fence to close admission, proves no durable
placement identity changes, then restores the producer and requires Watch feedback to reopen the
Pool. This separates a silent controller stall from a whole-cluster outage.

`prometheus-outage-e2e.sh` stops only one spoke Prometheus. The local evidence producer checks a
real Ready-node query before every report, so monitoring loss must stop evidence renewal and close
admission even though Kubernetes and OCM remain reachable. Recovery must reopen admission without
recreating Claim, Work, or Cell identity.

`scale-in-retirement-e2e.sh` temporarily opens a third Cell slot, drives a real capacity-pressure
Claim through OCM, and then supplies low-load evidence only for that new Cell. It advances the
persisted observation clock to exercise the one-hour CRD minimum without sleeping for an hour,
injects an explicit external retirement receipt only after `Draining`, and requires the production
reducers to reach `Retired` and delete only the compute ManifestWork. The script verifies the two
original identities and restores the reusable two-Cell baseline on success or interruption.

`fdb-scale-down-e2e.sh` runs the production FoundationDB/TKE/CBS reconcilers against isolated API
doubles on the Hub. It constructs twelve Ready storage process groups and retained CBS identities
across three zones, asks the production controller to contract them to nine, and restarts that
controller after its removal plan is durable. The external simulator then advances only the facts
owned by FDB Operator, TKE and CSI. The gate requires one deterministic removal per zone, fresh
post-target backup evidence, full replication before MachineSet contraction, a content-addressed
scale receipt, and three Released PVs in 30-day `Quarantined` state. The test never deletes a cloud
disk and cleans its isolated namespace, Nodes, PVs and cluster-scoped fixtures on exit.

`supernode-fdb-scale-e2e.sh` closes the complementary local-real gap. It asks the official FDB
Operator to materialize the production storage-process sequence `9 -> 12 -> 9` as actual Pods on
one k3d agent, requires every intermediate generation to be reconciled, available and fully
replicated, and refuses to advance while any active process group remains missing or unhealthy.
Removed process-group tombstones may remain in Operator status, but never count as capacity. After
contraction the gate observes the Operator's 120-second recovery safety window before another
expansion. It records exact Pod UIDs and finally restores the Cell's original process count. This is
the explicit **Supernode** capacity provider: it validates Kubernetes/FDB process multiplicity and
Operator convergence while declaring `physicalFailureDomains: 1`; it does not claim AZ isolation,
CBS lifecycle or TKE Machine provisioning. By default it targets the active `-cos` Cell and writes a
hashed receipt outside Git. Override `RIVET_LOCAL_FDB_CELL` for the fault-injection Cell.

The heavy real-Pod gate is opt-in during the full suite so an ordinary laptop cannot accidentally
exhaust itself:

```sh
RIVET_LOCAL_SUPERNODE_LIVE_SCALE=1 infra/cells/deploy/local/mesh/qualify.sh full
```

`qualify.sh` is the repeatable acceptance entry point. `quick` validates API/OCM health, all Go
state machines, federation/placement, and evidence renewal across a complete freshness window.
`full` additionally runs evidence-producer loss, Prometheus loss, FDB 12 -> 9, Cell scale-in and a
complete runtime-cluster outage/recovery. Runs are mutually exclusive and fail fast; every gate has
its own log plus before/after state and immutable-identity snapshots under
`${AGENTS_DIR:-$HOME/.agents}/benchmarks/local-mesh/<UTC-run-id>/summary.json`. Destructive gates
retain their own recovery traps, and a successful suite must finish with exactly the same durable
ManagedCluster, Claim, Work and Cell identities with which it started.

Useful kubeconfigs:

```sh
export MESH_STATE_DIR=${XDG_STATE_HOME:-$HOME/.local/state}/rivet-local-mesh
kubectl --kubeconfig "$MESH_STATE_DIR/mesh-hub.kubeconfig" get managedclusters
kubectl --kubeconfig "$MESH_STATE_DIR/runtime-a.kubeconfig" get nodes
kubectl --kubeconfig "$MESH_STATE_DIR/runtime-b.kubeconfig" get nodes
```

After `infra/cells/deploy/local/ingress/up.sh`, Grafana is available directly through the selected
trusted-LAN ingress binding with anonymous Viewer access:

```sh
curl http://9.134.163.40:6688/grafana/api/health
# UI: http://9.134.163.40:6688/grafana/
```

## Validation boundary

This environment deliberately validates the control-plane boundary in layers:

- Real here: three independent Kubernetes API servers, OCM registration and ManifestWork,
  production Cell/Pool/Claim/placement reconcilers, Prometheus federation, Grafana, RBAC, controller
  restart, full spoke outage and recovery. When the optional real-data-plane layer is installed,
  this also includes the official FDB Operator, independent FDB clusters, persistent FDB PVCs,
  real FDB transactions, Rivet Engine, Depot SQLite VFS, and custom workerd processes.
- Production reducers exercised against local external API doubles: FDB 12 -> 9 planning and
  sequencing, MachineSet capacity ownership, exact PV identity, scale receipts and CBS quarantine.
- Real Supernode capacity: optional official-Operator `9 -> 12 -> 9` storage-Pod convergence in
  each runtime cluster, with exact Pod identity and restoration of the installed topology.
- Simulated external facts in the control-plane scale tests: FDB Operator data movement/status, TKE
  node realization, CSI release, COS settlement/restore evidence, and the Cell runtime workload.
  These reducers remain deliberately isolated even when the optional live local data plane is
  installed; local FDB availability is not substituted for the scripted 12 -> 9 proof sequence.
- Requires a cloud gate: multi-host/AZ network partitions, real TKE node replacement, FDB process
  replacement and exclusion, FDB TLS, CBS attach/detach/quarantine, COS access-path consistency and
  durability, and runtime isolation/performance.

The simulator annotation and this boundary are part of the acceptance contract: a locally Ready
Cell must never be reported as production-qualified solely from this fixture.
