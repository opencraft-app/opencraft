# Shanghai Temporal Worker Cluster

Source overlay for the dedicated Shanghai TKE worker cluster (`cls-56a1mbml`).
The cluster runs `temporal-worker-controller`, so workers are deployed with the
Temporal official `WorkerDeployment` CRD instead of a plain Kubernetes
`Deployment`.

Workers connect to the Shanghai Temporal frontend:

```bash
TEMPORAL_ADDRESS=temporal-frontend-sh.lightclaw.tech:443
TEMPORAL_NAMESPACE=default
TEMPORAL_TLS=true
```

Runtime credentials are supplied by Kubernetes secrets and must not be committed
as plaintext.

## What This Deploys

- `Namespace` `temporal-workers`
- `Connection` `lightclaw-temporal`
- `WorkerDeployment` `rescue-exporter-worker`
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
repository, then auto-pins `argocd/services/workers/shanghai-workers/workers-platform.env`.
The GitOps view is mirrored under `argocd/services/workers/shanghai-workers/`.

Manual image pin, if needed:

```bash
WORKERS_IMAGE=lightclaw-shprod.tencentcloudcr.com/lightclaw/workers:<tag>
```

## Verify

```bash
kubectl -n temporal-workers get connection,workerdeployment,deploy,pods
kubectl -n temporal-workers describe workerdeployment rescue-exporter-worker
kubectl -n temporal-workers logs -l temporal.io/worker-deployment=rescue-exporter-worker --tail=100
```

Healthy worker logs should mention `worker listening on
task_queue=tencent-cvm-rescue-export` and should not repeatedly show HTML
`502` / `504` poll failures. Repeating gateway HTML errors are an ingress or
load-balancer gRPC long-poll issue, not a worker lifecycle issue.

## Notes

- Do not apply `workers/k8s/base/manifests.yaml` plain `Deployment` into this
  cluster; it would compete with controller-managed deployments.
- Beijing sandbox continues to use the plain `Deployment` overlay until that
  cluster also installs `temporal-worker-controller`.
