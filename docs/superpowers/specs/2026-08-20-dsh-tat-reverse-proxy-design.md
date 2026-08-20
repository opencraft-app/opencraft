# DSH TAT Reverse Proxy Design

## Goal

Extend the existing `site-gateway` process with a Host-based dispatcher. Existing
Pages hosts continue to use the COS static origin, while configured DSH hosts use
`httputil.ReverseProxy` over a Tencent TAT TCP tunnel to
`127.0.0.1:3080` on the selected user instance.

## Scope

This change owns only the reverse-proxy data plane:

- read the standard HTTP `Host` value and the opaque `Key` request header;
- classify the Host as COS, DSH, or unsupported;
- resolve `Key` to Tencent Cloud `region` and `instance_id` through a configured
  internal HTTP endpoint;
- open and multiplex TAT `PtyProxy` TCP streams;
- expose each stream as a Go `net.Conn` to `http.Transport`;
- proxy full HTTP and WebSocket traffic with `httputil.ReverseProxy`.

It does not install DSH, validate users, issue or verify browser credentials,
manage Pass state, modify CTL, or create DNS/TLS/production resources. An
upstream access proxy derives `Key` from the authenticated login state and
injects it into every DSH HTTP/WebSocket request.

## Request Routing

The dispatcher canonicalizes `r.Host` by removing an optional port, converting to
lowercase, and removing a trailing dot. Only an exact configured DSH Host such as
`dsh.lightvela.site` or `dsh.lightvela.tech` goes to the DSH handler. Every other
Host goes to the existing `SiteHandler`, preserving COS wildcard site routing and
custom domains; unsupported Hosts therefore keep the existing 404 behavior.

The DSH branch requires a non-empty `Key` header injected by the upstream access
proxy. The value remains opaque to `site-gateway`; it is passed only to the target
resolver and is removed before the request reaches DSH. Requests with zero or
multiple `Key` header values are rejected. It must never be logged.

## Target Resolution

When DSH proxying is enabled, `SITE_GATEWAY_DSH_TARGET_URL` identifies an internal
HTTP endpoint. `site-gateway` sends:

```http
GET <SITE_GATEWAY_DSH_TARGET_URL>
Key: <opaque request key>
```

The successful response contract is:

```json
{"data":{"region":"ap-guangzhou","instance_id":"lhins-..."}}
```

The resolver validates both fields and never accepts an IP address or port. The
only permitted upstream is `127.0.0.1:3080`.

## TAT Transport

A server-side TAT client uses platform credentials from runtime Secret variables.
For a target it calls `TAT StartSession`, obtains account metadata for
`SessionAuth`, connects to the regional TAT forwarding WebSocket, and sends:

```text
SessionAuth
PtyProxyNew
PtyProxyData
PtyProxyClose
```

One live TAT WebSocket is shared by all proxy streams for the same
`region + instance_id`. Each HTTP transport connection receives its own
`ProxyId`. A reader goroutine demultiplexes BSON frames by `ProxyId`; WebSocket
writes are serialized. A bounded per-connection queue prevents one slow browser
from blocking every stream.

`TatConn` implements `net.Conn`, including read/write deadlines and idempotent
close. The receive path enforces frame, per-connection, per-target, and process
byte limits; exhausting any limit closes the affected stream instead of allowing
an unbounded queue. Closing a TAT session terminates all of its `TatConn` values.
The next request creates a fresh session.

## HTTP Proxy

The DSH handler maintains one `http.Transport` and `httputil.ReverseProxy` per
resolved target. Its `DialContext` ignores the synthetic loopback address and asks
the TAT manager for a new `TatConn`. The proxy rewrites the upstream URL and Host
to `http://127.0.0.1:3080`, rewrites `Origin` only when present, strips `Key`, and
preserves standard forwarding metadata. Go's reverse proxy handles request bodies,
streaming responses, keep-alive, and WebSocket 101 upgrades.

## Configuration Boundary

DSH proxying is disabled when `SITE_GATEWAY_DSH_DOMAINS` is empty. Enabling it
requires:

- `SITE_GATEWAY_DSH_DOMAINS`;
- `SITE_GATEWAY_DSH_TARGET_URL`;
- `TENCENT_SECRET_ID` and `TENCENT_SECRET_KEY` supplied by a runtime Secret.

Enabling also requires an ingress trust boundary outside this service: both DSH
hosts must reach `site-gateway` only through `access_proxy/user-auth`. That proxy
must remove every client-supplied `Key` value and inject exactly one newly derived
value after validating the login state. The existing public Pages Ingress is not
such a trust boundary and must not be used as the direct DSH entry. This routing
and authentication work is intentionally outside this data-plane change, so the
checked-in sgprod DSH values remain empty.

No credential value, target key, TAT session identifier, or browser token is
written to Git or logs. The previously shared temporary credential is not used.

## Errors And Limits

- missing `Key`: 400;
- target not found: 404;
- target service failure: 502;
- TAT session or agent unavailable: 503;
- TAT tunnel timeout: 504;
- per-target connection limit reached: 429;
- unsupported Host remains governed by the existing site handler.

Target transports and sessions have bounded counts and idle expiry. Process
shutdown closes idle HTTP connections and every TAT WebSocket.

## Verification

Tests cover exact Host dispatch, preservation of the existing site handler,
key stripping, target response validation, TAT BSON framing, multiplexed streams,
dynamic deadlines, bounded receive storage, session failure cleanup, HTTP methods
and bodies, WebSocket upgrade, the fixed loopback destination, and configuration
validation. Streaming responses, keep-alive, and upgrade plumbing are delegated
to the standard-library `httputil.ReverseProxy` and `http.Transport`.
