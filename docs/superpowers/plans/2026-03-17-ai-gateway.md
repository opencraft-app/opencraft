# AI Gateway SaaS Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a SaaS AI gateway that proxies LLM requests through a Go business layer (auth, billing, rate-limiting) backed by a self-hosted Portkey Gateway for model routing and retries.

**Architecture:** Go HTTP server (Gin) handles all SaaS business logic — API Key auth, token quota billing, user-level rate limiting — then forwards validated requests to a self-hosted Portkey Gateway which handles multi-model routing, retries, and streaming. PostgreSQL stores persistent data; Redis handles rate-limit counters and API Key caching.

**Tech Stack:** Go 1.22+, Gin, GORM, lib/pq, go-redis/v9, Docker Compose, PostgreSQL 16, Redis 7, Portkey Gateway (self-hosted)

**Spec:** `docs/superpowers/specs/2026-03-17-ai-gateway-design.md`

**Project Conventions:**
- **Monorepo structure**: `ai-gateway/` is one module inside `mono/` repo, with its own `go.mod`. Root has `go.work` to link modules.
- **API style**: All APIs strictly RESTful — proper HTTP methods, resource-based URLs, plural nouns, JSON request/response.
- **Module path**: `git.woa.com/wisp/mono/ai-gateway`

---

## File Map

```
ai-gateway/
├── cmd/server/main.go                          -- App entrypoint, wire dependencies, start server
├── internal/
│   ├── config/config.go                        -- Load YAML config, env vars
│   ├── config/config_test.go                   -- Config parsing tests
│   ├── model/
│   │   ├── user.go                             -- User struct + GORM tags
│   │   ├── plan.go                             -- Plan struct (token_multipliers JSONB)
│   │   ├── subscription.go                     -- Subscription struct + status enum
│   │   ├── provider.go                         -- Provider struct (encrypted api_key)
│   │   ├── apikey.go                           -- ApiKey struct (key_hash, prefix)
│   │   ├── usage_log.go                        -- UsageLog struct
│   │   ├── audit_log.go                        -- AdminAuditLog struct
│   │   └── errors.go                           -- Domain error types (ErrQuotaExceeded, etc.)
│   ├── repository/
│   │   ├── user_repo.go                        -- User CRUD
│   │   ├── user_repo_test.go
│   │   ├── plan_repo.go                        -- Plan CRUD
│   │   ├── plan_repo_test.go
│   │   ├── subscription_repo.go                -- Subscription CRUD + atomic token ops
│   │   ├── subscription_repo_test.go
│   │   ├── provider_repo.go                    -- Provider CRUD + selection query
│   │   ├── provider_repo_test.go
│   │   ├── apikey_repo.go                      -- ApiKey CRUD by hash
│   │   ├── apikey_repo_test.go
│   │   ├── usage_repo.go                       -- UsageLog bulk insert
│   │   ├── usage_repo_test.go
│   │   └── audit_repo.go                       -- AuditLog insert
│   ├── service/
│   │   ├── user_service.go                     -- User create/get/update/delete
│   │   ├── user_service_test.go
│   │   ├── plan_service.go                     -- Plan CRUD logic
│   │   ├── plan_service_test.go
│   │   ├── subscription_service.go             -- Subscribe, renew, expire; single-active rule
│   │   ├── subscription_service_test.go
│   │   ├── billing_service.go                  -- Reserve, deduct, settle, multiplier logic
│   │   ├── billing_service_test.go
│   │   ├── provider_service.go                 -- Select provider, track quota, auto-exhaust
│   │   ├── provider_service_test.go
│   │   ├── apikey_service.go                   -- Generate, validate, revoke + cache invalidation
│   │   ├── apikey_service_test.go
│   │   └── provision_service.go                -- One-click provision (user + sub + key)
│   │   └── provision_service_test.go
│   ├── middleware/
│   │   ├── auth.go                             -- API Key → user context
│   │   ├── auth_test.go
│   │   ├── model_auth.go                       -- Check model vs plan.allowed_models
│   │   ├── model_auth_test.go
│   │   ├── billing.go                          -- Pre-check balance > 0
│   │   ├── billing_test.go
│   │   ├── ratelimit.go                        -- Redis INCR RPM/RPD
│   │   ├── ratelimit_test.go
│   │   ├── admin_auth.go                       -- Admin token + IP whitelist
│   │   ├── admin_auth_test.go
│   │   └── logging.go                          -- Request/response logging
│   ├── handler/
│   │   ├── proxy.go                            -- Forward to Portkey, SSE streaming
│   │   ├── proxy_test.go
│   │   ├── admin_user.go                       -- Admin user CRUD endpoints
│   │   ├── admin_plan.go                       -- Admin plan CRUD endpoints
│   │   ├── admin_subscription.go               -- Admin subscription endpoints
│   │   ├── admin_provider.go                   -- Admin provider CRUD endpoints
│   │   ├── admin_apikey.go                     -- Admin API key endpoints
│   │   ├── admin_provision.go                  -- One-click provision endpoint
│   │   ├── admin_stats.go                      -- Usage/user stats endpoints
│   │   ├── admin_test.go                       -- Admin handler tests
│   │   ├── user_self.go                        -- /v1/me, /v1/me/usage
│   │   ├── health.go                           -- /health, /ready
│   │   └── router.go                           -- Wire all routes + middleware
│   └── pkg/
│       ├── crypto/crypto.go                    -- AES-256-GCM encrypt/decrypt
│       ├── crypto/crypto_test.go
│       ├── redisclient/client.go               -- Redis connection + helpers
│       └── response/response.go                -- OpenAI-compatible error response helpers
├── migrations/
│   ├── 000001_init_schema.up.sql               -- All tables, indexes, partitions
│   └── 000001_init_schema.down.sql             -- Drop all
├── deploy/
│   ├── docker-compose.yml                      -- Gateway + Portkey + PG + Redis
│   ├── Dockerfile                              -- Multi-stage Go build
│   └── config.yaml                             -- Default config template
├── go.mod
├── go.sum
└── Makefile                                    -- build, test, migrate, docker shortcuts
```

---

## Task 1: Project Scaffolding & Infrastructure

**Depends on:** nothing (can run in parallel with nothing)
**Files:**
- Create: `ai-gateway/go.mod`
- Create: `ai-gateway/Makefile`
- Create: `ai-gateway/deploy/docker-compose.yml`
- Create: `ai-gateway/deploy/Dockerfile`
- Create: `ai-gateway/deploy/config.yaml`
- Create: `ai-gateway/internal/config/config.go`
- Create: `ai-gateway/internal/config/config_test.go`
- Create: `ai-gateway/cmd/server/main.go` (minimal, just starts empty server)

- [ ] **Step 1: Initialize Go module**

```bash
cd /Users/yanan/work/mono && mkdir -p ai-gateway && cd ai-gateway
go mod init git.woa.com/wisp/mono/ai-gateway
```

- [ ] **Step 2: Create Makefile**

Create `ai-gateway/Makefile` with targets: `build`, `test`, `run`, `docker-up`, `docker-down`, `migrate-up`, `migrate-down`.

```makefile
.PHONY: build test run docker-up docker-down migrate-up migrate-down

build:
	go build -o bin/ai-gateway ./cmd/server

test:
	go test ./... -v -count=1

run:
	go run ./cmd/server

docker-up:
	docker compose -f deploy/docker-compose.yml up -d

docker-down:
	docker compose -f deploy/docker-compose.yml down

migrate-up:
	migrate -path migrations -database "$(DATABASE_URL)" up

migrate-down:
	migrate -path migrations -database "$(DATABASE_URL)" down
```

- [ ] **Step 3: Create docker-compose.yml**

Create `ai-gateway/deploy/docker-compose.yml` with services: `ai-gateway`, `portkey`, `postgres`, `redis`. Use env vars for secrets. Include volume for postgres data.

```yaml
services:
  ai-gateway:
    build:
      context: ..
      dockerfile: deploy/Dockerfile
    ports: ["8080:8080"]
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_started
      portkey:
        condition: service_started
    environment:
      - CONFIG_PATH=/app/config.yaml
      - ENCRYPTION_KEY=${ENCRYPTION_KEY}
    volumes:
      - ./config.yaml:/app/config.yaml:ro

  portkey:
    image: portkeyai/gateway:latest
    ports: ["8787:8787"]

  postgres:
    image: postgres:16-alpine
    ports: ["5432:5432"]
    volumes:
      - pg_data:/var/lib/postgresql/data
    environment:
      POSTGRES_DB: ai_gateway
      POSTGRES_USER: gateway
      POSTGRES_PASSWORD: ${PG_PASSWORD:-gateway_dev}
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U gateway -d ai_gateway"]
      interval: 5s
      timeout: 5s
      retries: 5

  redis:
    image: redis:7-alpine
    ports: ["6379:6379"]

volumes:
  pg_data:
```

- [ ] **Step 4: Create Dockerfile**

Create `ai-gateway/deploy/Dockerfile` — multi-stage build: Go 1.22 builder → alpine runtime.

```dockerfile
FROM golang:1.22-alpine AS builder
WORKDIR /build
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o ai-gateway ./cmd/server

FROM alpine:3.19
RUN apk add --no-cache ca-certificates tzdata
WORKDIR /app
COPY --from=builder /build/ai-gateway .
EXPOSE 8080
CMD ["./ai-gateway"]
```

- [ ] **Step 5: Write config.go with test**

Create `ai-gateway/internal/config/config.go`: define `Config` struct with all fields from spec (Server, Database, Redis, Portkey, Billing, RateLimit). Load from YAML file path via `CONFIG_PATH` env var. Support env var overrides for secrets (ENCRYPTION_KEY, ADMIN_TOKEN, PG_PASSWORD).

Create `ai-gateway/internal/config/config_test.go`: test loading a sample YAML, test env var overrides, test defaults.

- [ ] **Step 6: Run tests**

```bash
cd /Users/yanan/work/mono/ai-gateway && go test ./internal/config/... -v
```
Expected: PASS

- [ ] **Step 7: Create deploy/config.yaml template**

```yaml
server:
  port: 8080
  admin_token: "${ADMIN_TOKEN}"
  admin_ip_whitelist: []
  max_request_body_size: 10485760

portkey:
  base_url: "http://portkey:8787"

database:
  dsn: "postgres://gateway:${PG_PASSWORD:-gateway_dev}@postgres:5432/ai_gateway?sslmode=disable"

redis:
  addr: "redis:6379"

billing:
  async_log: true
  low_balance_threshold: 10000
  default_reservation_tokens: 4096

rate_limit:
  default_rpm: 60
  default_rpd: 1000
```

- [ ] **Step 8: Create minimal main.go**

Create `ai-gateway/cmd/server/main.go`: load config, print "AI Gateway starting on :PORT", http.ListenAndServe on empty handler. Just enough to verify the build works.

- [ ] **Step 9: Verify build**

```bash
cd /Users/yanan/work/mono/ai-gateway && go build ./cmd/server
```
Expected: compiles without errors.

- [ ] **Step 10: Commit**

```bash
git add ai-gateway/
git commit -m "feat(ai-gateway): scaffold project with config, Docker, Makefile"
```

---

## Task 2: Database Models & Migrations

**Depends on:** Task 1 (go.mod exists)
**Files:**
- Create: `ai-gateway/internal/model/user.go`
- Create: `ai-gateway/internal/model/plan.go`
- Create: `ai-gateway/internal/model/subscription.go`
- Create: `ai-gateway/internal/model/provider.go`
- Create: `ai-gateway/internal/model/apikey.go`
- Create: `ai-gateway/internal/model/usage_log.go`
- Create: `ai-gateway/internal/model/audit_log.go`
- Create: `ai-gateway/internal/model/errors.go`
- Create: `ai-gateway/migrations/000001_init_schema.up.sql`
- Create: `ai-gateway/migrations/000001_init_schema.down.sql`

- [ ] **Step 1: Create all model structs**

One file per model. Each struct has GORM tags (`gorm:"column:...;type:..."`) matching the spec exactly. Use `uuid.UUID` from `github.com/google/uuid`. Use `datatypes.JSON` from `gorm.io/datatypes` for JSONB fields (allowed_models, token_multipliers, before_value, after_value). Define status enums as Go string constants.

`errors.go` defines sentinel errors:
```go
var (
    ErrUserNotFound         = errors.New("user not found")
    ErrPlanNotFound         = errors.New("plan not found")
    ErrSubscriptionNotFound = errors.New("subscription not found")
    ErrProviderNotFound     = errors.New("provider not found")
    ErrApiKeyNotFound       = errors.New("api key not found")
    ErrQuotaExceeded        = errors.New("token quota exceeded")
    ErrRateLimitExceeded    = errors.New("rate limit exceeded")
    ErrModelNotAllowed      = errors.New("model not allowed")
    ErrInvalidApiKey        = errors.New("invalid api key")
    ErrProviderUnavailable  = errors.New("no available provider")
    ErrInsufficientReserve  = errors.New("insufficient balance for reservation")
)
```

- [ ] **Step 2: Create migration SQL (up)**

Create `ai-gateway/migrations/000001_init_schema.up.sql` with all tables from spec:
- `users` with phone UNIQUE, external_uid UNIQUE, status enum CHECK
- `plans` with token_multipliers JSONB DEFAULT '{}'
- `subscriptions` with FKs, status enum CHECK
- `providers` with status enum CHECK, priority
- `api_keys` with key_hash UNIQUE, FK to users
- `usage_logs` PARTITION BY RANGE (created_at), with initial monthly partition
- `admin_audit_logs`
- All indexes from spec (idx_usage_logs_user_created, idx_usage_logs_provider_created, idx_subscriptions_user_status, idx_providers_type_status)
- uuid-ossp extension for uuid_generate_v4()

- [ ] **Step 3: Create migration SQL (down)**

```sql
DROP TABLE IF EXISTS admin_audit_logs;
DROP TABLE IF EXISTS usage_logs;
DROP TABLE IF EXISTS api_keys;
DROP TABLE IF EXISTS subscriptions;
DROP TABLE IF EXISTS providers;
DROP TABLE IF EXISTS plans;
DROP TABLE IF EXISTS users;
DROP EXTENSION IF EXISTS "uuid-ossp";
```

- [ ] **Step 4: Verify models compile**

```bash
cd /Users/yanan/work/mono/ai-gateway && go build ./internal/model/...
```
Expected: compiles.

- [ ] **Step 5: Commit**

```bash
git add ai-gateway/internal/model/ ai-gateway/migrations/
git commit -m "feat(ai-gateway): add database models and migration schema"
```

---

## Task 3: Crypto & Response Utilities

**Depends on:** Task 1 (go.mod)
**Files:**
- Create: `ai-gateway/internal/pkg/crypto/crypto.go`
- Create: `ai-gateway/internal/pkg/crypto/crypto_test.go`
- Create: `ai-gateway/internal/pkg/response/response.go`

- [ ] **Step 1: Write crypto test**

Test AES-256-GCM encrypt then decrypt roundtrip. Test that ciphertext differs from plaintext. Test decrypt with wrong key fails. Test empty plaintext. Test key rotation (encrypt with key A, decrypt attempts key B then key A).

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/yanan/work/mono/ai-gateway && go test ./internal/pkg/crypto/... -v
```
Expected: FAIL — file doesn't exist yet.

- [ ] **Step 3: Implement crypto.go**

`Encrypt(plaintext string, key []byte) (string, error)` — AES-256-GCM, returns base64-encoded `nonce:ciphertext`. `Decrypt(encoded string, keys ...[]byte) (string, error)` — tries each key in order (supports key rotation). Key must be exactly 32 bytes.

- [ ] **Step 4: Run test to verify it passes**

```bash
cd /Users/yanan/work/mono/ai-gateway && go test ./internal/pkg/crypto/... -v
```
Expected: PASS

- [ ] **Step 5: Create response.go**

OpenAI-compatible error response helpers:
```go
func ErrorResponse(c *gin.Context, httpStatus int, errType, code, message string)
func ErrInvalidAPIKey(c *gin.Context)
func ErrQuotaExceeded(c *gin.Context)
func ErrModelNotAllowed(c *gin.Context)
func ErrRateLimitExceeded(c *gin.Context, retryAfter int)
func ErrUpstreamError(c *gin.Context, msg string)
func ErrProviderUnavailable(c *gin.Context)
```

Each writes JSON `{"error":{"message":"...","type":"...","code":"..."}}` with the correct HTTP status from the spec error table.

- [ ] **Step 6: Commit**

```bash
git add ai-gateway/internal/pkg/
git commit -m "feat(ai-gateway): add AES-256-GCM crypto and OpenAI error response helpers"
```

---

## Task 4: Repository Layer

**Depends on:** Task 2 (models)
**Files:**
- Create: all `ai-gateway/internal/repository/*_repo.go` files
- Create: all `ai-gateway/internal/repository/*_repo_test.go` files

- [ ] **Step 1: Write repository interfaces**

Define interfaces at the top of each repo file. All repos accept `*gorm.DB` (or a transaction) so callers can wrap in transactions.

Key methods:
- `UserRepo`: Create, GetByID, GetByPhone, GetByExternalUID, Update, SoftDelete
- `PlanRepo`: Create, GetByID, GetByName, List, Update
- `SubscriptionRepo`: Create, GetActiveByUserID, DeductTokens(subID, amount) (atomic `WHERE token_balance >= amount`), RefundTokens(subID, amount), ExpireOverdue, CancelByUserID
- `ProviderRepo`: Create, GetByID, SelectBest(providerType) (filter active + has quota, order by priority DESC, limit 1), IncrementUsedQuota(providerID, amount), MarkExhausted(providerID), List, Update
- `ApiKeyRepo`: Create, GetByHash, DeactivateByID, DeactivateAllForUser, ListByUserID
- `UsageRepo`: BatchCreate (bulk insert for async logging)
- `AuditRepo`: Create

- [ ] **Step 2: Write test for SubscriptionRepo.DeductTokens (critical path)**

Test: create subscription with balance 10000. DeductTokens(5000) → success, balance 5000. DeductTokens(6000) → fail (insufficient), balance still 5000. Test concurrent deductions don't go negative.

Use `sqlmock` or a test postgres via testcontainers. Prefer `sqlmock` for unit speed.

- [ ] **Step 3: Run test to verify it fails**

```bash
cd /Users/yanan/work/mono/ai-gateway && go test ./internal/repository/... -v -run TestDeductTokens
```
Expected: FAIL

- [ ] **Step 4: Implement SubscriptionRepo with atomic deduction**

Key SQL for DeductTokens:
```go
result := db.Model(&model.Subscription{}).
    Where("id = ? AND token_balance >= ? AND status = ?", subID, amount, "active").
    Updates(map[string]interface{}{
        "token_balance": gorm.Expr("token_balance - ?", amount),
        "updated_at":    time.Now(),
    })
if result.RowsAffected == 0 {
    return model.ErrQuotaExceeded
}
```

- [ ] **Step 5: Run test to verify it passes**

Expected: PASS

- [ ] **Step 6: Implement remaining repos + tests**

Implement UserRepo, PlanRepo, ProviderRepo, ApiKeyRepo, UsageRepo, AuditRepo with basic tests for each (CRUD + key queries).

ProviderRepo.SelectBest is critical:
```go
func (r *providerRepo) SelectBest(providerType string) (*model.Provider, error) {
    var p model.Provider
    err := r.db.Where("provider_type = ? AND status = ? AND used_quota < total_quota",
        providerType, "active").
        Order("priority DESC").
        First(&p).Error
    if errors.Is(err, gorm.ErrRecordNotFound) {
        return nil, model.ErrProviderUnavailable
    }
    return &p, err
}
```

- [ ] **Step 7: Run all repo tests**

```bash
cd /Users/yanan/work/mono/ai-gateway && go test ./internal/repository/... -v
```
Expected: all PASS

- [ ] **Step 8: Commit**

```bash
git add ai-gateway/internal/repository/
git commit -m "feat(ai-gateway): implement repository layer with atomic token deduction"
```

---

## Task 5: Service Layer — Core Business Logic

**Depends on:** Task 4 (repositories), Task 3 (crypto)
**Files:**
- Create: all `ai-gateway/internal/service/*_service.go` files
- Create: all `ai-gateway/internal/service/*_service_test.go` files

- [ ] **Step 1: Write billing_service_test.go**

Test Reserve → returns estimated tokens deducted. Test Settle(actual < reserved) → refund difference. Test Settle(actual > reserved) → deduct extra. Test Reserve with insufficient balance → error. Test multiplier: model="gpt-4" with multiplier 30, raw_tokens=100 → effective deduction = 3000.

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/yanan/work/mono/ai-gateway && go test ./internal/service/... -v -run TestBilling
```
Expected: FAIL

- [ ] **Step 3: Implement BillingService**

```go
type BillingService struct {
    subRepo  repository.SubscriptionRepo
    provRepo repository.ProviderRepo
    usageRepo repository.UsageRepo
}

func (s *BillingService) Reserve(subID uuid.UUID, model string, plan *model.Plan) (int64, error)
    // Get multiplier from plan.TokenMultipliers[model], default 1.0
    // estimated = config.DefaultReservationTokens * multiplier
    // Call subRepo.DeductTokens(subID, estimated)
    // Return estimated

func (s *BillingService) Settle(subID, providerID uuid.UUID, estimated, actualRaw int64, model string, plan *model.Plan) error
    // actual = actualRaw * multiplier
    // delta = estimated - actual
    // if delta > 0: subRepo.RefundTokens(subID, delta)
    // if delta < 0: subRepo.DeductTokens(subID, -delta) — best effort, may fail if balance insufficient
    // provRepo.IncrementUsedQuota(providerID, actualRaw)
    // usageRepo.BatchCreate with usage log entry (async via goroutine)
```

- [ ] **Step 4: Run billing tests**

Expected: PASS

- [ ] **Step 5: Implement ApiKeyService with tests**

`Generate(userID) → (plainKey, *model.ApiKey, error)`: generate `sk-` + 48 random hex chars, SHA-256 hash, store hash + prefix in DB. `Validate(plainKey) → (*model.ApiKey, *model.User, *model.Subscription, *model.Plan, error)`: hash → check Redis cache → miss → query DB → populate cache (TTL 5min). `Revoke(keyID)`: deactivate in DB + delete Redis cache entry.

Tests: generate then validate roundtrip. Validate unknown key → error. Revoke then validate → error.

- [ ] **Step 6: Implement ProviderService with tests**

`SelectProvider(providerType) → (*model.Provider, error)`: delegates to repo.SelectBest, then decrypts provider.ApiKey via `crypto.Decrypt` before returning. `TrackUsage(providerID, tokens)`: increment used_quota, check if exhausted (used >= total), if so mark exhausted and **emit `slog.Warn("provider exhausted", "provider_id", id)` for alerting** (future: webhook notification).

Tests: select from multiple providers returns highest priority. Exhausted provider skipped. All exhausted → error.

- [ ] **Step 7: Implement SubscriptionService with tests**

`Subscribe(userID, planID, periodMonths) → (*model.Subscription, error)`: cancel existing active sub, create new one with token_balance = plan.MonthlyTokens. `ExpireOverdue()`: find all active subs with period_end < now, mark expired.

Tests: create sub. Create second sub cancels first. Expire overdue works.

- [ ] **Step 8: Implement UserService, PlanService with tests**

Standard CRUD services. UserService.SoftDelete sets status="deleted". PlanService validates name uniqueness.

- [ ] **Step 9: Implement ProvisionService with tests**

`Provision(phone, externalUID, planName) → (user, apiKey, subscription, error)`:
1. Create or get user by phone
2. Find plan by name
3. Create subscription (cancels existing)
4. Generate API key
5. Return all

Test: full provision creates user + sub + key. Provision existing user resets sub + adds key.

- [ ] **Step 10: Run all service tests**

```bash
cd /Users/yanan/work/mono/ai-gateway && go test ./internal/service/... -v
```
Expected: all PASS

- [ ] **Step 11: Commit**

```bash
git add ai-gateway/internal/service/
git commit -m "feat(ai-gateway): implement service layer with billing, API key, provider selection"
```

---

## Task 6: Redis Client & Rate Limiter

**Depends on:** Task 1 (go.mod, config)
**Files:**
- Create: `ai-gateway/internal/pkg/redisclient/client.go`
- Create: `ai-gateway/internal/middleware/ratelimit.go`
- Create: `ai-gateway/internal/middleware/ratelimit_test.go`

- [ ] **Step 1: Create Redis client wrapper**

`client.go`: wraps `go-redis/v9`. Methods:
- `IncrWithTTL(key string, ttl time.Duration) (int64, error)` — INCR + set TTL if key is new (use Lua script for atomicity)
- `Get/Set/Del` for API key cache
- `NewClient(addr string) *Client`

- [ ] **Step 2: Write ratelimit test**

Test: RPM=2. First 2 requests pass. Third returns 429. After 60s TTL, counter resets.
Use miniredis (`github.com/alicebob/miniredis/v2`) for in-memory Redis in tests.

- [ ] **Step 3: Run test to verify it fails**

Expected: FAIL

- [ ] **Step 4: Implement ratelimit middleware**

```go
func RateLimiter(redisClient *redisclient.Client) gin.HandlerFunc {
    return func(c *gin.Context) {
        user := GetUserFromContext(c)
        plan := GetPlanFromContext(c)

        // Check RPM
        rpmKey := fmt.Sprintf("rate:%s:rpm", user.ID)
        count, _ := redisClient.IncrWithTTL(rpmKey, time.Minute)
        if count > int64(plan.RPMLimit) {
            response.ErrRateLimitExceeded(c, 60)
            c.Abort()
            return
        }

        // Check RPD
        rpdKey := fmt.Sprintf("rate:%s:rpd", user.ID)
        count, _ = redisClient.IncrWithTTL(rpdKey, 24*time.Hour)
        if count > int64(plan.RPDLimit) {
            response.ErrRateLimitExceeded(c, 3600)
            c.Abort()
            return
        }

        c.Next()
    }
}
```

- [ ] **Step 5: Run test to verify it passes**

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add ai-gateway/internal/pkg/redisclient/ ai-gateway/internal/middleware/ratelimit*
git commit -m "feat(ai-gateway): add Redis client and user-level rate limiter middleware"
```

---

## Task 7: Auth & Billing Middleware

**Depends on:** Task 5 (services), Task 6 (Redis client)
**Files:**
- Create: `ai-gateway/internal/middleware/auth.go`
- Create: `ai-gateway/internal/middleware/auth_test.go`
- Create: `ai-gateway/internal/middleware/model_auth.go`
- Create: `ai-gateway/internal/middleware/model_auth_test.go`
- Create: `ai-gateway/internal/middleware/billing.go`
- Create: `ai-gateway/internal/middleware/billing_test.go`
- Create: `ai-gateway/internal/middleware/admin_auth.go`
- Create: `ai-gateway/internal/middleware/admin_auth_test.go`
- Create: `ai-gateway/internal/middleware/logging.go`

- [ ] **Step 1: Write auth middleware test**

Test: valid API key → user/sub/plan injected into context, c.Next() called. Invalid key → 401 response, c.Abort(). Missing Authorization header → 401. Disabled key → 401. Test Redis cache hit (second call doesn't query DB).

- [ ] **Step 2: Run test to verify it fails**

Expected: FAIL

- [ ] **Step 3: Implement auth.go**

Extract `Bearer sk-xxx` from header. SHA-256 hash the key. Check Redis cache (`cache:apikey:{hash}`). On miss, query ApiKeyRepo → load user + active subscription + plan → cache in Redis (TTL 5min). Inject into Gin context via `c.Set("user", user)`, `c.Set("subscription", sub)`, `c.Set("plan", plan)`. Update `api_keys.last_used_at` asynchronously (goroutine, best-effort). Helper functions: `GetUserFromContext(c)`, `GetSubscriptionFromContext(c)`, `GetPlanFromContext(c)`.

- [ ] **Step 4: Run auth test**

Expected: PASS

- [ ] **Step 5: Write model_auth test**

Test: request with model in allowed_models → pass. Model not in list → 403. Empty body or missing model field → 400.

- [ ] **Step 6: Implement model_auth.go**

Read request body (buffer it for re-read by proxy). Parse JSON to extract `model` field. Check against `plan.AllowedModels`. Restore body for downstream. Return 403 if not allowed.

- [ ] **Step 7: Run model_auth test**

Expected: PASS

- [ ] **Step 8: Write billing middleware test**

Test: subscription with balance > 0 and not expired → pass. Balance = 0 → 402. Expired subscription → 402.

- [ ] **Step 9: Implement billing.go**

Simple pre-check: read subscription from context. If `token_balance <= 0` or `period_end.Before(time.Now())` → 402. This is just the gate; actual deduction happens in proxy handler after response.

- [ ] **Step 10: Run billing test**

Expected: PASS

- [ ] **Step 11: Implement admin_auth.go + test**

Check `Authorization: Bearer admin-xxx` against config.AdminToken. Optionally check client IP against config.AdminIPWhitelist (CIDR parsing via `net.ParseCIDR`). Return 401 if invalid. Write test: valid token → pass, invalid → 401, IP not in whitelist → 401.

- [ ] **Step 12: Implement MaxBodySize middleware**

```go
func MaxBodySize(maxBytes int64) gin.HandlerFunc {
    return func(c *gin.Context) {
        c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxBytes)
        c.Next()
    }
}
```

- [ ] **Step 13: Implement logging.go**

Log request method, path, status code, latency, user ID (if present), request ID (generate UUID). Use Go's `slog` structured logging.

- [ ] **Step 14: Run all middleware tests**

```bash
cd /Users/yanan/work/mono/ai-gateway && go test ./internal/middleware/... -v
```
Expected: all PASS

- [ ] **Step 15: Commit**

```bash
git add ai-gateway/internal/middleware/
git commit -m "feat(ai-gateway): add auth, model auth, billing, admin auth, and logging middleware"
```

---

## Task 8: Proxy Handler (Core Request Path)

**Depends on:** Task 7 (middleware), Task 5 (billing service)
**Files:**
- Create: `ai-gateway/internal/handler/proxy.go`
- Create: `ai-gateway/internal/handler/proxy_test.go`

- [ ] **Step 1: Write proxy test for non-streaming**

Use `httptest.NewServer` to mock Portkey. Test: send chat completion request → proxy forwards to mock Portkey → response returned with correct body. Test: billing service.Reserve called before proxy, Settle called after response. Test: upstream 500 → return 502 to client.

- [ ] **Step 2: Run test to verify it fails**

Expected: FAIL

- [ ] **Step 3: Implement proxy.go — non-streaming path**

```go
func (h *ProxyHandler) ChatCompletions(c *gin.Context) {
    user := middleware.GetUserFromContext(c)
    sub := middleware.GetSubscriptionFromContext(c)
    plan := middleware.GetPlanFromContext(c)

    // 1. Parse model from request
    body, _ := io.ReadAll(c.Request.Body)
    var req map[string]interface{}
    json.Unmarshal(body, &req)
    modelName := req["model"].(string)
    isStream := req["stream"] == true

    // 2. Select provider
    provider, err := h.providerService.SelectProvider(providerType(modelName))

    // 3. Reserve tokens (billing pre-deduction)
    reserved, err := h.billingService.Reserve(sub.ID, modelName, plan)

    // 4. Forward to Portkey
    // Set provider API key in header for Portkey
    // POST to portkey.BaseURL + "/v1/chat/completions"

    // 5. Non-streaming: read response, extract usage, settle billing
    // 6. Return response to client
}
```

- [ ] **Step 4: Run non-streaming test**

Expected: PASS

- [ ] **Step 5: Write proxy test for streaming (SSE)**

Mock Portkey returns SSE chunks. Test: client receives all chunks. Test: final chunk has usage info → billing settled correctly. Test: stream interrupted → reservation partially refunded.

- [ ] **Step 6: Implement streaming path**

For `stream: true`:
- Set response headers: `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`
- Read chunks from Portkey response body, write each to client via `c.Writer.Write` + `c.Writer.Flush()`
- Accumulate token counts from chunks
- On `[DONE]`: extract final usage from last data chunk (if available), settle billing
- On error/disconnect: settle with accumulated count, refund rest of reservation

- [ ] **Step 7: Run streaming test**

Expected: PASS

- [ ] **Step 8: Add /v1/completions, /v1/embeddings, and /v1/models**

`/v1/completions` and `/v1/embeddings`: same proxy pattern as chat completions — delegate to Portkey with the correct endpoint path. Re-use billing/provider logic. Note: embeddings have no streaming and different usage response format (no completion_tokens).

`/v1/models`: no proxy — return user's `plan.AllowedModels` as OpenAI-compatible model list:
```go
func (h *ProxyHandler) Models(c *gin.Context) {
    plan := middleware.GetPlanFromContext(c)
    var models []map[string]interface{}
    for _, m := range plan.AllowedModels {
        models = append(models, map[string]interface{}{
            "id": m, "object": "model", "owned_by": "organization",
        })
    }
    c.JSON(200, gin.H{"object": "list", "data": models})
}
```

- [ ] **Step 9: Commit**

```bash
git add ai-gateway/internal/handler/proxy*
git commit -m "feat(ai-gateway): implement proxy handler with streaming SSE and token billing"
```

---

## Task 9: Admin API Handlers

**Depends on:** Task 5 (services), Task 7 (admin_auth middleware)
**Files:**
- Create: `ai-gateway/internal/handler/admin_provision.go`
- Create: `ai-gateway/internal/handler/admin_user.go`
- Create: `ai-gateway/internal/handler/admin_plan.go`
- Create: `ai-gateway/internal/handler/admin_subscription.go`
- Create: `ai-gateway/internal/handler/admin_provider.go`
- Create: `ai-gateway/internal/handler/admin_apikey.go`
- Create: `ai-gateway/internal/handler/admin_stats.go`
- Create: `ai-gateway/internal/handler/admin_test.go`

- [ ] **Step 1: Write provision endpoint test**

Test: POST `/api/admin/provision` with `{phone, external_uid, plan_name}` → 200 with `{user_id, api_key, plan_details}`. Test: missing fields → 400. Test: unknown plan_name → 404.

- [ ] **Step 2: Run test to verify it fails**

Expected: FAIL

- [ ] **Step 3: Implement admin_provision.go**

```go
func (h *AdminHandler) Provision(c *gin.Context) {
    var req struct {
        Phone       string `json:"phone" binding:"required"`
        ExternalUID string `json:"external_uid" binding:"required"`
        PlanName    string `json:"plan_name" binding:"required"`
    }
    if err := c.ShouldBindJSON(&req); err != nil {
        c.JSON(400, gin.H{"error": err.Error()})
        return
    }
    user, key, sub, err := h.provisionService.Provision(req.Phone, req.ExternalUID, req.PlanName)
    // Return user_id, api_key (plain), plan details
}
```

- [ ] **Step 4: Run provision test**

Expected: PASS

- [ ] **Step 5: Write tests for admin_user.go and admin_plan.go**

Test user CRUD cycle (create → get → update → soft-delete). Test plan create with token_multipliers + list + update.

- [ ] **Step 6: Implement admin_user.go and admin_plan.go**

Each handler: parse request → call service → return JSON. Include audit logging on mutations. Support pagination on list (`page`, `page_size` query params, default 1/20).

- [ ] **Step 7: Run user/plan admin tests**

Expected: PASS

- [ ] **Step 8: Write tests for admin_subscription.go and admin_provider.go**

Test subscription creation + token adjustment. Test provider create + usage tracking endpoint.

- [ ] **Step 9: Implement admin_subscription.go and admin_provider.go**

Subscription: POST/GET on `/api/admin/users/:id/subscriptions`, PUT on `/api/admin/subscriptions/:id/tokens`.
Provider: POST/GET/PUT on `/api/admin/providers[/:id]`, GET `/api/admin/providers/:id/usage`. Wire `crypto.Encrypt` on provider creation for api_key field.

- [ ] **Step 10: Run subscription/provider admin tests**

Expected: PASS

- [ ] **Step 11: Write tests for admin_apikey.go and admin_stats.go**

Test API key creation returns key. Test key deletion invalidates Redis cache. Test stats endpoint returns aggregated data.

- [ ] **Step 12: Implement admin_apikey.go and admin_stats.go**

API Key: POST on `/api/admin/users/:id/api-keys`, DELETE on `/api/admin/api-keys/:id`.
Stats: GET `/api/admin/stats/usage` (total tokens, requests, per-model), GET `/api/admin/stats/users` (active count, total).

- [ ] **Step 13: Run all admin tests**

```bash
cd /Users/yanan/work/mono/ai-gateway && go test ./internal/handler/... -v -run TestAdmin
```
Expected: all PASS

- [ ] **Step 8: Commit**

```bash
git add ai-gateway/internal/handler/admin*
git commit -m "feat(ai-gateway): implement admin API handlers with provision, CRUD, and audit logging"
```

---

## Task 10: User Self-Service & Health Endpoints

**Depends on:** Task 7 (auth middleware)
**Files:**
- Create: `ai-gateway/internal/handler/user_self.go`
- Create: `ai-gateway/internal/handler/user_self_test.go`
- Create: `ai-gateway/internal/handler/health.go`
- Create: `ai-gateway/internal/handler/health_test.go`

- [ ] **Step 1: Write user_self_test.go**

Test `/v1/me`: authenticated user → returns user info + subscription + plan + remaining tokens. Test `/v1/me/usage`: returns aggregated stats for last 7 days.

- [ ] **Step 2: Implement /v1/me and /v1/me/usage**

`GET /v1/me`: return user info + current subscription + plan details + remaining tokens from context (no DB query needed, already loaded by auth middleware).

`GET /v1/me/usage`: query usage_logs for current user, support `?days=7` query param, return aggregated stats (total requests, total tokens, per-model breakdown).

- [ ] **Step 3: Run user_self tests**

Expected: PASS

- [ ] **Step 4: Write health_test.go**

Test `/health`: always returns 200 `{"status":"ok"}`. Test `/ready`: with mock DB+Redis both up → 200. With DB down → 503 with error detail.

- [ ] **Step 5: Implement /health and /ready**

`GET /health`: always return `{"status": "ok"}` with 200.
`GET /ready`: ping PostgreSQL (`db.Exec("SELECT 1")`) + Redis (`client.Ping()`); if both respond, return 200. Otherwise 503 with details of which dependency is down.

- [ ] **Step 6: Run health tests**

Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add ai-gateway/internal/handler/user_self.go ai-gateway/internal/handler/health.go
git commit -m "feat(ai-gateway): add user self-service and health check endpoints"
```

---

## Task 11: Router Wiring & Main Entrypoint

**Depends on:** Tasks 7-10 (all handlers and middleware)
**Files:**
- Create: `ai-gateway/internal/handler/router.go`
- Modify: `ai-gateway/cmd/server/main.go`

- [ ] **Step 1: Create router.go**

Wire all routes and middleware:

```go
func NewRouter(deps *Dependencies) *gin.Engine {
    r := gin.New()
    r.Use(gin.Recovery())
    r.Use(middleware.Logging())
    r.Use(middleware.MaxBodySize(deps.Config.Server.MaxRequestBodySize))

    // Health (no auth)
    r.GET("/health", deps.HealthHandler.Health)
    r.GET("/ready", deps.HealthHandler.Ready)

    // Proxy routes (user auth → model auth → billing → rate limit → proxy)
    v1 := r.Group("/v1")
    v1.Use(middleware.Auth(deps.ApiKeyService, deps.RedisClient))
    {
        // Self-service (after auth, before billing/ratelimit)
        v1.GET("/me", deps.UserSelfHandler.Me)
        v1.GET("/me/usage", deps.UserSelfHandler.Usage)
        v1.GET("/models", deps.ProxyHandler.Models)

        // Proxy (full middleware chain)
        proxy := v1.Group("")
        proxy.Use(middleware.ModelAuth())
        proxy.Use(middleware.BillingCheck())
        proxy.Use(middleware.RateLimiter(deps.RedisClient))
        {
            proxy.POST("/chat/completions", deps.ProxyHandler.ChatCompletions)
            proxy.POST("/completions", deps.ProxyHandler.Completions)
            proxy.POST("/embeddings", deps.ProxyHandler.Embeddings)
        }
    }

    // Admin routes
    admin := r.Group("/api/admin")
    admin.Use(middleware.AdminAuth(deps.Config.Server.AdminToken, deps.Config.Server.AdminIPWhitelist))
    {
        admin.POST("/provision", deps.AdminHandler.Provision)
        // ... all other admin routes
    }

    return r
}
```

- [ ] **Step 2: Update main.go**

Full dependency injection wiring:
1. Load config
2. Connect PostgreSQL (GORM)
3. Run migrations (auto-migrate or golang-migrate)
4. Connect Redis
5. Create repos → services → handlers
6. Create router
7. Start HTTP server with graceful shutdown (signal handling)

- [ ] **Step 3: Verify build**

```bash
cd /Users/yanan/work/mono/ai-gateway && go build ./cmd/server
```
Expected: compiles without errors.

- [ ] **Step 4: Commit**

```bash
git add ai-gateway/internal/handler/router.go ai-gateway/cmd/server/main.go
git commit -m "feat(ai-gateway): wire router, dependency injection, and graceful shutdown in main"
```

---

## Task 12: Integration Test & Docker Verification

**Depends on:** Task 11 (everything wired)
**Files:**
- Create: `ai-gateway/test/integration_test.go`

- [ ] **Step 1: Write integration test**

Using testcontainers-go, spin up PostgreSQL + Redis. Run migrations. Test full flow:
1. Create plan via admin API
2. Create provider via admin API
3. Provision user (gets user + sub + key)
4. Use API key to call /v1/me → verify user info
5. Use API key to call /v1/chat/completions (mock Portkey via httptest) → verify response + token deduction
6. Call /v1/me again → verify reduced token balance
7. Exhaust tokens → verify 402 response
8. Verify /health and /ready return 200

- [ ] **Step 2: Run integration test**

```bash
cd /Users/yanan/work/mono/ai-gateway && go test ./test/... -v -tags=integration -timeout=120s
```
Expected: all PASS

- [ ] **Step 3: Test Docker build**

```bash
cd /Users/yanan/work/mono/ai-gateway && docker build -f deploy/Dockerfile -t ai-gateway:test .
```
Expected: builds successfully.

- [ ] **Step 4: Test Docker Compose up**

```bash
cd /Users/yanan/work/mono/ai-gateway && docker compose -f deploy/docker-compose.yml up -d
# Wait for healthy
curl http://localhost:8080/health
# Expected: {"status":"ok"}
docker compose -f deploy/docker-compose.yml down
```

- [ ] **Step 5: Commit**

```bash
git add ai-gateway/test/
git commit -m "feat(ai-gateway): add integration tests and verify Docker deployment"
```

---

## Task 13: Background Jobs (Subscription Expiry & Reservation Reaper)

**Depends on:** Task 11 (main.go wiring)
**Files:**
- Create: `ai-gateway/internal/worker/scheduler.go`
- Create: `ai-gateway/internal/worker/scheduler_test.go`

- [ ] **Step 1: Write scheduler test**

Test: create expired subscription (period_end in past, status=active). Run ExpireOverdue. Verify status changed to expired. Test: reservation reaper reclaims stale reservations (mock usage_logs with no settlement after 10 min).

- [ ] **Step 2: Implement scheduler.go**

Simple ticker-based scheduler (no external dependency):

```go
type Scheduler struct {
    subService *service.SubscriptionService
    // ... other services
}

func (s *Scheduler) Start(ctx context.Context) {
    // Expire overdue subscriptions every hour
    go s.runEvery(ctx, 1*time.Hour, s.subService.ExpireOverdue)

    // Reclaim stale reservations every 5 minutes
    go s.runEvery(ctx, 5*time.Minute, s.reclaimStaleReservations)
}

func (s *Scheduler) runEvery(ctx context.Context, interval time.Duration, fn func() error) {
    ticker := time.NewTicker(interval)
    defer ticker.Stop()
    for {
        select {
        case <-ctx.Done():
            return
        case <-ticker.C:
            if err := fn(); err != nil {
                slog.Error("scheduler job failed", "error", err)
            }
        }
    }
}
```

- [ ] **Step 3: Run test**

Expected: PASS

- [ ] **Step 4: Wire scheduler into main.go**

Start scheduler in main.go after all dependencies are ready, before HTTP server starts. Pass context for graceful shutdown.

- [ ] **Step 5: Commit**

```bash
git add ai-gateway/internal/worker/ ai-gateway/cmd/server/main.go
git commit -m "feat(ai-gateway): add background scheduler for subscription expiry and reservation reaper"
```

---

## Parallelism Map

Tasks that can run concurrently (no dependency conflicts):

```
Phase 0:            Task 1                   (project scaffolding — go.mod must exist first)
Phase 1 (parallel): Task 2, Task 3           (both depend only on Task 1)
Phase 2 (parallel): Task 4, Task 6           (both depend on Phase 1)
Phase 3:            Task 5                   (depends on Task 4 + Task 3)
Phase 4 (parallel): Task 7, Task 9, Task 10  (depend on Task 5 + Task 6; Task 9 only needs admin_auth from Task 7 — extract interface)
Phase 4b:           Task 8                   (depends on Task 7 middleware + Task 5 services)
Phase 5:            Task 11                  (depends on all Tasks 7-10)
Phase 6 (parallel): Task 12, Task 13         (depend on Task 11)
```

When using subagent-driven development, Phase 0 runs first, then Phase 1 (2 parallel), etc.
