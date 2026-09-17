---
id: 2026-09-15-localize-blog-content
type: task
scope: Localize LightVela Blog copy for every public international locale and the domestic Chinese Blog surface without external translation services.
status: completed
---

## goal

Complete source-controlled translations for the Blog posts that still render English body copy in non-English public locales.

## non_goals

- Do not alter Blog cover or inline image files.
- Do not call a third-party translation endpoint at build time or runtime.
- Do not publish, deploy, commit, or push changes.

## requirement_ids / requirement_refs / requirement_excerpt

- User request in the current Codex conversation: continue translating the Blogs that are still untranslated.
- User request in the current Codex conversation: preserve the existing images.

## interface_refs / data_structure_refs

- `frontend/src/pages/marketing/blog-content.ts`: Blog content model and locale-aware retrieval helpers.
- `frontend/src/pages/marketing/blog-content-translations.ts`: checked-in translation corpus.
- Invariant: URLs, command samples, image paths, cover images, publication dates, and authors remain unchanged across locales.

## history_context

- `current_design_refs`: `docs/context/domains/site-environment-routing.md`.
- `relevant_evolution`: the initial translation endpoint exhausted its quota and left an import pointing to a missing source file; the translation corpus now remains fully source controlled.
- `superseded_refs`: none.

## acceptance

- Every supported non-English locale renders curated Blog titles, excerpts, headings, prose, list labels, and image alt text without relying on a remote translation provider.
- The domestic Chinese Blog and every public global Blog locale keep the same article images.
- Focused Blog tests and TypeScript checks pass.

## affected_paths

- `frontend/src/pages/marketing/blog-content.ts`
- `frontend/src/pages/marketing/blog-content-translations.ts`
- `frontend/src/pages/marketing/__tests__/blog-content.test.ts`

## required_context

- `site-environment-routing`
- `lv-blog-publishing`

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md` | Repository boundaries | Preserve validation and no-deploy requirements |
| `frontend/AGENTS.md` | Frontend implementation rules | Apply focused validation |
| `docs/context/domains/site-environment-routing.md` | Site and locale contract | Keep domestic and global locale behavior separate |
| `.agents/skills/product-skills/lv-blog-publishing/SKILL.md` | Blog content workflow | Preserve Blog structure, assets, metadata, and formatting |

## evidence

- The initial static translation table covered titles and excerpts only.
- The checked-in corpus now covers Blog prose, headings, links, ordered lists, unordered lists, and image alt text for all seven non-English public locales.

## risks

- Large translation corpora can accidentally omit a fragment and leave English fallback text visible.
- Mitigation: add explicit translation-completeness checks for each public non-English locale.
- Rollback: remove the relevant static locale copy without touching route behavior or image assets.

## validation

- Run the focused Blog content tests.
- Run `pnpm typecheck` from `frontend/`.
- Run `git diff --check`.

## decisions

- Use a checked-in translation corpus rather than a free endpoint because endpoint quotas make builds nondeterministic and can corrupt generated source artifacts.

## scan_scope

- `frontend/src/pages/marketing/`
- `frontend/src/lib/public-site-navigation.ts`

## scan_output

- The Blog has seven source posts and seven non-English locale paths, with `zh-SG` sharing the `zh-CN` translation corpus.

## handoff

- Current state: all supported non-English Blog body strings are shipped from static source-controlled translation data.
- Next step: have a native-language editorial review update any machine-generated phrasing before publication if desired.
- Blockers: none.
