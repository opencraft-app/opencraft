# Create-first cluster bootstrap

These operations run on the exact Terraform-created bootstrap CVM after the
reviewed source bundle, credential-free Terraform inventory, sensitive
kubeconfig and complete 28-image lock have been transferred through the
protected COS/TAT path. They must not read q01 state or infer a cloud resource
by name.

Run `prepare-bootstrap-host.sh` first through TAT. It owns only Actor's `/data`
workspace and the declared `buildah/git/jq/node/skopeo` host-tool set; TKE remains
the sole owner of CVM `user_data`. A stock Terraform-created TencentOS 3.1
worker is therefore sufficient and no earlier hand-prepared node is assumed.
The phase is idempotent, reports a hash of the installed package NEVRA
inventory, and rejects a host with less than 20 GiB free instead of failing
halfway through an image generation transfer.

This is an operator/bootstrap workspace check, not runtime-build admission.
The separate `runtime_builder_inventory` Terraform output identifies a standalone
build CVM and its exact attached CBS. It must not be added to the strict
management platform inventory. `prepare-bootstrap-host.sh` does not initialize or mount
that disk and must not be mistaken for its readiness proof. Keep the original
bootstrap host as the owner of the shared release/qualification operation lock.
Build handoff requires independently verified storage initialization and actual
bulk-path admission on the standalone host; never start a compiler on a control
worker merely because `/data` exists.

`validate-runtime-builder-storage.py` is the read-only preflight for initializing
an empty dedicated disk, not the initializer itself. It requires the separate
inventory and a fresh `actor-runtime-builder-storage-observation/v1` document:

- native `DescribeInstances` and `DescribeDisks` responses selecting exactly one
  matching private running CVM and exclusive attached data disk, including ownership
  tags, zone, security group, capacity and request identities;
- management `kubectl get nodes -o json`, proving that the builder is not a TKE node;
- the builder's live metadata instance ID, resolved exact disk by-id link,
  `lsblk` JSON with filesystem, UUID, mount, serial and byte-capacity columns,
  root-device ancestry and an empty `wipefs` signature observation for that exact device.

The source response must not be renamed to invent unsupported API fields.
The locked provider 1.83.11 uses the disk ID as its attachment resource ID, not
an independent cloud attachment UUID; the planner therefore also checks the
live CBS `InstanceId` ([provider implementation](https://github.com/tencentcloudstack/terraform-provider-tencentcloud/blob/v1.83.11/tencentcloud/services/cbs/resource_tc_cbs_storage_attachment.go)).
Observations older than 120 seconds or from the future fail closed. Disk letters
are not identities: the expected link, disk serial and cloud disk ID must agree.
Root ancestry is cross-checked with the actual mounted root in `lsblk`. Existing
partitions, filesystems or mounts are rejected, even if the cloud attachment matches.

Native API representations are joined, not rewritten: `PublicIpAddresses` may
be `null` ([CVM field contract](https://cloud.tencent.com/document/api/213/15753)).
The private-only gate additionally requires explicit zero outbound bandwidth and
no positive public-IP assignment; missing fields, positive bandwidth or any
public address reject. `Shareable=false` and the exact attached `InstanceId`
remain mandatory. The documented non-shared `InstanceIdList=[]` and the actually
observed `[exact builder ID]` are accepted; another instance, duplicate/multiple
IDs or null/missing lists reject. The [CBS field document](https://cloud.tencent.com/document/api/362/15669)
describes an empty list, while the Beijing native receipt records the singleton
representation. This observed difference is not a claim that the documentation
promises that representation. Projection checks key presence before retaining
nullable values, so an omitted field cannot silently become a successful null.

```bash
"${ACTOR_BOOTSTRAP_PYTHON:?qualified Python 3.11 is required}" validate-runtime-builder-storage.py \
  --inventory /protected/runtime-builder.inventory.json \
  --observation /protected/runtime-builder.storage-observation.json
```

`collect-runtime-builder-storage.py` now obtains this observation using the configured
cloud CLI, an exact management inventory/kubeconfig and the existing `tat-run.sh`.
It projects only required CVM/CBS fields and ownership tags; unrelated login settings,
annotations and credential material must not enter the evidence. The guest program
uses stock Python 3.6-compatible syntax and receives only the instance/disk selectors,
not cloud credentials. It verifies the instance metadata before reading any disk.
The metadata endpoint is Tencent's documented
[instance-ID endpoint](https://cloud.tencent.com/document/product/213/4934).

Stock util-linux 2.32.1 returns exit status zero and **empty stdout**, rather than
JSON, for `wipefs --json --no-act` on a blank disk. The collector normalizes only
that exact successful empty output, corroborated by `lsblk` reporting no
filesystem, UUID, mount or child partitions. Nonzero exit, malformed/nonempty
JSON and contradictory block observations still fail closed. This compatibility
handling grants no formatting or build admission and changes no disk identity gate.

```bash
"${ACTOR_BOOTSTRAP_PYTHON:?qualified Python 3.11 is required}" collect-runtime-builder-storage.py \
  --inventory /protected/runtime-builder.inventory.json \
  --management-inventory /protected/management-inventory.json \
  --management-kubeconfig /protected/management.kubeconfig \
  > /protected/runtime-builder.storage-observation.json
```

The earliest cloud observation and guest observation must both be fresh and ordered.
The collector reports the immutable TAT invocation separately; a timeout is not
permission to submit the same operation blindly. Collect that invocation with the
existing TAT waiter. A successful capture still grants no formatting permission.
Tests use actual subprocess protocol doubles and the real TAT shell helper, covering
wrong management/node/metadata identities and already-used disks without cloud writes.

The plan hashes both exact input files and deliberately keeps `storageReady=false`.
It performs no cloud mutation, formatting, mounting, cleanup or runtime rollout.
`initialize-runtime-builder-storage.py` implements the separate mutating guest
phase. The coordinator must hold the original operations lock for collection,
transfer and the complete TAT invocation; the guest's local file lock is not a
second fleet lock. Install qualified Python 3.11 without creating a `/data`
workspace first. Transfer only the reviewed helper sources, immutable separate
inventory and a freshly collected observation; no cloud credential goes to the
builder. A saved preflight is not authorization to format.
No observed management PVC, including a disk currently named `/dev/vdb`, is a
candidate build disk. Rerunning against an already formatted dedicated build disk
without its matching journal refuses initialization.

```bash
# Only on the exact standalone builder, through the lock-owning coordinator.
python3.11 initialize-runtime-builder-storage.py \
  --inventory /protected/runtime-builder.inventory.json \
  --observation /protected/runtime-builder.storage-observation.json --execute
```

The initializer recollects live guest metadata/serial/root ancestry and rechecks
the two-minute cloud observation before formatting. It never guesses a disk
letter. It writes and fsyncs a private root-backed journal at
`/var/lib/actor-runtime-builder-storage/journal.json` **before** calling `mkfs`.
The journal binds exact inventory bytes, instance, CBS, capacity and a generated
filesystem UUID. Its phases are `formatting -> formatted -> mounted`. Existing
partitions, signatures or mounts cannot be adopted without the matching journal;
foreign UUIDs, nonempty underlying `/data`, existing bulk directories, conflicting
fstab/units, root ancestry, TKE membership and stale cloud observations fail closed.
No existing files or cache trees are moved or removed.

If formatting succeeds but its response is lost, resume validates the recorded
ext4 UUID and read-only `e2fsck`, never reformats the filesystem. An empty journaled
format intent may retry the same UUID; partial/foreign filesystem signatures fail
closed. A mounted/finished journal can never return to formatting. Preserve the
original TAT invocation on timeout and collect it before submitting a resume.

Persistence uses the exclusive managed `data.mount` unit, UUID-based source,
actual `findmnt` plus a fresh block observation, and a unique UUID link resolving
to the same CBS. There is no `nofail` fallback to root storage. `/var/lib/actor-build`
is created only as an absent-path link to `/data/actor-build`; existing trees are
rejected, not migrated. The managed Buildah configuration is
`/var/lib/actor-runtime-builder-storage/storage.conf`, with GraphRoot on `/data`.
Later preparation/build invocations must explicitly propagate
`CONTAINERS_STORAGE_CONF` to this file and verify Buildah's actual `info` result.
The existing storage admission checker must still inspect all actual bulk paths,
available bytes/inodes and root reserves. `mountVerified=true` deliberately keeps
`storageReady=false`; mounting is not toolchain/cache admission or permission to
compile on the old control node.

For a resume, the original collector's `--attached-only` mode captures an
already-initialized disk without requiring emptiness. It preserves the same
cloud/root/TKE identity fences, only proves `action=verify-attachment`, and never
grants formatting or build admission. The default collector/planner remains the
strict fresh-empty path. Local tests run real journal files and subprocess
protocol doubles, plus a native ext4 regular-file signature/fsck probe. They do
not prove cloud block mounts, reboot persistence, actual cloud coordination,
toolchain installation or controlled build handoff; those remain cloud gates.

`run-runtime-builder-storage.py` is the operations-host coordination entrypoint.
It verifies the exact reviewed `.actor-source` revision and manifest for the
initializer, collectors, planner, coordinator and existing lock/TAT helpers.
The full manifest supports the real repository's spaces, brackets and `$` in
unrelated filenames; only the fixed selected tool closure is transferred.
It re-execs through the original `with-autonomy-operation-lock.sh`, verifies
that the lock is actually held and that live instance metadata identifies the
inventory's original operations host. A variable saying "lock held" alone is
not evidence. No alternative fleet lock or cloud credential is sent to the
builder. Run it as a supervised operations-host job, not a disposable local
client process.

```bash
# From the immutable reviewed source tree on the original operations host.
python3.11 run-runtime-builder-storage.py \
  --inventory /protected/runtime-builder.inventory.json \
  --management-inventory /protected/management-inventory.json \
  --management-kubeconfig /protected/management.kubeconfig \
  --source-revision "$REVIEWED_TOOLS_REVISION" \
  --source-manifest-sha256 "$REVIEWED_TOOLS_MANIFEST_SHA256" --execute
```

The coordinator stores and fsyncs its private root-backed intent at
`/var/lib/actor-runtime-builder-coordinator/<instance-id>.json` before submission.
The identity binds exact inventory bytes, reviewed tools and actual transfer
payload. Keying it by host, not input hash, prevents reordered or changed inputs
from silently obtaining a second submission authority. The one bounded TAT
workflow also holds a private per-host intent lock: sibling commands beneath
the same fleet-lock supervisor cannot race the intent or replace its handle.
That lock does not confer fleet-operation authority. The bounded TAT
command materializes its exact credential-free closure under a new private
`/var/tmp` directory, so it does not create `/data` before the disk initializer.
The payload digest uses the actual bytes sent by TAT, including its command
substitution's removal of trailing newlines.

The coordinator makes one CLI submission attempt and disables the TAT helper's
submission retry loop. Once its invocation is recorded,
observation failure retains the operation lock and reuses `tat-wait.sh` for
that exact invocation. Restart from `submitted`, or from a native success whose
output was not saved, also only collects the original command. Unknown status
never permits a fresh command or build handoff. A lost submission response
leaves `submitting` and blocks reruns: collect the exact original command using
the recorded unique command name before any operator repair. This is not an
atomic transaction across local storage and TAT, nor a promise that a crashed
operations host retains a kernel flock. Preserve the intent and supervise the
job; never clear it or resubmit merely because a waiter disappeared.

A completed duplicate call returns its previously verified receipt. That is
historical evidence, not a new mount observation. `--recheck --execute` permits
a fresh attachment/journal/mount check only after the original native terminal
result is collected. Keep the original reviewed tool identity when resuming.
The receipt still says `storageReady=false`; Buildah, bulk-path admission,
toolchain/cache preparation, real CBS/reboot verification and build handoff
remain independent gates. Real lock/TAT subprocess tests cover local protocol
semantics, not cloud qualification.

For an initialized standalone builder, the same coordinator's `--prepare-host`
mode transfers `prepare-runtime-builder-host.py` and its exact reviewed closure.
It uses separate root-backed intent under
`/var/lib/actor-runtime-builder-host-coordinator`; never change or clear the
initialization intent to install tools. The original operations lock, fresh
native attachment/TKE exclusion, source-manifest checks, single submission and
same-invocation recovery remain mandatory. Use the same arguments shown above,
adding `--prepare-host`, from the new reviewed tooling source.

The guest requires the matching mounted journal, UUID, by-id/serial/capacity,
managed mount unit/config and existing bulk directories before running dnf.
It checks root/bulk byte and inode reserves and refuses a root-backed `/data`.
The declared packages combine the bootstrap tools with the native Engine/Host
compiler prerequisites; Node uses the explicit distro `nodejs:20` stream.
Temporary files and dnf cache are on the mounted disk. Every child receives
the managed `CONTAINERS_STORAGE_CONF`, and actual `buildah info` must report
`/data/actor-build/containers/storage`. Post-install guest identity, mount,
journal and reserves are checked again without inventing a fresh cloud
timestamp. The receipt deliberately reports `packageReady=true` and
`storageReady=false`. Pinned Rust, offline Cargo vendor, complete actual-path
admission and stage/build provenance still require separate evidence. This mode
never formats, imports cloud credentials/kubeconfig or compiles product code.

Static source admission also requires a real offline Kustomize renderer. After
package preparation, use `--install-render-kubectl /data/actor-build/source/<artifact>/kubectl`
with the same inventory, management inputs and reviewed-source arguments. This
mode has its own immutable intent at
`/var/lib/actor-runtime-builder-render-coordinator/<instance-id>.json`; it must
not rewrite initialization or package intents. The binary is pinned to the
official Linux/amd64 v1.30.14 checksum in `install-runtime-builder-render-tool.py`.
It is installed atomically without replacement at
`/data/actor-build/tools/render-kubectl/v1.30.14/bin/kubectl` with mode 0555.
An unrelated existing binary fails closed rather than being overwritten.

Hold the original operations lock through artifact transfer and installation.
For the existing COS relay, set both `RELAY_BUILDER_FILESYSTEM_UUID` and
`RELAY_BUILDER_DISK_ID` from the matching mounted journal/inventory. Guarded
relay verifies metadata, exact by-id mount, non-root backing, resolved destination
and partial-file identity before download and before rename. It cannot silently
fall back to root storage. Neither variable is needed for legacy transfers to
the operations host. Never send a cloud credential or kubeconfig to the builder.
The installer rechecks fresh native attachment/TKE exclusion, mounted journal,
actual artifact filesystem and reserves. It runs `version --client` and a real
offline canary with `KUBECONFIG=/dev/null`, then checks the mount again.
`renderReady=true/storageReady=false` proves only this rendering prerequisite,
not cluster API compatibility, Rust/vendor preparation or runtime-build admission.
Later source admission must explicitly add this pinned directory to `PATH`.

The [Beijing native render receipt](evidence/runtime-builder-render-tool-beijing-20261004.json)
records guarded relay and independent guest/coordinator `SUCCESS/0` results,
matching the earlier filesystem UUID and journal hash. It does not grant build
admission or supersede the historical failed source-gate receipt. The subsequent
source-admission section separately records the original complete static gate
passing and publishing the 2757 source tree, without a Runtime build or rollout.

`--prepare-offline-toolchain` installs the reviewed qualification Rust and vendor
archives using the same coordinator and separate
`/var/lib/actor-runtime-builder-toolchain-coordinator/<instance-id>.json` intent.
The archive digests, Rust version and exact Cargo.lock are source-pinned in
`install-runtime-builder-offline-toolchain.py`. Changes require a newly reviewed
artifact set and source revision, not runtime discovery from a remembered q01
`bootstrap-node.json`. Use guarded relay under the original operations lock to
place the two exact archive filenames from that helper below
`/data/actor-build/source/` before invoking this mode.

The installer requires matching mounted journal and fresh native attachment/TKE
exclusion, checks real artifact/cache filesystem backing and reserves, rejects
oversized/escaping/duplicate/special archive members and link-controlled parents,
then publishes complete tool trees on the build disk. Files are extracted before
symlinks without adopting archive ownership. Existing trees are byte-checked
against the exact archive and are never silently repaired or replaced. Actual
Rust/Cargo versions, installed lock, mount and journal are checked afterwards.
`toolchainReady=true/storageReady=false` is only offline installation evidence.
These qualification artifact pins are not proof of a fresh-machine artifact
producer, Cargo compilation, full actual-path admission, stage reuse or release.
Do not transfer Cargo credentials, host registry config or any kubeconfig.

For completed trees whose earlier installation failed its final validator,
`--verify-offline-toolchain` uses a separate
`/var/lib/actor-runtime-builder-toolchain-verification-coordinator` intent and
the guest's `--verify-only` path. Both completed trees must already exist.
Missing trees fail without installation; existing files are checked against
the entire pinned archives, and the real version outputs are compared as bytes.
The result binds `verificationOnly=true`. Preserve and collect the original
failed installation invocation and intent; verification never rewrites them
or makes their historical result successful. A successful version probe or
marker alone is insufficient to skip this full verification.

Host preparation installs Python 3.11 plus PyYAML as part of the declared
bootstrap tool set. Cell and management entrypoints resolve
`ACTOR_BOOTSTRAP_PYTHON` and use that qualified runtime; they never inherit
TencentOS's older `/usr/bin/python3` merely because of `PATH` ordering.

Node is selected from TencentOS's explicit `nodejs:20` module and is used only
by the immutable reviewed-source static gate (`node:test`); it is not copied
into a product image. Pinning the module stream avoids silently falling back
to TencentOS 3.1's Node 10 default on a replacement builder.

`install-pull-credential.sh` closes the first blank-cluster dependency. It:

1. joins the Terraform TKE/VPC/TCR identity to the complete image lock;
2. verifies the live TKE cluster, private TCR attachment and private DNS answer;
3. requires all 28 private repositories before minting a token;
4. creates one deterministic long-term cluster pull token only when no token
   or protected local credential already exists;
5. installs the exact `actor-fleet-tcr` Secret only in the role-specific
   namespaces; and
6. publishes an immutable non-secret receipt containing exact cluster,
   namespace and Secret UIDs.

An existing cloud token with a missing local credential is not rotated or
replaced automatically. That is an ambiguous partial failure and the operation
fails closed. Existing Kubernetes pull Secrets are byte-compared and likewise
never overwritten by this bootstrap path.

Example on the bootstrap CVM:

```bash
ACTOR_TERRAFORM_INVENTORY=/protected/actor-bj-k02-inventory.json \
ACTOR_IMAGE_INVENTORY=/protected/all-images.lock.json \
ACTOR_BOOTSTRAP_ROLE=cell \
ACTOR_CLUSTER_KUBECONFIG=/protected/actor-bj-k02.kubeconfig \
ACTOR_PULL_CREDENTIAL_STATE_DIR=/protected/pull-credentials/actor-bj-k02 \
ACTOR_PULL_CREDENTIAL_RECEIPT=/data/actor-qualification/receipts/actor-bj-k02-pull-bootstrap.json \
TENCENTCLOUD_SECRET_ID=... \
TENCENTCLOUD_SECRET_KEY=... \
  ./install-pull-credential.sh
```

The cloud credential is inherited from a protected process environment; it is
never an argument, file generated by this directory, or receipt field. The
long-term TCR credential remains under the `0700` state directory at mode
`0600`. Token rotation is intentionally a separate future operation because
it changes every namespace Secret and needs a cold-pull overlap proof.

An isolated bootstrap CVM does not need a mutable host `tccli` installation.
Mint one short-lived TCR token outside the blank Cell and pass its mode-0600
Docker auth file to `prepare-tccli-tool.sh`. The script resolves the
digest-pinned `base-tencentcloud-cli` image from the complete inventory,
requires the Cell's private TCR DNS answer, creates an identity-bound Buildah
working container, and emits an immutable non-secret receipt. Delete the
short-lived auth file immediately afterward. Then set `TCCLI` to
`tccli-container-wrapper.sh`. The wrapper passes credential variable names
(never their values) to the container and uses host networking plus
`internal.tencentcloudapi.com`; public API fallback is rejected for a
no-public-IP bootstrap node. This explicit bootstrap token breaks the otherwise
circular dependency between needing `tccli` to mint the long-lived pull token
and needing a pull token to obtain the reviewed `tccli` image.

Every later phase consumes this receipt. No phase may fall back to a public
image.

For management cluster C, acquire the complete upstream Argo CD HA install by
its reviewed hash. The URL may point at a protected COS relay, but changing the
endpoint never changes the accepted bytes:

```bash
mkdir -p /data/actor-qualification/sources
ACTOR_ARGOCD_HA_SOURCE=/data/actor-qualification/sources/argocd-ha-3.5.2.yaml \
ACTOR_ARGOCD_HA_SOURCE_URL=https://<protected-cos-relay>/argocd-ha-3.5.2.yaml \
  ./acquire-argocd-ha.sh
```

Then install the management platform floor:

```bash
ACTOR_TERRAFORM_INVENTORY=/protected/management-inventory.json \
ACTOR_IMAGE_INVENTORY=/protected/all-images.lock.json \
ACTOR_CLUSTER_KUBECONFIG=/protected/management.kubeconfig \
ACTOR_PULL_CREDENTIAL_RECEIPT=/protected/management-pull-bootstrap.json \
ACTOR_ARGOCD_HA_SOURCE=/data/actor-qualification/sources/argocd-ha-3.5.2.yaml \
ACTOR_MANAGEMENT_PLATFORM_RECEIPT=/data/actor-qualification/receipts/management-platform.json \
  ./install-management-platform.sh
```

This path uses the full `ha/install.yaml`, including all three Argo CRDs and
cluster RBAC. It resolves all four runtime images from the exact 28-image
inventory, installs only digest-pinned private references, waits for all eight
HA workloads, then records every workload and CRD UID. The management
Terraform root creates one schedulable worker in each of its three zones
because Redis, HAProxy, repo-server and API-server replicas use hard hostname
anti-affinity. A single bootstrap worker is not considered an HA platform.
The management Git service is the next receipt-bound phase:

```bash
ACTOR_TERRAFORM_INVENTORY=/protected/management-inventory.json \
ACTOR_IMAGE_INVENTORY=/protected/all-images.lock.json \
ACTOR_CLUSTER_KUBECONFIG=/protected/management.kubeconfig \
ACTOR_PULL_CREDENTIAL_RECEIPT=/protected/management-pull-bootstrap.json \
ACTOR_MANAGEMENT_PLATFORM_RECEIPT=/protected/management-platform.json \
ACTOR_MANAGEMENT_GIT_CREDENTIAL=/protected/management-git-publisher.json \
ACTOR_MANAGEMENT_GIT_RECEIPT=/data/actor-qualification/receipts/management-git.json \
  ./install-management-git.sh
```

This renderer consumes `git-service` only from the complete image inventory.
The cluster-owned immutable Secret is the credential authority; the local
mode-0600 publisher file is a reproducible client copy, not remembered cluster
state. The receipt binds the Gitea/PVC/Secret UIDs and read-only Argo access to
the management-platform receipt. `check-management-git.sh` revalidates that
contract without mutation before Git publication or ApplicationSet install.
Management controllers, observability and public API remain subsequent
receipt-bound phases.

The public Workers API has one additional, deliberate bootstrap handoff. It
cannot be managed by Argo until A/B routes exist and a real request has passed
the private CLB admission chain. Install and qualify it imperatively once,
then use `workers-api/gitops` to publish the exact credential-free resources
and create a commit-pinned `actor-management-workers-api` Application. The
installer proves that Argo adopts the existing Deployment and CLB Service
without changing their UIDs or the VIP. Its AppProject cannot manage Secrets;
the token Secret remains cluster bootstrap state. This is not a third Cell:
C remains the management/API plane, while A/B remain the runtime Cells.

For a Cell, Terraform creates two independent API-only CAM users whose policy
resource is exactly one bucket: `cold` for Depot and `backup` for FDB. Export
the sensitive output directly to protected mode-0600 storage, extract its
kubeconfig without logging it, then install the immutable Kubernetes Secrets:

```bash
ACTOR_TERRAFORM_INVENTORY=/protected/cell-inventory.json \
ACTOR_IMAGE_INVENTORY=/protected/all-images.lock.json \
ACTOR_TERRAFORM_SENSITIVE_BOOTSTRAP=/protected/cell-sensitive-bootstrap.json \
ACTOR_CLUSTER_KUBECONFIG=/protected/cell.kubeconfig \
ACTOR_PULL_CREDENTIAL_RECEIPT=/protected/pull-bootstrap.json \
ACTOR_STORAGE_CREDENTIAL_RECEIPT=/protected/storage-bootstrap.json \
  ./install-storage-credentials.sh
```

The operation joins the sensitive values back to the public Terraform bucket,
CAM-user, TKE UID, namespace UID, pull-Secret UID and image inventory. It
creates separate immutable `${cell}-runtime-cos` and
`${cell}-backup-credentials` Secrets and never serializes key material into its
receipt. Existing divergent Secrets fail closed; a runtime release can consume
the cold identity but cannot derive it from the backup key.

After pull, storage and TLS receipts exist, install the Cell-local platform
floor before registering the Cell with central Argo:

```bash
ACTOR_TERRAFORM_INVENTORY=/protected/cell-inventory.json \
ACTOR_IMAGE_INVENTORY=/protected/all-images.lock.json \
ACTOR_CLUSTER_KUBECONFIG=/protected/cell.kubeconfig \
ACTOR_PULL_CREDENTIAL_RECEIPT=/protected/pull-bootstrap.json \
ACTOR_STORAGE_CREDENTIAL_RECEIPT=/protected/storage-bootstrap.json \
ACTOR_FDB_TLS_RECEIPT=/protected/fdb-tls.json \
ACTOR_REGIONAL_PROFILE=/protected/beijing-profile.rendered.yaml \
ACTOR_REGIONAL_PROFILE_RECEIPT=/protected/beijing-profile.json \
ACTOR_CELL_PLATFORM_RECEIPT=/protected/cell-platform.json \
  ./install-cell-platform.sh
```

This entry point joins all prerequisite receipts before its first mutation,
checks every live namespace/pull/storage/TLS Secret UID, then installs Fleet
CRDs, the private FDB Operator, the exact regional Profile/Class, and the
private Cell-local controller. It deliberately does not install MachineSets,
`RivetCell`, Engine or workerd: those remain the subsequent Argo and runtime
phases. A restart converges the same resource UIDs and can only publish the
same immutable platform receipt.

Before creating the first `ShardClass`/Claim or planning a Cell,
`render-regional-profile.py` converts the reviewed FDB profile source to the
exact private `fdb-kubernetes-monitor` digest in the same image inventory. It
then recomputes `RivetCellProfile.spec`, updates the `ShardClass` digest, and
emits a receipt binding both to the image inventory. Use that returned
`profileDigest` in the C-side class/claim, Cell Terraform `fleet_binding`, and
`cell-spec.json`; never reuse the digest embedded in the public-source
template.

```bash
./render-regional-profile.py \
  --images /protected/all-images.lock.json \
  --output /data/tmp/beijing-profile.rendered.yaml \
  --receipt /data/actor-qualification/receipts/beijing-profile.json
```
