# Clean-room rebuild state machine

This directory is the operator entry point for reconstructing a fleet without
remembered cloud IDs or files copied from an old node. Terraform remains a
human-reviewed boundary for adding a regional foundation, management cluster,
or whole Cell. Everything after each apply is a receipt-bound reconciliation.

`management.runtimeBuilder` in the reviewed intent selects an independent build
CVM type and CBS size. The renderer does not copy these inputs to a Cell, and
Terraform does not change the control workers or join the builder to TKE. The
resulting `runtimeBuilder` inventory identifies the exact disk and attachment;
it is not a build-ready receipt. Storage initialization, mounts and actual build
admission still require their own verified bootstrap before this host is used.
Release/qualification continues on `kubernetes.bootstrapInstanceId` under the
existing shared operation lock, not a new lock on the build-only CVM.

The dependency order is:

```text
reviewed source + complete image lock
  -> foundation Terraform
  -> management Terraform
  -> management pull credential
  -> Argo HA platform
  -> management desired-state Git
  -> regional Code Plane + physical FDB backup
  -> Argo adoption of the Code Plane
  -> regional Profile / Cell Terraform / Cell qualification
  -> two admitted Cell routes
  -> public Workers API / first real placement
```

The first formally orchestrated product phase is
`run-management-code-plane.sh`. It closes the previous gap between independent
installers and the rebuild chain. The phase requires a protected mode-0700
state directory and the exact receipts produced by management bootstrap:

```bash
ACTOR_REBUILD_STATE_DIR=/protected/rebuild-generation \
ACTOR_TERRAFORM_INVENTORY=/protected/management-inventory.json \
ACTOR_IMAGE_INVENTORY=/protected/all-images.lock.json \
ACTOR_MANAGEMENT_BOOTSTRAP_IMAGE_INVENTORY=/protected/management-bootstrap-images.lock.json \
ACTOR_CLUSTER_KUBECONFIG=/protected/management.kubeconfig \
ACTOR_STORAGE_CREDENTIAL_SOURCE=/protected/management-storage-credentials.json \
ACTOR_PULL_CREDENTIAL_RECEIPT=/protected/management-pull-bootstrap.json \
ACTOR_MANAGEMENT_PLATFORM_RECEIPT=/protected/management-platform.json \
ACTOR_MANAGEMENT_GIT_RECEIPT=/protected/management-git.json \
ACTOR_MANAGEMENT_GIT_CREDENTIAL=/protected/management-git-publisher.json \
  ./run-management-code-plane.sh
```

`management-sensitive-bootstrap.json` is Terraform's protected Kubernetes
bootstrap output and contains the kubeconfig only. The storage credential
source is a separate operator-owned document with
`storageCredentials.backup.accessKeyId` and `secretAccessKey`; in
`shared-root` mode those values must be rendered from the reviewed account
credential, never copied from a TCR token or an older Cell. The Code Plane
performs an authenticated FDB blob-store bucket probe before it creates the
continuous-backup resource, so a mismatched identity fails in seconds rather
than at the physical-restorability timeout.

`ACTOR_MANAGEMENT_BOOTSTRAP_IMAGE_INVENTORY` is the immutable generation that
actually installed Argo and management Git. It defaults to the Code Plane
inventory for a fresh one-generation rebuild, but may differ after a product
release adds unrelated images. The final chain binds both generations; it does
not pretend that adding a Workers/runtime image reinstalled the management
bootstrap.

The Git base revision is observed immediately before the CAS publication. An
operator may pin an already reviewed base with
`ACTOR_MANAGEMENT_EXPECTED_REVISION`; a concurrent publisher makes the push or
receipt validation fail rather than silently merging desired state.

## Resume and ownership rules

The state directory is generation-scoped. Generated manifests and receipts
are immutable evidence; the only mutable file is a local advisory lock.

- A restart revalidates management Git before any mutation.
- A render interrupted before installation is reconstructed from Terraform
  inventory and the image lock. The run continues only after byte-for-byte
  equality.
- A Git push interrupted before its receipt is resumed only when the target
  tree is already identical and the original CAS base is an ancestor.
- Existing Application and final chain receipts are recomputed and compared;
  their presence is never treated as success by itself.
- FDB, backup, Registry, private CLB and external Secret UIDs must survive Argo
  adoption.
- Secrets, kubeconfig and publisher credentials never enter Git or the final
  ordinary receipt.

Success produces:

```text
receipts/code-plane/rebuild-chain.json
```

The chain binds Terraform inventory, image generation, management Git,
bootstrap render/install, Git publication, Argo convergence, physical backup
restorability and every adopted UID. Public `/v1` qualification now requires
this exact chain in addition to the two Cell routes and live Registry
bindings. Therefore A/B or Workers API cannot accidentally admit traffic from
an independently hand-installed C plane.

Long-duration soak is intentionally not part of this deterministic state
machine. It is a later operational evidence stream and never substitutes for
construction receipts.

The Cell-side evidence boundary is formal as well. After a Cell's existing
Terraform handoff, Argo convergence and initial qualification stages finish,
`gitops/complete-cell-qualification.sh` joins them into
`actor-cell-qualification-chain/v1`. Replaying the command recomputes and
byte-compares the immutable result. The receipt deliberately stops before
activation and says `placement_opened=false`; the later Cell rebuild runner
must keep the operator-owned `publish-qualified-release.sh` invocation as a
separate explicit transition.

After that explicit activation,
`gitops/cell-registration/complete-cell-adoption.sh` is the formal resumable
transition into central ownership. It revalidates the reviewed qualification,
creates or verifies the immutable Registration, waits for the exact Claim and
spoke UIDs to bind, and publishes route v2. It still cannot place an Actor;
`gitops/complete-cell-admission.sh` owns the subsequent public first-placement
proof and final admission-chain receipt.

Central observability is a separate resumable phase after the two spoke
Prometheus endpoints exist. It installs the digest-pinned Hub release, renders
only its non-Secret steady state, CAS-publishes that tree to management Git,
adopts it with a least-privilege Argo project, deliberately tests self-heal and
then verifies both Cell targets:

```bash
ACTOR_REBUILD_STATE_DIR=/protected/rebuild-generation \
ACTOR_CLUSTER_KUBECONFIG=/protected/management.kubeconfig \
ACTOR_FEDERATION_TARGETS=/protected/federation-targets.yaml \
ACTOR_IMAGE_INVENTORY=/protected/all-images.lock.json \
ACTOR_OBSERVABILITY_CHART_ARCHIVE=/protected/kube-prometheus-stack-87.21.0.tgz \
ACTOR_MANAGEMENT_GIT_CREDENTIAL=/protected/management-git-publisher.json \
ACTOR_OBSERVABILITY_IMAGE_REGISTRY=registry.example.internal \
  ./run-management-observability.sh
```

Re-execution compares the installed release, rendered Git tree and Argo UIDs
against the generation-scoped receipts. A mismatch fails closed. Grafana admin,
image-pull and Prometheus scrape Secrets never enter desired-state Git. The
Alertmanager receiver remains an explicit site integration input; the rebuild
does not invent a successful no-op receiver.

## Fleet-level qualification chain

After C and both Cells have converged, `assemble-fleet-qualification.py`
closes the permanent clean-room evidence chain. It does not rerun Terraform or
claim that the reviewed Terraform boundary is unattended. It joins the exact
Code Plane rebuild chain, both Cell qualification/identity/serving routes, the
historical first-placement and CLB replacement proof, the current
self-contained Workers desired-state revision, observability, deployment
cursor latency, and both cloud autoscaling qualifications. It then rechecks
the live ShardPool, both route ConfigMaps, both admitted Cells, the current
Workers Deployment/HPA, the pinned Argo revision, the fully Ready TKE
NetworkPolicy controller and the receipt-bound Registry FDB network-outage
failure/recovery matrix before emitting:

```text
receipts/fleet/rebuild-qualification.json
schema: actor-fleet-rebuild-qualification/v1
```

The current Workers desired tree must contain `workers-api-render.json` and
bind its exact digest. A desired-state revision that remembers only the render
hash is rejected because it cannot be reconstructed after operator scratch
files disappear. Historical public admission remains valid only as the proof
of first placement and traffic-preserving replacement; the fleet chain also
requires the current Deployment UID, current route UIDs, current image and
current Argo convergence, so a later release cannot inherit stale readiness.

The command intentionally takes every source receipt as an explicit absolute
path. `--qualification`, `--route`, and `--serving-route` are each supplied
twice, once per Cell. `--cell-kubeconfig CELL=/absolute/path` is also supplied
once per Cell so the final live gate proves the controller is Ready across C,
A and B rather than inferring Cell enforcement from Terraform source. The remaining flags correspond one-for-one to the
receipt names in the script's `--help`; no directory scan or "latest" file
selection is permitted. `--fdb-network-outage` is mandatory: a fleet cannot
inherit rebuild qualification from a cluster that only stores inert policy
objects or has not proved storage readiness fails closed and recovers.
