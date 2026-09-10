## goal

Update the global and domestic Scheduled Tasks documentation so both Chinese pages clearly introduce and distinguish Agent Tasks, Notification Tasks, and Script Tasks.

## non_goals

- Do not change Scheduled Task behavior, UI, API contracts, or routes.
- Do not commit, push, create an MR, or publish.

## requirement_ids / requirement_refs / requirement_excerpt

- User request, 2026-09-09: improve `https://lightvela.ai/docs/configuration/automation/` to showcase the existing Agent Task and the two newer task types, with a separate introduction for each, and return the English international documentation.
- Source of truth: the global Scheduled Tasks implementation and approved zero-token task PRD.

## interface_refs / data_structure_refs

- `frontend/src/pages/marketing/agent-automations-panel.tsx`: creation UI exposes `agent`, `fixed_notification`, and `script` task types.
- `frontend/src/lib/hermes-cron-client.ts`: Agent Tasks carry a prompt; `noAgent` tasks require a script and expose `zero_token_config`.
- `wiki/prd-docs/2026-09-06-zero-token-automation-tasks.md`: Notification Tasks and Script Tasks are `no_agent` runs, do not call a model, and have explicit delivery and safety boundaries.

## history_context

- `current_design_refs`: `wiki/prd-docs/2026-09-06-zero-token-automation-tasks.md` and the current frontend implementation.
- `relevant_evolution`: `docs/context/tasks/2026-09-06-zero-token-automation-tasks.md` introduced the two deterministic task types while retaining the existing Agent Task behavior.
- `superseded_refs`: none.

## acceptance

- The English, Simplified Chinese, domestic Chinese, and existing Indonesian sources introduce all three task types separately and retain the same information architecture.
- The page clearly distinguishes model-driven Agent Tasks from deterministic 0 Token Notification and Script Tasks without implying that they use no runtime resources.
- The page covers each type's purpose, inputs, execution behavior, delivery behavior, and key limits.
- Source markdown is synchronized into the English, Simplified Chinese, Traditional Chinese, and Indonesian rendered documentation outputs.
- Documentation checks and scoped source/produced-output integrity checks pass.

## affected_paths

- `frontend/src/content/docs/en/configuration/automation.md`
- `frontend/src/content/docs/configuration/automation.md`
- `frontend/src/content/docs/global/configuration/automation.md`
- `frontend/src/content/docs/id/configuration/automation.md`
- `frontend/src/content/docs/images/automation-create-job*.webp`
- `frontend/src/content/docs/images/automation-template-stock-job*.webp`
- `docs/context/tasks/2026-09-09-global-scheduled-task-types-documentation.md`

## required_context

- No route Pack matched the initial request.
- `frontend/AGENTS.md`
- `.agents/skills/product-skills/lv-docs/SKILL.md`
- `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md`

## context_receipt

| File | Reason | Use |
|---|---|---|
| `AGENTS.md@18af965f9` | Repository boundaries and documentation workflow | Limits scope and records validation requirements. |
| `frontend/AGENTS.md@18af965f9` | Frontend service boundary | Selects the minimal documentation synchronization and validation work. |
| `.agents/skills/product-skills/lv-docs/SKILL.md@18af965f9` | Global documentation rules | Requires paired English and Simplified Chinese sources, synchronizes existing Indonesian content, and verifies rendered outputs. |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@1.0.0` | Configuration and locale neighbor | Requires an implementation and adjacent test or generation check. |
| `wiki/prd-docs/2026-09-06-zero-token-automation-tasks.md@18af965f9` | Approved product behavior | Defines the three task types and the precise 0 Token and script-security boundaries. |
| `frontend/src/pages/marketing/agent-automations-panel.tsx@18af965f9` | Product implementation | Verifies the exact task-type labels and form behavior. |
| `frontend/src/lib/hermes-cron-client.ts@18af965f9` | Runtime-client contract | Verifies model invocation, no-agent, script, output, and error semantics. |

## evidence

- Context route query `Update international Automation documentation for all scheduled task types` matched no Pack, so a bounded exact search was run.
- The initial graph query did not match the existing graph vocabulary, so the decision relies on exact implementation and PRD evidence rather than inferred graph edges.
- The global page is registered in `GLOBAL_SIDEBAR`, `GLOBAL_SLUG_TO_FILE`, and `globalDocs` as `configuration/automation`; the domestic page is registered in `CN_SIDEBAR`, `CN_SLUG_TO_FILE`, and `cnDocs`.
- The task-type picker exposes `Agent Task`, `Notification Task`, and `Script Task` in the global UI.
- `pnpm docs:sync` completed successfully and synchronized 510 documentation pages.
- The English, Simplified Chinese, Traditional Chinese, and Indonesian rendered automation pages each contain 12 matching section headings.
- `python3 .agents/context/scripts/validate_documentation.py --repo . --format json` passed with 0 broken first-party links and 0 warnings.
- `git diff --check` passed.
- The generated automation pages select the expected English or Chinese image variant for `en-us`, `zh-cn`, `zh-sg`, `zh-hant`, `id-id`, `es`, `ja-jp`, and `ko-kr`.
- `python3 .agents/context/scripts/validate_change_impact.py --repo . --staged` passed with no staged files because this task intentionally leaves all changes unstaged.

## risks

- Users could mistake 0 Token for zero operational cost.
  The documentation will state only that there is no model invocation and no model-token usage.
- Users could treat Script Tasks as sandboxed code execution.
  The documentation will state that scripts run in the cloud Agent environment and should be trusted.
- Existing upstream-task instructions apply only to Agent Tasks.
  The documentation will place upstream-task chaining under the Agent Task section.

## validation

- Run `pnpm docs:sync` from `frontend`.
- Confirm matching sections and task-type facts in the English, Simplified Chinese, Indonesian, English-rendered, Simplified-Chinese-rendered, Traditional-Chinese-rendered, and Indonesian-rendered files.
- Run `python3 .agents/context/scripts/validate_documentation.py --repo . --format json`.
- Run `python3 .agents/context/scripts/validate_change_impact.py --repo . --staged`.

All listed checks passed.

## decisions

- Treat task type separately from schedule pattern.
  All three task types share the one-time, recurring, and interval schedule options.
- Use the product-facing English names Agent Task, Notification Task, and Script Task.
  These match the current global UI.
- Preserve the existing Indonesian source because it already exists for this route.

## scan_scope

- `frontend/src/content/docs/{en,global,id}/configuration/automation.md`
- `frontend/src/pages/marketing/agent-automations-panel.tsx`
- `frontend/src/lib/hermes-cron-client.ts`
- `frontend/src/pages/marketing/__tests__/agent-automations-panel.global.test.ts`

## scan_output

- The global creation UI and its test explicitly expose Agent Task, Notification Task, and Script Task.
- Agent Tasks use model-driven prompt execution.
- Notification Tasks send supplied text without a model.
- Script Tasks run Bash or Python, deliver non-empty standard output, remain silent on empty standard output, and expose failure or timeout outcomes.
- The English page now places `Understand the Three Task Types` immediately below the comparison table, with a separate prose introduction for each type; the Chinese and Indonesian global sources mirror that structure.

## handoff

- Complete.
- The global source files were updated in English, Simplified Chinese, and Indonesian because the route already has an Indonesian source.
- The domestic Chinese source was then aligned with the same task-type structure, using the domestic notification-channel screenshot and the shared page title `定时任务`.
- The shared-settings screenshot now uses the supplied English crop for non-Chinese locales and the supplied Chinese crop for `zh-cn`, `zh-sg`, and `zh-hant`.
- The stock-template screenshot follows the same locale split, using the supplied English dialog for non-Chinese locales and the supplied Chinese dialog for all Chinese locales.
- The domestic Chinese stock-template screenshot now uses the separate `automation-template-stock-job-cn.webp` asset, leaving the international Chinese default image unchanged.
- The international Chinese stock-template screenshot was then replaced with the supplied Telegram and WeChat variant for `zh-sg` and `zh-hant`, while the domestic `-cn` variant remained unchanged.
- The follow-up presentation change was synchronized with `pnpm docs:sync` and confirmed in the `en-us` rendered output.
- The documentation category register already marks Automation Tasks as `GLOBAL ✓`, so its status did not require a change.
- Changes remain unstaged and no commit, push, MR, or publishing action was performed.
