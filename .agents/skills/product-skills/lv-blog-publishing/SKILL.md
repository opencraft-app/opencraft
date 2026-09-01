---
name: lv-blog-publishing
description: Use when creating or editing a LightVela website Blog article, including its content language, category, cover image, article layout, or publishing time.
---

# Publishing a LightVela Blog Article

Use this skill for the international site Blog at `lightvela.ai/blog`.
It standardizes the published article without translating user-supplied content.

## Required inputs

- Identify the article content language and one category: `Announcement`, `Product`, or `Use Cases`.
  If either is absent from the request, ask for both in one concise question before authoring.
- Require a user-supplied, specific cover image.
  If none was uploaded or explicitly selected, ask the user to provide one instead of generating or choosing a substitute.

## Article data and formatting

- Add the post to `frontend/src/pages/marketing/blog-content.ts` with a stable lowercase slug, title, category, cover image, and `publishedAt` set to the actual insertion time as a timezone-aware ISO 8601 value.
  If the chosen category is not yet in `BlogPost`, extend its category union before adding the post.
- Keep the body in the supplied language for every site locale.
  Only surrounding interface labels follow the site language.
- Format prose as `paragraph` blocks, section titles as `heading`, procedures as `ordered-list`, bullets as `unordered-list`, prompts or commands as `code`, and destinations as inline `link` items.
  Do not add a summary heading, decorative shapes, outer card borders, or extra calls to action.
- Put the same cover asset first in `content` and in `coverImage`.
  Store it at `frontend/public/assets/blog/<slug>/cover.<extension>`.

## Layout and media

- Preserve the Blog listing's desktop three-column width and use the same `max-w-5xl` width for the article, its cover, body, and ending.
- Keep every Blog listing card title left-aligned, use `text-pretty` rather than `text-balance`, reserve two lines with `min-h-[2.5rem]`, and apply `line-clamp-2` so a long title ends with an ellipsis on line two instead of creating a third line or uneven right-side whitespace.
- The cover is always a 16:9 `aspect-video object-cover` image with `rounded-md` corners.
  This crops unusually tall or wide sources in CSS to match the first Blog post without altering the original file.
- Keep inline images at their natural aspect ratio.
  Use the existing `size: "narrow"` option for intentionally small vertical screenshots.

## Required article ending

- Render the existing `BlogShareActions` component after the final content block for every post.
  Do not recreate share markup in individual articles.
- It provides the thin divider, Share label, Copy link action, and X, LinkedIn, and Facebook links using the title and canonical `https://lightvela.ai` article URL.

## Verification

- Add or update focused tests for the card, article layout, cover crop, publishing metadata, and share behavior.
- Run the focused Vitest tests, `pnpm i18n:check`, `pnpm check`, and `git diff --check`.
  Run `pnpm build:global` if article routes, metadata, or public assets change.
