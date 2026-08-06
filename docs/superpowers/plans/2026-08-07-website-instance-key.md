# Website Instance Key Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow each Hermes CVM to call only Vela static-website APIs with a permanent, per-instance credential delivered through a reusable parameterized Tencent TAT command.

**Architecture:** CTL owns issuance and validation because it already has authoritative instance ownership in MySQL and the main Redis client. Service Gateway exposes a separate `/v1/instance/websites` route with an exact path allowlist and rewrites it to the existing CTL handlers, while browser traffic continues to use `/v1/websites` with session authentication. TAT stores the credential in a service-scoped environment file and injects it into the existing Hermes systemd user service.

**Tech Stack:** Go 1.x, `go-redis/v9`, MySQL/GORM, Service Gateway YAML routing, Bash, Tencent Cloud TAT `CreateCommand`/`InvokeCommand`, Markdown Agent Skill.

## Global Constraints

- Token format is `vwk_<key_id>_<secret>` where both variable components are base64url without padding.
- `key_id` is 16 random bytes and `secret` is 32 random bytes.
- Redis stores a random salt and `SHA-256(salt || secret)`, never the plaintext token.
- Keys have no TTL and remain active until explicitly revoked or the bound instance is no longer valid.
- Validation derives `user_id` and `instance_id` from the key binding; client identity headers are never trusted.
- Instance credentials authorize only the exact website routes used by the static-site Skill.
- Browser `/v1/websites` session authentication remains unchanged.
- `/v1/passes` is not exposed to instance credentials; site creation derives the current bundle when `bundle_id` is omitted.
- TAT uses `{{tat-hidden:website_key}}`; no secret is placed in command defaults, stdout, summaries, repository files, or logs.
- No database migration, image rebuild, live TAT invocation, Redis mutation, deployment, commit, or push is part of local implementation.

---

### Task 1: Redis-backed instance credential store

**Files:**
- Create: `ctl/pkg/websiteauth/store.go`
- Create: `ctl/pkg/websiteauth/store_test.go`

**Interfaces:**
- Produces: `Store.Issue(ctx, userID, instanceID) (plainToken string, binding Binding, error)`
- Produces: `Store.Validate(ctx, plainToken) (*Binding, error)`
- Produces: `Store.Revoke(ctx, keyID) error` and `Store.RevokeInstance(ctx, instanceID) error`

- [ ] **Step 1: Write failing tests for issue, validation, malformed tokens, wrong secret, revocation, and no expiry**

Use `miniredis` through the repository test helper. Assert that Redis contains only salt/hash/binding metadata and that the key has no TTL.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `cd ctl && go test ./pkg/websiteauth -count=1`

Expected: FAIL because package `websiteauth` does not exist.

- [ ] **Step 3: Implement the minimal store**

Use Redis keys `website:instance-key:<key_id>` and `website:instance-keys:<instance_id>`. Use a transaction pipeline to write the binding and instance index. Parse and compare hashes with `crypto/subtle.ConstantTimeCompare`.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `cd ctl && go test ./pkg/websiteauth -count=1`

Expected: PASS.

### Task 2: CTL issuance and website request authentication

**Files:**
- Create: `ctl/main/api/website_credential_handler.go`
- Create: `ctl/main/api/website_credential_handler_test.go`
- Modify: `ctl/main/api/server.go`
- Modify: `ctl/main/api/website_handler.go`
- Modify: `ctl/main/api/server_test.go`

**Interfaces:**
- Consumes: `websiteauth.Store`
- Produces: internal issue/revoke routes under `/internal/ctl/instances/{instance_id}/website-credential`
- Produces: website middleware accepting either trusted `X-User-Id` or `Authorization: Vela-Instance-Key <token>`

- [ ] **Step 1: Write failing handler tests**

Cover missing/invalid `CTL_INTERNAL_TOKEN`, instance not found, one-time plaintext response, valid instance key injection, malformed scheme, spoofed identity headers, Redis failure, and binding/instance ownership mismatch.

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `cd ctl && go test ./main/api -run 'WebsiteCredential|WebsiteInstanceAuth' -count=1`

Expected: FAIL because the credential handler and middleware are absent.

- [ ] **Step 3: Implement handlers and middleware**

Use `resource.RedisMainClient`, derive the binding from the instance row, fail closed when Redis is unavailable, and re-check that the bound instance row still exists with the same user before accepting a key. Register internal routes without exposing them through Service Gateway.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run: `cd ctl && go test ./main/api -run 'WebsiteCredential|WebsiteInstanceAuth' -count=1`

Expected: PASS.

### Task 3: Remove the Skill dependency on `/v1/passes`

**Files:**
- Modify: `ctl/main/api/website_handler.go`
- Modify: `ctl/pkg/logic/website/logic.go`
- Modify: `ctl/pkg/logic/website/logic_test.go`

**Interfaces:**
- Produces: `CreateSite` accepts an empty `bundleID` and derives the active pass bundle server-side.

- [ ] **Step 1: Write a failing test for empty `bundle_id`**

Assert that a user with an active pass can create a site without sending `bundle_id`, while a non-empty wrong bundle still returns `WEBSITE_INVALID_PARAM`.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `cd ctl && go test ./pkg/logic/website ./main/api -run 'CreateSite.*Bundle|WebsiteCreate.*Bundle' -count=1`

Expected: FAIL because the handler currently rejects an empty bundle.

- [ ] **Step 3: Implement server-side bundle derivation**

Remove the handler-level required check. After loading the active pass in `CreateSite`, set `bundleID = p.BundleID` only when the request value is empty; retain mismatch rejection for non-empty values.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `cd ctl && go test ./pkg/logic/website ./main/api -run 'CreateSite.*Bundle|WebsiteCreate.*Bundle' -count=1`

Expected: PASS.

### Task 4: Separate Service Gateway instance website route

**Files:**
- Modify: `argocd/services/service-gateway/beijing-sandbox/config.yaml`
- Modify: `argocd/services/service-gateway/shprod/config.yaml`
- Modify: `argocd/services/service-gateway/sgprod/config.yaml`
- Modify: `service-gateway/internal/gateway/config_policy_test.go`
- Modify: `service-gateway/internal/gateway/server_test.go`

**Interfaces:**
- Produces: public `/v1/instance/websites` route rewritten to `/v1/websites`
- Preserves: authenticated browser `/v1/websites` route

- [ ] **Step 1: Write failing route contract tests**

Require the instance route in all three environments, `access: public`, `path_policy: allowlist`, rewrite prefix `/v1/websites`, and exactly the Skill's GET/POST/DELETE path set. Assert identity headers are stripped and `Authorization` is preserved.

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `cd service-gateway && go test ./internal/gateway -run 'WebsiteInstance|Config.*Website' -count=1`

Expected: FAIL because the route is absent.

- [ ] **Step 3: Add the route and exact allowlist**

Keep `/v1/websites` authenticated. Add only capability, site CRUD, release create/list, and operation status paths under `/v1/instance/websites`.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run: `cd service-gateway && go test ./internal/gateway -run 'WebsiteInstance|Config.*Website' -count=1`

Expected: PASS.

### Task 5: Parameterized TAT credential delivery

**Files:**
- Create: `images/helpers/install-hermes-website-credential.sh`
- Create: `.ci/runtime/commands/create_hermes_website_credential_command.sh`
- Create: `.ci/runtime/commands/invoke_hermes_website_credential_command.sh`
- Create: `images/tests/test-hermes-website-credential-scripts.sh`
- Modify: `images/README.md`

**Interfaces:**
- Command template parameters: `website_key` as `{{tat-hidden:website_key}}`, `api_base` as `{{api_base}}`
- Target file: `/etc/vela/website-credential.env`
- Target unit integration: a drop-in containing `EnvironmentFile=/etc/vela/website-credential.env`

- [ ] **Step 1: Write failing shell tests**

Use command stubs to assert one reusable command is created with `EnableParameter=true`, the key placeholder is hidden, no default secret exists, each invocation has one instance and its own JSON parameters, and neither stdout nor stderr contains the key.

- [ ] **Step 2: Run the test and verify RED**

Run: `bash images/tests/test-hermes-website-credential-scripts.sh`

Expected: FAIL because the scripts do not exist.

- [ ] **Step 3: Implement target installation**

Validate the token character set, run as root, atomically write `root:agentuser 0440`, discover exactly one Hermes gateway user unit or accept an explicit override, add the drop-in, restart the user service, and verify only the presence of `VELA_WEBSITE_KEY` without printing its value.

- [ ] **Step 4: Implement command creation and invocation**

Create one parameterized command per region and invoke it once per instance because TAT applies one `Parameters` object to all instances in an invocation. Keep the reusable command because its content and defaults contain no secret.

- [ ] **Step 5: Run syntax and behavior tests**

Run: `bash -n images/helpers/install-hermes-website-credential.sh .ci/runtime/commands/create_hermes_website_credential_command.sh .ci/runtime/commands/invoke_hermes_website_credential_command.sh`

Run: `bash images/tests/test-hermes-website-credential-scripts.sh`

Expected: both commands exit 0 and the behavior test reports PASS.

### Task 6: Update the static-site Skill and handover

**Files:**
- Modify: `.agents/skills/cloudbase-site-builder/SKILL.md`
- Modify: `docs/handover/2026-08-07-instance-identity-website-token-handover.md`

**Interfaces:**
- Skill reads `VELA_WEBSITE_KEY` and calls `/v1/instance/websites` with `Vela-Instance-Key`.

- [ ] **Step 1: Record the pre-change Skill contract failure**

Run: `rg -n 'VELA_AUTH_TOKEN|/v1/passes|Authorization: Bearer' .agents/skills/cloudbase-site-builder/SKILL.md`

Expected: matches demonstrate the old session-token contract.

- [ ] **Step 2: Update the Skill and handover**

Remove the session token fallback and `/v1/passes` step. Document permanent per-instance keys, Redis revocation, the separate instance route, systemd environment delivery, and parameterized hidden TAT input.

- [ ] **Step 3: Verify the new Skill contract**

Run: `rg -n 'VELA_AUTH_TOKEN|/v1/passes|Authorization: Bearer' .agents/skills/cloudbase-site-builder/SKILL.md`

Expected: no matches.

Run: `rg -n 'VELA_WEBSITE_KEY|Vela-Instance-Key|/v1/instance/websites' .agents/skills/cloudbase-site-builder/SKILL.md`

Expected: all three new contract elements match.

### Task 7: Full local verification

**Files:**
- Verify all files changed by Tasks 1-6.

- [ ] **Step 1: Format code**

Run: `gofmt -w ctl/pkg/websiteauth/*.go ctl/main/api/website_credential_handler*.go ctl/main/api/website_handler.go ctl/pkg/logic/website/logic.go`

- [ ] **Step 2: Run CTL tests**

Run: `cd ctl && go test ./pkg/websiteauth ./pkg/logic/website ./main/api -count=1`

Expected: PASS.

- [ ] **Step 3: Run Service Gateway tests**

Run: `cd service-gateway && go test ./internal/gateway -count=1`

Expected: PASS.

- [ ] **Step 4: Run shell validation**

Run: `bash images/tests/test-hermes-website-credential-scripts.sh && bash .ci/runtime/check_ci_runtime.sh`

Expected: PASS.

- [ ] **Step 5: Inspect the final diff and secret scan**

Run: `git diff --check && git status --short && rg -n 'vwk_[A-Za-z0-9_-]{16,}' --glob '!docs/superpowers/plans/**' .`

Expected: no whitespace errors, only intended files changed, and no real-looking credential appears.
