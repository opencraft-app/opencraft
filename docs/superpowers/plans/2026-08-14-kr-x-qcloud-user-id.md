# KR X-Qcloud User ID Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Set the KR sandbox trade environment's `X-Qcloud-User-Id` source value to shadow account UIN `450860000002`.

**Architecture:** Keep the change in the KR-only deploy-facing overlay. The existing common replacement copies `JIFEI_CGW_X_QCLOUD_USER_ID` from the KR platform ConfigMap into `trade-config`, so no runtime code or shared configuration changes are needed.

**Tech Stack:** Kustomize, Kubernetes manifests, Git, Argo CD release flow

## Global Constraints

- Change only the KR sandbox trade environment configuration.
- Keep common, JP, and all other environment configuration unchanged.
- Do not patch or restart the live Deployment directly.
- Push source changes to `playground/sandbox-kr-1`; use CI and GitOps for release.

---

### Task 1: Update the KR Header Value

**Files:**
- Modify: `argocd/services/trade/sandbox-kr-1/trade-platform.env:7`
- Verify: rendered `ConfigMap/trade-config`

**Interfaces:**
- Consumes: the existing `trade-platform-values` ConfigMap generator and common `JIFEI_CGW_X_QCLOUD_USER_ID` replacement.
- Produces: `trade-config.data.JIFEI_CGW_X_QCLOUD_USER_ID` with value `450860000002` in KR only.

- [x] **Step 1: Verify the current configuration fails the desired assertion**

Run:

```bash
rg -n '^JIFEI_CGW_X_QCLOUD_USER_ID=450860000002$' argocd/services/trade/sandbox-kr-1/trade-platform.env
```

Expected: exit code `1`, because the file currently contains `800000294207`.

- [x] **Step 2: Apply the minimal configuration change**

Replace the single line with:

```dotenv
JIFEI_CGW_X_QCLOUD_USER_ID=450860000002
```

- [x] **Step 3: Verify the source value**

Run:

```bash
rg -n '^JIFEI_CGW_X_QCLOUD_USER_ID=450860000002$' argocd/services/trade/sandbox-kr-1/trade-platform.env
```

Expected: one match at line 7.

- [x] **Step 4: Render the KR overlay**

Run:

```bash
kubectl kustomize argocd/services/trade/sandbox-kr-1 --enable-alpha-plugins -o /tmp/kr-trade-rendered.yaml
rg -n 'JIFEI_CGW_X_QCLOUD_USER_ID: "450860000002"' /tmp/kr-trade-rendered.yaml
```

Expected: render exits `0`; the rendered `trade-config` contains the new value.

- [x] **Step 5: Verify scope and formatting**

Run:

```bash
git diff --check
git diff -- argocd/services/trade/sandbox-kr-1/trade-platform.env
```

Expected: `git diff --check` exits `0`; the configuration diff contains exactly one value replacement in the KR overlay.

- [ ] **Step 6: Commit and publish through the KR release branch**

After presenting the exact diff and receiving approval, run:

```bash
git add argocd/services/trade/sandbox-kr-1/trade-platform.env docs/superpowers/plans/2026-08-14-kr-x-qcloud-user-id.md
git commit -m "调整 KR 计费用户标识 / fix(trade): update KR billing user id"
git push origin HEAD:playground/sandbox-kr-1
```

Expected: push succeeds and triggers the KR trade CI; no direct Kubernetes mutation occurs.
