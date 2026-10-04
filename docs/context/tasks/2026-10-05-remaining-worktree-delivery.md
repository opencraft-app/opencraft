---
id: remaining-worktree-delivery-20261005
type: task
scope: Commit and push the remaining existing mono2 source changes without publishing services.
triggers: ["remaining worktree delivery"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - docs/context/tasks/2026-10-05-remaining-worktree-delivery.md
status: active
reviewed_at: 2026-10-05
review_due: 2026-11-05
revision: 1.0.0
precedence: task
derived: false
---

# Remaining source delivery

## goal
Commit and push the user's remaining existing source, tests and maintained documentation after the timeline repair was independently integrated into master.

## non_goals
- No service restart, preview replacement, GitOps, public mirror or cloud mutation.
- No credentials, local Kubernetes discovery cache, reference clones, dependency trees or compiled products in Git.
- No claim that every existing feature has been newly implemented or physically validated by this delivery.
- User subsequently confirmed master integration for this broader scope; preserve newer master changes during normal integration, never force-push.

## requirement_excerpt
User: "其他改动都提交一下推送呗？"

## history_context
- Original development checkout includes accumulated OpenCraft Web/Native/Host, frontend, CTL, NewAPI, Sandbox and Trade changes.
- Timeline-only commit `efc37fe08bbce0ce5ec60f0fe741b377f90e35af` is already on remote master; do not label a broad source snapshot as only that fix.
- Existing per-feature design and Task Packs remain the detailed implementation evidence; this task covers delivery and safety checking only.

## affected_paths
- `.agents/context/`, `docs/`, `opencraft/`, `frontend/`, `ctl/`, `new-api/`, `sandbox/`, `trade/`.

## context_receipt
- Root and OpenCraft AGENTS; frontend, CTL, NewAPI, Sandbox and Trade service instructions.
- Router required subscription-entitlements, identity-access and CTL service context; read all three.
- OpenCraft maintenance Skill and verification checklist; frontend runtime/i18n adjacency and current package/test scripts.
- Task and checkpoint templates from `docs/context/tasks/`.

## acceptance
- Explicit source inventory and credential scan before committing; retained local-only material is reported.
- Run affected service checks, record failures honestly, do not hide a non-green complete gate.
- Verify pushed branch and commit using fresh remote ref evidence; preserve later/unrelated working changes.

## validation
- OpenCraft gate plus focused tests if the existing gate stops early.
- Frontend check/test/build using the existing installed dependency tree.
- CTL, NewAPI, Sandbox, Trade affected Go tests and Trade vet.
- Context tests, staged documentation impact/link checks, whitespace and credential scan.

## stage
427-file source snapshot staged on an independent delivery branch; verification receipts collected, integration with newer master next. No push yet.

## verified
- Found 235 tracked changed files at initial inventory, plus new code/test/docs files.
- Discovered local-only `ref/` reference material and `.kube/cache/`; neither belongs in source delivery.
- Original real index has no staged changes. Remote master freshly fetched.
- Candidate inventory after generated-copy sync: 427 files; exclude reference clones, Kubernetes discovery cache and nine private operational/account reports. Bounded credential scan finds only synthetic test fixtures and the account-pool virtual-provider marker, not live secrets.
- Frontend check passed with zero new TypeScript diagnostics; frontend build and 54 directly affected Vitest checks passed. Trade renewal tests/vet, Sandbox service tests, CTL affected package tests and NewAPI middleware/model tests passed. Python quota script tests passed (10 cases).
- OpenCraft chat tests passed (470); workbench unit tests passed (322); SSH/Host/recovery/queue/session focused suite passed (135 passed, one skipped). Terminal typecheck and mechanically regenerated Agent Console drift check passed.
- Staged whitespace and documentation impact checks passed; documentation validator found zero broken first-party links and zero warnings. High-risk mappings still require owner review; structural validation is not semantic approval.
- Remote master has 724 commits not present in the original development branch; integration must preserve those independent changes. Do not replace master wholesale with the old checkout tree.

## unverified
- Complete gate is not green: OpenCraft's bounded gate timed out during workspace types, frontend full tests had failures and timed out, and the context governance suite had failures. No unrelated behavior fix was improvised to conceal these results.
- Post-merge source and actual pushed/master refs remain pending.

## discard
- Initial shell omitted Node/Go toolchain paths; use task-local PATH, never overwrite HOME.
- Incorrect template path corrected to `docs/context/tasks/`.
- Corepack's selected pnpm package is missing; use existing npm script runner without reinstalling dependencies or rewriting locks.
- Go needs explicit task-local GOPATH/GOMODCACHE/GOCACHE because this host has no usable default HOME-derived paths. NewAPI/Sandbox require GOWORK=off; do not modify go.work just to run tests.
- Frontend script tests use Vitest, not node:test; rerun with the package's configured runner.
- Full OpenCraft gate timed out at its workspace typecheck stage; no overall pass claimed. Frontend full tests and context governance have failures that must be retained in the delivery receipt.
- Vendored Agent Console check found current locale drift; regenerate mechanically from frontend source before staging.

## restore
- Development branch starts at `5b3a3ccaf873692cc5d1649019a6a432c02f8769`.
- Keep original sources and local-only files intact; do not reset or clean the working tree.

## next_action
Complete safety scan, bound the candidate snapshot, collect checks, then commit and push the delivery branch.
