---
id: frontend-owner-ci-reviewer-20261008
type: task
scope: Add xinqishang to frontend ownership and frontend CI approval gates.
triggers: ["frontend owner", "frontend CI reviewer"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - frontend/OWNERS
  - .ci/frontend.yml
  - .ci/templates/frontend-edgeone-release.yml
status: complete
reviewed_at: 2026-10-08
review_due: 2026-11-07
revision: 1.0.0
precedence: task
derived: false
---

## goal

Add `xinqishang` as a frontend service owner and frontend CI reviewer.

## non_goals

- Do not change other services' owners or reviewers.
- Do not start builds or release without separate confirmation; commit, push, and MR were authorized on 2026-10-08.

## requirement_ids / requirement_refs / requirement_excerpt

- User request, 2026-10-08: "frontend服务, 给xinqishang加上owner, 以及CI的审核人".

## interface_refs / data_structure_refs

- `frontend/OWNERS` controls service ownership.
- Main frontend build and EdgeOne release template use `check-in.reviews.flows[].reviewers`.
- Tokyo frontend extends `service-release.yml` with `PROD_REVIEWERS`.

## history_context

- `current_design_refs`: `.ci/frontend.yml`, `.ci/templates/frontend-edgeone-release.yml`, `.ci/tokyo-frontend.yml`.
- `relevant_evolution`: `.ci/OWNERS` already contains `xinqishang`; no change needed there.
- `superseded_refs`: none.

## acceptance

- Frontend owner file and all identified frontend CI approval lists include `xinqishang`.
- Gateway Dashboard reviewers are unchanged; CI contract tests pass.

## affected_paths

- `frontend/OWNERS`, `.ci/frontend.yml`, `.ci/templates/frontend-edgeone-release.yml`, `.ci/tokyo-frontend.yml`, and their contract test.

## required_context

- `frontend/AGENTS.md`, `docs/context/project/adjacency/argocd-ci-secrets.md`.

## context_receipt

| File | Reason | Use |
|---|---|
| `frontend/AGENTS.md` | Nearest service guidance | Scope frontend changes |
| `docs/context/project/adjacency/argocd-ci-secrets.md` | CI neighbor | Check workflow and test |
| `.agents/skills/devops-pipeline/SKILL.md` | CI operations constraints | Do not start build without confirmation |
| `.ci/runtime/tests/contract_tests/test_release_bundle_contracts.py` | CI contract | Preserve other reviewer lists |

## evidence

- Exact search found frontend owner and three frontend approval surfaces; `.ci/OWNERS` already lists `xinqishang`.
- Frontend CI contract file: 105 tests passed on current `master` baseline; focused frontend subset: 13 tests passed on the previous branch.
- All three changed CI YAML files parsed successfully; documentation validation and `git diff --check` passed.

## risks

- Source changes are not live until merged and synchronized by CI; existing in-flight approvals may retain their prior reviewer list.

## validation

- CI contract suite and YAML parse passed; no application runtime code changed.
- Frontend typecheck did not pass (206 diagnostics, including 55 new against its baseline, in untouched frontend code and missing local dependencies).
- Frontend Vitest suite showed widespread failures and collection errors in untouched files; stopped after confirming it could not provide a clean gate. Frontend package has no lint script.

## decisions

- Keep Tokyo Gateway Dashboard unchanged while extending Tokyo frontend reviewers.

## scan_scope

- `frontend/OWNERS`, `.ci/frontend*.yml`, `.ci/tokyo-frontend.yml`, and focused contract tests.

## scan_output

- No bulk scan artifact.

## handoff

- Focused changes prepared for an MR against `master`; CI build and release were not requested. Frontend-wide typecheck and Vitest remain failing outside this metadata-only change.

## stage

Local change complete; commit, push, and MR authorized by the user. Build and release not authorized.

## verified

- Frontend owner and three frontend approval surfaces include `xinqishang`.
- CI contract suite passed (105 tests on current `master` baseline); changed YAML parses; `git diff --check` passed.

## unverified

- No remote CI run or deployment performed.
- Frontend-wide checks remain red on the current worktree; they do not validate this metadata-only change.

## discard

- None.

## restore

- Review the five modified tracked files and this task pack before any commit.

## next_action

- Submit only the focused frontend change as an MR against `master`; do not deploy.
