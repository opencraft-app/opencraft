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
- `SITE_GATEWAY_AUTH_MODE=public`
- `SITE_GATEWAY_AUTH_ISSUER`
- `SITE_GATEWAY_AUTH_AUDIENCE`
- `SITE_GATEWAY_AUTH_START_URL`
- `SITE_GATEWAY_AUTH_PUBLIC_KEYS`
- `SITE_GATEWAY_AUTH_SESSION_TTL=5m`
- `SITE_GATEWAY_DSH_DOMAINS` (empty keeps DSH disabled)
- `SITE_GATEWAY_DSH_TARGET_URL` (empty keeps DSH disabled)

Secret values in `site-gateway-secrets`:

- `WEBSITE_INTERNAL_API_TOKEN`, identical to the CTL runtime value
- `WEBSITE_COS_SECRET_ID`
- `WEBSITE_COS_SECRET_KEY`
- `TENCENT_SECRET_ID` and `TENCENT_SECRET_KEY` when DSH is enabled

The COS credentials must be scoped to the dedicated website bucket. The bucket stays private;
all public reads go through site-gateway.

## Domain and TLS gate

TLS lifecycle is platform-owned.
The application does not create, update, or rotate that Secret.

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

The Singapore deployment is intentionally `SITE_GATEWAY_AUTH_MODE=public` and serves
`*.lightvela.site` anonymously. A future domestic deployment for `*.lightvela.tech` must use
`required` mode, a trusted Auth start URL, and public Ed25519 keys only; signing private keys
stay in the Auth control plane.

DSH must remain disabled until `dsh.lightvela.site` and `dsh.lightvela.tech` route only through
`access_proxy/user-auth`. That proxy must remove all client-supplied `Key` headers and inject
exactly one value derived after login validation. The public Pages Ingress is not a trusted DSH
entry and must not be used to bypass that proxy.

## Release ownership

- Application: `argocd/apps/sgprod/site-gateway.yaml`
- Project: `argocd/projects/sgprod-site-gateway.yaml`
- Pipeline: `.ci/site-gateway.yml`
- SSM export manifest: `scripts/ssm_manifest.site-gateway.sgprod.yaml`
- Target: cluster `sgprod`, namespace `ctl`

Production sync remains manual. Merging the GitOps change only approves desired state.
