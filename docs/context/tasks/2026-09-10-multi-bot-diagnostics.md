# Multi-Bot Diagnostics

## goal
Separate current-Profile diagnostics from instance-wide maintenance.

## non_goals
- No deployment, database migration, or enabling Bot creation.
- No per-Profile model-reset redesign or real destructive runtime tests.

## requirement_refs / requirement_excerpt
- User approved the diagnostics audit: scoped logs; block model reset on multi-Bot instances; main-Bot-only reinstall and backup/recovery with shared instance progress.
- wiki/prd-docs/2026-09-09-lightvela-multi-bot-profile.md

## interface_refs / data_structure_refs
- AgentDiagnosticsPanel, Bot.instanceId/profileId/isDefault, ResetInstanceConfig, BuildHermesImportScript.
- Native main maps to default; model reset must check profiles before key issuance.

## history_context
- current_design_refs: docs/engineering/domains/agent-gateway-runtime.md
- relevant_evolution: baseline 45f9d13fe84ea0da9d43d16b5f0b9195a621b692 hides new Bot entry.
- superseded_refs: none.

## acceptance
- Named and root logs explicitly select native Profile.
- Model reset fails closed for multiple or unverified Profiles before key changes.
- Instance maintenance only accessible from main Bot; progress survives sibling switching.
- A completed Bot creation refreshes the shared Bot list before leaving the loading page, without requiring a manual browser refresh.
- The English creation state says `Getting your LightVela Bot ready` and continues to use the existing animated ellipsis.
- Both first-Bot and additional-Bot dialogs start with an empty name field and show the localized `请输入 Bot 名称` placeholder.
- A cloned Bot with empty card state still shows the persona injected in its copied `SOUL.md`; file state wins after asynchronous card-state loading.
- The clone hint separates inherited and non-inherited data into two scannable rows and explicitly states that scheduled tasks are not inherited.
- The additional-Bot creation dialog no longer exposes advanced settings or an initial-persona override.
- The multi-Bot deletion dialog omits the unrelated purchased-plan explanation while retaining data-loss warning and name confirmation.
- Import explicitly targets root home. Focused frontend and Go tests plus type/i18n checks.

## affected_paths
- frontend/src/pages/marketing/agent-diagnostics-panel.tsx
- frontend/src/pages/marketing/agent-settings-page.tsx
- frontend/src/pages/marketing/agent-reset-config.ts
- ctl/pkg/instance/reset_config.go
- workers/internal/rescue/import_activities.go

## context_receipt
| File | Reason | Use |
|---|---|---|
| docs/context/project/services/frontend.md | UI boundary | preserve locale gates |
| docs/context/project/services/ctl.md | reset control | backend guard |
| docs/context/domains/agent-gateway-runtime.md | Profile isolation | explicit scope |
| docs/context/domains/site-environment-routing.md | CN preview | no environment change |
| frontend/AGENTS.md | service rules | tests/type checks |
| ctl/AGENTS.md | service rules | targeted Go tests |
| workers/AGENTS.md | recovery rules | activity-only change |
| docs/context/project/adjacency/frontend-runtime-openspec-i18n.md | adjacency | existing test and package scripts inspected |
| docs/engineering/domains/agent-gateway-runtime.md | design truth | update maintenance scope |

## decisions
- Reuse withHermesProfile; do not add a second Profile quoting implementation.
- Keep backup state keyed by instance ID, which the repository supports for legacy/main calls.

## evidence
- Worktree clean at start; bounded searches located command builders, reset key rotation and recovery state.
- A user screenshot showed the creation page remaining in loading state until a manual refresh; the completion branches navigated before `refreshBots`, allowing the destination page to observe stale shared state.
- Source inspection confirmed both creation entry paths prefilled `新 Bot`; they now clear the shared name state and rely on the existing required-name validation.
- Runtime file checks confirmed the source and cloned Bot `SOUL.md` files were byte-identical while the cloned Bot's separately keyed card state was empty; the UI loads these sources independently.

## risks
- Installed runtime compatibility and full multi-Profile restore need isolated runtime verification; no production maintenance execution.

## validation
- Bot 创建流程：创建相关 3 个前端测试套件通过，49 tests passed；覆盖完成后刷新、首个 Bot 与追加 Bot 空名称初始化，以及本地化占位提示。
- 人设展示：`BuddyPanel` 36 tests passed；竞态回归覆盖空卡片状态晚于 `SOUL.md` 返回的场景，最终展示以目标 Bot 的真实文件为准。
- Frontend: 5 focused suites, 115 passed / 1 skipped; includes rendered main/sibling switching, stale log removal, pending instance progress, single-Bot maintenance and hidden creation entry.
- `pnpm check` passed; final baseline check reports 174 existing diagnostics, 276 baseline, zero new. `pnpm build:cn` passed (96 static pages).
- `CGO_ENABLED=0 go test ./pkg/instance -run TestResetInstanceConfig -count=1` passed; `ctl/main/api` passed. `CGO_ENABLED=0 go vet ./pkg/instance ./pkg/errcode` passed.
- Worker `go test ./...` and `go vet ./...` passed.
- Full CTL package tests blocked by missing Docker; native CGO test linking blocked by local macOS Security symbol, so targeted checks used CGO_ENABLED=0.
- Documentation validation passed (zero broken first-party links); staged changed-path design-impact validation and diff checks passed.
- Local port 5174 owned by this worktree; HTTP GET /agents/diagnostics/ returned 200. Browser screenshot validation unavailable on the stale connection-error tab.
- Report: /tmp/lightvela-diagnostics-validation/report.html. No production mutation or deployment.

## handoff
- MR !3848 merged; follow-up UX and state fixes are submitted from `codex/bot-create-followups` targeting `master`.
- Local CN preview now uses the Beijing backend through process environment only; no proxy or deployment configuration is included in this change.

## stage
Implementation and local verification complete; preparing the separately authorized MR. Deployment remains out of scope.

## verified
- Explicit Profile log commands; instance-keyed maintenance state; fail-closed Profile inventory check before reset key changes; root-pinned import script.

## unverified
- Real multi-Profile backup restoration and installed CLI compatibility on a disposable remote instance.
- Full CTL database integration tests need Docker. Backend changes have not been deployed by this task.

## discard
- Initial test fixture failures (missing useMultiBotEnabled/email and quoted-string assertion) were corrected; do not treat them as product failures.

## restore
- Worktree: /Users/pablozhong/codex/lightvela-master-preview-3832; baseline 45f9d13fe84ea0da9d43d16b5f0b9195a621b692.

## next_action
- Validate the creation polling order fix, then update MR !3848 and verify its CI state without merging.
