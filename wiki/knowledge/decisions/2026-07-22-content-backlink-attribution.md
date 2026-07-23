# 内容反链渠道归因参数

日期：2026-07-22

## Decision

用于外部文章、社媒内容、Techpedia 和其他内容反链的 `lightvela.ai` 链接，统一通过 `from` 查询参数标记发布来源。

一篇文章内的所有 `lightvela.ai` 链接必须使用同一个来源值，包括正文内链、官网 CTA、Community ending 和引用链接。

## 渠道映射

| 发布平台 | `from` 值 |
| --- | --- |
| X / Twitter | `social_x` |
| Medium | `social_medium` |
| LinkedIn | `social_linkedin` |
| Product Hunt | `social_producthunt` |
| Tencent Techpedia / 技术百科 | `social_techpedia` |

未列入表格的平台不能自行猜测或复用其他来源值，应先补充渠道映射后再发布。

## URL 规则

- 没有查询参数时使用 `?from=...`，例如：`https://lightvela.ai/?from=social_x`。
- 已有查询参数时使用 `&from=...`，且不得重复添加 `from`。
- docs 链接同样适用，例如：`https://lightvela.ai/docs/configuration/files/?from=social_x`。
- `lightvela.ai` 路径必须使用真实路由，不能把 Markdown 源文件名当成 slug。
- 二维码和其他非 `lightvela.ai` CDN 链接不添加该参数。
- 本规则针对内容反链；canonical、sitemap 和站内页面本身的技术 metadata 不应为了归因参数而改写。

## 执行入口

- 长篇内容生成时，必须识别 X、Medium、LinkedIn、Product Hunt 或 Techpedia。只说“社媒”“social media”或“博客”时，先询问具体平台。
- SEO/GEO 任务涉及内容反链时，沿用同一套映射，并检查文章内是否混用了来源值。

具体执行规则：

- [`lv-longform-content/SKILL.md`](../../../.agents/skills/product-skills/lv-longform-content/SKILL.md)
- [`lv-seo-geo/SKILL.md`](../../../.agents/skills/product-skills/lv-seo-geo/SKILL.md)

## Context

这项规则将站外内容与 LightVela 的注册、访问和转化数据连接起来，便于按渠道评估 SEO、GEO 和内容分发效果。它落实了站外分发需要补充渠道参数的既有计划。

来源：

- [`2026-07-21 内容增长与积分邀请策略`](../../sources/brainstorm/2026-07-21-内容增长与积分邀请策略.md)
- [`2026-07-21 日会进展`](../../sources/progress/2026-07-21.md)

## Reopen When

- 新增内容分发平台，或现有平台需要拆分更细的来源值。
- 前端渠道统计字段、归因口径或 URL 规范发生变化。
- 需要将该规则扩展到 `lightvela.com` 或非内容场景。
