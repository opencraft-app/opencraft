---
id: task-opencraft-codex-quota-reset-visibility
type: task
scope: Show Codex quota reset times in OpenCraft account Settings and replace the local preview.
status: ready-to-switch
---

## goal
Show reported Codex quota reset times without hover in the account management page, then replace the current local preview with a verified build.

## non_goals
- Change account-pool quota authority, Codex binary, provider billing or production deployment.

## requirement_ids / requirement_refs / requirement_excerpt
- User request in this conversation: “codex 管理页面没有显示将于何时充值，你看看bb怎么做的？” followed by “实现，重启。” Interpreted as quota-window reset time, not a payment recharge date.

## interface_refs / data_structure_refs
- `opencraft/packages/appserver-protocol/src/codex-accounts.ts`: `CodexAccountLimitWindowView.resetAt` is nullable epoch milliseconds.
- `opencraft/packages/account-pool-host/src/codex-usage.ts`: Host is sole source of usage observations.
- `opencraft/plugins/builtin-agents/src/codex-accounts/view.tsx`: Settings projection is read-only.

## history_context
- `current_design_refs`: `opencraft/docs/platform-architecture.md#host-side-provider-account-pooling`.
- `relevant_evolution`: BB reference at `ref/bb` commit `62fe3bc` shows visible reset time in account details and usage settings; interaction reference only.
- `superseded_refs`: none.

## acceptance
- A reported reset timestamp is visible on both desktop and touch without hover, and account details show a full local timestamp.
- A missing timestamp is marked unknown, not synthesized.
- Focused test, affected typechecks, Web build, headless package smoke, switch and live health/version check pass.

## affected_paths
- `opencraft/plugins/builtin-agents/src/codex-accounts/view.tsx`
- `opencraft/apps/workbench-web/src/styles/codex-accounts.scss`
- `opencraft/tests/codex-accounts-settings.test.ts`
- `opencraft/docs/platform-architecture.md`
- `docs/engineering/domains/agent-gateway-runtime.md`

## required_context
- Root and OpenCraft `AGENTS.md`; OpenCraft maintenance skill and verification checklist.
- Router matched `subscription-entitlements` and `frontend-product-surface` by generic quota/UI words; these do not own Codex Host quota.

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md` | repository constraints | scoped implementation and deployment |
| `opencraft/AGENTS.md` | service constraints | account UI and preview checks |
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md` | interaction task | ownership and evidence |
| `opencraft/.agents/skills/opencraft-maintenance/references/verification.md` | verification | focused UI and package checks |
| `docs/context/domains/subscription-entitlements.md` | router must-read | ruled out billing authority |
| `docs/context/project/services/frontend.md` | router must-read | ruled out LightVela frontend scope |
| `opencraft/docs/platform-architecture.md` | current design | Host quota owner and Renderer projection |
| `opencraft/docs/build-matrix.md` | packaging | headless smoke gate |

## evidence
- Focused `codex-accounts-settings.test.ts`: 1/1 passed; reported timestamp and missing-time cases covered.
- `tsc --noEmit` passed for `plugins/builtin-agents` and `apps/workbench-web`; `git diff --check` passed.
- Headless package built at `/data/opencraft-quota-reset-release-20260925.tar.gz`, SHA-256 `e7d602bb60b2113d4d1effffcbc81169217498763a258be0e40ceb3bf5009e80`, buildId `20260925103419-23c1aeeb42e7`.
- Real package smoke passed for DSH and Codex initialization. Staged in `/opt/opencraft-server/releases/20260925103419-23c1aeeb42e7`; staged server bundle hash matches the archive.
- Change-impact check passed with formal design update. Old release remained current at staging check.

## risks
- Replacing the local preview temporarily disconnects the active conversation. Switch only after package smoke, with rollback to the current release on failed health/version checks.
- `resetAt: null` means upstream has not reported a time; UI must not imply a known reset.

## validation
- Focused account Settings test, affected typechecks, Web build, headless package smoke, live release health/version and touch-width layout.

## decisions
- Present absolute local time in compact row and full date/time in details; no countdown timer or second quota state owner.

## scan_scope
- Exact Codex accounts view/style/test and local preview build path.

## scan_output
- Bounded search output not retained.

## handoff
- Switch script `/data/opencraft-quota-npm-shim-20260925/switch-release.sh` is ready. The live preview remains on its prior build until the scheduled switch verifies health/version.
