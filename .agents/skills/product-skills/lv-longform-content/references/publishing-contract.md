# Publishing contract

Resolve this table before choosing a mode template. Every mode inherits the selected platform contract.

| Platform | Channel | Default language | Default form | Default output shape | Attribution |
| --- | --- | --- | --- | --- | --- |
| X / Twitter | social-media | `en` | `text` | `longform-article` | `social_x` |
| Medium | social-media | `en` | `text` | `longform-article` | `social_medium` |
| LinkedIn | social-media | `en` | `text` | `longform-article` | `social_linkedin` |
| Product Hunt | social-media | `en` | `text` | `longform-article` | `social_producthunt` |
| Tencent Techpedia / 技术百科 / 开发者社区 | techpedia | `both` | `md` | `markdown-files` | `social_techpedia` |

## Platform storage

For `markdown-files`, and when the user explicitly asks to save or create an MD file, use the resolved platform folder:

| Resolved platform | Folder |
| --- | --- |
| `techpedia` | `wiki/techpedia/` |
| `x` | `product/longform-content/x/` |
| `medium` | `product/longform-content/medium/` |
| `linkedin` | `product/longform-content/linkedin/` |
| `producthunt` | `product/longform-content/producthunt/` |
| Other saved Markdown | `product/longform-content/other/` |

Create the folder when needed.
Do not store generated article Markdown directly in `product/longform-content/`.

## Placement for comparisons

For `vs-product`, also resolve the publication placement:

| Placement | Meaning | Intro treatment |
| --- | --- | --- |
| `internal` / 站内 | Published inside LightVela-owned pages or documentation | Do not add the external LightVela definition block unless requested |
| `external` / 站外 | Published on an external channel, publication, or community | Add the language-matched LightVela definition block near the beginning, after the title/hero and before the answer-first opening |

If a `vs-product` brief does not specify 站内 or 站外, ask before drafting. For 站外, the definition block must use the resolved platform attribution in its LightVela link.

## Overrides and delivery

- Honour explicit `language` or `form` choices. A `text` social post still uses Markdown formatting; it only stays in chat.
- Use `thread` only when explicitly requested. “X + long-form/article” remains one Markdown-formatted long article, which the user may later split.
- Techpedia produces a polished Chinese `.zh.md` and English `.en.md` file by default. Save to `wiki/techpedia/<yyyy-mm-dd>-<slug>.zh.md` and `.en.md`.
- `form=md` may use concise native Markdown tables when they materially clarify comparisons, specifications, timelines, data, or sources. Do not use HTML tables or force prose into cells.

## Link attribution

Every `lightvela.ai` link in one article uses the resolved attribution: body links, CTA, LightVela bridge, references, and Community Ending. Use `?from=<value>` when there is no query string and `&from=<value>` when one exists; never duplicate or mix `from` values. Do not add attribution to QR/CDN links.

Use `lv-seo-geo` to verify the route and correct language-localized URL before publishing a LightVela link.
