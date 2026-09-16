---
id: 2026-09-15-add-hermes-dsh-blog
type: task
scope: Add the latest English LightVela Blog article about pairing Hermes Agent with DeepSeek Harness.
status: completed
---

## goal
Add the user-provided English article `Stop Letting Your Agent Work Alone: After Teaming Up Hermes and DSH, My Efficiency Went Up 10x` to the international LightVela Blog.

## non_goals
- Do not publish, deploy, push, commit, or change production or GitOps state.
- Do not replace the temporary color cover with final profile artwork.
- Do not add a separate page outside the existing Blog route.

## requirement_ids / requirement_refs / requirement_excerpt
- User request in the current task: add the latest English Blog article, use the attached images in order for `[img]` slots, use Cassidy Shi as writer, and use a temporary random-color first cover.
- `.agents/skills/product-skills/lv-blog-publishing/SKILL.md`: use the existing Blog content model, approved author, stable slug, and shared article ending.

## interface_refs / data_structure_refs
- `frontend/src/pages/marketing/blog-content.ts`: `BlogPost`, `BlogBlock`, and `BLOG_POSTS` are the content source.
- `frontend/src/pages/marketing/blog-article-page.tsx`: the first content image is the article cover and later image blocks are inline content.
- Invariant: the cover asset is used in both `coverImage` and the first content image.
- Invariant: the 14 attached images remain in their provided order after the temporary cover.

## history_context
- `current_design_refs`: `frontend/openspec/specs/blog.md`, `frontend/AGENTS.md`, and the existing Blog implementation.
- `relevant_evolution`: Blog posts are stored newest-first in `BLOG_POSTS` and use the approved author list.
- `superseded_refs`: none.

## acceptance
- The new post appears first in `BLOG_POSTS` with `use-case` category and author `Cassidy Shi`.
- The article is reachable at `/blog/hermes-deepseek-harness-10x-efficiency`.
- The temporary cover and 14 ordered inline images render through the existing article page.
- The DeepSeek API link, SkillHub setup command, and code prompts are formatted with existing Blog blocks.

## affected_paths
- `frontend/src/pages/marketing/blog-content.ts`
- `frontend/public/assets/blog/hermes-deepseek-harness-10x-efficiency/`

## required_context
- `AGENTS.md`, `frontend/AGENTS.md`, and `frontend/openspec/specs/blog.md`.
- `.agents/skills/product-skills/lv-blog-publishing/SKILL.md`.

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md` | Repository-wide task and file-edit rules | Preserve repository boundaries |
| `frontend/AGENTS.md` | Frontend implementation rules | Use the existing frontend content source |
| `frontend/openspec/specs/blog.md` | Blog behavior contract | Preserve route and article conventions |
| `.agents/skills/product-skills/lv-blog-publishing/SKILL.md` | Blog publishing workflow | Follow content, asset, and author requirements |

## evidence
- The context router returned no matching Pack for the bounded query `add latest English LightVela Blog article from pasted text with DeepSeek Harness screenshots`, so the relevant Blog files and skill were read directly.
- The pasted document contains article prose and 14 `[img]` placeholders; its embedded `[Image]` lines are treated as attachment markers, not additional instructions.
- The focused Blog listing and content tests passed with 2 test files and 5 tests.
- `git diff --check` passed.
- The new article asset folder contains 15 files, including one temporary cover and 14 ordered screenshots.

## risks
- The temporary cover is intentionally a placeholder and must be replaced later without changing the slug.
- The article includes user-supplied product and setup claims that were not independently edited or verified.

## validation
- Keep validation lightweight as requested.
- Run `git diff --check` and confirm all 15 article assets exist.

## decisions
- Use `use-case` because the article is a hands-on setup and workflow walkthrough.
- Use slug `hermes-deepseek-harness-10x-efficiency`.
- Use a deterministic temporary color SVG as the cover.

## scan_scope
- `frontend/src/pages/marketing/blog-content.ts`
- `frontend/public/assets/blog/hermes-deepseek-harness-10x-efficiency/`

## scan_output
- No separate scan artifact; bounded searches remain in the task execution log.

## handoff
- Current state: article content, assets, listing assertions, and lightweight validation are complete.
- Next step: replace the temporary cover asset with final profile artwork when it is available.
- Blockers: none for the requested Blog content change.
