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
Do not sync while the release-managed image tag placeholder remains in `site-gateway-platform.env`.
`SITE_GATEWAY_TLS_SECRET_NAME` is the stable Secret name used by the Ingress. The platform
certificate automation owns the live `Opaque` Secret in the `ctl` namespace: it obtains/renews
the wildcard certificate, imports it into Tencent Cloud SSL, and updates the live Secret's
`qcloud_cert_id`. Certificate IDs must not be written to `argocd/**`.

The wildcard certificate must cover the exact wildcard host. Before production sync, verify that
the platform automation has created `site-gateway-wildcard-tls` and that the qcloud Ingress
controller can read it. Certificate rotation may change the Tencent Cloud certificate ID without
any GitOps or application change.
The normal site-gateway Kustomize render only references the stable Secret name; it does not
create, update, or rotate that Secret. Before the first Argo CD sync, the platform owner must
provision the Secret in namespace `ctl` through the platform TLS workflow. Certificate renewal
and rotation update that existing Secret independently of site-gateway releases.

## Release ownership

- Application: `argocd/apps/sgprod/site-gateway.yaml`
- Project: `argocd/projects/sgprod-site-gateway.yaml`
- Pipeline: `.ci/site-gateway.yml`
- SSM export manifest: `scripts/ssm_manifest.site-gateway.sgprod.yaml`
- Target: cluster `sgprod`, namespace `ctl`

Production sync remains manual. Merging the GitOps change only approves desired state.
