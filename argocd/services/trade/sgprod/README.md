# Trade Singapore Production

The `sgprod` runtime Secret is sourced from Tencent Cloud SSM and committed only
as a SOPS-encrypted Kubernetes resource.

```bash
python3 scripts/export_ssm_to_sops.py \
  --manifest scripts/ssm_manifest.trade.sgprod.yaml \
  --only trade-runtime-secrets
python3 scripts/scan_secrets.py \
  argocd/secrets/sgprod/trade-runtime-secrets.sops.yaml
```

`TRADE_CLOUDLADDER_HMAC_SECRET` is the general Trade caller secret used by
explicit CloudLadder routes, including Credit sendResource. The historical
`TRADE_BILLING_CLOUDLADDER_HMAC_SECRET` must not be the only key delivered to
the Pod: it is Billing-specific and the general transport intentionally does
not fall back to it.

Secret changes, image promotion, and Pod rollout follow the protected
`master -> CI -> gitops -> manual Argo sync` production path. Do not patch the
live Secret or restart production Pods directly.
