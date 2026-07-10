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

### ⚠️ 链接必须用真实路由，不能用 markdown 源文件名

这是常犯错误：把 docs 的 markdown 源文件名当成 URL。源文件名形如 `01-overview.md`、`02-quickstart.md`、`04-core-concepts.md`，其中的 `01-`/`02-`/`04-` 数字前缀**只是为了排序，不是路由 slug**。直接写成 `https://lightvela.ai/docs/01-overview` 一定是 404。

正确的真实路由（已验证）：

| 错误（源文件名） | 正确（真实 URL） |
| --- | --- |
| `/docs/01-overview` | `/docs/overview` |
| `/docs/02-quickstart` | `/docs/quickstart` |
| `/docs/04-core-concepts` | `/docs/core-concepts` |
| `/docs/05-configuration` | `/docs/configuration` |
| `/docs/03-account` | `/docs/account` |

常用真实 docs 路径：`/docs/overview`、`/docs/quickstart`、`/docs/core-concepts`、`/docs/configuration`、`/docs/configuration/model`、`/docs/configuration/skill`、`/docs/configuration/automation`、`/docs/configuration/channel-telegram`（及 whatsapp/discord/qq/wecom/feishu/wechat）、`/docs/faq`、`/docs/faq/using-lightvela-safely`。

**生成任何内部链接前必须核对：**
1. slug 是否存在于 `frontend/next-site/docs-route-manifest.ts` 的 `DOCS_ROUTE_SLUGS`；
2. URL 是否出现在 `frontend/src/lib/seo-data.ts` 的页面级 key 里；
3. 能否在 `frontend/src/app/sitemap.xml/route.next.ts` 的生成路径里对上。

三个对不上的链接，一律不要写。拿不准时优先用上面的“常用真实 docs 路径”，或回退到 `/docs/overview` 这种确定存在的，不要编造。docs 站点基底路径是 `/docs`（见 `frontend/next-site/source.ts` 的 `baseUrl: '/docs'`）；默认站点是 `https://lightvela.ai`（国际站）/ `https://lightvela.com`（国内站）。

### 内链要在正文里分散，不要只堆在文末

内部链接应当**出现在正文自然提及概念的地方**（行内链接），而不是只在结尾聚成一堆或放一个“相关阅读”块。规则：

- 至少 2-3 个内链分布在正文不同 section（开头 / 中段 / 结尾都要有），不是只集中在最后一段。
- 链接要与所在句子的上下文真实相关（讲 skills 时链到 skill 配置页；讲 automations 时链到 automation 配置页）。
- 同一页面的内链不要重复指向（同一个目标链接出现一次即可，除非明显需要）。
- 仍然遵守“不堆塞、每个链接帮读者走下一步”。

### ⚠️ 内链要跟随文章语言，对应到本地化 URL（sitemap 已发多语版本）

LightVela 站点是多语的，sitemap 已经发出每个页面的本地化版本（`en-us` / `zh-cn` / `zh-sg`，带 `hreflang` alternates）。**生成内链时必须跟随文章语言，指向对应语言的 URL**，而不是一律用英文默认 URL。这同时是 GEO / UX 的硬性要求。

URL 结构（已验证，来自 `frontend/next-site/seo.tsx` 的 `localizedDocsPath` / `localizedPublicPath`、`siteUrlForSeoRegion`、`docs-route-manifest.ts` 的 `DOCS_ROUTE_SLUGS`）：

| 文章语言 | docs URL | public 页 URL | 站点 origin |
| --- | --- | --- | --- |
| 英文 / 默认 | `https://lightvela.ai/docs/<slug>` | `https://lightvela.ai/<page>` | 国际站 `lightvela.ai` |
| 中文（国际站，zh-sg） | `https://lightvela.ai/zh-sg/docs/<slug>` | `https://lightvela.ai/zh-sg/<page>` | 国际站 `lightvela.ai` |
| 中文（国内站，zh-cn） | `https://lightvela.com/zh-cn/docs/<slug>` | `https://lightvela.com/zh-cn/<page>` | 国内站 `lightvela.com` |

约定：

- slug 依然必须去掉源文件名的数字前缀（`overview`，不是 `01-overview`），并已在 `DOCS_ROUTE_SLUGS` 里核对存在。
- **中文文章统一用 `zh-sg`（国际站）那条**：`https://lightvela.ai/zh-sg/docs/<slug>`。只有当文章明确面向国内站场景时才用 `https://lightvela.com/zh-cn/...`。
- 同一篇文章里不要中英混链；英文文章用英文默认路径，中文文章用 `zh-sg` 路径，始终成套。
- 同时被两种语言引用的目标（比如 techpedia 同时出 `.zh.md` 和 `.en.md`），两个文件各自链对应语言的版本。

示例：

- 英文文章 → `[quickstart](https://lightvela.ai/docs/quickstart)`
- 中文文章 → `[快速上手](https://lightvela.ai/zh-sg/docs/quickstart)`

拿不准某 slug 在中文站是否提供时，去 `DOCS_ROUTE_SLUGS["zh-sg"]`（或 `"zh-cn"`）里查；该 locale 下没有的 slug，回退到英文默认路径，并在最终回复里说明。

## 输出语言

用户用中文提问时，用中文回复。改英文页面时，页面正文和 metadata 用英文。

## Reference

- `references/seo-geo-rules.md`: LightVela SEO/GEO 具体规则、sitemap 检查、关键词主题簇。
