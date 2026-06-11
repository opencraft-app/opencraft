# workers / shanghai-workers

GitOps source for `rescue-exporter-worker` on `cls-56a1mbml` (`shanghai-workers` Argo cluster).

- AppProject: `argocd/projects/shanghai-workers.yaml`
- Target cluster: `argocd/clusters/shanghai-workers.yaml` (register with `onboard_argocd_target_cluster.py`)
- Root app: `argocd/root/shanghai-workers.yaml` (bootstraps this app tree on the Beijing Argo control plane)
- Image pin: `workers-platform.env` (`WORKERS_IMAGE`) — updated by CI auto-pin.
- Runtime secrets: `argocd/secrets/shanghai-workers/workers-runtime-secrets.sops.yaml` (ksops).
- Worker CR manifests: copied from `workers/k8s/overlays/shanghai-workers/` (keep in sync when overlay changes).

The target cluster must already have `temporal-worker-controller` and the
`workerdeployments.temporal.io` / `connections.temporal.io` CRDs installed.

Runtime secrets are encrypted with sops (`workers-runtime-secrets.sops.yaml`). Edit with:

```bash
sops argocd/secrets/shanghai-workers/workers-runtime-secrets.sops.yaml
```

Image pin for manual bootstrap before CI auto-pin: set `WORKERS_IMAGE` in `workers-platform.env`
(normally updated by `.ci/workers.yml`).
