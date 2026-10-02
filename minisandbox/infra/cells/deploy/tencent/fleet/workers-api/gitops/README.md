# Workers API management GitOps handoff

This directory converts an already qualified management-cluster Workers API
into pinned Argo desired state. It does **not** install Argo, create the
management Git service, create credentials, qualify Cells, or make a failing
Workers API eligible for traffic.

## Bootstrap ownership

The dependency graph is intentionally one-way:

```text
Terraform C substrate
  -> pull credential -> Argo HA -> management Git
  -> A/B Cell qualification and route publication
  -> imperative Workers API + private CLB + public admission receipt
  -> credential-free Git tree at management/workers-api
  -> bootstrap-owned AppProject/Application pinned to the exact Git commit
  -> Argo self-heal
```

Argo and its repository cannot be born from an Application stored in that
repository. Their installation and the root `AppProject`/`Application` remain
the small imperative bootstrap boundary. After adoption, Argo owns the thirteen
Workers API resources and both private `LoadBalancer` Services (public `/v1`
and the isolated Object Router listener). It does not own:

- the legacy `workers-api-internal-token`, its exact receipt-derived
  `workers-api-internal-token-<content-hash>`, or any other Secret;
- CLB-assigned VIP, node ports, Tencent controller bookkeeping annotations, or
  Service status;
- ShardPool admission, Cell routes, Engine/runtime replicas, or node capacity;
- the root AppProject/Application themselves.

The AppProject cannot write Secrets. The Application is pinned to a commit,
never `main`; publishing bytes alone therefore cannot deploy them. There is no
Argo resource finalizer on the bootstrap-owned Application, so accidental
deletion of the root does not cascade-delete the serving API.

C also uses Argo `resource.inclusions` as a global discovery allowlist. The
adoption installer merges the exact Workers API kinds with the existing Cell
kinds before creating the Application. The Workers kinds are scoped to C's
`https://kubernetes.default.svc`; applying them to `*` would make A/B discovery
exceed their deliberately narrow RBAC. Because Argo's in-cluster REST client
uses the Kubernetes Service IP internally, bootstrap derives that private
`https://<clusterIP>:443` origin and includes both equivalent C identities.
This allowlist controls discovery only;
the narrower AppProject remains the write boundary. `Secret` is absent from
both layers. A nominally `Synced/Healthy` Application with any
`ExcludedResourceWarning`, a tracked-resource count other than the exact
phase-specific 12/13, or an unsynced resource fails the convergence gate. The two exact bootstrap-owned Secrets
(`actor-fleet-tcr`, the legacy `workers-api-internal-token`, and the exact
receipt-derived versioned credential) and the two exact
receipt-derived Cell route ConfigMaps are declared as known orphans; no
wildcard orphan suppression is used.

Every inclusion change hard-refreshes both ApplicationSet-owned Cell
Applications. Convergence additionally proves their exact source bindings are
unchanged and both remain `Synced/Healthy`; a Workers API adoption may not
silently degrade A or B.
Changing discovery policy also rolls the application-controller only when the
canonical inclusion set changed; this clears Argo's documented stale discovery
cache. An idempotent replay does not restart it.

## Object Router bootstrap update

An already adopted durable-only API cannot wait for A/B stateless endpoints:
those executors need the C Object Router address first. The explicit
`object-router-bootstrap` render therefore publishes twelve Argo-tracked
resources (the normal set minus the not-yet-created private Router CLB). It is
authorized by the exact prior convergence receipt, binds the separately
synchronized external credential, and proves the Pod has no stateless executor
token flags. After this revision is healthy, create and qualify the Router CLB;
the later `serving` render adds that thirteenth tracked resource and all serving
route evidence.

If the pinned Application is healthy but its historical convergence receipt
was not retained, `recertify-live-convergence.sh` may reconstruct only that
missing CAS baseline. It is strictly read-only: it clones the exact pinned Git
commit, verifies the desired tree against live Deployment/image/ConfigMap,
three-node topology, private endpoint and external Secret UID, and emits a new
convergence receipt. It cannot apply, patch, create or delete Kubernetes
resources and therefore cannot turn drift into evidence.

If an `object-router-bootstrap` revision reaches `Synced/Degraded` solely
because an earlier operator deleted and recreated the legacy immutable Secret
under the same name, use `rollback-failed-bootstrap.sh`. It accepts only the
exact failed publication and the preceding passed convergence receipt,
requires the reviewed `CreateContainerConfigError` missing-key signature,
rolls the bootstrap-owned Application back to that exact prior commit, and
proves the Deployment and private CLB Service UIDs were preserved. It is not a
general rollback command and cannot authorize an arbitrary unhealthy release.

```bash
python3 render-desired-state.py \
  --manifest /protected/workers-api-router-bootstrap.yaml \
  --render-receipt /protected/workers-api-router-bootstrap-render.json \
  --credential-receipt /protected/workers-api-credential.json \
  --endpoint-installation /protected/workers-api-private-endpoint.json \
  --prior-convergence /protected/management-workers-api-prior-convergence.json \
  --output-dir /data/tmp/management-workers-api-router-bootstrap \
  --receipt /protected/management-workers-api-router-bootstrap-render.json

# After publish.sh and render-application.py:
./install-application.sh APPLICATION PUBLICATION DESIRED_RENDER \
  /protected/workers-api-private-endpoint.json CONVERGENCE
```

## First adoption

Use the exact manifest and receipts emitted by the successful Workers API
install, private endpoint install, and final public admission chain:

```bash
python3 render-desired-state.py \
  --manifest /protected/workers-api.yaml \
  --render-receipt /protected/workers-api-render.json \
  --credential-receipt /protected/workers-api-credential.json \
  --endpoint-installation /protected/workers-api-private-endpoint.json \
  --object-router-endpoint-installation /protected/workers-object-router-private-endpoint.json \
  --public-admission /protected/public-admission.json \
  --output-dir /data/tmp/management-workers-api-desired \
  --receipt /protected/management-workers-api-render.json

HUB_KUBECONFIG=/protected/management.kubeconfig \
ACTOR_MANAGEMENT_GIT_CREDENTIAL=/protected/management-git-publisher.json \
ACTOR_MANAGEMENT_EXPECTED_REVISION=<reviewed-current-main-revision> \
  ./publish.sh /data/tmp/management-workers-api-desired \
  /protected/management-workers-api-render.json \
  /protected/management-workers-api-publication.json

python3 render-application.py \
  --publication-receipt /protected/management-workers-api-publication.json \
  --desired-render-receipt /protected/management-workers-api-render.json \
  --output /protected/management-workers-api-application.yaml

HUB_KUBECONFIG=/protected/management.kubeconfig \
  ./install-application.sh \
  /protected/management-workers-api-application.yaml \
  /protected/management-workers-api-publication.json \
  /protected/management-workers-api-render.json \
  /protected/workers-api-private-endpoint.json \
  /protected/workers-object-router-private-endpoint.json \
  /protected/management-workers-api-convergence.json
```

Publication is a compare-and-swap against the reviewed current Git revision.
Concurrent Cell or management publication fails rather than overwriting the
other commit. If the push succeeds but the process dies before its receipt is
published, replay with the same expected revision is accepted only when that
revision is an ancestor and the live Git tree is byte-identical; this closes
the bootstrap ACK-loss window without weakening CAS. Application installation snapshots Deployment, private Service,
and external Secret UIDs; waits for the exact revision to become
`Synced/Healthy`; proves that the VIP/CLB Service and UIDs survived adoption;
then changes only `revisionHistoryLimit` to prove Argo self-heal without a Pod
rollout.

Later releases do not repeat the imperative adoption cycle. They bind the
exact prior Argo convergence receipt instead of claiming that a not-yet-
deployed image has already passed the live public admission chain:

```bash
python3 render-desired-state.py \
  --manifest /protected/workers-api-next.yaml \
  --render-receipt /protected/workers-api-next-render.json \
  --credential-receipt /protected/workers-api-credential.json \
  --endpoint-installation /protected/workers-api-private-endpoint.json \
  --object-router-endpoint-installation /protected/workers-object-router-private-endpoint.json \
  --prior-convergence /protected/management-workers-api-prior-convergence.json \
  --output-dir /data/tmp/management-workers-api-next \
  --receipt /protected/management-workers-api-next-render.json
```

The rendered Git tree includes the immutable `workers-api-render.json` input
as a non-Kustomize evidence artifact. This makes every desired-state revision
self-contained: `evidence.json` binds its digest and the exact receipt remains
available even after an operator scratch directory is removed.

Publication reads the current global repository HEAD by default and the Git
push is the compare-and-swap; an explicit
`ACTOR_MANAGEMENT_EXPECTED_REVISION` remains available for audited replay.
That repository HEAD is distinct from the prior Workers API Application revision. The
installer proves that the live Application is still synced to its receipt-
bound prior revision and that Deployment, private Service, and external Secret
UIDs have not changed before advancing it. The three-control-node topology uses
hard zone spreading, preferred hostname anti-affinity, and a drain-first
rolling update with `maxUnavailable: 1` and `maxSurge: 0`. The controller first
frees one zone/node, then places the digest-pinned replacement while the other
two replicas remain available. A surge Pod is unsafe here: it may be placed
while the old Pod in its destination zone is still counted, after which
deleting an old Pod in another zone leaves a stable `1/2/0` distribution. The
installer and live recertifier therefore require three Ready replicas on three
distinct Ready nodes in three distinct zones. Post-deployment product
qualification emits the new convergence/public evidence; a failed rollout
never requires deleting the serving Deployment.
