# Credit Auth Code Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Pass-compatible one-time `auth_code` to Credit package checkout so the payment bridge can anonymously fetch an existing order's payment URL.

**Architecture:** Credit owns an injected Redis-backed auth-code store with a ten-minute TTL and atomic Lua consumption. The authenticated order endpoint issues a ticket bound to `user_id + deal_name`; the payment URL endpoint prefers gateway identity and consumes a ticket only when no trusted identity header exists. Service Gateway anonymously permits only the exact payment URL route.

**Tech Stack:** Go 1.25, `go-redis/v9`, UUID v4, miniredis, net/http, Kustomize, SOPS/SSM, Service Gateway YAML policies.

## Global Constraints

- Keep Credit independently deployable; do not import `ctl/pkg/authcode`.
- Ticket Redis keys use `credit:auth_code:` and expire after 10 minutes by default.
- Consumption must be atomic `GET + DEL`; a mismatch consumes the ticket.
- Trusted `X-User-Id` takes precedence and must not consume a supplied ticket.
- Trade remains the authority for order ownership and `credit_package` resource type; its 404 behavior must remain unchanged.
- Redis issuance failure must not turn an already-created Trade order into a failed API response.
- Only `POST /v1/credit/packages/order-url` receives optional gateway authentication.
- Credit workers must not require Redis to start.
- Do not commit or push until the user reviews the exact diff and confirms.

---

### Task 1: Redis Auth Code Store

**Files:**
- Create: `credit/internal/authcode/store.go`
- Create: `credit/internal/authcode/store_test.go`
- Modify: `credit/go.mod`
- Modify: `credit/go.sum`

**Interfaces:**
- Produces: `authcode.Ticket`, `authcode.Store`, `authcode.New(*redis.Client, time.Duration) Store`, `authcode.ErrTicketNotFound`, and `authcode.DefaultTTL`.
- Ticket fields: `UserID string`, `DealName string`, `IssuedAt int64`.

- [x] **Step 1: Write failing store tests**

Cover a successful issue/consume round trip, UUID shape, default TTL, expiry,
empty/unknown code, invalid ticket input, and a second consume returning
`ErrTicketNotFound`.

- [x] **Step 2: Verify RED**

Run:

```bash
cd credit && go test ./internal/authcode
```

Expected: FAIL because `internal/authcode` does not exist.

- [x] **Step 3: Implement the minimal Redis store**

Use this contract:

```go
type Ticket struct {
    UserID   string `json:"user_id"`
    DealName string `json:"deal_name"`
    IssuedAt int64  `json:"issued_at"`
}

type Store interface {
    Issue(context.Context, *Ticket) (string, error)
    Consume(context.Context, string) (*Ticket, error)
}
```

Generate UUID v4 codes, store JSON at `credit:auth_code:<uuid>`, and consume
with a Redis Lua script performing `GET` and `DEL` in one operation.

- [x] **Step 4: Verify GREEN**

Run `cd credit && go test ./internal/authcode` and expect PASS.

### Task 2: Auth Code Redis Configuration

**Files:**
- Modify: `credit/internal/config/config.go`
- Modify: `credit/internal/config/config_test.go`

**Interfaces:**
- Produces config fields `RedisAddr`, `RedisPassword`, `RedisDB`, and `AuthCodeTTL`.
- Produces `Config.ValidateAuthCode() error`; only the API bootstrap will call it.

- [x] **Step 1: Write failing configuration tests**

Assert `CREDIT_REDIS_DB` parses as a non-negative integer,
`CREDIT_AUTH_CODE_TTL` defaults to `10m` and accepts positive Go durations,
invalid values fail, and `ValidateAuthCode` requires only a non-empty address.

- [x] **Step 2: Verify RED**

Run:

```bash
cd credit && go test ./internal/config
```

Expected: FAIL because the Redis fields and validation do not exist.

- [x] **Step 3: Implement parsing and validation**

Read `CREDIT_REDIS_ADDR`, `CREDIT_REDIS_PASSWORD`, `CREDIT_REDIS_DB`, and
`CREDIT_AUTH_CODE_TTL`. Keep Redis optional in `Load` so worker commands can
reuse the same parser; expose a separate API-only address validator.

- [x] **Step 4: Verify GREEN**

Run `cd credit && go test ./internal/config` and expect PASS.

### Task 3: Issue Auth Code With Credit Orders

**Files:**
- Modify: `credit/internal/tradeclient/client.go`
- Modify: `credit/internal/tradeclient/client_test.go`
- Modify: `credit/internal/httpapi/server.go`
- Modify: `credit/internal/httpapi/server_test.go`
- Modify: `credit/cmd/credit/main.go`

**Interfaces:**
- Produces `tradeclient.OrderResult` with `BigOrderID` and `DealName`.
- Changes `tradeService.PlaceOrder` to return `*tradeclient.OrderResult`.
- Changes `httpapi.NewRouter` to receive an `authcode.Store` dependency.
- Order response contains `bigOrderId`, `dealName`, and `auth_code`.

- [x] **Step 1: Write failing order tests**

Assert a successful order issues a ticket containing the trusted header user
and returned deal, and includes the code in the response. Assert issue failure
returns HTTP 200 with an empty `auth_code`. Assert an empty upstream deal is a
gateway error and does not issue a ticket.

- [x] **Step 2: Verify RED**

Run:

```bash
cd credit && go test ./internal/httpapi ./internal/tradeclient
```

Expected: FAIL because order responses do not issue tickets.

- [x] **Step 3: Implement typed order response and issuance**

Decode Trade's order response into a typed result. After validating a
non-empty deal, issue with a two-second context. Log issuance errors without
returning them to the client, and always serialize `auth_code` in the Credit
order response. In `cmd/credit`, validate the Redis address, construct and
ping a `go-redis` client with a bounded startup context, defer `Close`, and
inject `authcode.New(client, cfg.AuthCodeTTL)` into the router.

- [x] **Step 4: Verify GREEN**

Run `cd credit && go test ./internal/httpapi ./internal/tradeclient` and expect PASS.

### Task 4: Anonymous Payment URL Authentication

**Files:**
- Modify: `credit/internal/httpapi/server.go`
- Modify: `credit/internal/httpapi/server_test.go`

**Interfaces:**
- Adds `AuthCode string \`json:"auth_code,omitempty"\`` to `userOrderURLRequest`.
- Adds a focused identity resolver accepting the request, ticket code, and deal.

- [x] **Step 1: Write failing authentication tests**

Cover authenticated precedence without ticket consumption, anonymous matching
ticket success, missing credentials, ticket not found, repeated use, deal
mismatch, store infrastructure failure, and preservation of Trade 404 after a
valid ticket resolves the user.

- [x] **Step 2: Verify RED**

Run `cd credit && go test ./internal/httpapi` and expect failures showing that
anonymous requests are still rejected before ticket consumption.

- [x] **Step 3: Implement dual-mode authentication**

Decode the body first. Resolve the trusted header before inspecting the code.
When anonymous, consume once and compare the ticket deal exactly. Map missing
or invalid credentials to 401, mismatch to 403, and Redis infrastructure
failure to a generic 500. Continue using the resolved user in the existing
Trade request.

- [x] **Step 4: Verify GREEN**

Run `cd credit && go test ./internal/httpapi` and expect PASS.

### Task 5: Gateway Policy And Redis Runtime Wiring

**Files:**
- Create: `argocd/services/credit/sandbox-bj-7/patch-credit-redis.yaml`
- Modify: `argocd/services/credit/sandbox-bj-7/kustomization.yaml`
- Create: `argocd/services/credit/beijing-sandbox/patch-credit-redis.yaml`
- Modify: `argocd/services/credit/beijing-sandbox/kustomization.yaml`
- Modify: `scripts/ssm_manifest.credit.beijing-sandbox.yaml`
- Modify: `argocd/secrets/beijing-sandbox/credit-runtime-secrets.sops.yaml`
- Modify: `argocd/services/service-gateway/sandbox-bj-7/config.yaml`
- Modify: `argocd/services/service-gateway/beijing-sandbox/config.yaml`
- Modify: `service-gateway/internal/gateway/config_policy_test.go`

**Interfaces:**
- Environment-specific API Deployment patches provide the Redis address,
  database index, and auth-code TTL without changing the shared Credit base.
- API Deployment receives the password; worker Deployments do not need it.
- Gateway optional-auth list contains exactly the Credit payment URL route.

- [x] **Step 1: Write failing policy assertions**

Extend the Credit deploy-config test to require exactly one optional-auth
entry: `POST /v1/credit/packages/order-url`, while retaining authenticated
session access and the existing path allowlist.

- [x] **Step 2: Verify RED**

Run:

```bash
cd service-gateway && go test ./internal/gateway -run Credit
```

Expected: FAIL because Credit has no optional-auth policy.

- [x] **Step 3: Add gateway and Redis manifests**

Add `auth_strategy: session` where missing and the exact optional-auth rule in
both environments. Beijing 7 points to its namespace Redis and reads the
password from `playground-runtime-secrets`. Beijing sandbox points to its
environment Redis and obtains `CREDIT_REDIS_PASSWORD` from Credit's SSM-backed
runtime Secret. Do not write plaintext credentials to the repository.

- [x] **Step 4: Regenerate and scan the Beijing sandbox secret**

Update the SSM source first, export with:

```bash
python3 scripts/export_ssm_to_sops.py \
  --manifest scripts/ssm_manifest.credit.beijing-sandbox.yaml \
  --only credit-runtime-secrets
python3 scripts/scan_secrets.py \
  argocd/secrets/beijing-sandbox/credit-runtime-secrets.sops.yaml
```

Expected: encrypted `CREDIT_REDIS_PASSWORD` present and secret scan PASS.

- [x] **Step 5: Verify GREEN and rendered manifests**

Run the Credit policy test and render both Credit and Service Gateway
Kustomize overlays. Assert the Credit API has all Redis variables and no
plaintext password appears.

### Task 6: Documentation

**Files:**
- Modify: `credit/AGENTS.md`
- Modify: `docs/frontend-credit-package-integration.md`
- Modify: `docs/engineering/journeys/subscription-purchase-renewal.md`
- Modify: `docs/superpowers/plans/2026-09-10-credit-checkout-integration.md`

**Interfaces:**
- Frontend docs show how to pass `auth_code` from order to the bridge page and
  then to `order-url` without a session.

- [x] **Step 1: Update contracts and examples**

Document the new order response, anonymous request example, one-time/ten-minute
behavior, authenticated fallback, error handling, Redis ownership, and exact
gateway exception.

- [x] **Step 2: Run documentation impact validation**

Run:

```bash
python3 .agents/context/scripts/validate_change_impact.py --repo . --base-ref origin/master
```

Expected: `docs-impact: passed`.

### Task 7: Full Verification And Beijing 7 Rollout

**Files:**
- Verify all modified files.

- [x] **Step 1: Run local verification**

```bash
cd credit && go test ./...
cd service-gateway && go test ./internal/gateway
cd trade && go test ./... && go vet ./...
git diff --check
pre-commit run scan-secrets --from-ref origin/master --to-ref HEAD
```

Expected: every command exits 0.

- [ ] **Step 2: Present the Beijing 7 commit and push diff**

Show the exact changed files, commit message, target
`playground/sandbox-bj-7`, and expected CI paths. Wait for explicit user
confirmation before commit or push.

- [ ] **Step 3: Build and deploy Beijing 7**

After confirmation, push the Beijing 7 commit, wait for Credit and Service
Gateway CI, verify GitOps convergence, and confirm both workloads are Ready.

- [ ] **Step 4: Run Beijing 7 integration matrix**

Create one unpaid Credit order, verify non-empty `auth_code`, exchange it
without `X-User-Id`, verify replay returns 401, verify a mismatched deal returns
403, and verify the authenticated path still returns a payment URL without
consuming a fresh ticket.

- [ ] **Step 5: Present the master MR update**

Rebase on latest master, rerun affected tests, show the exact incremental
commit and MR description update, and wait for explicit confirmation before
pushing the feature branch. The existing MR is !3870.
