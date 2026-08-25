# site-gateway / shprod

Shanghai production desired state for authenticated user websites on `*.lightvela.tech`.

## Runtime contract

- Pages host: `*.lightvela.tech`
- Auth fixed host: `sites-auth.lightvela.tech`
- OIDC issuer and endpoints: `https://api.lightvela.com`
- Content mode: `required`
- COS region: `ap-shanghai`
- TLS Secret: `site-gateway-wildcard-tls`, maintained outside this application
- Runtime Secret: `site-gateway-secrets`, provisioned from `mono-shprod-site-gateway-secrets`

`site-gateway-secrets` must contain `WEBSITE_INTERNAL_API_TOKEN`, `WEBSITE_COS_SECRET_ID`,
`WEBSITE_COS_SECRET_KEY`, and `SITE_GATEWAY_AUTH_AEAD_KEYS`. The internal token must equal the
value used by CTL and website-deployer. The AEAD keyring must contain
`site-gateway-sh-20260825-1`. No plaintext key or Tencent Cloud certificate ID belongs in Git.

## Pre-sync gates

Do not promote or sync this Application until all of the following are true:

1. CTL migration `000028` has completed and the Shanghai database is clean at schema version 28.
2. CTL, UserAuth, and website-deployer have been promoted, synced, and verified healthy.
3. `SITE_GATEWAY_COS_BUCKET` points to the dedicated private Shanghai website bucket, whose
   `_artifacts/` lifecycle rule has been applied and read back.
4. `site-gateway-secrets` exists in `ctl` and its four required keys have been verified by name.
5. Shanghai UserAuth exposes the configured OIDC issuer, authorize, token, and JWKS endpoints.
6. `site-gateway-wildcard-tls` references the Tencent Cloud certificate covering `*.lightvela.tech`.
7. DNS for `*.lightvela.tech` points to the Shanghai CLB created by this Ingress.

This environment deliberately leaves DSH disabled. Domestic DSH requires its own wildcard TLS,
Federation, and HMAC prerequisites and must not be enabled as a side effect of Pages rollout.

Production promotion and Argo sync remain manual.
