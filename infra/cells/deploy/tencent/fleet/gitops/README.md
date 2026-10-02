# Argo CD runtime release Hooks

All Argo, FDB, NATS, and observability third-party images are mirrored through
[`image-seed/`](image-seed/) as one digest-locked regional operation. The
legacy component mirror entry point delegates to that complete seed and now
requires an immutable receipt path; it cannot perform a tag-only Argo mirror.

Argo CD in management cluster C owns Git observation, diff, Sync state, Hook execution, and UI.
This directory does not implement another reconciler. It packages the existing public `/v1`
transactional upgrade workflow as native `Sync` and `SyncFail` Jobs.

`render_release_hooks.py` accepts only digest-pinned Hook/runtime/reporter images and complete source
identities. It derives one deterministic transaction run ID from the release attempt, candidate,
and previous release. The Sync
Job continuously probes public Durable Objects while the existing runtime release workflow rolls
the platform. The SyncFail Job can request only the exact previous release and passes the matching
failed receipt to the existing rollback authorizer.

The Hook image is based on the immutable digest of Tencent's official CLI image. Production uses
the TKE OIDC environment understood natively by that CLI and a projected one-hour ServiceAccount
token. The CAM role may invoke only the exact TAT builder; no static cloud key is stored in Git or
Kubernetes. `--auth-mode secret` exists only for an explicit local qualification fixture and must
never be rendered into a production release repository.
Beijing Hook Pods also pin TCCLI's root domain to `internal.tencentcloudapi.com`. TCCLI applies that
setting to product APIs but its Python SDK credential provider otherwise hard-codes public STS, so
the shared TAT helper explicitly exchanges the projected token against
`sts.internal.tencentcloudapi.com` and keeps the resulting short-lived credential only in process
memory. Both the OIDC exchange and TAT invocation therefore stay on Tencent's VPC endpoints; adding
a NAT gateway is not a release-plane dependency or a fallback.

`bootstrap.example.yaml` creates the namespace and an unprivileged ServiceAccount. It is owned by
the management-cluster bootstrap, not by the release Application. The ServiceAccount has no
Kubernetes RBAC. Its only authority is the short-lived CAM role whose trust policy binds the exact
OIDC audience and `system:serviceaccount:actor-release-system:actor-release-hook` subject. The q01
Terraform qualification declares a policy containing only `tat:InvokeCommand` and
`tat:DescribeInvocationTasks` on the exact Beijing builder CVM and commands bearing the
`actor-release-approved=true` tag. The Hook has no `RunCommand`, CreateCommand, ModifyCommand, or
tag authority. Upgrade and rollback command IDs are immutable inputs in Git; publishing those
commands belongs to a separate release-artifact identity. A production C cluster must render the
same contract with its own cluster provider and builder identity.

For q01 qualification, `publish-release-commands.sh` creates exactly two non-parameterized TAT
commands from one reviewed control-source identity: the candidate transaction and its bounded
rollback. Publication is idempotent by deterministic command name. An existing command is reused
only when its complete decoded content and all approval tags match; duplicate names or mismatched
content fail closed. The resulting protected JSON receipt supplies
`--upgrade-command-id`, `--rollback-command-id`, and
`--approved-commands-receipt` to this renderer. The renderer verifies that the
receipt binds the complete candidate and previous Runtime/reporter source
identities plus the deterministic run ID before it writes desired state, then
mounts that non-secret receipt read-only in both Hooks. Each Hook validates its
exact phase and command ID before invoking TAT. A candidate command from one
release therefore cannot mutate the Cell under another release's Git intent,
while the prior qualified Runtime remains independently rollbackable.
Tencent TAT command metadata is briefly eventually consistent after `CreateCommand`. The publisher
performs a bounded exact read-back of that one returned command ID; it never retries creation, and
fails closed unless content and approval tags become identically readable.
If Tencent exposes that newly returned command with its exact name, content and non-parameterized
shape but omits the requested tags, the artifact publisher binds the three approval tags through
the official TagResources API to that exact TAT command QCS resource and repeats the bounded
read-back. It never repairs a pre-existing command found by name, so an unknown command cannot be
turned into an approved release artifact. This authority belongs only to the artifact publisher;
the in-cluster Hook role still has InvokeCommand and DescribeInvocationTasks only.

The approved-command path writes a compact receipt summary to `actor-release-receipts`, not the
complete report. The builder EXIT handler must first persist each newly produced terminal report
in the immutable, hash-checked Cell evidence cache, including failed candidates needed for rollback.
Failure to preserve a successful report makes the command fail closed. The cache survives operator
replacement but is not a cross-cluster backup; exact full reports must also be archived through
`persist-receipt-from-builder.sh` to the independent COS evidence bucket. Until that archive is
verified, do not claim a complete disaster-resistant release evidence chain.
The compact receipt also records the Argo Application, Hook phase, release attempt, and exact Hook
Pod namespace/name/UID from the Kubernetes downward API. Qualification must join that identity to
the retained Job, the Pod's Job ownerReference, and the matching Application operation/history.
Neither a same-named builder receipt nor `Synced/Healthy` by itself proves that Argo initiated the
release transaction.

Before human activation, assemble one exact review artifact from the complete
construction and initial qualification evidence:

```bash
ACTOR_MANAGEMENT_IMAGE_INVENTORY=/data/actor-qualification/receipts/management-all-images.lock.json \
ACTOR_IMAGE_INVENTORY=/data/actor-qualification/receipts/all-images-<run>.lock.json \
ACTOR_TERRAFORM_INVENTORY=/data/actor-qualification/receipts/<cell>-terraform-inventory.json \
ACTOR_MANAGEMENT_PLATFORM_RECEIPT=/data/actor-qualification/receipts/management-platform.json \
ACTOR_MANAGEMENT_GIT_RECEIPT=/data/actor-qualification/receipts/management-git.json \
ACTOR_MANAGEMENT_DESIRED_RECEIPT=/data/actor-qualification/receipts/management-desired-state.json \
ACTOR_HANDOFF_RECEIPT=/data/actor-qualification/receipts/<cell>-handoff.json \
ACTOR_PUBLICATION_RECEIPT=/data/actor-qualification/receipts/<cell>-publication.json \
ACTOR_CELL_PLATFORM_RECEIPT=/data/actor-qualification/receipts/<cell>-cell-platform.json \
ACTOR_REGISTRATION_RECEIPT=/data/actor-qualification/receipts/<cell>-registration.json \
ACTOR_FDB_TLS_RECEIPT=/data/actor-qualification/receipts/<cell>-fdb-tls.json \
ACTOR_QUALIFICATION_AUDIT_RECEIPT=/data/actor-qualification/receipts/<cell>-autonomy-audit.json \
ACTOR_QUALIFICATION_CONTROL_RECEIPT=/data/actor-qualification/receipts/<cell>-autonomy-control.json \
ACTOR_INITIAL_QUALIFICATION_RECEIPT=/data/actor-qualification/receipts/<cell>-initial-qualification.json \
ACTOR_ARGO_CONVERGENCE_RECEIPT=/data/actor-qualification/receipts/<cell>-argo-convergence.json \
ACTOR_CELL_QUALIFICATION_CHAIN_RECEIPT=/data/actor-qualification/receipts/<cell>-qualification-chain.json \
  ./complete-cell-qualification.sh
```

The command is restart-safe: an existing output is reconstructed from every
exact input and must compare byte-for-byte. Its receipt always states
`placement_opened=false` and `operator_activation_required=true`; it cannot
write Kubernetes state, publish a route, or create an Object. This is the
single artifact an operator reviews before invoking
`operations/publish-qualified-release.sh`.

The post-activation admission preflight requires this exact chain and promotes
its digest into the final admission receipt. Reviewing one qualification chain
and later supplying another generation's construction or qualification files
therefore fails before the first public Object mutation.

After the human qualification activation and first public Agent creation,
join the exact evidence files rather than copying fields by hand:

```bash
python3 assemble-admission-receipt.py \
  --management-images /data/actor-qualification/receipts/management-all-images.lock.json \
  --images /data/actor-qualification/receipts/all-images-<run>.lock.json \
  --terraform-inventory /data/actor-qualification/receipts/<cell>-terraform-inventory.json \
  --management-platform /data/actor-qualification/receipts/management-platform.json \
  --management-git /data/actor-qualification/receipts/management-git.json \
  --management-desired /data/actor-qualification/receipts/management-desired-state.json \
  --handoff /data/actor-qualification/receipts/<cell>-handoff.json \
  --publication /data/actor-qualification/receipts/<cell>-publication.json \
  --platform /data/actor-qualification/receipts/<cell>-cell-platform.json \
  --registration /data/actor-qualification/receipts/<cell>-registration.json \
  --tls /data/actor-qualification/receipts/<cell>-fdb-tls.json \
  --qualification-audit /data/actor-qualification/receipts/<cell>-autonomy-audit.json \
  --qualification-control /data/actor-qualification/receipts/<cell>-autonomy-control.json \
  --initial-qualification /data/actor-qualification/receipts/<cell>-initial-qualification.json \
  --argo /data/actor-qualification/receipts/<cell>-argo-convergence.json \
  --qualification-chain /data/actor-qualification/receipts/<cell>-qualification-chain.json \
  --adoption /data/actor-qualification/receipts/<cell>-claim-adoption.json \
  --route /data/actor-qualification/receipts/<cell>-route.json \
  --activation /data/actor-qualification/receipts/<cell>-qualification-activation.json \
  --placement /data/actor-qualification/receipts/<cell>-first-placement.json \
  --output /data/actor-qualification/receipts/<cell>-admission-chain.json
```

The join treats the standalone, self-digesting management and Cell image
inventories as their respective retained generation contracts. They may roll
independently; forcing a Cell release to equal the older management-plane
generation would make a valid rollout impossible. Each inventory is bound by
its own platform receipt, and the Cell inventory is additionally bound by the
Terraform handoff, desired-state publication, management receipts and Argo
convergence; requiring transient builder-side preimage files again would make
a replacement management node depend on the old builder filesystem. The
independently released Workers API still supplies a fresh cold-pull product
receipt, whose base dependencies must exactly match the inventory. The join
fails unless those bindings match, the
qualified runtime digest belongs to that reconstructed inventory, the
management Terraform identity flows through the Argo platform, private Git
service and desired-state ApplicationSet receipts, the Cell publication uses
that exact repository and convergence uses that exact ApplicationSet UID, the
Argo registration and convergence are both scoped to the production Cell
ApplicationSet rather than an isolated E2E controller, the
immutable three-Secret FDB TLS receipt names the same
Cell, the control file hashes the exact passing autonomy audit, the activation
hashes that exact allow-control file, the initial-qualification receipt binds
the Argo convergence and the exact Bottomless/Engine HA paths audited by that
allow decision, and the Terraform/Argo spoke UID,
immutable route, human
admission generation, public ObjectRef, Registry FDB record and Actor ID all
describe the same Cell and first object.

The final receipt also promotes the Terraform inventory digest, handoff and
desired-state publication receipt digests, Argo registration receipt digest, immutable Git revision and
Argo convergence receipt digest, plus the exact Cell platform receipt and
cluster UID and all three management receipt digests, into its `construction` section. Its
`qualification` section binds the exact autonomy-control digest, content-
addressed in-cluster receipt reference, pre-activation qualification-chain
digest, qualified runtime digest and activation receipt. Assembly rejects an activation whose embedded plan differs from the
published qualification, so a merely plausible `Ready` JSON document cannot
bridge the human admission boundary.

The normal post-approval entry point performs the first placement and join in
one restart-safe step. It never creates the activation receipt, so the human
CAS remains an explicit boundary:

```bash
ACTOR_IMAGE_INVENTORY=/data/actor-qualification/receipts/all-images-<run>.lock.json \
ACTOR_MANAGEMENT_IMAGE_INVENTORY=/data/actor-qualification/receipts/management-all-images.lock.json \
ACTOR_TERRAFORM_INVENTORY=/data/actor-qualification/receipts/<cell>-terraform-inventory.json \
ACTOR_MANAGEMENT_PLATFORM_RECEIPT=/data/actor-qualification/receipts/management-platform.json \
ACTOR_MANAGEMENT_GIT_RECEIPT=/data/actor-qualification/receipts/management-git.json \
ACTOR_MANAGEMENT_DESIRED_RECEIPT=/data/actor-qualification/receipts/management-desired-state.json \
ACTOR_HANDOFF_RECEIPT=/data/actor-qualification/receipts/<cell>-handoff.json \
ACTOR_PUBLICATION_RECEIPT=/data/actor-qualification/receipts/<cell>-publication.json \
ACTOR_CELL_PLATFORM_RECEIPT=/data/actor-qualification/receipts/<cell>-cell-platform.json \
ACTOR_REGISTRATION_RECEIPT=/data/actor-qualification/receipts/<cell>-registration.json \
ACTOR_FDB_TLS_RECEIPT=/data/actor-qualification/receipts/<cell>-fdb-tls.json \
ACTOR_QUALIFICATION_AUDIT_RECEIPT=/data/actor-qualification/receipts/<cell>-autonomy-audit.json \
ACTOR_QUALIFICATION_CONTROL_RECEIPT=/data/actor-qualification/receipts/<cell>-autonomy-control.json \
ACTOR_INITIAL_QUALIFICATION_RECEIPT=/data/actor-qualification/receipts/<cell>-initial-qualification.json \
ACTOR_ARGO_CONVERGENCE_RECEIPT=/data/actor-qualification/receipts/<cell>-argo-convergence.json \
ACTOR_CELL_QUALIFICATION_CHAIN_RECEIPT=/data/actor-qualification/receipts/<cell>-qualification-chain.json \
ACTOR_CELL_ADOPTION_RECEIPT=/data/actor-qualification/receipts/<cell>-claim-adoption.json \
ACTOR_CELL_ROUTE_RECEIPT=/data/actor-qualification/receipts/<cell>-route.json \
ACTOR_QUALIFICATION_ACTIVATION_RECEIPT=/data/actor-qualification/receipts/<cell>-qualification-activation.json \
ACTOR_WORKERS_API_PRODUCT_RECEIPT=/data/actor-qualification/receipts/product-workers-api.json \
ACTOR_WORKERS_API_RENDER_RECEIPT=/data/actor-qualification/receipts/workers-api-render.json \
ACTOR_WORKERS_API_INSTALL_RECEIPT=/data/actor-qualification/receipts/workers-api-install.json \
ACTOR_WORKERS_API_ENDPOINT=http://<private-workers-api-origin> \
HUB_KUBECONFIG=/protected/hub.kubeconfig \
CELL_KUBECONFIG=/protected/terraform-cell.kubeconfig \
ACTOR_FIRST_PLACEMENT_RECEIPT=/data/actor-qualification/receipts/<cell>-first-placement.json \
ACTOR_ADMISSION_CHAIN_RECEIPT=/data/actor-qualification/receipts/<cell>-admission-chain.json \
ACTOR_ADMISSION_RUN_ID=<32-lowercase-hex> \
  ./complete-cell-admission.sh
```

The run ID deterministically names the Worker and Object. If the process stops
after the FDB claim but before publishing its receipt, rerunning with the same
ID reclaims that Object instead of creating another Agent. If the receipt
already exists, the script verifies its run ID and resumes only the evidence
join. An existing final receipt is never overwritten.

Before it makes that first public API mutation, the entry point validates the
complete Terraform, publication, registration, convergence, qualification and
human-activation chain in preflight mode. A stale activation file therefore
cannot create an Agent and fail only after the fact.

The same preflight requires the independently releasable Hub Workers API
product, render, and installation receipts. This lets the public facade move
forward without forcing an unrelated FDB/runtime rollout through every Cell,
while still proving that its exact image uses the admitted generation's build
foundations, both immutable Cell routes, and distinct Cell-scoped Engine
credentials.

Create that first production Agent through the public `/v1` endpoint and
capture the private proof without hand-assembling Registry or Engine fields:

```bash
python3 qualify-first-placement.py \
  --endpoint http://<private-workers-api-origin> \
  --hub-kubeconfig /protected/hub.kubeconfig \
  --cell-kubeconfig /protected/terraform-cell.kubeconfig \
  --route-receipt /data/actor-qualification/receipts/<cell>-route.json \
  --operation-id <32-lowercase-hex> \
  --receipt /data/actor-qualification/receipts/<cell>-first-placement.json
```

The gate uploads and deploys a minimal Durable Agent, creates one Object via
the public API, executes its `fetch()` through the same public `/v1` path, then
joins the returned `ObjectRef` to the exact Registry FDB record, immutable route
ConfigMap UID, and exactly one connectable Actor in the selected Cell. The final
join also binds the Terraform cluster ID/private endpoint to the exact Argo
cluster Secret UID and Synced/Healthy Application UID. It deliberately keeps
that first Object as durable evidence.
If a Cell's Engine Service does not follow `<datacenter>-engine`, pass its exact
DNS-label name with `--engine-service`.
If the resolver selects another Cell, the gate fails rather than relabelling
the result; a clean-room first Cell is deterministic, while later Cell
expansion must use a qualification Pool or a separately reviewed placement
constraint.
After a Hook finishes, capture the exact Application, Job, and Pod JSON and run
`verify_argocd_release_provenance.py`. It accepts only an exact deterministic run ID, successful
compact/full receipt, Argo tracking identity, exact Pod-to-Job UID ownership, successful matching
Hook resource result, and one retained immutable Git revision. Its output is the publishable
orchestration-provenance receipt; the four input snapshots remain evidence inputs.
The PVC is never pruned. Argo Job state and
logs provide release visualization, while receipt verification remains the success authority.
The receipt PVC is bootstrap-owned and must be applied before the release Application; it is not
published in `releases/<cell>/current` and must never carry an Argo tracking ID for that
Application. This keeps an old receipt volume outside per-release pruning and prevents a retained,
correctly bound claim from leaving every later release permanently `OutOfSync`.
The bootstrap-owned `actor-release-cbs-wffc-retain` StorageClass and the 10 GiB minimum in
`release-receipts-pvc.yaml` are explicit: Tencent CBS rejects smaller volumes, while relying on the
cluster default would also downgrade receipt retention to `Delete` and bind before scheduling.
The intent ConfigMap exposes the Hook and candidate digests, deterministic run ID, and the exact
approved upgrade/rollback Command IDs in the Argo resource tree without exposing credentials.
The Hook digest deliberately does not change the transaction run ID by itself, but it is part of
desired state. A Hook/control-plane repair increments `releaseAttempt`; that produces a new run ID
and new immutable approved commands while retaining the failed attempt's exact artifacts. This
prevents a repaired retry from colliding with or rewriting the evidence chain it is meant to fix.
An early rollout failure that has already restored Kubernetes state but did not produce an eligible
semantic-failure receipt remains failed for operator inspection; it must not be relabeled as a
successful user-transparent rollback.

`build-image.sh` builds only from an exact reviewed source tree, requires the current
`base-tencentcloud-cli` digest and a new `ACTOR_PRODUCT_BUILD_RECEIPT` path, records the source
manifest and base-image digest as OCI labels, pushes a unique tag, cold-pulls the registry digest,
rechecks those labels, publishes the immutable receipt, and prints the digest reference consumed
by `render_release_hooks.py`. Both the final Hook and its
pinned Tencent CLI build base live in Beijing TCR. Beijing builds therefore never depend on Docker
Hub or Debian mirror reachability; the mirrored base already contains the reviewed `jq` package.
Changing that base requires an explicit reviewed digest update.
The semantic-failure builder also preserves an immutable source tree at
`q01-src-<revision>-<candidate-manifest>` after the candidate image succeeds. The approved release
entry requires that exact identity before validation or rollout; retaining only the image and
deleting its patched source would make the transaction fail closed before producing a release
receipt.
`Dockerfile.release-hook-base` records how to reproduce that infrequently changed dependency base;
it is the only release-Hook build step allowed to contact upstream package sources.
Because TCR instance-token repository access is fixed when the token is created, adding these two
repositories also advances the q01 pull credential generation. Reusing the older token would make
an apparently healthy cluster fail only when the first release Hook is scheduled.

The Tencent bootstrap-owned Hook ServiceAccount binds the separately managed pull-only
`actor-fleet-tcr` Secret, so every release attempt can cold-pull a newly published digest even when
the Job renderer accidentally omits its explicit override. Unattached/local management clusters
also pass `--image-pull-secret actor-fleet-tcr`; the renderer records only that reference and never
places registry credentials in Git. A deployment that intentionally relies on a native TCR
attachment may remove both bindings only after a new-digest cold-pull preflight proves that path.

`argocd-project.example.yaml` is the release-plane permission ceiling: the Application can manage only its
intent ConfigMap, receipt PVC, and Hook Jobs in `actor-release-system`. It cannot manage Secrets,
workloads, Nodes, Machines, or Cell storage. Replace the example private Git URL as an installation
rendering step and keep the credential outside Git. `application.example.yaml` enables automatic
sync for a new reviewed Git revision but deliberately disables self-heal and Argo retry: a failed
release stays failed at that exact revision, and only its `SyncFail` transaction may restore the
previous runtime. A new Git commit is required for another release attempt.
`argocd-release-scope.yaml` supplies the matching discovery ceiling. The in-cluster target is
restricted to `actor-release-system`, cluster resources are disabled, and Argo watches only
ConfigMaps, PVCs, and Jobs while respecting RBAC in strict mode. The cluster Secret contains no
bearer token; the controller continues to use its projected ServiceAccount identity.

## q01 qualification Git

`qualification-git-service.yaml` supplies a real, private Git repository for the Beijing q01
qualification only. It runs the official rootless Gitea image mirrored by digest into Beijing TCR,
stores its SQLite database and repositories on a retained CBS volume, and is reachable only from
its own namespace and the Argo repo-server. `install-qualification-git.sh` creates separate
publisher and Argo-reader identities; their credentials never enter Git, and only the reader token
is materialized as an Argo repository Secret. Token rotation is restart-safe because random account
passwords are persisted in the builder's protected state before either account is created.

After operator replacement, missing local credentials do not mean that Gitea accounts are
missing. Do not rerun the installer to guess replacement passwords. Run `python3
recover-publisher.py` under the shared autonomy operation lock to recover only the publisher.
This explicitly resets `release-publisher`'s password and replaces its `q01-release-publisher`
token, leaving the reader account, Argo repository Secret, and Git content unchanged. The protected
recovery journal is persisted before the password change, so interruption can be recovered by
rerunning the same operation. Publication must not run concurrently with token replacement.
The workflow validates the pinned Git image, original private repository identity, and new token's
push permission before producing a non-secret receipt. It does not prove a release or a successful
Argo Sync. A recovered credentials file may contain only the publisher; it is not an input to
the installer, which manages both accounts.

`publish-desired-state.sh DIRECTORY MESSAGE` commits the exact rendered release directory to
`releases/actor-bj-q01/current` and pushes through `GIT_ASKPASS`, keeping the token out of arguments
and logs. Cloning an empty repository succeeds normally; any clone failure is therefore an
authentication, reachability, or repository-identity failure and stops publication. It must never
be reinterpreted as permission to initialize a replacement history. This q01
repository is deliberately not called production HA: it proves the
Git/Argo/Hook state machine in q01. New create-first management clusters use
`terraform/create-first/bootstrap/install-management-git.sh`, which renders
the same bounded service from the complete private image inventory and binds
its live PVC, Secret and repository identities into an immutable receipt. It
is a rebuildable single-replica desired-state authority with retained storage,
not a claim of Git service HA; an external organization-owned Git service can
replace it later behind the same publication contract.

## q01 control-plane desired state

`actor-cell-control-q01` is deliberately separate from the runtime-release Application. It owns
only the static CRDs, Fleet controller RBAC/Deployment/Service, and the exact
`RivetCellProfile -> ShardClass -> RivetCell` policy binding under
`platform/actor-bj-q01/current`. It does not own runtime workloads, replica counts, Nodes,
MachineSets, FDB status, receipts, Secrets, or release Hooks. The runtime-release Application
therefore remains the sole transaction owner for Engine/Host/Reporter rollout and rollback.

`render_control_plane.py` rejects Secrets, unknown resource kinds, an unpinned controller image,
stale profile digests, a missing complete-image-inventory digest, and duplicate identities. It writes
that inventory digest onto both Profile and Cell plus the canonical profile digest onto the Cell, so
the autonomy audit does not depend on controller-populated status. It assigns child dependency waves in the order
Profile/Class, Cell, controller. The Application enables self-heal but initially
keeps prune disabled: adoption of an existing q01 resource is reversible, while deletion requires
a separate inventory and retirement proof. `publish-control-desired-state.sh` publishes only the
reviewed `platform/actor-bj-q01/current` root through the existing protected publisher identity.

The control Application owns every static `RivetCell` field except
`spec.desiredState`. That single lifecycle field is ignored with
`RespectIgnoreDifferences=true` and is owned by `publish-qualified-release.sh`, which changes it
with UID/resourceVersion CAS only after an exact release-bound autonomy receipt passes. On initial
creation Git still supplies `Provisioning`; deleting and recreating a Cell therefore closes
placement and requires qualification again. No other Cell field is excluded from Argo self-heal.
The one-time AppProject/Application bootstrap remains outside the child Application so it cannot
expand its own permissions or change its own source repository.

The cloud FDB autoscaling qualification is the only workflow allowed to make a
temporary change to the Argo-owned autoscaling policy. Before each one-step
signal window it requires the control Application to be `Synced/Healthy`,
starts a digest-pinned in-cluster recovery Job, and disables self-heal with an
Application-UID JSON-patch CAS. As soon as the Cell persists the selected
target, the workflow restores the original Profile/Class binding, re-enables
self-heal and waits for `Synced/Healthy` again. If the qualification process or
builder disappears, the recovery Job can only re-enable self-heal on that one
Application; Argo then restores the Git policy. The recovery account has no
Secret, Cell, FDB, delete, or RBAC authority. A direct Profile patch while
self-heal is enabled is invalid evidence because Argo will correctly revert it.

CRDs, the Argo control Role/Binding, and the Fleet controller's ServiceAccount/RBAC are deliberately
bootstrap-owned and excluded from the child Application. Allowing a Git child to edit its own RBAC
or arbitrary ClusterRoles would turn repository write access into cluster-admin. The child desired
state therefore contains exactly five resources: Profile, Class, Cell, controller Deployment and
metrics Service. `argocd-release-scope.yaml` controls discovery only; AppProject plus the
bootstrap-owned `argocd-control-rbac.yaml` remain the independent authorization ceiling.
