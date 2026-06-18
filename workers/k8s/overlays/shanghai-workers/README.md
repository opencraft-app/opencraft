# Shanghai Temporal Worker Cluster

Source overlay for the dedicated Shanghai TKE worker cluster (`cls-56a1mbml`).
The cluster runs `temporal-worker-controller`, so workers are deployed with the
Temporal official `WorkerDeployment` CRD instead of a plain Kubernetes
`Deployment`.

Workers connect to the Shanghai Temporal frontend:

```bash
TEMPORAL_ADDRESS=temporal.lightvela.com:443
TEMPORAL_NAMESPACE=default
TEMPORAL_TLS=true
```

Runtime credentials are supplied by Kubernetes secrets and must not be committed
as plaintext.

## What This Deploys

- `Namespace` `temporal-workers`
- `Connection` `lightclaw-temporal`
- `WorkerDeployment` `rescue-exporter-worker`
- `WorkerDeployment` `hermes-import-worker`
- runtime `Secret` and image pin `ConfigMap`

The controller owns the versioned child `Deployment`s. It injects the Temporal
worker lifecycle variables used by `rescue-exporter`:

- `TEMPORAL_ADDRESS`
- `TEMPORAL_NAMESPACE`
- `TEMPORAL_DEPLOYMENT_NAME`
- `TEMPORAL_WORKER_BUILD_ID`

This is the official Temporal Worker Deployment / Worker Versioning path. Do
not add manual `TEMPORAL_DEPLOYMENT_NAME` or `TEMPORAL_WORKER_BUILD_ID` values to
the pod template; the controller derives them from the `WorkerDeployment`.

## Release Flow

CI builds the `workers` image for `shanghai-workers` with the shprod TCR
repository, then auto-pins
`argocd/services/workers-rescue-exporter/shanghai-workers/workers-platform.env`.
`hermes-import-worker` uses the same workers image and pins through
`argocd/services/workers-hermes-importer/shanghai-workers/workers-platform.env`.
Shared runtime resources are deployed by
`argocd/services/workers-runtime/shanghai-workers/`, while each concrete worker
gets its own deploy service and Argo app.

Manual image pin, if needed:

```bash
WORKERS_IMAGE=lightclaw-shprod.tencentcloudcr.com/lightclaw/workers:<tag>
```

For local source-overlay rendering, copy the example env files into their
ignored runtime locations:

```bash
cp rescue-exporter/generated/platform.env.example rescue-exporter/generated/platform.env
cp hermes-importer/generated/platform.env.example hermes-importer/generated/platform.env
cp shared/generated/workers-runtime-secrets.env.example shared/generated/workers-runtime-secrets.env
```

## Verify

```bash
kubectl -n temporal-workers get connection,workerdeployment,deploy,pods
kubectl -n temporal-workers describe workerdeployment rescue-exporter-worker
kubectl -n temporal-workers describe workerdeployment hermes-import-worker
kubectl -n temporal-workers logs -l temporal.io/worker-deployment=rescue-exporter-worker --tail=100
kubectl -n temporal-workers logs -l temporal.io/worker-deployment=hermes-import-worker --tail=100
```

Healthy worker logs should mention `worker listening on
task_queue=tencent-cvm-rescue-export mode=rescue-export` or `worker listening on
task_queue=hermes-import mode=hermes-import` and should not repeatedly show
HTML `502` / `504` poll failures. Repeating gateway HTML errors are an ingress
or load-balancer gRPC long-poll issue, not a worker lifecycle issue.

## Notes

- Do not apply `workers/k8s/base/manifests.yaml` plain `Deployment` into this
  cluster; it would compete with controller-managed deployments.
- Beijing sandbox continues to use the plain `Deployment` overlay until that
  cluster also installs `temporal-worker-controller`.
