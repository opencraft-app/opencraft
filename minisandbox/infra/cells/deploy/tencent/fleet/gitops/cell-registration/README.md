# Central Argo Cell registration

Management cluster C runs upstream Argo CD. Each Cell is registered through a
dedicated target-cluster ServiceAccount; the Terraform administrator
kubeconfig is a one-time bootstrap input and is never copied into Argo, Git, or
the non-secret receipt.

The target identity can create/update/patch only TKE `MachineSet` and the exact
namespace's `RivetCell`. It cannot delete either kind or read Secrets. Argo
pruning is disabled, MachineSet replicas remain owned by capacity controllers,
and `RivetCell.spec.desiredState` remains owned by the receipt-bound admission
operation.

Install the management resources once. The installer preserves every existing
Argo resource inclusion, adds only the reviewed Cell kinds, and is idempotent:

```bash
HUB_KUBECONFIG=/protected/hub.kubeconfig \
ACTOR_TERRAFORM_INVENTORY=/protected/management-inventory.json \
ACTOR_IMAGE_INVENTORY=/protected/all-images.lock.json \
ACTOR_PULL_CREDENTIAL_RECEIPT=/protected/management-pull-bootstrap.json \
ACTOR_MANAGEMENT_PLATFORM_RECEIPT=/protected/management-platform.json \
ACTOR_MANAGEMENT_GIT_RECEIPT=/protected/management-git.json \
ACTOR_MANAGEMENT_DESIRED_RECEIPT=/data/actor-qualification/receipts/management-desired-state.json \
  ./install-management.sh
```

The installer first revalidates the create-first Argo platform and management
Git receipts against live UIDs, the digest-locked Gitea StatefulSet, retained
PVC, immutable credential Secrets and the reader's effective repository
permissions. It derives the repository URL from that evidence instead of an
operator string, then binds the AppProject and ApplicationSet to both receipts
and the cluster UID.

`resource-inclusions.yaml` adds only `MachineSet` and `RivetCell` to the
dedicated management-cluster Argo inventory policy. If that Argo instance
already has inclusion entries, merge and retain them explicitly; do not replace
them or broaden unrelated kinds to every Cell. Adding another Cell workload
kind requires a reviewed change to both this policy and the AppProject
allow-list.

Argo applies `resource.inclusions` globally to every target registered in that
management instance. Consequently every target identity, including legacy or
read-only targets not selected by `actor-cells`, must have `get/list/watch` for
these included kinds. It need not—and should not—gain write or delete access.
The local C installation proves this coexistence rule with its static A/B
identities.

After a reviewed Terraform apply, publish the exact rendered tree through the
bounded management publisher. It revalidates the live Git service, opens a
temporary loopback port-forward and reads the publisher password from its
mode-0600 derived credential; neither the URL nor receipt contains a secret.
The operation permits only a new `cells/<cell-id>` payload (or an exact
restart-safe replay), performs an ordinary fast-forward push, verifies the
remote branch, and records every committed file:

```bash
./publish-management-desired-state.sh \
  /data/tmp/cell-inventory.json \
  /data/tmp/cells/actor-bj-k02/handoff-receipt.json \
  /data/tmp/cells/actor-bj-k02 \
  /data/actor-qualification/receipts/actor-bj-k02-publication.json
```

Register only the immutable commit returned by that exact publication receipt:

```bash
HUB_KUBECONFIG=/protected/hub.kubeconfig \
CELL_KUBECONFIG=/protected/terraform-cell.kubeconfig \
CELL_INVENTORY=/data/tmp/cell-inventory.json \
CELL_HANDOFF_RECEIPT=/data/tmp/cells/actor-bj-k02/handoff-receipt.json \
CELL_PUBLICATION_RECEIPT=/data/actor-qualification/receipts/actor-bj-k02-publication.json \
CELL_PLATFORM_RECEIPT=/data/actor-qualification/receipts/actor-bj-k02-cell-platform.json \
CELL_DESIRED_ROOT=/data/tmp/cells/actor-bj-k02 \
CELL_REGISTRATION_RECEIPT=/data/actor-qualification/receipts/actor-bj-k02-registration.json \
  ./register-cell.sh
```

Before either spoke RBAC or the central Argo cluster Secret is written, the
script verifies the publication receipt, complete handoff file inventory,
exact Terraform API endpoint, and the immutable create-first Cell platform
receipt. It re-reads the live cluster UID, FDB Operator and Cell controller
Deployment UIDs/readiness/image identity, and Profile/Class UIDs and spec. A
blank or replaced cluster therefore cannot be registered merely because an old
Git handoff still exists. It then verifies target RBAC negative permissions and
any existing Argo target identity.
The registered Argo credential is namespace-scoped to
`actor-fdb-cell-system,actor-stateless-system`. In the FDB namespace it can
manage only `RivetCell`; the stateless namespace grants read-only
`RivetCell` discovery because Argo's namespace cache lists each discovered
type in every allowed namespace, while workload writes remain restricted to
the stateless namespace. The privileged node-admission ServiceAccount lives in
the unregistered `actor-runtime-admission-system` namespace. This prevents a
Git-authored Deployment from mounting FDB/COS Secrets or borrowing the
Node/Machine patch identity even though Argo itself never receives Secret-read
RBAC.
Registration derives its exact Git revision solely from the verified
publication receipt; operators do not copy a commit ID into a second input. The
handoff must use schema v2 and include the complete, self-authenticating
28-image inventory. Its digest is copied into the scoped Argo cluster Secret,
the generated Application, and the spoke `RivetCell`; a valid Terraform
inventory paired with another release's image lock is rejected.
Convergence binds all four capacity identities (`control`, `fdb`, `runtime`,
and `stateless`). Terraform records the official stateless Native NodePool's
generated `np-*` ID in inventory; Argo owns the other three MachineSets and
their names are derived from the digest-bound handoff manifests rather than a
hard-coded generation. The verifier lists the complete live MachineSet
inventory, so a missing pool or an unreviewed leftover pool both fail closed.
Argo must not recreate or prune the cloud-owned stateless pool. A Cell without
all four exact identities cannot produce a current convergence receipt.
It stores the scoped ServiceAccount token only in the central Argo cluster
Secret. Reusing the same registration is idempotent; changing Cell, cluster ID,
or endpoint fails closed unless `ACTOR_ARGOCD_REPLACE_CLUSTER=true` is supplied
for a separately reviewed cluster replacement.

The ApplicationSet selects only cluster Secrets labelled both
`managed-cell=true`, `desired-state=published`, and
`registration-scope=production`, pins each Application to the
Git commit recorded by registration, and derives its path from the Cell ID.
Argo health does not admit traffic; qualification and the human receipt-bound
admission CAS remain later gates.
The FDB MachineSet's `spec.scaling.minReplicas` is owned by the Cell capacity
controller alongside `spec.replicas`. Argo ignores only that field on
`np-fdbpool0`; otherwise a DR restore can request nodes while Argo repeatedly
resets the capacity floor to Terraform's bootstrap value. The control pool's
minimum remains Argo-owned.
The convergence receipt carries the production project and registration scope;
route publication, initial qualification, and final admission all reject an
E2E-scoped or otherwise non-production receipt.

After the ApplicationSet has observed the registered target, create the
production convergence receipt through the read-only verifier:

```bash
python3 verify-convergence.py \
  --hub-kubeconfig /protected/hub.kubeconfig \
  --cell-kubeconfig /protected/terraform-cell.kubeconfig \
  --inventory /data/tmp/cell-inventory.json \
  --handoff-receipt /data/tmp/cells/actor-bj-k02/handoff-receipt.json \
  --desired-root /data/tmp/cells/actor-bj-k02 \
  --registration-receipt /data/actor-qualification/receipts/actor-bj-k02-registration.json \
  --receipt /data/actor-qualification/receipts/actor-bj-k02-argo-convergence.json
```

It fails closed unless the live cluster Secret UID, immutable Git revision,
inventory/handoff annotations, Application UID and health, RivetCell UID and
profile, platform receipt/cluster UID, and all three MachineSet UIDs belong to
the same construction chain. The output
contains no token or kubeconfig and is published without an overwrite race.
After the qualification activation receipt says the same spoke Cell UID is
`Ready`, publish the formal Claim adoption record:

```bash
python3 adopt-cell.py \
  --hub-kubeconfig /protected/hub.kubeconfig \
  --cell-kubeconfig /protected/terraform-cell.kubeconfig \
  --convergence-receipt /data/actor-qualification/receipts/actor-bj-k02-argo-convergence.json \
  --qualification-chain /data/actor-qualification/receipts/actor-bj-k02-qualification-chain.json \
  --activation-receipt /data/actor-qualification/receipts/actor-bj-k02-qualification-activation.json \
  --receipt /data/actor-qualification/receipts/actor-bj-k02-claim-adoption.json
```

This creates two immutable central objects: a credential Secret and a
`RivetCellRegistration`. The credential belongs to a separate spoke
ServiceAccount. It can get the `kube-system` namespace identity and get/update
only the named `RivetCell`; it cannot read Secrets, touch MachineSets, create a
Cell, or delete anything. The registration permanently intersects Claim UID,
Pool UID, Kubernetes cluster UID, spoke Cell UID, credential Secret UID,
profile/release identity, and all three convergence, reviewed-qualification,
and activation evidence digests. Consequently the central Registration cannot
make a merely activated but differently reviewed Cell visible to placement.
If the command is interrupted after creating the immutable central objects,
rerunning it against the same receipt path reconstructs the live result and
accepts the retained receipt only when every stable field is identical. It
never overwrites a conflicting receipt.

The external provider in the central Fleet controller is the only writer of
Claim status. It polls the spoke, creates the logical Cell, mirrors fresh
controller-owned status, and binds the Claim. Loss of the spoke preserves the
durable UID binding but immediately closes the logical Cell to placement. A
logical lifecycle transition such as `Draining` is sent back through the same
single-Cell credential. OCM and this provider are mutually exclusive.

Destroy the one-time Terraform administrator kubeconfig only after retaining
the convergence, activation, and adoption receipts; Argo and the Fleet
controller then retain separate least-privilege credentials.

Only after the Claim is `Bound` and its logical Cell is fresh and Ready,
publish the immutable route from the same convergence receipt:

```bash
python3 publish-cell-route.py \
  --hub-kubeconfig /protected/hub.kubeconfig \
  --convergence-receipt /data/actor-qualification/receipts/actor-bj-k02-argo-convergence.json \
  --qualification-chain /data/actor-qualification/receipts/actor-bj-k02-qualification-chain.json \
  --activation-receipt /data/actor-qualification/receipts/actor-bj-k02-qualification-activation.json \
  --adoption-receipt /data/actor-qualification/receipts/actor-bj-k02-claim-adoption.json \
  --receipt /data/actor-qualification/receipts/actor-bj-k02-route.json
```

The operation intersects the Terraform-bound Pool, Claim and datacenter with
the exact pre-activation qualification chain, the human activation CAS, the
central adoption receipt and the live logical/spoke Cell UIDs. It creates one
immutable ConfigMap in the dedicated Workers API namespace. Replaying an
identical route is safe; any evidence, identity or datacenter change fails
closed and requires an explicit Cell replacement. A route does not admit
traffic by itself: the Fleet controller must still publish the same logical
Cell in the Pool's fresh admission set. There is no legacy route rewrite path;
a clean-room fleet has no compatibility state to preserve.
The route receipt has the same strict replay rule: rerunning verifies the
existing bytes against the exact live ConfigMap rather than treating file
existence as success.

The normal post-activation entry point executes adoption, waits for the exact
Claim UID and spoke Cell UID to become `Bound`, and then publishes the route:

```bash
HUB_KUBECONFIG=/protected/hub.kubeconfig \
CELL_KUBECONFIG=/protected/terraform-cell.kubeconfig \
ACTOR_ARGO_CONVERGENCE_RECEIPT=/data/actor-qualification/receipts/<cell>-argo-convergence.json \
ACTOR_CELL_QUALIFICATION_CHAIN_RECEIPT=/data/actor-qualification/receipts/<cell>-qualification-chain.json \
ACTOR_QUALIFICATION_ACTIVATION_RECEIPT=/data/actor-qualification/receipts/<cell>-qualification-activation.json \
ACTOR_CELL_ADOPTION_RECEIPT=/data/actor-qualification/receipts/<cell>-claim-adoption.json \
ACTOR_CELL_ROUTE_RECEIPT=/data/actor-qualification/receipts/<cell>-route.json \
  ./complete-cell-adoption.sh
```

This is restart-safe but deliberately stops before first placement. It cannot
manufacture the human activation receipt and it cannot call the public Object
API. A bounded wait treats a changed Claim, Pool or spoke UID as a permanent
identity failure; transient API unavailability may retry only until the
configured timeout.

After the Cell's private Engine and stateless-executor Services have independently
passed their endpoint gates, publish the mutable serving snapshot into C. The
identity route remains immutable; endpoint replacement advances this separate
revision by exactly one using the live ConfigMap resourceVersion as CAS:

```bash
python3 publish-cell-serving-route.py \
  --hub-kubeconfig /protected/hub.kubeconfig \
  --identity-route-receipt /data/actor-qualification/receipts/<cell>-route.json \
  --engine-endpoint-receipt /data/actor-qualification/receipts/<cell>-engine-endpoint.json \
  --stateless-endpoint-receipt /data/actor-qualification/receipts/<cell>-stateless-endpoint.json \
  --region ap-beijing \
  --revision 1 \
  --published-at 2026-09-23T10:00:00Z \
  --receipt /data/actor-qualification/receipts/<cell>-serving-route.json
```

An exact replay only verifies the live route and retained receipt. A changed
authority requires `--revision <prior+1>` and `--expected-resource-version` from
the live prior snapshot. The publication contains no bearer token: Workers API
authorizes only the separately configured exact Cell UID/capability pair. The
management Argo project ignores only the four receipt-derived identity/serving
ConfigMap names, so these Fleet-owned routes do not create wildcard orphan noise.

Updating an existing Argo Cell registration is likewise explicit and
compare-and-swap protected. Set `ACTOR_ARGOCD_UPDATE_REGISTRATION=true` and
`ACTOR_ARGOCD_EXPECTED_REVISION` to the currently registered Git revision. The
command verifies the existing Cell, scope, cluster and API endpoint before it
can take field ownership and publish the new immutable revision.

The C-to-Cell credential and negative-RBAC path has a real local-mesh gate:

```bash
python3 local-registration-e2e.py \
  --hub-kubeconfig /root/.local/state/rivet-local-mesh/mesh-hub.kubeconfig \
  --cell-kubeconfig /root/.local/state/rivet-local-mesh/runtime-a.kubeconfig \
  --internal-server https://172.18.0.7:6443 \
  --tls-server-name k3d-rivet-runtime-a-serverlb \
  --receipt /data/actor-qualification/receipts/local-cell-registration-$(date +%s).json
```

It creates the scoped identity and central Argo Secret, verifies the retained
Secret UID against a non-secret receipt, proves all three forbidden operations,
and removes only its exact test resources. The receipt path must be new so a
prior proof cannot be silently replaced. It does not claim ApplicationSet
convergence; that is a separate Git/Argo self-heal E2E.

Run that complete convergence gate with two fresh receipt paths:

```bash
python3 local-applicationset-e2e.py \
  --hub-kubeconfig /root/.local/state/rivet-local-mesh/mesh-hub.kubeconfig \
  --cell-kubeconfig /root/.local/state/rivet-local-mesh/runtime-a.kubeconfig \
  --internal-server https://172.18.0.7:6443 \
  --tls-server-name k3d-rivet-runtime-a-serverlb \
  --registration-receipt /data/actor-qualification/receipts/local-appset-registration-$(date +%s).json \
  --receipt /data/actor-qualification/receipts/local-appset-convergence-$(date +%s).json
```

The gate serves an immutable temporary Git repository inside C, lets the
ApplicationSet create and sync the Cell Application, proves ordinary desired
state self-heals, proves `MachineSet.spec.replicas` remains capacity-controller
owned, replaces the Argo application-controller Pod, and proves self-heal still
works after replacement. It restores the prior global Argo inclusion policy and
removes only the exact E2E objects; both receipts remain as evidence.
