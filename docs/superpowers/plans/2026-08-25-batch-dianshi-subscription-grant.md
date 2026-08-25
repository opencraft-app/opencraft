# Batch Dianshi Subscription Grant Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add internal user-ID based shadow registration and subscription grant APIs, plus a one-off batch script that grants `bundle_launch_ai_01` through Dianshi product `142123551192174` without changing inventory.

**Architecture:** Auth exposes the existing binding behavior by verified user ID. CTL enforces Pass ownership and delegates a prepared order to a dedicated Trade grant endpoint. Trade copies the inventory mapping, overrides only the product ID, and preserves callback/idempotency metadata. A standard-library Python script orchestrates the two public internal APIs.

**Tech Stack:** Go, Gin, net/http, database/sql, Python 3 standard library, Go testing, unittest.

## Global Constraints

- Do not modify `trade_bundle_activity` data or seed files.
- Do not expose the Dianshi secret outside Trade.
- All new endpoints must fail closed when their internal token is absent or invalid.
- Existing user-facing Auth, CTL purchase, Trade Dianshi, and domestic-site behavior must remain unchanged.
- Product ID defaults to `142123551192174`; bundle ID defaults to `bundle_launch_ai_01`.
- Implement inline in the current task; do not dispatch subagents.

---

### Task 1: Auth register-or-retry endpoint

**Files:**
- Modify: `user/auth/internal/service/service.go`
- Modify: `user/auth/internal/service/service_test.go`
- Modify: `user/auth/internal/httpapi/internal_shadow.go`
- Modify: `user/auth/internal/httpapi/internal_shadow_test.go`

**Interfaces:**
- Produces: `Service.RegisterOrRetryInternalShadowBinding(ctx context.Context, userID string) (ShadowBindingResult, error)`
- Produces: `POST /internal/shadow/binding/register-or-retry` with `{external_user_id}` and the existing internal envelope.

- [ ] **Step 1: Write failing service tests**

Cover a missing binding for a stored user with verified email, an already active binding, an unknown user, and an unverified email. Assert that missing binding invokes the same `BindShadowAccount` flow as `RetryShadowBinding`.

- [ ] **Step 2: Run the service tests and verify failure**

Run: `cd user/auth && go test ./internal/service -run 'RegisterOrRetryInternalShadowBinding' -count=1`

Expected: FAIL because the service method does not exist.

- [ ] **Step 3: Implement the service method**

The method trims and validates `userID`, loads `s.store.FindUserByID`, selects `user.Email` only when `EmailVerified`, calls:

```go
s.shadowBinding.BindShadowAccount(ctx, shadowbinding.BindInput{
    UserID: user.ID,
    Email:  verifiedEmail,
    Phone:  user.Phone,
})
```

It mirrors the existing retry method's partial-result handling and migration notification.

- [ ] **Step 4: Write failing route tests**

Assert 401 without internal token, 400 without `external_user_id`, 404 for unknown user, and 200 with a non-secret binding response for a valid user.

- [ ] **Step 5: Register and implement the route**

Add `handleRegisterOrRetryShadowBinding` beside `handleRetryShadowBilling`, reuse `isAuthorizedInternalToken`, `toErrorBody`, `toInternalShadowBinding`, and register:

```go
router.POST("/internal/shadow/binding/register-or-retry", internal.handleRegisterOrRetryShadowBinding)
```

- [ ] **Step 6: Run Auth tests**

Run: `cd user/auth && go test ./internal/service ./internal/httpapi -count=1`

Expected: PASS.

### Task 2: Trade campaign grant and product-scoped idempotency

**Files:**
- Modify: `trade/internal/store/order.go`
- Modify: `trade/internal/store/order_test.go`
- Modify: `trade/internal/logic/placeorder/service.go`
- Modify: `trade/internal/logic/placeorder/service_dianshi_test.go`
- Modify: `trade/internal/httpapi/internalapi/handler.go`
- Modify: `trade/internal/httpapi/internalapi/handler_test.go`

**Interfaces:**
- Changes: `FindReusableDianshiOrder(..., bundleID string, actID int64, createdAfter time.Time)`.
- Produces: `GrantDianshiSubscription(ctx context.Context, req PlaceOrderRequest, actID int64) (*DianshiGrantResult, error)`.
- Produces: `POST /internal/trade/dianshi/subscriptions/grant`.

- [ ] **Step 1: Write failing DAO tests**

Require the reusable-order SQL query to bind `act_id` in addition to user, activity, and bundle. Update test doubles to accept the new parameter.

- [ ] **Step 2: Implement product-scoped order reuse**

Add `AND act_id = ?` to the query and pass `mapping.ActID` from the ordinary and grant paths.

- [ ] **Step 3: Write failing grant logic tests**

Cover invalid `actID`, active mapping copied without mutation, participation hit returning `skipped`, reusable matching order returning `reused`, and a new order persisting the overridden product ID while retaining inventory activity/secret/time span.

- [ ] **Step 4: Implement grant logic**

Extract the shared validation/shadow/bundle/mapping preparation from `PlaceDianshiOrderAndPay`. The ordinary path still errors when the resolver says the request is not Dianshi eligible. The grant path treats an active mapping with an existing participation as `skipped`, clones the mapping, sets only `ActID`, and invokes `placeOrderDianshiAndPay`.

Return one of:

```go
type DianshiGrantResult struct {
    Status     string
    DealName   string
    BigOrderID string
}
```

- [ ] **Step 5: Write and implement internal HTTP tests**

Add a request DTO with existing place-order fields plus `actId`. Assert authentication, input validation, `status`, `dealName`, and `bigOrderId`. Register only the dedicated route:

```go
group.POST("/dianshi/subscriptions/grant", grantDianshiSubscriptionHandler(deps.PlaceOrder))
```

- [ ] **Step 6: Run Trade order and HTTP tests**

Run: `cd trade && go test ./internal/store ./internal/logic/placeorder ./internal/httpapi/internalapi -count=1`

Expected: PASS.

### Task 3: Preserve overridden product ID through callback

**Files:**
- Modify: `trade/internal/logic/placeorder/service.go`
- Modify: `trade/internal/logic/placeorder/service_dianshi_test.go`
- Modify: `trade/internal/logic/createresource/handler.go`
- Modify: `trade/internal/logic/createresource/handler_dianshi_test.go`

**Interfaces:**
- Produces: Dianshi `preference_param.dianshiActId`.
- Changes: participation callback prefers a positive callback `goodsDetail.dianshiActId`, with legacy fallbacks.

- [ ] **Step 1: Write failing request and callback tests**

Assert `DoGoodsAndPay` receives `dianshiActId=142123551192174`. Assert callback participation stores that value even without a `trade_order`, and old callbacks without it store inventory `ActID`.

- [ ] **Step 2: Implement metadata propagation**

Add the effective mapping product ID to `PreferenceParam`. In `insertDianshiParticipation`, resolve product ID with:

```go
actID := int64(extractIntFromGoodsDetail(para.GoodsDetail, "dianshiActId"))
if actID <= 0 {
    actID = int64(extractIntFromGoodsDetail(para.GoodsDetail, "dianshi_act_id"))
}
if actID <= 0 {
    actID = mapping.ActID
}
```

Keep `ActivityID` sourced from inventory and retain the existing duplicate-key behavior.

- [ ] **Step 3: Run callback tests**

Run: `cd trade && go test ./internal/logic/placeorder ./internal/logic/createresource -count=1`

Expected: PASS.

### Task 4: CTL internal grant endpoint

**Files:**
- Modify: `ctl/pkg/adapter/trade/adapter.go`
- Modify: `ctl/pkg/adapter/trade/adapter_test.go`
- Modify: `ctl/pkg/transport/pass.go`
- Modify: `ctl/pkg/logic/pass/logic.go`
- Modify: `ctl/pkg/logic/pass/logic_test.go`
- Modify: `ctl/main/api/pass_handler.go`
- Modify: `ctl/main/api/server.go`
- Create: `ctl/main/api/dianshi_grant_route_test.go`

**Interfaces:**
- Produces: `trade.Adapter.GrantDianshiSubscription(ctx, *GrantDianshiSubscriptionRequest)`.
- Produces: `Logic.GrantDianshiSubscription(userID string, req *transport.GrantDianshiSubscriptionRequest)`.
- Produces: `POST /internal/ctl/subscriptions/dianshi/grant`.

- [ ] **Step 1: Write failing adapter tests and implement adapter**

Use camel-case Trade JSON fields, Bearer auth, and `/internal/trade/dianshi/subscriptions/grant`. Decode `status`, `dealName`, and `bigOrderId`.

- [ ] **Step 2: Write failing logic tests**

Assert the method fixes Pass duration to `1m`, passes `goodsNum=1`, maps `ErrPassAlreadyExists` to `{status:"skipped"}`, and forwards `act_id` to Trade.

- [ ] **Step 3: Implement logic and transport DTOs**

Reuse `prepareCreatePassOrder` with an internal `CreatePassOrderRequest{BundleID:req.BundleID, Period:1, TimeUnit:"m"}`. Only `ErrPassAlreadyExists` is converted to a successful skip; all other validation and adapter errors remain errors.

- [ ] **Step 4: Write failing route tests and implement route**

Require `Authorization: Bearer <CTL_INTERNAL_TOKEN>`, POST only, and body `{external_user_id,bundle_id,act_id}`. Register the exact path in `server.go` and add it to `normalizePath` if required by the metrics tests.

- [ ] **Step 5: Run CTL tests**

Run: `cd ctl && go test ./pkg/adapter/trade ./pkg/logic/pass ./main/api -count=1`

Expected: PASS.

### Task 5: Batch orchestration script

**Files:**
- Create: `scripts/grant_dianshi_subscriptions.py`
- Create: `scripts/tests/test_grant_dianshi_subscriptions.py`

**Interfaces:**
- Consumes: Auth register-or-retry, Auth binding-state, and CTL grant endpoints.
- Produces: JSONL per-user results and a process exit code.

- [ ] **Step 1: Write failing unittest cases**

Use `http.server.ThreadingHTTPServer` as a fake backend. Cover comments/blanks/deduplication, malformed IDs, active polling, terminal Auth failure, CTL skip, continuation after failure, token headers, and final exit status.

- [ ] **Step 2: Run tests and verify failure**

Run: `python3 -m unittest scripts.tests.test_grant_dianshi_subscriptions -v`

Expected: FAIL because the script module does not exist.

- [ ] **Step 3: Implement the standard-library script**

Use `argparse`, `urllib.request`, `json`, and `time`. Read token from `LIGHTCLAW_INTERNAL_SERVICE_TOKEN`, never include headers in output, poll with bounded `--timeout` and `--poll-interval`, preserve input order, and continue after each per-user error.

- [ ] **Step 4: Run script tests**

Run: `python3 -m unittest scripts.tests.test_grant_dianshi_subscriptions -v`

Expected: PASS.

### Task 6: Cross-service verification

**Files:**
- Verify all modified files from Tasks 1-5.

- [ ] **Step 1: Format code**

Run `gofmt` on modified Go files and `python3 -m py_compile scripts/grant_dianshi_subscriptions.py`.

- [ ] **Step 2: Run targeted suites**

Run:

```bash
cd user/auth && go test ./internal/service ./internal/httpapi -count=1
cd trade && go test ./internal/store ./internal/logic/placeorder ./internal/logic/createresource ./internal/httpapi/internalapi -count=1
cd ctl && go test ./pkg/adapter/trade ./pkg/logic/pass ./main/api -count=1
python3 -m unittest scripts.tests.test_grant_dianshi_subscriptions -v
```

Expected: all PASS.

- [ ] **Step 3: Run broader service tests**

Run `go test ./...` separately in `user/auth`, `trade`, and `ctl`. Record any unrelated pre-existing failures rather than hiding them.

- [ ] **Step 4: Review the diff for secrets and inventory changes**

Run `git diff --check`, verify no secret literal is present, and verify no migration, seed, or `trade_bundle_activity` runtime mutation was added.
