# Website backend release and rollback contract

This is a **release-preparation checklist**, not authorization to change production and not
an overall Ready declaration. Qualification is **driver-specific**: the 2026-10-01 Beijing
and Seoul `runsc` acceptance covered stateless, owner-authenticated `fetch-v1`; it does not
qualify the current `minisandbox` persistent backend or its regional infrastructure.

The `minisandbox` candidate supplies `fetch-v1` plus independently gated `rivet-sql-v1` SQL,
backed by a site-scoped Durable Object and native Depot/FDB. Owner writes and authenticated
share-session GET/HEAD reads use the same site database. Anonymous writes and arbitrary
outbound access remain outside the contract. Reuse the existing static website operations.
Qualify each region's real Workers API, durable execution, replacement, rollback and tenant
isolation before enabling either backend or data capability. Do not route international data
through the Beijing native endpoint.

Freeze and verify the Workers API's stateless executor endpoint/capability and the
private Object Router listener/endpoint. Keep executor, workerd and Object Router
capabilities separate. Bind the Engine's actual logical datacenter, which need not
be the cloud region name. Ready Pods with absent executor routes are not a passed
runtime gate: an actual Worker deployment and Durable Object write/read are required.

Native execution readiness is not a per-package preparation receipt. The manager may poll
only its private `__platform_prepare` path within the existing three-second deadline when a
503 carries `X-Workers-Error: true`, a valid bounded JSON error, `retryable: true` and one of
`executor_unavailable`, `worker_prepare_failed` or `executor_overloaded`. It never retries
application fetch or SQL. An error cannot arm durable reset; reset requires an observed
valid stale compiled marker. Exact stateless/durable package markers and deployment CAS
fences still precede the site's joint activation. Exhausted or nonretryable preparation
fails closed and preserves the previously active site.

Explicit site deletion may supersede an uncertain publication only for the reviewed
native driver's permanent Object tombstone, after journal/receipt endpoint and scope
identity are validated. Native deletion must acknowledge success before local journal,
artifacts and the in-memory fence are removed; directory removal is fsynced. Failed
or foreign-identity deletion stays fenced. Never infer activation ownership, retry an
application write, erase the journal manually, or delete the Worker to bypass retained
Durable Object history. A later activation cannot resurrect the deleted Object identity.

## Regional infrastructure prerequisite (persistent driver)

Passing Beijing/Seoul business acceptance is not proof that Shanghai/Singapore
already have a persistent runtime to consume. Resolve this prerequisite before
rendering production consumer bindings or declaring the release Ready:

1. Bind each production region to an actual account, management/Cell cluster,
   namespace and resource UID. Reuse a qualified existing deployment if one is
   found. An empty inventory in the operations cluster alone does not prove that
   all other accounts/clusters are empty. A missing target is an unresolved input,
   not permission to substitute a test endpoint.
2. If new regional infrastructure is needed, use the existing
   `minisandbox/infra/cells/deploy/tencent/fleet/terraform/create-first/` roots.
   Review regional account, live zones, storage identity and capacities before
   rendering inputs. Its committed `rebuild/fleet-intent.json` is Beijing-specific;
   changing only `region` is insufficient. Do not copy Beijing resource IDs,
   shared-root credentials or test storage into a production intent.
3. Review independent regional network intent. The source network contract
   reserves Shanghai Actor VPCs in `10.176.0.0/12` and Singapore in
   `10.224.0.0/12`. Both operations VPCs use `10.0.0.0/12`, so they must not be
   attached to a common Beijing CCN. Check live collisions and exact private
   listener/security-group flows before any authorized provisioning.
4. Separate the two endpoint contracts: the manager's
   `WEBSITE_MINISANDBOX_API_URL` points to that region's qualified Workers API;
   consumer `WEBSITE_RUNTIME_BASE_URL` points to the private TLS **manager**, not
   directly to Workers API or Object Router. Bind actual logical scope,
   stateless executor and Object Router configuration separately.
5. Provision/verify the manager's persistent single-writer store, regional
   deploy/invoke role references, TLS SAN/CA and secure init-container key
   materialization. Verify the regional storage renewal service and consumer
   reads after renewal; fresh startup alone is not proof of periodic renewal.
6. Promote the frozen test-qualified normal-source images to the correct
   production registries by digest, keeping rollback artifacts and data stores.
   Only then render region-specific prepare/enable patches using
   `RELEASE-BINDINGS.md`, initially closed. No placeholder URL, test CA/token,
   or test machine image ID is an admissible production input.

Local preparation does not authorize Terraform apply, secret creation, image
promotion, GitOps changes or production adoption. Keep infrastructure, bindings,
Argo convergence and real-user acceptance as separate evidence gates.

## Frozen inputs

Record and keep together:

- Source revision **and dirty/source-file snapshot**, Go toolchain, Linux architecture.
- CTL API/service, website worker, site gateway and service gateway immutable image digests.
  Verify their actual executable hashes after rollout, not only Deployment image strings.
- Manager executable SHA256 and its immutable image/source snapshot. For `minisandbox`, bind the
  regional Workers API, registry, native runtime image digests and scope, plus the compiled package
  and retained-release receipt. For `runsc`, also record the systemd unit SHA256, engine Docker
  image ID/repository digest, export SHA256, workerd lockfile and runsc version. A mutable tag is
  not sufficient; one driver's evidence does not qualify the other.
- Migration `000032_website_backend_revision` up/down hashes; recheck numbering against target
  master before integration. On 2026-10-05, fetched master already contains this migration;
  both files are byte-identical to this branch. Do not infer live regional DB versions from
  Git, or reapply an already-applied migration. The minisandbox SQL adapter adds no new CTL
  migration beyond 32; generated application schemas belong to the site's own database and
  must remain backward-compatible for code rollback. Editing this checklist does not apply
  a production migration.
- Complete website Skill version; new-machine image IDs and region mapping; Skill-only install
  and rollback Command JSON hashes. Do not embed instance credentials in these artifacts.
- When regional storage uses expiring sessions, freeze the scoped role/policy IDs, issuer
  helper/source and consumer executable/image digests. Verify projected files update without
  `subPath`, all three STS fields reach the signer, and real storage requests still work after
  renewal. The root issuer must remain outside runtime workloads; expired or unknown renewal
  outcomes cannot be treated as Ready. A test-only local issuer loop is not a production
  identity/renewal service and must not be copied into a production deployment.
- Region-specific runtime URL, TLS CA trust and secret **references**. Keep all actual secret
  values, env files, SSH identity and private TLS keys outside Git and distributable archives.

The repository runtime artifact consists of `site-runtime` built with the documented Linux
command, `website-runtime.service`, `runtime-image/` source/lockfile, and this deployment guide.
Build/test artifacts can be exported as a deterministic, file-hashed archive. An archive itself
is not deployment evidence.

## Offline configuration preparation

Use [RELEASE-BINDINGS.md](RELEASE-BINDINGS.md) and the references-only renderer to prepare
regional final-overlay patches. Append them after existing positional source patches; never
insert a Component into the CTL overlay. Both regional real-source renders preserve the
existing static/auth/DSH settings. Prepare keeps new fullstack disabled, enable requires an
explicit regional enablement approval. No production identity or secret is inferred from tests.

## Rollout order after explicit release authorization

1. Confirm target is the intended region/environment; back up DB and deployed manifests/image
   digests through the existing release process. Preserve the active site's current artifacts.
2. Reconcile the actual regional schema first. Apply the compatible migration only when it is
   genuinely pending; do not reapply migration32 from source-history evidence. Deploy the control
   plane/worker/gateway with fullstack creation disabled; preserve static clients and existing sites.
3. Qualify the selected regional driver. For `minisandbox`, verify the regional Workers/registry/
   native execution identities, Depot/FDB persistence and readiness, retained-version replacement,
   rollback and tenant isolation. Keep international storage in its own region. For `runsc`, verify
   dedicated hosts, Docker/runsc, cgroups, architecture and the pinned engine. Both require a private
   manager store and strict TLS SAN/CA trust; no user machine or shared-node Docker socket.
4. Install the hash-verified manager through the selected test-qualified deployment mechanism.
   Preserve the previous image/binary and persistent manager store for rollback; verify actual
   execution identity and startup preflight. A systemd deployment additionally requires unit
   verification. Never overwrite or reissue deploy/invoke tokens during an upgrade.
5. Configure worker deploy-token and gateway invoke-token separately, regional HTTPS endpoint,
   and CA trust. Do not publish keys or manager listener publicly; do not disable certificate checks.
6. Verify real manager deploy/invoke/delete, timeout recovery, metadata/network denial,
   credential separation and no leftover labelled containers using the exact selected artifacts.
7. Enable only the approved test/canary owner(s). Publish using a normal user machine and its
   automatically delivered instance credential. Verify the real browser OIDC path, static content,
   `/api` result, old-page revision rejection, owner isolation, failed publication preserving the
   old site, joint rollback, lifecycle and delete/storage/runtime/quota terminal state.
8. Promote the validated source/images/config through the normal GitOps process. Verify target
   Argo revision, immutable workload images and `Synced`/`Healthy`, then repeat business acceptance.
   The task-owned imperative test deployments have **no** production Argo convergence claim.
9. Adopt the final Skill in new-machine builds. After production launch, the user executes the
   separately prepared Skill-only TAT stock rollout by actual region. Use refreshed inventory,
   canary acknowledgement and resume ledger; do not combine instance-key delivery with Skill update.

Production host identifiers, endpoint/SAN, CA secret references and regional image/Command
mapping must be reviewed before step 3/5/9. Test host identities and tokens are not production
configuration. Providing these inputs during approved release is not an authorization shortcut.

A static candidate on a backend-enabled site must not delete still-eligible backend/COS
history. Legacy static cleanup requires a manager-confirmed empty backend store. An
unconfigured optional runtime client is not such confirmation: legacy static
publication may continue but skips pruning and preserves history. A configured
manager whose storage confirmation is unavailable fails publication closed. Switching the active site to static does not
itself delete SQL data or authorize backend-history reclamation. Verify returning to a retained
fullstack release preserves its original records.

For Kubernetes manager deployments, materialize TLS certificate/key from the
read-only source Secret into a runtime-UID-owned `emptyDir` using an init container.
The final private key must be a regular file with mode `0600`; direct projected
Secret symlinks are rejected by the listener. Keep the source Secret out of the
manager container, preserve certificate SAN and bytes, and replace the Pod for
certificate rotation. Verify actual manager startup and strict TLS before
changing the dedicated consumers; TCP readiness alone is insufficient.

## Rollback order

- Stop new fullstack creation/expansion first. This capability gate is not a kill switch for
  already active fullstack sites: preserve their runtime/gateway while recovering service.
- For a site-version issue, use the public rollback operation and poll to terminal success;
  static path and backend digest/revision switch as one generation. Verify an old browser gets
  409 and reload gets the restored page/API. Missing/pruned artifacts require republishing a
  retained ZIP, not declaring a rollback successful.
- For a manager upgrade issue, restore the preserved binary/unit, leave the runtime data store
  intact, restart, and verify existing immutable releases remain invokable. Do not delete bundles
  merely because a control-plane acknowledgement was lost.
- For an application-image issue, restore the captured image/config versions compatible with
  current DB schema. Do **not** downgrade to a static-only gateway while active fullstack sites
  still exist. Either retain the compatible gateway/runtime or explicitly withdraw affected sites.
- Do not run the destructive DB down migration until all fullstack sites/releases have been
  drained/migrated and old-client behavior is verified. Never use schema down as a traffic switch.
- Skill rollback restores each machine's own previous complete directory with the version guard.
  Lost rollback acknowledgement requires reconciliation, not blind repeat. Credentials stay intact.

## Test evidence and remaining sign-off

Qualification receipts and immutable artifact identities are maintained in
`docs/context/tasks/2026-10-02-website-minisandbox-integration.md`. Do not promote
an older manager/native snapshot merely because an earlier browser read passed.
Read the current checkpoint and reconcile outstanding invocations before issuing
another cloud or deployment action.

The Beijing qualification now covers the actual native application package,
Agent publication, independent owner/share browsers with the same server record,
manager recreation, code upgrade and joint rollback, ordinary DNS with strict TLS,
and native Actor sleep/wake. The deployed r12 website worker also preserves
retained backend artifacts through a real static publication and a normal return
to the retained fullstack release; the original server record remains intact.
Actor sleep/wake and manager recreation alone do not prove native Host replacement.
The separate native Host qualification has now passed: one registered Host Pod
was normally replaced, the same Actor was observed on its actual new Host, and
both independent browser sessions preserved the original full-record integrity.
This does not claim physical Node/VM rebuilding.

Korean qualification has passed regional FDB availability/quorum and actual native
execution: a Durable Object write was read intact through another Workers API Pod.
A separate stateless Worker invoked its declared object binding through the private
Object Router, followed by a version switch and CAS rollback with the original
record intact. Engine, persistent Hosts and stateless executors are Ready; these
results still do not replace the international website/browser business gate.
The actual regional Agent generated a fullstack package using the explicitly
configured authorized model route; credential and placeholder scans passed. The
owned legacy test site was narrowly cleaned and its quota slot released, without
another site-delete submission or any global quota/billing changes. The actual
Agent artifact was then published once: the original operation is successful and
the active release matches the scanned package. Still qualify independent
owner/share browsers, write denial, website redeployment/rollback and isolation
before claiming Korean business Ready.
A local test-only STS issuer is not a production identity renewal service.
The checked-in [storage session renewer](../../minisandbox/infra/cells/cmd/storage-session-renewer/README.md)
is the in-cluster replacement: projected ServiceAccount OIDC identity, exactly
three Cell-owned UID-pinned Secrets, a pre-created singleton Lease, strict STS
TLS and expiry-aware readiness. In Korean testing, the formal workload has now
passed projected-OIDC exchange for all three roles, actual same-UID session
generation/expiry rotation, a fresh held Lease and `/readyz`. A later read-only
checkpoint under the final normal 600-second window also observed new generations
and later expiries for all three same-UID Secrets; the existing Engine mounted the
current renewed session. This does not claim another physical cold-tier request.
The real FDB backup consumer has also read with a renewed session. The Go/Rust consumers have compiled;
code-registry and cold-tier runtime requests after rotation still require their
selected image qualification. These results do not qualify the whole runtime or
authorize production.

For each regional file-session release, record the actual namespace/Cell/Lease
and Secret UIDs, exact role/provider/audience bindings, renewer and consumer
image digests, and the final rendered configuration without placeholders.
Mount each Secret as a complete read-only directory (not `subPath`); require
real code-registry, cold-tier and backup requests after actual session rotation.
A short qualification renewal window may trigger rotation sooner, but must
retain the real STS expiry; the final deployment uses the separately frozen
normal renewal window. Do not infer consumer adoption from Secret updates or
reuse an expired local-issuer receipt as qualification. No static/root credential
fallback or local loop belongs in the release configuration.

The installed Skill is business-agnostic: new-image builds and Skill-only stock
commands contain only `SKILL.md` and `scripts/package_fullstack.py`, without
predetermined application routes or business fields. A working Agent on an
existing test machine does not prove fresh-machine delivery. The candidate image
must pass cleanup/capture auditing and fresh boot, and the fresh Agent must expose
the expected complete Skill version in its actual installed runtime catalog.

Fresh-machine Skill qualification passed in both test regions with the final
business-agnostic two-file bundle. Preserve the bundle identity when adopting it
in approved production new-machine builds; testing is not production adoption.

Before declaring wait-for-hidden-release Ready, close the real international
website/browser business path, remaining regional isolation and final credential
consumer qualifications. The Korean Native primary image-pull credential used in
qualification is temporary and has expired. The existing platform-injected pull
capabilities have now passed authenticated reads of the exact immutable Native
manifest and one actual kubelet `Always` pull/execution of that digest. Its
single short-lived qualification Pod succeeded and was UID-cleaned; existing
Native Pods and Secrets were unchanged. The node already cached image layers,
so this is not an uncached-layer transfer claim. Maintenance is the existing
TKE TCR Assistant CR/sync/injection path; its long-term credential rotation is
not claimed. Production configuration must not freeze the expired temporary
qualification primary as a usable credential. Freeze final regional source/image/configuration bindings after those
changes, not before.
The international public page being accessible through a trusted bastion does
not prove a failed local-browser TLS path has recovered.

No production release, GitOps promotion, stock Skill rollout or production
owner-machine mutation is authorized in this preparation phase. Local-only tests,
healthy FDB, a successful image capture or an offline manifest render cannot
individually replace the remaining live gates.
