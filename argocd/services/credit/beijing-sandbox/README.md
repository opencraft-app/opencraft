# credit · beijing-sandbox

This directory is the deploy-facing source for the Beijing Credit service. It deploys the API,
daily usage worker, and lifecycle worker into the dedicated `credit` namespace.

## Runtime dependencies

- Database: shared Beijing CynosDB at `10.15.224.4`, database/user `credit`.
- Runtime Secret: Tencent Cloud SSM `mono-beijing-sandbox-credit-runtime-secrets`, exported through
  `scripts/ssm_manifest.credit.beijing-sandbox.yaml`.
- Trade: `http://trade.trade.svc.cluster.local`.
- LLMGateway control plane: `https://llmgw-control.lightvela.com`.

Before first release, the database/user and SSM Secret must exist. Do not copy plaintext credentials
from `sandbox-bj-7`; regenerate the SOPS snapshot from SSM instead:

```bash
python3 scripts/export_ssm_to_sops.py \
  --manifest scripts/ssm_manifest.credit.beijing-sandbox.yaml \
  --only credit-runtime-secrets
python3 scripts/scan_secrets.py \
  argocd/secrets/beijing-sandbox/credit-runtime-secrets.sops.yaml
```

The `master` Credit pipeline builds and auto-pins `beijing-sandbox`. Shanghai remains a separate,
manually promoted rollout and is not configured here.
