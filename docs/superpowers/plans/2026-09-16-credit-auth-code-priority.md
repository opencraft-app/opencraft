# Credit Auth Code Priority Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Credit payment-link authentication prefer the order-bound `auth_code` over an OAuth-injected `X-User-Id`.

**Architecture:** Keep the existing dual-auth endpoint and ticket validation, but reverse only the credential selection order to match Pass. An explicit regression test covers requests carrying both credentials, while a separate fallback test preserves the authenticated PC flow when no ticket is supplied.

**Tech Stack:** Go, `net/http`, Redis-backed Credit auth-code store, Go testing.

## Global Constraints

- A non-empty `auth_code` must be consumed and validated before considering `X-User-Id`.
- `X-User-Id` remains the fallback only when `auth_code` is absent.
- Invalid, expired, replayed, or mismatched tickets must not fall back to the header.
- Order ownership and existing HTTP status semantics remain unchanged.

---

### Task 1: Fix Credit order-url authentication precedence

**Files:**
- Modify: `credit/internal/httpapi/server_test.go`
- Modify: `credit/internal/httpapi/server.go`
- Modify: `credit/AGENTS.md`
- Modify: `docs/engineering/journeys/subscription-purchase-renewal.md`
- Modify: `docs/frontend-credit-package-integration.md`

**Interfaces:**
- Consumes: `authcode.Store.Consume(context.Context, string)` and trusted `X-User-Id` headers.
- Produces: The effective `external_user_id` passed to `trade.GeneratePayURL`.

- [ ] **Step 1: Add the failing precedence regression test**

Change the existing both-credentials test so the ticket belongs to `usr-ticket-owner`, the header contains `usr-scanner`, and the expected Trade request uses `usr-ticket-owner` after consuming the ticket exactly once.

- [ ] **Step 2: Verify the old implementation fails**

Run: `go test ./internal/httpapi -run 'TestUserOrderURL(AuthCodePrecedesTrustedHeader|UsesTrustedHeaderWithoutAuthCode)' -count=1 -v`

Expected: the precedence test fails because the current implementation uses `usr-scanner` and does not consume the ticket.

- [ ] **Step 3: Implement auth-code-first resolution**

Trim `auth_code`; when present, require the auth store, consume and validate the ticket, and return its user. Only after the code branch is absent should the resolver read `X-User-Id`.

- [ ] **Step 4: Update service documentation**

Document that `auth_code` wins when both credentials are present and that the login header is only a compatibility fallback.

- [ ] **Step 5: Verify Credit**

Run:

```bash
go test ./internal/httpapi -count=1
go test ./... -count=1
git diff --check
```

Expected: all commands pass.
