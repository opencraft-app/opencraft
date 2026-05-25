# Vibebase Shanghai Production

Vibebase is a Redis-backed per-user KV service. It runs in the `ai-gateway` namespace and is exposed only through `service-gateway` at `/v1/vibebase/*`.

Configuration policy:

- Non-sensitive runtime settings live in `vibebase-platform.env`.
- `VIBEBASE_INTERNAL_SERVICE_TOKEN` is plaintext platform config and must match the corresponding `SERVICE_GATEWAY_VIBEBASE_INTERNAL_TOKEN`.
- The only encrypted runtime dependency is `vibebase-runtime-secrets.REDIS_PASSWORD`.
