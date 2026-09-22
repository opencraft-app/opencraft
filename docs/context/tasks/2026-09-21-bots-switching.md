## goal

Add the `Bots Switching` documentation page under `Features & Configuration` for the international and domestic sites, with all available international translations, locale-aware screenshots, sidebar registration, and Fumadocs registration.

## non_goals

- Do not change product behavior or channel implementation.
- Do not publish, commit, push, or modify production or GitOps state.

## requirement_ids / requirement_refs / requirement_excerpt

- User request in the current task: add `Bots Switching` to the international English `Features & Configuration` documentation and place the five attached images in order.
- The user-provided content is the content scope and is authoritative for the requested page sections.
- The follow-up request requires the page in every available documentation language, English screenshots for English, Indonesian, Spanish, Japanese, and Korean, and Chinese screenshots for both international and domestic Chinese.

## interface_refs / data_structure_refs

- `frontend/src/config/docs-sidebar.ts`: domestic and international sidebar and slug-to-file registries.
- `frontend/scripts/sync-fumadocs-content.mjs`: domestic and international metadata registries and generated route/content output.
- `frontend/src/content/docs/last-updated.json`: documentation source update-date manifest.
- `frontend/src/pages/marketing/agent-settings-page.tsx`: current multi-Bot creation, switching, cloning, and WeChat ownership UI evidence.

## history_context

- `current_design_refs`: `frontend/src/config/docs-sidebar.ts`, `frontend/scripts/sync-fumadocs-content.mjs`, and the existing international configuration pages.
- `relevant_evolution`: no existing `Bots Switching` page or exact registration was found by bounded search.
- `superseded_refs`: none.

## acceptance

- The page is visible in the international and domestic `Features & Configuration` sidebars with the localized title.
- English, Simplified Chinese, Indonesian, Spanish, Japanese, and Korean source files have matching structure, image order, facts, links, and limitations appropriate to their region.
- The five supplied Chinese screenshots are the shared default assets, and the English screenshots are retained as `-en` variants for English, Indonesian, Spanish, Japanese, and Korean.
- `pnpm docs:sync` produces `en-us`, `zh-sg`, `zh-hant`, `id-id`, `es`, `ja-jp`, `ko-kr`, and `zh-cn` outputs for the new route.
- Documentation link, image, route, date-manifest, and relevant parity checks pass.

## affected_paths

- `docs/context/tasks/2026-09-21-bots-switching.md`
- `frontend/src/content/docs/en/configuration/bots-switching.md`
- `frontend/src/content/docs/global/configuration/bots-switching.md`
- `frontend/src/content/docs/id/configuration/bots-switching.md`
- `frontend/src/content/docs/configuration/bots-switching.md`
- `frontend/src/content/docs/es/configuration/bots-switching.md`
- `frontend/src/content/docs/ja/configuration/bots-switching.md`
- `frontend/src/content/docs/ko/configuration/bots-switching.md`
- `frontend/src/content/docs/images/bots-switching-*.webp`
- `frontend/src/content/docs/last-updated.json`
- `frontend/src/config/docs-sidebar.ts`
- `frontend/scripts/sync-fumadocs-content.mjs`
- Generated documentation output under `frontend/.fumadocs-content/` and `frontend/next-site/docs-route-manifest.ts`
- `wiki/growth-state/lightvela-docs-content-categories.md`
- `frontend/scripts/international-docs-parity.test.ts`

## required_context

- Pack ID: `2026-09-21-bots-switching`
- Authority: current documentation source and registration code, plus current Bot settings implementation for product facts.

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `.agents/skills/product-skills/lv-docs/SKILL.md` | Required for domestic and international documentation work | Defined global source pairing, regional adaptation, registration, image, sync, and validation rules |
| `.agents/skills/product-skills/lv-docs/references/docs-rules.md` | Required docs routing and generation details | Defined sidebar, slug, source, image, and generated-output expectations |
| `docs/context/domains/site-environment-routing.md` | Required route context for a dual-site change | Confirmed that the domestic and international sites are independent delivery surfaces |
| `/Users/cassidyshi/.codex/plugins/cache/openai-bundled/browser/26.825.51511/skills/control-in-app-browser/SKILL.md` | Required visual-check workflow for screenshot replacement | Defined the live-page visual verification workflow |
| `docs/context/tasks/TASK-TEMPLATE.md` | Required Task Pack structure | Defined this pack's state contract |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md` | Required adjacency check after bounded routing search | Confirmed frontend/i18n generation and test neighbors to inspect when relevant |
| `frontend/src/config/docs-sidebar.ts` | Target domestic and international navigation and route mapping | Confirmed the Bot feature and supported domestic channels, then identified both sidebar and mapping insertion points |
| `frontend/scripts/sync-fumadocs-content.mjs` | Target domestic and international metadata and route generation | Confirmed the Bot feature and both regional registries, then identified the global and domestic registration points |
| `frontend/src/pages/marketing/agent-settings-page.tsx` | Product behavior evidence | Confirmed Bot creation, clone choices, profile switching, plan limits, and WeChat ownership behavior |
| `wiki/growth-state/lightvela-docs-content-categories.md` | Content status ledger | Confirmed the target top-level category and the need to add the new item |

## evidence

- `python3 .agents/context/scripts/validate_context.py --route "Add an international English documentation page named Bots Switching under Features & Configuration with five supplied images"` returned no matching Pack and instructed a bounded exact search.
- Bounded exact search found no existing `Bots Switching` page or registration.
- The worktree was clean before this task.
- `pnpm docs:sync` synchronized 542 docs and generated the `Bots Switching` page in every requested locale.
- Source and generated-page checks confirmed five images in the requested order, with default Chinese assets for `zh-cn`, `zh-sg`, and `zh-hant`, and `-en` assets for `en-us`, `id-id`, `es`, `ja-jp`, and `ko-kr`.
- Browser navigation to the live documentation pages timed out twice before a page could be loaded, so the required live visual check could not complete in this environment.

## risks

- Supplied screenshots have both English and Chinese UI variants. Mitigation: use the Chinese assets as the default and retain the English assets as `-en` variants so the sync script selects them by locale.
- The international docs parity suite expects completed English pages to have Spanish, Japanese, and Korean source counterparts. Mitigation: retain localized copies with matching structure, links, and image order, and add Indonesian as explicitly requested.
- The user supplied a WhatsApp single-Bot limitation, while the current frontend source explicitly exposes the corresponding ownership notice for WeChat. Mitigation: retain the requested statement but avoid adding implementation-specific claims beyond the supplied requirement.
- Generated route files can drift if sync is skipped. Mitigation: run `pnpm docs:sync` and inspect generated `en-us`, `zh-sg`, and `zh-hant` outputs.

## validation

- Run `cd frontend && pnpm docs:sync`.
- Run targeted docs metadata/date/link/image/parity checks available in the frontend scripts.
- Run the repository documentation validation relevant to the changed docs and report any pre-existing failures separately.
- Completed: `pnpm docs:sync`, `pnpm exec vitest run --config vitest.config.ts scripts/international-docs-parity.test.ts scripts/docs-last-updated.test.ts`, `pnpm check`, source/generated image checks, and `git diff --check`.
- Known unrelated failure: `scripts/docs-image-assets.test.ts` reports 139 existing oversized PNG/JPEG references outside this page.

## decisions

- Use slug `configuration/bots-switching` and source filename `configuration/bots-switching.md` in each regional source root.
- Place the sidebar item beside `Model Switching`, before `DeepSeek Harness`, so related switching controls remain adjacent.
- Create `en/` first as requested, then create the required `global/` Simplified Chinese source with the same structure and image order.
- Add the domestic Chinese source and Indonesian translation after the follow-up request, and preserve the existing Spanish, Japanese, and Korean translations.

## scan_scope

- `frontend/src/content/docs/en/`
- `frontend/src/content/docs/global/`
- `frontend/src/config/docs-sidebar.ts`
- `frontend/scripts/sync-fumadocs-content.mjs`
- `frontend/next-site/docs-route-manifest.ts`
- `frontend/src/pages/marketing/agent-settings-page.tsx`
- `wiki/growth-state/lightvela-docs-content-categories.md`

## scan_output

- Bounded exact-search results were emitted in the task conversation; no separate scan artifact was needed.

## handoff

- Current status: implementation and validation are complete.
- Next step: hand off without publishing.
- Blocking items: none.
- Required permissions: repository write access only; no external or production permissions required.
