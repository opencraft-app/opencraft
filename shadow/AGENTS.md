# AGENTS.md

This project is a Go single-service scaffold for Tencent Cloud shadow-account integration.

## Purpose

The service models the Level2 shadow-account flow for a SaaS product:

- send SMS verify code for registration
- register a Tencent Cloud shadow account
- exchange one-time `auth_code` for SaaS token and temporary credentials
- save basic auth
- create a free-trial order and build payment / console redirects
- call real dianshi / billing endpoints when `SHADOW_BILLING_MODE=http`
- update shadow-account phone numbers with rollback semantics
- expose Tencent Cloud internal callback endpoints for `user_id` and `auth_code` verification

## Current status

- The service is runnable locally.
- The default mode is `fake`, which makes local verification possible without real Tencent Cloud credentials.
- The Tencent Cloud provider is already wired through the internal `tencentcloud-sdk-go`.
- The HTTP billing provider is implemented and can call real dianshi / billing endpoints.
- Storage is pluggable at the interface level. The built-in implementation is `sqlite`.

## Important files

- `cmd/shadowd/main.go`: process entrypoint
- `internal/app`: dependency wiring
- `internal/platform`: Tencent Cloud `account` / `cam` / `sts` adapters
- `internal/shadow`: core registration, token, redirect, callback orchestration
- `internal/httpapi`: external APIs and internal callback handlers
- `internal/billing`: billing abstraction, fake implementation, and real HTTP adapter
- `internal/mockcloud`: mock official backend used in black-box e2e tests
- `internal/storage`: storage contract and shared records
- `internal/storage/sqlite`: SQLite-backed persistent store
- `ARCHITECTURE.md`: architecture design
- `README.md`: runbook and verification steps

## How to run

Default local mode:

```bash
cd /Users/skipzhang/code/shadow
make build
./bin/shadowd
```

Run tests:

```bash
cd /Users/skipzhang/code/shadow
go test ./...
```

## Environment

See `.env.example` for the supported environment variables.

Key variables:

- `SHADOW_STORAGE_DRIVER=sqlite`
- `SHADOW_STORAGE_DSN`
- `SHADOW_PROVIDER=fake|tencent`
- `SHADOW_PROVIDER=fake|mock|tencent`
- `SHADOW_BILLING_MODE=fake|http`
- `SHADOW_PLATFORM`
- `SHADOW_SECRET_ID`
- `SHADOW_SECRET_KEY`
- `SHADOW_ACCOUNT_ENDPOINT`
- `SHADOW_CAM_ENDPOINT`
- `SHADOW_STS_ENDPOINT`
- `SHADOW_BILLING_ENDPOINT`
- `SHADOW_DIANSHI_ENDPOINT`
- `SHADOW_BILLING_RECOVERY_ENDPOINT`
- `SHADOW_FREE_TRIAL_ACTIVITY_ID`
- `SHADOW_FREE_TRIAL_ACT_ID`
- `SHADOW_CALLBACK_TOKEN`

Tencent Cloud test endpoints are not baked into config defaults.
Use `scripts/start-tencent-test.sh` or set the endpoint env vars explicitly.
The startup script runs `make build` and launches `./bin/shadowd`.

Deployment build:

```bash
cd /Users/skipzhang/code/shadow
make build-linux-amd64
```

## Internal SDK note

The internal Tencent Cloud Go SDK depends on a Polaris module that is not available in this environment.  
To keep the project buildable, a local stub module is provided under `third_party/polaris-go-v2`, and `go.mod` replaces the original dependency with that local stub.

Do not remove that replace rule unless the real internal Polaris dependency is available in the build environment.

## When extending this project

- Keep the public HTTP contract aligned with the Tencent Cloud shadow-account callback protocol.
- Prefer implementing new Tencent Cloud integrations behind `internal/platform` interfaces.
- Keep real billing behavior behind `internal/billing.Provider`.
- Keep storage implementations behind `internal/storage.Store` so the business layer does not depend on a specific database.
