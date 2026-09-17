# Credit Callback Regional Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route production Credit billing callbacks to Shanghai for `tkexgz` SH and to Singapore/Tokyo for `tkexsg` without changing Pass callbacks.

**Architecture:** Keep the shared CloudLadder route definitions unchanged and use the existing per-workload environment-variable overrides in the two production manifests. Replace the former all-Beijing test assertion with exact per-environment route maps so future drift fails CI.

**Tech Stack:** Kubernetes YAML, Python `unittest`, PyYAML, Kustomize.

## Global Constraints

- `tkexgz` routes `SH` to `https://api.lightvela.com`; every other Credit route remains `https://lightclaw.tech`.
- `tkexsg` routes `SG` to `https://api.lightvela.ai`; every other Credit route uses `https://api-sandbox-jp-1.lightclaw.tech`.
- Do not modify Pass callback routes, authentication, timeout, methods, or shared route defaults.

---

### Task 1: Encode and apply the production route maps

**Files:**
- Modify: `.ci/runtime/tests/gitops_tests/test_clgateway_credit_callback.py`
- Modify: `argocd/services/cloudladdergateway/tkexgz/statefulsetplus.yaml`
- Modify: `argocd/services/cloudladdergateway/tkexsg/statefulsetplus.yaml`
- Modify: `docs/engineering/domains/release-gitops.md`

**Interfaces:**
- Consumes: CloudLadder route override environment variables named `CLOUDLADDERGATEWAY_ROUTE_JIFEI_CREDIT_CALLBACK_<REGION>_BASE_URL`.
- Produces: Exact domestic and international production Credit callback target maps.

- [ ] **Step 1: Replace the all-Beijing test helper with exact expected route maps**

Define expected values for all eleven regions in each production manifest. Assert that the manifest contains every key and that each value equals the required regional target.

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `python3 -m unittest discover -s .ci/runtime/tests/gitops_tests -p 'test_clgateway_credit_callback.py' -v`

Expected: failures for `tkexgz/SH`, `tkexsg/SG`, and the remaining `tkexsg` routes because the manifests still point to Beijing preproduction.

- [ ] **Step 3: Update the two production manifests**

Set only the Credit callback override values described in the global constraints and replace the obsolete comments that say every region routes to Beijing.

- [ ] **Step 4: Run focused and broader validation**

Run:

```bash
python3 -m unittest .ci.runtime.tests.gitops_tests.test_clgateway_credit_callback -v
python3 -m unittest discover -s .ci/runtime/tests/gitops_tests -p 'test_clgateway*.py' -v
kustomize build argocd/services/cloudladdergateway/tkexgz --enable-alpha-plugins --enable-exec >/tmp/tkexgz-cloudladder.yaml
kustomize build argocd/services/cloudladdergateway/tkexsg --enable-alpha-plugins --enable-exec >/tmp/tkexsg-cloudladder.yaml
```

Expected: all tests pass and both Kustomize overlays render successfully.

- [ ] **Step 5: Review the final diff**

Run: `git diff --check && git diff --stat && git diff`

Expected: only the plan, route-map test, and two production manifests are changed.
