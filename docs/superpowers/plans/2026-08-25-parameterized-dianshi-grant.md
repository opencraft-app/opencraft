# Parameterized Dianshi Grant Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the one-off Dianshi subscription grant accept all campaign parameters from the script and remove its dependency on `trade_bundle_activity` configuration.

**Architecture:** The script requires bundle, activity, product, and time-span arguments and reads the campaign secret from `DIANSHI_ACTIVITY_SECRET_KEY`. CTL validates and forwards these fields with its prepared Pass order. Trade resolves only user and bundle fundamentals, checks participation by the requested activity ID, builds an in-memory campaign mapping, and calls the existing Dianshi order-and-pay implementation.

**Tech Stack:** Python 3 standard library, Go, Gin, net/http, database/sql, unittest, Go testing.

## Global Constraints

- Do not read or mutate `trade_bundle_activity` in the dedicated grant request path.
- Keep ordinary Dianshi inquiry and purchase behavior unchanged.
- Keep `(uin, activity_id)` participation idempotency and product-scoped reusable-order idempotency.
- Require the campaign secret from `DIANSHI_ACTIVITY_SECRET_KEY`; never print, persist, or return it.
- Use `bundle_launch_ai_01`, activity ID `165523570799387`, product ID `142163399386388`, and time span `1m` for the first SG validation.
- Implement inline in the current task; do not dispatch subagents.

---

### Task 1: Parameterize the batch script

**Files:**
- Modify: `scripts/grant_dianshi_subscriptions.py`
- Modify: `scripts/tests/test_grant_dianshi_subscriptions.py`

**Interfaces:**
- Consumes: required `--bundle-id`, `--activity-id`, `--act-id`, and `--time-span-unit` arguments.
- Consumes: required `DIANSHI_ACTIVITY_SECRET_KEY` environment variable.
- Produces: CTL JSON fields `bundle_id`, `activity_id`, `act_id`, `time_span_unit`, and `secret_key`.

- [ ] **Step 1: Write failing script tests**

Assert the grant request contains every explicit campaign field and that argument parsing has no stale campaign defaults. Assert an empty `DIANSHI_ACTIVITY_SECRET_KEY` exits before any request.

- [ ] **Step 2: Run the tests and verify the expected failure**

Run: `python3 -m unittest scripts.tests.test_grant_dianshi_subscriptions -v`

Expected: FAIL because the client and parser do not accept activity ID, time-span unit, or campaign secret.

- [ ] **Step 3: Implement the script contract**

Change the grant call to send:

```python
{
    "external_user_id": user_id,
    "bundle_id": bundle_id,
    "activity_id": activity_id,
    "act_id": act_id,
    "time_span_unit": time_span_unit,
    "secret_key": secret_key,
}
```

Make all non-secret campaign fields required CLI arguments. Read the secret only from `DIANSHI_ACTIVITY_SECRET_KEY` and fail before processing when it is empty.

- [ ] **Step 4: Run script tests**

Run: `python3 -m unittest scripts.tests.test_grant_dianshi_subscriptions -v`

Expected: PASS.

### Task 2: Propagate and validate campaign fields in CTL

**Files:**
- Modify: `ctl/pkg/transport/pass.go`
- Modify: `ctl/pkg/adapter/trade/adapter.go`
- Modify: `ctl/pkg/adapter/trade/adapter_test.go`
- Modify: `ctl/pkg/logic/pass/logic.go`
- Modify: `ctl/main/api/dianshi_grant_route_test.go`

**Interfaces:**
- Changes: `transport.GrantDianshiSubscriptionRequest` adds `ActivityID`, `TimeSpanUnit`, and `SecretKey`.
- Changes: `tradeadapter.GrantDianshiSubscriptionRequest` adds camel-case JSON `activityId`, `timeSpanUnit`, and `secretKey`.
- Produces: `parseDianshiTimeSpanUnit(string) (period int, timeUnit string, err error)`.

- [ ] **Step 1: Write failing route, adapter, and logic tests**

Assert missing activity ID, product ID, time-span unit, or secret is rejected. Assert `1m` prepares `period=1,timeUnit=m` and every campaign field is forwarded unchanged.

- [ ] **Step 2: Run tests and verify the expected failure**

Run: `cd ctl && GOWORK=off go test ./main/api ./pkg/adapter/trade ./pkg/logic/pass -run 'DianshiGrant|GrantDianshi' -count=1`

Expected: FAIL because the request DTOs and parser do not contain the new fields.

- [ ] **Step 3: Implement CTL validation and propagation**

Parse `time_span_unit` using `^([1-9][0-9]*)([A-Za-z]+)$`, normalize the unit to lowercase, and let existing Pass validation reject unsupported units. Treat the secret as opaque and never log it.

- [ ] **Step 4: Run CTL tests**

Run: `cd ctl && GOWORK=off go test ./main/api ./pkg/adapter/trade ./pkg/logic/pass -count=1`

Expected: PASS.

### Task 3: Remove activity mapping lookup from the Trade grant path

**Files:**
- Modify: `trade/cmd/trade/main.go`
- Modify: `trade/internal/logic/placeorder/service.go`
- Modify: `trade/internal/logic/placeorder/service_dianshi_test.go`
- Modify: `trade/internal/httpapi/internalapi/handler.go`
- Modify: `trade/internal/httpapi/internalapi/handler_test.go`

**Interfaces:**
- Produces: `DianshiGrantCampaign{ActivityID, ActID int64; TimeSpanUnit, SecretKey string}`.
- Changes: `GrantDianshiSubscription(ctx, PlaceOrderRequest, DianshiGrantCampaign)`.
- Adds: a narrow participation reader dependency with `HasUserParticipated(context.Context, string, int64) (bool, error)`.

- [ ] **Step 1: Write failing Trade tests**

Use a resolver that fails if called. Assert the dedicated grant succeeds without it, checks participation with the requested activity ID, sends the explicit activity/product/time span, calculates a non-empty checksum, and does not mutate or require an inventory mapping.

- [ ] **Step 2: Run tests and verify the expected failure**

Run: `cd trade && GOWORK=off go test ./internal/logic/placeorder ./internal/httpapi/internalapi -run 'GrantDianshi' -count=1`

Expected: FAIL because the existing method still resolves `trade_bundle_activity`.

- [ ] **Step 3: Implement the request-scoped campaign path**

Extract shared order fundamentals for request validation, shadow binding, online CTL bundle, and Trade bundle definition. The ordinary path then invokes `ActivityResolver`; the grant path invokes the participation reader with the explicit activity ID and constructs:

```go
mapping := &activity.Mapping{
    BundleID:         req.BundleID,
    ActivityID:       campaign.ActivityID,
    ActID:            campaign.ActID,
    SecretKey:        campaign.SecretKey,
    Active:           true,
    TimeSpanUnit:     campaign.TimeSpanUnit,
    OrderExpiredTime: 1,
}
```

Never include `SecretKey` in logs, results, or persisted goods detail.

- [ ] **Step 4: Run Trade grant tests**

Run: `cd trade && GOWORK=off go test ./internal/logic/placeorder ./internal/httpapi/internalapi -run 'GrantDianshi' -count=1`

Expected: PASS.

### Task 4: Make callback participation independent of the mapping row

**Files:**
- Modify: `trade/internal/logic/createresource/handler.go`
- Modify: `trade/internal/logic/createresource/handler_dianshi_test.go`

**Interfaces:**
- Consumes: callback `goodsDetail.dianshi_activity_id` and `goodsDetail.dianshiActId`.
- Preserves: inventory lookup only as a legacy fallback when callback metadata is absent.

- [ ] **Step 1: Write a failing callback test**

Make `GetBundleActivityByBundleID` fail and provide positive request-scoped activity/product IDs in `goodsDetail`. Assert participation insertion succeeds with those IDs.

- [ ] **Step 2: Run the test and verify the expected failure**

Run: `cd trade && GOWORK=off go test ./internal/logic/createresource -run 'DianshiCallback.*RequestScoped' -count=1`

Expected: FAIL because callback handling unconditionally loads `trade_bundle_activity`.

- [ ] **Step 3: Implement request metadata precedence**

Read both positive IDs from `goodsDetail`. Only query `trade_bundle_activity` when either ID is absent, preserving legacy callback behavior. Insert participation with the effective IDs.

- [ ] **Step 4: Run callback tests**

Run: `cd trade && GOWORK=off go test ./internal/logic/createresource -count=1`

Expected: PASS.

### Task 5: Verification and release preparation

**Files:**
- Verify all files modified by Tasks 1-4.
- Modify: `docs/superpowers/specs/2026-08-25-batch-dianshi-subscription-grant-design.md`

- [ ] **Step 1: Format and compile**

Run `gofmt` on modified Go files and `python3 -m py_compile scripts/grant_dianshi_subscriptions.py scripts/tests/test_grant_dianshi_subscriptions.py`.

- [ ] **Step 2: Run focused and service tests**

Run the focused suites from Tasks 1-4, then run `GOWORK=off go test ./... -count=1` in `trade` and `ctl`, and the Python unittest suite.

- [ ] **Step 3: Review security and scope**

Run `git diff --check`. Verify no campaign secret literal, seed, migration, SOPS file, or runtime inventory mutation is present. Verify ordinary inquiry and purchase paths still invoke `ActivityResolver`.

- [ ] **Step 4: Present the diff before commit**

Show the exact changed files, test evidence, commit title, source branch, and target MR. Wait for explicit confirmation before `git commit` and `git push`.
