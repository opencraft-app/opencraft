# Single-node Dev Stack

This stack runs a local Lightclaw dev slice on one machine:

- MySQL 8 with separate schemas for auth, payment, subscription, ai-gateway, and sandbox.
- Redis 7.
- `lightclaw-auth`, `payment`, `subscription`, `ai-gateway`, `sandbox-api`, and `service-gateway`.
- `frontend` Vite dev server, pointed at the local `service-gateway`.
- `fake-qq-oauth`, a local QQ OAuth emulator for browser sign-in flows.
- `sandbox-api` uses the mock provider and seeded local capacity. It does not touch real cloud resources.

The stack defaults to `LOCAL_STACK_PLATFORM=linux/arm64` for Apple Silicon
development. Set `LOCAL_STACK_PLATFORM=linux/amd64` explicitly when validating
x86 images; service binaries follow the selected target architecture.

## Start

```bash
docker compose -f deploy/local/docker-compose.yml up --build
```

With local overrides:

```bash
cp deploy/local/.env.example deploy/local/.env
docker compose --env-file deploy/local/.env -f deploy/local/docker-compose.yml up --build
```

## Endpoints

| Service | URL |
| --- | --- |
| frontend | http://localhost:5173 |
| service-gateway | http://localhost:8085 |
| auth | http://localhost:28081 |
| fake QQ OAuth | http://localhost:19010 |
| sandbox-api | http://localhost:18081 |
| payment | http://localhost:18082 |
| subscription | http://localhost:8086 |
| ai-gateway | http://localhost:18080 |
| portkey | http://localhost:8787 |
| MySQL | 127.0.0.1:43306 |
| Redis | 127.0.0.1:36379 |

## Smoke checks

```bash
curl -fsS http://localhost:8085/metrics >/dev/null
curl -fsS http://localhost:5173 >/dev/null
curl -fsS http://localhost:28081/healthz
curl -fsS http://localhost:19010/healthz
curl -fsS http://localhost:18081/health
curl -fsS http://localhost:18082/healthz
curl -fsS http://localhost:8086/healthz
curl -fsS http://localhost:18080/health
```

The sandbox seed creates `openclaw-default`, `sku-local-default`, `pool-local-default`,
and five clean mock instances. A basic sandbox allocation can be tested with:

```bash
curl -fsS -X POST http://localhost:8085/sandboxes \
  -H 'content-type: application/json' \
  -d '{"templateClassID":"openclaw-default","metadata":{"owner":"local"}}'
```

The auth seed creates the same local invite codes used by tests:
`VALID2026`, `EXPIRED2026`, and `USED2026`.

The fake QQ OAuth service lives under `mockservers/qq-oauth`. To exercise a
local QQ sign-in in the browser, open:

```text
http://localhost:8085/auth/oauth/qq/start?return_to=http%3A%2F%2Flocalhost%3A5173%2F
```

The flow redirects through `http://localhost:19010/oauth2.0/authorize`, then
back to `service-gateway`, and finally returns to the frontend with a local
session. Switch the fake account by adding `fake_user=second` to the authorize
URL when manually testing the mock server.

The frontend runs `pnpm dev:global` by default and bakes:

```bash
VITE_AUTH_API_BASE_URL=http://localhost:8085
```

Override the frontend script or port when needed:

```bash
LOCAL_FRONTEND_SCRIPT=dev:cn LOCAL_FRONTEND_PORT=5174 \
  docker compose -f deploy/local/docker-compose.yml up --build frontend
```

## Optional worker

The default stack does not run `sandbox-worker`. To include it:

```bash
docker compose -f deploy/local/docker-compose.yml --profile workers up --build
```

The worker still uses `CLOUD_PROVIDER=mock`.

## Reset

```bash
docker compose -f deploy/local/docker-compose.yml down -v
```

`down -v` removes the local MySQL and Redis volumes.
