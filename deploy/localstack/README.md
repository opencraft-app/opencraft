# Localstack Kubernetes Environment

`localstack` is a first-class developer environment rendered with Kustomize and
executed by the developer's local Kubernetes cluster. It does not use Argo CD,
GitOps promotion, CI/CD, TCR, Tencent Cloud resources, SOPS, or KSOPS.

The currently verified host is macOS on Apple Silicon with OrbStack. Docker
Desktop Kubernetes is accepted by the context guard and uses the same local
Docker image store. Other local cluster runtimes need an explicit image-loading
and host networking contract before they are supported.

## Runtime Model

- Existing service `k8s/base` manifests remain the runtime source.
- Environment overlays replace database, Redis, URL, image, and feature values.
- TKE, CLS, Ingress, HPA, ServiceMonitor, PodMonitor, and cloud pool resources
  are deleted from the rendered local environment.
- MySQL, Redis, migrations, seed jobs, and every Lightclaw business service run
  in Kubernetes.
- Sandbox uses `CLOUD_PROVIDER=mock` and does not access a real resource pool.
- Trade, Shadow, and CloudLadderGateway are real service binaries. Only their
  external boundaries are fake: Jifei, Tencent Cloud APIs, QQ OAuth, and the
  Sandbox cloud provider.
- Auth keeps its real encryption and persistence path for legacy real-name
  verification, while Tencent FaceID terminates at the HTTPS endpoint exposed
  by `fake-tencentcloud`. A checked-in local-only CA is trusted only by the Auth
  Pod; no real identity provider is contacted.
- `shadow-trade-adapter` is local compatibility glue between Trade's
  `external_user_id` resolver contract and Shadow's authenticated preflight
  binding contract. It does not replace either business service.
- `fake-wechat-pay-bridge` receives the local QR bridge request, injects a
  deterministic WeChat OpenID, and redirects to the real frontend payment
  page. Local Nginx only routes the initial request to this explicit fake
  external boundary; frontend source, Auth, CTL, Trade, and release images stay
  unchanged.
- Shadow's local SQLite data uses a PVC, so account bindings survive rollouts
  and `down`/`up`.
- `mock-control` loads versioned capability/scenario files and persists local
  Fake QQ users plus their active scenario in MySQL. Fake QQ defaults to
  creating a blank user and also lists users already present in the current
  localstack state.
- Checked-in Secret values are local-only fake values.
- macOS `launchd` keeps `kubectl port-forward` entrypoints alive after the
  launching terminal exits.

The environment contract is
[`deploy/envs/localstack/environment.yaml`](../envs/localstack/environment.yaml).

## Prerequisites

- macOS on Apple Silicon
- OrbStack Kubernetes, or Docker Desktop with Kubernetes enabled
- `docker`, `kubectl`, `kustomize`, and `make`
- current Kubernetes context set to `orbstack` or `docker-desktop`

Check the host before building images:

```bash
make local-stack-doctor
```

## Start

```bash
make local-stack-up
```

The command:

1. refuses non-local Kubernetes contexts;
2. builds native `linux/arm64` images in the local Docker image store;
3. applies infrastructure and service Kustomize overlays;
4. runs all database migration jobs;
5. applies idempotent local seed data;
6. waits for every Deployment to become available;
7. installs launchd-managed localhost entrypoints.

### Sandbox Capacity Bootstrap

Sandbox capacity is bootstrapped from checked-in, idempotent sources so a fresh
developer machine does not depend on manually prepared database rows:

1. `deploy/local/mysql/seed/030-ctl-bundles.sql` assigns local bundles to
   `spec-2c4g50g` and `spec-4c8g80g`.
2. `deploy/localstack/ctl/server_conf_rewrite.toml` maps both specs to
   `openclaw-default`, `sku-local-default`, and `pool-local-default`.
3. `deploy/local/mysql/seed/020-sandbox-mock-pool.sql` creates that template
   class, SKU, pool, bindings, and five clean mock instances.

`make local-stack-up` runs migrations first and then reruns the seed Job, so the
same contract works on an empty MySQL volume and repairs missing seed rows on an
existing volume. Spec-to-pool routing remains CTL environment configuration; it
is intentionally not duplicated into the sandbox schema.

For a manifest-only check:

```bash
make local-stack-render >/dev/null
bash deploy/localstack/tests/validate.sh
```

Reuse already-built images:

```bash
LOCALSTACK_SKIP_BUILD=1 make local-stack-up
```

Build one image:

```bash
bash deploy/localstack/localstack.sh build frontend
```

Services whose release Dockerfiles pin `amd64`, plus CloudLadderGateway, Shadow,
Trade, CTL, and the frontend, use localstack-only Dockerfiles under
`deploy/localstack/images/`. They build the current checkout as native arm64
without changing release Dockerfiles. The frontend Dockerfile uses the current
Next.js static-export build and bakes the localhost gateway URL into the local
artifact.

## Endpoints

| Component | URL |
| --- | --- |
| Frontend | `http://localhost:5173` |
| Service gateway | `http://localhost:8085` |
| Auth | `http://localhost:28081` |
| Fake QQ OAuth | `http://localhost:19010` |
| Sandbox API | `http://localhost:18081` |
| Payment | `http://localhost:18082` |
| Subscription | `http://localhost:8086` |
| AI gateway | `http://localhost:18080` |
| CloudLadderGateway | `http://localhost:18095` |
| Shadow | `http://localhost:18083` |
| Trade | `http://localhost:18084` |
| CTL | `http://localhost:19590` |
| Fake Jifei | `http://localhost:19020` |
| Fake Tencent Cloud APIs | `http://localhost:19030` |
| Fake WeChat pay bridge | `http://localhost:19040` |
| MySQL | `127.0.0.1:43306` |
| Redis | `127.0.0.1:36379` |

The fake Jifei service treats `needCharge=0` as a completed local payment. It
then replays Jifei's `checkCreate` and `createResource` callbacks to the real
Trade service, which provisions the pass through the real CTL service. No real
payment provider or cloud resource is contacted. Fake Jifei stores deal
context and fulfillment status in `/data/fake-jifei.sqlite` on its own PVC, so
Deployment rollouts do not lose pending or completed mock orders. Its
Deployment uses the `Recreate` strategy to preserve the single-writer SQLite
model.

The local QQ OAuth flow starts at:

```text
http://localhost:8085/auth/oauth/qq/start?return_to=http%3A%2F%2Flocalhost%3A5173%2F
```

The Fake QQ page selects a user and a scenario. Creating a blank user shows its
synthetic name, ID card, phone, and development SMS code before continuing the
normal OAuth redirect. Existing users keep state produced by earlier
interactions.

The initial scenarios are:

- `full`: every unspecified fake capability uses its success default;
- `realname-success`: Tencent ID-card verification succeeds;
- `realname-failed`: Tencent ID-card verification returns an identity mismatch.

State snapshots and scenarios are separate concepts. A logical localstack
snapshot establishes state that already exists across services; a scenario
changes only future fake-provider behavior. Restoring a snapshot is an
explicit environment-wide operation. Switching a user scenario does not
rewrite Auth, subscription, payment, sandbox, or mockserver history.

## Secret Overrides

SOPS is intentionally not part of localstack. Each component has a checked-in
`secrets.defaults.env` containing fake local values.

To replace a Secret, create a complete env file under:

```text
deploy/envs/localstack/overrides/<component>.env
```

Supported component names are `infrastructure`, `auth`, `payment`,
`subscription`, `ai-gateway`, `sandbox`, `cloudladdergateway`, `shadow`,
`trade`, and `service-gateway`. Override files are ignored by Git and applied
after Kustomize creates the default Secret.

## Operations

```bash
make local-stack-status
make local-stack-logs
make local-stack-down
make local-stack-reset
```

`down` removes localstack workloads but preserves MySQL, Redis, and Shadow
PVCs. `reset` also removes namespaces and local data. Re-running `up` reruns
idempotent migrations and seed jobs.

The former Compose stack remains under `deploy/local/` as a transition and
debugging fallback. `local-stack-up` stops that stack before binding localhost
ports so both environments cannot accidentally serve the same URLs.
