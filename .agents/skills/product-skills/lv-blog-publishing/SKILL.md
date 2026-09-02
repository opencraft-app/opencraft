---
name: lv-blog-publishing
description: Use when writing, creating, adding, editing, updating, or publishing a LightVela Blog article or Blog page entry, including content language, category, cover image, layout, metadata, or publishing time.
---

# LightVela Blog Publishing

Use this skill for the international Blog at `https://lightvela.ai/blog`.
Load it when the user asks to write a blog, add a new blog post, create an article card, edit an existing article, update Blog page presentation, or publish Blog content.

## Scope and routing

- Apply this skill to Blog listing cards, article detail pages, article content, cover images, Blog metadata, and the Blog entry in the website footer.
- Use `lv-longform-content` when the user only wants a draft or marketing article and does not ask to put it on the Blog page.
- Use `lightvela-changelog-update` for product updates that belong in the changelog rather than the Blog.
- Use `lv-docs` for documentation pages, even when the requested content is tutorial-like.
- Use `lv-seo-geo` in addition to this skill when the request includes search visibility, structured metadata, canonical URLs, sitemap, or GEO requirements.

## Required inputs

- Confirm the article language before authoring.
  If the user did not specify it, ask for the language in one concise question.
- Confirm exactly one category: `Announcement`, `Product`, or `Use Cases`.
  If the user did not specify it, ask for the category in the same question.
- Require a specific user-provided cover image for every new post.
  If the user did not upload or explicitly select one, ask for the cover image before implementing the post.
- Keep article content in its requested language across all site locales unless the user explicitly asks for translation.
  Translate surrounding navigation, category labels, dates, share controls, and other interface copy through i18n.

## Standard article implementation

- Add or update the post in `frontend/src/pages/marketing/blog-content.ts`.
- Use a stable lowercase slug and keep the title, category, cover image, content, and `publishedAt` fields consistent.
- Set `publishedAt` to the actual insertion or publishing time as a timezone-aware ISO 8601 value.
- Put the same cover asset first in `content` and in `coverImage`.
- Store a post cover at `frontend/public/assets/blog/<slug>/cover.<extension>` unless an existing project asset convention requires another path.
- Add the route under `/blog/<slug>` through the existing Blog routing model instead of creating a one-off page.
- Preserve the existing shared `BlogShareActions` ending and do not duplicate article share markup.

## Content formatting

- Render normal prose as `paragraph` blocks.
- Render section titles as `heading` blocks.
- Render procedures as `ordered-list` blocks.
- Render unordered points as `unordered-list` blocks.
- Render prompts, shell commands, and configuration snippets as `code` blocks.
- Render destination URLs and references as inline `link` items.
- Preserve meaningful tables as tables when the current content model supports them.
- Do not add a `Summary` heading unless the user explicitly requests one.
- Do not add decorative shapes, unnecessary outer borders, extra buttons, or unrelated calls to action.
- Keep long Markdown or content source text readable with one full sentence per physical line where applicable.

## Blog frontend conventions

- Keep the Blog listing at a centered `max-w-5xl` content width with three desktop columns and responsive single-column behavior on small screens.
- Use the same `max-w-5xl` width for the article cover, title, body, and ending so the detail page aligns with the listing.
- Keep the public header visually consistent with the main site by using the shared transparent or immersive header treatment over the Blog background.
- Use a subtle light blue to white CSS gradient behind the Blog page, with the color becoming white early in the page.
- Preserve generous bottom spacing after the final listing row before the footer.
- Keep each card simple and border-free, with a lightly rounded cover image, title, category, dot separator, and date.
- Do not add card descriptions unless the user explicitly requests them.
- Keep card titles left-aligned, use `text-pretty` instead of `text-balance`, reserve two lines with `min-h-[2.5rem]`, and apply `line-clamp-2` so a long title ends with an ellipsis on line two rather than creating a third line or uneven right-side whitespace.
- Use a 16:9 `aspect-video object-cover` cover with `rounded-md` corners.
  Crop unusually tall or wide source images in CSS to match the Blog card ratio without modifying the original source.
- Keep inline article images at their natural aspect ratio unless the source is intentionally a small vertical screenshot.
  Use the existing `size: "narrow"` option for intentionally small vertical images.
- Place the article cover above the article title on detail pages.
  Keep the title bold but smaller than the page heading and avoid excessive right-side whitespace.
- Keep article body line spacing compact and readable.

## Fixed article ending

- Render `BlogShareActions` after the final content block for every article.
- Keep the ending as a reusable component for all current and future posts.
- It must contain a thin divider, the `Share` label, a text-only `Copy link` button, and icon-only square-ish X, LinkedIn, and Facebook buttons.
- Use SVG platform icons with accessible labels and links that include the article title and canonical article URL.
- Use the canonical URL format `https://lightvela.ai/blog/<slug>`.

## Verification

- Add or update focused tests for the listing card, article route, title clamping, cover crop, language behavior, publishing metadata, and share actions.
- Run the focused Blog Vitest tests.
- Run `pnpm i18n:check`, `pnpm check`, and `git diff --check` after implementation.
- Run `pnpm build:global` when routes, metadata, public assets, or build-time content change.
- Check that no unrelated files or generated assets were added.
