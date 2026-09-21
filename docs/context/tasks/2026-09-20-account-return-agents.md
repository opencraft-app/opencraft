---
id: task-account-return-agents
type: task
scope: Account and billing direct return navigation
triggers: ["account return agents", "billing navigation", "agents menu copy"]
owner: pablozhong
authority: primary
source_of_truth: ["frontend/src/pages/marketing/account-page.tsx"]
status: active
reviewed_at: 2026-09-20
review_due: 2026-12-20
revision: 1.0.0
precedence: task
derived: false
---

## goal
Make the return to `/agents` visible without opening the avatar menu on account and billing pages.

## non_goals
- No changes to authentication, billing, account callbacks or production deployment; avatar-menu changes are copy-only.

## requirement_ids / requirement_refs / requirement_excerpt
- User feedback on 2026-09-20: return navigation from `/account` and `/account/billing` is too deeply hidden.
- Latest follow-up: place the return entry immediately left of the top-right avatar on both pages; remove the brand-adjacent experiment. Keep language switching hidden.
- Copy follow-up: menu uses `我的智能体` / `My Agents`; return action uses `返回智能体` / `Back to Agents`, with corresponding translations in all supported dictionaries.

## interface_refs / data_structure_refs
- `AccountPage` account/billing view; `AppLink`; `AGENTS_HOME_PATH`.
- The target is the app route `/agents`, not browser history or a locale-prefixed public route.

## history_context
- current_design_refs: `frontend/DESIGN.md`, `docs/engineering/domains/site-environment-routing.md`.
- relevant_evolution: MR !4310 split the pages; current base `7e907e1a3` contains that merge.
- superseded_refs: none.

## acceptance
- Return action height is 36px on desktop, retaining a 44px icon touch target on narrow screens.
- Account and billing headers hide the language switcher without changing the selected locale or other pages' headers.
- Both authenticated views expose a return link immediately left of the header avatar; desktop shows destination text, narrow screens show an accessible 44px arrow control.
- One click returns to `/agents`, including direct-entry navigation.
- Existing account and billing operations remain unchanged; focused tests, check and build pass.

## affected_paths
- `frontend/src/pages/marketing/account-page.tsx`
- `frontend/src/components/site/product-chrome.tsx`, `public-site-header.tsx`, header regression tests and `frontend/DESIGN.md`.
- `frontend/src/components/site/user-avatar-menu.tsx`, its tests, and `frontend/src/i18n/generated/` (two new independent navigation keys).
- Adjacent account and global billing component tests.

## required_context
- frontend-product-surface; frontend service instructions and design conventions.

## context_receipt
| File | Reason | Use |
|---|---|---|
| `docs/context/project/services/frontend.md` | Router must_read | Scope and validation boundaries |
| `docs/context/domains/site-environment-routing.md` | Locale routing must_read | Separate CN/global checks |
| `frontend/AGENTS.md` | Service instructions | Tests, check and build |
| `frontend/DESIGN.md` | Existing design system | Restrained pill navigation |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md` | Adjacent regression coverage | Reuse account component tests |
| `docs/context/tasks/TASK-TEMPLATE.md` | Task contract | Bounded task record |
| `docs/context/tasks/CHECKPOINT-TEMPLATE.md` | Handoff contract | Checkpoint structure |

## evidence
- MR !4321 combined source validation: 128 tests across seven files passed; `pnpm check` has zero new diagnostics; global build passed with 650 pages and 42 SEO route checks. Context-audit unit tests: 33 passed. Repository-wide context validator reports 1826 findings, matching the existing MR worktree; neither newly added task file has a remaining finding. Context contract suite reports four failures against that repository-wide baseline, not a green full-repository gate.
- Compact-height follow-up: browser measured 36px at 1440px viewport and 44px at 320px viewport on both global routes. 61 focused account tests passed.
- Avatar-left final CN build passed (104 static pages); previews restored on CN 5176 and global 5177 with the same local mock configuration. Initial test startup hit local DNS ENOTFOUND; rerun with transient `--api.host 127.0.0.1` passed without changing repository configuration.
- Latest avatar-left placement: 118 tests and `pnpm check` passed. Eight desktop/mobile × CN/global × account/billing browser cases confirmed the action immediately left of the avatar, aligned vertically, no horizontal overflow, hidden language switcher, and working `/agents/` navigation. Screenshots `/tmp/lightvela-avatar-return-*`. This supersedes earlier logo-right positioning evidence.
- Language-button removal follow-up: 61 account tests, `pnpm check` and CN build (104 pages) passed. Restored local mock previews; browser verified both global account routes show return link and avatar without a language switcher.
- Latest master fetched; isolated clean worktree switched to `codex/account-return-agents`.
- Navigation copy uses independent menu/return keys so marketing Companion wording stays unchanged. Title-row and logo-right layout experiments were superseded by the final avatar-left placement.
- Latest copy regression: 86 tests across account and avatar-menu files passed; `pnpm check` passed with zero new diagnostics and complete translation coverage (2942 entries).
- Latest international production build passed: 650 static pages, SEO checks passed for 42 public routes. CN 5176 and global 5177 mock previews restored afterwards.
- Seven locales × two account routes verified in a real browser using isolated local mock sessions: localized menu and return labels visible, no horizontal overflow, return click reaches `/agents/` (14 cases).
- Compact-height final implementation: 61 account tests and `pnpm check` passed; CN build passed with 104 static pages. Run check and build sequentially because both synchronize Fumadocs; stop same-worktree dev servers before building.
- Documentation validation: zero errors/warnings; explicit changed-file impact check passed with no matched rules; `git diff --check` passed.

## risks
- Narrow screens collapse text while retaining an accessible name and 44px touch target.
- Two new navigation strings are extracted via `i18n-extract`, populated through `i18n-apply`, and Traditional Chinese regenerated through `i18n-zh-hant`; original marketing keys remain unchanged.

## validation
- Focused account/global billing tests; `pnpm check`; CN build; desktop/mobile browser navigation.

## decisions
- Place the outlined return link immediately left of the avatar using the shared header's optional `beforeUserMenu` slot; hide while anonymous/loading. Title-row and brand-adjacent experiments are superseded.
- Reuse `AppLink`, Lucide ArrowLeft and the existing avatar-menu destination; distinguish menu noun from return action text.

## scan_scope
- Account page, shared chrome, route constants and adjacent tests.

## scan_output
- `account-page-split.test.tsx` and `account-page-sections.test.tsx` do not exist; split regression lives in `account-page-name-audit.test.tsx`.

## handoff
- User authorized appending this change to MR !4321 (`codex/upgrade-plan-polish`, target `master`), retaining the original upgrade-page changes. Preview uses mock repositories and local preview auth, not production credentials.
- CN preview: `http://127.0.0.1:5176/account/` and `/account/billing/`. Global 5177 restored; both regions covered by local mock browser navigation, not production login validation.
- No merge or production operation authorized. Full frontend test suite not run; delivery will revalidate the combined MR source before push.
