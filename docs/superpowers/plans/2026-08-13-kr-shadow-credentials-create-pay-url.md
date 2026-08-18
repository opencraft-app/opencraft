# KR Shadow Credentials CreatePayUrl Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sign international `CreatePayUrl` requests with the order owner's short-lived shadow-account credentials.

**Architecture:** `lightclaw-auth` remains the owner of the shadow-account exchange flow. An authenticated internal endpoint issues a one-time auth code, exchanges it through CAM and STS, validates the resulting UIN against the active binding, and returns only short-lived credentials. `trade` fetches those credentials just in time for an international pay URL request and uses `common.NewTokenCredential` for that single Billing CloudAPI call.

**Tech Stack:** Go, Gin, Tencent Cloud Go SDK, existing internal Bearer-token authentication, Go unit tests.

## Global Constraints

- Do not persist or log temporary `SecretId`, `SecretKey`, SaaS token, or session token.
- Reject credentials whose UIN or owner UIN does not match the active shadow binding.
- Keep domestic pay URL generation on the existing jifei path.
- Deploy only by committing and pushing to `playground/sandbox-kr-1`; do not mutate the live cluster directly.

---

### Task 1: Auth shadow credential exchange

**Files:**
- Modify: `user/auth/internal/shadowbinding/types.go`
- Modify: `user/auth/internal/shadowbinding/tencentcloud.go`
- Modify: `user/auth/internal/shadowbinding/unavailable.go`
- Modify: `user/auth/internal/shadowbinding/service.go`
- Test: `user/auth/internal/shadowbinding/service_test.go`

**Interfaces:**
- Produces: `TencentCloudClient.GetTemporaryCredentialsForSaaS(ctx, CloudTemporaryCredentialsInput) (CloudTemporaryCredentials, error)`.
- Produces: `Service.IssueTemporaryCredentials(ctx, userID, clientIP, clientUA) (CloudTemporaryCredentials, error)`.

- [ ] **Step 1: Write failing service tests**

Add tests proving an active binding receives temporary credentials and that mismatched UIN credentials are rejected. The recording cloud client returns:

```go
CloudTemporaryCredentials{
    Uin: 300000000053, OwnerUin: 300000000053,
    TmpSecretID: "tmp-id", TmpSecretKey: "tmp-key", Token: "tmp-token",
}
```

- [ ] **Step 2: Verify the tests fail**

Run: `GOWORK=off go test ./internal/shadowbinding -run 'TestIssueTemporaryCredentials'`

Expected: compile failure because the new method and types do not exist.

- [ ] **Step 3: Implement the exchange**

Add a cloud-client method that calls existing `getSaaSTokenByAuthCode` and `getSaaSAccessToken`, propagating UIN metadata. Add a service method that loads an active binding, issues an external auth code, invokes the cloud client, checks UIN/owner UIN, and validates non-empty temporary credential fields.

- [ ] **Step 4: Verify auth shadowbinding tests pass**

Run: `GOWORK=off go test ./internal/shadowbinding`

Expected: PASS.

### Task 2: Auth internal credentials endpoint

**Files:**
- Modify: `user/auth/internal/service/service.go`
- Modify: `user/auth/internal/httpapi/internal_shadow.go`
- Test: `user/auth/internal/httpapi/internal_shadow_test.go`

**Interfaces:**
- Consumes: `shadowbinding.Service.IssueTemporaryCredentials` from Task 1.
- Produces: `POST /internal/shadow/credentials` authenticated by `SHADOW_BINDING_INTERNAL_TOKEN`.

- [ ] **Step 1: Write failing HTTP tests**

Test unauthorized access, successful credentials issuance for `external_user_id`, and response fields `uin`, `owner_uin`, `tmp_secret_id`, `tmp_secret_key`, `token`, and `expired_at`.

- [ ] **Step 2: Verify the tests fail**

Run: `GOWORK=off go test ./internal/httpapi -run 'TestInternalShadowCredentials'`

Expected: 404 because the route is not registered.

- [ ] **Step 3: Implement the endpoint**

Register the POST route beside the existing binding lookup, reuse Bearer-token authorization, validate `external_user_id`, and call the service with request client metadata. Return secrets only in the success response and never include them in logs or errors.

- [ ] **Step 4: Verify auth tests pass**

Run: `GOWORK=off go test ./internal/shadowbinding ./internal/service ./internal/httpapi`

Expected: PASS.

### Task 3: Trade shadow credential client

**Files:**
- Modify: `trade/internal/shadowclient/client.go`
- Test: `trade/internal/shadowclient/client_test.go`

**Interfaces:**
- Produces: separate `CredentialClient` interface with `GetTemporaryCredentialsByExternalUserID` so existing binding-only fakes remain compatible.

- [ ] **Step 1: Write failing HTTP client tests**

Verify POST path, Bearer token, request JSON, successful secret decoding, unauthorized mapping, and invalid/empty credential rejection.

- [ ] **Step 2: Verify the tests fail**

Run: `GOWORK=off go test ./internal/shadowclient -run 'TestGetTemporaryCredentials'`

Expected: compile failure because `CredentialClient` is absent.

- [ ] **Step 3: Implement the client method**

Reuse the existing HTTP client, envelope parser, timeout, and typed error conventions without logging response bodies on credential responses.

- [ ] **Step 4: Verify shadowclient tests pass**

Run: `GOWORK=off go test ./internal/shadowclient`

Expected: PASS.

### Task 4: Billing request uses temporary credentials

**Files:**
- Modify: `trade/internal/cloudbillingclient/client.go`
- Modify: `trade/internal/cloudbillingclient/client_test.go`
- Modify: `trade/internal/logic/placeorder/service.go`
- Modify: `trade/internal/logic/placeorder/service_test.go`
- Modify: `trade/cmd/trade/main.go`

**Interfaces:**
- Consumes: `shadowclient.CredentialClient` from Task 3.
- Produces: `cloudbillingclient.Client.CreatePayURL(ctx, credentials, request)` using `common.NewTokenCredential`.

- [ ] **Step 1: Write failing Billing and placeorder tests**

Verify `CreatePayUrl` is signed with all three temporary credential fields; international pay URL generation fetches credentials using `order.ExternalUserID`; mismatched order and credential UIN fails before Billing is called; domestic behavior does not fetch credentials.

- [ ] **Step 2: Verify the tests fail**

Run: `GOWORK=off go test ./internal/cloudbillingclient ./internal/logic/placeorder`

Expected: compile/test failure against the old static-credential API.

- [ ] **Step 3: Implement just-in-time signing**

Store endpoint/profile/transport configuration in the Billing client, build a Tencent Cloud SDK client per call with `common.NewTokenCredential`, inject the credential resolver into placeorder, fetch credentials only on the international cache-miss path, and retain the configured `X-Qcloud-User-Id` routing header.

- [ ] **Step 4: Verify trade tests pass**

Run: `GOWORK=off go test ./internal/cloudbillingclient ./internal/shadowclient ./internal/logic/placeorder ./cmd/trade`

Expected: PASS.

### Task 5: Regression verification and delivery

**Files:**
- Review all modified files from Tasks 1-4.

- [ ] **Step 1: Format and test both modules**

Run `gofmt` on modified Go files, then:

```bash
cd user/auth && GOWORK=off go test ./...
cd trade && GOWORK=off go test ./...
```

Expected: PASS.

- [ ] **Step 2: Inspect secret safety and diff scope**

Run `git diff --check`, inspect `git diff`, and confirm no temporary credential values are logged, persisted, or included in error bodies.

- [ ] **Step 3: Present the exact commit scope for approval**

Show changed files, test results, and proposed commit message. Wait for explicit user confirmation before `git commit` or `git push`.
