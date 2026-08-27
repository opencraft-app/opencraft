---
name: lv-longform-content
description: 生成 LightVela 长篇营销/产品文章的专用技能。用户要求撰写“LV 长篇内容”“长篇内容”、教程系列、功能介绍系列、应用场景系列、行业更新/行业研究、竞品对比 / product comparison / “vs” 文章、社媒长文、Tencent Techpedia/腾讯技术百科、开发者社区、博客/文章草稿，或围绕 LightVela 功能、Channels、Skills、Automations、Hermes Agent、SkillHub/ClawHub、Souls、模型配置、真实用户场景创作长文时使用，尤其适用于指定 X、Medium、LinkedIn、Product Hunt 或 Techpedia 发布平台的内容。
---

# LightVela 长篇内容

## 1. Resolve the brief before writing

Identify these fields. `mode`, `platform`, and `subject` are required; derive the rest from the publishing contract unless the user explicitly overrides them.

```text
mode: tutorial | feature-intro | use-case | industry-update | vs-product
platform: x | medium | linkedin | producthunt | techpedia
subject: <topic>
language: en | zh | both
form: text | md
output_shape: longform-article | thread | markdown-files
attribution: social_<platform>
placement: internal | external
style: default
storage_folder: <derived from platform>
```

Read `references/publishing-contract.md` first. If `mode`, `platform`, or `subject` is missing, ask once for every missing item. Do not ask separately about language or form: use the platform default. Generic “social media”, “blog”, or “write an article” is not a platform.

For `vs-product`, also resolve `placement` before drafting: ask whether the document is for 站内 (internal) or 站外 (external) when the user has not said. Do not infer this from the platform. For 站外, apply the external-publication intro block in the mode reference; omit it for 站内 unless the user explicitly requests it.

Before drafting, read:

1. `references/shared-rules.md`
2. `references/modes/<mode>.md`
3. `references/styles/default.md`, or the requested installed style file; if a named style is not installed, ask for a sample or confirm using the default instead of silently inventing it
4. `../lv-seo-geo/SKILL.md` when the article includes LightVela links

## 2. Research and product facts

- For `feature-intro`, and for any named product capability, verify the feature in repo code/docs before writing. Describe it in user language unless the audience explicitly wants developer detail; never invent fields, endpoints, paths, or behavior.
- For `tutorial` and `use-case`, lightly verify named product capabilities.
- For `industry-update`, research before outlining. Use high-quality traceable sources and cross-check material facts; its mode file has the full evidence and image rules.
- For `vs-product`, research both sides from primary sources before comparing them. Do not infer pricing, feature parity, performance, support, or operational requirements from brand reputation.

## 3. Produce the resolved output

Follow the resolved publishing contract even when the selected mode is `industry-update`:

- `longform-article` is Markdown-formatted long prose with headings, emphasis, lists, links, and code blocks where useful. It is not a numbered thread.
- Use `thread` / `1/n` only when the user explicitly asks for a thread, 串文, or content split into posts.
- `text` means “return in chat”, not “remove Markdown formatting”.
- `markdown-files` means create the required files in the resolved platform folder and report their absolute paths.
- For social `text` output, create an MD file only when the user explicitly asks to save it or create an MD file, then use the same platform folder.

All complete articles end with the language-matched Community Ending unless the user explicitly asks to omit the ending or QR codes. All `lightvela.ai` links must use the one resolved platform attribution. Use the SEO/GEO skill as the source of truth for real routes and URL construction.

## Platform storage

Resolve `storage_folder` from `references/publishing-contract.md` before writing files.
Store every generated article MD in the exact folder defined by the publishing contract. Techpedia uses `wiki/techpedia/`; other saved platform content remains under `product/longform-content/<storage_folder>/`. Never store files directly at either content root.

## 4. Final check

Check the applicable mode, publishing contract, storage folder, link attribution, Community Ending, image policy, language, and output form before responding. For saved files, report mode, platform, form, languages, and paths.

## Reference map

- `references/publishing-contract.md`: platform → language, form, output shape, attribution, delivery.
- `references/shared-rules.md`: writing, links, images, Community Ending, final checks.
- `references/modes/`: content-specific structures and constraints.
- `references/styles/`: reusable voice/style layers.
- `evals/evals.json`: regression cases for critical output contracts.
