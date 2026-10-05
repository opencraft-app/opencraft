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

## requirement_ids / requirement_refs
- Source delivery: commit and push remaining source, then integrate into master as explicitly confirmed by the user.

## current_design_refs / interface_refs / data_structure_refs
- Root and service AGENTS own source-delivery boundaries; OpenCraft platform architecture and ChatUI architecture own merged runtime/presentation contracts.
- Integration uses ordinary Git three-way merge; dependency locks and generated Agent Console copies remain derived artifacts of their declared source.

## relevant_evolution / superseded_refs
- Earlier navigation and timeline deliveries are already on master. This broader delivery preserves their newer fixes rather than replacing master with the older source snapshot.
- Earlier snapshot-only delivery status is superseded by the explicit master-integration authorization.

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
427-file source snapshot committed as `1a53b96c36571a1094c45ef2cd84266468172370` and pushed to `fix/remaining-worktree-20261005`. Normal three-way integration with master `2c9369ca696ed178cd08d9b560a431c7a4858410` is resolved in `/data/mono2-remaining-integration-T1ZVel`, including 82 initially conflicting files. Newer master behavior and unique source improvements are preserved. Merged-source validation has completed; remote master delivery awaits the final commit/push. Running preview untouched.

## verified
- Found 235 tracked changed files at initial inventory, plus new code/test/docs files.
- Discovered local-only `ref/` reference material and `.kube/cache/`; neither belongs in source delivery.
- Original real index has no staged changes. Remote master freshly fetched.
- Candidate inventory after generated-copy sync: 427 files; exclude reference clones, Kubernetes discovery cache and nine private operational/account reports. Bounded credential scan finds only synthetic test fixtures and the account-pool virtual-provider marker, not live secrets.
- Frontend check passed with zero new TypeScript diagnostics; frontend build and 54 directly affected Vitest checks passed. Trade renewal tests/vet, Sandbox service tests, CTL affected package tests and NewAPI middleware/model tests passed. Python quota script tests passed (10 cases).
- OpenCraft chat tests passed (470); workbench unit tests passed (322); SSH/Host/recovery/queue/session focused suite passed (135 passed, one skipped). Terminal typecheck and mechanically regenerated Agent Console drift check passed.
- Staged whitespace and documentation impact checks passed; documentation validator found zero broken first-party links and zero warnings. High-risk mappings still require owner review; structural validation is not semantic approval.
- Remote master has 724 commits not present in the original development branch; integration must preserve those independent changes. Do not replace master wholesale with the old checkout tree.
- Integrated-source checks: complete OpenCraft workspace typecheck, Chat 478 tests, Workbench 330 tests and the complete appserver test command passed. SSH/Host/attachment focused checks passed (91 passed, one skipped); goal/navigation/focus/disclosure/reflow checks passed (29). Four real-component timeline-order browser cases passed across desktop/touch and light/dark.
- Integrated Web and preview-bridge builds passed. Frontend build passed; final frontend check reports 166 existing diagnostics against a 171-diagnostic baseline, zero new and five resolved. The 54 focused frontend tests passed. Integrated CTL, NewAPI, Sandbox and Trade affected Go tests and Trade vet passed; quota Python tests passed (10).
- Integration validation exposed a duplicate timeline key helper and an obsolete frontend resource-preparation call introduced by automatic merging. Removed the duplicate and legacy call without weakening the newer master ownership model; reruns passed.
- Dependencies were installed in this isolated worktree, not borrowed from another checkout. Rebuilt node-pty for terminal tests; used pnpm 10.28.2 with the frozen frontend lock. Regenerated Agent Console copies and the font subset from merged source.
- The final remote check discovered newer master `b9117f63b159bd12b83dd55df8916697307ad376` (daily/explore navigation). Integrated it normally, retaining both documentation additions and regenerating the derived manifest. Final frontend check again has zero new diagnostics; seven navigation/embedded-session test files passed (95 cases), Hermes plugin passed (88 cases), Web/Hermes types and generated-copy drift check passed.
- The original development checkout acquired subsequent SSH changes after the 427-file snapshot commit. Those concurrent changes are left untouched and are not part of this delivery snapshot.

## unverified
- Complete gate is not green: OpenCraft's bounded gate timed out during workspace types, frontend full tests had failures and timed out, and the context governance suite had failures. No unrelated behavior fix was improvised to conceal these results.
- Actual integrated branch/master remote refs remain pending until push and a fresh remote read. Earlier full-gate failures are not superseded by the narrower passing checks above; no complete product gate pass is claimed.
- A nine-file navigation combination including rendered AgentSettingsPage tests exhausted the Node worker heap and was stopped. The seven-file bounded rerun passed; the two full-page rendering files are not claimed to pass. Context governance remains non-green (5690 reported errors after incorporating newer master); documentation structure/link validation is a separate passing check.

## discard
- Initial shell omitted Node/Go toolchain paths; use task-local PATH, never overwrite HOME.
- Incorrect template path corrected to `docs/context/tasks/`.
- The default Corepack/pnpm selection could not consume the frontend frozen lock; the isolated installation succeeded with pnpm 10.28.2. Do not rewrite the frontend lock to work around the tool version.
- Go needs explicit task-local GOPATH/GOMODCACHE/GOCACHE because this host has no usable default HOME-derived paths. NewAPI/Sandbox require GOWORK=off; do not modify go.work just to run tests.
- Frontend script tests use Vitest, not node:test; rerun with the package's configured runner.
- Full OpenCraft gate timed out at its workspace typecheck stage; no overall pass claimed. Frontend full tests and context governance have failures that must be retained in the delivery receipt.
- Vendored Agent Console check found current locale drift; regenerate mechanically from frontend source before staging.

## restore
- Development branch starts at `5b3a3ccaf873692cc5d1649019a6a432c02f8769`.
- Keep original sources and local-only files intact; do not reset or clean the working tree.

## next_action
Commit the validated normal merge, push the integration and fast-forward master with fresh remote verification; no deployment or preview mutation.
