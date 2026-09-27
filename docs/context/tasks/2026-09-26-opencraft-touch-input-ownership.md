---
id: task-opencraft-touch-input-ownership
type: task
scope: Make Codex account rows and shared Workbench controls distinguish touch from mouse hover across themes.
status: verified-in-source
---

## goal
Give Web/Electron Workbench one current-input signal, remove sticky touch hover from the Codex account list and shared controls, and keep account actions reachable with a touch-sized target.

## non_goals
- Claim that every feature-local hover rule in the entire Workbench has been audited or change Host/account credential semantics.
- Push, commit or replace the running Web service without a separate request.

## requirement_ids / requirement_refs / requirement_excerpt
- User, 2026-09-26: “codex 模型账户的item 对于触屏支持有问题 由此可见还是不是全主题全控件的触控升级”.

## interface_refs / data_structure_refs
- `main.tsx` owns the document-level pointer input signal on `document.documentElement`; touch/pen contact enables it, real mouse movement clears it.
- `controls.web.scss` and `menu.web.scss` own shared hover interpretation; theme tokens continue to own color values.
- `AccountRow` is a disclosure button plus independent Radix actions trigger; touch must not hide the latter or synthesize a persistent row surface.

## history_context
- `current_design_refs`: `opencraft/docs/workbench-design-language.md`, `opencraft/design/invariants.md#WSP-24`, `docs/engineering/domains/agent-gateway-runtime.md`.
- `relevant_evolution`: Activity previously used a list-local `data-touch-interaction` guard. Codex accounts still used unconditional `:hover`/`:focus-within`, a 28px actions trigger, and `(hover: none)` alone for visibility.
- `superseded_refs`: none.

## acceptance
- Touch scroll and tap do not leave a Codex account row in a mouse-hover fill; keyboard focus remains visible and mouse hover remains available after real mouse movement.
- Account actions are visible and at least 44px to hit for touch, without changing credential or menu semantics.
- Shared quiet/navigation/menu/Settings controls use the same input-mode rule and theme tokens; light/dark/extended themes do not fork behavior.
- Focused tests, Web typecheck/build and change-impact pass; actual mobile/browser verification is reported separately.

## affected_paths
- `opencraft/apps/workbench-web/src/main.tsx`
- `opencraft/apps/workbench-web/src/runtime/pointer-modality.ts`
- `opencraft/apps/workbench-web/src/components/sidebar.tsx`
- `opencraft/apps/workbench-web/src/styles/app.scss`
- `opencraft/apps/workbench-web/src/styles/settings-panel.scss`
- `opencraft/apps/workbench-web/src/styles/codex-accounts.scss`
- `opencraft/apps/workbench-web/src/styles/model-services.scss`
- `opencraft/apps/workbench-web/src/styles/sidebar-bots.scss`
- `opencraft/apps/workbench-web/src/styles/bot-management.scss`
- `opencraft/packages/design-system/src/controls.web.scss`
- `opencraft/packages/design-system/src/menu.web.scss`
- `opencraft/tests/sidebar-activity.test.ts`
- `opencraft/tests/codex-accounts-settings.test.ts`
- `opencraft/tests/pointer-modality.test.ts`
- `opencraft/docs/workbench-design-language.md`
- `opencraft/design/invariants.md`
- `docs/engineering/domains/agent-gateway-runtime.md`

## required_context
- Context router query `OpenCraft Codex accounts model account item touch scroll hover all themes controls design system` matched no pack. Bounded search located the Codex account component, Settings CSS, shared control/menu mixins, Activity's existing touch guard and neighboring account tests. The generic frontend adjacency card was checked and ruled out as LightVela-specific.

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md`, `opencraft/AGENTS.md` | repository and service constraints | scope, Task Pack, validation |
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md`, `references/verification.md` | interaction maintenance | input ownership and evidence levels |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md` | adjacency check | ruled out unrelated frontend card |
| `opencraft/docs/workbench-design-language.md`, `opencraft/design/invariants.md` | current UI contract | transient hover and theme token ownership |
| `opencraft/plugins/builtin-agents/src/codex-accounts/view.tsx`, `opencraft/apps/workbench-web/src/styles/codex-accounts.scss` | failing surface | disclosure/action split and unsafe hover/target |
| `opencraft/packages/design-system/src/controls.web.scss`, `menu.web.scss`, `opencraft/apps/workbench-web/src/styles/settings-panel.scss` | shared controls | repeated hover rules and target geometry |
| `opencraft/tests/codex-accounts-settings.test.ts`, `opencraft/tests/sidebar-activity.test.ts` | neighboring tests | coverage extension |

## evidence
- Codex account row sets fill on `&:hover, &:focus-within`; its 28px ellipsis is hidden except hover/focus or `(hover: none)`. Touch scrolling can synthesize or retain both states.
- Shared quiet/navigation/menu/Settings controls contain direct `:hover` rules; the previous Activity-only guard is not a global touch contract.
- Live user mobile state is not available to the agent; a local browser probe was attempted but the in-app browser did not respond.

## risks
- Hybrid devices need the last real pointer input, not only media capability; keyboard focus must not be removed while touch mode is active.
- Enlarging shared action hit areas can affect narrow layouts; verify account and Settings geometry.
- Other handcrafted feature hover selectors remain an explicit future audit, not a completed all-controls claim.

## validation
- Focused pointer/Activity/account tests passed (8/8); Web TypeScript and release build passed; `git diff --check` passed. The compiled CSS was inspected for guarded account, model-service and bot-management selectors. Explicit-file change-impact passed, with maintainer review advisory for `agent-gateway-runtime`; the staged-only check had no staged files. Real phone/Electron presentation remains a separate evidence level.

## decisions
- Put input-mode detection at the document boundary so Radix portals and all themes consume the same fact. Use design-system mixins for shared hover interpretation; keep Codex row layout in its feature CSS.

## scan_scope
- Bounded `codex-accounts`, Settings, design-system control/menu mixins, Activity touch behavior and adjacent tests; `:hover` inventory in Workbench styles.

## scan_output
- Nine style files contain hover rules, including 114 matches in `app.scss`; this task migrates shared primitives, affected account rows and nearby model-service/sidebar-bot controls, not every bespoke selector. The `any-hover`/`any-pointer` capability pair retains mouse hover on hybrid devices, while the document's current-input signal suppresses touch hover.

## handoff
- Source implementation and focused automated checks are complete. No phone or Electron interaction test was available, so full-theme/full-control touch acceptance remains open. No commit, push or deployment was performed; running preview remains at buildId `20260925114240-385dd3f8f717` until separately replaced.
