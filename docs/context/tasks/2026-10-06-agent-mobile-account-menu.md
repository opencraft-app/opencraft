---
id: agent-mobile-account-menu-20261006
type: task
scope: Restore the Agent sidebar account menu in the mobile navigation drawer.
triggers: ["Agent mobile account menu"]
owner: LightVela frontend
authority: primary
source_of_truth:
  - frontend/src/pages/marketing/agent-settings-page.tsx
  - frontend/src/components/site/sidebar-user-menu-controller.tsx
status: in-review
reviewed_at: 2026-10-06
review_due: 2026-10-20
revision: 1.0.0
precedence: task
derived: false
---

## goal

Make the existing cloud storage, billing, and account menu reachable at the bottom of the mobile Agent drawer.

## non_goals

- No account, billing, route, desktop navigation, release, or backend behavior changes.

## requirement_ids / requirement_refs / requirement_excerpt

- User screenshots on 2026-10-06 show these entries in the desktop sidebar account menu and absent from the mobile drawer. External issue ID: unknown.

## interface_refs / data_structure_refs

- `AgentSettingsPage` renders `UserAvatarMenu` with `variant="sidebar"`; `SidebarUserMenuController` owns the existing routes and menu conditions.
- The mobile drawer keeps its fixed profile and footer outside `.lv-agents-sidebar-middle`, which alone scrolls.

## history_context

- `current_design_refs`: `frontend/src/components/site/sidebar-user-menu.README.md`, `docs/context/tasks/2026-10-05-agent-mobile-navigation.md`, current source at `f3046979d`.
- `relevant_evolution`: the mobile drawer landed with the account footer explicitly gated by `isDesktop`.
- `superseded_refs`: `frontend/openspec/changes/2026-08-24-sidebar-chat-settings-tabs-plan.md` describes an older sidebar shape.

## acceptance

- At mobile width, opening the drawer shows a bottom account trigger independently of a long conversation list; opening it exposes cloud storage, billing, and account links.
- Desktop menu behavior stays intact. Focused tests, frontend check and build, and `git diff --check` pass.

## affected_paths

- `frontend/src/pages/marketing/agent-settings-page.tsx`
- `frontend/src/styles.css`
- `frontend/src/pages/marketing/__tests__/agent-settings-labs-nav.test.tsx`
- This Task Pack.

## required_context

- `subscription-entitlements`, `frontend-product-surface`, and frontend service guidance.

## context_receipt

| File | Reason | Use |
|---|---|---|
| `AGENTS.md@user-provided` | Repository rules | Scope and validation |
| `docs/context/domains/subscription-entitlements.md@f3046979d` | Route must-read | Preserve billing authority |
| `docs/context/project/services/frontend.md@f3046979d` | Route must-read | Frontend validation |
| `frontend/AGENTS.md@f3046979d` | Nearest service rules | Frontend gates |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@f3046979d` | Adjacent source/test routing | Checked the current menu tests |
| `frontend/openspec/changes/2026-08-24-sidebar-chat-settings-tabs-plan.md@f3046979d` | Sidebar history | Avoid old tab assumptions |
| `docs/context/tasks/2026-10-05-agent-mobile-navigation.md@f3046979d` | Current mobile drawer design | Preserve fixed footer and scrollport |
| `frontend/src/components/site/sidebar-user-menu.README.md@f3046979d` | Current menu design | Reuse existing controller |

## evidence

- Exact search located `isDesktop ?` around the sidebar account footer; `SidebarUserMenuController` already supplies all three links.
- Mobile drawer interaction test opens the bottom account trigger, checks the three existing routes, and closes the drawer and menu.
- The first broad Vitest attempt opened this menu with an unstable repository mock and exhausted a worker. After stabilizing that mock, the focused five-file run passed 51/51 tests.
- A separate `user-avatar-menu.test.tsx` run reported two model-placement expectation failures. No model-placement source changed here; those assertions were not counted as passing validation.

## risks

- The footer must fit a 320px drawer and remain visible above the mobile safe area; the existing Popover uses collision bounds and viewport height limits.

## validation

- Focused Vitest for mobile drawer and sidebar menu, `pnpm check`, `pnpm build:cn`, `pnpm build:global`, `git diff --check`, and change-impact validation.
- Focused Vitest: 5 files, 51 tests passed. `pnpm check`: passed, 0 new TypeScript diagnostics. Both regional builds: passed. Documentation validator: no errors. `git diff --check`: passed.
- The repository has no `lint` script. The required `--staged` change-impact check passed with an empty staged set; affected source paths do not match a design-document mapping.

## decisions

- Reuse the desktop sidebar menu in the mobile drawer. Do not duplicate its links in the header menu.

## scan_scope

- Agent settings page, account menu components, responsive styles, and adjacent tests.

## scan_output

- Bounded symbol search: `UserAvatarMenu|mobileChatNavOpen|lv-agents-sidebar-footer`.

## handoff

- Implementation and local validation complete in the isolated worktree. On 2026-10-06 the user authorized commit, push, and MR creation. Authenticated phone browser visual acceptance remains unverified; merge and release are not authorized.
