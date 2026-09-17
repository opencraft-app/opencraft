---
id: opencraft-skills-scroll-ownership
type: task
scope: Restore Skills scrolling by separating edge-to-edge inset policy from Settings viewport scroll ownership.
triggers: ["Skills scroll", "edge-to-edge", "Settings viewport"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - opencraft/packages/extension-contract/src/index.ts
  - opencraft/apps/workbench-web/src/components/settings-page.tsx
  - opencraft/apps/workbench-web/src/styles/app.scss
status: active
reviewed_at: 2026-09-17
review_due: 2026-12-16
revision: 1.0.0
precedence: task
derived: false
---

## goal

Make long edge-to-edge Settings pages scroll through one Shell-owned viewport without reintroducing document padding or nested page scrollbars.

## non_goals

- Do not add a Skills-local overflow wrapper.
- Do not change master-detail pane ownership, catalog content, Header geometry or page data.

## requirement_ids / requirement_refs / requirement_excerpt

- User request, 2026-09-17: inspect Codex and rectify the Skills page that cannot scroll vertically.

## interface_refs / data_structure_refs

- `SettingsPageContribution.layout` controls inset/topology, not arbitrary feature CSS.
- `document` and `edge-to-edge` retain the Settings viewport as vertical scroll owner.
- `master-detail` alone delegates scrolling to bounded child panes.

## history_context

- Skills moved its toolbar into the persistent AppShell Header and declared `edge-to-edge` to remove stacked document insets.
- The original rule also set the viewport to `overflow: hidden`, assuming an internal page scroll owner that Skills never had.
- Codex keeps Header and scrollport as siblings; the scrollport is `h-full min-h-0 flex-1`, `overflow-x-hidden`, `overflow-y-auto`, with stable scrollbar gutter.

## acceptance

- Skills can scroll from top to bottom with the AppShell Header fixed.
- Exactly one page-level vertical scroll owner exists.
- Cloud Storage/document and master-detail behavior remain unchanged.
- Scroll position changes in a real Electron window and content is not clipped.

## affected_paths

- `opencraft/packages/extension-contract/src/index.ts`
- `opencraft/apps/workbench-web/src/styles/app.scss`
- `opencraft/tests/lightvela-work-navigation.test.ts`
- `opencraft/design/invariants.md`
- `opencraft/docs/platform-architecture.md`

## required_context

- `frontend-product-surface`; OpenCraft maintenance and baseline UI constraints.

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/project/services/frontend.md@worktree` | Router-required frontend context. | Preserve UI validation boundary. |
| `opencraft/AGENTS.md@worktree` | Local ownership and preview rules. | Keep scroll ownership in Shell. |
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md@worktree` | Required maintenance method. | Fix the geometry owner instead of feature CSS. |
| `opencraft/.agents/skills/opencraft-maintenance/references/verification.md@worktree` | Runtime validation matrix. | Require real Electron scroll evidence. |
| `opencraft/.agents/skills/baseline-ui/SKILL.md@worktree` | UI baseline. | Avoid nested viewport and layout animation. |
| `ref/codex/lazy/app-initial/chat-home-page.js@worktree` | Requested Codex source reference. | Recover Header sibling plus single auto-scroll viewport topology. |

## evidence

- Before: Electron Settings viewport `clientHeight=914`, `scrollHeight=1746`, `overflowY=hidden`, `scrollTop=0`; no descendant owns vertical scrolling.
- An isolated runtime probe changing only that viewport to `overflow-y:auto` reached `scrollTop=320`, then restored the original value.
- Codex source uses a Header sibling plus `relative h-full min-h-0 flex-1 [scrollbar-gutter:stable] overflow-x-hidden overflow-y-auto` viewport in `ref/codex/lazy/app-initial/chat-home-page.js`.
- Focused Skills/layout suites: 77 passing; Extension Contract and Web typechecks pass; Electron build passes.
- Final isolated Electron preview on CDP 9346 reports exactly one page-level scroll owner (`settings-page__viewport`): `clientHeight=914`, `scrollHeight=1746`, `overflowY=auto`, stable gutter, top `scrollTop=0`, bottom `scrollTop=832`. AppShell Header stays at `top=0`, `bottom=46`; Skills remains current; route switch to Cloud Storage resets viewport to `scrollTop=0` with no renderer exception.
- Visual bottom-state evidence: `/tmp/opencraft-skills-scroll-bottom.png`.

## risks

- Restoring outer scrolling must not create a second page scrollbar or affect master-detail pages.
- Scrollbar appearance must not shift content width when content length changes.

## validation

- Focused layout test, Web/contract typechecks, Electron build.
- Real Electron top/bottom scroll, owner count, Header rect and Skills→Storage route check.

## decisions

- Follow Codex's sibling Header and single `min-height:0` auto-scroll viewport.
- Keep `edge-to-edge` as an inset policy; do not introduce a new feature-owned scroll wrapper.

## scan_scope

- Settings layout contract, Shell viewport CSS, Skills route, Codex recovered layout source.

## scan_output

- Bounded exact source trace; no graph extraction used.

## handoff

- Implementation and real Electron verification complete in the current dirty worktree. Preview remains running on CDP 9346. No commit, push, MR or release is included without separate authorization.
