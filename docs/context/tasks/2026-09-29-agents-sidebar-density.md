## goal
Tighten the desktop Agents left-navigation vertical rhythm, slightly enlarge its item labels, and open the desktop account menu on hover while preserving existing keyboard and touch behavior.

## non_goals
- Do not change Agents navigation entries, routing, copy, or mobile layout.
- Do not merge, publish, or change any deployment or production state.

## requirement_ids / requirement_refs / requirement_excerpt
- User request, 2026-09-29: sync the latest remote master; make the Agents left navigation row spacing smaller, and make labels such as "通道" and "技能" slightly larger by referencing the prior common density.
- Follow-up request: the left-bottom account menu should expand on hover.
- Delivery request: submit the completed change as a Gongfeng merge request.

## interface_refs / data_structure_refs
- `frontend/src/pages/marketing/agent-settings-page.tsx`: emits the shared Agents navigation for domestic and international sites.
- `frontend/src/styles.css`: desktop sidebar rules override the shared navigation defaults at `min-width: 1024px`.
- `frontend/src/components/site/sidebar-user-menu.tsx`: owns the desktop sidebar account-menu trigger and Popover interaction.
- `opencraft/plugins/lightvela-hermes/src/upstream/mono2/UPSTREAM.json`: records the frontend source revision for the mechanical OpenCraft Agent Console snapshot.
- Invariant: mobile (`max-width: 1023px`) retains its 36px navigation item height and existing grid layout.

## history_context
- `current_design_refs`: current `origin/master` (`4e616ad0de7beb7f0f27f6eaa83bc53c50bc4149`) and `frontend/src/pages/marketing/__tests__/agent-settings-nav-spacing.test.ts`.
- `relevant_evolution`: `e1b649478` introduced compact-sidebar variables; the desktop middle-panel override still expands group and item gaps to 12px and 4px and renders labels at 12px.
- `superseded_refs`: none.

## acceptance
- Desktop navigation group and row gaps use the denser values (4px and 0px).
- Desktop navigation item labels are 13px, without changing the mobile rule.
- Hovering the desktop account trigger opens its existing Popover; click and keyboard interactions remain available.
- The focused navigation-spacing test and the frontend type/check gate pass.
- The vendored OpenCraft manifest records the delivered frontend commit and passes its drift check.

## affected_paths
- `frontend/src/styles.css`
- `frontend/src/pages/marketing/__tests__/agent-settings-nav-spacing.test.ts`
- `frontend/src/components/site/sidebar-user-menu.tsx`
- `frontend/src/components/site/__tests__/sidebar-user-menu.test.tsx`
- `frontend/src/components/site/__tests__/user-avatar-menu.test.tsx`
- `opencraft/plugins/lightvela-hermes/src/upstream/mono2/UPSTREAM.json`

## required_context
- `frontend-product-surface`
- `docs/context/project/services/frontend.md`
- `frontend/AGENTS.md`
- `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md`

## context_receipt
| File | Reason read | Use in this task |
|---|---|---|
| `docs/context/project/services/frontend.md@4e616ad0d` | Frontend product-surface routing result | Confirms focused UI test and dual-site evidence are needed. |
| `frontend/AGENTS.md@4e616ad0d` | Service-level rules | Defines the frontend verification boundary. |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@4e616ad0d` | Required adjacent test/configuration check | Routes the change to the existing navigation-spacing test. |
| `frontend/src/styles.css@4e616ad0d` | Current rendering authority | Identifies the desktop-only gap and font-size overrides. |
| `frontend/src/pages/marketing/__tests__/agent-settings-nav-spacing.test.ts@4e616ad0d` | Adjacent regression coverage | Provides the focused source-level contract to extend. |
| `frontend/src/components/site/sidebar-user-menu.tsx@4e616ad0d` | Screenshot target implementation | Preserves the existing Popover semantics while adding hover opening. |
| `frontend/src/components/site/__tests__/sidebar-user-menu.test.tsx@4e616ad0d` | Interaction regression coverage | Verifies hover, click, Escape, focus return, and menu content. |
| `opencraft/AGENTS.md@a235443ec` | Generated-closure ownership and validation rules | Requires synchronizing and checking the vendored Agent Console snapshot after frontend source changes. |

## evidence
- `git fetch origin master` updated `origin/master` from `9dd39f190` to `4e616ad0d`.
- The primary checkout was dirty; work proceeds in an isolated worktree at the fetched master commit.
- `pnpm exec vitest run src/pages/marketing/__tests__/agent-settings-nav-spacing.test.ts --api.host 127.0.0.1`: 7/7 passed. The `--api.host` override avoids this environment's `localhost` DNS failure.
- `pnpm check`: passed with 166 current diagnostics, 171 baseline, and 0 new diagnostics.
- `python3 .agents/context/scripts/validate_documentation.py --repo . --format json`: passed with no errors or broken first-party links.
- `python3 .agents/context/scripts/validate_change_impact.py --repo . --staged`: passed for all six changed files; they were subsequently returned to the unstaged working tree because remote delivery was not authorized.
- Local CN preview at `http://127.0.0.1:5174/agents/` rendered the shared Agents navigation at 1440px and 720px. Desktop showed the adjusted density; the narrow layout retained its existing two-column groups and touch targets.
- Follow-up visual adjustment: desktop middle-panel gaps were tightened to 4px between groups and 0px within groups. The focused spacing test remains 7/7 passed, and the existing Whistle proxy returned the local `/agents/` response with HTTP 200.
- Hover interaction: `pnpm exec vitest run src/components/site/__tests__/sidebar-user-menu.test.tsx src/components/site/__tests__/user-avatar-menu.test.tsx src/pages/marketing/__tests__/agent-settings-nav-spacing.test.ts --api.host 127.0.0.1` passed 54/54. It verifies hover opening, click and keyboard entry, nested-language Escape handling, and focus return.
- Final `pnpm check` passed with 166 current diagnostics, 171 baseline, and 0 new diagnostics; `git diff --check` passed.
- CI repair: `npm --prefix opencraft run sync:mono2-agent-console` synchronized the generated manifest to `a235443ec`; `npm --prefix opencraft run check:mono2-agent-console` verified all 130 vendored files.
- Conflict repair: after `origin/master` advanced to `c1df25f86`, the only merge conflict was the mechanical `UPSTREAM.json`. The target snapshot was used as the merge baseline, then the closure was regenerated from merge commit `b7da9f628`; `check:mono2-agent-console` again verified all 130 files.
- Post-merge regression: the three focused sidebar suites passed 54/54; `pnpm check` passed with 166 current diagnostics, 171 baseline, and 0 new diagnostics.

## risks
- Reducing desktop spacing could affect compact desktop viewports. Existing max-height variables remain the source of truth for that variant.
- Changing typography could affect only desktop readability. Mobile rules remain untouched.

## validation
- Run the focused navigation-spacing test.
- Run `pnpm check` from `frontend/` and `git diff --check`.
- Capture a focused desktop and narrow-screen visual check if the local preview can be started.

## decisions
- Scope the denser desktop vertical spacing through the existing middle-panel CSS variables rather than adding new tokens or changing mobile values.
- Increase only the desktop override from 12px to 13px; the base 14px and mobile behavior remain unchanged.

## scan_scope
- `frontend/src/styles.css`, the Agents navigation component, its adjacent spacing test, and the recent CSS history.

## scan_output
- Bounded symbol search and `git blame` identify `222a2cc511` as the source of the desktop overrides.

## handoff
- Ready for merge-request delivery. The desktop account trigger opens its existing menu on hover; the first mouse click after hover leaves it open, while keyboard and touch click behavior remain available. The branch also contains the latest master merge and its mechanically regenerated OpenCraft snapshot. Merge, deployment, and production actions remain out of scope.
