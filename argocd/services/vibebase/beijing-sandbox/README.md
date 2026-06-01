# Vibebase Beijing Sandbox

Vibebase is a Redis-backed per-user KV service. It runs in the `ai-gateway` namespace but owns its runtime Secret instead of depending on `ai-gateway-runtime-secrets`.

It is intentionally cluster-private and is exposed only through `service-gateway` at `/v1/vibebase/*`.

API values are text-only in v1: namespace and key must be valid UTF-8 and capped at 128 bytes each; values must be valid UTF-8 and capped at 5000 bytes. Vibebase is not a binary blob store.

Config model:

- Non-sensitive runtime settings live in `vibebase-platform.env` and the rendered `vibebase-config` ConfigMap.
- User isolation relies on the trusted `X-Lightclaw-User-ID` header injected by `service-gateway`; Vibebase does not require a separate internal bearer token.
- The only encrypted runtime dependency is `vibebase-runtime-secrets.REDIS_PASSWORD`.
