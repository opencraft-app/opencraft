# Isolate static website operations from optional backend runtime failures

## goal
Keep existing pure-static publish/update/delete paths independent of the new website runtime while preserving backend history, quota checks and truthful deletion completion.

## non_goals
No production/GitOps/cloud changes, source commit/push/MR merge, migration, frontend exposure, Skill delivery or database deletion. This patch does not yet change beta enablement; eventual hidden release is requested to use show() rather than an account allowlist.

## requirement_refs
User approved the necessary static/runtime coupling repair after choosing show()-hidden exposure without a beta-user allowlist. Do not infer missing backend data from a failed HTTP query.

## interface_refs
CTL internal operation/claim responses add optional HasBackendHistory and PreviousStorageBytes, both GORM-ignored response facts. Website worker distinguishes explicit false from omitted/unknown history. No schema migration.

## history_context
Base: 5be05e09a, website-minisandbox-integration-20261002. Previously both retention cleanup and storage accounting made static publication depend on runtime HTTP; deletion called runtime for all sites once configured.

## acceptance
Certified static sites make no runtime call for publish or delete. Backend/unknown history survives a failed accounting request; conservative usage reaches the existing quota check, not zero. Failed backend deletion leaves COS and completion untouched. Missing fallback facts cannot certify zero usage. Current static kind does not hide earlier backend releases.

## affected_paths
ctl/pkg/model/website/entity.go; ctl/pkg/logic/website/logic.go and operation_lease_test.go; workers/internal/website/{types.go,backend.go,deployer.go,storage.go,publish_atomicity_test.go}; docs/engineering/domains/agent-gateway-runtime.md.

## context_receipt
- Root AGENTS.md and user local override: dirty-worktree safety and explicit release authorization.
- workers/AGENTS.md and ctl/AGENTS.md: rollback, operation fences and service validation.
- docs/context/domains/{release-gitops,agent-gateway-runtime}.md and docs/context/project/services/ctl.md: cross-service and release boundaries.
- docs/engineering/domains/agent-gateway-runtime.md: existing retention/accounting contract.

## evidence
RED: injected runtime 503 failed static publish and backend-free delete in the original implementation. CTL response assertion failed because backend-history facts were absent. GREEN: workers website package race tests passed (1.924s), covering 8 publish/delete history/fallback cases with runtime HTTP503 and the existing website package regressions. CTL affected operation/lease/backend/storage quota race tests passed (1.778s). Vet/build passed for affected worker/CTL packages. git diff --check passed. Explicit changed-file design-impact validation passed with agent-gateway-runtime Owner review required before integration. No production verification is claimed.

## risks
Conservative fallback can temporarily overcount storage and hit quota; it must not be advertised as exact or guaranteed to admit every static transition. Older CTL responses remain unknown; deploy CTL before workers. Backend-history deletion still waits for runtime cleanup. Existing published packages and production are unchanged.

## validation
Targeted website worker package race tests; CTL affected operation/lease/backend gate race tests; vet/build for affected packages; git diff --check and unstaged change-impact validation. No repository-wide or cloud business test.

## handoff
Local patch only. Hidden release still needs show()-only enablement implementation, final source/deployed-package reconciliation and regional production runtime bindings/acceptance. Do not reuse Beijing storage for production or claim this repair is a release.

## show-only enablement follow-up
User authorized commit/push/MR integration and merge on 2026-10-10, not deployment.
Regional WEBSITE_BACKEND_ENABLED replaces owner filtering, with runtime configuration and
independent data gate retained. Schema3 removes beta_users from release inputs. Legacy
schema1/2 lists are parsed but not used for enablement. Website navigation subscribes to
the shared show() state, stays hidden by default, and does not grant API permissions.
Existing integration MR !4938 is reused; current remote reported conflicts and failing
checks before this update. Actual merge remains subject to checks and owner review.

## 2026-10-10 source integration verification
Merged origin/master 3bc4384e5 into the integration branch, preserving both sides of
two appended domain-document conflicts; frontend merged automatically. CTL website
package race passed (12.291s), worker website race passed (1.592s), vet/build passed
for both. Gateway fullstack/backend integration passed. Release bindings 19/19 passed.
Frontend targeted routes/controller/source guard: 37/37, shared show() account-menu
subset: 5/5; typecheck baseline after MDX generation: 0 new diagnostics (164 current,
171 recorded baseline). Full account-menu suite has 2 model-link failures; those
component/test files are unchanged from current master. No broad frontend build or
production/browser business acceptance was performed. Initial Node webstorage interference
was avoided with --no-experimental-webstorage, without changing source.
Design-impact check versus master passed; runtime/release maintainer review required.
