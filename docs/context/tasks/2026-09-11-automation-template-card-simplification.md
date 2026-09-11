## goal
Simplify scheduled-task template cards across domestic and international sites and keep the three blank-create task types visually aligned so every locale shows a clickable card without a Hermes source badge, visible enable affordance, notification metadata, or skill metadata.

## non_goals
- Do not change template creation, scheduling, notification, or skill-preselection behavior.
- Do not change category filtering, pagination, collapse behavior, or runtime template sources.
- Do not alter task-type semantics or the fields rendered for intelligent, notification, and script tasks.

## requirement_ids / requirement_refs / requirement_excerpt
- User request, 2026-09-11: remove the top-right Hermes tag, remove the Enable arrow and all localized equivalents because the card is clickable, and show only each template schedule in the card footer.
- User follow-up, 2026-09-11: keep the three create-task type variants at the same visual height by letting blank space above the action buttons vary, including while toggling between types, without internally scrolling the longest form.
- User follow-up, 2026-09-11: on ended-job cards, retain only View and Delete in the bottom action row and align that pair on the right.
- User follow-up, 2026-09-11: replace current-job bottom actions with a three-dot control that rolls the original action buttons out to the left on hover and rolls them back when the pointer leaves.
- User follow-up, 2026-09-11: remove the rollout container border, vertically center it with the three-dot trigger, keep clicks on the trigger from leaving it open, and stagger the buttons from left to right on open and right to left on close.
- User follow-up, 2026-09-11: add Copy to both current- and ended-job rollouts and open the standard create flow prefilled with the source job's task type, name, content, schedule, and editable settings.
- User follow-up, 2026-09-11: keep template-create and edit modals at the same height while switching run-frequency selections, using flexible space above the action row rather than resizing the dialog.
- User follow-up, 2026-09-11: in the blank Create Task form, preselect every connected notification channel while allowing each channel to be turned off individually.

## interface_refs / data_structure_refs
- `AutomationScenarioTemplatesSection` remains a button per template and continues to call `onEnable(template)`.
- `AutomationCatalogTemplate` keeps `notificationPolicy` and `skills` because creation behavior consumes those fields even though the card no longer displays them.

## history_context
- `current_design_refs`: `frontend/src/pages/marketing/agent-automations-panel.tsx` is the current shared implementation.
- `relevant_evolution`: `docs/context/tasks/2026-09-06-zero-token-automation-tasks.md` confirms the scheduler and template workflow are shared across domestic and international sites.
- `superseded_refs`: none.

## acceptance
- The Hermes badge is absent from every template card.
- Cards remain clickable and use the template name as their accessible button name.
- The footer shows only the schedule with its clock icon.
- The three task-type controls share a minimum height and the blank-create dialog uses the longest base form height, leaving flexible space above an aligned action row for shorter task types.
- Template-create and edit dialogs keep that same action-row position while their run-frequency controls change.
- Current and ended job rollouts include Copy, which opens create mode prefilled from the source without modifying it.
- A blank Create Task form selects all currently connected notification channels by default, while template, copy, and edit forms preserve their own delivery configuration.
- Targeted component tests and locale checks pass.

## affected_paths
- `frontend/src/pages/marketing/agent-automations-panel.tsx`
- `frontend/src/pages/marketing/__tests__/agent-automations-panel.test.ts`

## required_context
- No router Task Pack matched the initial query.
- `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md` supplies the frontend and locale adjacency requirements.

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md` | 仓库级边界与 Task Pack 规则 | 限定变更和验证流程 |
| `frontend/AGENTS.md` | 前端服务规则 | 要求视觉变更具备组件测试或截图证据 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@1.0.0` | 前端、双站和 i18n 邻接 | 确认共享实现和 locale 生成验证 |
| `docs/context/tasks/2026-09-06-zero-token-automation-tasks.md` | 自动任务已有行为边界 | 保留模板启用和 scheduler 数据行为 |

## evidence
- Context route query `scheduled task automation template cards remove Hermes tag Enable arrow bottom metadata` did not match a Pack.
- Bounded frontend search located the shared card renderer and its focused component test.
- Focused automation suite passed 181 tests.
- The global-region tab-order contract passed under the global build flags.
- Typecheck baseline passed with zero new diagnostics, and i18n extraction reported zero missing required translations.
- Focused automation suite passed 182 tests, including connected-channel defaults and manual opt-out.
- The initial 720px fixed-height attempt incorrectly introduced an inner form scrollbar and was replaced with a 860px minimum-height dialog that allows the longest form to render naturally.

## risks
- Removing metadata from the card must not remove the underlying fields because template creation still uses notification and skill configuration.
- Removing the visible enable text must retain a meaningful accessible button name and click behavior.

## validation
- Run the focused Vitest file for the automation panel.
- Run `pnpm i18n:check`, `pnpm i18n:validate`, `pnpm typecheck`, and `git diff --check` from `frontend/`.
- Run the repository change-impact validation without staging unrelated user work.

## decisions
- Use the template name as the card button's accessible name instead of a localized enable phrase.
- Keep the clock and schedule label as the only footer metadata.

## scan_scope
- `frontend/src/pages/marketing/agent-automations-panel.tsx`
- `frontend/src/pages/marketing/__tests__/agent-automations-panel.test.ts`
- `frontend/src/i18n/`

## scan_output
- One shared renderer serves both regional builds and all locales.

## handoff
- Complete.
- Domestic focused automation suite passed 178 tests.
- Global focused card and blank-create layout contracts passed 2 tests.
- i18n extraction and validation, frontend typecheck, diff check, documentation validation, and change-impact validation passed.
- Locale validation reported 49 pre-existing warnings and zero errors.
- The blank-create dialog no longer has an internal form scrollbar, and its action row follows the longest base task type while shorter types leave blank space above it.
- The blank-create dialog is vertically centered in the page whenever its full height fits in the viewport.
- Ended-job cards expose only View and Delete through the same right-aligned three-dot hover rollout used by current-job cards.
- Current-job cards keep their original actions in an accessible, three-dot hover rollout positioned to the left of the trigger.
- The current-job rollout has no border, shadow, or padding, stays vertically centered with the trigger, fades its white mask in only while the action rollout is active to cover schedule text beneath it, ignores pointer clicks on the trigger, reveals from the trigger toward the left, and retracts from the left back toward the trigger with a 100ms staggered opacity sequence that respects reduced-motion preferences.
- The schedule mask is structurally separate from the icon row, so its exit transition cannot shift action buttons while they are retracting.
- Copy opens create mode with the source job as initial form data, creates a new task and any required managed script, and never edits the source job.
- Template-create and edit forms use the same 860px minimum-height, bottom-aligned action row as the blank create flow, with page-level scrolling only when needed.
