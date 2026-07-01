# Trade Seoul Sandbox

This directory is the deploy-facing GitOps entry for `trade` in `sandbox-kr-1`.

Runtime notes:

- namespace: `lightvela-playground-sandbox-kr-1`
- image registry: `lightclaw-kr1.tencentcloudcr.com/lightclaw/trade`
- MySQL: namespace-local `mysql.lightvela-playground-sandbox-kr-1.svc.cluster.local`
- site kind: `intl`
- trade region override: `ap-singapore`
- DB job catalog: `argocd/catalogs/playground/seoul-playground/sandbox-kr-1/trade.yaml`

The runtime secret is sourced from `../../../secrets/sandbox-kr-1/trade-runtime-secrets.sops.yaml`.
