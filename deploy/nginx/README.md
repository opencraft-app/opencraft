# managed site ingress access observations

This is the environment-owned Nginx HTTP reverse-proxy configuration for managed site.
The backend and HTTP/WS forwarding behavior remain unchanged. TLS can terminate
at an outer proxy; `scheme` describes this hop, while `forwarded_proto`, `origin`
and `referer_origin` describe observed request headers, without trusting them for
admission or changing the headers sent upstream.

JSON access rows include timestamp, server-generated request ID, peer and bounded
forwarded IP chain, bounded user agent, Fetch Metadata, status and upstream timing.
Origin and Referer retain only scheme/host/port. Request paths exclude query strings.
Cookie, Authorization, bodies, full Referer and URL queries are never logged.
The request ID is returned in `X-managed site-Request-ID` and forwarded as `X-Request-ID`.
Connection/peer/user-agent/time help compare sequences but cannot identify a user
or prove two connections belong to the same device. WebSocket access rows finish
on disconnect: absence of a completed 101 row does not prove upgrade failure.

Deployment: source only from a clean `env/join` commit. Acquire the environment
lock, compare live configuration to the inspected baseline, retain an owned backup,
check standalone candidate syntax, atomically install, run `nginx -t`, then perform
`nginx -s reload` (not restart). Restore the backup and reload if validation fails.
Do not touch application services, TLS, account data or other virtual hosts.
Existing plain-format log rows are retained; consumers must accept mixed historical
text and new JSON. Keep the existing logrotate policy and private log access.
Validate public HTTP and a closed no-fee WS probe, valid JSON/request-ID correlation,
Origin/Referer redaction and absence of a synthetic query secret before handing off.
