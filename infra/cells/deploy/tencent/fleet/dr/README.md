# Production Cell disaster-recovery qualification

This directory contains the reviewed, isolated restore target for
`actor-bj-k01`. The target is intentionally a compact three-process FDB cluster
spread across three availability zones. It proves backup recoverability without
duplicating the production cluster's nine 200 GiB volumes or receiving live
production traffic.

The restore version in `restore-from-continuous.yaml` is an immutable point-in-
time value captured from `fdbbackup describe`. Refresh it deliberately for a new
drill; never silently restore "latest" when recording RPO.

The retained CBS volumes are not automatically deleted. Preserve the restore
receipt and explicitly review the PVC/PV names before cleanup.

For an existing restore target, expand each bound PVC directly and wait for
its reported capacity and mounted filesystem to grow. Do not apply a changed
`volumeClaimTemplate` during a restore: FoundationDB Operator treats that
template change as a process-group replacement. The checked-in 40 GiB request
is the creation-time size for subsequent drills.

`restore-agents.yaml` supplies three temporary `backup_agent` processes (one per
AZ) that execute the queued restore. Agent count controls restore throughput,
not correctness; the qualification Cell must not require nine GiB of idle
ordinary worker capacity merely to enter a DR drill. They use ordinary worker
capacity (the FDB node-pool taint excludes them) and must be removed after the
restore reaches a terminal state and its evidence has been captured.

`seed-and-freeze-actors.sh` creates a retained DR probe set through the real
Engine/workerd path, records the online SQLite checksums, then leaves every
Actor asleep and fully cold. Its final source FDB read version is the lower
bound that `MaxRestorableVersion` must cross before the final restore starts.

After starting the immutable restore exactly once, run
`complete-isolated-restore.sh`. It only observes the existing restore tag and
UID, waits for the isolated FDB cluster to become fully replicated and
reconciled, and then runs the pinned Actor SQLite verifier. It never starts or
retries a restore, so a failure leaves the target and evidence intact.

FoundationDB Operator v2.34.0 starts restores with the fixed `default` restore
tag and only calls `fdbrestore start` when that tag has no status. An aborted
`default` tag therefore makes a replacement Restore CR look idle. The current
drill starts one uniquely tagged restore from a credentialed temporary
`backup_agent` Pod and binds the tag, UID and version in the receipt; never
delete and recreate the CR as an implicit retry.

`set-fdb-drill-capacity.sh 10` creates one temporary Native-node spare only
after the source FDB and continuous backup pass their production gates. It
waits for the MachineSet and all Nodes, then proves `ZoneEquality`. Use the
spare for the exact-node replacement drill and return to nine with the same
script only after the replacement process group is fully replicated.

`qualify-zone-recovery.sh` is the bounded isolated-restore node-recovery drill.
It takes a Kubernetes zone at run time (`DRILL_ZONE`) to select one storage Pod,
then cords only that Pod's dedicated node, normally deletes the exact Pod, and
always uncordons that exact node in a shell `trap`. It refuses to operate if
that node also hosts an FDB process from another cluster. It then waits for
three Ready storage Pods in three Kubernetes zones and for FDB `Available`,
`FullReplication`, and reconciliation. Run it only with an explicit
`DRILL_EXECUTE=true` and preserve its JSON receipt with the rest of the restore
evidence. The drill is intentionally narrower than a real cloud-AZ power or
network outage: the DR cluster shares a dedicated node pool with production,
so a whole-zone cordon requires a separately isolated pool or explicit
production-AZ-failure authorization.

`qualify-primary-az-loss.sh` is the primary-Cell synthetic AZ-loss gate. It
requires both `AZ_LOSS_EXECUTE=true` and `AZ_LOSS_ALLOW_PRIMARY=true`, checks
the nine storage Pods are 3/3/3 and the continuous backup is restorable, then
adds a temporary `NoExecute` taint to every dedicated FDB node in the selected
Kubernetes zone. That lets Kubernetes evict the processes as an involuntary
node disruption without directly deleting Pods or bypassing the FDB PDB. A
surviving-zone FDB client continuously writes an isolated key prefix; the
script records failures, latency, health transitions and recovery time, then
removes both the taints and the probe keys. Its `trap` removes taints on every
exit path. This is a real process-loss test but remains synthetic: it is not
proof of a cloud-zone power or network outage.
