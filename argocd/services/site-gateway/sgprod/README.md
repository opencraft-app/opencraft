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
- `SITE_GATEWAY_AUTH_ENDPOINTS_ENABLED=true`
- `SITE_GATEWAY_AUTH_FIXED_HOST=sites-auth.lightvela.site`
- `SITE_GATEWAY_AUTH_OIDC_ISSUER=https://api.lightvela.ai`
- `SITE_GATEWAY_AUTH_OIDC_AUTHORIZE_URL`
- `SITE_GATEWAY_AUTH_OIDC_TOKEN_URL`
- `SITE_GATEWAY_AUTH_OIDC_JWKS_URL`
- `SITE_GATEWAY_AUTH_OIDC_CLIENT_ID=site-gateway`
- `SITE_GATEWAY_AUTH_AEAD_ACTIVE_KEY_ID`
- `SITE_GATEWAY_AUTH_SESSION_TTL=5m`
- `SITE_GATEWAY_DSH_DOMAINS` (empty keeps DSH disabled)
- `SITE_GATEWAY_DSH_FEDERATION_AUTHORIZE_URL`
- `SITE_GATEWAY_DSH_FEDERATION_BASE_URL` (empty keeps DSH disabled)
- `SITE_GATEWAY_DSH_FEDERATION_CLIENT_ID`
- `SITE_GATEWAY_DSH_FEDERATION_KEY_ID`

Secret values in `site-gateway-secrets`:

- `WEBSITE_INTERNAL_API_TOKEN`, identical to the CTL runtime value
- `WEBSITE_COS_SECRET_ID`
- `WEBSITE_COS_SECRET_KEY`
- `SITE_GATEWAY_AUTH_AEAD_KEYS`
- `SITE_GATEWAY_DSH_FEDERATION_HMAC_KEY` when DSH is enabled

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

The Singapore deployment keeps `SITE_GATEWAY_AUTH_MODE=public`, so `*.lightvela.site` remains
anonymous. OIDC endpoints are enabled independently for explicit login and callback flows.
UserAuth signing keys stay in the Auth control plane; the gateway owns a separate AEAD keyring.

DSH must remain disabled until `*-dsh.lightvela.site` and `*-dsh.lightvela.tech` route only through
`access_proxy/user-auth`. That proxy must remove client-supplied DSH context headers and inject
exactly one Bot ID plus one delegated session after login. Site-gateway signs the existing Auth
federation request and never receives Tencent Cloud credentials. The public Pages Ingress is not
a trusted DSH entry and must not bypass that proxy.

## Release ownership

- Application: `argocd/apps/sgprod/site-gateway.yaml`
- Project: `argocd/projects/sgprod-site-gateway.yaml`
- Pipeline: `.ci/site-gateway.yml`
- SSM export manifest: `scripts/ssm_manifest.site-gateway.sgprod.yaml`
- Target: cluster `sgprod`, namespace `ctl`

Production sync remains manual. Merging the GitOps change only approves desired state.
