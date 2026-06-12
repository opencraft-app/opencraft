# Plan: Hidden Hermes WebUI Browser

## Acceptance

Restore the TAT-backed Hermes WebUI browser panel on the Agent console while keeping it hidden by default. Running `show()` in the browser console reveals the WebUI/browser entry alongside the other hidden tools.

## Tasks

- [x] Developer: restore WebUI proxy panel and proxy helpers from the previous TAT WebUI implementation.
  - Files: `frontend/src/components/domain/*`, `frontend/src/lib/*`
  - Verify: targeted WebUI proxy tests pass.

- [x] Developer: wire `/agents/browser` into Agent console navigation as a hidden tool.
  - Files: `frontend/src/router/paths.ts`, `frontend/src/pages/marketing/openclaw-settings-page.tsx`
  - Verify: default navigation does not show WebUI; `show()` reveals the browser entry.

- [x] Reviewer: run targeted checks.
  - Commands: WebUI/component tests, `pnpm i18n:check`, and `pnpm check` where feasible.
