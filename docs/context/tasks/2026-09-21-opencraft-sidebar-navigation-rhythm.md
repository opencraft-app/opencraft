## goal

Normalize the OpenCraft primary Sidebar navigation so Start and LightVela route rows share one leading icon slot, text axis and spacing rhythm, while removing the visible “Work” label.

## non_goals

- Do not change route identities, Skills/Storage availability, Host selection, task grouping, or sidebar resize behavior.
- Do not redesign Settings or account/footer navigation.
- Do not package, install, commit, push, or publish the application.

## requirement_ids / requirement_refs / requirement_excerpt

- User screenshot/request 2026-09-21: normalize the inconsistent Start/Skills spacing and remove the “Work” text.

## interface_refs / data_structure_refs

- `opencraft/packages/design-system/src/controls.web.scss`: `navigation-control` owns row interaction and typography.
- `opencraft/apps/workbench-web/src/components/sidebar.tsx`: Start defines the shared 28px leading slot.
- `opencraft/apps/workbench-web/src/components/lightvela-work-navigation.tsx`: standalone Workbench route navigation.
- Invariant: Start and contributed route rows consume the same row height, leading slot, gap and inline padding.
- Invariant: removing the visual group label does not remove the navigation landmark or route semantics.

## history_context

- `current_design_refs`: `opencraft/docs/workbench-design-language.md`, `opencraft/design/invariants.md`.
- `relevant_evolution`: Work routes already consume the shared navigation-control state tokens, but their raw SVG bypasses Sidebar’s leading slot and their wrapper stacks label-specific spacing.
- `superseded_refs`: none.

## acceptance

- “Work” is absent from the visible Sidebar while the nav retains its accessible label.
- Start and Skills icons/text share the same computed horizontal axes.
- Navigation rows use one 34px row height and 1px row gap; the task region has one intentional section gap rather than stacked margins.
- Focus/current-route behavior remains unchanged.
- Focused tests, typecheck/build and an isolated Electron CDP measurement pass.

## affected_paths

- `opencraft/apps/workbench-web/src/components/lightvela-work-navigation.tsx`
- `opencraft/apps/workbench-web/src/components/sidebar-navigation-item.tsx`
- `opencraft/apps/workbench-web/src/components/sidebar.tsx`
- `opencraft/apps/workbench-web/src/styles/app.scss`
- `opencraft/packages/design-system/src/tokens.web.scss`
- `opencraft/packages/design-system/src/controls.web.scss`
- `opencraft/tests/lightvela-work-navigation.test.ts`
- `opencraft/tests/workbench-sidebar-dock.test.ts`
- `opencraft/tests/typography-system.test.ts`
- `opencraft/design/invariants.md`
- `opencraft/docs/workbench-design-language.md`

## required_context

- Router weakly matched `frontend-product-surface`; its must-read derived service card was read, but implementation authority remains `opencraft/AGENTS.md` and OpenCraft design docs.

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `opencraft/AGENTS.md` | Shell and design-system ownership | Keep geometry in Shell/shared tokens, not page CSS. |
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md` | OpenCraft maintenance method | Preserve navigation semantics and verify current-source Electron. |
| `opencraft/.agents/skills/opencraft-maintenance/references/verification.md` | Sidebar validation matrix | Select shell tests and isolated CDP measurement. |
| `opencraft/docs/workbench-design-language.md` | Sidebar design authority | Reuse navigation-control and design tokens. |
| `opencraft/design/invariants.md` | Current Work-route invariant | Preserve standalone routes while removing only the label presentation. |
| `docs/context/project/services/frontend.md` | Router must-read | Confirm the root router match concerns a different frontend service. |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md` | Required adjacency check | Confirm no locale/generated frontend neighbor is involved. |

## evidence

- Before implementation, Start wrapped its icon in `.sidebar-action__icon` (28px), while Skills rendered a raw 17px SVG; Work navigation also added an 8px block inset, label row and 4px gap.
- The task list path stacked `sidebar-content-scroll`, `sidebar-tasks` and first target-group margins.
- The final model has one `SidebarNavigationItem` consumed by Start, Skills, contributed primary routes and footer actions. Design System owns the five row/section geometry tokens.
- Final isolated Electron CDP measurement: Start and Skills both use `row x=8 width=224 height=34`, `icon x=15 width=28`, `label x=51`, `gap=8px`, `padding-left=7px`; visible `Work` leaf count is zero.

## risks

- Removing the label could erase grouping for assistive technology; retain the existing `aria-label="LightVela work tools"` landmark.
- A selector-only patch could drift Start and Skills again; assert the shared leading-slot markup and computed geometry.
- Existing unrelated edits in `app.scss` and `design/invariants.md` must be preserved.

## validation

- Relevant navigation/typography tests via `--test-name-pattern` (4 passed).
- `npm run typecheck --workspace @opencraft/workbench-web` (passed).
- `npm run test:shell-space` (16 passed).
- `npx tsx --test tests/workbench-sidebar-dock.test.ts` (20 passed).
- `npm run check:boundaries` (passed).
- `npm run build:electron` (passed; existing bundle-size/dynamic-import warnings only).
- Isolated Electron CDP snapshot and computed row/icon/text geometry (passed in normal and selected states).
- Full `lightvela-work-navigation.test.ts` still has two pre-existing failures from unrelated in-progress Skills/DSH changes (`customSkillDirs` and an obsolete install-target copy assertion); the four tests in this change set pass.
- Bounded change-impact, documentation validation and scoped `git diff --check` passed; mapped owner review remains required.

## decisions

- Keep LightVela routes as a separate semantic nav landmark but present its rows as a continuous primary navigation cluster.
- Model Start and contributed routes as the same `SidebarNavigationItem`; containers own only landmark/section semantics.
- Design System owns leading slot, inline padding, content gap, row gap and section gap; feature CSS adds no competing item geometry.

## scan_scope

- Sidebar component, LightVela Work navigation, adjacent SCSS and focused tests only.

## scan_output

- Exact search found the label in `lightvela-work-navigation.tsx`, feature spacing in `app.scss`, shared leading slot in `sidebar.tsx`, and focused regression tests in `lightvela-work-navigation.test.ts`.

## handoff

- Implementation and isolated Electron geometry verification complete. The preview was stopped; the installed `/Applications/OpenCraft.app` was not replaced.
