# Plan: Agent Console canonical path

## Acceptance

`/agents` becomes the canonical Agent console entry, section navigation has stable URLs, and legacy `/dashboard/settings` links continue to work through redirects.

## Tasks

- [x] Developer: update route definitions and legacy redirects.
  - Files: `frontend/src/router/index.tsx`
  - Verify: `/agents`, `/agents/models`, and legacy paths resolve to the Agent console.

- [x] Developer: make the Agent console section state URL-driven.
  - Files: `frontend/src/pages/marketing/openclaw-settings-page.tsx`
  - Verify: clicking nav items updates URL; direct `/agents/<section>` selects the right section.

- [x] Developer: update first-party entry links to `/agents`.
  - Files: `frontend/src/**`
  - Verify: grep no primary product entry still points to `/dashboard/settings` except compatibility redirects/tests that intentionally cover old paths.

- [x] Developer: update OpenSpec and implementation docs for the new canonical path.
  - Files: `frontend/openspec/specs/marketing.md`, `frontend/openspec/config.yaml`, `docs/implementations/frontend-key-implementation.md`
  - Verify: docs identify `/agents` as canonical and `/dashboard/settings` as legacy compatibility.

- [x] Reviewer: run targeted checks.
  - Commands: `pnpm check`, relevant tests for updated route/link expectations, `pnpm i18n:check` if text extraction changes.
  - Verify: `pnpm check`, `pnpm i18n:check`, `marketing-header-actions.test.tsx`, and local Vite route smoke checks passed. `plan-select-page.test.tsx` currently hangs as a single-file Vitest run; exact blocker documented in the final handoff.
