# Beijing serverless qualification cluster

`actor-serverless-qual-bj` is an isolated, disposable qualification target for
the Actor serverless data plane. It reuses the Beijing Actor VPC, private
builder, TCR and three zonal subnets, but it must never reuse the production
TKE cluster, FoundationDB database name, TLS identity, COS bucket or runtime
Cell ID.

The initial cost envelope is fixed and intentionally has no unbounded cloud
autoscaler:

- three `SA9.LARGE8` control workers;
- three `SA9.LARGE8` workerd workers, with 30 placement slots and one reserved repair-surge Machine;
- nine `SA9.LARGE16` FoundationDB workers with one retained 200 GiB BSSD each,
  with a bounded scale-out ceiling of 30.

The official price inquiry on 2026-09-03 returned a discounted compute and
system-disk estimate of CNY 0.19/hour for `SA9.LARGE8`, CNY 0.26/hour for
`SA9.LARGE16`, and CNY 0.08/hour for a 200 GiB BSSD. That makes the initial
worker envelope about CNY 3.84/hour, excluding TKE management, COS requests
and small ancillary storage.

The qualification Cell uses the same minimum `three_data_hall` shape as the
product: nine hostname fault domains, nine coordinators, and a 3/3/3 zone
distribution. A three-node `double` database is not a valid RivetCell and the
CRD intentionally rejects it.

The three zonal node subnets are `/24`s and the runtime pool uses
`ZoneEquality`. Before admitting an autoscaling test, preflight must prove at
least 64 free node addresses in every zone, not merely enough aggregate VPC
space. On 2026-09-03 the Beijing 6/7/8 subnets had 235/240/241 addresses free.
At the bounded maxima (3 control + 31 runtime including repair surge + 30 FDB), equal placement needs
21 node addresses per zone. GR Pod addresses come from the separate
`10.200.0.0/16` cluster CIDR; at 64 Pods per node the 64-node ceiling consumes
at most 4,096 Pod addresses. Both node and Pod headroom must be checked again
on every apply because the VPC is shared.

All three MachineSets use the q01-only security group. It admits east-west
traffic from the VPC node CIDR and `10.200.0.0/16` GR Pod CIDR. Reusing the
production node security group is forbidden: besides weakening Cell isolation,
it silently breaks cross-node Pod traffic when the qualification Pod CIDR is
not present. A preflight cross-node TCP matrix is therefore required before
FoundationDB creation and after every node-pool scale-out.

Create the empty managed cluster only after loading Tencent credentials from a
protected environment:

```sh
TCCLI=/data/build-cache/tencent-cli-venv/bin/tccli \
  QUALIFICATION_STATE_DIR=/data/agents/cloud/tencent-beijing-qualification/state \
  ./create-cluster.sh
```

The script is convergent by exact cluster name, rechecks both CIDRs for route
conflicts, enables TKE deletion protection, and writes only the cluster ID and
non-secret state beneath `/data`. It never creates a second same-name cluster.
`create-bootstrap-node.sh` also treats its local state as a cache rather than
cloud truth: every rerun requires the recorded CVM to be Running, a member of
the exact q01 TKE cluster, and TAT Online.  A missing node is archived as a
retired identity and replaced using a persisted idempotency token; a
response-lost creation is adopted only when the exact q01 name identifies one
unambiguous member.  State advances atomically only after all three readiness
checks pass.  The clean replacement must then run `install-builder-kubeconfig.sh`
and `bootstrap-operator-node-via-tat.sh` before it may execute an operation.
The already-created cluster and its four COS buckets are subsequently adopted
by the import-first module under [`terraform/`](terraform/). MachineSets remain
Kubernetes YAML so Terraform never competes with either TKE or the load-driven
runtime capacity controller for replica ownership.

Operator readiness does not imply image-builder readiness. After replacing an
operator, run `bootstrap-runtime-system-via-tat.sh` for TencentOS system build
dependencies, then `bootstrap-runtime-rust-via-tat.sh REVIEWED_RUST_SYSROOT` for
the reviewed Rust 1.96.0 toolchain. Both reject an instance other than the exact
converged operator. Rust is transferred through Beijing COS with a SHA-256-bound
archive and installed under `/data/build-cache/runtime-rust/1.96.0`. Run
`bootstrap-runtime-vendor-via-tat.sh REVIEWED_SOURCE_ROOT` to transfer an offline
dependency bundle keyed by the exact `Cargo.lock` SHA-256. Builds use an isolated
Cargo home under their `/data/tmp` stage, with networking disabled and sources
from `/data/build-cache/runtime-vendor/<lock-sha256>/vendor`. No Cargo credentials or registry
configuration enter the toolchain archive. System RPM versions are reported at
installation time, not claimed to be a hermetic package snapshot.
`build-runtime-via-tat.sh` checks all required executables before issuing or
transferring any registry push credential. A passed bootstrap is only build
readiness, never runtime release or public API qualification evidence.
It checks the exact Python 3.11 interpreter during preflight, then installs a
process-local `python3` shim for the complete remote build and cleans it on exit.
Setting only `ACTOR_BUILD_PYTHON` is insufficient: stage reuse and other child
helpers invoke `python3` themselves and must not fall back to TencentOS Python 3.6.
The system default interpreter is never replaced.

The q01 runtime and semantic-failure build wrappers default to one Cargo build job on the
4-core, 8 GiB operator. `RIVET_BUILD_JOBS=2` is the only higher supported setting there.
The validated value is sent to the remote Cargo environment; a local environment variable alone
would not constrain the TAT process. The build also runs in a unique systemd scope with
`MemoryMax=6G`, `CPUQuota=200%`, and `TasksMax=512`. Scope setup failure fails the build;
there is no fallback to unrestricted compilation. This preserves management headroom on this
operator, but does not establish that a prior management outage was caused by OOM. The real
operator preflight verified the memory controller limit as `6442450944` bytes.
The q01 wrappers override only release LTO from `fat` to `thin`; opt-level 3 and the workspace's
one-codegen-unit setting remain unchanged. A controlled cloud build proved that both GNU ld and
lld fat-LTO links exceed the operator's 6 GiB build cgroup, while raising that boundary would consume
the node's Kubernetes allocatable memory. Thin LTO keeps cross-crate optimization without weakening
the management-plane memory fence. The wrapper selects the distribution `clang` plus `ld.lld`
through a fixed, reviewed linker wrapper and does not inject `RUSTFLAGS`. System bootstrap installs
and records the exact `lld` RPM, and proves the linker with a real executable before a build can mint
push authority.
Keep monitoring and command delivery usable during compilation; never start a replacement build
while the previous invocation is still executing. If TAT retains a stale cancelling record after
a verified host reboot, require different previous/current boot IDs and absence of compiler
processes before treating the old execution as fenced; never infer this merely from a timeout.

Publish the separately built OS-only base with `publish-runtime-base.sh LOCAL_IMAGE`.
It verifies that `actor-fleet` is private, creates only the `runtime-base` repository
when absent, and uses a temporary registry token in a disposable Docker config.
The publication tag binds the complete local image ID; success requires pulling
the registry digest and comparing the resulting image ID. No CAM policy is changed.
The Beijing base published on 2026-09-07 is
`lightclaw-bj82.tencentcloudcr.com/actor-fleet/runtime-base@sha256:74e21d110ae9b2d5409c36a53bfd7097bae4cc00e0302e5c8a12eac62bca4308`.
Pass it as `RIVET_RUNTIME_BASE_IMAGE` to both normal and semantic-failure builds.

Bootstrap and operation use only the same-VPC builder through TAT. A temporary
public Kubernetes API is not an accepted management path. Capacity is applied
in control, workerd, then FDB order; every pool must become Ready before the
next is admitted.

The builder is not assumed to have public Internet egress. Install COSCLI with
`install-coscli-via-relay.sh /data/build-cache/coscli/v1.0.9/coscli`: the wrapper
verifies the pinned v1.0.9 digest locally, transfers the immutable binary through
the qualification COS relay, and re-verifies it before installation on the
builder. Direct download remains a developer fallback, not the clean-room path.

The FDB 9→12→9 production gate is launched through
`run-fdb-autoscaling-qualification.sh`. The wrapper fixes the q01 Cell,
ShardClass, StorageProfile, MachineSet and production workload sizes; builds
and publishes the load generator; consumes only the registry-returned digest;
and writes its receipt beneath `/data/actor-qualification`. Operators provide
no release identity arguments after a reviewed source bundle has been applied:
the wrapper reads and revalidates `.actor-source/SOURCE_REVISION` and the full
`.actor-source/RELEASE_SHA256SUMS`, generates the run ID, publishes the load generator,
uses only the registry-returned digest, and selects the fixed receipt path.
Explicit source-identity variables remain available only for audited recovery.
Calling the generic qualifier with a hand-assembled environment is a debugging
path, not the operating procedure.

If a qualification is externally cancelled only after its exact 9→12
`FdbScaleOperation` succeeded, the normal failure trap deliberately preserves
the safe expanded topology. Recovery uses `run-recover-expanded-fdb.sh`, with
`ALLOW_FDB_EXPANDED_RECOVERY=1` and the exact successful source operation name.
It rejects active load generators, non-restorable backup, nonzero public Agent
occupancy, incomplete replication, a digest-mismatched profile, or an already
existing later contraction. It then supplies only temporary scale-down
evidence to the normal fleet controller and waits for the controller → FDB
Operator → TKE chain. It never patches FDB process counts, MachineSet replicas,
or deletes a volume directly; the three released CBS volumes must finish in
the normal 30-day quarantine before its recovery receipt can pass.
The trusted operator launches the long recovery asynchronously with
`run-recover-expanded-fdb-via-tat.sh EXACT_OPERATION`; the printed immutable
TAT invocation is resumed rather than resubmitted after a client disconnect.

The load generator reaches the Cell only through
`http://actor-bj-q01-workers-api:8080/v1`: it publishes or reuses the fixed
`q01-fdb-autoscale-gate` Worker, creates deterministic Agent ObjectRefs, advances
their Durable Object SQLite state before and after both topology changes, and
deletes those exact ObjectRefs. The production verifier rejects a Job containing
`--engine-url` or lacking `fleet.actor.dev/public-api-only=true`; internal Actor
creation is not acceptable evidence for this product qualification.

The FDB gate retains 1,000 deterministic public Objects across both topology
changes, but activates them in batches of 32 and waits 45 seconds after each
batch, beyond the reviewed 30-second Host idle interval. The outer qualifier
independently samples Cell occupancy, runtime StatefulSet replicas and runtime
MachineSet replicas for the complete run. A receipt is rejected if occupancy
exceeds the three-Host warm envelope or either runtime resource moves away from
exactly three replicas. Large active concurrency remains the responsibility of
the separate Agent-arrival and load-driven runtime qualifications.

From the trusted operator host, the normal entry point is only:

```sh
./run-fdb-autoscaling-via-tat.sh
```

Large dormant-cardinality refreshes use the same entry point and must set the
bounded `ACTOR_QUALIFICATION_ACTORS`, `ACTOR_QUALIFICATION_PROBES`, concurrency,
batch, pacing and idempotent-retry variables together with
`ACTOR_LOADGEN_TIMEOUT_SECONDS` and `ACTOR_QUALIFICATION_TAT_TIMEOUT_SECONDS`.
The wrapper validates those values before contacting TAT and writes their exact
shell-quoted values into the remote command. Actor cardinality is capped at one
million, the workload timeout at 24 hours, and the enclosing TAT timeout at 24
hours. The small periodic qualification retains the existing defaults.

The gate deliberately restores the bootstrap `ObserveOnly` policy before it
writes its terminal receipt.  The one-time production transition is
`promote-fdb-automatic-via-tat.sh`: it resolves the latest receipt and the
atomically promoted reviewed source only on the private builder, runs
`promote-fdb-automatic.sh RECEIPT`, and returns the immutable promotion receipt
through the content-verified COS relay.  Under the same global operation lock it
requires the newest terminal attempt, runs the independent receipt verifier,
binds the exact Cell/FDB/MachineSet UIDs, rechecks a restorable backup and zero
active Jobs/scale operations, then advances the profile and ShardClass digest
as one guarded transition.  Any failed convergence restores the exact
`ObserveOnly` policy.  The checked-in q01 profile is the post-qualification
`Automatic` desired state; hand-patching that mode is not an operating path.
Subsequent evidence refreshes start from either a stable `ObserveOnly` bootstrap
or the stable production `Automatic` policy, temporarily install the bounded
qualification thresholds, and restore the exact starting policy.  Receipt v3
records that baseline mode; the verifier retains v2 support only for the
one-time bootstrap gate.  A weekly evidence refresh therefore never requires
demoting an already admitted production Cell.

It resolves only the atomically promoted
`/var/lib/actor-build/deploy/actor-bj-q01-current` source link, uses the fixed
private kubeconfig, starts one TAT invocation and relies on the shared
operation lock to reject duplicates. If the client disconnects, resume the
printed invocation with `tat-wait.sh`; never submit a replacement run.
The link is changed only by `promote-reviewed-source.sh TARGET`; that command
revalidates the complete release manifest and all cluster-backed static gates,
then atomically swaps the symlink and writes a promotion receipt beneath
`/data/actor-qualification/source-promotions`. Every immutable target is named
`q01-src-<git-commit>-<release-manifest-sha256>` and promotion verifies both
components against the bundle metadata. The commit component is required even
when the file-content manifest is unchanged because Git also binds executable
mode and other tree metadata needed by the operating entry points.
The autonomy systemd entrypoint resolves this link once at invocation start and
then executes only the captured immutable physical tree.  A source promotion
therefore upgrades the next audit without reinstalling the service and cannot
mix files from two revisions inside one audit.

Create each immutable target with `materialize-reviewed-source.sh`; it copies
the reviewed base while excluding the root Cargo `target/`, applies the
content-addressed delta, and verifies the new complete manifest before the
target becomes eligible for promotion. Promotion marks the tree read-only.
The TencentOS builder prerequisite set includes `jq >= 1.6`, Python 3.6 or
newer, `sha256sum`, and `kubectl`; `promote-reviewed-source.sh` checks these
before running the source gates. On the current TencentOS 3.1 builder, install
the declared JSON tool with `dnf install -y jq` during host bootstrap.
Runtime builds always set `CARGO_TARGET_DIR` outside the source tree (normally
`/data/build-cache/rivet-runtime-cargo-target`), so source history cannot
silently multiply compiler caches or fill the builder root disk.
The builder serializes releases with a host lock and read-only bind-mounts the
verified immutable tree at a stable workspace path. `prepare-cargo-cache.sh`
hashes the complete transitive set of local Cargo packages for Engine and Host,
plus the compiler/linker contract. A changed input clears the bounded target;
an operations-only revision reuses it. This avoids both stale binaries from
archive timestamps and needless recompilation caused only by content-addressed
source directory names.
`build-runtime-via-tat.sh` is also the shared post-bootstrap build entrypoint:
set `QUALIFICATION_CELL_NAME`, `QUALIFICATION_KUBECONFIG`, and
`QUALIFICATION_SOURCE_LINK` to the exact reviewed Cell inputs. Their bounded
paths are validated before TAT runs; creating a fake q01 kubeconfig alias is
not an accepted multi-Cell operating procedure.

When a fresh stage has been built from the exact candidate source, transfer its
four artifacts, `STAGE_SHA256SUMS` and immutable receipt through the COS relay,
then select `QUALIFICATION_PREPARED_STAGE_DIR` and
`QUALIFICATION_PREPARED_STAGE_RECEIPT` below `/data/actor-build/`. Both must be
supplied. The entrypoint verifies source/manifest, fork and FDB identities,
fresh toolchain receipt identity, positive build parallelism, the canonical
four-artifact checksums and static ELF before issuing push authority. It repeats
verification after copying into its private stage. The original receipt bytes
are preserved, not rebound to a different source. This branch does not pull or
extract an older Runtime; the positional base digest is retained as the existing
command interface but is unused. Native Rust still builds in the stable,
serialized workspace with the same resource and ABI gates. The default remains
the separately validated previous-image reuse path.

For an Engine/Host-only release, the entrypoint may reuse the expensive
workerd/FoundationDB stage from a digest-pinned, previously qualified Runtime.
`reuse-stage-from-runtime.sh` first verifies both complete source manifests,
then compares every file, symlink, type, and executable bit in the
content-defining stage closure: the content-addressed workerd bundle and lock,
the Zig/Bazel and FoundationDB locks, the pool initializer, and the Depot ABI.
The orchestration shell and bundle verifier are intentionally outside that
closure: changing cache layout or strengthening validation does not change
artifact bytes, while the actual workerd compiler recipe is inside the locked
bundle. It also binds the base image labels to exactly one immutable
reviewed-source tree and verifies the extracted workerd hash and static-link
contract. Any artifact-input drift, ambiguous baseline, mutable image tag, or
missing identity fails before the product build. The new Runtime embeds a fresh
stage receipt; direct artifact copying without that receipt is not an accepted
build path.
Historical source used only for that comparison is materialized by
`materialize-runtime-baseline-source.sh` below `runtime-baselines/`. It still
checks the content-addressed bundle, every manifest entry, exact file inventory,
and safe archive paths, then makes the tree read-only. It deliberately does not
run today's release-policy tests and cannot be selected by source promotion.

Cluster bootstrap has two non-obvious, declarative prerequisites:

- run `install-private-registry.sh` from the trusted local operator host. It
  creates one q01-named long-term TCR credential, retains its only credential
  copy in the mode-0600 qualification state directory, and verifies the exact
  Token ID is still enabled on every rerun. It transfers only the generated
  Docker config to the builder and converges the fixed `actor-fleet-tcr`
  Secret in both control namespaces. If cloud metadata survives but the local
  credential is lost, installation fails instead of silently creating another
  long-term token. Tokens are never committed or placed in Terraform state;
  every required private repository, including the two digest-pinned build
  bases, must exist before that token is created. TCR instance tokens created
  before a repository may authenticate successfully yet be denied on push;
  repository creation followed by explicit token rotation is the only accepted
  repair path;
  the same installer binds the exact `cls-ike1rebd` VPC to a single Running TCR
  internal endpoint and verifies on the builder that the registry hostname
  resolves to that private address. Public/NAT registry access is not an
  accepted fallback;
- run `install-fdb-tls.sh` on the builder after generating q01 TLS material.
  It uses create/replace rather than `kubectl apply`, because the combined
  public/private CA bundle is large enough for a last-applied annotation to
  exceed the Kubernetes annotation limit.
- run `install-backup-credentials.sh` on the builder. The Secret contains the
  complete FDB blob credential document under the exact `credentials` key;
  splitting it into `api_key` and `secret` keys is invalid for both backup and
  runtime credential derivation.

The Fleet controller and every private q01 workload explicitly reference the
fixed registry Secret. Patching only the namespace `default` ServiceAccount is
not sufficient because these workloads use named ServiceAccounts.

The fixed `actor-fleet-tcr` Secret is the long-lived pull identity required for
unattended Pod and Node replacement. It is not the build writer. Controller
builds use `build-controller-via-tat.sh`, which mints a one-hour TCR token from
the protected operator identity, uploads it only to a unique mode-0600 builder
path, validates the reviewed source identity and private DNS route, then removes
the file on both the remote and local cleanup paths. A pull-capable long-term
token can therefore never be mistaken for proven push authority.

After the first runtime install creates the scoped runtime COS and auth
Secrets, install the public Worker API with `install-code-plane.sh`. Both image
references are resolved from the complete 28-image inventory named by
`ACTOR_IMAGE_INVENTORY`; a separately supplied digest must match it exactly.
The installer performs a server-side dry run and waits for all three replicas
of both services.

Apply `continuous-backup.yaml` only after copying the active q01 TLS material
to the independently named `actor-bj-q01-backup-tls` Secret. The manifest is
intentionally fully rendered: cluster, account hostname, bucket, object prefix,
tag and both Secret names must all contain q01. Reusing the k01 manifest with a
single Cell-name substitution is forbidden because the bucket and object-prefix
identities have a different string shape.

Code Plane installation is also fail-closed before rollout. The installer runs
each immutable Registry/API image once on every control node through the shared
image preflight, without a service-account token and without changing the live
Deployment. A missing manifest, invalid architecture, stale TCR credential or
node egress failure therefore preserves the old three-replica service and
cleans up the exact probe Pods instead of leaving an `ImagePullBackOff` rollout.
The installation holds the same fleet-wide operation lock as FDB scaling and
runtime/controller releases, so concurrent automation cannot delete another
run's probes or overlap a control-plane rollout with a storage transition.

The qualification code plane uses the independent private bucket
`actor-worker-code-qual-bj-q01-nv1-1388575217`. Its application-level Version
IDs are content hashes, so COS bucket versioning stays `NeverEnabled`; immutable
conditional PUT is the overwrite fence. It must not share the runtime cold or
FDB backup prefix.

Large deployment bundles and receipt transfers use the independent
`actor-build-relay-qual-bj-q01-nv1-1388575217` bucket under `relay/`. Objects
expire after one day and incomplete multipart uploads are aborted after one
day. It is a transport, never an evidence authority, and is never used for
runtime cold data, FDB backups, or Worker code. TAT carries only the short
reviewed command that downloads or uploads a SHA-256-addressed object.

Each terminal qualification also publishes an immutable, full-SHA-bound
ConfigMap through `operations/cache-qualification-receipt.sh`. The operator
hydrates `/data/actor-qualification/receipts` from those objects before every
autonomy audit. This makes the operator disk a disposable availability cache:
node replacement cannot turn passed gates into missing receipts. The cache is
not the disaster-recovery authority; durable cross-cluster retention belongs
in `actor-qualification-evidence-prod-bj-q01-nv1-1388575217`, never the one-day
relay. `persist-receipt-from-builder.sh` PUTs the exact SHA-addressed receipt,
reads it back and verifies bytes/SHA before updating the local copy and the
immutable cluster availability copy.

Install the pinned Tencent Go `coscli` binary with `install-coscli.sh`, then use
`relay-upload-to-builder.sh LOCAL_FILE ABSOLUTE_REMOTE_FILE` for those bundles.
Large receipts and logs travel in the reverse direction through
`relay-download-from-builder.sh ABSOLUTE_REMOTE_FILE LOCAL_FILE`: TAT returns only
the exact byte count and SHA-256, the builder PUTs to a unique 15-minute signed
Beijing COS relay URL, local COSCLI downloads and verifies the artifact, and the
exact temporary key is deleted. Do not use TAT output chunking for large evidence.
The local operator uses COSCLI—not AWS CLI—to upload with server-side
encryption and hash metadata, then gives the builder a 15-minute signed GET
URL. The builder checks both byte count and SHA-256 before an atomic rename;
the signed URL is never written to a repository or receipt.

Install the cluster-local Prometheus/Grafana stack with
`install-observability.sh`. The wrapper renders the shared physical FDB/COS
collector with the q01 Cell, bucket and qualification-only backup prefix; it
fails if a k01 identity survives rendering. The shared installer accepts that
rendered manifest through `ACTOR_INFRASTRUCTURE_METRICS_FILE`.

TKE owns `v1beta1.custom.metrics.k8s.io` and continuously reconciles it to a
provider for Tencent's fixed pod-resource metrics. The q01 Adapter does not
fight that control loop: it publishes Cell-filtered Actor occupancy through
the independent `external.metrics.k8s.io` API. HPA's `AverageValue=16` divides
the total occupancy by the current replica count and preserves the same
`ceil(active Actors / 16)` capacity rule.

Runtime autoscaling qualification is load-driven. Manually changing either the
StatefulSet or MachineSet replica count is only a network preflight and cannot
produce a passing receipt. A valid soak must show Actor occupancy crossing the
configured warm-capacity target, HPA creating runtime Pods, an Unschedulable Pod
causing `np-runtime0` to add TKE capacity, and the new Host accepting Actors.
The qualification HPA targets 16 active Actors against each Host's hard limit
of 32, retaining 50 percent warm headroom. HPA stops at 30 Hosts, while the
MachineSet reserves a 31st slot exclusively for one exact repair surge.
When load is removed, the serial Host-drain controller—not HPA—must fence and
remove at most one Host at a time before TKE reclaims its empty node. Warm
capacity creation remains subject to the three-second Actor-ready SLO; cloud
node provisioning time is reported separately and must never be hidden inside
that SLO.

Engine HA uses `run-engine-ha.sh` from the immutable reviewed source. The q01
wrapper owns the exact Cell, namespace, kubeconfig and unique receipt path, so
the operating procedure never assembles those identities by hand. It keeps
traffic on the public `/v1` Agent/DO API while an Engine Pod is removed by an
exact UID-preconditioned, zero-grace Kubernetes delete; a normal graceful
rollout is deliberately not accepted as crash evidence. Receipt schema v2
also proves that the exact deletion timestamp fell strictly inside the measured
1,500-request public traffic window; merely running traffic before and after a
fault is not accepted as continuity evidence. A successful q01 wrapper run is
not complete until the full receipt is also present in the Cell evidence cache.

Install the HPA, serial Host-drain controller, and TKE runtime-capacity
controller from one reviewed manifest. The controller image must be the exact
digest produced from the same source revision; the installer rejects tags and
performs a server-side dry-run before acquiring its dedicated SSA fields:

```sh
KUBECONFIG=/var/lib/actor-build/credentials/actor-bj-q01.kubeconfig \
RIVET_REPORTER_IMAGE=lightclaw-bj82.tencentcloudcr.com/actor-fleet/actor-fleet-controller@sha256:<digest> \
RIVET_RUNTIME_IMAGE=lightclaw-bj82.tencentcloudcr.com/actor-fleet/rivet-runtime@sha256:<digest> \
  ./install-workerd-autoscaling.sh
```

The installer intentionally never uses `--force-conflicts`. A field conflict
means another controller or an old manual workflow still owns part of the
autoscaling contract and must be resolved explicitly before unattended
operation. Once the 3-Host/3-node baseline is steady, run
`load-driven-soak.py`; only its immutable JSON receipt proves the complete
load-to-cloud-scale-to-serial-reclaim chain.

Exact runtime Machine repair is a separate provider qualification. Run
`qualify-runtime-machine-repair.sh` under
`operations/with-autonomy-operation-lock.sh`; it adds one empty surge Machine,
deletes only that Machine with a UID precondition, and requires every baseline
Machine UID to survive. Keep targeted repair disabled and omit Machine delete
RBAC until `verify-runtime-machine-repair-receipt.py` accepts the cloud receipt.
The receipt is bound to the live cluster and MachineSet UIDs. After it passes,
run `qualify-runtime-automatic-replacement.sh`: it temporarily enables the same
generic controller, injects one exact q01 Node-local quarantine, and requires
the drain, replacement, exact Machine deletion, surge contraction, and
Ready/admitted-capacity restoration loop to converge. A failed run removes
Machine delete RBAC automatically. A passing run leaves q01 enabled and writes
an immutable receipt; `configure-runtime-machine-repair.sh disable` is the
explicit fail-closed rollback.

`ZoneEquality` governs only creation; a provider replacement followed by an
ordinary contraction can therefore leave the three-Host floor in a `2/1/0`
zone distribution. The capacity controller continuously repairs that exact
steady-state skew by quarantining the newest Machine in the overrepresented
zone and reusing the same one-surge, Host-drain and UID-preconditioned Machine
deletion protocol. For the one pre-controller bootstrap incident, run only
`repair-runtime-topology.sh` with `TOPOLOGY_REPAIR_EXECUTE=true`. It accepts no
topology other than healthy `2/1/0`, and its immutable receipt must prove that
the target disappeared and three Ready/admitted Hosts returned in three
distinct zones. Once quarantine begins, the controller owns convergence;
operators must not manually restore, scale or delete the selected Node or
Machine.

`agent-arrival-rate.py` is the separate admission-rate gate. It first uses real
Agents to establish five warm Hosts, lets those Agents sleep, and then schedules
100 new Agent IDs over one second. Every sample includes the client scheduling
lag, object-create latency, first JS `fetch()` latency, and scheduled-to-chat-
ready latency; the gate fails if any Agent is not usable within three seconds.
The burst remains active until HPA and TKE reach the seven-Host recommendation,
then the test observes serial return to the 3-Host baseline and deletes all test
objects by exact ID.

The metric baseline is taken only after two unchanged Prometheus counter
snapshots separated by more than one scrape interval. Deployment prepare and
canary are synchronous at the API boundary but their Engine counters may appear
one scrape later; without this fence those system placements can be attributed
to the user batch. A Cell with unrelated placement traffic never reaches the
quiescent fence and therefore fails closed instead of relaxing exact accounting.

The canonical receipt name is
`<cell>-agent-arrival-<UTC>.json`. The Cell-neutral
`actor-cell-agent-arrival-rate/v1` receipt binds the immutable runtime image
and manifest plus the exact three base Engine/runtime Pod sets
before and after the scale cycle. It requires every internal unavailable result
to be explained by both the Envoy no-capacity and hard-capacity counters, caps
placement work amplification at 1.25x, average allocation-gate wait at 250 ms,
and the over-one-second gate tail at ten percent. These internal cost bounds are
composed with the harder user-visible three-second chat-ready SLO; a sampled
capacity miss is bounded backpressure, not a dropped user request. Transient
scale-out Pods may come and go, but the base set and release identity must not
change during the qualification.
The q01 autonomy service must set
`AUTONOMY_QUALIFICATION_MODE=autoscaling-cell`; this composes that receipt with
the `production-cell` Bottomless, Engine HA, and FDB 9→12→9 receipts. It never treats a `production-cell` receipt as independently
production-qualified.

The optional physical recovery exercise is documented in
[`physical-restore/README.md`](physical-restore/README.md). It is run explicitly
after storage-format, backup, or restore implementation changes and is not a
Cell admission or continuous-qualification prerequisite. Its receipt still
names the current source FoundationDB UID. Likewise, Engine HA receipts bind the
common Engine/workerd immutable release while allowing only the deliberately
replaced Engine Pod UID to change.

The restore workers are deliberately three replicas, one per availability
zone. Their count affects restore throughput, not recoverability, and must not
force the Cell to reserve nine GiB of idle general-purpose capacity. The gate
proves three Ready workers on three distinct Nodes and zones before the unique
restore tag is started, then scales the temporary Deployment to zero only after
the restored SQLite set passes. A Deployment may retain an old
`ProgressDeadlineExceeded` condition after being scaled down; recovery must
observe the current generation and Ready replica count, not treat that stale
condition as proof that the current Pods failed.

The 2026-09-08 current-release drill exposed exactly this capacity invariant:
the old nine-worker manifest could schedule only seven workers, so the gate
stopped while the restore tag was still uninitialized. After reducing the
reviewed shape to three and re-establishing one worker in each Beijing zone,
the same frozen twelve-Object seed was restored exactly once at FDB version
`369041481818`. All 6.33 GB of range blocks and the mutation log completed,
all twelve restored SQLite databases matched, source Objects were reverified
and deleted through public `/v1`, and the restore workers returned to zero.
The retained receipt is
`actor-bj-q01-dr-physical-restore-release-060b-20260908-v1-recovered.json`
(SHA-256 `fefc75b25b4a4c856a7202dcd0965b0ccdc21b3b9565403c487e659fb8b7b2b4`).

The current release also passed the real semantic-failure rollback gate. Argo run
`6ef9c21a5d760298ab9842879bb4f6b6` fully installed the bounded bad runtime, public `/v1`
observed the intended `fetch_failed`, and SyncFail restored the same 32 ObjectRefs to the exact
qualified runtime. The rollback served 963 successful public requests and its receipt SHA-256 is
`14dd596754692eaf052d500bd672f853d133a6e97b4126af5fbea517db266162`.
Stable intent run `38a58f0ce1df40e9a4792b314ddbf1a8` then served 1,532 public requests with zero
failures and returned Argo to `Synced/Healthy/Succeeded`; its receipt SHA-256 is
`94e6e9c02f342316ea99860ce9bdc506a2216edc8b2f93c801ab1dba5d1918a6`.
The failed preflight run `bb00e235b6330165adeb8e53c052f10d` is retained as evidence that a
candidate image without its exact immutable source tree is rejected before any live workload
change; the builder now preserves that source identity atomically.

Run the current-release Bottomless gate only through
`run-bottomless-production.sh`. It fixes the q01 Cell, `production-cell`
profile, public Worker/DO `/v1` application path, receipt location, operation
lock and in-cluster evidence cache. After its terminal TAT invocation, use
`runtime/monitor-bottomless-qualification.sh` with profile `production-cell`;
that step copies the exact receipt into the independent COS evidence bucket
and verifies the read-back hash. The Engine Actor routes recorded in the
receipt are privileged fault-injection and ObjectRef audit surfaces, never the
application API.

This warm-rate result must not be represented as a cold-node SLO. Reactive TKE
node creation is deliberately measured as elasticity and takes longer than
three seconds. Sustaining the same ready SLO for an unforecast cold burst
requires enough pre-existing hard Host capacity for the arrival window; HPA
cannot provision a cloud node retroactively.

The capacity math, bounded-burst interpretation, FoundationDB keyspace audit,
and adaptive allocation-conflict policy are maintained in
[`capacity-and-fdb-hotspot-design.md`](capacity-and-fdb-hotspot-design.md).
Qualification is incomplete unless the receipt and FDB transaction-attempt
distribution satisfy that document; adding storage servers is not an accepted
workaround for a contended single key.

Retirement is explicit: first close admission, prove no live Actor or dirty
cold-tier work remains, retain receipts, destroy test COS contents and CBS
volumes by exact identity, disable TKE deletion protection, and finally delete
this cluster. Never point the retirement procedure at `cls-0zvm1btp`.
