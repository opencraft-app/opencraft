# Worker Registry production code plane

This is the stateless, three-replica Worker code registry for the regional Hub
(cluster C). It is not deployed in runtime Cells A/B and has no local durable
volume.

The durability order is deliberately asymmetric:

1. conditionally create the immutable `VersionContent` object in COS;
2. in one FoundationDB transaction, create/verify its immutable summary and
   replace the active Worker deployment pointer;
3. return success.

Version upload and Deployment publication are also available as separate API
operations. A gradual Deployment references one or two already-persisted
Version summaries; FDB validates every reference and replaces the complete
weighted pointer while appending immutable Deployment history in one transaction.
Only the five newest uploaded Versions are eligible for a new Deployment; older
history reports whether rollback remains available. Durable Object assignment is
deterministic per `(namespace, worker, actor_id)` and changes only when weighted
version intervals actually move; ordinary stateless Worker assignment is
request-scoped.

The Registry also owns the active-Deployment invalidation fence used by
stateless dispatch. Every active pointer replacement or deletion changes an
opaque namespace cursor in the same FDB transaction. Workers API replicas
long-poll the private `deployment-cursor` endpoint, backed by an FDB watch;
this removes Registry/FDB from cache-hit request paths without relying on a
stale-time TTL. The cursor is not an ordering token and is compared only for
equality.

A process failure can therefore leave only an unreferenced COS object. It
cannot publish an FDB deployment that points to code not yet present in COS.
Deleting a Worker removes only the active deployment. Historical immutable
versions remain cold-loadable by exact ID; only the newest five are deployable for rollback;
normal Durable Object actors follow the active Deployment instead of retaining
a lifetime code-version pin.

Version GC is report-only in this release. The API identifies inactive Versions
outside the five-Version window, but COS deletion must remain disabled until the
Engine has a complete durable reverse-reference index for explicit Actor pins.

## Required release inputs

Build the production image only through the checked-in wrapper. It requires
the current generation's `base-golang` and `base-distroless` digest refs, runs
the FDB-backed Registry tests in the image build, pushes a unique tag, then
cold-pulls and verifies the OCI source identity before publishing the immutable
product receipt:

```sh
ACTOR_SOURCE_DIR=/path/to/reviewed-source \
WORKER_REGISTRY_IMAGE_TAG=<regional-tcr>/actor-fleet/worker-registry:<release> \
WORKER_REGISTRY_BUILD_BASE=<regional-tcr>/actor-fleet/base-golang@sha256:<digest> \
WORKER_REGISTRY_RUNTIME_BASE=<regional-tcr>/actor-fleet/base-distroless@sha256:<digest> \
ACTOR_PRODUCT_BUILD_RECEIPT=/data/actor-qualification/receipts/product-worker-registry-<run>.json \
REGISTRY_AUTH_FILE=/protected/tcr-auth.json \
  ./build-image.sh
```

For the regional builder, use `build-image-via-tat.sh`. It obtains a bounded
temporary TCR token, uploads only the Docker auth document, verifies the exact
reviewed-source revision and manifest on the builder, invokes `build-image.sh`,
removes the remote credential, downloads the immutable product receipt and
validates it locally. A bootstrap pull credential is not a build credential and
must not be reused for pushes.

Before applying, resolve `__WORKER_REGISTRY_IMAGE_DIGEST__` from the complete
28-image inventory. Never select it independently from the inventory used for
runtime release. Create two Secrets without committing their values:

```text
worker-registry-fdb:
  cluster-file: <FDB connection file contents>

worker-registry-fdb-tls:
  cert.pem: <client certificate accepted by the code-plane FDB cluster>
  key.pem: <matching private key>
  ca.pem: <FDB cluster CA>

worker-registry-cos:
  bucket-url: https://<bucket-appid>.cos-internal.<region>.myqcloud.com
  secret-id: <short-lived or scoped principal>
  secret-key: <secret>
  session-token: <optional token>
```

The FDB prefix is code-plane-only; it must not depend on either runtime Cell's
availability. The COS credential needs only bucket HEAD plus GET and
conditional PUT for `worker-registry/v5/**`. The bucket must have versioning
disabled: application-level version IDs are content hashes and writes use the
COS-native `x-cos-forbid-overwrite: true` contract. The CAM policy should also
require the `cos:x-cos-forbid-overwrite` condition so another client cannot
silently issue an overwrite-capable PUT with the same principal.

`--max-compatibility-date` must be updated only with the workerd release bound
used by A/B. This turns an otherwise late runtime startup failure into an
upload-time 400 response.

`--version-retention=5` is the current user-visible deployment and rollback
window. Increasing it changes only eligibility; it does not enable physical COS
deletion.

Apply and verify:

```sh
kubectl kustomize . | kubectl apply -f -
./verify.sh
```

After the three replicas are Ready, expose them through the dedicated private
regional CLB and bind every Cell runtime release to the emitted endpoint:

```sh
HUB_KUBECONFIG=/protected/management.kubeconfig \
ACTOR_WORKER_REGISTRY_PRIVATE_SUBNET_ID=subnet-... \
ACTOR_WORKER_REGISTRY_SOURCE_CIDRS=10.160.0.0/12 \
ACTOR_WORKER_REGISTRY_SECURITY_GROUP_ID=sg-... \
ACTOR_WORKER_REGISTRY_ENDPOINT_RECEIPT=/protected/worker-registry-endpoint.json \
  ./install-private-endpoint.sh

RIVET_WORKER_REGISTRY_URL=$(jq -er .endpoint /protected/worker-registry-endpoint.json) \
  ../runtime/release-runtime.sh ...
```

The Registry remains the authoritative regional code plane. Cell-local
Registry deployments are qualification fixtures only and must never be used by
a Cell admitted behind the public `/v1` API.
