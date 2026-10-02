# Runtime Node admission and image preparation

Runtime Node admission is a scheduling-eligibility decision for one exact
cloud Machine and Node identity. It is not Kubernetes API admission, workload
readiness, or a release rollout.

## Field ownership

| State | Sole writer |
| --- | --- |
| Runtime StatefulSet scale-up | HPA |
| Host placement fence and StatefulSet scale-down | Host-drain controller |
| Runtime MachineSet scale-up and runtime scale-in taint | Runtime-capacity controller |
| Exact normal scale-down intent | Runtime-capacity controller |
| Exact normal Machine termination plus pool contraction | TKE `DeleteClusterMachines` API through a cluster-scoped CAM identity |
| Other Machine and Node lifecycle | TKE MachineSet controller |
| MachineSet birth admission taint | Terraform/Argo MachineSet template |
| Concrete Machine admission taint and Node admission taint, label and annotation | Runtime-capacity admission reconciler |
| Candidate runtime image preparation | Runtime release workflow |
| Probe exit status | Tokenless, node-pinned probe Pod |

The admission reconciler runs in the existing runtime-capacity-controller
process. The probe Pod has no Kubernetes token and cannot admit itself. Node
admission never writes `spec.unschedulable`, StatefulSet replicas, MachineSet
replicas, or Host drain state.

## Admission invariants

1. Every runtime Machine starts with
   `fleet.actor.dev/runtime-admission=pending:NoSchedule`. Workerd does not
   tolerate that taint.
2. An attempt binds Node UID, provider ID, Machine UID, MachineSet UID, the
   compiled Node profile digest, and the current immutable runtime image.
3. The controller accepts only the exact probe Pod UID that it persisted for
   the attempt. A replacement Pod or Node cannot inherit the result.
4. TKE continuously derives Node taints from the concrete `Machine.spec.taints`.
   Opening the scheduling fence therefore uses two ordered, UID/resource-version
   guarded JSON patches: first remove the exact pending taint from the concrete
   Machine, then write admitted evidence and `runtime-admitted=true` while
   removing it from the Node. A crash between the writes leaves the Node fenced.
   Closing the fence reverses the order: fence the Node first, then restore the
   concrete Machine taint. The MachineSet template always retains the birth
   taint for future Machines.
5. A draining or deleting Node cannot transition to admitted. A late probe
   success is ignored and the attempt becomes cancelled.
6. Invalid or unknown admission state is fail-closed: the admitted label is
   removed and the pending taint is restored before the reconcile reports an
   error.
7. Executable, image-pull, DNS, and timeout failures are blocked and retried
   with bounded backoff because they may be fleet-wide; they do not authorize
   Machine deletion. Only a persistent, directly observed Node pressure
   condition enters quarantine automatically.
8. At most one repair-surge Machine may be requested. Generic MachineSet
   contraction is forbidden while a quarantined Node exists because it cannot
   prove which Machine TKE will delete.
9. An admitted Node remains admitted across a runtime release. The release
   workflow separately pulls and executes the candidate digest on every
   compute Node before changing a workload template.
10. Shared FDB, COS, NATS, or Engine health is a Cell admission concern and
    must never classify a Node as defective or trigger replacement churn.
11. The Cell-local provider qualification owns one exact, CAS-protected MachineSet
    hold while its empty surge Machine exists. The hold suppresses only
    scale-down; demand-driven scale-up and Node admission continue.
12. Normal scale-down never decrements `MachineSet.spec.replicas`. TKE has
    demonstrated that a generic decrement may delete a different, busy
    Machine even with `deletePolicy: Newest`. StatefulSet placement is also
    independent of Machine creation order, so the newest Machine is not
    necessarily the one emptied by Host drain. The controller inspects the
    complete bounded inventory, prefers the newest proven-empty Machine, then
    persists its exact Machine/Node/MachineSet UID tuple, fences and rechecks
    that Node, and invokes `DeleteClusterMachines` with that one Machine name
    and `EnableScaleDown=true`. If no Machine is provably empty, scale-down is
    blocked.
13. `prepared` is reversible and is cancelled by new HPA demand. `issued`
    means the provider request may have escaped the process; it is never
    cleared until both the exact Machine and Node disappear and the pool
    desired count reaches the recorded target. Because this API has no
    caller-supplied idempotency token, any persisted attempt—whether or not a
    RequestId was received—is never submitted twice.

The durable state is the strict JSON value in
`fleet.actor.dev/runtime-admission-state`. Node name and StatefulSet ordinal
are observations only and never identity.

Normal scale-down additionally persists
`fleet.actor.dev/runtime-capacity-downscale-intent` on the exact MachineSet.
Its Machine UID, Node UID, MachineSet UID, source/target replica counts,
attempt timestamp and provider RequestId are the recovery record across
controller restarts and ambiguous HTTP responses.

## Exact normal scale-down workload identity

The capacity controller must not receive a root or general TKE credential.
Each production Cell Terraform module enables the managed TKE OIDC issuer/provider and defines
one CAM role whose only policy statement is `name/tke:DeleteClusterMachines`
on the exact Cell cluster resource. Its trust policy accepts only that Cell's
`system:serviceaccount:actor-fdb-cell-system:<cell>-runtime-capacity` with
audience `sts.cloud.tencent.com`. The PodSpec directly declares a projected,
short-lived ServiceAccount token, its read-only mount and the four SDK
environment variables; it therefore does not depend on the availability or
mutation behavior of `pod-identity-webhook`. The controller exchanges the token
for temporary CAM credentials. No
long-lived AK/SK is stored in a Kubernetes Secret, Terraform output, manifest,
image layer, TAT payload, or runtime Host.

Enable the capability only after the OIDC role and provider qualification are
present:

```bash
RUNTIME_EXACT_SCALE_DOWN_ENABLED=true \
RUNTIME_TKE_CLUSTER_ID="$exact_cluster_id" \
RUNTIME_TKE_OIDC_ROLE_ARN="qcs::cam::uin/$account_uin:roleName/${cell}-runtime-scale-down" \
  ./deploy/tencent/fleet/runtime/install.sh
```

Missing projected identity, STS exchange failure, a changed
cluster/MachineSet/Machine/Node identity,
malformed provider response, foreign workload, or partial provider convergence
all fail closed. The qualification hold must remain set until a cloud test
proves that the recorded candidate disappears, every non-candidate Machine UID
survives, no busy Host is removed, and the pool converges by exactly one.

## Safe rollout order

Apply in this order:

1. Apply the Cell's runtime MachineSet overlay so all subsequently created Nodes
   receive the pending taint at birth.
2. Install the updated runtime-capacity controller with the intended immutable
   runtime digest and its least-privilege namespaced Pod permissions. The
   bootstrap digest lets admission run before the runtime StatefulSet exists.
3. Wait until every current runtime Node has exact admitted evidence and no
   pending admission taint. Adding `NoSchedule` to an existing Node does not
   evict its current Host during this backfill.
4. Install or update the runtime StatefulSet. Its hard node affinity requires
   `runtime-admitted=true` independently of the pending taint.
5. Enable load-driven HPA/MachineSet expansion.

For production Cells, `runtime/install-admission-controller.sh` enforces steps
1 through 3 and is invoked automatically by `runtime/install.sh`. The historical q01
qualification environment uses `install-workerd-autoscaling.sh`, which invokes
the same controller first and then owns only its HPA/drain fixtures. Both refuse to install when
the MachineSet template lacks the birth fence and wait for exact durable
Node/Machine admission evidence.

## Remaining provider qualification

Automatic removal of a quarantined Machine stays disabled until the exact Cell proves
that deleting one exact TKE `Machine` with a UID precondition removes that
Machine rather than an arbitrary member. Until then the controller retains the
isolated Node and its one-Machine repair surge. This is intentional fail-closed
behavior, not a manual deletion instruction.

The provider qualification creates one empty repair-surge Machine, waits for
its exact admission, deletes that Machine with a UID precondition, and requires
the complete baseline Machine UID set to survive unchanged:

```bash
RIVET_CELL_NAME="$cell" \
KUBECONFIG="$cell_kubeconfig" \
QUALIFICATION_RECEIPT=/data/actor-fleet/receipts/runtime-machine-repair.json \
  ../operations/with-autonomy-operation-lock.sh -- \
  ../qualification/actor-bj-q01/qualify-runtime-machine-repair.sh

../qualification/actor-bj-q01/verify-runtime-machine-repair-receipt.py \
  --expected-cell "$cell" --expected-machine-set np-runtime0 \
  /data/actor-fleet/receipts/runtime-machine-repair.json
```

The runtime MachineSet must use `deletePolicy: Newest`. This is part of the
safety proof, not a placement preference: if TKE creates a replacement between
the exact UID-preconditioned Machine delete and the repair-surge contraction,
that new empty Machine is the only surplus candidate. A missing or changed
policy makes the capacity controller fail closed.

`ZoneEquality` is not treated as capacity evidence. A cloud burst or a
temporarily unavailable subnet can leave an otherwise Ready MachineSet skewed
across zones. The capacity controller derives the number of runtime Hosts that
the admitted Node topology can actually schedule under `maxSkew: 1`. When that
number is below the StatefulSet target, it requests at most one additional
Machine per provider convergence and re-evaluates the observed zones. It never
relaxes the hard spread constraint, counts a pending/unadmitted Node, or deletes
a Machine as part of this availability correction. Surplus contraction remains
the independently qualified UID-fenced scale-down path.

Host drain is fail closed as well. An unreachable management endpoint, a
malformed stats response, a non-zero active/in-flight/queued counter, or a Pod
that remains terminating past the timeout never authorizes eviction or Machine
deletion. The quarantined Node remains fenced and the single repair surge stays
available; only an exact quiescence proof advances automatic replacement.

The receipt schema is bound to the Kubernetes cluster UID and MachineSet UID,
so a receipt from a deleted/recreated cluster cannot grant destructive
authority to its replacement. Only a verified passing receipt permits adding
`delete` to the controller's exact Machine RBAC and setting
`RUNTIME_CAPACITY_TARGETED_REPAIR_ENABLED=true`:

```bash
RIVET_CELL_NAME="$cell" \
KUBECONFIG="$cell_kubeconfig" \
RUNTIME_MACHINE_REPAIR_QUALIFICATION_RECEIPT=/data/actor-fleet/receipts/runtime-machine-repair.json \
QUALIFICATION_RECEIPT=/data/actor-fleet/receipts/runtime-automatic-repair.json \
  ../qualification/actor-bj-q01/qualify-runtime-automatic-replacement.sh

../qualification/actor-bj-q01/verify-runtime-automatic-repair-receipt.py \
  --expected-cell "$cell" --expected-machine-set np-runtime0 \
  --provider-receipt-sha256 "$(sha256sum /data/actor-fleet/receipts/runtime-machine-repair.json | cut -d' ' -f1)" \
  /data/actor-fleet/receipts/runtime-automatic-repair.json

# Fail-closed rollback removes Machine delete RBAC before the old Pod exits.
RIVET_CELL_NAME="$cell" KUBECONFIG="$cell_kubeconfig" \
  ../qualification/actor-bj-q01/configure-runtime-machine-repair.sh disable
```

每个 Cell 的完整自动换机资格测试通过后，会发布两份仅限 root 读取、带 Cell 名的
canonical receipt：

```text
/data/actor-qualification/receipts/<cell>-runtime-machine-repair-current.json
/data/actor-qualification/receipts/<cell>-runtime-automatic-repair-current.json
```

后续普通 runtime release 未显式覆盖开关时，安装器会同时核验两份 receipt 的
cluster UID、MachineSet UID，以及 automatic receipt 绑定的 provider receipt SHA-256；
全部一致才保留 Machine `delete` 权限与自动换机开关。任一文件缺失、身份变化或摘要不匹配
都会 fail closed，不继承旧集群的删除资格。

Run the local contract and controller tests with:

```bash
./deploy/tencent/fleet/tke-native-runtime-nodepool/test-admission-contract.sh
go test ./internal/runtimecapacity/... ./cmd/workerd-runtime-capacity-controller
```
