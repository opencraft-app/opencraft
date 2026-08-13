# site-gateway / sgprod

International production GitOps source for public user websites in the Singapore cluster.

## Runtime contract

Platform values in `site-gateway-platform.env`:

- `SITE_GATEWAY_IMAGE`
- `SITE_GATEWAY_DEPLOYED_AT`
- `SITE_GATEWAY_ROOT_DOMAINS`
- `SITE_GATEWAY_WILDCARD_HOST`
- `SITE_GATEWAY_TLS_SECRET_NAME`
- `SITE_GATEWAY_COS_BUCKET`
- `SITE_GATEWAY_COS_REGION=ap-singapore`
- `SITE_GATEWAY_CTL_BASE_URL=http://ctl-api.ctl.svc.cluster.local`

Secret values in `site-gateway-secrets`:

- `WEBSITE_INTERNAL_API_TOKEN`, identical to the CTL runtime value
- `WEBSITE_COS_SECRET_ID`
- `WEBSITE_COS_SECRET_KEY`

The COS credentials must be scoped to the dedicated website bucket. The bucket stays private;
all public reads go through site-gateway.

## Domain and TLS gate

The root domain, wildcard host, and Singapore COS bucket are already set to their production values.
Do not sync while `REPLACE_SITE_GATEWAY_QCLOUD_CERT_ID` or the release-managed image tag placeholder remains.
The wildcard certificate must cover the exact wildcard host and must be imported into Tencent
Cloud SSL. The ingress secret contains the resulting `qcloud_cert_id`, not PEM data.

## Release ownership

- Application: `argocd/apps/sgprod/site-gateway.yaml`
- Project: `argocd/projects/sgprod-site-gateway.yaml`
- Pipeline: `.ci/site-gateway.yml`
- SSM export manifest: `scripts/ssm_manifest.site-gateway.sgprod.yaml`
- Target: cluster `sgprod`, namespace `ctl`

Production sync remains manual. Merging the GitOps change only approves desired state.
