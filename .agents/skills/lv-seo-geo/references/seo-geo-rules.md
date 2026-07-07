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
