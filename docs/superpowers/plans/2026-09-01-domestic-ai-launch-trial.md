# Domestic AI Launch Trial Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make domestic `bundle_launch_ai_01` point-stone inquiries use the requested monthly or quarterly period while retaining DB-controlled order duration.

**Architecture:** Extend the existing exact bundle allowlist in the trade inquiry helper so Launch AI follows the same request-period behavior as Launch regardless of site. Keep place-order production logic unchanged and add regression coverage proving a future DB value of `3d` is honored during ordering.

**Tech Stack:** Go, standard `testing` package, trade inquiry/placeorder services.

## Global Constraints

- Only `bundle_launch_ai_01` loses its domestic/international branch; behavior for every other bundle remains unchanged.
- A `1m` request must inquire with `1m`; a `3m` request must inquire with `3m`.
- Order duration must continue to come from `trade_bundle_activity.time_span_unit`.
- Do not change frontend code, DB migrations, or live DB data.

---

### Task 1: Domestic Launch AI inquiry period

**Files:**
- Modify: `trade/internal/logic/inquiry/service_dianshi_test.go`
- Modify: `trade/internal/logic/inquiry/service.go`

**Interfaces:**
- Consumes: `dianshiInquiryTimeSpanUnit(req QuoteRequest, mapping *activity.Mapping, siteKind string) string`
- Produces: `dianshiInquiryTimeSpanUnit(req QuoteRequest, mapping *activity.Mapping) string`, with exact allowlist behavior for Launch and Launch AI.

- [x] **Step 1: Write the failing domestic monthly test**

Change the domestic Launch AI test so its mapping uses `TimeSpanUnit: "3d"` and asserts that a `TimeSpan: 1, TimeUnit: "m"` request sends `preference_param.timeSpanUnit == "1m"`.

- [x] **Step 2: Run the focused test and verify RED**

Run:

```bash
cd trade && go test ./internal/logic/inquiry -run DomesticLaunchAIBundle -count=1
```

Expected: FAIL because current domestic behavior sends the mapped `3d` value.

- [x] **Step 3: Implement the exact bundle allowlist**

Update the helper and its call site so only these exact IDs use the requested period:

```go
useRequestPeriod := mapping.BundleID == dianshiLaunchBundleID ||
	mapping.BundleID == dianshiLaunchAIBundleID
```

Remove the now-unused `siteKind` helper argument. Do not alter resolver selection or any other bundle logic.

- [x] **Step 4: Add quarterly and isolation regression tests**

Add a domestic Launch AI case with `TimeSpan: 3, TimeUnit: "m"` and assert `3m`. Retain the existing non-Launch test that asserts its mapped activity duration is used.

- [x] **Step 5: Run inquiry tests and verify GREEN**

Run:

```bash
cd trade && go test ./internal/logic/inquiry -count=1
```

Expected: PASS.

### Task 2: Three-day DB order-duration regression

**Files:**
- Modify: `trade/internal/logic/placeorder/service_dianshi_test.go`

**Interfaces:**
- Consumes: existing `placeOrderDianshi` duration parsing from `activity.Mapping.TimeSpanUnit`.
- Produces: regression evidence that `3d` reaches point-stone and persisted order fields unchanged.

- [x] **Step 1: Add a three-day place-order test**

Construct the existing point-stone test dependencies, set `r.mapping.BundleID = "bundle_launch_ai_01"` and `r.mapping.TimeSpanUnit = "3d"`, place an order, then assert:

```go
prefParam["timeSpanUnit"] == "3d"
order.Period == 3
order.TimeUnit == "d"
order.GoodsDetail["timeSpan"] == 3
order.GoodsDetail["timeUnit"] == "d"
```

- [x] **Step 2: Run the focused place-order test**

Run:

```bash
cd trade && go test ./internal/logic/placeorder -run LaunchAIBundleUsesActivityDuration -count=1
```

Expected: PASS, confirming existing order logic already supports the future DB value.

- [x] **Step 3: Run formatting and full focused verification**

Run:

```bash
gofmt -w trade/internal/logic/inquiry/service.go trade/internal/logic/inquiry/service_dianshi_test.go trade/internal/logic/placeorder/service_dianshi_test.go
cd trade && go test ./internal/logic/inquiry ./internal/logic/placeorder -count=1
cd trade && go test ./... -count=1
```

Expected: all tests PASS.

- [x] **Step 4: Review the diff**

Run:

```bash
git diff --check
git diff -- trade/internal/logic/inquiry/service.go trade/internal/logic/inquiry/service_dianshi_test.go trade/internal/logic/placeorder/service_dianshi_test.go
```

Expected: no whitespace errors; no frontend, migration, deployment, or DB changes.
