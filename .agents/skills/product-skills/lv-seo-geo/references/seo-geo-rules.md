# LightVela SEO/GEO Rules

## 代码事实

SEO 数据主要在：

```text
frontend/src/lib/seo-data.ts
frontend/next-site/seo.tsx
frontend/src/app/sitemap.xml/route.next.ts
frontend/next-site/docs-route-manifest.ts
frontend/src/config/docs-sidebar.ts
```

已知机制：

- `seo-data.ts` 维护运行时/测试侧 SEO title、description、keywords。
- `PAGE_DESCRIPTIONS_BY_REGION` 为页面级 description 覆盖；未命中时回退全站默认。
- `DOC_PAGE_TITLES_BY_REGION` 维护 docs 页面 title 映射。
- `frontend/next-site/seo.tsx` 维护 Next metadata、keywords、alternates、JSON-LD、站点 URL。
- `sitemap.xml` 由 `DOCS_ROUTE_SLUGS`、public paths、SEO locale 常量生成，不是手写 XML。
- `docs-route-manifest.ts` 是 docs sitemap 与路由静态参数的关键来源。
- `docs-sidebar.ts` 控制 docs 菜单和 slug -> markdown 文件映射。

## Sitemap 一致性检查

当 URL、slug、导航或页面文件变化时，必须检查：

1. 页面是否真实存在。
2. 页面是否应该被索引。
3. sitemap 是否包含该页面。
4. sitemap 中是否还保留已经删除/改名的旧页面。
5. canonical/hreflang alternates 是否与实际可访问 URL 一致。

Docs 页重点对齐：

```text
GLOBAL_SIDEBAR / CN_SIDEBAR
GLOBAL_SLUG_TO_FILE / CN_SLUG_TO_FILE
DOCS_ROUTE_SLUGS
PAGE_DESCRIPTIONS_BY_REGION
DOC_PAGE_TITLES_BY_REGION
```

如果发现 discrepancy，在最终回复中明确写：

```text
发现 sitemap/路由不一致：<路径> 当前 <现象>，建议同步 <文件/常量>。
```

不要只改文档正文后忽略 sitemap 风险。

## SEO 页面内容检查

每个可索引页面尽量满足：

- H1 或首屏标题明确包含页面主实体或主题。
- 开头 1-2 段自然说明页面解决什么问题。
- title 与 description 覆盖页面真实内容。
- description 约 140-180 英文字符或 80-140 中文字为佳，不要堆砌关键词。
- 页面内有 2-5 个自然内部链接，指向相关下一步。
- 图片 alt 或周边正文能解释图片用途，尤其是 docs/tutorial 页面。
- 页面内容不要和其他页面大段重复。

## GEO 页面内容检查

GEO 目标：让生成式搜索能准确回答“LightVela 是什么、适合谁、怎么用、和传统 AI chat / VPS / bot hosting 有什么不同”。

优先添加这些类型的句子：

- 定义句：`LightVela is ...`
- 关系句：`Hermes Agent is the cloud-hosted agent runtime inside LightVela.`
- 对比句：`Unlike a normal chatbot, LightVela keeps Hermes online and connected to messaging channels.`
- 场景句：`You can use it as a Telegram AI assistant for reminders, daily summaries, and skill-powered workflows.`
- 下一步句：`To start, configure a model, connect a channel, then install skills or automations.`

GEO 友好结构：

```markdown
## What is <topic>?
Direct answer in 2-4 sentences.

## How it works in LightVela
Explain model/channel/skill/automation/runtime relationship.

## When to use it
Concrete scenarios.

## Related setup
Internal links to docs or guides.
```

## 关键词主题簇

### AI Agent / Personal Agent

Use when explaining product positioning, overview, core concepts, landing pages.

English:

- cloud AI agent
- personal AI agent
- AI assistant
- AI companion
- always-on AI agent
- AI agent with memory
- agent hosting
- cloud-hosted agent

Chinese:

- 云端 Agent
- 个人 Agent
- AI 助手
- AI 伙伴
- 长期在线智能体
- 带记忆的 AI Agent
- Agent 托管

### Hermes Agent

Use when explaining the product runtime.

English:

- Hermes Agent
- Hermes instance
- cloud-hosted Hermes Agent
- Hermes runtime
- dedicated agent environment
- long-term memory

Chinese:

- Hermes Agent
- Hermes 实例
- 云端 Hermes
- Hermes 运行环境
- 专属运行环境
- 长期记忆

### Easy Cloud / VPS / Hosting

Use when comparing LightVela to self-hosting, cloud servers, deployment pain.

English:

- easy cloud
- easy VPS
- cloud runtime
- managed agent hosting
- no local deployment
- 24/7 online agent
- hosted AI agent

Chinese:

- 轻量云
- 简单云服务器
- 云端运行环境
- 托管 Agent
- 免本地部署
- 7x24 小时在线

### Channels / Bots

Use for Telegram, WhatsApp, Discord, WeChat, Lark, QQ, WeCom docs.

English:

- Telegram AI bot
- WhatsApp AI assistant
- Discord AI bot
- WeChat agent
- messaging channel
- AI assistant in chat

Chinese:

- Telegram 机器人
- WhatsApp AI 助手
- Discord 机器人
- 微信 Agent
- 聊天通道
- 对话入口

### Skills / Automations

Use for SkillHub/ClawHub and scheduled task pages.

English:

- AI agent skills
- SkillHub skills
- AI automations
- scheduled AI tasks
- daily report agent
- recurring reminders

Chinese:

- AI Agent 技能
- SkillHub 技能
- 自动任务
- 定时任务
- 日报助手
- 定时提醒

## 内链建议

常见内链目标：

- Overview: `/docs/overview`
- Quickstart: `/docs/quickstart`
- Core Concepts: `/docs/core-concepts`
- Model setup: `/docs/configuration/model`
- Channel setup: `/docs/configuration/channel-telegram`, `/channel-whatsapp`, `/channel-discord`, `/channel-wechat`
- Skills: `/docs/configuration/skill`
- Automations: `/docs/configuration/automation`
- Chat/memory: `/docs/configuration/agent-chat`
- Safety: `/docs/faq/using-lightvela-safely`

长篇内容或营销页可自然加入：

- “Start with the Quickstart guide”
- “Learn how Hermes, models, channels, and skills work together”
- “Connect Telegram/WhatsApp/Discord”
- “Install skills”
- “Set up automations”

### ⚠️ 用真实路由，不要用 markdown 源文件名

最常见的内链错误：把 docs 的 markdown 源文件名直接当成 URL。源文件名形如 `01-overview.md`、`02-quickstart.md`、`04-core-concepts.md`，其中的 `01-` / `02-` / `04-` 数字前缀**只是为了排序，不是路由 slug**。写成 `https://lightvela.ai/docs/01-overview` 一定是 404。

错误 → 正确对照：

| 错误（源文件名） | 正确（真实 URL） |
| --- | --- |
| `/docs/01-overview` | `/docs/overview` |
| `/docs/02-quickstart` | `/docs/quickstart` |
| `/docs/03-account` | `/docs/account` |
| `/docs/04-core-concepts` | `/docs/core-concepts` |
| `/docs/05-configuration` | `/docs/configuration` |
| `/docs/07-faq` | `/docs/faq` |

**生成任何 docs 内链前，必须核对 slug 真实存在：**

1. slug 出现在 `frontend/next-site/docs-route-manifest.ts` 的 `DOCS_ROUTE_SLUGS`（注意按 locale 分组：`en-us` / `zh-cn` / `zh-sg`）；
2. URL path 出现在 `frontend/src/lib/seo-data.ts` 的页面级 key（如 `"/docs/overview"`）；
3. 能在 `frontend/src/app/sitemap.xml/route.next.ts` 的生成路径里对上（sitemap 由 `DOCS_ROUTE_SLUGS` + public paths 生成，不是手写）。

三项任一对不上就不要写该链接。拿不准时优先用上方「常见内链目标」里确定存在的路径，或回退到 `/docs/overview`，**绝不编造路径**。

补充事实：docs 站点基底路径是 `/docs`（`frontend/next-site/source.ts` 的 `baseUrl: '/docs'`）；默认站点 origin 是 `https://lightvela.ai`（国际站）/ `https://lightvela.com`（国内站），见 `frontend/next-site/seo.tsx` 的 `siteUrlForSeoRegion`。

### 内链要在正文里分散，不要只堆在文末

内部链接应当**出现在正文自然提及概念的地方**（行内链接），而不是只在结尾聚成一堆或放一个“相关阅读”块。

- 至少 2-3 个内链分布在正文不同 section（开头 / 中段 / 结尾都要有），不是只集中在最后一段。
- 链接要与所在句子的上下文真实相关（讲 skills 时链到 skill 配置页；讲 automations 时链到 automation 配置页）。
- 同一目标的链接在同一页出现一次即可，除非明显需要重复。
- 仍遵守“不堆塞、每个链接帮读者走下一步”。

这条规则同样适用于 `lv-longform-content` 产出的长篇内容：不要把全部内链扔进结尾段，要在正文各 section 自然散布。

### ⚠️ 内链要跟随文章语言，对应到本地化 URL

LightVela 站点是多语的，sitemap 已经发出每个页面的本地化版本（`en-us` / `zh-cn` / `zh-sg`，带 `hreflang` alternates，见 `frontend/src/app/sitemap.xml/route.next.ts` 用 `buildDocsAlternates` / `buildPublicAlternates` 生成）。**生成内链时必须跟随文章语言，指向对应语言的 URL**，而不是一律用英文默认 URL。

URL 结构（已验证，来自 `frontend/next-site/seo.tsx` 的 `localizedDocsPath` / `localizedPublicPath`、`siteUrlForSeoRegion`、`frontend/next-site/docs-route-manifest.ts` 的 `DOCS_ROUTE_SLUGS`）：

| 文章语言 | docs URL | public 页 URL | 站点 origin |
| --- | --- | --- | --- |
| 英文 / 默认 | `https://lightvela.ai/docs/<slug>` | `https://lightvela.ai/<page>` | 国际站 `lightvela.ai` |
| 中文（国际站，zh-sg） | `https://lightvela.ai/zh-sg/docs/<slug>` | `https://lightvela.ai/zh-sg/<page>` | 国际站 `lightvela.ai` |
| 中文（国内站，zh-cn） | `https://lightvela.com/zh-cn/docs/<slug>` | `https://lightvela.com/zh-cn/<page>` | 国内站 `lightvela.com` |

约定：

- slug 必须去掉源文件名的数字前缀（`overview`，不是 `01-overview`），并在 `DOCS_ROUTE_SLUGS` 里核对存在。
- **中文文章统一用 `zh-sg`（国际站）那条**：`https://lightvela.ai/zh-sg/docs/<slug>`。只有当文章明确面向国内站场景时才用 `https://lightvela.com/zh-cn/...`。
- 同一篇文章里不要中英混链：英文文章用英文默认路径，中文文章用 `zh-sg` 路径，始终成套。
- 同时被两种语言引用的目标（例如 techpedia 同时出 `.zh.md` 和 `.en.md`），两个文件各自链对应语言的版本。

示例：

- 英文文章 → `[quickstart](https://lightvela.ai/docs/quickstart)`
- 中文文章 → `[快速上手](https://lightvela.ai/zh-sg/docs/quickstart)`

拿不准某 slug 在中文站是否提供时，去 `DOCS_ROUTE_SLUGS["zh-sg"]`（或 `"zh-cn"`）里查；该 locale 下没有的 slug，回退到英文默认路径，并在最终回复里说明。

## 修改 SEO 数据时的测试提示

若修改这些文件，优先运行相关测试或至少指出未运行：

- `frontend/src/lib/seo-data.ts`
- `frontend/next-site/seo.tsx`
- `frontend/src/app/sitemap.xml/route.next.ts`
- `frontend/next-site/docs-route-manifest.ts`
- `frontend/src/config/docs-sidebar.ts`

常见验证：

```bash
cd frontend && pnpm test -- seo
cd frontend && pnpm check
```

如果只是给文章正文加自然内链和关键词，不一定需要跑完整类型检查，但最终回复要说明验证范围。
