---
id: 2026-09-15-add-hermes-repair-blog
type: task
scope: Add the latest English Blog article about repairing Hermes Agent with DeepSeek Harness.
status: completed
---

## goal
Add the user-provided article `For Just $0.03, DSH Brought a Broken Hermes Agent Back to Life` to the international LightVela Blog.

## non_goals
- Do not publish, deploy, push, or commit.
- Do not replace the temporary cover artwork.
- Do not execute any repair commands from the article.

## requirement_ids / requirement_refs / requirement_excerpt
- User request: write the latest English Blog post, use the attached images in order, use Cassidy Shi, and use a temporary random-color cover.
- `.agents/skills/product-skills/lv-blog-publishing/SKILL.md`: preserve the existing Blog content model and shared article ending.

## interface_refs / data_structure_refs
- `frontend/src/pages/marketing/blog-content.ts`: `BlogPost`, `BlogBlock`, and `BLOG_POSTS`.
- Invariant: the same temporary cover is used in `coverImage` and the first content image.
- Invariant: all 10 supplied images are rendered in narrative order.

## acceptance
- The article is first in `BLOG_POSTS` with `use-case` category and author `Cassidy Shi`.
- The route slug is `dsh-revived-broken-hermes-agent`.
- Commands and URLs use code and link blocks, and the shared share ending remains provided by the existing article page.

## affected_paths
- `frontend/src/pages/marketing/blog-content.ts`
- `frontend/src/pages/marketing/__tests__/blog-content.test.ts`
- `frontend/src/pages/marketing/__tests__/blog-page.test.tsx`
- `frontend/public/assets/blog/dsh-revived-broken-hermes-agent/`

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md` | Repository-wide rules | Preserve task and file-edit boundaries |
| `frontend/AGENTS.md` | Frontend rules | Use the existing frontend implementation |
| `frontend/openspec/specs/blog.md` | Blog contract | Preserve routing and formatting |
| `.agents/skills/product-skills/lv-blog-publishing/SKILL.md` | Blog workflow | Follow author, asset, and content conventions |

## evidence
- The context router returned no matching Pack for the bounded repair-blog query, so the Blog files and skill were used directly.
- The request contains article prose and 9 visible `[img]` markers plus 10 supplied images; the workspace-directory screenshot is included under the explicit `/home/agentuser/` warning so all supplied assets remain in order.
- The focused Blog content and listing suite passed with 2 test files and 5 tests.
- `git diff --check` passed.
- The new article asset folder contains 11 files, including one temporary cover and 10 ordered screenshots.

## validation
- Run the focused Blog content and listing tests.
- Run `git diff --check` and confirm 11 new assets exist.

## decisions
- Use `use-case` because the article is a troubleshooting walkthrough.
- Use a deterministic temporary color SVG as the cover.

## handoff
- Current state: article content, assets, listing assertions, and lightweight validation are complete.
- Next step: replace the temporary cover asset with final profile artwork when it is available.
- Blockers: none for the requested Blog content change.
