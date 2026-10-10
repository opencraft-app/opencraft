# Workers API production deployment

This is the Hub/control-cluster deployment of the only public `/v1` Workers endpoint. It is a
replaceable, HPA-managed stateless facade with a three-replica HA floor; Worker/Version/Deployment truth remains in the
three-replica Worker Registry backed by FDB/COS, and Actor truth remains in the selected runtime
Cell.

Object creation and activation have a fixed three-second readiness deadline. Worker and Agent
fetches are intentionally excluded from the control-plane HTTP timeout so long conversations and
streaming responses follow caller cancellation and the Agent execution policy instead.

Before rendering, resolve the immutable `workers-api` image from the complete
28-image inventory plus both Cells' identity, private Engine/stateless endpoint,
and published `CellServingRoute` receipts. Never
select this image independently from the inventory used for runtime release.
The renderer requires the product ref, source revision, source-manifest digest,
and original build-receipt byte digest to match the inventory's exact
`workers-api` entry. Matching Go foundations alone is insufficient. Both
bootstrap and serving reject a mismatch before publishing any output.
Do not reformat an immutable product receipt after assembling the inventory.
Each Cell first creates its immutable `actor-stateless-auth/v1` credential
receipt. `sync-credentials.sh` then copies the two exact Engine, executor and
Object Router capabilities into the externally owned immutable
`workers-api-internal-token-<content-hash>` and emits a value-free receipt; do
not commit the Secret or its values. The legacy `workers-api-internal-token`
remains unchanged as the capability source during the one-time pre-Router
bootstrap: its three Registry/Engine values must remain byte-identical. The
versioned Secret name is included in the Pod template and every render/GitOps
receipt. Never delete and recreate an immutable Secret under the same name:
kubelet may retain the old immutable object indefinitely even after its UID
changes, leaving new Pods in `CreateContainerConfigError`.

The first rollout is deliberately two-phase. `object-router-bootstrap` starts
the new image and internal listener from Engine identity routes while removing
stateless executor capabilities from the Pod. After that converges, install the
private Object Router endpoint, then A/B executors and serving routes. A final
`serving` render consumes those receipts and enables stateless dispatch. No
placeholder address or hand-edited Deployment is part of the production path.

`verify.sh` may run from any operator working directory, including against a
relocated reviewed-source tree. It enters each test suite's source directory
and passes module names to `unittest`, not absolute file paths. The fleet
static gate includes a real copied-tree regression with dotted parent paths
and an unrelated working directory.

`/readyz` reports local facade readiness after configuration validation. It does
not probe Registry, require an admitted placement candidate, or require every
Cell Engine to be healthy. Registry outages must not withdraw all Hub replicas
and cut off already-cached Object routes. New Objects and placement-cache misses
still need Registry truth and fail closed when it is unavailable. Cell route
identity is checked on every hit. Deployment watch loss still disables the active
Worker code cache; readiness does not bypass code loading or freshness checks.
Registry has its own storage readiness probe, and Cell qualification remains
independent of facade readiness. Capacity and dependency failures are request-scoped.

Stateless dispatch keeps at most 4,096 recently used active Workers per API
replica. This is not a TTL cache: Registry changes an opaque namespace cursor
in the same FDB transaction as the active Deployment pointer, and each API
replica maintains a long-polling FDB-backed cursor watch. A cursor change
flushes the LRU; loss or corruption of the watch disables the cache and sends
misses to Registry until synchronization is re-established. The Worker read
and cursor are one Registry transaction snapshot, so a response that raced an
invalidation cannot repopulate the old Deployment.

For the first production VPC, expose that Service only through the receipt-
producing private CLB entry point. It accepts explicit bounded source CIDRs,
binds the Tencent subnet, source Service UID, Deployment UID and exact image,
requires at least three endpoints, and probes `/readyz` before publishing its
immutable receipt:

```sh
HUB_KUBECONFIG=/protected/hub.kubeconfig \
ACTOR_WORKERS_API_PRIVATE_SUBNET_ID=subnet-... \
ACTOR_WORKERS_API_SOURCE_CIDRS=10.160.0.0/16,9.134.163.40/32 \
ACTOR_WORKERS_API_SECURITY_GROUP_ID=sg-... \
ACTOR_WORKERS_API_ENDPOINT_RECEIPT=/protected/workers-api-private-endpoint.json \
PYTHON=python3.11 \
  ./install-private-endpoint.sh
```

The security-group ID must come from the same management Terraform inventory
as the subnet. TKE binds it to its dynamically owned CLB. This operation emits
an `installed` receipt only; the separate cloud qualification gate must observe
the exact group through the CLB API and prove C-allow plus A/B-deny before the
endpoint is eligible for publication. Kubernetes `loadBalancerSourceRanges`
remains defense in depth, not qualification evidence by itself. The CLB is private even when an
explicitly reviewed corporate source range is not RFC1918. The script rejects
IPv4 ranges broader than `/12`, loopback, multicast, unspecified ranges,
mutable images, or fewer than three Ready API backends. The private CLB itself
publishes the product port `6688`; no operator host, Caddy, reverse tunnel, or
DevCloud-to-IDC route belongs to the production request path.

The Service intentionally uses `externalTrafficPolicy: Cluster`: Workers API
does not use the original client IP, while cluster forwarding prevents a CLB
node target from refusing new connections during one API Pod replacement.
Source authorization remains at the exact CLB security group and bounded
`loadBalancerSourceRanges` verified by the cross-VPC qualification gate.
The TKE 1.30 deployment also uses the native lifecycle sleep action for a
30-second preStop drain window. That exceeds the CLB's observed three-by-five-
second unhealthy threshold and keeps stale forwarding entries served until
the backend has been removed; the 50-second Pod grace period leaves another
ten seconds for Go's graceful HTTP shutdown.
Qualification reads the live Tencent listener as well as Kubernetes state:
there must be exactly one TCP/6688 node-target listener with health checking,
and final admission rechecks the VIP, Service forwarding policy and Pod drain
window instead of trusting the earlier installation receipt alone.

Run the final gate from a protected operator environment that has Tencent API
credentials and the fleet TAT helper. The allowed probe must be a C instance;
the two denied probes must be distinct A/B Cell instances. The gate verifies
their live CVM VPC identities, the CLB type/VIP/exact security group, a real
`/readyz` response from C, and absence of any HTTP response from both Cells:

```sh
ACTOR_WORKERS_API_ENDPOINT_INSTALLATION_RECEIPT=/protected/workers-api-private-installed.json \
ACTOR_WORKERS_API_ENDPOINT_QUALIFICATION_RECEIPT=/protected/workers-api-private-qualified.json \
ACTOR_WORKERS_API_ALLOWED_TAT_INSTANCE=ins-c \
ACTOR_WORKERS_API_DENIED_TAT_INSTANCES=ins-a,ins-b \
ACTOR_TAT_RUN=/reviewed/tat-run.sh \
TCCLI=/reviewed/tccli \
  ./qualify-private-endpoint.sh
```

Finally run one normal Workers API Pod replacement through the qualified CLB.
The bounded gate requires at least three digest-identical replicas on distinct nodes,
keeps requests flowing through the CLB before/during/after deletion, and fails
on any non-ready response or if the replacement window is too short to test:

```sh
python3.11 ./qualify-private-endpoint-ha.py \
  --kubeconfig /protected/hub.kubeconfig \
  --endpoint http://10.160.0.17:6688 \
  --receipt /protected/workers-api-private-ha.json
```

Production images are built with `build-image.sh`. It accepts only reviewed source identity,
digest-pinned Go/runtime bases, a new `ACTOR_PRODUCT_BUILD_RECEIPT` path, and protected registry
credentials. Both bases must come from the current product build generation in Beijing TCR; the
Dockerfile deliberately has no defaults. After push, the wrapper cold-pulls the exact digest,
rechecks the source OCI labels, and only then publishes the receipt. It runs the Workers API unit
tests inside the Go 1.25 build stage.

The TAT build wrapper gives each operation an immutable receipt identity bound
to source revision, source manifest, both base digests and the unique image tag.
Changing bases or tag cannot collide with an earlier source-only receipt.
Python bytecode is disabled on the builder so receipt validation cannot add
derived files to the reviewed source closure. This prepares a candidate image;
it does not update Kubernetes, Argo, or the live release inventory.

The [2026-10-04 candidate receipt](evidence/workers-api-product-42ef7aea-20261004.json)
records a real Go build, TCR push and isolated cold pull for the safe platform
logger, redirect-preserving fetch client and Registry-outage facade readiness.
Its source is the committed mono2 Go subtree, not a remembered file subset.
It matches the runtime-2757 dependency lock and has passed leaf promotion into
a staged inventory. It is not deployed; the original strict10k final-drain
supervisor remains unchanged. CLS addon/CRD/topic compatibility, controlled
canary collection, positive/negative queries and exploration release gates
remain separate prerequisites.

```sh
./verify.sh
python3.11 ./render.py \
  --inventory /protected/all-images.lock.json \
  --workers-api-product-receipt /protected/product-workers-api.json \
  --credential-receipt /protected/workers-api-credential.json \
  --engine-endpoint-receipt /protected/actor-bj-a01-engine-endpoint.json \
  --engine-endpoint-receipt /protected/actor-bj-b01-engine-endpoint.json \
  --stateless-endpoint-receipt /protected/actor-bj-a01-stateless-endpoint.json \
  --stateless-endpoint-receipt /protected/actor-bj-b01-stateless-endpoint.json \
  --cell-route-receipt /protected/actor-bj-a01-route.json \
  --cell-route-receipt /protected/actor-bj-b01-route.json \
  --cell-serving-route-receipt /protected/actor-bj-a01-serving-route.json \
  --cell-serving-route-receipt /protected/actor-bj-b01-serving-route.json \
  --pool actor-beijing-kubernetes \
  --phase serving \
  --output /protected/workers-api.yaml \
  --receipt /protected/workers-api-render.json
```

The renderer rejects public origins, duplicate Cells, Engine/stateless
endpoint/route UID or datacenter mismatches, mixed Pools, unbound serving-route
publications, incomplete image inventories, and mutable image references. The
manifest is therefore a derived release artifact, but it does not remember serving
addresses. Workers API reads CAS-versioned `CellServingRoute/v1` ConfigMaps at
runtime; an endpoint revision takes effect without rolling the API replicas,
while Cell/Pool UID and per-Cell capability inventories remain release-bound. The Deployment
starts at three replicas and the HPA may scale it to thirty. QPS and in-flight requests are the
direct routing-pressure signals, with CPU and RSS as safety signals; request latency remains an
alerting and diagnosis signal so an expected long-lived response cannot by itself force maximum
scale. Prometheus Adapter publishes only the two bounded per-Pod routing metrics used by the HPA.

Install the rendered artifact through the receipt-producing entry point. It
revalidates the exact synchronized credential and never creates, replaces or
rotates the externally owned Secret:

```sh
HUB_KUBECONFIG=/protected/hub.kubeconfig \
ACTOR_WORKERS_API_MANIFEST=/protected/workers-api.yaml \
ACTOR_WORKERS_API_RENDER_RECEIPT=/protected/workers-api-render.json \
ACTOR_WORKERS_API_CREDENTIAL_RECEIPT=/protected/workers-api-credential.json \
ACTOR_WORKERS_API_INSTALL_RECEIPT=/protected/workers-api-install.json \
  ./install.sh
```

Installation passes only after the current HPA replica target (never fewer than three)
is digest-pinned, fully Ready and spread across at least three distinct nodes, and
the local `/readyz` probe succeeds. This does not qualify Registry availability or
an end-to-end Worker request. The renderer and install
receipt still require the complete pair of private Engine routes and separate
credentials; live Engine and placement-capacity health are monitored and
enforced per request rather than coupled to global Pod readiness.

Release is not qualified by applying this manifest alone. The local gate must first prove API Pod
replacement, concurrent first-object resolution across three replicas, and stale-cache rejection
after Worker deletion. Production qualification repeats replacement through the real internal
ingress and records exact Pod UIDs before and after the drill.

After both immutable identity routes and both versioned serving routes are published,
close the public admission chain with `qualify-public-admission.py`. It joins both
Argo convergence receipts, both live identity and serving routes, the rendered/installed API, private CLB
installation and security qualification, the post-routing Pod-replacement
gate, the formal management Code Plane rebuild-chain receipt, the private
regional Registry endpoint it owns, one live Registry binding for each Cell,
and one real `/v1` placement. It then rechecks the live Pool, Claims,
logical/spoke Cell UIDs, routing digest, three Pod/node identities and endpoint
Service UID before emitting the final content-addressable receipt.
