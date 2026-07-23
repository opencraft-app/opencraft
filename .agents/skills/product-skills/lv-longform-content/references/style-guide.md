# LightVela Long-Form Style Guide

## Shared Style

Write like a product builder explaining something useful to a real user. The style is warm, clear, and practical, with enough narrative to make the article readable.

Default article length: 900-1,500 words unless the user gives a target length. `industry-update` may be shorter or longer when the event needs enough context and caveats.

**Answer-first opening (GEO/AEO):** the very first paragraph (after the hero image, before any setup or story) must directly answer the title's question or define the topic in 1-3 sentences, so search engines and AI search can extract the conclusion straight from the top. For a question title (e.g. "Who is LightVela for?"), the first sentence answers it head-on ("LightVela is for … these kinds of people: …") — do not open with a story or a pain point. For a feature/noun title, open with a one-sentence definition ("X is …, which lets you …"). The paragraph must stand on its own; put narrative, scenarios, and steps *after* this summary. Answer-first constrains only the opening paragraph; each mode's arc then unfolds as usual below it.

## Output Channel

Choose one output channel and one publishing platform before writing. The platform determines the `from` attribution parameter for every `lightvela.ai` link; language and form (text vs Markdown) default from the channel per the table in `SKILL.md` (语言与形式默认值). Honour any explicit language/form the user gave and never ask about them separately. Generic “social media” or “blog” is not a platform; ask whether the target is X, Medium, LinkedIn, Product Hunt, or Techpedia.

For examples below, replace `<distribution_from>` with the exact mapped value from `SKILL.md` before producing an article. Never emit the placeholder in final content.

- `social-media`: use only when the user names X, Medium, LinkedIn, or Product Hunt; produce the article in chat unless the user asks to save it. Default language is English unless the user asks for Chinese or bilingual output. Default form is in-chat text, **not** `.md`.
- `techpedia`: for Tencent Techpedia、腾讯技术百科、开发者社区、开发者文章, produce Markdown files, not chat-only output. Always create both a Chinese version and an English version (`.zh.md` + `.en.md`) — this is a fixed, bundled default.

If the user does not specify the channel (or mode/topic), run the consolidated intake in `SKILL.md`; do not ask about language or form in a separate round.

Markdown-specific rule: when `form=md`, use native Markdown tables when they materially clarify comparisons, specifications, timelines, datasets, or source summaries. Keep columns concise and readable; do not use HTML tables or force long prose into cells. Plain-text articles do not need tables by default.

Use this shape:

```markdown
Article Title
[RECOMMEND ADD IMAGE: Recommended hero image or product screenshot — <why it belongs here>]
Answer-first opening paragraph: directly answer the title's question / define the topic in 1-3 sentences, then a short bridge into the body.

Section Heading
Body...
[RECOMMEND ADD IMAGE: Screenshot or diagram for this moment — <what it shows / why>]

Section Heading
Body...

Done / What Comes Next / Why It Matters
Closing paragraphs...

## Join LightVela's Community for More Updates!

**Visit us at [LightVela](https://lightvela.ai/?from=<distribution_from>)**

**Discord** — scan the QR code to join our Discord community and connect with builders for the latest updates.

![LightVela Discord QR](https://dscache-intl.cloudcachetci.com/upload/nodir/disc_LV-23c00256e06401213046ab1142a1db7438ecc40b.png)

**WhatsApp** — scan the QR code to join our WhatsApp group, try LightVela, and chat with us directly.

![LightVela WhatsApp QR](https://dscache-intl.cloudcachetci.com/upload/nodir/whatsapp_LV-e2089814c4615f98fdae3c9d457ceee4b3654f9f.png)
```

Voice rules:

- Use first person for use-case stories when appropriate: "I wanted...", "I connected...", "What I learned...".
- Use second person for tutorials: "You will...", "Make sure...", "Go back...".
- Use product voice for feature introductions: "LightVela gives...", "A Soul is...", "This lets...".
- Use an informed first-person voice for industry updates: distinguish reported facts from personal judgment, and do not force Hermes or LightVela into an unrelated topic.
- Keep paragraphs short, usually 2-5 sentences.
- Prefer concrete nouns and verbs: connect, paste, install, ask, schedule, reply, verify.
- Use examples and short quoted prompts where the user needs to see exactly what to type.
- Keep the ending grounded: what the user can now do, why it matters, and what the pattern unlocks.
- Always append the Community Ending after the article's normal closing when the selected output channel requires it. The Discord and WhatsApp QR images are real assets, not `[Image]` placeholders.
- Use the fixed image recommendation format defined in `SKILL.md` (图片建议固定模板). Inside the article, put a standalone bracketed line at each image spot: `[RECOMMEND ADD IMAGE: <what to add> — <why it belongs here>]`. Do not use a bare `[Image]` or arbitrary variants.
- Keep image density fair: usually 2-4 images for a long article, up to 5 only for a screenshot-heavy tutorial. `industry-update` is the exception: generate exactly one topic-specific hero image with Codex image generation and no other image placeholders.

Avoid:

- SEO stuffing.
- Over-polished launch slogans.
- Long bullet lists unless the article is genuinely procedural.
- Claiming features that were not provided by the user or found in repo/docs.
- Saying "seamless", "revolutionary", "game-changing", or similar empty marketing terms.

## Community Ending

Append this exact ending after every complete article when the selected output channel requires it, regardless of whether the selected mode is `tutorial`, `feature-intro`, `use-case`, or `industry-update`. Keep it after the article's own closing section, and do not replace the QR images with `[Image]` placeholders.

**The ending's language follows the article's output language:** use the English block for English articles (and English-default `social-media`), and the Chinese block for Chinese articles (e.g. the `.zh.md` file in a `techpedia` pair). The QR image URLs are identical in both; only the invite copy differs.

English ending:

```markdown
## Join LightVela's Community for More Updates!

**Visit us at [LightVela](https://lightvela.ai/?from=<distribution_from>)**

**Discord** — scan the QR code to join our Discord community and connect with builders for the latest updates.

![LightVela Discord QR](https://dscache-intl.cloudcachetci.com/upload/nodir/disc_LV-23c00256e06401213046ab1142a1db7438ecc40b.png)

**WhatsApp** — scan the QR code to join our WhatsApp group, try LightVela, and chat with us directly.

![LightVela WhatsApp QR](https://dscache-intl.cloudcachetci.com/upload/nodir/whatsapp_LV-e2089814c4615f98fdae3c9d457ceee4b3654f9f.png)
```

Chinese ending（中文文章用这个）:

```markdown
## 加入 LightVela 社区，获取更多动态！

**访问 [LightVela](https://lightvela.ai/?from=<distribution_from>)**

**Discord** —— 扫码加入我们的 Discord 社区，与开发者交流、获取最新动态。

![LightVela Discord QR](https://dscache-intl.cloudcachetci.com/upload/nodir/disc_LV-23c00256e06401213046ab1142a1db7438ecc40b.png)

**WhatsApp** —— 扫码加入我们的 WhatsApp 群组，体验 LightVela、直接和我们聊聊。

![LightVela WhatsApp QR](https://dscache-intl.cloudcachetci.com/upload/nodir/whatsapp_LV-e2089814c4615f98fdae3c9d457ceee4b3654f9f.png)
```

## Image Planning

Before finalizing, decide whether images improve the article. Prefer images that reduce reader effort:

- Hero or product state image near the top.
- Screenshot after a major UI milestone.
- Simple diagram for a workflow, lifecycle, or architecture explanation.
- Result screenshot near verification or outcome.

Do not overfill the article with images. If an image is recommended, mark the exact position in the article with a standalone `[RECOMMEND ADD IMAGE: <specific recommendation> — <why>]` line.

After the article is produced, also include a short chat summary:

```markdown
Image recommendations:
- After "<section heading>": <image to add> — <why>
- After "<section heading>": <image to add> — <why>
```

For `techpedia`, keep these image placeholders inside both `.zh.md` and `.en.md` files, and include the same image recommendation list in the final chat response.

## Techpedia / Developer Community Files

For Tencent Techpedia or 开发者社区 output:

- Create two Markdown files: `<slug>.zh.md` and `<slug>.en.md`.
- The Chinese version should be publication-ready Chinese, not a rough machine translation.
- The English version should follow the same structure, examples, and image placeholders.
- Include the Community Ending in both files.
- Report the saved paths in the final chat response.
- If the repository has no established content directory, use `product/longform-content/<yyyy-mm-dd>-<slug>.zh.md` and `product/longform-content/<yyyy-mm-dd>-<slug>.en.md`.

## Tutorial Series

Use for `LV 长篇内容（教程系列）`.

Purpose: help a user complete a concrete setup or workflow.

Recommended structure:

```markdown
<Outcome-focused title>
[RECOMMEND ADD IMAGE: Hero screenshot showing the finished setup or target workflow — <what the reader sees when it's done>]
Answer-first: in 1-2 sentences state what this guide gets you to and roughly what it takes, then say what the guide will help the user do.

Before You Start
Prerequisites, accounts, tokens, model/channel/skill requirements, safety notes.

Step 1: <Action>
Clear instruction and product context.
[RECOMMEND ADD IMAGE: Screenshot of the UI after completing this milestone — <what state to confirm>]

Step 2: <Action>
Continue with exact clicks, fields, commands, or prompts.

Step 3: <Action>
...

Verify It Works
Tell the user what success looks like and what to ask Hermes.

If Something Goes Wrong
Common failure cases and practical fixes.

A Few Notes
Constraints, best practices, or edge cases.

Done
Short closing that restates the completed outcome.

## Join LightVela's Community for More Updates!

**Visit us at [LightVela](https://lightvela.ai/?from=<distribution_from>)**

**Discord** — scan the QR code to join our Discord community and connect with builders for the latest updates.

![LightVela Discord QR](https://dscache-intl.cloudcachetci.com/upload/nodir/disc_LV-23c00256e06401213046ab1142a1db7438ecc40b.png)

**WhatsApp** — scan the QR code to join our WhatsApp group, try LightVela, and chat with us directly.

![LightVela WhatsApp QR](https://dscache-intl.cloudcachetci.com/upload/nodir/whatsapp_LV-e2089814c4615f98fdae3c9d457ceee4b3654f9f.png)
```

Style notes:

- Make the first paragraph answer-first: state the outcome and rough effort up front, before any setup context.
- Number steps only when the sequence matters.
- Include safety notes near the action that creates risk, such as tokens, API keys, permissions, or public channels.
- Add `[RECOMMEND ADD IMAGE: <specific screenshot> — <why>]` after major UI milestones.
- Include short prompt examples in fenced code blocks when users should type something into Hermes.

## Feature Introduction Series

Use for `LV 长篇内容（功能介绍系列）`.

Purpose: introduce a product capability and explain why users should care.

> ⚠️ **Audience: non-technical users.** You may read the codebase to confirm the feature is real (per `SKILL.md` 功能相关内容必须基于真实代码), but the article itself must NOT expose backend details — no file paths, API endpoints, field names, proto, config keys, Go/TS types, or service/dir names. Code is the source of truth for facts, not the vocabulary. Rewrite every mechanism in plain product language (e.g. "give your Agent a persona profile", not "materialize a SOUL.md into the sandbox workspace"). Only keep implementation detail when the reader is explicitly a developer.

Recommended structure:

```markdown
Introducing <feature>: <human benefit> with LightVela
[RECOMMEND ADD IMAGE: Product screenshot or simple visual showing the feature — <the capability at a glance>]
Answer-first: open with a one-sentence definition of the feature and the benefit it gives users, then bridge into the existing LightVela/Hermes context and the problem it answers.

What Is <Feature>?
Define the capability in simple product language.

Why It Matters
Explain the user need and what changes after the feature exists.
[RECOMMEND ADD IMAGE: Before/after visual or user-facing state — <what changed for the user>]

How It Works
Explain entry points, core actions, states, and result.
[RECOMMEND ADD IMAGE: Screenshot or diagram of the workflow — <entry points and states>]

What You Can Do With It
Give 2-4 concrete examples in prose.

What Comes Next
Close with the product direction and what this first version unlocks.

## Join LightVela's Community for More Updates!

**Visit us at [LightVela](https://lightvela.ai/?from=<distribution_from>)**

**Discord** — scan the QR code to join our Discord community and connect with builders for the latest updates.

![LightVela Discord QR](https://dscache-intl.cloudcachetci.com/upload/nodir/disc_LV-23c00256e06401213046ab1142a1db7438ecc40b.png)

**WhatsApp** — scan the QR code to join our WhatsApp group, try LightVela, and chat with us directly.

![LightVela WhatsApp QR](https://dscache-intl.cloudcachetci.com/upload/nodir/whatsapp_LV-e2089814c4615f98fdae3c9d457ceee4b3654f9f.png)
```

Style notes:

- After the answer-first definition sentence, lead with the shift in user experience, not an internal implementation detail.
- Use "what Hermes can use" vs "how Hermes shows up" style contrasts when helpful.
- Avoid full step-by-step setup unless the feature intro needs a short "how to try it" section.
- Keep product definitions crisp: one feature, one job, one user-facing benefit.

## Use-Case Series

Use for `LV 长篇内容（应用场景系列）`.

Purpose: tell a specific story showing how LightVela turns Hermes into a useful always-on assistant.

Recommended structure:

```markdown
I made a <scenario> agent in <channel> with LightVela
[RECOMMEND ADD IMAGE: Hero image showing the channel or finished assistant — <where the story lives>]
Answer-first: in 1-2 sentences say what this agent does and how LightVela made it possible (the takeaway), then open the story with the specific annoyance, recurring task, or personal need.

Starting With <Channel or Entry Point>
Why this channel/workflow fit the user's real behavior.
[RECOMMEND ADD IMAGE: Screenshot of the channel or entry point — <how the user gets in>]

Giving Hermes The Right Tools
Explain skills, model, memory, channel, or configuration used.
[RECOMMEND ADD IMAGE: Screenshot of skills, model, memory, or configuration — <the tools wired in>]

Turning It Into <Specific Assistant>
Show example prompts and what Hermes returns or helps with.

Automating The Assistant
If relevant, explain scheduled or repeated tasks with Automations.
[RECOMMEND ADD IMAGE: Screenshot of the automation schedule or repeated result — <the repeatable payoff>]

What I Learned
Extract the product pattern.

Why I Liked It
End emotionally but practically: what became easier, what stayed online, what felt personal.

## Join LightVela's Community for More Updates!

**Visit us at [LightVela](https://lightvela.ai/?from=<distribution_from>)**

**Discord** — scan the QR code to join our Discord community and connect with builders for the latest updates.

![LightVela Discord QR](https://dscache-intl.cloudcachetci.com/upload/nodir/disc_LV-23c00256e06401213046ab1142a1db7438ecc40b.png)

**WhatsApp** — scan the QR code to join our WhatsApp group, try LightVela, and chat with us directly.

![LightVela WhatsApp QR](https://dscache-intl.cloudcachetci.com/upload/nodir/whatsapp_LV-e2089814c4615f98fdae3c9d457ceee4b3654f9f.png)
```

Style notes:

- Use a first-person narrative when the prompt is a scenario/story.
- Open with a one-to-two sentence answer-first takeaway (what the agent does + that LightVela made it easy); then start the story from a small annoyance, not from the product.
- Make the build feel achievable: channel + skill + instruction + optional automation.
- Include transferable examples near the end: "The same pattern could work for..."
- Keep the article honest. If a skill or data source is hypothetical, phrase it as "you could" or "with the right skill".

## Industry Updates

Use for `industry-update`.

Purpose: analyze a concrete model release, product change, hardware trend, infrastructure shift, research result, policy event, or ecosystem development. The article should be topic-first and observational, not a tutorial, feature introduction, or sales page. Hermes and LightVela are optional context, not the subject by default.

Recommended structure:

```markdown
<Industry Update Title>
<One Codex-generated topic-specific hero image>
Answer-first opening: state what happened, why it matters, and how readers should understand it.

The Short Version
What Actually Happened
Research and Evidence
What Changed — and What Did Not
The Caveats Nobody Mentions
Who Should Care
What This Says About the Industry
Personal Take and What I’m Watching Next
Where LightVela Fits

## Join LightVela's Community for More Updates!
...
```

Rules:

- Generate exactly one original 16:9 hero image with Codex `imagegen`; do not write a `[RECOMMEND ADD IMAGE: ...]` placeholder and do not add further article images.
- Research before outlining or drafting. Use high-quality, traceable sources: primary announcements and documentation, papers or research institutions, regulator/government documents, original benchmarks or datasets, filings, and formal interviews; use reputable edited media and industry research for context and independent perspective.
- Cross-check key facts, dates, prices, performance numbers, and policy claims with two independent sources when possible. State source conflicts, dates, and uncertainty instead of manufacturing certainty.
- Keep an evidence trail with inline links or a concise `Sources` section. Do not treat unsourced social posts, SEO farms, unattributed reposts, affiliate roundups, or screenshots as the sole evidence for an important claim.
- Include dates, units, sample sizes, benchmark scope, and caveats for important numbers. Use a native Markdown table when it makes comparisons, specifications, timelines, data, or sources easier to understand.
- Use a clean, minimal futuristic editorial-poster aesthetic: soft lavender gradients, glossy lighting, restrained glass or metallic surfaces, minimal UI accents, topic-relevant floating elements, and generous negative space.
- Make the visual specific to the article's topic. Use one clear object or metaphor for the actual event or change; avoid generic robots, unrelated sci-fi visuals, clutter, dense UI, fake logos, and long or unreadable text.
- Place the main subject on the right or lower-right and reserve the left or upper-left for a short 2-5 word headline and optional small `INDUSTRY UPDATE` eyebrow. Match the article language and keep typography sparse.
- Do not require Hermes or LightVela to appear in the article. Keep the body focused on the industry topic.
- Merge personal judgment and future monitoring into `Personal Take and What I’m Watching Next`; do not add a separate `Closing Thought` section.
- Add one concise, natural LightVela bridge near the end only. This is the only place where LightVela links may appear. Before writing it, use `lv-seo-geo` to verify the relevant real route, localization, and matching `from` attribution. Do not add LightVela links in the opening or body.
- If the output channel requires the Community Ending, put it after the LightVela bridge.

Image prompt pattern:

```text
Create one 16:9 editorial hero image for an industry-update article about "<specific topic>".
Use an exceptionally clean, minimal futuristic blog-poster aesthetic with soft lavender and pale violet gradients, glossy studio lighting, restrained glass or metallic materials, generous negative space, minimal UI-like accents, and a few topic-relevant floating elements.
Make the main subject unmistakably about <specific product, model, hardware, research, event, or policy>. Use one clear visual metaphor for the article's actual change or tension, not a generic humanoid robot.
Place the main subject on the right or lower-right, keep the left or upper-left calm for a short 2-5 word headline, and use only sparse explanatory elements such as a timeline, benchmark card, data stream, network node, price marker, or regulatory boundary when they fit the topic.
Use clean modern sans-serif typography and, if useful, a small "INDUSTRY UPDATE" eyebrow. Do not add paragraphs, fake UI copy, dense labels, fake logos, fake brand marks, or unreadable microtext. Match the article language.
Make it polished, editorial, topic-specific, and suitable as a blog hero image; avoid clutter, excessive neon, stock-photo styling, and visual noise.
```

## Quick Revision Checklist

Before finalizing, check:

- The selected mode matches the prompt.
- The output channel is known. If mode/channel/topic are not all clear, run the consolidated intake from `SKILL.md` (never ask about language or form separately).
- The title matches the series style.
- For `tutorial`, `feature-intro`, and `use-case`, the article has a `[RECOMMEND ADD IMAGE: <specific recommendation> — <why>]` hero line, and its first paragraph is answer-first: it directly answers the title's question / defines the topic in 1-3 self-contained sentences before any story, pain point, or setup.
- For `industry-update`, the article has exactly one Codex-generated, topic-specific hero image and no `[RECOMMEND ADD IMAGE: ...]` lines or additional image recommendations.
- For `industry-update`, research happened before drafting; important claims have traceable, high-quality sources, key facts are cross-checked where possible, and data includes dates, units, scope, and caveats.
- For non-`industry-update` modes, image spots appear at natural screenshot moments, with fair density, all using the fixed `[RECOMMEND ADD IMAGE: <what> — <why>]` format.
- The final chat response lists recommended image placements for non-`industry-update` modes; for `industry-update`, it reports the generated hero image instead.
- For Techpedia/开发者社区, two Markdown files exist: Chinese and English.
- The Community Ending appears after the normal article closing, with both QR image links intact.
- Markdown articles may use concise native Markdown tables when they materially improve comparisons, specifications, timelines, data, or source summaries; plain-text articles do not require tables.
- The product mechanics are clear enough to act on.
- The piece sounds like LightVela/Hermes when the topic calls for it; `industry-update` remains topic-first and does not force either product into the body.
- No attached example content is copied beyond structural inspiration.
- SEO/GEO: opening is answer-first (title question answered / topic defined in the first paragraph); contains the main keyword once; at least one clear definition sentence; meaningful internal links woven through the body for non-`industry-update` modes, each pointing to a real verified route (never a markdown source filename like `/docs/01-overview` — use `/docs/overview`); no keyword stuffing. For `industry-update`, LightVela links appear only in the closing bridge and are verified with `lv-seo-geo`. (Full link-verification procedure and route list belongs to `lv-seo-geo`.)
