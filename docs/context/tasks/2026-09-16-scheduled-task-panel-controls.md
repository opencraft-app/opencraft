---
id: 2026-09-16-scheduled-task-panel-controls
type: task
scope: Scheduled-task templates, task-type card sizing, and recurring daily-time input behavior across LightVela domestic and global sites.
status: completed
---

## goal
Make the scheduled-task panel show templates only for Current Tasks, size task-type cards from their tallest content, and let recurring daily times be typed or selected from the clock picker.

## non_goals
- Do not change scheduled-task backend contracts, lifecycle classification, or deployment configuration.
- Do not change template content, supported locales, or the one-time picker behavior.

## requirement_ids / requirement_refs / requirement_excerpt
- User request from 2026-09-16: show templates only in Current Tasks, remove the fixed task-type card height while preserving equal-height cards, and support both typed and clock-picker recurring times across all languages and the domestic site.
- Follow-up: the recurring time control must use the same segmented input and picker design as One-time, limited to hour and minute fields, including its 144 px hour/minute picker column width.
- Follow-up: hide the hour/minute list scrollbars in both pickers and leave only the Confirm action below them.

## interface_refs / data_structure_refs
- `frontend/src/pages/marketing/agent-automations-panel.tsx`: shared domestic and global scheduled-task UI.
- `RecurringPicker`: preserves `HH:mm` values through `onTime` and `onDailyTimes`.
- Invariant: recurring time input and picker write the same schedule state.

## history_context
- `current_design_refs`: `frontend/openspec/specs/marketing.md`, `frontend/AGENTS.md`, and `docs/context/project/services/frontend.md`.
- `relevant_evolution`: the existing panel already separates Current Tasks, Ended Tasks, and Recent Runs and provides a vertical recurring-time picker.
- `superseded_refs`: none.

## acceptance
- Task templates render in Current Tasks only and are absent from Ended Tasks and Recent Runs.
- The three task-type cards share a grid row height determined by the tallest card, with no fixed minimum height.
- A recurring daily time uses the same segmented input and picker design as One-time, without date fields, and its hour/minute picker is 144 px wide like One-time's time column.
- Both pickers preserve scrolling without displaying a scrollbar and expose only Confirm below the selection columns.
- Focused domestic and global tests, i18n validation, lint, typecheck, and diff checks pass.

## affected_paths
- `frontend/src/pages/marketing/agent-automations-panel.tsx`
- `frontend/src/pages/marketing/__tests__/agent-automations-panel.test.ts`
- `frontend/src/pages/marketing/__tests__/agent-automations-panel.global.test.ts`
- `frontend/openspec/specs/marketing.md`

## required_context
- `docs/context/project/services/frontend.md`
- `docs/context/domains/site-environment-routing.md`
- `frontend/AGENTS.md`
- `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md`

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md` | Repository boundaries and validation rules | Preserve scope and verification requirements |
| `frontend/AGENTS.md` | Frontend implementation rules | Select focused frontend checks |
| `docs/context/project/services/frontend.md` | Shared domestic and global frontend boundary | Keep behavior in the shared panel |
| `docs/context/domains/site-environment-routing.md` | Domestic and global delivery contract | Verify both regional surfaces |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md` | i18n and test neighbor routing | Reuse existing locale keys and focused tests |
| `frontend/openspec/specs/marketing.md` | Scheduled-task design contract | Record durable UI behavior |

## evidence
- `HEAD` and `origin/master` both resolve to `feb0e69afbf8cea31b9929d313596eddbdd14a9f`.
- The bounded search located the templates section, task-type grid, recurring picker, and domestic/global component tests.
- Focused scheduled-task tests passed: 205 tests across domestic and global panel suites, including recurring picker width and no-Cancel/hidden-scrollbar assertions.
- `pnpm i18n:check`, `pnpm i18n:validate`, `pnpm typecheck`, `pnpm build:cn`, and `pnpm build:global` passed.
- The first global build exposed stale generated Next and Fumadocs state; regenerating Fumadocs and clearing only ignored `.next` output restored a passing build without source changes.

## risks
- Native time inputs can emit temporary invalid values while being edited.
- Mitigation: accept only the browser's valid `HH:mm` value, then pass it through the existing schedule state callbacks.

## validation
- Run focused domestic and global scheduled-task tests.
- Run frontend i18n validation, lint, typecheck, and `git diff --check`.

## decisions
- Keep the existing vertical hour and minute lists as the clock interaction.
- Use the shared i18n helper labels rather than adding duplicate locale keys.

## scan_scope
- `frontend/src/pages/marketing/agent-automations-panel.tsx`
- `frontend/src/pages/marketing/__tests__/agent-automations-panel.test.ts`
- `frontend/src/pages/marketing/__tests__/agent-automations-panel.global.test.ts`

## scan_output
- The bounded scan found templates rendered outside the active-view condition, `min-h-24` on all task-type cards, and a button-only recurring daily-time control.

## handoff
- Current state: picker scrollbar and footer actions are standardized across One-time and recurring controls.
- Next step: no implementation work remains; do not commit, push, or open an MR without user authorization.
- Blockers: none.
