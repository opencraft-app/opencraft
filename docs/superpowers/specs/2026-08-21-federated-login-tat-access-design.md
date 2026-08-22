# Federated Login and TAT Access Design

## Status

Implemented on 2026-08-21 and disabled by default. Production enablement still
requires environment secrets and the reset/TAT invalidation probe described
below.

The visual design is frozen in the reviewed prototype. This document defines
the production behavior and trust boundaries. The first implementation keeps
the login handoff stateless: it adds no federation ticket table and no Redis
dependency.

## Goal

A first-party independent site must be able to:

1. send an unauthenticated browser to the LightVela main site;
2. let the user log in or confirm the currently logged-in account;
3. receive a delegated login state without learning its contents;
4. ask LightVela for a fresh Tencent TAT WebSocket bootstrap whenever it opens
   a new proxied connection for one of the user's Bots.

LightVela remains the authority for user identity and Bot ownership. The
independent site is a reverse proxy: its browser talks to the independent site,
and the independent-site backend uses Tencent TAT WebSocket as its upstream
transport.

## Non-goals

This slice does not:

- implement the independent-site service;
- share the main-site `lc_session` cookie across domains;
- expose Tencent Cloud AK/SK or a reusable physical instance credential;
- let the independent site select a physical `instance_id` or `sandbox_id`;
- add a federation ticket table, Redis replay cache, or one-time-code cleanup
  worker;
- redesign the existing domestic or international login controls;
- remove the whole `sandbox-legacy` route; this slice only narrows it so the
  sandbox-id TAT subpath is no longer reachable from the public ingress.

## Confirmed Product Decisions

### Authorization page

The main frontend owns a dedicated route:

```text
/auth/federation/authorize
```

The page always renders. An already authenticated user is not redirected
silently.

- Signed out: open the existing `LoginModal`.
- Signed in: display the reviewed account-confirmation dialog.
- `继续`: issue the five-second handoff ticket and redirect to the independent
  site.
- `切换其他账号`: enter `LoginModal` in switch-account mode.
- `返回使用当前账号`: leave switch-account mode without deleting the current
  session.
- Dialog close: cancel authorization and return to the validated callback with
  `error=access_denied`.

The confirmation dialog reuses the existing dialog dimensions, close control,
button component, avatar rendering, fonts, motion, and accessibility behavior.
It must not copy provider controls or brand icons.

`LoginModal` continues to own regional behavior:

- international: Google and GitHub plus international legal links;
- China: WeChat, phone, and QQ plus China legal links.

The region comes from the deployed main site (`isGlobal` and locale), never
from an independent-site query parameter.

Switch-account is a distinct signed OAuth intent. Cancelling preserves the
current source session. A successful switch creates the new session and deletes
the previously current source session before returning to confirmation. That
also invalidates delegated sessions derived from the old account without a new
federation revocation table. The callback must never interpret switch-account
as "bind this provider to the current user".

### Callback allowlist

The client registry is the source of truth for callbacks. The first approved
client accepts HTTPS callbacks on these two independently valid domains:

```text
lightvela.site
*.lightvela.site
lightvela.tech
*.lightvela.tech
```

The callback path is fixed:

```text
/auth/lightvela/callback
```

Validation must reject:

- non-HTTPS schemes;
- userinfo;
- fragments;
- non-default ports;
- suffix lookalikes such as `evillightvela.site`,
  `lightvela.tech.evil.com`, or `lightvela.tech-attacker.com`;
- any path other than the fixed callback path.

These domains are intentionally separate from the broader OAuth `return_to`
allowlist and do not need to appear in that legacy default list. Deployment
must verify DNS/ingress ownership before enabling the client.

The exact normalized callback URI is bound into the handoff ticket. Local
development callbacks are separate explicit origins and are never implied by
the production suffix rules.

## Trust Model

There are three independent proofs:

1. Main-site session: who the user currently is.
2. Independent-site service signature: which backend is making the request.
3. Current Bot ownership: whether that user owns that Bot at connection time.

No one proof substitutes for another.

The independent site treats all LightVela tokens as opaque strings. It never
parses claims and never receives a LightVela signing or encryption key.

## Stateless Token Model

### Why authenticated encryption is required

The current Auth model has no separate public `session_id`. The random
`auth_sessions.token` is both the lookup key and the full bearer credential.
Putting it inside a signed-but-readable JWT/HMAC payload would leak the main
session to the browser and independent site.

Federation tokens therefore use authenticated encryption (AEAD), not a
readable signed payload. A dedicated keyring is used only for federation. Keys
are selected by `kid`; newly issued tokens use the active key and verification
accepts previous keys until their maximum token lifetime has elapsed.

### Handoff ticket

The authorization page receives a ticket with a five-second lifetime, counted
from the moment the user clicks `继续`.

Encrypted contents:

```text
version
kid
scope = federation:handoff
source_session_token
user_id
client_id
normalized_redirect_uri
issued_at
expires_at = issued_at + 5 seconds
random_nonce
```

Associated data binds the token type and deployment environment so a token
cannot be replayed as another token class or in another environment.

This design is deliberately stateless. It cannot prove strict single use.
Replay during the five-second window is an explicit product risk acceptance
because exchange also requires the independent site's HMAC credential.
Expired tickets fail closed.

### Delegated session

The independent-site backend exchanges a valid handoff ticket for an opaque
delegated session. The backend sets that value in its own Secure, HttpOnly,
SameSite=Lax cookie.

Encrypted contents:

```text
version
kid
scope = federation:session
source_session_token
user_id
client_id
issued_at
expires_at = min(source session expiry, configured delegated-session maximum)
```

On every TAT connection request, `user/auth` decrypts the delegated session and
calls the existing `CurrentSession` with the recovered source token. Main-site
logout, expiry, or deletion therefore invalidates the independent-site login
on its next connection attempt without a new federation database.

Impersonation sessions must not issue federation tickets.

Exchange is deterministic for a given handoff ticket and client. Replaying the
same ticket during its five-second lifetime returns the same delegated-session
value and expiry rather than minting independent sessions. The implementation
uses a token-specific nonce derived with a separate nonce-derivation key from
the unique handoff ciphertext; it must never reuse the handoff AEAD key or a
nonce across different handoff ciphertexts.

## Independent-site Service Authentication

Each client has a separate HMAC secret and key ID. The first configured client
is `personal-site`; the model remains a registry so another first-party site
does not share its secret.

Requests carry:

```text
X-LightVela-Client-Id
X-LightVela-Key-Id
X-LightVela-Timestamp
X-LightVela-Request-Id
X-LightVela-Signature
```

The canonical string contains:

```text
client_id
key_id
HTTP method
normalized path
canonical query
timestamp
request_id
SHA256(body)
```

The server uses HMAC-SHA256 and constant-time comparison. It rejects unknown
clients/keys, mismatched callback ownership, stale timestamps, malformed
request IDs, and signatures that do not cover the exact body.

No replay database is introduced. The request ID is signed and logged for
correlation; the five-second handoff ticket and deterministic exchange bound
the accepted replay behavior. TAT session creation is allowed to repeat because
every new proxied connection must receive a fresh TAT bootstrap.

## Public Ingress

`service-gateway` does not verify the federation HMAC. It exposes only the exact
federation API paths to `user/auth` as public application-authenticated paths;
`user/auth` performs the client HMAC and token checks before any business call.

The existing `/auth` route receives an explicit `public_allow` extension for:

```text
GET  /auth/federation/context
POST /auth/federation/tickets
POST /auth/federation/exchange
POST /auth/federation/bots/{bot_id}/tat/session
```

All other `/auth` behavior remains unchanged. Gateway configuration-policy
tests must require these exact method/path pairs and reject broader
`/auth/federation` prefix exposure.

## HTTP Contracts

### Read authorization context

```text
GET /auth/federation/context?client_id=...&redirect_uri=...&state=...
```

Session authentication is optional. The response contains only validated
client display information, normalized callback information, and the current
session summary when present. It never returns the main session token.

### Issue handoff ticket

```text
POST /auth/federation/tickets
```

Requires the current main-site session. Body:

```json
{
  "client_id": "personal-site",
  "redirect_uri": "https://example.lightvela.site/auth/lightvela/callback",
  "state": "opaque-client-state"
}
```

The server validates the client and callback again, issues the five-second
ticket, and returns the complete validated redirect URL. The frontend navigates
to that URL; it never constructs an arbitrary redirect itself.

### Exchange handoff ticket

```text
POST /auth/federation/exchange
```

Requires independent-site HMAC headers. Body:

```json
{
  "ticket": "opaque",
  "redirect_uri": "https://example.lightvela.site/auth/lightvela/callback"
}
```

The server decrypts the ticket, verifies the source main session, client, exact
callback, scope, and expiry, then returns:

```json
{
  "delegated_session": "opaque",
  "expires_at": "RFC3339"
}
```

### Create a TAT transport

```text
POST /auth/federation/bots/{bot_id}/tat/session
```

Requires independent-site HMAC headers and the delegated session. The service:

1. decrypts the delegated session;
2. verifies its current source main session;
3. derives `user_id` only from the verified session;
4. calls a thin CTL internal route with the verified user ID and a shared
   internal-service bearer; the source main-session token never leaves Auth;
5. returns a sanitized TAT bootstrap to the independent-site backend.

The request cannot contain `user_id`, `sandbox_id`, physical `instance_id`,
Tencent UIN, or AppID overrides.

Ownership failures return 404 to avoid revealing whether another user's Bot
exists. Authentication and client-signature failures return 401. Invalid or
stopped Bot states return 409. Upstream timeout returns 504.

## CTL and Sandbox Flow

There is one TAT ownership authority and one business operation:

```text
POST /v1/instances/{bot_id}/tat/session
  -> ctl.logic.StartTerminalSession
  -> sandbox /sandboxes/{sandbox_id}/tat/session
```

Federation adds only a thin internal transport route:

```text
POST /internal/bots/{bot_id}/tat/session
```

It requires the shared internal-service bearer and trusted `X-User-Id`, then
calls the existing `ctl.logic.StartTerminalSession`. It does not duplicate
ownership, entitlement, state, or sandbox selection logic. `user/auth` never
forwards the recovered source main-session token outside Auth.

CTL forwards the same internal-service bearer and verified user header to
sandbox for the TAT operation. Sandbox accepts that identity only when the
internal bearer matches its configured secret; ordinary browser TAT calls
continue through session introspection.

The existing CTL operation must be tightened to:

1. load the Bot through the existing user-scoped DAO;
2. require a connectable running state and active entitlement;
3. capture the current `sandbox_id`;
4. call sandbox's existing TAT session operation;
5. reload the Bot and reject the response if ownership, status, or `sandbox_id`
   changed while the upstream call was in flight;
6. return only the fields needed by the reverse proxy.

Sandbox must check both before and after `StartSession`:

- sandbox mapping still exists;
- the physical instance is still `ALLOCATED`;
- the mapping still points to the same pool instance and cloud ID.

The complete ownership-check and TAT-bootstrap operation has a five-second
deadline. A response that arrives after the deadline or after the post-check is
discarded.

The accepted deployment invariant is:

- every reusable CVM passes through reset before it can return to `CLEAN`;
- reset takes longer than the five-second connection window;
- reset invalidates previous TAT sessions and connections;
- no allocation path bypasses reset.

This slice relies on that invariant instead of adding allocation epoch or
connection-lease storage. Tests must prove the late-result rejection behavior;
the reset/TAT invalidation invariant requires an environment-level integration
test before production enablement.

The absence of persisted epoch/lease is an explicit product risk acceptance
for this slice. Enabling the client is blocked unless the environment probe
demonstrates that reset exceeds the connection deadline and invalidates old TAT
sessions/connections.

## Existing Legacy Route

Current master and GitOps still contain an authenticated prefix route:

```text
POST /sandboxes/{sandbox_id}/tat/session
```

The product frontend no longer uses it, but service-gateway still matches and
forwards it. Before federation can be enabled, each target environment must add
an exact `path_policy: allowlist` to `sandbox-legacy` that excludes
`/sandboxes/{sandbox_id}/tat/session`. The root `POST /sandboxes` route may
remain temporarily if caller inventory shows it is needed. The gateway already
has a dedicated Bot-scoped TAT allowlist entry, so federation and the frontend
continue through CTL.

## Configuration

The feature is disabled unless all required values are present.

Required configuration groups:

- federation enabled flag;
- active AEAD key ID and keyring;
- client registry with client ID, display name, HMAC key IDs, callback suffixes,
  and callback path;
- CTL internal base URL and shared internal-service token;
- five-second handoff and TAT operation deadlines;
- delegated-session maximum lifetime.

Secrets remain in the existing environment-specific secret pipeline. No secret
value or generated credential is committed to Git.

The CTL dependency uses an internal cluster base URL. Auth, CTL, and sandbox
receive the same internal-service token through their existing secret
pipelines. The token is never committed or returned to the independent site.

## Implementation Surfaces

### `user/auth`

- extend `api/openapi.yaml` with the four federation contracts and regenerate
  `internal/api/server.gen.go`;
- add a focused federation package for AEAD tokens, client registry, callback
  validation, deterministic exchange, and HMAC verification;
- wire configuration in `cmd/lightclaw-auth/main.go` and
  `internal/httpapi/server.go`;
- add an internal HTTP adapter to CTL's thin internal Bot-scoped TAT route;
- extend OAuth state/callback handling with a signed `switch_account` intent
  that deletes the old session only after the new session succeeds.

### `frontend`

- add the `/auth/federation/authorize` route and repository methods;
- reuse `LoginModal`, extracting only a shared dialog frame/provider body when
  necessary rather than copying controls;
- add switch-account mode without changing ordinary login behavior;
- use the existing public-site header/assets, `Button`, avatar fallback, i18n,
  and region selection.

### `ctl` and `sandbox`

- keep the existing public Bot-scoped route and `StartTerminalSession` logic;
- add the authenticated internal transport route that restores a trusted user
  context and invokes the same logic;
- add connectable-state and pre/post mapping checks to that existing flow;
- enforce the five-second context deadline and discard late results;
- make sandbox reject non-`ALLOCATED` mappings before and after StartSession;
- allow CTL's shared internal-service bearer plus trusted user header for this
  TAT operation without accepting it from the public ingress;
- do not change the public response shape used by the current frontend except
  through backward-compatible omission of unnecessary sensitive fields.

### `service-gateway` and GitOps

- exact-allow the four federation Auth paths;
- narrow `sandbox-legacy` with a path allowlist that excludes TAT session
  creation;
- update config-policy tests for every environment;
- render disabled-by-default federation configuration in source overlays;
- enable a concrete client only after its AEAD/HMAC secrets and production
  reset probe are present.

## Audit and Observability

Every exchange and TAT request records:

- request ID;
- client ID and key ID;
- user ID after successful session verification;
- Bot ID for TAT requests;
- normalized callback origin for exchange;
- result code and latency;
- CTL/sandbox upstream request IDs.

Tokens, source session tokens, HMAC signatures, callback query contents, TAT
session IDs, UINs, and WebSocket URLs are never logged.

Metrics distinguish validation, source-session, ownership, state, timeout, and
upstream failures without using user IDs or Bot IDs as labels.

## Testing

### Token and service authentication

- AEAD round trip for each token class;
- wrong key, key ID, environment, scope, audience, callback, and ciphertext;
- exact five-second expiry boundary;
- source-session logout and expiry invalidate delegated sessions;
- impersonation session rejection;
- key rotation overlap;
- canonical HMAC vectors and body tampering;
- callback suffix confusion and URL normalization attacks.

### CTL and sandbox

- another user's Bot returns 404;
- stopped/deleting/missing-sandbox Bot cannot create TAT sessions;
- sandbox rejects non-`ALLOCATED` instances;
- Bot or sandbox mapping changes while `StartSession` is blocked;
- late results are discarded after five seconds;
- response does not expose fields outside the approved bootstrap contract.

### Frontend

- signed-out page opens the existing regional `LoginModal`;
- domestic and international provider controls remain unchanged;
- signed-in confirmation uses the current user and avatar;
- switch-account and return-to-current-account are reversible;
- successful login returns to confirmation instead of navigating home;
- close returns `access_denied` only to a validated callback;
- Continue uses only the server-provided redirect URL;
- responsive and keyboard/focus behavior matches existing dialogs.

### Production gate

Before enabling a client in production, run an environment probe that proves:

1. a TAT WebSocket established for allocation A is terminated by reset;
2. an unconsumed A TAT session cannot connect after B receives the same CVM;
3. no CVM reaches `CLEAN` without the reset and TAT readiness barrier.
