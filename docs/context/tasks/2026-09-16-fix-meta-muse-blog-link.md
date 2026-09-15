---
id: 2026-09-16-fix-meta-muse-blog-link
type: task
scope: Correct a malformed Meta Muse Blog hyperlink and complete missing image-alt localizations.
status: completed
---

## goal
Remove the unintended document hyperlink from the Meta Muse sign-up paragraph and supply the missing localized installation-progress image alt text.

## non_goals
- Do not change the domestic Blog sharing policy. Domestic Blog articles intentionally expose only Copy link.
- Do not optimize Blog image assets, cache Blog post construction, or alter client-boundary behavior in this focused correction.
- Do not publish, deploy, or change GitOps state.

## requirement_ids / requirement_refs / requirement_excerpt
- Frontend code review feedback supplied by the user: remove the malformed `doc.weixin.qq.com/smartpage/...` hyperlink and fix the one untranslated image alt before merge.

## interface_refs / data_structure_refs
- `frontend/src/pages/marketing/blog-content.ts`: `BLOG_POSTS` is the canonical Blog content model.
- `frontend/src/pages/marketing/blog-content-translations.json`: every localized image alt resolves through the source English string key.
- Invariant: prose without an intended destination must remain a string, not a `BlogInline` link object.

## history_context
- `current_design_refs`: `frontend/openspec/specs/blog.md`, `frontend/AGENTS.md`, and `docs/context/project/services/frontend.md`.
- `relevant_evolution`: `2026-09-15-add-meta-muse-blog.md` introduced the article and its localized content.
- `superseded_refs`: none.

## acceptance
- The Meta Muse sign-up paragraph renders as plain text and contains no `doc.weixin.qq.com` destination.
- Every public non-English locale localizes every Blog image alt.
- Focused Blog tests, i18n check, type check, diff check, and global build pass.

## affected_paths
- `frontend/src/pages/marketing/blog-content.ts`
- `frontend/src/pages/marketing/blog-content-translations.json`
- `frontend/src/pages/marketing/__tests__/blog-content.test.ts`
- `frontend/src/pages/marketing/__tests__/blog-article-page.test.tsx`
- `frontend/public/fonts/HYRuiYiSong-45J.subset.woff2`

## required_context
- `AGENTS.md`
- `frontend/AGENTS.md`
- `docs/context/project/services/frontend.md`
- `frontend/openspec/specs/blog.md`
- `r7/product-skills/lv-blog-publishing/SKILL.md`

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md` | Repository boundaries and validation rules | Preserve Git and verification constraints |
| `frontend/AGENTS.md` | Frontend ownership rules | Select focused frontend validation |
| `docs/context/project/services/frontend.md` | Frontend service boundary | Confirm relevant checks |
| `frontend/openspec/specs/blog.md` | Blog contract | Preserve Blog content and sharing constraints |
| `r7/product-skills/lv-blog-publishing/SKILL.md` | Blog publishing workflow | Validate localized content changes |

## evidence
- Bounded audit reproduced one malformed `doc.weixin.qq.com/smartpage/...` link in the Meta Muse sign-up paragraph.
- The same audit found one missing source image-alt key in all six non-English translation tables.
- Focused Blog tests passed: 3 files and 34 tests.
- `pnpm i18n:check`, `pnpm check`, `git diff --check`, and `pnpm build:global` passed.
- The global static export contains `out/blog/tencent-cloud-agent-early-taste-of-meta-muse/index.html`.

## risks
- Broad content rewrites could change approved editorial copy. Mitigation: change only the malformed inline wrapper and its missing localized alt keys.

## validation
- Run focused Blog Vitest tests.
- Run `pnpm i18n:check`, `pnpm check`, `git diff --check`, and `pnpm build:global` from `frontend/`.

## decisions
- Keep domestic Blog sharing copy-only because this is an explicit product requirement, not an incidental behavior.
- Defer asset compression, post caching, and client-bundle safeguards because they are review suggestions outside this P1 correction.

## scan_scope
- `frontend/src/pages/marketing/blog-content.ts`
- `frontend/src/pages/marketing/blog-content-translations.json`
- `frontend/src/pages/marketing/__tests__/blog-content.test.ts`

## scan_output
- No separate scan artifact. The bounded audit output is captured in the task log.

## handoff
- Current state: the source correction, localized alts, generated CJK font subset, and regression coverage are complete.
- Next step: amend and push the existing Blog review branch.
- Blockers: none.
