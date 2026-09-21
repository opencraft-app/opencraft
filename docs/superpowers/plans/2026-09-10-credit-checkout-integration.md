# Credit Checkout Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the user-facing Credit checkout flow with a secured payment URL endpoint and a frontend integration guide.

**Architecture:** Credit remains the only public service for credit-package checkout. It forwards the authenticated user and payment presentation options to Trade's existing pay URL endpoint; Trade verifies both order ownership and `resource_type=credit_package` before returning payment details. Service Gateway exposes only the explicit Credit path allowlist.

**Tech Stack:** Go, `net/http`, Gin, YAML route policy, Markdown.

## Global Constraints

- The console flow is product list -> inquiry -> order -> payment URL -> payment -> package query.
- `/v1/credit/packages/order-and-pay` remains an internal integration-test shortcut and is excluded from the console flow.
- Payment URL lookup must not return another user's order or a non-Credit order.
- Refunds, billing callbacks, usage reporting, and lifecycle workers are outside the frontend guide.

---

### Task 1: Secure Trade Pay URL Lookup

**Files:**
- Modify: `trade/internal/logic/placeorder/service.go`
- Modify: `trade/internal/httpapi/internalapi/handler.go`
- Test: `trade/internal/httpapi/internalapi/handler_test.go`

**Interfaces:**
- Consumes: `POST /internal/trade/orders/{dealName}/pay-url`
- Produces: optional `expected_resource_type` checkout binding enforced together with `external_user_id`

- [x] Add a failing handler test proving mismatched owner or resource type returns `404 OrderNotFound` before a cached payment URL is exposed.
- [x] Run the focused test and confirm it fails against the current implementation.
- [x] Add `ExpectedResourceType` to `GeneratePayURLOptions`, parse `expected_resource_type`, and validate the loaded order.
- [x] Run the focused and package tests.

### Task 2: Add the Credit Payment URL Endpoint

**Files:**
- Modify: `credit/internal/tradeclient/client.go`
- Modify: `credit/internal/tradeclient/client_test.go`
- Modify: `credit/internal/httpapi/server.go`
- Modify: `credit/internal/httpapi/server_test.go`

**Interfaces:**
- Consumes: authenticated `X-User-Id`, `deal_name`, and optional payment presentation fields
- Produces: `POST /v1/credit/packages/order-url` returning snake-case payment details

- [x] Add failing client and HTTP tests for request forwarding, trusted identity, resource-type binding, and response shape.
- [x] Run the focused tests and confirm failures are caused by the missing endpoint and client method.
- [x] Implement typed `PayURLRequest` and `PayURLResult`, then register and implement the public handler.
- [x] Run all Credit tests.

### Task 3: Expose the Route and Document the Frontend Flow

**Files:**
- Modify: `service-gateway/internal/gateway/config_policy_test.go`
- Modify: `argocd/services/service-gateway/sandbox-bj-7/config.yaml`
- Modify: `argocd/services/service-gateway/beijing-sandbox/config.yaml`
- Modify: `credit/AGENTS.md`
- Create: `docs/frontend-credit-package-integration.md`

**Interfaces:**
- Produces: authenticated and real-name-gated Service Gateway access to `/v1/credit/packages/order-url`

- [x] Update the policy expectation first and confirm both environment tests fail because the route is absent.
- [x] Add the route to Beijing 7 and Beijing sandbox allowlists.
- [x] Document product query, inquiry, order, payment URL, and package query with executable curl and JSON examples.
- [x] Run focused Service Gateway policy tests and scan the document for placeholders or internal-only workflow leakage.

### Task 4: Verification

- [x] Run `gofmt` on modified Go files.
- [x] Run `cd credit && go test ./...`.
- [x] Run focused Trade tests, followed by `cd trade && go test ./...` when disk permits.
- [x] Run focused Service Gateway policy tests and the full package test in an environment that permits `httptest` listeners.
- [x] Review `git diff --check`, `git status`, and the final diff.

## 2026-09-11 Follow-up: Sessionless Payment Bridge

The original checkout endpoint assumed that the payment bridge retained the
LightVela session. Credit now follows the Pass ticket model: package order
responses include a Redis-backed, ten-minute, one-time `auth_code` bound to
the authenticated user and `dealName`. Service Gateway permits anonymous
access only to `POST /v1/credit/packages/order-url`; Credit atomically consumes
the ticket when no trusted `X-User-Id` is present and then applies the existing
Trade owner and `credit_package` checks. Authenticated requests retain priority
and do not consume a supplied ticket. The detailed design and execution plan
are in `2026-09-11-credit-auth-code-design.md` and
`2026-09-11-credit-auth-code.md`.
