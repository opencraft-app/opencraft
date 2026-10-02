# RivetCell provisioning and automatic admission SOP

Status: implementation contract; Cell Terraform, the credential-free renderer,
least-privilege central Argo registration, ApplicationSet convergence,
admission-aware serving placement and FDB ownership persistence exist. The
create-first management C substrate and Terraform-owned C/Cell CCN attachments
now exist statically. Their Beijing apply/network proof, generic blank-cluster
platform bootstrap, initial qualification, and the joined receipt are not yet
one production workflow.

## Operator contract

Creating a Cell has two deliberate human decisions: review/apply the Terraform plan for one exact
`RivetCellClaim`, then admit that new failure domain after its initial qualification receipt is
reviewable. Installation and qualification between those gates are automatic:

```text
reviewed RivetCellClaim + Terraform apply
  -> immutable Cell inventory
  -> Argo CD installs the Cell
  -> public /v1 Durable Object and storage qualification
  -> immutable pre-activation qualification chain
  -> release-bound RivetCellReport
  -> operator invokes the receipt-bound admission CAS
  -> fleet controller derives readyForPlacement=true
  -> ShardPool publishes the Cell as an admission candidate
  -> resolver may place new Agent DOs in the Cell
```

There is no ad-hoc `kubectl patch` or manual reporter environment update. The product-level
"accepting=true" approval is represented by the existing receipt-bound CAS of
`spec.desiredState` to `Ready`; it is not a second mutable boolean. The public placement bit remains
`RivetCell.status.readyForPlacement`, derived by the fleet controller from current intent and
evidence. A Cell is never deleted automatically. Retirement and physical destruction remain
separate, explicitly approved workflows.

The operator reviews the single `actor-cell-qualification-chain/v1` artifact,
not a remembered list of component files. `complete-cell-qualification.sh`
reconstructs that artifact byte-for-byte when resumed and proves the exact
Terraform, management Git, Argo, TLS, runtime release, Bottomless and Engine HA
identities. Physical restore remains a separately retained, operator-triggered
DR exercise and is not an admission input. The artifact explicitly records that
placement remains closed and cannot perform the activation CAS itself.

## Ownership

| State | Sole writer | Contract |
|---|---|---|
| Claim identity and capacity epoch | Fleet controller | One deterministic Claim per Cell UID and scale-out epoch; a failed Claim is not silently replaced. |
| VPC, subnet, TKE, COS and cloud IAM resources | Terraform | The reviewed plan is the only human approval point. Terraform does not publish placement readiness. |
| Cell software desired state | Argo CD | Installs only immutable, digest-pinned manifests generated from the Terraform inventory. It does not own cloud capacity or live status. |
| Runtime/FDB/COS/backup observations | Cell reporter and qualification workflows | Reports exact Cell UID/generation, release digest and immutable receipt references. |
| `RivetCell.status.readyForPlacement` and Pool candidates | Fleet controller | Derived fail-closed from desired state, fresh report, profile/topology/health/capacity and release-bound qualification. No other component patches it. |
| New Agent DO placement | Worker Registry FDB object record | Workers API resolves one fresh Pool snapshot, then competing API replicas use one FDB transaction to persist the winning Pool/Cell UID, datacenter and Actor lifecycle record before creation. Kubernetes status is an input, not the transaction authority. |
| Existing Agent DO route | Resolver and FDB placement directory | A Cell closing admission affects only new placement; existing object IDs continue to resolve to their owning Cell. |

## Required identifiers

The Terraform operation is bound to one tuple and records it in both its plan artifact and output
inventory:

```text
(region, ShardPool UID, RivetCellClaim UID, scaleOutEpoch, Cell ID, profile digest)
```

The handoff rejects a missing or changed UID, a reused Cell ID, an already-bound Claim with a
different Cell, a profile digest mismatch, or an inventory containing credentials. Retrying the
same tuple is idempotent. A different tuple requires a new reviewed Terraform plan.

## Automatic admission state machine

```text
InfrastructureReady
  -> ArgoInstalling
  -> Qualifying
  -> ReportPublished
  -> PlacementReady
```

Every transition is monotonic for the same attempt and has a durable operation ID. The following
rules are mandatory:

1. Terraform success alone never admits traffic.
2. Argo `Synced/Healthy` alone never admits traffic.
3. Readiness probes alone never admit traffic.
4. Qualification uses only the public `/v1` Worker/Version/Deployment/Object API and calls the
   persistent object a Durable Object or Agent DO, not an Actor API.
5. The qualification receipt must match the live runtime image, rendered manifest, Cell UID and
   Cell generation. A later release invalidates that admission root until the release workflow
   publishes its own matching evidence.
6. `publish-qualified-release.sh` is the only qualification activation writer and is explicitly
   invoked by the operator for a new Cell. It publishes the
   immutable evidence first, updates the reporter, observes the matching Report, and only then
   advances `spec.desiredState` from `Provisioning/Qualifying` to `Ready` by UID/resourceVersion
   CAS.
7. The fleet controller is the only writer of `status.readyForPlacement`. Missing, stale or
   mismatched evidence closes placement automatically.
8. The resolver may use only a fresh `ShardPool.status.admissionCandidates` entry and must perform
   the final durable FDB CAS reservation. It cannot infer readiness from a DNS endpoint or an Argo
   Application.

If any stage fails, the Cell remains installed for diagnosis but closed to new placement. A retry
resumes the same operation identity. It must not create a replacement Cell, delete cloud resources,
or weaken a failed gate.

## Capacity boundary

A Cell is a bounded failure domain, not an indefinitely growing cluster. Runtime Hosts scale
automatically inside the Cell. The new-infrastructure address planning target is 1,024 total
nodes per Cell, including control, FDB, compute, bootstrap and temporary repair/upgrade capacity.
New Cell templates use a `/20` node VPC with three AZ `/22`s and a fourth `/22` reserved.
This target is not qualified thousand-node capacity. The deployed maximum stays owned by the
Cell profile and runtime envelopes until per-AZ node and GR Pod address headroom, cloud quotas,
control-plane capacity, load and recovery gates pass. The current `/16` Pod example must not be
assumed sufficient merely because the node VPC is large enough. See the
[network budget](network/README.md#new-cell-address-budget).
Approaching the admission watermark creates a new
`RivetCellClaim`; an operator reviews and applies its Terraform plan. Existing Agent DOs do not
migrate merely because the fleet gained a Cell.

Qualification-cluster limits such as q01's 30 runtime Hosts are cost guards and must not be
presented as product limits. Likewise, 32 is the current per-Host active-Agent hard admission
limit, not the number of Agents in a Cell and not an adequate fleet-capacity test sample.

## Deletion boundary

No normal controller or Terraform apply automatically deletes a Cell, FDB cluster, CBS disk, COS
bucket, qualification receipt, or placement record. The normal lifecycle stops at admission
closure. A future retirement SOP must first prove the existing retirement contract and then
require a separate reviewed destruction plan.

## Current implementation gap

The repository already contains the fail-closed readiness derivation, Claim state machine,
`publish-qualified-release.sh`, Argo release Hooks, resolver abstraction, create-first Terraform,
and a renderer that binds immutable Claim/Pool identity to credential-free cloud inventory.
Remaining wiring is:

1. apply management C and one Cell from Terraform, then prove the exact private API/gateway allow and deny paths;
2. bootstrap CRDs, operators, FDB and runtime software in a blank target before the narrow AppSet is expected to converge;
3. execute the proven registration/ApplicationSet workflow against the new private TKE target and retain its immutable cloud receipts;
4. make every installer consume the complete 28-image inventory by digest;
5. run the initial public DO/storage/HA qualification automatically after Argo convergence;
6. retain the implemented pre-activation qualification chain and then the
   final joined receipt through operator admission, Report, Pool candidate and
   first successful FDB placement reservation in one formal Cell rebuild
   runner.

The serving adapter now rechecks Pool generation, Cell report expiry,
logical/spoke UID and an immutable convergence-bound route before proposing a
Cell. The Worker Registry rejects a new object without a placement and its FDB
transaction makes one proposal the permanent winner. The local three-cluster
gate has proven three concurrent API replicas converge to one Actor and has
read the exact persisted winner back from Registry FDB.

The q01 autonomy timer implements an automatic activation mode for qualification exercises. It holds
the same Cell operation lock as release and rollback, emits exactly one fresh control receipt, and
invokes `publish-qualified-release.sh` only when that receipt is `allow` and the observed Cell phase
is `Provisioning` or `Qualifying`. A concurrent release causes the audit run to skip without writing
a transient block; an unexpected phase or activation failure is a hard service error. New-Cell
production Cell provisioning keeps the explicit operator admission gate and remains non-unattended
until the cloud-execution/image-consumption/initial-qualification/joined-receipt items above are complete.

Until that joined receipt exists, provisioning a new Cell is not an unattended path even if each
individual component reports healthy.

The initial qualification audit uses `AUTONOMY_QUALIFICATION_MODE=initial-cell`. It requires
release-bound `production-cell` Bottomless, Cell-scoped Engine HA, and the live
FDB/backup/topology/metrics/static-release gates. It intentionally excludes historical
arrival-rate, FDB scale-cycle, transparent-upgrade, and semantic-rollback receipts, because those
are continuous-operation evidence for an already admitted Cell. The operator still publishes the
fresh allow receipt explicitly; `initial-cell` never changes `RivetCell.spec.desiredState` itself.

After retaining the exact Argo convergence receipt, run the bounded workflow from reviewed source:

```bash
CELL=actor-bj-k02 \
CELL_NAMESPACE=actor-fdb-cell-system \
KUBECONFIG_PATH=/protected/actor-bj-k02.kubeconfig \
ARGO_CONVERGENCE_RECEIPT=/data/actor-qualification/receipts/actor-bj-k02-argo-convergence.json \
INITIAL_RUNTIME_RELEASE_RECEIPT=/data/actor-qualification/receipts/actor-bj-k02-runtime-release-<release-id>.json \
AUTONOMY_SOURCE_REVISION=<40-hex> \
AUTONOMY_SOURCE_MANIFEST_SHA256=<64-hex> \
AUTONOMY_SOURCE_TARGET=/var/lib/actor-build/deploy/<reviewed-source-identity> \
INITIAL_QUALIFICATION_EXECUTE=true \
  ./qualification/run-initial-cell-qualification.sh
```

It serializes Bottomless and Engine Pod-loss behind the Cell operation lock,
then emits one exact final audit/control pair plus an aggregate receipt. It does not invoke
`publish-qualified-release.sh`; the operator reviews that pair before the explicit activation CAS.

When this workflow is launched through TAT, use a two-hour (`7200`) outer
window so Bottomless cold convergence and Engine HA can consume their bounded
inner deadlines. Physical restore is deliberately not part of Cell admission
or continuous qualification. The retained `physical-restore/run.sh` entrypoint
is an explicit operator-triggered DR exercise for storage-format, backup, or
restore implementation changes; its result is diagnostic evidence and never a
placement prerequisite.
