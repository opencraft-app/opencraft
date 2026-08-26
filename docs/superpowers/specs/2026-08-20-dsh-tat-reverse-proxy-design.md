# DSH Federation TAT Reverse Proxy Design

## Goal

Expose each DeepSeek Harness WebUI at:

```text
<bot_id>-dsh.lightvela.site
<bot_id>-dsh.lightvela.tech
```

The browser-facing authentication and delegated login state are owned by the
shared LightVela federation capability. `site-gateway` owns only Host routing,
the authenticated federation-to-TAT adapter, and the HTTP/WebSocket reverse
proxy to `127.0.0.1:3080`.

The first production release enables only `.site`. `.tech` remains disabled
until a domestic `site-gateway` deployment exists.

## Request Flow

```text
browser
  -> <bot_id>-dsh.lightvela.site
  -> site-gateway DSH handler
  -> no delegated Cookie: federation authorize/ticket/exchange callback
  -> host-only delegated-session Cookie
  -> Auth POST /auth/federation/bots/<bot_id>/tat/session
  -> Auth validates delegated session and current source login
  -> Auth/CTL validates current Bot ownership and creates TAT session
  -> site-gateway TAT WebSocket
  -> PtyProxyNew 127.0.0.1:3080
  -> httputil.ReverseProxy returns the DSH HTTP/WebSocket WebUI
```

`site-gateway` derives the Bot ID from the Host and reads the opaque delegated
session from its own Host-only, Secure, HttpOnly Cookie. Browser-supplied legacy
`X-LightVela-DSH-*` headers are ignored and stripped before proxying.

## Host And Bot Binding

The DSH route is derived from the standard Go `r.Host` value. A configured
domain such as `dsh.lightvela.site` accepts only a single-label prefix:

```text
<bot_id>-dsh.lightvela.site
```

The Bot route ID is the literal Bot ID. It is not encrypted or hashed. It must:

- contain only lowercase ASCII letters, digits, and `-`;
- start and end with a letter or digit;
- be at most 59 bytes so `<bot_id>-dsh` stays within the 63-byte DNS label limit.

The login state is cryptographically bound to the exact DSH Host. Auth validates
the delegated session and Bot ownership before returning a TAT session, so a
session cannot select an arbitrary instance from browser input.

## Federation Contract

`site-gateway` treats the delegated session as opaque. For every new TAT session
it calls:

```http
POST /auth/federation/bots/<bot_id>/tat/session
Content-Type: application/json
X-LightVela-Client-Id: <client id>
X-LightVela-Key-Id: <key id>
X-LightVela-Timestamp: <RFC3339 UTC>
X-LightVela-Request-Id: <unique request id>
X-LightVela-Signature: <HMAC-SHA256 signature>

{"delegated_session":"<opaque value>"}
```

The HMAC canonical form and response fields follow the shared Auth federation
implementation. The adapter validates the returned `region`, `instanceId`,
`ownerUin`, `appId`, and WebSocket URL. The WebSocket URL must be exactly
`wss://<region>.forward.tat-tc.tencent.cn/ws` without userinfo, query, or
fragment.

The current pushed federation implementation is a temporary contract baseline.
When skip's latest branch is pushed, integration must compare endpoint paths,
signature headers/canonicalization, delegated-session exchange, callback rules,
response fields, and error codes before enabling DSH.

## Authentication Boundary

`site-gateway` does not validate the LightVela user itself. It performs the
federation authorize/ticket/exchange redirect flow, then treats the resulting
delegated session as opaque. It does not hold Tencent Cloud credentials or the
CTL internal service token.

Auth remains authoritative for:

- current user login validity;
- delegated-session validity and expiry;
- Bot ownership at connection time;
- CTL/TAT authorization.

The DSH domain must remain disabled until the federation authorize page,
callback allowlist, and shared client credentials are deployed. Direct public
traffic without a delegated session starts the federation login flow.

## TAT Transport

One TAT WebSocket is shared per opaque `Bot ID + delegated session` target.
Each HTTP transport connection receives an independent `ProxyId`. BSON writes
are serialized and reads are demultiplexed by `ProxyId`.

The manager enforces bounded targets, connections, queue depth, frame size, and
buffered bytes. Closing or evicting a proxy target also closes its TAT session.
Pending session creation is cancelable and cannot escape the cache after target
eviction.

## Reverse Proxy

Each target owns one `http.Transport` and `httputil.ReverseProxy`. Its
`DialContext` returns a TAT-backed `net.Conn`; the only destination is fixed at
`127.0.0.1:3080`.

The reverse proxy supports ordinary HTTP methods, request bodies, streaming,
keep-alive, and WebSocket upgrade. It rewrites upstream Host and Origin to the
loopback DSH address, preserves validated forwarded protocol metadata, and
strips the gateway federation Cookie and legacy context headers while preserving
DSH's own application Cookies and Authorization header.

## Configuration And Rollout

DSH is disabled when `SITE_GATEWAY_DSH_DOMAINS` is empty. Enabling it requires:

- `SITE_GATEWAY_DSH_DOMAINS=dsh.lightvela.site`;
- Auth federation base URL;
- federation client ID and key ID;
- federation HMAC key from a Secret;
- verified wildcard DNS, Ingress, and TLS coverage for `*.lightvela.site`.

Checked-in production configuration remains disabled until skip's federation
contract is available and both services hold matching secret material. Rollback
is clearing `SITE_GATEWAY_DSH_DOMAINS`; this leaves existing cloud-site COS and
OIDC behavior unchanged.

## Verification

Before release, tests must cover Host parsing and Bot binding, header stripping,
HMAC request construction, Auth error mapping, bootstrap validation, TAT BSON
multiplexing, resource limits, HTTP/WebSocket proxying, session eviction, and
cloud-site routing regression. Final acceptance requires a real delegated login,
a real owned Bot, a real TAT-connected CVM running DSH on port 3080, HTTPS asset
loading, WebSocket traffic, logout/expiry behavior, and rollback verification.
