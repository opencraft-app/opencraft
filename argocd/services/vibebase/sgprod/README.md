# Vibebase Singapore Production

Vibebase is a Redis-backed per-user KV service. It runs in the `ai-gateway` namespace and is exposed only through `service-gateway` at `/v1/vibebase/*`.

Configuration policy:

- Non-sensitive runtime settings live in `vibebase-platform.env`.
- User isolation relies on the trusted `X-Lightclaw-User-ID` header injected by `service-gateway`; Vibebase does not require a separate internal bearer token.
- The only encrypted runtime dependency is `vibebase-runtime-secrets.REDIS_PASSWORD`.
