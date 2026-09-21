# Account Subscription Locale

## goal
Preserve the selected international-site language when account settings opens subscription creation or upgrade.

## non_goals
- No billing, authentication, regional backend, deployment, or shared navigation changes.

## requirement_refs / requirement_excerpt
- User report on 2026-09-10: simplified Chinese changes to English after opening subscription plans from account settings.

## interface_refs / data_structure_refs
- `frontend/src/lib/public-site-navigation.ts`: publicSiteHref.
- `frontend/src/lib/public-site-routing.ts`: resolveVisiblePublicSiteLocale.
- Preserve upgrade_pass_id and its URL encoding; CN links remain unchanged.

## history_context
- current_design_refs: `docs/engineering/domains/site-environment-routing.md`.
- relevant_evolution: account links were hard-coded to /subscribe; global unprefixed public pages use English.
- superseded_refs: none.

## acceptance
- Account creation links retain simplified/traditional Chinese, English, Spanish and Indonesian.
- Upgrade links retain language and encoded pass ID.
- Existing account tests and frontend check pass.

## affected_paths
- `frontend/src/pages/marketing/account-page.tsx`
- `frontend/src/pages/marketing/__tests__/account-page-renewal.global.test.tsx`

## required_context / context_receipt
| File | Reason | Decision |
| --- | --- | --- |
| docs/context/domains/site-environment-routing.md | Regional boundary | Preserve CN behavior |
| docs/context/project/services/frontend.md | Frontend scope | Use focused checks |
| frontend/AGENTS.md | Service rules | Existing types and tests |
| docs/context/project/adjacency/frontend-runtime-openspec-i18n.md | Locale neighbor | Inspect routing tests |
| docs/engineering/domains/site-environment-routing.md | Current design | Reuse existing locale helper |

## decisions
- Localize only international account subscription links using the active i18n language.
- Do not alter global AppLink behavior or copy translations.

## scan_scope / scan_output
- Account page, app navigation adapters, public routing helpers and neighboring tests.
- Found two unlocalized subscription links; navigation adapters intentionally forward URLs unchanged.

## evidence / validation
- Regression-first: six failures reproduced missing locale prefixes.
- After fix: five suites, 67 tests passed, including existing account and regional routing tests.
- pnpm check passed: 174 existing TypeScript diagnostics, zero new; removed one unused Shield import in the touched file.
- Global build passed: 606 pages; SEO checks passed for 42 public static routes.
- Documentation validation passed with zero broken first-party links; git diff --check passed.

## risks
- No authenticated production checkout performed. Regression tests verify rendered links without creating orders.

## handoff
- User authorized committing and pushing this fix to existing MR !3848; no merge or deployment authorized.
- Existing Beijing local preview configuration is unchanged.
- Checkpoint: implementation and local verification complete; authenticated browser checkout and production deployment not performed.
