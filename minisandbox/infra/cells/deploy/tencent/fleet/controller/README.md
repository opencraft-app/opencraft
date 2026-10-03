# actor-fleet-controller deployment

Production images are built from a reviewed source closure and pushed by
immutable registry digest.  The source manifest contains `sha256sum` entries
relative to the repository root; both its hash and the full Git revision are
embedded in the OCI image and checked before release:

```sh
ACTOR_SOURCE_DIR=/var/lib/actor-build/deploy/<reviewed-source> \
ACTOR_FLEET_CONTROLLER_IMAGE_TAG=lightclaw-bj82.tencentcloudcr.com/actor-fleet/actor-fleet-controller:<unique-tag> \
ACTOR_FLEET_BUILD_BASE=lightclaw-bj82.tencentcloudcr.com/actor-fleet/base-golang@sha256:<digest> \
ACTOR_FLEET_RUNTIME_BASE=lightclaw-bj82.tencentcloudcr.com/actor-fleet/base-distroless@sha256:<digest> \
ACTOR_PRODUCT_BUILD_RECEIPT=/data/actor-qualification/receipts/product-actor-fleet-controller-<run>.json \
REGISTRY_AUTH_FILE=/var/lib/actor-build/credentials/actor-bj-q01-tcr-config.json \
  ./build-image.sh
```

The reviewed bundle's `.actor-source/SOURCE_REVISION` and
`.actor-source/RELEASE_SHA256SUMS` are the default build identity. Explicit identity
variables are reserved for audited recovery and receive the same hash check.

When `go.mod` or `go.sum` changes, build and push a new dependency base first
with `build-dependency-base.sh`, then pass its registry digest to the controller
build gate. The controller builder pulls that digest and requires its
`fleet.actor.dev/go-mod-sha256` and `fleet.actor.dev/go-sum-sha256` labels to
match the reviewed source exactly, so an old dependency cache fails closed
without coupling the build script to a manually updated source hash. The
release Dockerfile has no base default, so it cannot silently reuse a
historical digest. The dependency-base Dockerfile bootstraps from a
private, digest-pinned TCR image supplied as `ACTOR_FLEET_BOOTSTRAP_BASE`; the
TAT wrapper requires it to use the same regional registry host. A Beijing build
therefore never depends on Docker Hub, a retired registry, or public NAT, and
resolves newly introduced modules through Tencent's mainland Go module mirror.

The build cold-pulls the registry digest, rechecks the source OCI labels and
publishes a new immutable product receipt. The digest printed by the build is the only acceptable
`ACTOR_FLEET_CONTROLLER_IMAGE` input to `release-controller.sh`; tags are not
release identities.

The runtime capacity binary also provides
`--oidc-credential-self-check`. Run it inside the live controller Pod before
removing a qualification hold. It performs only the STS role exchange, prints
no credential material, and exits before creating Kubernetes clients or
starting a reconcile loop.

Both the STS exchange and the exact TKE deletion request use Tencent Cloud's
`*.internal.tencentcloudapi.com` VPC endpoints. The controller does not require
or justify a public NAT route.

Before changing either live Deployment, the release runs that digest and the
real controller/reporter binary once on every control node using each target
namespace's own pull Secret. Registry, credential, node-network and
architecture failures therefore preserve the previous version instead of
creating an `ImagePullBackOff` rollout.

The separate Go image also includes `workerd-host-drain-controller`; changing
its UID/RV-fenced topology repair logic does not require rebuilding workerd or
the unified runtime image. Its `--help` / `-h` exits successfully before
Kubernetes initialization, Secret reads or reconciliation. Runtime releases
probe this exact entrypoint and its expected help output on every control node
before mutating live workloads. A successful help probe proves only that the
entrypoint runs, not PDB behavior, Actor fencing, destination capacity or safe
scale-in. Topology repair remains disabled until its independent gates pass.

For a mono2-only controller build, export the **entire committed**
`minisandbox/infra/cells` Git tree under `infra/cells/`; do not assemble a
remembered file subset or include uncommitted source. Bind the full mono2
revision, subtree tree ID and per-file manifest in `.actor-source/`, scan the
closure, and transfer the content-addressed archive through the management
template's current COS bootstrap relay. Select the relay and TCR from current
management outputs, not the historical q01 defaults.

`qualification/actor-bj-q01/build-controller-via-tat.sh` accepts the exact
`/data/actor-build/deploy/controller-src-<revision>-<manifest-sha256>` path for
this build. It still accepts the reviewed legacy q01 inputs for existing
workflows, but the new path cannot point at `current`, a nested directory or
another revision/manifest. Validation happens before minting push credentials.
Temporary push authority is stored under `/data/actor-build/credentials/`,
removed by both remote and local cleanup, and independently expires. The build
requires pinned bases with matching Go module labels and retains the normal
isolated registry cold-pull receipt. This is an artifact preparation operation,
not permission to alter a Cell while a qualification supervisor holds its lock.

The [2026-10-04 initial candidate receipt](evidence/controller-product-03e7e7b7-20261004.json)
records a real Go-only build, registry push and isolated cold-pull for source
`03e7e7b7`. Its Go base does **not** match the current runtime-2757 complete
inventory, so this historical artifact cannot be promoted into that inventory.
It is **not deployed** and does not certify TKE topology repair or
the strict 10,000-active-object gate. Keep repair disabled until the real API,
generation, destination-capacity and serialized release gates pass.

Select controller bases from the **exact target release's complete inventory**,
not from bootstrap inputs or whichever cached base has matching module labels.
Module-graph equality is necessary for compilation but does not replace the
dependency-closure identity checked by `product-lock.py promote`. A controller
leaf promotion must preserve every other inventory entry, especially the
qualified runtime; do not change a foundation entry to accommodate a candidate.

The build wrapper keys new receipts by a NUL-separated SHA-256 of source revision,
source-manifest SHA-256, build-base ref, runtime-base ref and unique output tag.
It rejects an existing receipt before build/push. Different bases/tags therefore
cannot collide with the previous immutable proof; retry a disconnected operation
by its original TAT invocation, not by resubmitting the same build intent.
`PYTHONDONTWRITEBYTECODE=1` prevents receipt-generation imports from placing
derived caches in the reviewed source closure.

The [current-lock candidate](evidence/controller-product-03e7e7b7-current-lock-20261004.json)
passed real Go build/test, registry cold-pull and `product-lock.py promote`
against the runtime-2757 inventory. Comparison proved that only the controller
entry changed; the other 27 entries and remaining root metadata were preserved.
This is a **staged inventory**, not a cloud release or TKE/Actor qualification.

Execute release helpers from a frozen source snapshot, including their TAT
neighbours. Never edit a local waiter while its remote invocation is active:
the shell can report a footer parse failure even after the original remote build
succeeded. Resume that invocation, collect its immutable receipt and verify exact
credential cleanup instead of rebuilding or pretending the local exit passed.

Apply CRDs before this kustomization:

```sh
kubectl apply -f ../crds.yaml
kubectl apply -k .
```

The checked-in image tag is a development placeholder. A production or cloud qualification deploy
must replace it with a registry-reported `sha256` digest. The default deployment watches only
`actor-fleet-system`; use a separate overlay and a separate namespace for experiments.

The controller has read-only access to `RivetCellReport`. Grant Report write permission only to the
Cell Agent or qualification publisher in the watched namespace. It creates `RivetCellClaim`, but no
RBAC rule permits it to delete Claims, Cells or any cloud resource.

Operator-backed profiles may define `foundationDB.autoscaling`. `ObserveOnly` persists a
recommendation in `RivetCell.status.foundationDBAutoscaling` while retaining the baseline process
count. `Automatic` is intentionally a separate profile promotion: it changes the storage process
target in three-host steps only after fresh Prometheus capacity evidence, FDB reconciliation,
zero data movement and backup health gates pass. The FoundationDB Kubernetes Operator remains the
sole owner of process-group exclusion and removal.

The provider continuously stamps retained Tencent CBS PVs with immutable Cell, FDB cluster,
ProcessGroup, PVC and disk identities. Any future scale down fails closed unless every active
storage process has a complete inventory. `FDBVolumeRetirement` records the later Released-volume
quarantine; its production default is 30 days and its initial GC mode is `ObserveOnly`. This
controller deliberately has no delete verb or Tencent CBS deletion credential.

## MeshHarness capacity autoscaling E2E

`MeshHarness` is the deterministic composition mode for the Cell control plane: production
reconcilers run together against a fake Kubernetes API while adapters emulate OCM delivery,
FoundationDB Operator convergence, TKE capacity and Cell Agent evidence. Time and failures can be
advanced at durable boundaries without replacing the state machines under test.

Capacity signals come from one shared fake Prometheus endpoint. The production Cell reporter binds
every query to the target `cell` label before publishing evidence, so the harness covers both
cross-Cell metric isolation and the resulting control decisions. The Cell controller derives
`AdmissionClosed` and a monotonic epoch from the source Cell's evidence, the Pool creates a new
Cell, and later target pressure independently drives both another Cell Claim and the target's
9-to-12 FDB/TKE scale-out operation.

Run the deterministic control-plane path with:

```sh
go test ./internal/fleetcontroller -run '^TestMeshHarnessCellCapacityAutoscaling$' -count=1 -v
```

The test uses the real Pool, Cell and FoundationDB reconcilers. It fakes only OCM delivery,
FoundationDB Operator convergence and the Cell Agent qualification report. It verifies that one
capacity epoch produces exactly one Claim, one target Cell and one FDB cluster; the Claim remains
`Provisioning` until the target is independently qualified; only the qualified Cell enters Pool
admission; sustained low headroom grows that Cell from 9 to 12 FDB processes together with its TKE
MachineSet floor; and stale qualification closes admission without replaying the handled epoch.

This is a controller composition test, not a TKE qualification. In particular, the fake OCM
provider is test-only: the production binary still has no Claim-to-ManifestWork provisioner, and
the test does not create TKE nodes, CBS volumes or Tencent COS buckets.
