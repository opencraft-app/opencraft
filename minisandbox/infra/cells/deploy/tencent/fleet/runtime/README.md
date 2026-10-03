# Kubernetes Rivet runtime and Cell reporter

This directory deploys the non-durable portion of `actor-bj-k01` across two
physical TKE worker pools. Six Engine replicas, three NATS members and the
Cell agent select `fleet.actor.dev/control-pool=true`. Three workerd/host Pods
select `rivet.dev/compute=true` and tolerate only the matching NoSchedule
taint. Both layers use hard hostname placement and hard zone spreading, and
neither may schedule on the dedicated FDB pool.

Create and verify `tke-native-control-nodepool` before releasing these
manifests, then create `tke-native-runtime-nodepool`. The latter is ordinary
workerd compute and deliberately does not advertise PVM support. PVM sbxlet
requires a separately qualified node that proves a usable `/dev/kvm`; adding a
label to a standard CVM is not qualification.

Before creating auth Secrets or changing admission/runtime workloads, the
installer reads the Cell's actual control Nodes and validates Ready status,
scheduling fences, role isolation, unique identities and the required zone
count. MachineSet Ready replicas and `ZoneEquality` alone are insufficient.
`qualification-single-zone` is explicit; production never relaxes its
three-zone constraint to work around a Pending NATS or Engine Pod.

Runtime builds require actual bulk-storage isolation. `verify-builder-storage.py`
checks `/data`, the reviewed-source/workspace root and Buildah's reported
GraphRoot before `build-runtime-via-tat.sh` grants push authority, then rechecks
under the stable build lock before mounting the workspace. `build-image.sh`
also checks the actual stage, Cargo target and temporary directories before
image pulls and compilation. A directory named `/data` on the system filesystem,
a tmpfs/overlay/network backing, missing mount identity or inadequate headroom
fails closed. The checker is read-only and never formats, mounts or deletes data.
The observed Buildah store comes from its documented
[`info` JSON](https://github.com/podman-container-tools/buildah/blob/main/docs/buildah-info.1.md),
not an assumed default pathname.

The conservative initial policy reserves at least 20 GiB or 20% of nodefs,
whichever is larger, plus at least 64 GiB of build increment and 10 GiB or 10%
of each independent bulk filesystem. Paths on the same filesystem pay the
increment once, not once per directory. This is preflight admission, not a disk
quota or a measured peak bound for arbitrary builds. Concurrent writers and
late disk consumption can still invalidate a snapshot. Fresh workerd/V8 builds
need their own measured peak budget; this gate does not qualify them.
The system filesystem also needs 16,384 available inodes; each bulk filesystem
needs 81,920. Adequate free bytes alone cannot qualify an inode-exhausted build.

Canonical paths and disk layout must be established by Terraform/bootstrap
before building. Existing source bundles, stage receipts and caches must not be
silently moved, reformatted or deleted by the checker. The existing c631 product
can be released without rebuilding it, but the shared-root builder diagnosed on
2026-10-03 is deliberately not eligible for a new build until its storage is fixed.

The runtime image is built from the exact Beijing-qualified artifacts recorded
as OCI labels in `Dockerfile`. It must be supplied by registry digest. The
installer derives the runtime COS Secret inside Kubernetes from the existing
FDB blob credential Secret; it never writes credentials to this repository.
The source namespace for the long-lived pull-only `actor-fleet-tcr` Secret is
selected by `RIVET_CONTROLLER_NAMESPACE` and defaults to
`fdb-operator-actor-fleet-controller-system`. An isolated qualification
cluster may point it at its Cell namespace after copying the Secret through an
API-to-API pipe; registry passwords are never accepted as installer arguments.

On a clean builder, first produce the runtime stage directly from the bundled
workerd fork and checksum-locked FoundationDB client. It requires verified Zig
and Bazel executables but never extracts files from an older runtime image:

```sh
RIVET_SOURCE_DIR=/path/to/rivet \
RIVET_STAGE_DIR=/data/tmp/runtime-stage \
RIVET_STAGE_RECEIPT=/data/actor-qualification/receipts/runtime-stage-<run>.json \
RIVET_TOOLCHAIN_RECEIPT=/data/actor-qualification/receipts/runtime-toolchains-<run>.json \
WORKERD_ZIG=/protected/toolchains/<run>/zig/zig \
WORKERD_BAZEL=/protected/toolchains/<run>/bazel \
  ./prepare-stage.sh
```

The stage build defaults to `WORKERD_BUILD_JOBS=16` so a blank builder does
not derive an unsafe parallelism level from a large CPU count while compiling
the memory-heavy V8 translation units. Builders with measured headroom may set
another positive value. The selected value is recorded in the immutable stage
receipt; it changes build resource usage, not runtime identity.

The independently versioned workerd fork uses a serialized persistent build
workspace under `/data/build-cache/workerd-stage/<commit>-<tree>` by default.
This preserves Bazel and Depot-FFI Cargo artifacts across reviewed source
bundles, so an infra-only or runtime-configuration change does not rebuild all
V8 translation units. `WORKERD_BUILD_CACHE_DIR` may select another absolute
data-volume path. The cache is never trusted as release evidence: every run
still verifies the source bundle, locked fork commit/tree, toolchains, static
ELF properties, staged checksums, and a new source-bound stage receipt.

An existing physical workspace can be selected explicitly with
`WORKERD_VERIFIED_WARM_CACHE_DIR=/data/.../third-party`. This is a build-cache
adoption path, not an old-binary reuse path. It requires a real, clean checkout
at `workerd-fdb`, the exact locked fork commit/tree, and its existing
`rivet-history` link. The full stage and local production Rust closure must
match the reviewed source before and after the official fork compiler recipe.
The builder does not change that source link or the old workspace's code. It
retains the physical compiler path for Bazel/Cargo cache hits and records the
input digest in the new immutable stage receipt. A dirty checkout, differing
client input, missing graph or late source change fails closed. Blank builders
still use the default content-addressed cache and require no adoption flag.

An incremental release may use `reuse-stage-from-runtime.sh` only after the
verified base and release source agree on every stage input. This includes the
embedded Rust bridge's local production dependency closure rooted at
`rivet-depot-client` and `rivet-envoy-protocol`, not just the workerd fork bundle.
The gate resolves both locked graphs offline before any container access and
includes normal/build dependencies, workspace manifests, lockfile, Cargo
configuration, source bytes and executable modes. Dev-only Engine/Depot code
does not invalidate that stage. File links also bind their in-tree target's
content and mode; directory links, escaping links and missing graph inputs
fail closed. A changed compiled client requires a fresh stage, not a new label
on the old binary. The build must configure its verified offline Cargo sources
before invoking this gate.
The bridge's direct dependency roots are bound to the audited fork tree. A new
fork must use a fresh stage until that root contract is reviewed and updated;
matching two copies of an unknown fork is not permission to omit its new roots.

The full source-materialization gate checks the shell's helper invocation and
the helper's production-input proof separately. Its structural regression runs
without Cargo so a clean builder can materialize reviewed source before toolchain
installation. The actual offline Cargo/changed-input tests remain mandatory for
stage-reuse changes; neither check substitutes for the other or for a qualified
compiled-origin receipt.

Those tools themselves are installed from the official checksum-locked sources
without consulting `/data/build-cache`:

```sh
RIVET_TOOLCHAIN_DIR=/protected/toolchains/<run> \
RIVET_TOOLCHAIN_RECEIPT=/data/actor-qualification/receipts/runtime-toolchains-<run>.json \
  ./install-toolchains.sh
```

Then use the checked-in image build entry point instead of reconstructing the
Cargo/buildah sequence by hand:

```sh
RIVET_SOURCE_DIR=/path/to/rivet \
RIVET_STAGE_DIR=/path/to/runtime-image \
RIVET_STAGE_RECEIPT=/data/actor-qualification/receipts/runtime-stage-<run>.json \
RIVET_RUNTIME_CONFIG_FILE=/path/to/rendered-production-config.jsonc \
RIVET_RUNTIME_BASE_IMAGE=registry.example/actor-fleet/runtime-base@sha256:<digest> \
RIVET_RUNTIME_IMAGE_TAG=registry.example/actor-fleet/rivet-runtime:<release> \
ACTOR_PRODUCT_BUILD_RECEIPT=/data/actor-qualification/receipts/product-rivet-runtime-<run>.json \
REGISTRY_AUTH_FILE=/secure/temporary-auth.json \
./build-image.sh
```

Engine and Host are glibc-linked because Engine uses the FoundationDB client.
Before Cargo starts, the builder compares its `GNU_LIBC_VERSION` with the
digest-pinned runtime base and fails closed unless they are identical. The
Beijing clean builder and the Rocky 8 runtime base both use glibc 2.28. A
newer workstation may prepare and verify the static-musl workerd stage, but it
must not publish the final runtime image; transfer the verified stage to the
qualified builder instead.

The OS-only base is a separate artifact built from `Dockerfile.base` with a
digest-pinned `ROCKY_IMAGE`. Mirror the resulting base into the private registry
before a release. Runtime builds require its exact digest, record it as an OCI
label, and do not install packages or contact public OS registries. Do not use
the previous complete runtime as this base: that would retain obsolete binary
layers and grow the image across releases.

Applied source bundles carry `.actor-source/SOURCE_REVISION` and the complete
`.actor-source/RELEASE_SHA256SUMS`; the builder reads and verifies those by default.
Explicit source identity variables remain available only for audited recovery.

A blank builder starts from a deterministic full reviewed-source bundle and
its immutable machine-readable receipt:

```sh
RIVET_SOURCE_DIR=/data/mono2/minisandbox \
RIVET_SOURCE_REVISION=<full-mono2-commit-id> \
RIVET_SOURCE_BUNDLE=/protected/source-<full-commit-id>.tar.gz \
RIVET_SOURCE_RECEIPT=/protected/source-<full-commit-id>.receipt.json \
./bundle-full-reviewed-source.sh
```

`RIVET_SOURCE_DIR` names the project root, not necessarily the Git repository root. The bundler derives
the committed project path and records the mono2 repository tree, `minisandbox` project path, and exact
project tree in its v2 receipt. The archive itself starts at the project root, so a blank builder never
receives unrelated mono2 services and existing build entrypoints keep the same layout.

The operation never replaces either output. An exact replay is idempotent, and
an interrupted bundle-without-receipt publication can only be completed after
the deterministic bytes compare equal. Publish both files to protected remote
storage; a local Git commit or local bundle is not a clean-room recovery
artifact. The blank builder consumes the receipt rather than separately copied
revision and manifest values:

```sh
./materialize-full-reviewed-source.sh \
  /incoming/source-<full-commit-id>.tar.gz \
  /incoming/source-<full-commit-id>.receipt.json
```

When the builder still runs a pre-v2 source tree, use the workstation-side
`qualification/actor-bj-q01/materialize-full-reviewed-source-via-relay.sh`.
It sends the bundle, receipt, verifier and materializer through the
content-addressed COS relay, checks all four exact hashes on the builder, and
creates the immutable source directory without changing the promoted `current`
link or any workload.

The script first verifies every reviewed source file against the supplied
manifest, runs an executable WorkerLoader ABI test against the exact staged
`workerd` binary and its built-in config schema, builds both Rust binaries with
`--locked`, and makes both the
fresh host binary and the built container parse the exact production config. It
embeds the source revision and source-manifest hash in the image, refreshes the
staged worker, runs the Dockerfile self-checks, records artifact hashes as OCI
labels, pushes with the caller-supplied temporary auth file, cold-pulls the
exact registry digest, checks those labels again, publishes its immutable
product receipt, and prints the registry-reported digest. It never creates or
stores a cloud credential.

When a builder starts from a reviewed warm tree, generate and apply the complete
delta rather than copying a remembered list of files:

```sh
RIVET_SOURCE_DIR=/local/rivet \
RIVET_BASE_REVISION=<builder-base> \
RIVET_SOURCE_REVISION=<release-revision> \
RIVET_SOURCE_MANIFEST_FILE=/path/to/complete-reviewed-SHA256SUMS \
RIVET_SOURCE_BUNDLE=/tmp/rivet-release.tar.gz \
./bundle-source-delta.sh

RIVET_SOURCE_DIR=/builder/rivet \
RIVET_BASE_REVISION=<builder-base> \
RIVET_SOURCE_REVISION=<release-revision> \
RIVET_SOURCE_BUNDLE=/incoming/rivet-release.tar.gz \
./apply-source-delta.sh
```

The bundle carries the complete changed-file list, base/release revisions,
per-delta hashes and the separately generated complete release manifest.
Application validates that full manifest against the prospective base-plus-
delta view before modifying the builder tree. Deltas containing deletions fail
closed and require a fresh full source tree, because an overlay cannot prove
that deleted source is absent.

`rivet-cell-reporter` is a separate ServiceAccount and Deployment. It verifies
the bound FDB identity, profile digest, FDB/backup generations and health,
three-zone Pod topology, runtime Pod readiness, and required Secrets before
refreshing `RivetCellReport`. It also reads the exact Cell UID's persistent
Object count from the management-owned Worker Registry; a missing or malformed
response prevents report refresh rather than manufacturing a zero count. The
initial manifest deliberately publishes
`capacity.riskLevel=AdmissionClosed` and `qualification.ready=false`; the new
runtime is not placement-eligible until its own immutable Actor qualification
receipt exists.

Qualification is release-scoped rather than a sticky Cell flag. A publisher
must set `QUALIFICATION_RELEASE_DIGEST` from the verified receipt independently
of `RELEASE_DIGEST`. The reporter emits `qualification.ready=true` only when
the two exact `sha256:` values match; the Fleet controller compares them again
before opening placement. Consequently every runtime release automatically
invalidates the previous qualification without interrupting already placed
Objects. Reusing the old receipt, copying the new digest into both fields before
qualification, or treating Pod readiness as qualification violates the release
contract.

Install with registry-reported digests, never mutable tags:

Bootstrap also validates the resolved Engine PubSub driver before changing the
runtime ConfigMap or starting Engine. A zero exit from `config show` is not
enough: older flattened-enum binaries can silently discard an unsupported NATS
option and use in-process memory. The gate requires the actual resolved NATS
driver. The base template therefore does not require the newer optional
`connection_timeout_ms` field; enabling that tuning requires a separately
qualified compatible Engine image, not a new workerd build during a rebuild.

An interrupted first install may resume from NATS-only, or from exact
Engine/NATS workloads while the Cell is still `Provisioning`, no Host exists,
and no static release ledger exists. The latter path never deletes NATS with
Engine alive. A mature Cell with a missing workload remains fail-closed.

```sh
KUBECONFIG=/path/to/admin.kubeconfig \
ACTOR_IMAGE_INVENTORY=/data/actor-qualification/receipts/all-images-<run>.lock.json \
RIVET_WORKER_REGISTRY_URL=http://cell-worker-registry:8080 \
RIVET_COLD_BUCKET=<terraform-cell-inventory.storage.cold> \
./install.sh
```

An admitted Cell must use the management-owned regional Worker Registry, not
the Cell-local qualification fixture. The create-first order is deliberately
`install.sh` (bootstrap without a ledger), Registry binding, then the first
`release-runtime.sh`. Binding is rejected once a static release ledger exists;
all later endpoint changes require a user-transparent Runtime release. Bind the
regional private endpoint before opening public placement with the
transactional entry point below. It validates the endpoint
receipt and Cell VPC, changes the Host Registry fetch origin and qualification
Workers API publish origin with UID/resource-version guarded patches, rolls
both workloads, and emits the immutable binding receipt consumed by public
admission. This prevents a canary from publishing to a Cell-local Registry
while runtime Hosts fetch from the regional Registry:

```sh
ACTOR_REGISTRY_BINDING_PRE_ADMISSION=true \
RIVET_CELL_NAME=actor-bj-k01 \
RIVET_CELL_VPC_CIDR=10.161.0.0/16 \
ACTOR_WORKER_REGISTRY_ENDPOINT_RECEIPT=/protected/worker-registry-endpoint.json \
ACTOR_REGISTRY_BINDING_RECEIPT=/protected/actor-bj-k01-registry-binding.json \
KUBECONFIG=/protected/cell.kubeconfig \
  ./bind-worker-registry.sh
```

The operation restores the preceding StatefulSet and qualification Workers API
revisions if rollout or live qualification fails. It is intentionally
unavailable after admission: a
post-admission Registry migration requires a separate user-transparent release
protocol rather than this bootstrap repair.

The Hub reaches each admitted Cell through a dedicated, source-bounded private
Engine load balancer. Publish it from the Terraform-selected Cell subnet and
retain its immutable identity receipt; the public Workers API renderer consumes
the endpoint only through that receipt:

```sh
RIVET_CELL_NAME=actor-bj-k01 \
RIVET_DATACENTER_NAME=local-runtime-a \
RIVET_ENGINE_PRIVATE_SUBNET_ID=subnet-... \
RIVET_ENGINE_HUB_CIDRS=10.160.0.0/16 \
RIVET_ENGINE_ENDPOINT_RECEIPT=/data/actor-qualification/receipts/actor-bj-k01-engine-endpoint.json \
KUBECONFIG_PATH=/protected/cell.kubeconfig \
  ./install-private-engine-endpoint.sh
```

The generated Tencent CLB accepts only the declared private Hub CIDRs. Its
receipt intersects datacenter, spoke RivetCell UID, Service UID, subnet and
private address; an address copied from another Cell is therefore not a valid
Workers API input.

`install.sh` first installs the Cell-scoped runtime admission/capacity
controller, waits for every exact Machine/Node UID to carry durable admitted
evidence, and only then applies the workerd StatefulSet with hard
`runtime-admitted=true` affinity. A new Cell therefore cannot schedule workerd
on an unprobed Node and cannot deadlock merely because its StatefulSet does not
exist yet. `install-admission-controller.sh` is also an explicit first-stage
entry point for operators that need to inspect admission before continuing the
release; normal releases should keep using the single transactional entry
point.

For production, operators and agents must use the transactional release entry
point instead of calling `install.sh` directly:

```sh
RIVET_RUNTIME_PROFILE=production \
ACTOR_IMAGE_INVENTORY=/data/actor-qualification/receipts/all-images-<run>.lock.json \
RIVET_WORKER_REGISTRY_URL=http://cell-worker-registry:8080 \
RIVET_COLD_BUCKET=<terraform-cell-inventory.storage.cold> \
./release-runtime.sh
```

The complete inventory supplies the exact runtime, reporter, NATS and metrics
images plus both product source identities. Repeating any of those environment
variables is allowed only when it is byte-for-byte identical to the inventory;
an independent override fails before Kubernetes is read or mutated.

`release-runtime.sh` snapshots the live ConfigMap, checks FDB/full replication/
reconciliation and Restorable backup, starts a disposable compatibility Job
that verifies the image's embedded revision/manifest and parses the rendered
production config, and only then calls the installer. It audits all six
Engine replicas and every currently desired runtime Host, the exact digest and
at least three-zone placement afterward. Runtime Host replicas are dynamic
capacity owned by HPA/Host drain: an update preserves a live count above the
three-Host floor, waits for every such replica to become updated and Ready, and
never writes that count into the static release ledger. Any rollout failure
restores the exact ConfigMap snapshot and rolls both Engine and runtime hosts
back before returning failure. Qualification is deliberately a separate next
step and must not overlap this transaction.

Reporter qualification environment is lifecycle state owned only by
`publish-qualified-release.sh`; it is absent from the static runtime manifest
and from the static release digest. Before an update, `release-runtime.sh`
removes all five qualification variables with that same `kubectl-set` field
manager and waits for the reporter's fail-closed defaults to become Ready.
This both closes new placement and prevents Server-Side Apply ownership
conflicts. A failed transaction restores the exact previous reporter template,
including its prior qualification state.

After all health gates pass, the release publishes `${CELL}-release-ledger` and
an external receipt. The ledger binds reviewed runtime/control source manifests,
registry-resolved image digests, release-owned workload specifications, the two
non-secret configuration maps, and image preflight contracts. Both the Cell
reporter and host autonomy audit compare live state with this ledger. Replica
counts, MachineSet capacity, Node admission/drain state, FDB process counts and
Secret data are deliberately absent because they have different owners.

The installer performs a one-object Server-Side Apply ownership migration for
the runtime ConfigMap because Cells installed by the older workflow may still
record `kubectl-replace` as the owner of `data.config.jsonc`. The
`--force-conflicts` transfer is deliberately scoped to the extracted ConfigMap.
The installer similarly reclaims only the workload image and manifest-hash
fields that an earlier transactional rollback may have left under the
`kubectl-patch` manager. That minimal apply uses a separate
`rivet-runtime-release-fields` manager so omitting selectors and other
installer-owned workload fields cannot prune them. All other workload fields
and resources retain ordinary conflict detection, and rollback writes under
the same scoped manager.

NATS has a component-local manifest identity derived only from `nats.yaml` and
the Cell name. Runtime source revisions, runtime images, and runtime tuning are
deliberately excluded. A routine Engine/Host release therefore reapplies the
same NATS desired state without changing its Pod template revision; replacing a
NATS Pod belongs to the separate dependency rollout and its lame-duck gate.

Runtime tuning is selected at install time and does not require another image
build. `production` is the default: its FDB write-debt target/limit are 10/12
MiB and each workerd host admits 16 recoveries plus a queue of 64. For daily
development, install the same immutable image with the short profile:

Production also allows one in-flight serverful placement transaction per
`(namespace, pool)` in each Engine process. This process-local contention gate
does not replace the exact FDB `SlotsKey` reservation; it bounds burst conflict
tails while six Engine replicas retain six-way placement concurrency. The
three-second Agent ready qualification includes this queueing time.

```sh
RIVET_RUNTIME_PROFILE=e2e-fast \
RIVET_RUNTIME_IMAGE=registry.example/rivet-runtime@sha256:... \
RIVET_REPORTER_IMAGE=registry.example/actor-fleet-controller@sha256:... \
RIVET_NATS_IMAGE=registry.example/nats@sha256:... \
RIVET_WORKERD_METRICS_IMAGE=registry.example/observability-busybox@sha256:... \
RIVET_WORKER_REGISTRY_URL=http://cell-worker-registry:8080 \
./install.sh
```

`e2e-fast` uses a 256 KiB write-debt target with 2 MiB of commit headroom,
admits two recoveries plus a queue of 16 per host, and shortens Depot's periodic
reclaim wake from production's 10 minutes to 5 seconds. The installer renders the
write-debt values into the typed runtime ConfigMap, the reclaim interval into the
Engine environment, and all tuning into the manifest hash, so changing a profile
causes a controlled rollout, not a rebuild. The
individual `RIVET_FDB_WRITE_DEBT_*` and `RIVET_WORKERD_*` variables remain
available for deliberate experiments. `RIVET_DEPOT_RECLAIM_INTERVAL_MS` may be
set from 1000 through 86400000 milliseconds; invalid values fail installation
and Engine validation instead of silently falling back.

The installer validates that the per-Cell runtime token is exactly 64 lowercase
hex bytes, repairs an older newline-terminated token, recreates only affected
runtime hosts, and allows 45 minutes for a safe sequential StatefulSet rollout.
Engine runs six steady-state replicas with preferred hostname anti-affinity and
hard, region-portable spreading across three `topology.kubernetes.io/zone`
values. Its PDB retains four replicas; rolling updates use `maxUnavailable: 0`
and `maxSurge: 1`, so all six serving replicas remain available until a
replacement passes startup and readiness. Engine placement keeps two steady
replicas in each zone while allowing the temporary seventh surge Pod to colocate;
hard anti-affinity would make that surge permanently unschedulable. The HA
qualification independently requires the six steady Ready replicas to remain
evenly spread over three hosts and zones before and after its crash injection. Rivet's
Engine is horizontally replicated over the same
FDB/Gasoline state and a shared NATS PubSub plane. Process-local `memory`
PubSub is valid only for one Engine process: putting multiple such processes
behind a Service makes requests routed to non-owning processes fail with
`no responders`. NATS therefore runs as a three-member StatefulSet with hard
cross-zone anti-affinity and a two-member PDB. Its ordinal is only a stable
cluster DNS identity; core NATS holds no durable Actor data and has no PVC.
This HA contract is separate from Actor execution
ownership: a live Actor generation remains fenced to one runtime-host process.
The StatefulSet ordinal is a stable operational slot, but the Envoy UUID is
fresh on every process start; a replacement must acquire a new generation
rather than inheriting the old owner's identity.
The Pods retain a 620-second termination grace period so production upgrades
can drain Actors instead of terminating them at the Kubernetes default.
Engine's `preStop` first creates a Pod-local draining marker. The one-second
readiness check removes that Pod from service discovery, then a ten-second
propagation window elapses before SIGTERM starts Guard's graceful shutdown.
Workers API gateway fetches deliberately do not pool HTTP/1.1 connections to
Engine across requests, so EndpointSlice removal also changes the backend used
by the next non-idempotent POST. Both halves are required: a fixed sleep alone
cannot drain established keep-alive connections, while closing a pooled
connection immediately exposes an ambiguous transport failure that the
platform cannot safely replay.

The cold-only gate records two distinct bounded planner wakes. The live final
checkpoint proves online service continuity, then a second force-reclaim
request is issued only after every Actor is asleep and all three host
registries are back at baseline. This prevents a legitimate live shard pin
from turning the only reclaim request into a completed no-op. Qualification
failures atomically preserve a terminal JSON receipt containing the last
inflight stage and error; the wrapper adds the immutable before/after release
binding even when the harness exits non-zero.

The production distinction between compute sleep, cold publication, hot-cache
reclaim, and physical object GC is specified in
[`durable-object-idle-and-cold-policy.md`](durable-object-idle-and-cold-policy.md).
`rivet-workerd-host` handles both SIGINT and Kubernetes SIGTERM, so an already
drained Pod exits promptly while the 620 seconds remain an upper safety bound.

### Serial Host drain

Automatic workerd scale-in is not delegated to HPA. The Cell reporter contains a durable pure
state machine that observes all Host aggregate admission counters, persists one target Pod name and
UID in the runtime StatefulSet annotation, and removes only the highest ordinal after that exact
Host reports zero Actors, zero in-flight requests, an empty queue, and quiescence. Remaining Actor
and request capacity must stay at or below 70 percent, all observations must be fresh, and low load
must remain stable for five minutes. A demand increase or ten-minute drain deadline restores the
Host capacity instead of force deleting it. Kubernetes resource-version and UID preconditions make
action replay idempotent and prevent a replacement Pod from inheriting an old drain.

The workerd Host publishes `capacity=0` through the existing Envoy metadata message while draining.
Pegboard treats zero as a hard placement fence and rechecks that durable FDB value before starting
the delayed `GoingAway` wave, so a cancelled drain does not run a stale eviction task. The
Host does not also emit `ActorIntent::Sleep`: that would race Pegboard's `GoingAway` transition and
convert a planned relocation into an on-demand cold wake. This leaves one lifecycle owner and keeps
rollout recovery independent of how often a client revisits each Actor. The
cluster-addressable management listener is deliberately separate from the SQLite bridge and exposes
only authenticated health, aggregate stats, and a 1 KiB drain request on port 19083.

Release-time serial replacement uses the same endpoint from inside the target Pod. After closing
local admission and publishing zero capacity, every `draining=true` request emits a
generation-scoped Pegboard sleep intent for each Actor still owned by that Host. The installer
reissues the idempotent request until both Actor registries, in-flight requests, and the admission
queue are exactly empty; it never interprets a timeout as permission to delete. A stale intent is
discarded by Pegboard's generation fence and cannot stop a replacement owner. A release predating
this active-drain protocol cannot be qualified as user-transparent under continuous Actor traffic:
upgrade it once in an explicitly recorded maintenance bootstrap, then require the continuous
public `/v1` upgrade/rollback gate for every subsequent release.

The checked-in production manifest keeps `HOST_DRAIN_MODE=Disabled`. Enable `Automatic` only
together with a qualified scale-up path; otherwise an idle Cell could safely shrink to
`HOST_DRAIN_MIN_REPLICAS` but have no mechanism to add the capacity back under later demand.

Production `install.sh` also installs the standalone Host-drain controller and its HPA from
`host-autoscaling.yaml`. The HPA owns scale-out demand only and has Kubernetes scale-down
disabled; the UID-fenced controller is the sole replica-decrease writer and pauses whenever a
`statefulset-uid-cas-v1` release hold exists. Production defaults are 4..301 Hosts at 16 active
Actors per Host. Four is the smallest safe three-zone StatefulSet floor after arbitrary Pod or
Node replacement: deleting the highest ordinal from a three-Host set can otherwise remove the
only Host in one zone. Scale-in preserves all three zones and permits at most skew 2 while walking
an ordinal prefix; normal scheduling continues to enforce `maxSkew: 1`. The external metric
adapter must be healthy before the Cell is admitted for automatic
scale-out; without it the HPA and drain controller fail closed rather than shrinking capacity.

Release and qualification acquire the same UID/resourceVersion-fenced hold. A passive
`Observing` state has not selected or fenced a Host, so the hold builder may atomically reset only
that stabilization timer to `Idle` while installing the hold; `Selected` and every later drain
phase must finish or abort normally. After the hold is visible, the workflow also waits until the
runtime MachineSet has no exact downscale intent and none of its Nodes retains a downscale fence.
This prevents a provider-side Node deletion that trails a completed Host contraction from changing
the immutable Pod set during release or qualification. Dynamic release binding accepts the full
production HPA envelope of 3..301 Ready Hosts and still requires the exact desired Pod UID set to
remain unchanged across each qualification.

The runtime capacity Deployment has one `Recreate` writer per MachineSet. Orphaned Node drain
recovery requires an API-server JSON Patch test of the MachineSet UID and resourceVersion before
the existing Node UID/resourceVersion/owner CAS removes its fence. A GET without an intent is not
proof that a committed intent is absent. If the exact original Machine and Node still exist but an
intent's entire fence is missing, only zero provider attempts and an empty RequestID permit its
CAS cancellation. Capacity, topology, emptiness, and stabilization must then be evaluated again.
An attempted operation, replacement UID, partial fence, or another owner's fence remains fail closed.
Do not scale this writer above one replica without a cross-resource ownership protocol.

For a known zero-attempt intent whose exact Node has completely lost its fence, set
`RUNTIME_CAPACITY_CONTROLLER_RECOVERY=1` on the normal `release-runtime.sh` transaction.
The default is `0`. This does not skip capacity settle: after acquiring the release hold, the
workflow captures original templates, validates the candidate runtime config and both controller
entrypoints, then validates the exact MachineSet/Machine/Node identities. It creates an immutable
`${cell}-cap-recovery-${hold-id}` ConfigMap journal before the UID/resourceVersion/template-CAS
controller-image patch. The singleton `Recreate` controller must clear the unattempted intent under
the hold before any Engine/Host/NATS rollout proceeds. It never directly edits an intent or Node.
Accepted/attempted operations, partial fences and replaced identities are not recoverable this way.

Before full rollout starts, a failed recovery restores only its exact controller template under
the same live hold. A foreign template, replaced Deployment/StatefulSet UID, or failed rollback
retains the hold and immutable journal. A hard-killed release likewise leaves durable evidence;
this journal is not automatic release resumption. The full transaction still owns the final static
ledger and closes placement during replacement. Retain the journal for incident review; do not
delete it or steal a hold to make a failed release look successful.

`RIVET_CELL_REPORTER_MODE=disabled` is reserved for isolated runtime qualification
clusters that deliberately do not install the production Fleet CRDs (for example, a
three-FDB-node performance probe that cannot claim the nine-node production profile).
It removes all seven reporter resources from the rendered runtime manifest. Such a cluster
must deploy the standalone `workerd-host-drain-controller` before enabling scale-in;
production Cells keep the default `enabled` mode.

After rollout, run the real Actor path rather than accepting readiness probes as
qualification:

```sh
KUBECONFIG=/path/to/admin.kubeconfig \
QUALIFICATION_RECEIPT=/secure/receipts/runtime-actor-smoke.json \
./qualify-runtime.sh
```

An autoscaling Cell also has a fixed-base data-plane gate. With the production
target of 16 active Actors per Host, `production-cell` drives 48 Actors across
the three base Hosts. Its recovery phase issues two simultaneous idempotent
reads per sleeping Actor (96 requests total), so all three per-Host admission
limits and zero-reject/zero-timeout behavior are exercised without inflating
persistent Actor density. Queue deltas are measured strictly from the
post-sleep baseline and retained as observations, but this 48-Actor profile
does not require every `max_in_flight=16` Host to queue: that is mathematically
dependent on placement and service latency. The 96-Actor `production` profile
retains the three-Host queue requirement. It requires the
same checkpoint, Bottomless, cold-read, and recovery proofs as `production`.
It deliberately is not claim-eligible on
its own: Cell readiness additionally requires the separate 100 Agent/s
scale-out/serial-drain receipt, Engine HA, and independent backup restore.

```sh
QUALIFICATION_PROFILE=production-cell \
QUALIFICATION_RECEIPT=/secure/receipts/runtime-production-cell.json \
./qualify-runtime.sh
```

The matching daily gate is intentionally small and short:

```sh
QUALIFICATION_PROFILE=e2e-fast \
QUALIFICATION_RECEIPT=/secure/receipts/runtime-actor-e2e-fast.json \
./qualify-runtime.sh
```

For a detached production gate, follow the original immutable invocation at a
low cadence instead of repeatedly querying it by hand. The monitor defaults to
one TAT status check every five minutes, prints only terminal command output,
then downloads, hashes, and verifies the receipt:

```sh
TAT_INSTANCE_ID=ins-builder \
TENCENT_PROFILE=protected-profile \
./monitor-bottomless-qualification.sh \
  inv-existing \
  /var/log/actor-qualification/bottomless-production.json \
  ./receipts/bottomless-production.json \
  production
```

Set `BOTTOMLESS_MONITOR_POLL_SECONDS` to another value of at least 30 seconds
when needed. Disconnecting the monitor is harmless; resume the same invocation
ID and never submit a duplicate qualification.

It runs the same checkpoint, cold-state, cold-read, bounded recovery, wake,
integrity, and cleanup state machine with 18 Actors, a 3 MiB Bottomless probe,
and a five-minute cold-state ceiling. The script refuses to run when its
qualification profile differs from the deployed ConfigMap annotation. Receipts
are stamped `development-e2e`; they are useful regression evidence but can
never open production admission or replace the `production` release receipt.
Both profiles require the synchronized wake to exercise the bounded queue on
all three runtime hosts. The production receipt additionally must pass
`verify_bottomless_receipt.py`, which rejects a relaxed SLO, partial-host storm,
cleanup residue, a logical size that merely crosses the compaction target, or
any non-production receipt scope. The harness also captures the immutable
runtime image digest, rendered-manifest hash, and exact 3+3 Engine/runtime-host
Pod UIDs before and after the run; any rollout during qualification invalidates
the receipt.

The smoke gate creates Actors through Engine, requires traffic on all three
workerd hosts, performs durable SQLite writes after an online COS checkpoint,
and proves reads remain live during the final checkpoint. The checkpoint freezes
an evidence watermark without closing Actor admission; new commits form a hot
tail and may slow under FDB write-debt backpressure. The gate then proves sleep
and releases runtime-local hot-shard pins, waits for exact cold-only state, then
performs a generation-advancing cold wake. It deletes the exact test Actors and requires
both host and bridge registries to return to their pre-test baseline. It does
not open fleet admission or replace the 2K/4K capacity qualification. The
default background-settle window is 60 minutes because COS sinking is allowed
to be slow; this does not relax the independent 10s/20s/30s p95/p99/max cold
read SLO. Qualification-policy cleanup is concurrent and bounded by the same
worker pool, so a failed gate does not serialize 96 network timeouts.

Each qualification checkpoint explicitly requests bounded force reclaim. This
only wakes the existing reclaim planner immediately: retention, history pins,
branch generations, exact COS publication and hashes, and FDB transaction
budgets remain mandatory. A force request that cannot prove those conditions is
a recorded no-op or failure; it is never an unsafe delete override.

After that data-path gate is idle, prove the steady Engine replicas tolerate a
real Pod loss:

```sh
KUBECONFIG=/path/to/admin.kubeconfig \
ENGINE_HA_RECEIPT=/secure/receipts/runtime-engine-ha.json \
./qualify-engine-ha.sh
```

该门禁持续通过公共 `/v1` Agent/DO API 发流量，并使用 Kubernetes
`DeleteOptions.preconditions.uid` 对选定 Engine Pod 做零宽限删除。普通优雅删除不能作为
Engine 崩溃证据；UID precondition 也保证名称相同的新 Pod 不会被迟到的故障动作误删。
门禁复用 Cell-scoped `<cell-suffix>-engine-ha-gate` Worker，只通过公共 API 删除本轮 Object。Worker 一旦
绑定 DO namespace，产品协议会永久拒绝删除，因此“删除 Worker”既不是清理条件，也不能
通过创建每轮唯一 Worker 来规避；receipt 必须记录固定 fixture 被保留。

The drill first requires six Ready Engine Pods balanced two-per-host across three
standard Kubernetes zones, a PDB with `minAvailable: 4`, and one immutable
image. An in-cluster probe uses only the public `/v1` Workers endpoint: it
uploads a Version, creates a Deployment and ten independent `ObjectRef`s, then
keeps opening new public fetch connections while the harness gracefully
deletes one exact Engine Pod. It never calls `/actors` or `/gateway/{actor_id}`.
All 1500 reads must succeed, a post-failure SQLite write must persist, all
qualification Objects and the Worker must be deleted, and the Deployment must
return to six cross-zone replicas. The receipt records stable public resource
identities, the deleted Pod UID and before/after topology. Run this separately
from `qualify-runtime.sh` so its port-forward cannot pin the data-path test to
the Pod being removed.

When direct SSH is unavailable, use `../tat/tat-run.sh`,
`../tat/tat-upload.sh`, and `../tat/tat-download.sh`. Transfers are
bounded, hash-verified, and atomically installed. The helpers deliberately wait
for terminal `TaskStatus`; Tencent TAT exposes a zero `TaskResult.ExitCode` even
while a task is still `RUNNING`. Run `../tat/test-tat-tools.sh` after editing
the helpers; its local fake TAT verifies that exact state transition as well as
multi-chunk and empty-file round trips.
Submit the hour-scale production Bottomless gate with `tat-run.sh --detach` so
it returns an immutable invocation ID immediately. Collect that same invocation
later; never duplicate the remote qualification to regain a local progress
display.
