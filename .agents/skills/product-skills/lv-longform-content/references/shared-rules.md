# Shared rules

## Writing and structure

- Default to a complete 900–1,500 word article unless the user gives a length. `industry-update` may vary when evidence needs more context.
- Put the hero image first, then an answer-first opening: in 1–3 self-contained sentences directly answer the title question or define the topic before any story, setup, or pain point.
- Use short, natural headings; short paragraphs; concrete nouns and verbs; specific prompts/examples when useful. Avoid SEO stuffing, AI hype, and invented product facts.
- Keep LightVela, Hermes, Skills, Channels, and Automations relevant to the actual topic. Do not copy a reference article beyond structural inspiration.

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

- The first paragraph is answer-first and the requested style is applied.
- The selected platform contract and mode rules are both satisfied.
- Every `lightvela.ai` URL has the one matching `from` value.
- Image count and format match the mode.
- The Community Ending is the last section unless explicitly waived by the user.
