---
id: opencraft-activity-disclosure-checkpoint-20261006
type: task
scope: Recovery state for the Activity disclosure refactor.
triggers: ["activity disclosure checkpoint", "disclosure recovery", "historical folding verification"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - docs/context/tasks/2026-10-06-opencraft-activity-disclosure.md
status: retired
reviewed_at: 2026-10-06
review_due: 2026-11-05
revision: 1.1.0
precedence: task
derived: false
---

## stage
Implementation and verification complete; follow-up user-authorized scoped Git delivery in progress. No preview deployment authorized.

## verified
- Isolated `refactor/activity-disclosure-20261006` based on preview source `3cefebe3e`; preview and unrelated Tencent OA work unchanged.
- Old implementation reproduced generic-boundary collapse defects. Core now uses explicit segment endings and per-slice final eligibility, never prior-response phase.
- 131 focused tests passed, including the 96-case portable current-Codex pure oracle; entire chat suite 504 and Workbench suite 332 passed; Web build passed.
- No-toggle projection keeps full expanded partition; inner partition protects qualified finals.
- All-workspace typecheck, i18n/boundary checks passed in the gate; change-impact passed with the actual explicit 12-file change set (not an empty staged-only set).
- New real Conversation and existing ordered smokes each passed four desktop/touch/theme combinations. Existing reflow smoke passed 48 cases with 0 px measured drift.
- Prose DOM identity probe now waits for the actual lazy Markdown paragraph, not the initial raw-text fallback. No extra renderer mutation was needed.
- Final complete `npm run gate` exited 0: 2,232 passes, one environment-conditional skip, no failures; Web/Expo Web/iOS bundle passed. No native-device or live-preview acceptance claimed.
- Follow-up user authorized commit, push and integration into master. Git fetch authenticated through the existing private helper configuration; no credential copied or printed.

## unverified
- Full repository context validation is not green (6,273 errors outside the new Task Pack/checkpoint). Both new files have zero reported errors; catalog/unrelated cleanup intentionally excluded.
- Exact screenshot protocol phases were not fetched; no claim of original screenshot finals being misclassified.

## discard
- Generic `hasDisclosureBoundary`, global historical-final eligibility, blanket force-expansion and an unwired future chat-mode service.
- Old machine-local r3562 test loader is not current reference/caller evidence.

## restore
- Isolated checkout on `refactor/activity-disclosure-20261006`; resolve its local path via `git worktree list`.
- Main Task Pack, `chat-activity-disclosure.test.ts`, `agent-activity.ts`, real fixture/smoke and architecture updates.
- Test-only Playwright installed under own ignored `opencraft/.runtime/activity-disclosure-browser`; root no-save install failed peer resolution without changing tracked dependencies.

## next_action
- Stage only the twelve scoped files, run staged impact/secret/diff checks, commit, push source and integrate remote master using non-force pushes. Independently verify remote containment; current preview stays unchanged.
