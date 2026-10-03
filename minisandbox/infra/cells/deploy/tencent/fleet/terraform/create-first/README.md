# Create-first Tencent Cell infrastructure

This is the clean-room construction path. It creates a regional foundation,
an independent management cluster C, and one independently stateful Cell
without importing q01, remembering old cloud resource IDs, copying files from
an old node, or placing credentials in Git.
The adjacent q01 Terraform remains historical qualification state and is not a
template for another Cell.

It creates one regional CCN and attaches C and every Cell VPC. The adjacent
`bootstrap/` operations install the management Argo and desired-state Git
floors plus the Cell CRD/FDB/Fleet-controller floor in blank TKE clusters,
with immutable receipts. `rebuild/run-management-code-plane.sh` now owns the
next regional Code Plane/Argo-adoption state transition and emits the single
receipt required by final public admission. Cell runtime and qualification
remain later receipt-bound phases rather than hidden Terraform provisioners.

## Ownership and state boundaries

| Root | Owns | State prefix |
|---|---|---|
| `bootstrap-state` | one encrypted, versioned COS Terraform-state bucket | local bootstrap state |
| `foundation` | regional private TCR instance, namespace, complete repository inventory, regional CCN, and the account-scoped TKE OIDC role-policy attachment | `actor-fleet/foundation` |
| `management` | C VPC, three subnets, security groups, TKE, three zonal workers (one bootstrap), standalone runtime-builder CVM and build CBS, private endpoint, TCR/CCN attachments, regional Worker-code, code-plane FDB-backup and qualification-evidence buckets | `actor-fleet/management` |
| `cell` | one VPC, three subnets, security groups, TKE, bootstrap worker, private endpoint, TCR/CCN attachments, COS buckets and scoped CAM roles | `actor-fleet/cells/<cell-id>` |
| `operations-network` | attach an existing regional LightVela VPC to an isolated CCN route table; expose only C and prevent current/future Cells from learning operations routes | `actor-fleet/operations-network` |

Every Cell has a separate backend prefix and therefore an independently
reviewable plan and destruction blast radius. Cell MachineSets remain
Kubernetes desired state: Cell Terraform creates only its bootstrap worker.
Management Terraform creates three initial workers because upstream Argo HA
has hard hostname anti-affinity and cannot converge on one node. Terraform
never marks a Cell placement-ready.

Runtime image compilation has a separate physical resource envelope. Management
Terraform creates a private standalone CVM and an independently identified
512 GiB CBS by default; neither joins TKE nor changes the three control workers.
`runtime_builder_instance_type` and `runtime_builder_data_disk_gib` are explicit
management-only inputs. This is disposable build capacity, not Actor storage.
The separate credential-free `runtime_builder_inventory` output binds the instance, zone, disk
and attachment, and retains `operationsInstanceId` as the original bootstrap
host. It is not part of the strict platform `management_inventory` contract.
Do not move release/qualification to a second operation-lock domain.

Run the full management plan and its exact saved-plan apply under the original
operations-host wrapper. A short lock-availability probe on that host does not
authorize applying from a different machine. Join the backend state lineage and
the current management/VPC/bootstrap identities before mutation; a builder-only
change must create only the five declared builder resources, with no existing
resource update or destruction. Transfer neither saved plans nor state through
the ordinary credential-free source relay.

On a private operations host, Terraform needs both an offline provider source
and the established private Tencent API domain. A cached installed provider alone
does not eliminate Registry discovery. Transfer the exact provider ZIP through
COS, verify it against the tracked `.terraform.lock.hcl`, and use a protected
`TF_CLI_CONFIG_FILE` with a `filesystem_mirror` and no `direct` fallback.
The mirror's packed layout is
`registry.terraform.io/tencentcloudstack/tencentcloud/terraform-provider-tencentcloud_1.83.11_linux_amd64.zip`.
Do not disable TLS or replace the lock file with hashes generated from an arbitrary
cache. Terraform's COS backend also uses the Tencent Tag API for state locking:
being able to read COS does not prove that it can acquire the state lock.
Set `TENCENTCLOUD_DOMAIN=internal.tencentcloudapi.com` before backend initialization,
plan and apply on the configured same-VPC operations host. This is the same
private API root used by the existing tccli wrapper, not a second state or lock
authority. Never work around a network failure using `-lock=false` or force-unlock.
See HashiCorp's [provider mirror configuration](https://developer.hashicorp.com/terraform/cli/config/config-file#explicit-installation-method-configuration)
and [COS backend domain and locking](https://developer.hashicorp.com/terraform/language/backend/cos).

If cloud quota stops an apply after another resource was created, preserve the
backend state and the native terminal invocation. Collect the exact partial
resource identities before any recovery. A new complete plan after quota is
resolved must reuse recorded resources; never rerun the old plan, discard state,
delete unreviewed security groups, or adopt a broader control-worker security
group merely to bypass the standalone builder's isolation contract.

Provisioning is not build readiness. The inventory deliberately requires a
storage bootstrap: verify the cloud attachment and exact guest block-device
identity before any initialization; never infer `/dev/vdb` or overwrite a used
disk. All actual bulk write paths must pass `runtime/verify-builder-storage.py`
on the mounted data filesystem. The disk envelope does not establish the peak
space or CPU/I/O budget of a fresh V8 build. No Terraform provisioner formats,
migrates or prunes an existing host, and the build entrypoint must remain blocked
until the separate storage bootstrap is implemented and verified. The read-only
`bootstrap/validate-runtime-builder-storage.py` joins fresh native cloud API,
management-node and guest block-device observations to this output. A passed
plan still reports `storageReady=false` and is not reusable format authority.

Management and Cell roots also own the TKE `networkpolicy` add-on at an
explicit reviewed version. Kubernetes accepting a `NetworkPolicy` object is
not evidence of enforcement: platform qualification requires the
`kube-system/networkpolicy` DaemonSet to be observed and Ready on every
desired node. In GlobalRouter/IPVS mode the add-on values bind both the Pod
and Service CIDRs. Existing policy manifests must be audited before enabling
the add-on because they become effective immediately.

Regions exposing fewer than three availability zones may be exercised only
with `availability_mode=qualification-single-zone`. The inventory records this
fact, the renderer accepts exactly one physical zone, and the resulting Profile
must retain `qualification.ready=false` for production admission. The default
`production-multi-zone` mode still requires three distinct AZs. This is an
explicit functional/recovery test mode, not an HA waiver.

Run the live CVM zone preflight before creating the state bucket or any
billable regional resource. It uses the current Tencent API response rather
than a remembered region table, and production bootstrap fails unless at least
three distinct zones are `AVAILABLE`:

```bash
TENCENT_REGION=ap-beijing \
AVAILABILITY_MODE=production-multi-zone \
./preflight-region-zones.sh
```

The preflight is also mandatory when planning a qualification region. In that
mode it proves at least one usable zone, but it does not make the Cell eligible
for production placement. Management and Cell VPC creation additionally use a
Terraform resource precondition against live `tencentcloud_zones(product=cvm)`
data, so omitting the shell preflight cannot create a cluster with unavailable
subnet zones or an unsatisfied production AZ count.

The `TKE_QCSRole#QcloudAccessForTKERoleInOIDCConfig` attachment is deliberately
owned once by `foundation`. Tencent needs it while enabling and disabling TKE
OIDC, and attaching it from every Cell would let destruction of one Cell break
destruction or creation of every other Cell. Cell planning fails closed unless
the foundation remote state proves this shared prerequisite is present.

The state bucket is the unavoidable bootstrap exception. Create it once from
local state and retain that tiny state as a protected artifact:

```bash
cd bootstrap-state
cp terraform.tfvars.example terraform.tfvars
terraform init
terraform plan -out=/data/tmp/bootstrap-state.tfplan
terraform apply /data/tmp/bootstrap-state.tfplan
```

Do not commit `terraform.tfvars`, plans, state, kubeconfig, private keys, or
cloud credentials. The operator supplies only an existing OpenSSH *public* key;
Terraform does not generate or retain the private half.

The reviewed, non-secret fleet shape lives in
`rebuild/fleet-intent.json`. It fixes the C/A/B identities, non-overlapping
networks, node selector, capacity policy and public operator key without any
Tencent resource ID. `rebuild/render-inputs.py` produces management tfvars
directly. A Cell render additionally requires the fresh C-created
Pool/Claim/profile binding, so a rebuilt Cell cannot accidentally reuse an old
Kubernetes UID or old private-registry profile digest.

## Regional foundation

Initialize against the newly created state bucket, then review and apply:

```bash
export TENCENT_REGION=ap-beijing
./init-backend.sh foundation <state-bucket-name>
terraform -chdir=foundation plan -out=/data/tmp/foundation.tfplan
terraform -chdir=foundation apply /data/tmp/foundation.tfplan
```

Repository creation precedes any long-lived TCR token. A new image repository
must be added to `foundation/variables.tf` before release automation is allowed
to mint or rotate a token.

The CCN supplies private VPC reachability only. It is not an authorization
boundary: TKE endpoint security groups, private CLB source restrictions and
gateway mTLS must enforce the exact flows in `network/ccn-plan.yaml`. Pod and
Service CIDRs are never attached or advertised to CCN.

New Cell examples use a `/20` node VPC, three AZ `/22` subnets and one unallocated
`/22` recorded in `network/ccn-plan.yaml`. Management C remains `/16`. This is a
new-infrastructure address contract, not an in-place shrink of existing VPCs.
The planning target of 1,024 total nodes includes control/FDB/runtime and
temporary replacement nodes; it does not raise any qualified autoscaling ceiling.
The independent Pod CIDR must be sized from TKE's actual per-node allocation and
peak recovery demand before increasing node limits. The retained `/16` Pod example
is not a thousand-node capacity claim. See the
[network budget](../../network/README.md#new-cell-address-budget).

## Management cluster C

Create C before any Cell so a Cell can bind its API allow-list and immutable
management identity directly from the management Terraform state:

```bash
./init-backend.sh management <state-bucket-name>
cp management/terraform.tfvars.example /data/tmp/management.tfvars
terraform -chdir=management plan \
  -var-file=/data/tmp/management.tfvars \
  -out=/data/tmp/management.tfplan
terraform -chdir=management apply /data/tmp/management.tfplan
```

## Operations network attachment

Apply this root after C and at least once after the management state has emitted
`ccnRouteTableId`. The renderer resolves the external VPC by its stable exact
name and reviewed CIDR; no remembered VPC or route-table ID belongs in rebuild
intent. Install the propagation deny before attachment, then bind the operations
VPC to its custom table:

```bash
python3 rebuild/render-inputs.py \
  --intent rebuild/fleet-intent.json \
  --target operations-network \
  --output /data/tmp/operations-network.tfvars.json
./init-backend.sh operations-network <state-bucket-name>
terraform -chdir=operations-network plan \
  -var-file=/data/tmp/operations-network.tfvars.json \
  -out=/data/tmp/operations-network.tfplan
terraform -chdir=operations-network apply /data/tmp/operations-network.tfplan
```

The default-table policy is deliberately first-match `accept operations -> C`,
then `drop operations -> any VPC`. The custom operations table accepts only C.
Do not attach Shanghai or Singapore operations VPCs to Beijing's CCN: their
production VPCs reuse `10.0.0.0/12`, so every region owns an independent CCN and
an independent `operations-network` state.

The Worker-code and code-plane backup buckets are regional C-owned resources;
they must never be borrowed from a runtime Cell. `management_inventory` is
credential-free. `sensitive_bootstrap.kubeconfig`
is a protected bootstrap artifact and must never be committed or included in
an ordinary receipt. Creating C does not yet install Argo CD, Registry,
Workers API, Caddy, or their qualification Hooks; that remains the generic
platform-bootstrap gate below.

`network.workersApiSecurityGroup` is the only security group that may be
attached to the private Workers API CLB. It admits C's VPC plus only the exact
`trusted_workers_api_cidrs`; the regional aggregate and Cell VPCs are
deliberately excluded. The Service installer consumes this inventory value and
TKE remains the owner that binds it to the dynamically created CLB.

`network.workerRegistrySecurityGroup` is separate. Its private CLB accepts TCP
8080 only from the reviewed regional VPC aggregate so workerd Hosts in admitted
Cells can resolve active Deployments and fetch immutable Versions from C. A Cell
runtime release must consume the receipt-bound private Registry endpoint; a
Cell-local Registry URL is a bootstrap error because public `/v1` writes only
to C's authoritative code plane.

The first common bootstrap phase is already inventory-driven. Run
`bootstrap/install-pull-credential.sh` on the exact Terraform bootstrap CVM
for role `management` or `cell`; it verifies the live TKE/VPC/private-TCR
identity and the complete image generation before installing any pull Secret.
Its immutable receipt is a prerequisite for subsequent platform installation.
For Cells, run `bootstrap/install-storage-credentials.sh` immediately after the
pull bootstrap. Terraform supplies distinct cold/backup CAM users limited to
their exact bucket; the protected sensitive output is the only handoff carrying
their key material. Runtime releases require the exact Terraform cold bucket
and consume the resulting immutable Secret rather than copying FDB backup
credentials.

## Manually approved Cell expansion

Render and publish the regional profile from the exact image inventory before
creating the Claim or planning a Cell:

```bash
python3 bootstrap/render-regional-profile.py \
  --images /data/actor-qualification/receipts/all-images-<run>.lock.json \
  --output /data/tmp/beijing-profile.yaml \
  --receipt /data/actor-qualification/receipts/beijing-profile.json
```

The returned `profileDigest` is the single value used by the C-side
`ShardClass`/Claim, Terraform `fleet_binding`, and `cell-spec.json`. This step
is mandatory because the private TCR copy has its own registry manifest digest;
retaining the public-source profile digest would make FDB Pods request an
object that does not exist in TCR.

Copy `cell/terraform.tfvars.example` to a protected working directory and bind
it to one immutable `ShardPool`/`RivetCellClaim` identity plus its scale-out
epoch and class/profile digest. Then set only new desired inputs: Cell ID,
non-overlapping CIDRs/zones, reviewed TKE version, account AppId, state bucket,
and the operator public key. No input is an old Tencent resource ID. The public image selector must be an anchored,
reviewed exact-name regex and must resolve to exactly one live public image;
ambiguity fails the plan rather than silently selecting "latest".

For a fresh `MinimumCells` Claim, the binding epoch is zero; that Claim has no
capacity-pressure trigger. For a `CapacityPressure` Claim, derive the epoch from
`spec.trigger.scaleOutEpoch`. There is no top-level `spec.scaleOutEpoch` field.
Always verify the live Claim's Pool UID and class before rendering the binding.

`storage_identity_mode=dedicated-users` gives each Cell two independent,
API-only CAM users with permanent access keys, one for its cold bucket and one
for its backup bucket. Tencent account operation protection blocks unattended
`AddUser`; run the preflight before creating billable resources and temporarily
disable operation protection for the bounded apply if it fails.

`storage_identity_mode=shared-root` is the explicit alternative for an account
whose operator has chosen to inject the root key into Cell Secrets. Terraform
does not ingest or persist that key: the protected bootstrap handoff supplies
it out of band and records `root-account-shared` as the real identity. This
mode skips CAM user/policy creation and therefore does not run the CAM AddUser
preflight.

Before the Cell storage bootstrap, render the protected handoff from the raw
Terraform output and the operator-selected root environment:

```bash
python3 bootstrap/render-shared-root-storage.py \
  --inventory /protected/cell.inventory.json \
  --sensitive /protected/terraform-sensitive-bootstrap.json \
  --output /protected/cell.sensitive-bootstrap.json
```

The helper requires `shared-root`, an empty raw Terraform credential map, the
inventory's exact cold/backup buckets and root identity, and the configured
`TENCENTCLOUD_SECRET_ID`/`TENCENTCLOUD_SECRET_KEY`. It writes a new mode-0600 file
inside a protected directory, preserves the kubeconfig, refuses overwrite and
does not print keys. Supply that file as `ACTOR_TERRAFORM_SENSITIVE_BOOTSTRAP`;
the unmodified Terraform output intentionally cannot satisfy storage bootstrap.

```bash
# Required only for storage_identity_mode=dedicated-users:
TCCLI=/path/to/tccli ./preflight-cam-automation.sh
./init-backend.sh cell <state-bucket-name> actor-bj-k02
terraform -chdir=cell plan \
  -var-file=/data/tmp/actor-bj-k02.tfvars \
  -out=/data/tmp/actor-bj-k02.tfplan
terraform -chdir=cell apply /data/tmp/actor-bj-k02.tfplan
```

The Cell reads the exact C VPC CIDR, management TKE identity and regional CCN
identity from remote state. `trusted_api_cidrs` is reserved for additional
reviewed operator networks; operators must not copy C's CIDR into it manually.

The plan/apply is intentionally manual. Automatic Host scaling operates inside
a Cell; adding or destroying an entire Cell changes the fleet failure domain
and stays behind a human-reviewed Terraform plan.

After apply, export only the non-sensitive inventory and merge it with the
reviewed product capacity policy:

```bash
terraform -chdir=cell output -json cell_inventory \
  >/data/tmp/actor-bj-k02-inventory.json
cp cell-spec.json.example /data/tmp/actor-bj-k02-spec.json
python3 render-cell-assets.py \
  --inventory /data/tmp/actor-bj-k02-inventory.json \
  --spec /data/tmp/actor-bj-k02-spec.json \
  --image-inventory /data/actor-qualification/receipts/all-images-<run>.lock.json \
  --output /data/tmp/actor-bj-k02-desired
```

The renderer requires the product policy's Pool, class and profile digest to
match the Terraform-bound Claim. It produces self-contained MachineSets, a `RivetCell` initially in
`Provisioning`, and a deterministic `handoff-receipt.json`. It refuses secret-
shaped inventory, Cell identity mismatch, malformed cloud IDs, non-three-zone
inventory, invalid profile digests, unsafe capacity ranges, and an existing
output directory. The generated tree is a staging artifact; review it before
the bounded `gitops/cell-registration/publish-management-desired-state.sh` operation
verifies and commits it to the Argo desired-state repository. The publisher
rejects extra files, an existing Cell with different content, embedded Git
credentials and non-fast-forward races, then emits an immutable publication
receipt consumed by Cell registration.

The rendered tree also carries the complete image inventory and binds its
self-authenticating digest into the Cell and handoff. Registration propagates
that digest through the central Argo cluster Secret and generated Application;
the final admission-chain join rejects any other inventory.

`sensitive_bootstrap.kubeconfig` is used only by the separate Argo cluster
registration/bootstrap operation. It must be streamed through protected
temporary storage and never joined to the inventory receipt.

## Admission and deletion

Argo installs digest-pinned software and qualification runs against the public
API. Passing qualification makes the Cell *eligible for operator approval*; it
does not silently admit a new failure domain. The first production iteration
keeps one explicit human CAS from `Provisioning/Qualifying` to `Ready`. The
Fleet controller remains the sole writer of `status.readyForPlacement`, and the
resolver uses only that derived status for new Agent placement.

Cell deletion is never automatic. First close admission, prove no placement or
retained-data reference remains, set deletion protection false in a separately
reviewed plan, and explicitly empty only the exact Cell-owned buckets before
destroy. None of those actions is part of normal reconciliation.

Deleting a disposable regional qualification environment also requires an
inventory-driven cloud cleanup after the Terraform roots reach zero resources:

1. destroy `operations-network` before management or foundation, so the
   external LightVela VPC is detached and the CCN policies have one state owner;
2. remove its Argo cluster registration and Application before touching Cell
   capacity, then stop Cell capacity, drain and Fleet reconcilers;
3. retire exact Machine names with `EnableScaleDown=true` and
   `InstanceDeleteMode=terminate`, one request per node pool, and wait until the
   TKE Machine inventory is empty;
4. stop backup/object writers before the final bucket-empty pass, otherwise
   late backup writes correctly prevent bucket deletion;
5. inspect unattached CBS disks by exact `tke-clusterId` ownership. `Retain`
   PVCs intentionally survive TKE deletion and require separate explicit data
   destruction authority;
6. preserve account-scoped TKE role-policy attachments required by any other
   region. A regional state is not exclusive ownership of an account resource;
7. explicitly destroy the regional TCR only after all consumers are gone.
   `delete_bucket=true` prevents leaving its physical COS backing bucket; and
8. re-list TKE, VPC, CVM, CLB, CBS, TCR, CCN and COS inventory by exact IDs.
   A zero-resource Terraform state alone is not proof of zero cloud residuals.

The ordinary fleet rebuild retains foundation and the versioned state/recovery
bucket. Full disposal of an unused qualification region is a different,
explicit operator action, and must archive its final state/evidence before
deleting that bucket. See [the Chengdu bootstrap and teardown record](rebuild/chengdu-bootstrap-and-teardown-2026-09-15.md).

## Static gate

Run before reviewing any plan:

```bash
./verify.sh
```

It runs renderer tests, Terraform formatting and validation for all four
roots, rejects remembered Tencent resource IDs in template inputs, and checks
that the regional TCR inventory covers the runtime token preflight inventory.

Before destroying an existing fleet, run the separate hard gate documented in
`pre-destroy/README.md`. It retains the versioned Terraform state bucket as the
minimal bootstrap seed, publishes and reads back the exact source and locked
Terraform artifacts, verifies all four remote states, and refuses a dirty Git
tree. A `verdict=passed` receipt is required by the destroy planner; static
validation alone never authorizes deletion.

The formal post-Terraform phase order, restart behavior and management Code
Plane invocation are documented in `rebuild/README.md`.

## Remaining clean-room gates

This Terraform layer is necessary but not sufficient for a zero-history
rebuild. The following stay fail-closed until they have their own immutable
receipts:

1. apply the new management and Cell roots, then prove the exact private
   C-to-Cell Kubernetes API, public API-to-gateway and Guard-to-gateway routes;
2. install the complete management and Cell platforms from the exact image inventory before
   registering the blank target; the current AppSet owns only `MachineSet` and
   `RivetCell`, not CRDs/operators/runtime workloads;
3. execute the locally proven central Argo registration/ApplicationSet workflow
   against a newly created Beijing Cell and retain its immutable receipts;
4. run the 17-image cold TCR seed, collect all 11 product build receipts, and
   make every installer consume the assembled 28-image lock by digest;
5. execute the locally proven generic 100-year FDB TLS bootstrap against the
   new Cell and retain its protected key material plus immutable receipt;
6. automatic initial public DO, cold-tier, backup/restore and node-replacement
   qualification, joined from Terraform inventory through first placement
   using `gitops/qualify-first-placement.py` and
   `gitops/assemble-admission-receipt.py`;
7. immutable source publication to a remote protected repository—the current
   local source commit alone is not a rebuild artifact.

Until those gates are closed, this directory proves reproducible cloud
construction and deterministic Terraform-to-Kubernetes handoff, not complete
unattended production qualification.
