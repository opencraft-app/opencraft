---
id: task-opencraft-activity-menu-surface
type: task
scope: Match Activity ellipsis trigger background to its task row surface.
status: implemented-unreleased
---

## goal
Make the Activity row's “…” trigger visually share the row background across hover, selected, touch, focus and open states.

## non_goals
- Change thread identity, menu actions, list order, touch hit area, or running preview without a separate replacement request.

## requirement_ids / requirement_refs / requirement_excerpt
- User, 2026-09-25: “活动页面‘ ... ’按钮这个颜色我希望能和背景相同。你看看codex 怎么建模的呗”.

## interface_refs / data_structure_refs
- `SidebarActivityItem` owns route selection; `ThreadRowMenu` owns an independent Radix trigger because nested buttons are invalid.
- `app.scss` owns the row hover/selection surface and trigger visibility; `data-touch-interaction` guards simulated hover.

## history_context
- `current_design_refs`: `opencraft/docs/workbench-design-language.md`, `opencraft/design/invariants.md#WSP-24`.
- `relevant_evolution`: `2026-09-25-opencraft-sidebar-activity-touch.md` established one Activity component with input-adaptive hover and 44px touch trigger. Codex r3562 local desktop snapshot is not present at its documented path; the public Codex app docs do not expose internal sidebar CSS. Reference is a state/interaction principle, not copied source.
- `superseded_refs`: none.

## acceptance
- Trigger has no independent background in default/hover/selected/touch/open states; row hover persists while pointer is over it.
- Touch drag remains free of simulated hover; menu remains reachable at 44px; focus ring remains visible.
- Focused test, Web typecheck and CSS build pass; report live-preview status separately.

## affected_paths
- `opencraft/apps/workbench-web/src/styles/app.scss`
- `opencraft/tests/sidebar-activity.test.ts`
- `opencraft/docs/workbench-design-language.md`
- `opencraft/design/invariants.md`
- `docs/engineering/domains/agent-gateway-runtime.md`

## required_context
- Router query `OpenCraft activity sidebar conversation ellipsis menu trigger background match row Codex reference touch hover` matched no Pack. Bounded search found `ThreadRowMenu`, `SidebarActivityItem`, Activity SCSS and focused test; frontend adjacency card checked the test neighbor.

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md`, `opencraft/AGENTS.md` | repository and service constraints | ownership, preservation and validation |
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md` | interaction task | model one row surface |
| `opencraft/.agents/skills/opencraft-maintenance/references/verification.md` | verification | touch and desktop checks |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md` | adjacency | focused test/build neighbor |
| `opencraft/docs/platform-architecture.md` | Shell ownership | no Thread/Host authority changes |
| `opencraft/docs/workbench-design-language.md`, `opencraft/design/invariants.md` | current UI contract | row/trigger split |
| `opencraft/vendor/codex/IMPORT_MAP.json` | reference provenance | old reference path not available |
| `opencraft/tests/sidebar-activity.test.ts` | neighbor | regression assertion |

## evidence
- Current trigger independently set tertiary-hover background; selected override set another fill. The sibling row button already owned row fill.
- Official Codex app page was fetched; it does not establish the internal CSS contract. Historical local r3562 path is unavailable.
- Focused Activity and sidebar dock tests: 25/25 passed. Web TypeScript check, release Web build and `git diff --check` passed.
- Compiled CSS maps the trigger background to transparent (`background:0 0`) and places row hover on `.sidebar-activity-row:hover > .sidebar-activity-item`.
- An isolated static browser preview was opened, but this session's mobile browser interface did not permit a screenshot or DOM inspection without the Preview Bridge. The temporary preview page was closed and removed; no real touch/desktop visual confirmation is claimed.

## risks
- Pointer entering a sibling trigger can drop `item:hover`; row wrapper must own hover continuity.
- On touch, transient hover must remain disabled; transparent trigger still needs a 44px hit area.

## validation
- `tests/sidebar-activity.test.ts`, Web TypeScript, Web build, change-impact and diff check; actual rendered browser if available.

## decisions
- Keep one CSS surface owner on the main row; use transparent trigger and wrapper-scoped hover, rather than copying color tokens to the trigger.

## scan_scope
- Exact Activity component, trigger and SCSS region; no broad reference-repo scan.

## scan_output
- Bounded source search only; no saved scan artifact.

## handoff
- Source and build output are updated. Running local preview remains buildId `20260925103419-23c1aeeb42e7`; this change has not been deployed. Next safe step is a separately authorized preview replacement followed by real touch/desktop visual check.
