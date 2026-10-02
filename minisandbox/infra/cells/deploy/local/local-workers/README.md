# One-command local Workers stack

This entry point assembles the self-contained three-cluster product path. Hub C runs OCM, fleet
control, observability, the Workers API, the code Registry, and the persistent local S3 double.
Runtime Cells A and B each run an independent FDB cluster, Engine, NATS, durable workerd Host, and
an independently authenticated stateless executor.

```sh
infra/cells/deploy/local/local-workers/up.sh
infra/cells/deploy/local/local-workers/verify.sh
infra/cells/deploy/local/local-workers/qualify.sh all
infra/cells/deploy/local/local-workers/down.sh --destroy
```

`up.sh` is idempotent and preserves existing PVCs. One atomic
[`StorageProfile`](../mesh/storage-profiles/local-workers.json) selects the FDB cluster, cold bucket,
endpoint, object layout, maximum object size, and recovery window for both Cells. The default v1
profile binds `local-runtime-*-storage-v1` FDB clusters to `local-runtime-*-cold-v1` buckets. Scripts
do not accept independent FDB or bucket overrides because a partial switch can strand authoritative
object references. By default it runs the runtime A cold-recovery qualification after provisioning. Set
`RIVET_LOCAL_SKIP_COLD_QUALIFICATION=true` only for a quick development bring-up.

Cold objects retain the canonical, hash-distributed key layout below. Environment, region, and Cell
isolation belong in the bucket selected by `StorageProfile`; no common prefix is inserted ahead of
the hash fanout:

```text
<hash4>/cold/v2/<branch-id>/<shard>/<txid>/<generation>/<content-hash>.cold
```

The qualification proves a real Actor path: SQLite writes are acknowledged by FDB, a checkpoint is
published through Depot to the local S3 protocol double, Engine is replaced, the Actor sleeps, and
the next request restores and verifies every byte from cold storage. Receipts are stored outside the
repository under `$MESH_STATE_DIR/local-workers/receipts`. It also runs the permanent
`stateless-durable-routing-e2e`: ordinary fetch, immutable placement in both Cells, same/cross-Cell
Durable Object binding calls, direct ObjectRef convergence, sleep/wake, and stateless Pod replacement.
The same command also runs `stateless-capacity-provider-e2e`: 60 real held fetches drive the
production in-flight metric, HPA, an unschedulable Pod, startup-tainted k3d Node creation,
exact-image admission, normal Pod drain, and UID-fenced Node deletion back to the one-node baseline.
The central `workers-api-autoscaling-e2e` then drives held user fetches through Hub Prometheus and
`custom.metrics.k8s.io`, proving that the regional Router scales `3 -> 4 -> 3` without any script
writing the Deployment replica count. The following HA gate remains valid if the HPA starts above
three: it treats three as the floor and exercises the complete current replica set.
