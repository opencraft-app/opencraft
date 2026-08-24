# Site Gateway OIDC Integration Notes

This note is for the UserAuth / OIDC owner that serves `site-gateway`.

## Exact callback and fixed host

The client is fixed-host only. The browser must always enter auth through:

```text
https://sites-auth.lightvela.tech/auth/lightvela/start?launch=<opaque-launch>
```

When endpoints are enabled, the concrete site may explicitly begin the same
flow through:

```text
https://<concrete-site-host>/__lightvela/auth/start?return_to=%2Fabout
```

The OIDC provider must only redirect to the exact callback:

```text
https://sites-auth.lightvela.tech/auth/lightvela/callback
```

Do not accept wildcard callbacks, prefix callbacks, query-expanded callbacks, or
callback hosts derived from user input.

## Authorization request contract

The fixed host sends:

- `response_type=code`
- `scope=openid`
- `client_id=site-gateway`
- `redirect_uri=https://sites-auth.lightvela.tech/auth/lightvela/callback`
- `state=<opaque browser state>`
- `nonce=<opaque nonce>`
- `PKCE` parameters: `code_challenge=<S256(pkce_verifier)>` and `code_challenge_method=S256`
- `code_challenge=<S256(pkce_verifier)>`
- `code_challenge_method=S256`

UserAuth must preserve `state` on the redirect back.

## Token endpoint contract

The fixed callback exchanges the code with:

```text
grant_type=authorization_code
code=<authorization-code>
client_id=site-gateway
redirect_uri=https://sites-auth.lightvela.tech/auth/lightvela/callback
code_verifier=<pkce_verifier>
```

The returned ID token must be Ed25519 / `EdDSA`, have a valid `kid`, and match:

- `iss = SITE_GATEWAY_AUTH_OIDC_ISSUER`
- `aud = site-gateway`
- `nonce = nonce from __Host-lv_oidc_state`

JWKS must publish an `OKP` / `Ed25519` key with the signing `kid`.

## Browser cookies and final handoff

`site-gateway` owns two cookies:

- `__Host-lv_oidc_state` on `sites-auth.lightvela.tech`
- `lv_site_session` on the concrete site host

Both cookies are `Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/`, and must not
contain `Domain=`. Parent-domain cookies are forbidden.

After code exchange and ID token validation, `site-gateway` sends a 5 second
`handoff` back to:

```text
https://<concrete-site-host>/__lightvela/auth/callback?handoff=<opaque-handoff>
```

The concrete host validates `handoff`, sets `lv_site_session`, and redirects to
the safe relative `return_to`.

## Failure semantics

- Invalid `launch`, invalid state, invalid handoff, invalid `kid`, wrong `alg`,
  wrong `iss`, wrong `aud`, wrong `nonce`, or replayed host binding => `403`
- OIDC token endpoint failure or JWKS failure => `502` / `503`
- `*.lightvela.site` stays public when `SITE_GATEWAY_AUTH_MODE=public`
- `SITE_GATEWAY_AUTH_MODE=required` is invalid unless `SITE_GATEWAY_AUTH_ENDPOINTS_ENABLED=true`

## Runtime variables

Endpoint-enabled deployments must provide:

```text
SITE_GATEWAY_AUTH_ENDPOINTS_ENABLED=true
SITE_GATEWAY_AUTH_FIXED_HOST=sites-auth.lightvela.tech
SITE_GATEWAY_AUTH_OIDC_ISSUER=https://<userauth-origin>
SITE_GATEWAY_AUTH_OIDC_AUTHORIZE_URL=https://<userauth-origin>/oauth2/authorize
SITE_GATEWAY_AUTH_OIDC_TOKEN_URL=https://<userauth-origin>/oauth2/token
SITE_GATEWAY_AUTH_OIDC_JWKS_URL=https://<userauth-origin>/.well-known/jwks.json
SITE_GATEWAY_AUTH_OIDC_CLIENT_ID=site-gateway
SITE_GATEWAY_AUTH_AEAD_ACTIVE_KEY_ID=<kid>
SITE_GATEWAY_AUTH_SESSION_TTL=5m
```

Protected-content deployments additionally set:

```text
SITE_GATEWAY_AUTH_MODE=required
```

Anonymous-content deployments with working auth endpoints set:

```text
SITE_GATEWAY_AUTH_MODE=public
```

The AEAD key itself must be injected only from `site-gateway-secrets` under the
same env name:

```text
SITE_GATEWAY_AUTH_AEAD_KEYS=<kid>=<base64url-key>
```

Do not place `SITE_GATEWAY_AUTH_AEAD_KEYS` in a ConfigMap or generated
`platform.env.example`.

International `*.lightvela.site` deployments continue to set
`SITE_GATEWAY_AUTH_MODE=public` by default. They may either leave
`SITE_GATEWAY_AUTH_ENDPOINTS_ENABLED=false` for current anonymous behavior, or
set `SITE_GATEWAY_AUTH_ENDPOINTS_ENABLED=true` together with
`sites-auth.lightvela.site` to expose explicit `/__lightvela/auth/start` and
fixed-host callback support while keeping ordinary static content anonymous.
