# Shared rules

## Writing and structure

- Default to a complete 900–1,500 word article unless the user gives a length. `industry-update` may vary when evidence needs more context.
- Put the hero image first, then an answer-first opening: in 1–3 self-contained sentences directly answer the title question or define the topic before any story, setup, or pain point.
- Open every article with an explicit summary section so answer engines can extract it. Requirements:
  - Use a dedicated heading: `## 摘要` (zh) or `## Summary` (en). Do not use `TL;DR`, `一句话回答`, or other informal labels.
  - Place it before any hook, anecdote, or context section, immediately after the hero image when one exists.
  - Write 1–2 self-contained bold paragraphs (or a short bold list when the answer is genuinely enumerable) that summarize the article and directly answer the question in the title. It must stand alone when quoted with no other part of the page.
  - Name the concrete entities, numbers, file names, and conclusions the body will support. Do not tease ("read on to find out") and do not merely restate the title.
  - Keep it distinct from the page `description` / meta summary: the description is a one-line SEO blurb, the summary section is the extractable answer.
- Use short, natural headings; short paragraphs; concrete nouns and verbs; specific prompts/examples when useful. Avoid SEO stuffing, AI hype, and invented product facts.
- Keep LightVela, Hermes, Skills, Channels, and Automations relevant to the actual topic. Do not copy a reference article beyond structural inspiration.
- Never expose internal repositories, service names, hostnames, ports, or branch names in examples. Use neutral placeholders such as `agent-demo` instead of real internal project names.
- Do not write serial-only navigation such as "下一篇预告", "上一篇", "in the next post", or "this series". Docs and evergreen pages are entered directly from search or the sidebar, so cross-references must name the target article and stay valid in any reading order.

## Images

- `tutorial`, `feature-intro`, and `use-case`: recommend 2–4 valuable images (up to 5 for screenshot-heavy tutorials). Put each at its exact article position on a standalone line:

  ```text
  [RECOMMEND ADD IMAGE: <specific image> — <what it proves or why it belongs here>]
  ```

  In the final chat response, list those placements using the same format.
- `industry-update`: its mode file requires exactly one generated 16:9 hero image and no recommendation placeholders or additional images.
- QR images in the Community Ending are real hosted assets, not recommendations or local paths.

## Links and completion

- Use `lv-seo-geo` for real routes, localized URLs, natural internal links, and the matching attribution parameter. Do not use Markdown source filenames as docs URLs.
- For ordinary LightVela articles, weave useful internal links through the body. For `industry-update`, only its near-end LightVela bridge may contain LightVela links.
- Add the exact language-matched block from `community-ending.md` after the article body, source list, and any LightVela bridge. This applies to every complete article regardless of mode, platform, form, or length.

## Final check

- The article opens with a `## 摘要` / `## Summary` section that stands alone and answers the title question.
- The first paragraph is answer-first and the requested style is applied.
- The selected platform contract and mode rules are both satisfied.
- Every `lightvela.ai` URL has the one matching `from` value.
- Image count and format match the mode.
- No internal project names, hostnames, or ports appear in examples, and no serial-only navigation ("下一篇预告", "in the next post") is present.
- The Community Ending is the last section unless explicitly waived by the user.
