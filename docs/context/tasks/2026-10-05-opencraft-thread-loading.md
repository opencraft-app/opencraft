# Thread loading feedback

## goal
Show a centered neutral ring, without visible text, while a Thread first loads.

## non_goals
- No runtime, transport, ordering, scroll-policy or SSH deployment change.
- Do not hide retained history or replace failure/retry feedback.

## requirement_ids / requirement_refs / requirement_excerpt
- User 2026-10-05: thread 加载中的提示，不要文字，参考 Codex。

## interface_refs / data_structure_refs
- `conversationRecoveryPresentation`: existing authoritative/history/failure projection.
- `Conversation.emptyState`: only painted for an empty Timeline; no overlay.
- Feature owns status, DS owns neutral glyph/motion, Conversation owns geometry/scroll.

## history_context
- current_design_refs: `opencraft/docs/chat-ui-architecture.md`, `opencraft/design/invariants.md`.
- relevant_evolution: delayed skeleton already separates cold/warm recovery.
- superseded_refs: skeleton lines replaced, not an additional loading owner.

## acceptance
- Real DOM: centered ring, hidden label only, empty-slot lifetime, retry, preserved warm history/draft/scroll.
- Desktop/touch, light/dark/custom theme, reduced motion and forced colors.
- Focused unit tests, Web/DS typecheck, isolated browser smoke and Web build.

## affected_paths
- Web recovery/Startup/UI primitive, DS Web controls, tests/smoke, formal chat architecture.

## required_context / context_receipt
| File | Reason | Influence |
| --- | --- | --- |
| root and OpenCraft AGENTS.md | ownership and verification | preserve dirty worktree and view identity |
| opencraft-maintenance SKILL.md + verification.md | UI maintenance | real DOM verification required |
| frontend service + runtime/i18n adjacency | routed context | no generator-owned locale edits |
| chat-ui-architecture.md, design README | recovery contract | no warm overlay or new scroll owner |
| latest Codex immutable app-shared renderer, Wakaru cli/tli modules | visual reference | neutral ring + motion-safe rotation; not a copied runtime |

## evidence / validation
- `npm run test:thread-loading`: 2/2 passed, cold/warm/authority/failure and passive accessible SVG.
- Web and Design System workspace typechecks passed; `npm run check:boundaries` (including typography) passed; `git diff --check` passed.
- `npm run smoke:thread-loading`: 8 real-component Chromium cases passed (desktop/touch × Codex/custom × light/dark). Both cold slots center the ring; hidden label, semantic color, rotation/reduced motion, forced colors, retry and preserved warm DOM/input/scroll checked.
- Initial smoke harness import and premature virtualizer-scroll sampling corrected. Scroll retention is measured after actual layout/scroll frames settle, not after a fixed sleep.
- Isolated Web production build passed: `/data/opencraft-thread-loading-build-4ywXcJ/web`, build ID `20261005-thread-loading`; existing chunk-size/dynamic-import warnings remain.
- Screenshots reviewed: `/data/opencraft-thread-loading-build-4ywXcJ/screenshots/touch-codex-light.png` and `desktop-codex-dark.png`. Fixture footer is not the product Composer; no claim of physical iPhone or live preview verification.

## risks
- Empty slot can have zero height: verify both pre-lease stage and actual Conversation geometry.
- Chromium touch emulation is not physical iPhone verification.

## decisions
- Shared decorative SVG; accessible localized label belongs to the resource view.
- Retain existing CSS-only 200 ms reveal, use reduced-motion static ring.

## scan_scope / scan_output
- Bounded recovery/scroll CSS and latest Codex shared spinner module only.

## handoff
- Source implementation and scoped gates complete. The final formal headless candidate `/data/opencraft-ssh-flex-preview-0EUz5Y` includes this change, buildId `20261005-ssh-flex-thread-ring`; archive smoke and packaged SSH UI smoke passed. Independent temporary cutover succeeded: actual PID 576109, unit `opencraft-ssh-flex-20261005-preview.service`, cwd/runtime SHA/buildId/health verified after reconnect. Physical iPhone and external HTTPS entry unverified (server cannot connect to join.devcloud.woa.com:443); user-side refresh needed. The earlier SSH archive is stale and must not be deployed.
