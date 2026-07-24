# Publishing contract

Resolve this table before choosing a mode template. Every mode inherits the selected platform contract.

| Platform | Channel | Default language | Default form | Default output shape | Attribution |
| --- | --- | --- | --- | --- | --- |
| X / Twitter | social-media | `en` | `text` | `longform-article` | `social_x` |
| Medium | social-media | `en` | `text` | `longform-article` | `social_medium` |
| LinkedIn | social-media | `en` | `text` | `longform-article` | `social_linkedin` |
| Product Hunt | social-media | `en` | `text` | `longform-article` | `social_producthunt` |
| Tencent Techpedia / 技术百科 / 开发者社区 | techpedia | `both` | `md` | `markdown-files` | `social_techpedia` |

## Overrides and delivery

- Honour explicit `language` or `form` choices. A `text` social post still uses Markdown formatting; it only stays in chat.
- Use `thread` only when explicitly requested. “X + long-form/article” remains one Markdown-formatted long article, which the user may later split.
- Techpedia produces a polished Chinese `.zh.md` and English `.en.md` file by default. Save to `product/longform-content/<yyyy-mm-dd>-<slug>.zh.md` and `.en.md` when no established directory exists.
- `form=md` may use concise native Markdown tables when they materially clarify comparisons, specifications, timelines, data, or sources. Do not use HTML tables or force prose into cells.

## Link attribution

Every `lightvela.ai` link in one article uses the resolved attribution: body links, CTA, LightVela bridge, references, and Community Ending. Use `?from=<value>` when there is no query string and `&from=<value>` when one exists; never duplicate or mix `from` values. Do not add attribution to QR/CDN links.

Use `lv-seo-geo` to verify the route and correct language-localized URL before publishing a LightVela link.
