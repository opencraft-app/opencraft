# International Preview KR Sandbox Auth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route ordinary international branch previews to the KR sandbox for API data and sessions, while exposing only OAuth providers that KR actually supports.

**Architecture:** The preview publisher injects `https://api-sandbox-kr-1.lightclaw.tech` into the international build. The HTTP repository treats Google OAuth as unavailable when that backend is selected, so existing login screens omit the unusable button while GitHub stays on the same KR backend as the resulting session.

**Tech Stack:** Bash preview publisher, TypeScript repository layer, Python unittest, Vitest.

## Global Constraints

- Domestic preview routing remains on `https://lightclaw.tech`.
- Playground branches retain their branch-specific API routing.
- Do not send KR session tokens to the international production API.
- Do not render an OAuth entry whose selected backend returns 404 for its start route.

---

### Task 1: Lock the preview routing contract

**Files:**
- Modify: `.ci/runtime/tests/command_tests/test_publish_frontend_preview.py`
- Modify: `.ci/runtime/commands/publish_frontend_preview.sh`

**Interfaces:**
- Consumes: `resolve_preview_auth_api_base_url(branch, variant)`.
- Produces: the KR sandbox API base for ordinary international branch previews.

- [x] Add a failing command contract asserting that the international fallback is `https://api-sandbox-kr-1.lightclaw.tech` and the domestic fallback remains `https://lightclaw.tech`.
- [x] Run `python3 .ci/runtime/tests/command_tests/test_publish_frontend_preview.py` and confirm the new assertion fails against the current global API fallback.
- [x] Change only the international fallback in `publish_frontend_preview.sh`.
- [x] Re-run the command test and confirm it passes.

### Task 2: Hide unsupported Google OAuth on KR

**Files:**
- Modify: `frontend/src/repositories/__tests__/http-repositories.test.ts`
- Modify: `frontend/src/repositories/http-repositories.ts`

**Interfaces:**
- Consumes: `AuthRepository.getOAuthStartUrl(provider)`.
- Produces: `null` for Google when the selected auth API is KR sandbox; a KR URL for GitHub.

- [x] Add a failing repository test for the KR Google/GitHub capability boundary.
- [x] Run the focused Vitest file and confirm Google currently returns a KR URL instead of `null`.
- [x] Add the smallest backend capability check in `getOAuthStartUrl`.
- [x] Re-run the focused tests and confirm they pass.

### Task 3: Verify the branch change

**Files:**
- Verify only; no additional production files.

**Interfaces:**
- Consumes: completed Tasks 1 and 2.
- Produces: evidence suitable for commit/push confirmation.

- [x] Run the preview publisher command test.
- [x] Run the focused repository and international login component tests.
- [x] Run `git diff --check` and inspect the final diff.
- [ ] Present the proposed commit and push target for user confirmation.
