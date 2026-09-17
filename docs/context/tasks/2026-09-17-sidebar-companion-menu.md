## goal
Remove “我的智能体伙伴” from the Agent sidebar footer's account menu on both domestic and international sites, while keeping the account page's top-right menu unchanged.

## non_goals
- Do not remove the `/agents` route, rename translations, or change the account page header menu.
- Do not merge or release; the user subsequently authorized MR delivery after local review.

## requirement_ids / requirement_refs / requirement_excerpt
- User request and screenshot in this conversation (2026-09-17): remove only the sidebar footer menu entry; retain the account page top-right entry; apply to both sites. No external issue ID supplied.

## interface_refs / data_structure_refs
- `UserAvatarMenu` accepts `variant: "header" | "sidebar"`; the Agent desktop sidebar passes `sidebar`, while `ProductPageShell` uses the default header variant on `/account`.
- Both sites use this component; `isGlobal` controls other regional menu behavior and does not need a new branch for this requirement.

## history_context
- `current_design_refs`: `frontend/openspec/specs/auth.md`, `frontend/openspec/changes/2026-09-14-global-agents-account-language-switcher-design.md`.
- `relevant_evolution`: The sidebar variant and header variant share one component on current `origin/master` (`3165aca5a`).
- `superseded_refs`: none.

## acceptance
- The open sidebar footer menu has no “我的智能体伙伴” link in either site mode, while “账号管理” remains.
- The open header menu still links “我的智能体伙伴” to `/agents` in either site mode.
- Focused component tests, frontend check, and domestic/international builds pass.

## affected_paths
- `frontend/src/components/site/user-avatar-menu.tsx`
- `frontend/src/components/site/__tests__/user-avatar-menu.test.tsx`
- This Task Pack and checkpoint.

## required_context
- `site-environment-routing`, `frontend-product-surface`.

## context_receipt
| File | Why read | Decision informed |
|---|---|---|
| `AGENTS.md@3165aca5a` | Repository rules | Isolate dirty checkout; validate before handoff |
| `frontend/AGENTS.md@3165aca5a` | Frontend rules | Run focused test, check and builds |
| `frontend/DESIGN.md@3165aca5a` | UI conventions | Preserve existing menu interaction and styling |
| `docs/context/domains/site-environment-routing.md@3165aca5a` | Routed domain | Verify both delivery surfaces |
| `docs/context/project/services/frontend.md@3165aca5a` | Routed service | Shared frontend ownership |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@3165aca5a` | Adjacency card | Inspect adjacent test and avoid unnecessary i18n edits |
| `frontend/openspec/specs/auth.md@3165aca5a` | Avatar menu contract | Keep account and authentication actions |
| `frontend/openspec/changes/2026-09-14-global-agents-account-language-switcher-design.md@3165aca5a` | Regional menu design | Preserve international language menu behavior |

## evidence
- `agent-settings-page.tsx` renders `UserAvatarMenu variant="sidebar"` in its desktop footer.
- `account-page.tsx` uses `ProductPageShell`, whose default header renders `UserAvatarMenu` without the sidebar variant.
- New domestic and international sidebar assertions each failed before the change because the companion link was present.
- After the variant guard, focused Vitest passed 3 files / 36 tests; `pnpm check` passed with 0 new TypeScript diagnostics; `pnpm build:cn` generated 103 static pages and `pnpm build:global` generated 649.
- Documentation validation reported no errors, warnings, broken first-party links, or unclassified documents.
- The first localhost-proxy preview reached only the login gate. The final Chrome/Whistle preview used `pnpm dev:global` on 5174 with domain routing and was approved by the user.

## risks
- Removing the shared link unconditionally would also remove the account page header entry; restrict the condition to `isSidebar`.
- Preserve menu state, navigation destination, and international language controls unchanged.

## validation
- Passed: focused Vitest on avatar menu and nearby header/sidebar tests (36/36), `pnpm check` (0 new TypeScript diagnostics), `pnpm build:cn`, `pnpm build:global`, and documentation validation.
- Build-generated changes to `frontend/next-env.d.ts` and `frontend/public/fonts/HYRuiYiSong-45J.subset.woff2` were excluded from the handoff diff.

## decisions
- Use the existing `variant` prop, not a new site-specific flag or translation key.

## scan_scope
- `frontend/src/components/site/user-avatar-menu.tsx`, its focused test, `agent-settings-page.tsx`, `account-page.tsx`, `product-chrome.tsx`, and `public-site-header.tsx`.

## scan_output
- Bounded terminal search identified the two component call paths; no scan artifact saved.

## handoff
- The user subsequently authorized MR delivery. The new MR includes this change and the empty-persona page change; Soul terminology stays in MR !4154.
