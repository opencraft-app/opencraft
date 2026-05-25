# CloudAgent Gateway Shanghai Production

This directory is the deploy-facing Argo CD entry for `cloudagent-gateway` in
Shanghai production.

Boundaries:

- Source code remains under `cloudagent/`.
- `cloudagent/gateway/deploy/k8s/gateway-shprod.yaml` owns the base Kubernetes
  shape.
- This overlay owns shprod image pins, artifact pins, and the ksops entry for
  runtime credentials.
- The leaf Argo app is scanned by `root-shprod` through
  `argocd/apps/shprod/cloudagent-gateway.yaml`.

Secret keys:

```text
GATEWAY_AGS_API_KEY
GATEWAY_TOKENHUB_API_KEY
GATEWAY_API_KEY
GATEWAY_TALOS_API_KEY
TENCENTCLOUD_WSA_APIKEY
```

Only `GATEWAY_AGS_API_KEY` and `GATEWAY_TOKENHUB_API_KEY` are required. The
core gateway runtime keys stay in `gateway-runtime-secrets`.
`TENCENTCLOUD_WSA_APIKEY` stays in `cloudagent-wsa-search-secrets`; keep search
provider credentials split so they cannot overwrite the runtime secret.
The Deployment references all keys explicitly with `secretKeyRef`; do not
replace that with `envFrom.secretRef`.

Non-secret values such as sandbox template ids, sidecar URLs, and checksums
belong in `cloudagent-gateway-platform.env` and should be updated by release
promotion or a reviewed GitOps change.
