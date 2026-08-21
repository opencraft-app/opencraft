# Hermes Website Bootstrap Implementation Plan

> **For agentic workers:** Execute inline in this worktree. The user explicitly requested implementation without TDD; add focused tests with each implementation unit and run them after the code is in place.

**Goal:** Guarantee Skill installation in new Hermes images and, after a new CTL instance becomes Running, make a best-effort attempt to deliver a unique website credential.

**Architecture:** CTL issues credentials and owns lifecycle ordering; sandbox owns Tencent TAT invocation; the image pipeline owns immutable Skill delivery. The feature is gated by two non-secret CTL settings.

**Tech Stack:** Go, Tencent TAT, Bash, Python unittest, Kustomize/GitOps.

## Global Constraints

- Never place plaintext `vik_` values in logs, command content, Git, task payloads, or result files.
- Keep Tencent credentials in sandbox; CTL calls only sandbox internal APIs.
- Do not alter existing instance behavior when bootstrap configuration is absent.
- Credential issuance or TAT delivery failure must not fail instance creation or delete the Sandbox; use a provisional key, revoke it on failure, and allow later repair.
- Do not merge `master`, modify `gitops`, sync Argo, change DNS, or publish production.

---

### Task 1: Parameterized TAT invocation

**Files:**
- Modify: `sandbox/internal/provider/provider.go`
- Modify: `sandbox/internal/provider/tencent.go`
- Modify: `sandbox/internal/provider/tencent_test.go`
- Modify: `sandbox/api-gin/tat.go`
- Modify: `sandbox/api-gin/handler_test.go`

- [ ] Add a provider method that invokes one existing CommandId for one cloud instance with a JSON `Parameters` object.
- [ ] Add an internal sandbox endpoint that accepts CommandId and parameter values without logging the body.
- [ ] Validate sandbox ownership, CommandId format, parameter keys, and response InvocationId.
- [ ] Cover request mapping, invalid input, and provider errors.

### Task 2: CTL adapter and create-time delivery

**Files:**
- Modify: `ctl/pkg/adapter/sandbox/types.go`
- Modify: `ctl/pkg/adapter/sandbox/adapter.go`
- Modify: `ctl/pkg/instance/logic.go`
- Modify: `ctl/pkg/instance/async.go`
- Modify: `ctl/pkg/instance/async_website_credential_test.go`
- Modify: `ctl/pkg/config/define.go`
- Modify: `ctl/pkg/config/config.go`

- [ ] Add the sandbox adapter invocation method and reuse existing result polling.
- [ ] Read the CommandId and API base from explicit configuration.
- [ ] After `Running` and normal create-success bookkeeping, revoke stale keys, issue a 15-minute provisional key, invoke TAT, and activate the key permanently only on success.
- [ ] Protect internal TAT invocation with the shared `SANDBOX_API_KEY`, restrict it to the configured website credential CommandId, and expose metadata-only polling.
- [ ] On any credential/TAT failure, warn without plaintext values, revoke the new key when one exists, preserve the already-Running instance and Sandbox, and let provisional TTL cover worker crashes or failed cleanup.
- [ ] Ensure disabled configuration preserves the previous path.
- [ ] Test success, disabled mode, issuance failure, invocation failure, and status ordering.

### Task 3: Production configuration contract

**Files:**
- Modify: `ctl/k8s/base/manifests.yaml`
- Modify: `argocd/services/ctl/sgprod/ctl-platform.env`
- Modify: `argocd/services/ctl/sgprod/README.md`
- Modify: `docs/handover/2026-08-18-lightvela-site-remaining-todos.md`

- [ ] Add non-secret env wiring without a fake production CommandId.
- [ ] Document that production enables the feature only after the real regional CommandId is supplied.
- [ ] Keep automatic delivery off in all other environments.

### Task 4: Guaranteed Skill image installation

**Files:**
- Modify: `images/deploy-build.sh`
- Modify: `images/build.sh`
- Modify: `images/tests/test-hermes-build-script.sh`
- Modify: `images/tests/test-hermes-runtime.sh`

- [ ] Upload `.agents/skills/website-builder/SKILL.md` as an explicit build asset.
- [ ] Install it into the Hermes Skill root before curation.
- [ ] Make a missing source or installed Skill a hard build failure.
- [ ] Verify manual and automated image-build paths carry the asset through their shared `deploy-build.sh` upload path.

### Task 5: Security fixes already found in domestic auth review

**Files:**
- Modify: `site-gateway/internal/siteauth/token.go`
- Modify: `site-gateway/internal/config/config.go`
- Modify: `site-gateway/internal/httpapi/siteauth.go`
- Modify: matching tests

- [ ] Enforce a five-minute maximum ticket/session lifetime.
- [ ] Reject unsafe return paths and untrusted callback hosts/protocols.
- [ ] Make unauthenticated HEAD behavior match the documented contract.

### Task 6: Verification and integration handoff

- [ ] Run focused CTL, sandbox, image, site-gateway, and CI contract suites.
- [ ] Run formatters, `go vet`, builds, Kustomize renders, and credential scanning.
- [ ] Sync latest `master` with a merge commit after verification.
- [ ] Show the final diff, commit message, and MR payload for the required irreversible-action confirmation.
