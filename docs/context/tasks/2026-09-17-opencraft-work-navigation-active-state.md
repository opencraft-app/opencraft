---
id: opencraft-work-navigation-active-state
type: task
scope: Keep the active Skills or Cloud Storage destination visibly selected in the shared OpenCraft sidebar.
triggers: ["Work navigation", "Skills active state", "Cloud Storage active state"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - opencraft/packages/design-system/src/theme-engine.ts
  - opencraft/packages/design-system/src/controls.web.scss
  - opencraft/apps/workbench-web/src/components/lightvela-work-navigation.tsx
status: active
reviewed_at: 2026-09-17
review_due: 2026-12-16
revision: 1.0.0
precedence: task
derived: false
---

## goal

Make the current Skills or Cloud Storage route retain the same visible selected state as other sidebar navigation rows.

## non_goals

- Do not add a new route store, navigation state, animation, or feature-local color token.
- Do not change the Skills or Cloud Storage page layout.

## requirement_ids / requirement_refs / requirement_excerpt

- User screenshot and clarification, 2026-09-17: when currently inside Skills, the corresponding Work navigation row needs a persistent location cue.

## interface_refs / data_structure_refs

- `LightVelaWorkNavigation.section` remains the route-derived authority.
- `aria-current="page"` remains the accessible selected-state contract.
- Theme Engine owns distinct navigation hover/current/pressed colors.
- `controls.navigation-control` is the only owner that maps those tokens to interaction state.

## history_context

- The route already projected `aria-current`, but Work navigation used a feature-local `background-tertiary` that was visually indistinguishable from the sidebar surface in the light theme.

## acceptance

- Skills remains visibly selected while its route is active; Cloud Storage receives the state after navigation.
- Work, Settings and platform Shell rows consume the shared navigation state primitive without feature-local colors or motion.
- Focus visibility and route semantics remain intact.

## affected_paths

- `opencraft/apps/workbench-web/src/styles/app.scss`
- `opencraft/apps/workbench-web/src/components/shell-navigation/shell-navigation.scss`
- `opencraft/packages/design-system/src/theme-engine.ts`
- `opencraft/packages/design-system/src/controls.web.scss`
- `opencraft/tests/lightvela-work-navigation.test.ts`

## required_context

- `frontend-product-surface`; OpenCraft local AGENTS and UI ownership rules.

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/project/services/frontend.md@worktree` | Router-required frontend context. | Preserve product UI validation boundaries. |
| `opencraft/AGENTS.md@worktree` | OpenCraft UI ownership and verification rules. | Reuse Design System state primitives. |
| `opencraft/.agents/skills/baseline-ui/SKILL.md@worktree` | UI baseline requested by task match. | Avoid feature-local state styling and new motion. |

## evidence

- Focused Work navigation, appearance theme and Shell navigation suites: 31 passing; Design System and Web typechecks pass; Electron build passes.
- Isolated Electron preview on CDP 9345 confirms both themes and both routes: Skills owns `aria-current="page"` at `/settings/lightvela.hermes.skills`, then Cloud Storage owns it after navigation to `/settings/lightvela.hermes.storage`.
- Dark computed state hierarchy is hover `0.065`, current `0.114`, pressed `0.16`; current row is 34px and inactive rows remain transparent. Light screenshot `/tmp/opencraft-navigation-system-light.png` shows a persistent selected surface without layout shift or renderer exception.

## risks

- Selected fill must remain theme-token driven and must not obscure keyboard focus.

## validation

- Focused Work navigation test, Web typecheck, Electron build and live light/dark route inspection.

## decisions

- Keep route selection in React, define the state family once in Theme Engine, and let `controls.navigation-control` map semantic state to appearance for every shell consumer.

## scan_scope

- Work navigation component, shared navigation primitive, Work navigation stylesheet and focused tests.

## scan_output

- Bounded source trace; no graph extraction used.

## handoff

- Implementation and live verification complete in the current dirty worktree. The isolated Electron preview remains running on CDP 9345. No commit, push, MR or release is part of this task unless separately requested.
