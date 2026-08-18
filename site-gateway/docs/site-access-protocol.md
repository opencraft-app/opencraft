# LightVela Domestic Site Access Protocol

This contract protects user sites under `*.lightvela.tech`. Sites under
`*.lightvela.site` remain anonymous when their gateway is configured with public
mode.

## Roles

The trusted Auth integration is the issuer. It owns the existing `lc_session`
cookie and decides whether the browser is logged in. It must never copy that
cookie to the domestic site or expose it to browser JavaScript.

The site-gateway is the verifier. It only receives a short-lived signed access
ticket and verifies it locally. It does not render a login page, store user
sessions in Redis, or call Auth for every static asset.

## Signed Ticket

The issuer creates a compact JWS using Ed25519 with `alg=EdDSA`:

Header:

```json
{
  "typ": "LV-Site-Access",
  "alg": "EdDSA",
  "kid": "<key-id>"
}
```

Payload:

```json
{
  "iss": "lightvela-auth",
  "aud": "lightvela-site-gateway",
  "sub": "<lightvela-user-id>",
  "site_host": "<site-id>.lightvela.tech",
  "state": "<browser-state>",
  "iat": 0,
  "exp": 0,
  "jti": "<unique-ticket-id>"
}
```

`site_host` is mandatory and binds the ticket to one domestic site host.
`state` is mandatory and must copy the state supplied by the gateway challenge.
`exp` must be no more than five minutes after `iat`. `jti` is an audit value;
the stateless verifier does not persist it.

The gateway accepts only EdDSA and the configured issuer, audience, `kid`, and
Ed25519 public key. It rejects missing required claims, expired or future-dated
tickets, a different Host, or a different state.

## Browser Handoff

When a required-mode gateway receives a GET or HEAD without a valid
`lv_site_session`, it sets a host-only, Secure, HttpOnly, SameSite=Lax cookie
named `__Host-lv_site_state`, then redirects to the configured Auth start URL:

```text
https://<auth-origin>/site-access/start
  ?redirect_uri=https%3A%2F%2F<site-host>%2F__lightvela%2Fauth%2Fcallback
  &state=<browser-state>
  &return_to=%2Frequested%2Fpath
```

The Auth integration validates `lc_session`, signs the ticket, and redirects
back to the supplied callback:

```text
https://<site-host>/__lightvela/auth/callback
  ?ticket=<signed-jws>
  &state=<browser-state>
  &return_to=%2Frequested%2Fpath
```

The gateway verifies the ticket and state, sets a host-only, Secure, HttpOnly,
SameSite=Lax `lv_site_session` cookie containing the signed ticket, clears the
state cookie, and redirects to the validated relative `return_to` path. It
never accepts an absolute or cross-origin return URL.

Every later GET or HEAD must carry a valid `lv_site_session` before metadata or
COS lookup. Authenticated responses use `Cache-Control: private, no-store` and
`X-Robots-Tag: noindex, nofollow, noarchive`. Invalid authentication fails
closed with HTTP 403 and never reads COS.

## Key Configuration and Rotation

The gateway receives public keys as non-secret platform configuration:

```text
SITE_GATEWAY_AUTH_PUBLIC_KEYS=<kid>=<base64url-ed25519-public-key>,<kid2>=<base64url-key2>
```

The signing private key stays in the trusted Auth control plane and never enters
Git, frontend assets, SOPS plaintext, or a site container. During rotation,
publish the new public key under a new `kid`, keep the old public key until all
old tickets have expired, then remove it.

## Stateless Boundary

This protocol has no server-side session state. Therefore it intentionally does
not provide strict one-time ticket consumption, an immediate logout revocation,
or a persisted deny-list. The short `exp`, Host binding, state cookie, private
COS bucket, and HttpOnly site cookie limit the exposure window. A future strict
revocation requirement would need a state store keyed by `jti`.

## Environment Policy

```text
*.lightvela.tech -> SITE_GATEWAY_AUTH_MODE=required
*.lightvela.site -> SITE_GATEWAY_AUTH_MODE=public
```

The international site behavior must remain unchanged when its deployment is
public mode.
