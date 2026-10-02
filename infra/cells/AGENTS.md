# Actor fleet operating instructions

These instructions apply to `infra/cells` in the Rivet monorepo. Rivet runtime source lives under
`runtimes/`; do not copy independent upstream repositories, build trees, credentials, or live
qualification state into this directory.

## Standard entry points

- Read `deploy/tencent/fleet/README.md` before changing a Cell.
- Run `deploy/tencent/fleet/tat/test-tat-tools.sh` after changing a TAT helper.
- Use `deploy/tencent/fleet/tat/tat-run.sh` for commands on a Tencent builder that is
  reachable through TAT. Do not duplicate `tccli tat RunCommand` polling loops.
- If a client disconnects after `RunCommand`, resume the immutable invocation with
  `deploy/tencent/fleet/tat/tat-wait.sh`; do not launch the mutation again blindly.
- Use `deploy/tencent/fleet/tat/tat-upload.sh` for bounded file transfer through TAT.
- Use `deploy/tencent/fleet/tat/tat-download.sh` to retrieve receipts and logs through
  bounded TAT output chunks with byte-count and SHA-256 verification.
- Run `deploy/tencent/fleet/runtime/build-image.sh` on the builder to build and push the
  unified Engine/workerd-host/workerd image.
- Generate warm-tree overlays with `runtime/bundle-source-delta.sh` and apply them with
  `runtime/apply-source-delta.sh`; never copy a remembered subset of files. The build must verify
  the resulting per-file source manifest before Cargo runs.
- Provision three-zone control capacity through
  `deploy/tencent/fleet/tke-native-control-nodepool/install.sh`, then Actor compute capacity through
  `deploy/tencent/fleet/tke-native-runtime-nodepool/install.sh`. Engine/NATS must select only the
  control pool; workerd/sbxlet must select and tolerate only the compute pool. Both Node
  Ready/topology gates are stricter than the cloud MachineSet replica count.
- Release the dedicated FDB Native-node autoscaling envelope through
  `tke-native-nodepool/release-envelope.sh`, then qualify the complete 9 -> 12 -> 9 chain with
  `autoscaling/qualify.sh`. The gate must finish by running `autoscaling/verify_receipt.py`; do not
  replace it with manual FDB, MachineSet, or CBS edits.
- Deploy production only through `deploy/tencent/fleet/runtime/release-runtime.sh`. It must
  validate the immutable image against the rendered production config before it delegates to
  `install.sh`, and it must restore the pre-release ConfigMap/workload revisions on failure.
- Qualify the real Actor path with `deploy/tencent/fleet/runtime/qualify-runtime.sh`; retain
  the JSON receipt and its SHA-256.
- After the Actor data-path gate is idle, run
  `deploy/tencent/fleet/runtime/qualify-engine-ha.sh`; it must delete one exact Engine Pod
  under continuous Service traffic, report zero request failures, and restore three cross-zone
  replicas. Do not run this fault drill concurrently with a port-forwarded runtime qualification.
- Install and verify the one-per-TKE-cluster monitoring plane with
  `deploy/tencent/fleet/observability/install.sh` and `observability/verify.sh`. Never install
  or upgrade it while a production runtime rollout or qualification is active.
- For any autonomous high-risk workflow use
  `deploy/tencent/fleet/operations/run-autonomy-ops-cycle.sh`; it holds one shared operation
  lock from pre-audit through post-audit. Do not recreate a short-lived `flock` assertion around
  a long rollout or qualification: that lock is released before the mutation begins.
- Bootstrap the Tencent builder's pinned Helm binary with
  `deploy/tencent/fleet/tat/install-helm.sh`, then cold-seed every third-party runtime image with
  `deploy/tencent/fleet/gitops/image-seed/seed-tcr.sh`. Retain its receipt and assemble the full
  28-repository lock before installation. Do not run a component-only mutable-tag mirror or patch
  individual failed Pods to public mirror URLs.

## Project topology and established evidence

This repository contains the production-directed Rivet storage fleet and its
Go management/evidence binaries. The former Go/Relay durability laboratory has
been removed and is not an alternate deployment path.

```text
                         management / evidence plane
 TKE API + TKE MachineSet + actor-fleet-controller + FDB Operator
             + cluster Prometheus/Grafana + autonomy control
                                  |
                                  v
                    one independently operated RivetCell
 client -> Engine Deployment (3) -> NATS PubSub (3, non-durable)
                                  |
                         runtime-host StatefulSet (3)
                                  |
             Actor SQLite / Depot -> FoundationDB (hot, ACK authority)
                                      |
                         immutable COS cold objects + FDB backup
```

- A `RivetCell` is the storage and failure-domain unit: one exclusive FDB
  cluster, one COS policy domain, and its Engine/runtime capacity. It is not an
  Actor, and a growing fleet adds Cells rather than treating one global FDB
  cluster as infinitely scalable.
- The production SQLite path is `SQLite -> Depot -> FDB ACK`, with COS as the
  immutable cold tier and backup target. Do not reintroduce Relay, etcd or
  Litestream as a parallel commit authority.
- FDB data capacity uses the official FDB Kubernetes Operator on a dedicated
  TKE Native-node envelope. TKE owns Machines, the Operator owns FDB
  process-group movement, and the fleet controller owns bounded Cell policy;
  no layer may perform another layer's mutation directly.
- Engine is a replaceable six-replica Deployment; runtime hosts are a
  three-replica StatefulSet only for operational slots. Neither is durable
  Actor truth: FDB/Gasoline generation fencing establishes the one live owner.
- Prometheus/Grafana is one private, cluster-level monitoring plane, never one
  stack per Cell. `operations/` turns health, receipt freshness, alerts and
  forecasts into an auditable `allow` / `degrade` / `block` control decision.

The following are achieved **evidence**, not timeless promises and not a
substitute for continuing receipts:

- a real production Bottomless qualification has bound immutable runtime image,
  rendered manifest and six workload Pod UIDs while proving online checkpoint,
  cold publish/reclaim, cold wake, write-debt crossing, cleanup and SLOs;
- Engine HA has been qualified by deleting one exact steady-state Engine Pod
  under continuing traffic, with replacement and cross-zone restoration;
- the primary Cell has completed a controlled synthetic one-zone node-loss
  drill and returned FDB to balanced `3/3/3`. This is evidence for Kubernetes
  node unavailability, **not** proof of a Tencent physical AZ outage;
- FDB elastic capacity has completed a real `9 -> 12 -> 9` Operator/TKE chain.
  The three released CBS disks enter a 30-day logical quarantine before any
  independent Disk GC may delete them;
- low-cardinality cold-tier, queue, FDB, Engine/runtime and capacity-forecast
  metrics, alert rules, dashboards, receipt verification and a five-minute
  builder-side autonomy audit/control timer are installed for the first Cell.

Read the following before selecting a path:

| Need | Authoritative location |
| --- | --- |
| Production FDB/COS Cell, release, evidence and operations | `deploy/tencent/fleet/README.md` |
| FDB process/node elasticity and retained CBS handling | `deploy/tencent/fleet/autoscaling/` |
| Bottomless image release and Actor/Engine qualification | `deploy/tencent/fleet/runtime/` |
| Primary/isolated restore DR drills | `deploy/tencent/fleet/dr/` |
| Cluster-level telemetry, alerts and forecasts | `deploy/tencent/fleet/observability/` |
| Continuous autonomy audit, policy and serialized operation lock | `deploy/tencent/fleet/operations/` |
| Kubernetes Cell policy and evidence reporter | `cmd/actor-fleet-controller/`, `cmd/rivet-cell-reporter/`, `internal/fleetcontroller/`, `internal/cellreporter/` |

## Tencent access and secrets

- Credentials come from `TENCENTCLOUD_SECRET_ID`, `TENCENTCLOUD_SECRET_KEY`, a short-lived role,
  or an existing protected kubeconfig/Secret. Never put credentials, TCR tokens, kubeconfig
  contents, or runtime auth tokens in source, receipts, command output, or Git history.
- Set `TAT_INSTANCE_ID` and optionally `TENCENT_REGION`; the TAT helpers fail closed when they are
  absent.
- TAT reports `TaskResult.ExitCode=0` while a task is still running. Always gate completion on
  `TaskStatus`, as the repository helper does.
- For a public TKE endpoint behind a CLB, connect to the CLB IP while setting kubeconfig
  `tls-server-name` to the cluster domain. If the public gateway still rewrites TLS, operate from a
  same-VPC builder with the intranet kubeconfig.

## State ownership and workload-kind invariants

- Do not equate a stateful product contract with Kubernetes `StatefulSet`. Workload kind is an
  operational mechanism; correctness comes from explicit durable truth, leases, generations, and
  fencing. Changing a Deployment to a StatefulSet does not create replication, failover, or
  exactly-one ownership.
- FDB/Gasoline is the durable source of truth for Actor catalog, workflow, lease, generation,
  current SQLite head, and cold-object references. Bottomless SQLite durability is the exact
  composition of the FDB hot tail plus immutable COS cold objects named by those references.
  Engine, NATS, runtime-host local filesystems, Pod names, and node names must never become an
  independent authoritative copy. Local runtime state is disposable.
- Engine is a six-replica Deployment. It has no stable identity, owns no Actor, and must remain
  replaceable during traffic. Every replica uses the same FDB/Gasoline state and the shared NATS
  PubSub plane. A release is invalid unless deleting one exact steady-state Engine Pod under new
  Service connections produces zero request failures, preserves a subsequent SQLite write, and
  restores three cross-zone replicas.
- Actor execution ownership belongs to exactly one live runtime-host process for one generation.
  Rivet creates a fresh Envoy UUID on every host-process start; do not derive it from a Pod name,
  StatefulSet ordinal, PVC, or node name. A replacement acquires a new generation, and generation
  fencing must reject the stale process. This fresh identity prevents ABA and ghost-owner reuse.
- Runtime hosts use a three-replica StatefulSet for stable operational slots, deterministic
  observation, and controlled rollout. The ordinal is not the Actor owner and must not appear in a
  correctness key. There is no runtime PVC. A future switch to Deployment is an operational design
  change, not a state-model change, and still requires the same one-live-generation proof.
- NATS uses a three-member StatefulSet only because clustering needs stable route DNS. It has no
  PVC and contains no durable Actor truth. Loss of NATS may interrupt coordination, so its
  three-zone mesh and PDB are availability gates; restoration must come from configuration and
  FDB-backed workflows, never from persisted NATS state.
- Scale the layers independently: Engine replicas add coordination/API capacity, runtime hosts add
  Actor execution capacity, FDB process groups add durable throughput/capacity, and COS holds cold
  immutable data. Never couple these into one replica count or migrate Actor ownership merely to
  scale Engine.
- Control and Actor execution workloads must not share worker nodes. Control Pods select
  `fleet.actor.dev/control-pool=true`; Actor execution Pods select `rivet.dev/compute=true`, and
  compute nodes carry `rivet.dev/compute=true:NoSchedule`. Only an independently qualified node
  with a usable `/dev/kvm` may additionally advertise `rivet.dev/pvm=true`; standard cloud VM
  capacity must never be relabelled as PVM-capable without that proof.
- Admission evidence must match the state boundary. Pod readiness proves only process readiness;
  Engine fault traffic proves replaceability; exact host registries prove single-owner placement;
  sleep/wake and host-loss drills prove generation fencing and FDB recovery; Bottomless receipts
  prove checkpoint, write-debt, COS, cold-read, and recovery-admission behavior.

## Cell safety contract

- Never force-delete FDB Pods, PVCs, backups, or runtime Pods to speed up an operation. Respect
  PDBs, StatefulSet `OrderedReady`, and the configured termination grace period.
- A disaster-recovery restore that shares dedicated FDB nodes with the primary
  Cell may run only bounded Pod/node recovery drills on a node verified not to
  host a primary FDB process. Every temporary cordon must be undone by a
  failure-safe `trap`. Do not call that a whole-AZ failure test: an AZ drill
  needs an isolated restore node pool or explicit authorization for a
  controlled primary-cell fault.
- Physical backup restore is an explicit, operator-triggered DR exercise, not a per-Cell
  admission gate. Initial qualification, autoscaling qualification, continuous qualification,
  placement admission, and automated Cell provisioning must neither invoke a physical restore nor
  require a physical-restore receipt. A missing, stale, or failed exercise receipt must not block
  placement. Keep the restore implementation and verifier available, and rerun the exercise only
  when the storage format, backup implementation, or restore implementation changes, or when an
  operator explicitly requests a DR rehearsal. Never silently promote this exercise back into an
  automated qualification chain.
- FDB nodes are dedicated; runtime Pods must not tolerate the FDB taint. Placement uses Kubernetes
  zone/hostname topology semantics, never hard-coded AZ names in base manifests.
- FDB capacity automation owns policy and the exact dedicated MachineSet replica target, not data
  movement. It may change only the desired storage process count and matching node target in
  multiples of three; the official FoundationDB Kubernetes Operator exclusively creates, excludes,
  drains, and removes process groups, while TKE owns Machine lifecycle and `ZoneEquality` placement.
  Before lowering a `three_data_hall` process target, persist an exact removal set that leaves equal
  process and coordinator candidates in all three Kubernetes zones. Do not rely on the Operator's
  implicit shrink ordering: a missing locality field can make it choose an unbalanced set even from
  a 4/4/4 source topology. The explicit set selects the victims; it never bypasses Operator exclusion
  or data movement.
  Scale down must finish Operator exclusion and full-replication gates before TKE removes empty
  nodes. The dedicated MachineSet must retain `deletePolicy: Newest`, and the persisted per-zone
  removal plan must select the newest steady-state Pod/node in each zone so MachineSet contraction
  targets the same empty Machines. Never let Cluster Autoscaler evict a live FDB Pod.
  MachineSet capacity is shared by every FDB cluster in the Cell namespace, including temporary
  disaster-recovery restores. Its target is the primary process target plus all auxiliary storage
  processes, rounded up to a multiple of three; never contract it to the primary count alone.
- Before any FDB scale down, persist a complete ProcessGroup -> PVC UID -> PV UID -> CBS disk ID
  inventory. Retained CBS volumes enter a logical quarantine only after the PVC is gone, the PV is
  Released, and the disk is unattached. The production default retention is 2,592,000 seconds
  (30 days). Volume GC starts in ObserveOnly and no controller may receive disk-delete permission
  until a real 9 -> 12 -> 9 qualification proves the inventory, receipt, backup, and recovery gates.
- Prometheus and Grafana are cluster-level infrastructure, not per-Cell workloads. Run one stack
  per TKE cluster, keep it off FDB-dedicated nodes, use retained CBS for its state, and expose no
  public ingress by default. Metrics may identify bounded operational topology such as Cell, Pod,
  node, and operation; they must never label Actor, database, branch, bucket, request, or object IDs.
- Build one unified runtime image, execute its container self-checks, push it, record the registry
  digest, then roll Engine and all runtime hosts to that digest.
- A source revision label is not source-integrity evidence by itself. Bind the image to a reviewed
  changed-file manifest, embed both revision and manifest hash, and require the exact built image
  to deserialize and validate the exact rendered production config before any workload mutation.
- Preserve the six-replica Engine HA contract: preferred hostname/zone anti-affinity, hard
  three-zone spread with two steady replicas per zone, PDB `minAvailable: 4`, and rolling
  `maxUnavailable: 0` / `maxSurge: 1`.
  Keep the Engine `preStop` endpoint-drain window; deleting a Pod without it can race kube-proxy
  propagation and expose a terminating backend to otherwise valid new requests.
  A surge can leave 2/1/0 after an old Pod in another zone is removed; topology spread does not
  rebalance a finished rollout. Do not count
  a temporary rollout surge as HA and do not change the Deployment back to `Recreate` or one
  steady-state replica. Engine remains a Deployment because durable catalog/workflow/lease state
  is in FDB/Gasoline; all Engine and workerd processes must use the shared three-member NATS
  PubSub plane. Never use process-local `memory` PubSub with more than one Engine replica. NATS
  is a StatefulSet only for stable route DNS and has no PVC or durable Actor truth. The three
  runtime hosts remain a StatefulSet for stable operational slots and controlled rollout, not to
  persist ownership: every process start receives a fresh Envoy UUID. Actor generation/fencing,
  not an Engine Pod identity or StatefulSet ordinal, enforces one live owner and prevents ABA.
- Before and after a runtime rollout, require the FDB cluster to be Available, fully replicated,
  and reconciled, and require the continuous backup to be Restorable.
- Do not run qualification during a rollout. The Bottomless gate must prove online checkpoint
  continuity (writes after the first checkpoint and reads during the final checkpoint), exact
  checkpoint-target cold state, cold-read SLO, bounded recovery admission, generation advance,
  data integrity, and exact cleanup. COS sinking must never close Actor admission; FDB write-debt
  pressure may delay a commit but must not surface as an Actor SQLite error.
- Prove online service and exact ownership before sleep, then release runtime-local shard pins and
  require exact cold-only state before the synchronized wake. Requiring zero hot rows while a live
  VFS still legitimately pins its current shard is an invalid and nondeterministic gate.
- Treat force reclaim only as an immediate wake of Depot's normal bounded planner. It must never
  bypass cold-object publication, exact hashes, lifecycle generations, retention/history pins, or
  FDB transaction budgets. Keep its request explicit and its acceptance visible in qualification
  evidence; configure the periodic cadence with `RIVET_DEPOT_RECLAIM_INTERVAL_MS`. A checkpoint
  requested while an Actor is live may legitimately finish reclaim as a pin-related no-op, so the
  production gate must issue and record a second bounded force-reclaim request after every Actor is
  asleep and the exact host registries have returned to baseline.
- The formal Bottomless claim requires more than a successful harness exit. At least one exact
  qualification database must report no logical byte limit and grow beyond the configured transient
  FDB write-debt limit, not merely beyond its compaction target. The cold-wake wave must queue on all
  three runtime hosts, stay within every host's in-flight/queue peaks, drain to zero, and record no
  rejection or timeout. Only a `production-qualification` receipt accepted by
  `runtime/verify_bottomless_receipt.py` is claim-eligible.
- Bind every production qualification to the immutable runtime image digest, rendered-manifest
  hash, and exact six Engine plus every desired runtime-host Pod UID before and after the workload. Any
  rollout, Pod replacement, mutable image, or manifest change during the run invalidates the receipt.
  The Engine/runtime primary containers must share that runtime digest. Auxiliary containers such as
  metrics sidecars may use a different pinned digest, but their name and digest must also be captured
  in the release binding and remain unchanged; never weaken the binding by pretending they are runtime
  containers or by omitting them.
- Keep the daily feedback loop short without forking the correctness path. `e2e-fast` must run the
  same checkpoint/cold/wake/recovery state machine with smaller data, shorter cold-settle ceilings,
  and lower admission waterlines. Timing, write-debt, and recovery-admission values are runtime
  configuration selected through environment variables and rendered into the typed ConfigMap;
  changing them must not require a binary rebuild. Stamp fast receipts as development evidence and
  never use them to open production admission. The hour-scale `production` qualification is a
  release gate and may run asynchronously instead of blocking ordinary iteration.
- Submit hour-scale Tencent release gates with `deploy/tencent/fleet/tat/tat-run.sh --detach`; preserve the
  returned invocation ID and resume or collect that exact invocation. A lost local waiter never
  authorizes submitting a duplicate qualification.
- Follow detached Bottomless gates with `runtime/monitor-bottomless-qualification.sh`; its default
  five-minute cadence keeps long waits quiet, then downloads, hashes, and verifies the terminal
  receipt. Do not replace it with high-frequency status or progress polling.
- The Beijing builder has a legacy native listener on `127.0.0.1:18081`; qualification reserves
  local ports `28081-28083` for Kubernetes port-forwards.

## Release order

1. Run focused unit/integration tests and formatting checks locally.
2. Transfer only reviewed source/deploy artifacts; verify local and remote SHA-256.
3. Build with a locked Cargo graph, create the OCI image, and use the registry-reported digest.
4. Roll out safely and re-check FDB, backup, topology, images, and readiness.
5. Run the real cloud Bottomless qualification and the independent one-Engine-loss HA drill;
   preserve both immutable receipts. Do not add physical restore to this admission sequence; it is
   a separately initiated DR exercise under the Cell safety contract above.
6. Commit the implementation, runbook changes, and non-secret receipt together. Never declare a
   Cell placement-ready from probes or manifests alone.
