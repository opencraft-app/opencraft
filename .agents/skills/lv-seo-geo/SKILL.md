---
name: lv-seo-geo
description: LightVela 专用 SEO/GEO 技能。用户要求审查、编辑或规划 LightVela 页面、文档、博客的搜索可见性、生成式搜索优化、关键词、页面描述、sitemap.xml 一致性、canonical/hreflang 路由暴露、内部链接、主题簇，或涉及 AI agent、AI assistant、Hermes Agent、cloud hosting、easy VPS 等关键词时使用。LightVela URL/path 发生变化且可能影响 sitemap 或 SEO metadata 时也使用。
---

# LightVela SEO/GEO

## 定位

这个技能用于 LightVela 页面、文档、长篇内容的 SEO 与 GEO 检查和改写。它关注产品关键词、页面内反链、sitemap 一致性、AI 搜索可读性，不替代通用 metadata 技能。

如果任务涉及 title、meta description、canonical、Open Graph、Twitter Card、JSON-LD 等技术 metadata，同时使用 `fixing-metadata`。

## 必读代码

执行 SEO/GEO 任务前，按改动范围读取：

- `frontend/src/lib/seo-data.ts`
- `frontend/next-site/seo.tsx`
- `frontend/src/app/sitemap.xml/route.next.ts`
- `frontend/next-site/docs-route-manifest.ts`
- `frontend/src/config/docs-sidebar.ts`
- 目标页面/文档文件

详细检查清单见 `references/seo-geo-rules.md`。

## 工作流

1. 判断任务类型：
   - SEO：搜索引擎可索引页面、关键词、title/description、sitemap、canonical、内部链接。
   - GEO：面向 ChatGPT、Perplexity、Google AI Overview 等生成式搜索的实体表达、问题回答、概念定义、场景化段落。
   - 混合任务：两者都做。

2. 明确页面目标：
   - 页面 URL / slug 是否变化。
   - 目标区域：国际站、国内站，或双站。
   - 目标主题：AI agent、AI assistant、Hermes Agent、cloud AI agent、agent hosting、easy cloud/VPS、Telegram bot、automations、skills 等。

3. 检查 sitemap 与真实路由：
   - 如果新增、删除、重命名 docs slug 或 public page，检查 `sitemap.xml` 生成来源是否同步。
   - 对 docs 页，重点检查 `docs-route-manifest.ts`、`docs-sidebar.ts`、真实 markdown 文件是否一致。
   - 如果发现页面实际可访问但 sitemap 没有，或 sitemap 有但页面已不存在，必须在最终回复提醒用户并建议修复。

4. 做页面内 SEO：
   - 页面首屏/开头自然包含主关键词。
   - H1/H2 能明确说明页面主题。
   - 添加相关内部链接，不堆砌。
   - 更新 `seo-data.ts` 页面级 description 时，确保与页面真实内容一致。

5. 做 GEO：
   - 增加清晰定义句，例如 “LightVela is a cloud-hosted personal AI agent platform...”
   - 使用问答式、对比式、场景式段落，让生成式搜索容易抽取答案。
   - 让 Hermes Agent、LightVela、cloud hosting、skills、automations、channels 的关系说清楚。
   - 避免关键词堆砌；关键词必须服务于解释。

6. 输出审查结果或改动总结：
   - 关键词覆盖。
   - sitemap/路由一致性。
   - 内部链接建议或已添加链接。
   - GEO 可抽取性改进。
   - 未处理风险。

## 关键词原则

优先使用 LightVela 的自然产品语言，不要把页面写成关键词农场。

核心英文关键词：

- LightVela
- cloud AI agent
- personal AI agent
- AI assistant
- AI companion
- Hermes Agent
- agent hosting
- cloud-hosted agent
- always-on AI agent
- AI agent with memory
- Telegram bot / WhatsApp bot / Discord bot
- automations
- skills
- easy cloud / easy VPS / cloud runtime

核心中文关键词：

- LightVela
- 云端 Agent
- 个人 Agent
- AI 助手
- AI 伙伴
- Hermes Agent
- Agent 托管
- 云端托管
- 长期记忆
- 自动任务
- 技能
- 多通道接入

## 内链/Backlink 要求

页面内推荐加入上下文相关内部链接：

- 概念解释页链接到 docs overview/core concepts。
- 功能页链接到对应 configuration docs。
- 长篇教程链接到 Quickstart、model、channel、skill、automation docs。
- 应用场景文链接到最相关的 setup/tutorial 页面。

不要为了 SEO 加无意义链接。每个链接都要帮助用户继续完成下一步。

## 输出语言

用户用中文提问时，用中文回复。改英文页面时，页面正文和 metadata 用英文。

## Reference

- `references/seo-geo-rules.md`: LightVela SEO/GEO 具体规则、sitemap 检查、关键词主题簇。
