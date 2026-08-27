# LightVela Site Gateway Fixed-Host OIDC Protocol

This contract protects `*.lightvela.tech` user sites with a fixed-host OIDC
client. `*.lightvela.site` remains public when `SITE_GATEWAY_AUTH_MODE=public`.

## Flow

1. A concrete site host such as `ws-abc.lightvela.tech` either detects that
   `lv_site_session` is missing or invalid for protected content, or the user
   explicitly opens:

   ```text
   https://ws-abc.lightvela.tech/__lightvela/auth/start?return_to=%2Fabout
   ```

2. The site host validates itself through the configured site namespace,
   creates an encrypted `launch` token, and redirects to:

   ```text
   https://sites-auth.lightvela.tech/auth/lightvela/start?launch=<opaque-launch>
   ```

3. The fixed host validates `launch`, generates PKCE and `nonce`, stores the
   transaction in `__Host-lv_oidc_state`, and redirects to the OIDC
   authorization endpoint with `response_type=code`, `scope=openid`,
   `code_challenge_method=S256`, exact fixed callback, and browser `state`.
4. The OIDC provider redirects only to:

   ```text
   https://sites-auth.lightvela.tech/auth/lightvela/callback
   ```

5. The fixed callback validates the `__Host-lv_oidc_state` cookie and query
   `state`, exchanges the code with PKCE, validates the Ed25519 ID token using
   JWKS (`alg=EdDSA`, `kid`, `iss`, `aud`, `nonce`), then issues a 5 second
   encrypted `handoff`.
6. The browser returns to the concrete host:

   ```text
   https://ws-abc.lightvela.tech/__lightvela/auth/start?return_to=%2Fabout
   https://ws-abc.lightvela.tech/__lightvela/auth/callback?handoff=<opaque-handoff>
   ```

7. The site host validates `handoff`, sets host-only `lv_site_session`, and
   redirects to the safe relative `return_to`.

## Endpoint and content gating

`SITE_GATEWAY_AUTH_ENDPOINTS_ENABLED` controls whether the OIDC endpoints exist
at all:

```text
fixed host                -> /auth/lightvela/start + /auth/lightvela/callback
concrete site             -> /__lightvela/auth/start + /__lightvela/auth/callback
```

`SITE_GATEWAY_AUTH_MODE` still controls ordinary static content:

```text
endpoints disabled + public    -> current public behavior
endpoints enabled  + public    -> public content, explicit auth endpoints work
endpoints enabled  + required  -> static content auto-redirects into auth
endpoints disabled + required  -> invalid startup config
```

When `/__lightvela/auth/start` is used explicitly, `return_to` must remain a
safe relative path on the same concrete host. Missing or invalid values fall
back to `/`.

## Token Types

- `launch`: AEAD payload containing `site_host`, relative `return_to`, and the
  exact fixed callback URL; TTL 5 minutes.
- `__Host-lv_oidc_state`: AEAD cookie payload containing `state`,
  `pkce_verifier`, `nonce`, `launch_digest`, `site_host`, `return_to`, and the
  fixed callback URL; TTL 5 minutes.
- `handoff`: AEAD payload bound to `site_host + user_id + nonce`; TTL 5
  seconds.
- `lv_site_session`: AEAD payload bound to the concrete site host; TTL at most
  5 minutes.

Each artifact uses a distinct AEAD scope under the dedicated
`SITE_GATEWAY_AUTH_AEAD_KEYS` keyring. These keys must not be reused for
federation, signing, or any UserAuth secret. The AEAD key material must live
only in `site-gateway-secrets`; it must not appear in a ConfigMap or generated
`platform.env.example`.

## Cookie Rules

- `__Host-lv_oidc_state`: `Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/`, and
  no `Domain=`.
- `lv_site_session`: `Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/`, and no
  `Domain=`.

Set-Cookie headers for this flow must not contain `Domain=`. Parent-domain
cookies are forbidden.

## Validation Rules

- `return_to` must stay a relative path on the concrete host. Absolute URLs,
  protocol-relative URLs, control characters, and browser-normalized cross-site
  forms are rejected.
- `handoff` replay on a sibling host such as `ws-other.lightvela.tech` must be
  rejected.
- State tampering, launch tampering, invalid `kid`, wrong `alg`, wrong `iss`,
  wrong `aud`, wrong `nonce`, or expired ID tokens fail closed with `403`.
- OIDC token endpoint or JWKS fetch failures fail closed with `502`/`503`.

## Runtime Configuration

Endpoint-enabled ConfigMap values use:

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

Required content mode adds:

```text
SITE_GATEWAY_AUTH_MODE=required
```

Public content mode with enabled endpoints uses:

```text
SITE_GATEWAY_AUTH_MODE=public
```

Endpoint-enabled Secret values use:

```text
site-gateway-secrets:
  SITE_GATEWAY_AUTH_AEAD_KEYS=<kid>=<base64url-key>
```

Environment policy:

```text
*.lightvela.tech  -> required mode with endpoints enabled and sites-auth.lightvela.tech
*.lightvela.site  -> public mode, endpoints optional, sites-auth.lightvela.site when enabled
```
