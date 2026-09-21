---
id: 2026-09-15-add-meta-muse-blog
type: task
scope: Add the latest English LightVela Blog article and supplied screenshots.
status: completed
---

## goal
Add the user-provided English article `Tencent's Cloud Agent Gave an Early Taste of Meta's Muse` to the international LightVela Blog.

## non_goals
- Do not publish, deploy, push, commit, or change production or GitOps state.
- Do not replace the temporary cover image with a final profile image.
- Do not rewrite the supplied article into a different topic.

## requirement_ids / requirement_refs / requirement_excerpt
- User request in the current task: add the latest English Blog article, use attached images in order for `[img]` slots, use Cassidy Shi as writer, and use a temporary random-color image for the first profile or cover image.
- `frontend/openspec/specs/blog.md`: Blog articles are English, use the existing content model, and expose a stable international Blog route.

## interface_refs / data_structure_refs
- `frontend/src/pages/marketing/blog-content.ts`: `BlogPost`, `BlogBlock`, and `BLOG_POSTS` are the content source.
- `frontend/src/pages/marketing/blog-article-page.tsx`: the first content image is treated as the article cover and the remaining blocks are rendered as body content.
- Invariant: `coverImage` and the first content image must refer to the same temporary cover asset.
- Invariant: the 18 supplied inline screenshots must remain in the user-provided order.

## history_context
- `current_design_refs`: `frontend/openspec/specs/blog.md`, `frontend/AGENTS.md`, and the existing Blog page implementation.
- `relevant_evolution`: existing Blog posts are stored newest-first in `BLOG_POSTS` and use the approved author list.
- `superseded_refs`: none.

## acceptance
- The new post appears first in `BLOG_POSTS` with the exact title, `Use Cases` category, and author `Cassidy Shi`.
- The article is reachable at `/blog/tencent-cloud-agent-early-taste-of-meta-muse` in the international build.
- The temporary cover appears on the listing and article cover, and the 18 inline images render in supplied order.
- The linked signup paragraph and final LightVela links remain functional.
- Focused Blog tests, i18n checks, type checks, diff checks, and the international production build pass.

## affected_paths
- `frontend/src/pages/marketing/blog-content.ts`
- `frontend/src/pages/marketing/__tests__/blog-content.test.ts`
- `frontend/src/pages/marketing/__tests__/blog-page.test.tsx`
- `frontend/src/pages/marketing/__tests__/blog-article-page.test.tsx`
- `frontend/public/assets/blog/tencent-cloud-agent-early-taste-of-meta-muse/`

## required_context
- `AGENTS.md` and `frontend/AGENTS.md` for repository and frontend boundaries.
- `frontend/openspec/specs/blog.md` for the Blog contract.
- `docs/context/project/services/frontend.md` for frontend validation boundaries.

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md` | Repository-wide task and validation rules | Preserve task, Git, and file-edit boundaries |
| `frontend/AGENTS.md` | Frontend implementation and command rules | Select focused frontend checks |
| `frontend/openspec/specs/blog.md` | Blog route and content behavior | Preserve article and international route invariants |
| `docs/context/project/services/frontend.md` | Frontend service validation boundary | Select lint, type, test, and build gates |
| `r7/product-skills/lv-blog-publishing/SKILL.md` | Blog publishing workflow | Follow content, asset, and verification requirements |

## evidence
- Context routing returned no matching Pack for the bounded query `add latest English LightVela Blog article about Tencent Cloud Agent and Meta Muse`, so the relevant frontend files and Blog specification were read directly.
- The working tree contains an unrelated untracked prior task pack that must be preserved.
- The focused Blog suite passed with 4 test files and 11 tests.
- `pnpm i18n:check` passed.
- `pnpm check` passed with 0 new TypeScript diagnostics.
- `git diff --check` passed.
- `pnpm build:global` passed and generated the new default and localized Blog article routes.
- The frontend package has no `lint` script and no `eslint` executable, so a targeted ESLint command could not run.

## risks
- The temporary cover is intentionally not the final profile artwork and must be replaced later without changing the slug.
- Long screenshot assets increase the static asset footprint, so paths and image dimensions must be checked before handoff.
- User-supplied market claims are treated as article content and are not independently editorially verified in this implementation task.

## validation
- Run focused Blog Vitest tests.
- Run `pnpm i18n:check`, `pnpm check`, `git diff --check`, and `pnpm build:global` from `frontend/`.
- Confirm all 19 referenced image assets exist.

## decisions
- Use `use-case` because the article is a hands-on product walkthrough.
- Use slug `tencent-cloud-agent-early-taste-of-meta-muse`.
- Use a deterministic temporary color PNG as the cover because the user requested a placeholder and no final profile image was supplied.

## scan_scope
- `frontend/src/pages/marketing/`
- `frontend/openspec/specs/blog.md`
- `frontend/public/assets/blog/tencent-cloud-agent-early-taste-of-meta-muse/`

## scan_output
- No separate scan artifact; bounded searches and test output remain in the task execution log.

## handoff
- Current state: the article, temporary cover, ordered screenshots, focused tests, and validation are complete.
- Next step: replace the temporary cover asset with the final profile image when it is available.
- Blockers: none for the requested Blog content change.
