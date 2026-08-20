# SG Production Trade Resource Query Authentication Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the three SG production trade resource-query callbacks, verify them live, and then route tkexsg SG callbacks to SG production.

**Architecture:** Inject the existing SG trade-pair token into CTL under its shared inbound-token name. Release and verify this change before making the independent cloudladdergateway route change.

**Tech Stack:** Tencent Cloud SSM, SOPS/age, Kubernetes/Kustomize, Argo CD, Python unittest.

## Global Constraints

- Do not change `CTL_INTERNAL_TOKEN` or CTL authentication code.
- Do not switch the SG route before all three live callbacks return code `0`.
- Use feature branches and MRs; do not push directly to `master` or `gitops`.
- Never print secret values.

---

### Task 1: Add the SG CTL shared-token contract

**Files:**
- Modify: `.ci/runtime/tests/contract_tests/test_ctl_sgprod_trade_contract.py`
- Modify: `scripts/ssm_manifest.ctl.sgprod.yaml`
- Modify: `argocd/secrets/sgprod/ctl-runtime-secrets.sops.yaml`

**Interfaces:**
- Consumes: `CTL_TRADE_TOKEN` from SSM `mono-sgprod-ctl-runtime-secrets`.
- Produces: the same value as `LIGHTCLAW_INTERNAL_SERVICE_TOKEN` in SG CTL.

- [x] Add failing assertions for the manifest and encrypted Secret key.
- [x] Run the contract test and observe the missing-key failure.
- [x] Create immutable SSM `v3` from `v2`, adding only the shared key.
- [x] Point the manifest to `v3` and regenerate the SOPS Secret.
- [x] Run the contract test, secret scanner, and `git diff --check`.
- [ ] Show the diff and obtain approval before commit, push, and MR creation.

Verification commands:

```bash
python3 .ci/runtime/tests/contract_tests/test_ctl_sgprod_trade_contract.py
python3 scripts/scan_secrets.py argocd/secrets/sgprod/ctl-runtime-secrets.sops.yaml
git diff --check
```

### Task 2: Release and verify SG CTL

**Files:** No additional source files.

**Interfaces:**
- Consumes: Task 1 merged and promoted through normal CI/GitOps.
- Produces: live SG CTL accepting SG trade's bearer token.

- [ ] Verify the SG CTL Argo revision, health, and rollout.
- [ ] Confirm token presence and equality by hashes only.
- [ ] Run `getAllAppIds`, then use returned SG data for `getUserResources` and
  `queryResource`.
- [ ] Require HTTP 200 and business code `0` from all three calls.

### Task 3: Switch the tkexsg SG route

**Files:**
- Modify: `argocd/services/cloudladdergateway/tkexsg/statefulsetplus.yaml`

**Interfaces:**
- Consumes: successful Task 2 live verification.
- Produces: SG callback forwarding to `https://api.lightvela.ai`.

- [ ] Change only `CLOUDLADDERGATEWAY_ROUTE_JIFEI_CALLBACK_SG_BASE_URL` from
  the JP sandbox endpoint to `https://api.lightvela.ai`.
- [ ] Render and test cloudladdergateway configuration; ensure other regions do
  not change.
- [ ] Show the diff and obtain separate approval before commit, push, and MR.
