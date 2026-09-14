## goal

Publish the three scheduled-task Use Cases pages under the titles `Automating Agent Task with LightVela`, `Setting Notification Task in LightVela`, and `Running Script Task in LightVela`, localize those titles for every configured international source locale, and use translated Chinese titles for the domestic pages and both sidebars.

## non_goals

- Do not browse external sources, commit, push, create an MR, or publish.
- No domestic pages beyond the three requested scheduled-task pages are in scope.
- Do not run `pnpm check` or a full build unless requested.

## requirement_ids / requirement_refs / requirement_excerpt

- User request, 2026-09-14: add a new international Use Cases page below the current Discord event bot page using the supplied Scheduled Task: Agent document exactly.

## interface_refs / data_structure_refs

- `frontend/src/config/docs-sidebar.ts`: global sidebar and slug-to-file registration.
- `frontend/scripts/sync-fumadocs-content.mjs`: global documentation registration and rendered route generation.
- `frontend/src/content/docs/last-updated.json`: source document update dates.

## history_context

- `current_design_refs`: `.agents/skills/product-skills/lv-docs/SKILL.md`, `frontend/src/config/docs-sidebar.ts`, and `frontend/scripts/sync-fumadocs-content.mjs`.
- `relevant_evolution`: the international Use Cases group currently ends with `discord-event-agent`.
- `superseded_refs`: none.

## acceptance

- The supplied English Agent page exists at `frontend/src/content/docs/en/use-cases/scheduled-task-agent.md` with the four requested screenshots.
- The Agent page contains the four supplied screenshots in the requested order and locations.
- The paired Simplified Chinese source exists at `frontend/src/content/docs/global/use-cases/scheduled-task-agent.md`.
- The paired Agent source contains the same four screenshots with localized alt text.
- The supplied Notifications page exists at `frontend/src/content/docs/en/use-cases/scheduled-task-notifications.md` with the four requested screenshots.
- The paired Simplified Chinese Notifications source exists at `frontend/src/content/docs/global/use-cases/scheduled-task-notifications.md`.
- The Notifications page contains the four supplied screenshots in the requested order and locations.
- The paired Notifications source contains the same four screenshots with localized alt text.
- The supplied Script page exists at `frontend/src/content/docs/en/use-cases/scheduled-task-script.md` with the four requested screenshots.
- The paired Simplified Chinese Script source exists at `frontend/src/content/docs/global/use-cases/scheduled-task-script.md`.
- The paired Script source contains the same four screenshots with localized alt text.
- Indonesian, Spanish, Japanese, and Korean source files exist for all three pages, with matching heading structure and image order.
- Indonesian metadata exists for all three page slugs.
- The domestic Chinese Agent source exists with domestic channel wording and the four supplied Chinese screenshots.
- The domestic sidebar, slug map, `cnDocs`, and content category ledger register the Agent page.
- The domestic Chinese Notifications source exists with domestic channel wording and the four supplied Chinese screenshots.
- The domestic sidebar, slug map, `cnDocs`, and content category ledger register the Notifications page.
- The domestic Chinese Script source exists with domestic channel wording and the four supplied Chinese screenshots.
- The domestic sidebar, slug map, `cnDocs`, and content category ledger register the Script page.
- The page is registered after `discord-event-agent` and renders in the international English and Chinese routes.
- `pnpm docs:sync` succeeds; `pnpm check` is not run per request.

## affected_paths

- `frontend/src/content/docs/en/use-cases/scheduled-task-agent.md`
- `frontend/src/content/docs/global/use-cases/scheduled-task-agent.md`
- `frontend/src/content/docs/use-cases/scheduled-task-agent.md`
- `frontend/src/content/docs/use-cases/scheduled-task-notifications.md`
- `frontend/src/content/docs/use-cases/scheduled-task-script.md`
- `frontend/src/content/docs/en/use-cases/scheduled-task-notifications.md`
- `frontend/src/content/docs/global/use-cases/scheduled-task-notifications.md`
- `frontend/src/content/docs/en/use-cases/scheduled-task-script.md`
- `frontend/src/content/docs/global/use-cases/scheduled-task-script.md`
- `frontend/src/content/docs/{id,es,ja,ko}/use-cases/scheduled-task-agent.md`
- `frontend/src/content/docs/{id,es,ja,ko}/use-cases/scheduled-task-notifications.md`
- `frontend/src/content/docs/{id,es,ja,ko}/use-cases/scheduled-task-script.md`
- `frontend/src/content/docs/images/scheduled-task-agent-1.png`
- `frontend/src/content/docs/images/scheduled-task-agent-2.png`
- `frontend/src/content/docs/images/scheduled-task-agent-3.png`
- `frontend/src/content/docs/images/scheduled-task-agent-4.png`
- `frontend/src/content/docs/images/scheduled-task-notifications-1.png`
- `frontend/src/content/docs/images/scheduled-task-notifications-2.png`
- `frontend/src/content/docs/images/scheduled-task-notifications-3.png`
- `frontend/src/content/docs/images/scheduled-task-notifications-4.png`
- `frontend/src/content/docs/images/scheduled-task-script-1.png`
- `frontend/src/content/docs/images/scheduled-task-script-2.png`
- `frontend/src/content/docs/images/scheduled-task-script-3.png`
- `frontend/src/content/docs/images/scheduled-task-script-4.png`
- `frontend/src/content/docs/images/scheduled-task-agent-zh-1.png`
- `frontend/src/content/docs/images/scheduled-task-agent-zh-2.png`
- `frontend/src/content/docs/images/scheduled-task-agent-zh-3.png`
- `frontend/src/content/docs/images/scheduled-task-agent-zh-4.png`
- `frontend/src/content/docs/images/scheduled-task-notifications-zh-1.png`
- `frontend/src/content/docs/images/scheduled-task-notifications-zh-2.png`
- `frontend/src/content/docs/images/scheduled-task-notifications-zh-3.png`
- `frontend/src/content/docs/images/scheduled-task-notifications-zh-4.png`
- `frontend/src/content/docs/images/scheduled-task-script-zh-1.png`
- `frontend/src/content/docs/images/scheduled-task-script-zh-2.png`
- `frontend/src/content/docs/images/scheduled-task-script-zh-3.png`
- `frontend/src/content/docs/images/scheduled-task-script-zh-4.png`
- `frontend/src/config/docs-sidebar.ts`
- `frontend/scripts/sync-fumadocs-content.mjs`
- `frontend/scripts/international-docs-parity.test.ts`
- `frontend/src/content/docs/last-updated.json`
- `frontend/next-site/docs-route-manifest.ts`
- `frontend/mdx-components.tsx`
- `frontend/mdx-components.test.tsx`
- `frontend/src/components/docs/markdown-renderer.tsx`
- `wiki/growth-state/lightvela-docs-content-categories.md`
- `docs/context/tasks/2026-09-14-global-scheduled-agent-use-case.md`

## required_context

- `service-frontend`
- `site-environment-routing`
- `frontend-product-surface`
- `.agents/skills/product-skills/lv-docs/SKILL.md`
- `.agents/skills/product-skills/lv-seo-geo/SKILL.md`
- `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md`

## context_receipt

| File | Reason | Use |
|---|---|---|
| `frontend/AGENTS.md` | Frontend service rules | Confirmed source and validation boundaries. |
| `docs/context/project/services/frontend.md` | Frontend service context | Confirmed markdown sources are authoritative over generated content. |
| `docs/context/domains/site-environment-routing.md` | International site routing | Confirmed international and domestic docs are separate delivery surfaces. |
| `.agents/skills/product-skills/lv-docs/SKILL.md` | Docs workflow | Confirmed paired international sources, registration, and sync requirements. |
| `.agents/skills/product-skills/lv-seo-geo/SKILL.md` | International docs SEO/GEO | Confirmed real route and attribution rules for the supplied automation link. |
| `.agents/skills/product-skills/lv-docs/references/docs-rules.md` | Locale and domestic-site rules | Confirmed that scheduled tasks are not currently registered on the domestic site. |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md` | Frontend generation neighbor | Confirmed the docs sync script is the relevant generated-output entry point. |

## evidence

- `git status --short` showed a clean `master` worktree before this task.
- `pnpm docs:sync` completed successfully and synchronized 519 docs.
- Generated pages exist for `en-us`, `zh-sg`, and `zh-hant` at the Agent, Notifications, and Script slugs.
- Generated domestic `zh-cn` Agent page and international `zh-sg`/`zh-hant` Agent pages resolve the four `scheduled-task-agent-zh-*.png` assets.
- Generated `en-us` Agent page still resolves the original `scheduled-task-agent-*.png` assets.
- Generated domestic `zh-cn` Notifications page and international `zh-sg`/`zh-hant` Notifications pages resolve the four `scheduled-task-notifications-zh-*.png` assets.
- Generated `en-us` Notifications page still resolves the original `scheduled-task-notifications-*.png` assets.
- Generated domestic `zh-cn` Script page and international `zh-sg`/`zh-hant` Script pages resolve the four `scheduled-task-script-zh-*.png` assets.
- Generated `en-us` Script page still resolves the original `scheduled-task-script-*.png` assets.
- `pnpm docs:sync` completed successfully and synchronized 532 docs after the domestic Agent registration.
- `pnpm docs:sync` completed successfully and synchronized 533 docs after the domestic Notifications registration.
- `pnpm docs:sync` completed successfully and synchronized 534 docs after the domestic Script registration.
- The three requested page titles are localized in the `en-us`, `zh-cn`, `zh-sg`, `zh-hant`, `id-id`, `es`, `ja-jp`, and `ko-kr` rendered outputs.
- Generated Agent pages contain all four image references and resolve them to `/docs-images/scheduled-task-agent-1.png` through `/docs-images/scheduled-task-agent-4.png`.
- Generated Notifications pages contain all four image references and resolve them to `/docs-images/scheduled-task-notifications-1.png` through `/docs-images/scheduled-task-notifications-4.png`.
- Generated Script pages contain all four image references and resolve them to `/docs-images/scheduled-task-script-1.png` through `/docs-images/scheduled-task-script-4.png`.
- Source-only locale validation confirms matching H2 counts and image order `1,2,3,4` in every Indonesian, Spanish, Japanese, and Korean page.
- `node scripts/docs-last-updated.mjs --sync` added 12 locale source entries, for 461 entries total.
- Route inventory counts now include the three scheduled-task pages: 71 international routes, 47 domestic routes, 69 Indonesian routes, and 70 generated documents for fully localized locales.
- `pnpm exec vitest run --config vitest.config.ts scripts/international-docs-parity.test.ts` passes all 44 tests.
- `pnpm typecheck` passes with 0 new TypeScript diagnostics.

## risks

- The supplied copy contains its original wording and grammar; it was not editorially corrected because the user requested exact content.
- Domestic Agent, Notifications, and Script pages are registered and remain unstaged.

## validation

- Run `git diff --check`.
- Run `pnpm docs:sync` after markdown and registration changes.
- Run `pnpm exec vitest run --config vitest.config.ts scripts/international-docs-parity.test.ts` after changing published route inventory.
- Do not run `pnpm check` unless requested.

## decisions

- Use `scheduled-task-agent` as the slug and place it directly after `discord-event-agent`.
- Keep the English source exact and provide the paired Simplified Chinese source required by the international docs workflow.
- Make the sync generator tolerate missing optional-locale source files so this scoped international page does not require unrelated translations.
- Match callout keywords as whole words so prompt text containing `notes` stays a normal prompt block.
- Apply the same whole-word rule to the Fumadocs MDX renderer, which serves this page.
- Add explicit source files for Indonesian, Spanish, Japanese, and Korean so each locale can render the same content and screenshots after the next docs sync.
- Adapt domestic channel wording to 微信、飞书和 QQ instead of copying international-only channel claims.
- Keep the scheduled-task slugs unchanged while updating page and sidebar titles for every supported locale.

## scan_scope

- `frontend/src/content/docs/{en,global}/use-cases/scheduled-task-agent.md`
- `frontend/src/content/docs/{en,global}/use-cases/scheduled-task-notifications.md`
- `frontend/src/content/docs/{en,global}/use-cases/scheduled-task-script.md`
- `frontend/src/content/docs/{id,es,ja,ko}/use-cases/scheduled-task-{agent,notifications,script}.md`
- `frontend/src/config/docs-sidebar.ts`
- `frontend/scripts/sync-fumadocs-content.mjs`
- `frontend/next-site/docs-route-manifest.ts`

## scan_output

- All localized sources contain the same four images in the requested order.
- The new slugs appear after `use-cases/discord-event-agent` in the global sidebar, route map, and generated route manifest.
- The second prompt no longer matches the info callout detector through the substring in `notes`.
- `pnpm exec vitest run mdx-components.test.tsx` passes, including the `notes` regression case.

## handoff

- International source translations and the requested domestic Agent, Notifications, and Script pages are complete and remain unstaged.
- No commit, push, MR, or publish was performed.
