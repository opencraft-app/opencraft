## goal

Implement the agreed MR 4390 frontend optimization plan: make console show state ownership explicit, align the affected Radix dependencies and lockfile, and make the Agent sidebar fit the 14-inch MacBook Pro reference viewport while preserving an independently scrollable middle area.

## non_goals

- No production deployment or GitOps changes.
- No redesign of account or Agent navigation content.
- No changes to backend contracts, billing behavior, or site routing.

## requirement_ids / requirement_refs / requirement_excerpt

- MR 4390 review comments: resolve remaining correctness, dependency, lockfile, and sidebar density concerns.
- User requirement: anchor sidebar validation to a 14-inch MacBook Pro and adjust vertical spacing/button height so fixed navigation fits one viewport.

## interface_refs / data_structure_refs

- `frontend/src/lib/console-show-event.ts`: durable console-show state and command installation.
- `frontend/src/pages/marketing/agent-console-helpers.ts`: console helper ownership of `show()`.
- `frontend/src/components/site/agent-sidebar.tsx`: sidebar scroll ownership.
- `frontend/src/styles.css`: desktop sidebar geometry and navigation density.
- Invariant: fixed sidebar regions remain visible; dynamic middle content owns vertical scrolling.

## history_context

- `current_design_refs`: `docs/context/project/services/frontend.md`, `docs/context/domains/site-environment-routing.md`, `frontend/AGENTS.md`.
- `relevant_evolution`: MR review identified ambiguous show toggling, multiple Radix versions, lockfile re-resolution, and sidebar density concerns; later commits already removed the old feedback-link and external memory/account dead-code shapes.
- `superseded_refs`: historical review comments about `MemoryPanelView` and external account cards are not current production structure.

## acceptance

- One `show()` toggle owner with remount and multi-surface tests.
- Radix dialog/popover dependencies use the selected compatible version without avoidable duplicate runtime versions.
- Lockfile changes are limited to intentional dependency updates.
- At viewport `1512x850` CSS px, fixed Agent sidebar regions and account footer are visible without page-level horizontal overflow; dynamic middle content scrolls independently.
- A compact desktop density applies to short viewports without changing mobile layout.
- Focused tests, frontend checks, OpenCraft guard, and preview smoke verification pass.

## affected_paths

- `frontend/src/lib/console-show-event.ts`
- `frontend/src/pages/marketing/agent-console-helpers.ts`
- `frontend/src/components/site/agent-sidebar.tsx`
- `frontend/src/components/site/__tests__/`
- `frontend/src/pages/marketing/__tests__/`
- `frontend/src/styles.css`
- `frontend/package.json`
- `frontend/pnpm-lock.yaml`
- `opencraft/plugins/lightvela-hermes/package.json`
- `docs/context/tasks/2026-09-28-mr4390-sidebar-optimization.md`

## required_context

- `service-frontend`: frontend service boundaries and validation.
- `site-environment-routing`: domestic/international UI boundary and locale validation.
- `frontend/AGENTS.md`: frontend implementation and gate rules.
- `baseline-ui`: UI density, accessibility, and layout constraints.

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/project/services/frontend.md` | 前端服务边界与验证 | 确定改动范围和门禁 |
| `docs/context/domains/site-environment-routing.md` | 双站与 locale 约束 | 保持国内/国际站行为一致 |
| `frontend/AGENTS.md` | 本地前端实现规则 | 依赖、样式和测试约束 |
| `.agents/skills/baseline-ui/SKILL.md` | 导航密度与可访问性 | 约束按钮高度、焦点和布局 |

## evidence

- Current branch: `frontsandbox/agents-sidebar-account-hit-area`.
- Current HEAD: `0fbcd0b0b`.
- Current `opencraft guard` evidence: passed after this task.
- Current source inspection: live page and loading view contain `.lv-agents-sidebar-middle`; current dependency graph still declares multiple Radix dialog versions.

## risks

- Changing `show()` ownership can alter hidden-entry visibility across Header and Sidebar; mitigate with multi-mount tests.
- Compact density can clip localized labels or keyboard focus; mitigate with domestic/international strings and viewport checks.
- Lockfile regeneration can introduce unrelated updates; mitigate by reviewing the final lockfile diff against the target branch.

## validation

- Focused Vitest suites for console helpers, sidebar, account menu, and navigation geometry.
- `pnpm --dir frontend check` and `pnpm --dir frontend test` as the final frontend gates.
- `npm --prefix opencraft run check:mono2-agent-console` after source synchronization.
- Preview HTTP and visual smoke checks at the reference viewport.

## decisions

- Reference viewport: `1512x850` CSS px.
- Fixed navigation is the one-screen criterion; unbounded session history remains scrollable inside middle.
- Desktop compact mode may reduce nav item height to `30px`, never below that value; mobile layout remains unchanged.

## scan_scope

- `frontend/src/lib/console-show-event.ts`
- `frontend/src/pages/marketing/agent-console-helpers.ts`
- `frontend/src/components/site/`
- `frontend/src/styles.css`
- `frontend/package.json`
- `frontend/pnpm-lock.yaml`

## scan_output

- Focused Vitest: 6 files, 60 tests passed.
- `frontend check`: passed; typecheck reported 171 current / 171 baseline / 0 new.
- Frozen lockfile check: passed; `git diff --check`: passed.
- `opencraft check:mono2-agent-console`: passed.
- Preview endpoints returned HTTP 200 for domestic and international URLs.
- Full frontend suite remains baseline-blocked: multiple pre-existing failures and Node heap OOM; no failure was in the focused sidebar/console suites.

## handoff

- Current state: implementation committed and pushed as `8a7aee5f1`.
- Next: reviewer should inspect the intentional Radix version alignment and the full-suite baseline failures separately.
- Blockers: full frontend suite is not green because of unrelated existing failures and heap exhaustion; browser sidebar visual verification requires an authenticated preview session.
