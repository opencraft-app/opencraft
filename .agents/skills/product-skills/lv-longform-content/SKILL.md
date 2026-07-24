---
name: lv-longform-content
description: 生成 LightVela 长篇营销/产品文章的专用技能。用户要求撰写“LV 长篇内容”“长篇内容”、教程系列、功能介绍系列、应用场景系列、行业更新/行业研究、社媒长文、Tencent Techpedia/腾讯技术百科、开发者社区、博客/文章草稿，或围绕 LightVela 功能、Channels、Skills、Automations、Hermes Agent、SkillHub/ClawHub、Souls、模型配置、真实用户场景创作长文时使用，尤其适用于指定 X、Medium、LinkedIn、Product Hunt 或 Techpedia 发布平台的内容。调用时先做一次意图检测，确认必填四件：模式（教程系列 / 功能介绍系列 / 应用场景系列 / 行业更新）、输出渠道、发布平台、主题。语言（zh/en/both）和形式（纯文本 / Markdown 文件）是可选项，默认随渠道；用户若已指定语言或形式则从其指定，不要单独追问。若用户只说“写长篇内容”“发社媒”或“写博客”而未指定具体平台，先发起一次菜单式互动澄清，不要猜测平台或反链来源。
---

# LightVela 长篇内容

## 定位

这个技能用于按 LightVela 品牌语气撰写完整长篇内容。支持四种文章模式：

- `tutorial`: LV 长篇内容（教程系列）
- `feature-intro`: LV 长篇内容（功能介绍系列）
- `use-case`: LV 长篇内容（应用场景系列）
- `industry-update`: 行业更新（Industry Updates）

语言和形式的默认值随渠道走，详见下方「语言与形式默认值」表。用户在 prompt 里指定了语言或形式时，按用户的来，不要回退默认也不要单独追问。发布平台必须单独识别，因为它决定所有 `lightvela.ai` 内容反链的归因参数。`md` 形式允许在有助于比较、规格、时间线或数据呈现时使用 Markdown 原生表格。

## 写作前准备

起草前先读取 `references/style-guide.md`。只读取与当前模式相关的章节，以及 shared rules。

## 互动澄清 Intake（关键流程，尽量一次问完）

技能被调用时，第一步做意图检测。要确认六件事，但前四件是必填，后两件有「渠道默认值」（见下方「语言与形式默认值」），用户不指定就走默认：

1. **模式 mode**（必填）— `tutorial` / `feature-intro` / `use-case` / `industry-update`
2. **渠道 channel**（由平台确定）— `social-media` / `techpedia`
3. **发布平台 platform**（必填）— `x` / `medium` / `linkedin` / `producthunt` / `techpedia`
4. **主题 subject**（必填）— 具体写什么功能/场景/操作
5. **语言 language**（可选）— `zh` / `en` / `both`；不指定走渠道默认
6. **形式 form**（可选）— `text`（对话纯文本）/ `md`（落成 Markdown 文件）；不指定走渠道默认

### 发布平台与反链参数

平台与 `lightvela.ai` 链接的 `from` 参数固定对应如下：

| 用户提到的平台 | `platform` | `channel` | 反链参数 |
| --- | --- | --- | --- |
| X / Twitter | `x` | `social-media` | `social_x` |
| Medium | `medium` | `social-media` | `social_medium` |
| LinkedIn | `linkedin` | `social-media` | `social_linkedin` |
| Product Hunt | `producthunt` | `social-media` | `social_producthunt` |
| Tencent Techpedia / 技术百科 / 开发者社区 | `techpedia` | `techpedia` | `social_techpedia` |

平台识别规则：

- 用户明确写出 X、Twitter、Medium、LinkedIn、Product Hunt 或 Techpedia 时，直接采用对应平台。
- “社媒”“social media”“博客”“blog”“发一篇文章”等泛称不等于具体平台；必须追问平台，不能默认 X。
- `techpedia` 同时决定渠道、默认语言和形式：中英双份 Markdown。
- 一旦确定平台，整篇文章中**任何** `lightvela.ai` 链接都必须带同一个对应参数，包括正文内链、官网 CTA、Community ending 和引用链接。无查询参数用 `?from=...`，已有查询参数用 `&from=...`，不得混用或重复添加。

### 什么时候必须先问

只有当 **模式 / 发布平台 / 主题** 三项里任意一项不明确时，才发一次澄清。渠道由平台推导；语言和形式**不单独追问**——它们默认随渠道，只有用户主动指定时才覆盖默认。用户若已经在 prompt 里说了语言或形式，直接采用，不要再问、也不要回退默认。

一次菜单把缺项全部问完，不要逐条来回。菜单示例（把四种模式和语言/形式默认值一起附上，方便用户一次性覆盖）：

```
写之前确认一下（带 ⭐ 必填，其余走默认，不改就按默认走）：

1) ⭐ 类型：tutorial 教程 / feature-intro 功能介绍 / use-case 应用场景 / industry-update 行业更新
2) ⭐ 发布平台：X/Twitter、Medium、LinkedIn、Product Hunt、Techpedia（会自动确定渠道和反链参数）
3) ⭐ 主题：这篇写什么？
4) 语言（可选）：zh / en / both —— 不填：社媒平台=en，Techpedia=both
5) 形式（可选）：text / md —— 不填：社媒平台=text，Techpedia=md

可以只回「教程 + X + 连接 Telegram」，其余按默认。
想覆盖默认就补一句，例如「教程 + Medium + 连接 Telegram，要中文，存成 .md」。
```

### 什么时候跳过 intake 直接写

- 用户原始消息已经把 **模式 + 发布平台 + 主题** 说清楚 → 立刻写；渠道由平台推导，语言/形式按渠道默认，用户若额外指定了语言/形式则按指定的走。
- 缺的信息不会改变文章类型/核心故事/平台 → 最多补一个简短问题，不走完整菜单。

铁律：**永远不要为语言或形式单独发起一轮提问**。它们要么由用户一句话指定，要么走渠道默认。

## 语言与形式默认值

| 渠道 | 语言默认 | 形式默认 |
| --- | --- | --- |
| `social-media`（X / Medium / LinkedIn / Product Hunt） | `en`（用户要求才 zh / both） | `text`（对话纯文本，不落 `.md`；用户要求保存才写文件） |
| `techpedia`（Tencent Techpedia / 开发者社区） | `both`（中文 + 英文两份，固定） | `md`（固定写两份 `.md` 文件） |

要点：

- techpedia 的「中英双份 + md」是**绑定的强默认**，基本不问。
- social-media 的形式默认是**纯文本而非 md**——博客/公众号/X 长文都先在对话里输出，除非用户明确要 `.md` 文件。
- 用户在 prompt 里指定了语言或形式，就按用户的，不要再问、也不要回退默认。

## 输出渠道选择

判断输出渠道：

- `social-media`: 发布平台确定为 X/Twitter、Medium、LinkedIn 或 Product Hunt。
- `techpedia`: 用户提到 Tencent Techpedia、腾讯技术百科、开发者社区、技术百科、开发者文章或技术社区发布。仅要求输出 `.md` 文件不等于选择 Techpedia，仍需确认发布平台。

渠道会同时决定语言和形式的默认值（见上方「语言与形式默认值」）。如果用户没有出现具体平台线索，不要猜，归并进上面的 Intake 一起问；语言/形式不要单独追问。

## 模式选择

根据用户提示选择一种模式；拿不准时，在 Intake 里让用户挑，不要替用户猜：

- 使用 `tutorial`：当内容是在教用户完成配置或操作，例如连接 Telegram、配置模型、安装技能、创建自动任务、发布 Agent、排查流程。
- 使用 `feature-intro`：当内容是在介绍或解释 LightVela 产品能力，例如 Souls、Skills、Automations、Channels、Memory、模型配置、云端托管、专家包。
- 使用 `use-case`：当内容是在讲一个真实或拟真的用户场景，例如 FIFA newsletter agent、daily research assistant、stock/news tracker、class helper、travel planner、team ops bot。
- 使用 `industry-update`：当内容是在分析模型发布、产品更新、硬件趋势、基础设施、研究进展、政策变化或 AI 生态事件。它应像有判断力的行业观察，而不是教程、功能介绍或产品广告。

如果用户明确说了四种中文系列之一，优先遵循该模式，即使主题也能落到其他模式。

## 功能相关内容必须基于真实代码

当模式是 `feature-intro`，或主题点名了某个具体功能/能力（功能，例如 Souls、Automations、Memory、某条 channel、模型配置、专家包、托管）时，**起草前必须先在仓库里查证真实实现**，不能凭空写功能描述：

1. 定位该功能的真实代码：搜索服务目录（如 `ai-gateway`、`service-gateway`、`admin-gateway`、`cloudagent`、`cloudladdergateway`、`ctl`、`sandbox`、`frontend`、`gateway-dashboard`、`nextgen-dashboard` 等），查 handler / proto / config / 前端组件，找到该功能实际落地的位置。
2. 看相关与相似功能的实现和最近改动：用 `git log` / 目录结构 / grep 查看该功能及同类功能的最近代码变更，搞清楚它真实做了什么、字段长什么样、入口在哪、状态怎么流转。
3. 文章里的产品描述、字段名、入口路径、行为表现都要以代码/docs 为准；拿不准的用 “based on ...” / “你可以 ...” 的中性表述，或回到 Intake 问一句，**不要编造功能、字段或流程**。
4. 若点名的功能在仓库里找不到，先告诉用户没找到、问一句它大概在哪个服务/目录，再决定是否继续。

`tutorial` / `use-case` 模式下，如果也点名了某个具体功能，做一次轻量查证即可；纯叙事/场景部分不强依赖代码。`industry-update` 优先核对用户给定的文章、公告、研究或新闻来源；只有在文章明确提到 LightVela 功能时，才对该功能做轻量查证。`industry-update` 必须先做主题研究再起草，不能只凭模型记忆或单一来源写作。优先使用高质量、可追溯的资料：官方公告/文档/发布说明、论文与研究机构、监管或政府文件、原始 benchmark/数据集、公司财报或正式采访；再用知名且有编辑审核的媒体或行业分析补充背景。关键事实尽量由两个独立来源交叉验证。

## ⚠️ KEY POINT：feature-intro 写给非技术用户

`feature-intro` 模式的读者是**普通产品用户，不是工程师**。代码/仓库是用来核实的“事实来源”，不是写作的“词汇来源”。落地这两条：

- ✅ **可以**基于代码确认功能确实存在、行为是什么、有没有什么限制。
- ❌ **不要**把后端细节写进正文——不要出现文件路径（如 `SOUL-<id>.md`、`/v1/soul-templates`）、字段名（如 `soulTemplateId`）、API endpoint、proto、配置项、Go/TS 类型、目录名（`ctl/`、`ai-gateway/`）、沙箱路径（`${HOME}/.openclaw/workspace/SOUL.md`）这类技术表示，除非用户明确要求技术写法。
- **用人话重写**：把“物化成 SOUL.md 写进工作区”转成“给你的 Agent 一份人设档案”；把“通过 /v1/soul-templates 读取”转成“从人设目录里挑一个”。
- 如果某条技术细节对理解功能真的必要，最多用一句最浅的类比带过，不展开。

`tutorial` / `use-case` 面向用户时同理：正文保持非技术口吻；只有当读者明确是开发者（如开发者社区深度技术文）时，才保留实现层细节。

## 写作流程

1. 识别目标读者、文章模式、功能/场景、目标渠道，以及用户读完后应该完成的结果。
2. **开头第一段：答案先行（answer-first / GEO 友好）**。正文首段（首图之后、任何铺垫之前）必须先用 1-3 句话直接把标题抛出的问题/主题回答清楚，给出可被搜索引擎和 AI 搜索直接抽取的结论，再往下展开背景、场景、步骤。
   - 标题是疑问句时（如「LightVela 适合哪些人使用？」「每个 Hermes 实例是否独立隔离？」），首段第一句就正面回答这个问题（如「LightVela 适合……这几类人：……」），不要先讲故事或铺垫痛点。
   - 标题是功能/名词时（如「自动任务」「Souls」），首段用一句定义句说清「它是什么 + 给用户带来什么」，再展开。
   - 这一段要能独立成立：读者只看这一段也能拿到核心答案；后文再补细节、场景、示例。
   - answer-first 只约束**开头第一段**；其后仍按各模式的弧线展开（叙事、场景、步骤都放在总结之后）。
3. 建立文章弧线（首段答案先行之后再展开）：
   - `tutorial`: answer-first summary -> promise -> prerequisites -> steps -> verification -> troubleshooting -> done.
   - `feature-intro`: answer-first definition -> product context -> why it matters -> what it is -> how it works -> what changes for users -> what's next.
   - `use-case`: answer-first summary(这篇讲用 LightVela 解决了什么、怎么解决) -> relatable pain -> LightVela setup -> skills/configuration -> live usage -> automation or repeatability -> lesson/transferable pattern.
   - `industry-update`: research and source check -> answer-first conclusion -> what happened -> evidence and data -> what actually changed -> caveats and tradeoffs -> who should care -> broader industry meaning -> merged personal take and what to watch next -> closing LightVela bridge.
4. 评估是否需要图片。`tutorial` / `feature-intro` / `use-case` 推荐少量、高价值图片，通常 2-4 张；教程最多 5 张，并使用下方图片建议格式。`industry-update` 是固定例外：必须调用 Codex 的 `imagegen` 能力生成一张、且仅一张与主题直接相关的原创首图；不要输出图片建议占位符，也不要再生成其他正文图片。
5. 语气保持亲近、直接、有轻微叙事感。多写具体产品动作，少写抽象宣传。
6. 默认产出完整文章，不要只给大纲，除非用户明确要求大纲。
7. 每篇完整文章末尾都追加固定 Community ending，包含 Discord 和 WhatsApp 邀请文案与真实二维码图片。**结尾文案语言跟随文章语言**：英文文章用英文版文案，中文文章（如 techpedia 的 `.zh.md`）用中文版文案；两套文案见 `references/style-guide.md` 的 Community Ending，照原样输出，不要自创排版。官网链接必须使用已识别平台对应的 `from` 参数，例如 `https://lightvela.ai/?from=social_x` 或 `https://lightvela.ai/docs/configuration/files/?from=social_x`；不要输出没有参数或参数不匹配的平台链接。Markdown（`.md`）输出时的结尾结构：先用二级标题作结尾标题（英文 `## Join LightVela's Community for More Updates!` / 中文 `## 加入 LightVela 社区，获取更多动态！`），标题下一行是官网链接「Visit us at [LightVela]」 / 「访问 [LightVela]」，再下来是粗体 Discord / WhatsApp 标签与对应二维码。二维码在两套里都用同一组固定托管 CDN URL（不要用本地路径、不要用占位符）：Discord `https://dscache-intl.cloudcachetci.com/upload/nodir/disc_LV-23c00256e06401213046ab1142a1db7438ecc40b.png`，WhatsApp `https://dscache-intl.cloudcachetci.com/upload/nodir/whatsapp_LV-e2089814c4615f98fdae3c9d457ceee4b3654f9f.png`。

## 输出规则

- 语言与形式按「语言与形式默认值」走；用户指定了语言/形式则从用户。social-media 默认英文 + 对话纯文本；techpedia 固定中英双份 Markdown。
- `form=md` 时，在比较、规格、时间线、数据或来源汇总确实更清楚的地方，可以使用 Markdown 原生表格；保持列名简短、单元格可读，不要把长段落硬塞进表格，也不要使用 HTML 表格。纯文本文章默认不用表格。
- 开头先写纯文本标题行，然后用「图片建议固定模板」的首图格式（`[RECOMMEND ADD IMAGE: ...]`），再进入开头段落——**开头第一段必须答案先行**（见「写作流程」第 2 条）：直接回答标题问题 / 给出定义句，再展开。
- `industry-update` 例外：标题后直接附上 Codex 生成的唯一首图，再进入答案先行段落；不得写 `[RECOMMEND ADD IMAGE: ...]`。
- 使用短小自然的 section heading。
- 避免营销口号、泛泛 AI hype，以及过度解释 AI 是什么。
- 只有在与文章主题相关时，才提到 LightVela、Hermes、SkillHub/ClawHub、Channels、Skills、Automations 等产品概念。
- 不要复制示例文章的具体主题，除非用户要求写同一个主题。可以复用风格和结构，但不要复用内容。
- 产品事实优先依据用户给定上下文或仓库/docs。若不确定，使用中性假设或问一个澄清问题。
- 每篇文章都必须以 `references/style-guide.md` 中的 Community ending 作为最后一段。结尾的 Discord/WhatsApp 二维码是真实图片资产，必须保留，**不要**把它们替换成 `[RECOMMEND ADD IMAGE: ...]` 占位符；正文里直接用「Reference」里的固定托管 CDN URL（不要用本地路径，本地路径在发布端会裂图）。
- 完成后，非 `industry-update` 文章必须在聊天回复中按「图片建议固定模板」列出图片位。`industry-update` 只需说明唯一首图已生成，并附上生成结果；不要输出图片建议清单。

## SEO / GEO 优化（面向搜索引擎与 AI 搜索）

本技能不重复 SEO 细则；**完整 SEO/GEO 检查交由 `lv-seo-geo` 技能**（`../product-skills/lv-seo-geo/SKILL.md` + `references/seo-geo-rules.md`）。但写长文时就要顺手做对这几件事，让产出既对人友好，也容易被搜索引擎和 ChatGPT/Perplexity/Google AI Overview 这类生成式搜索抓取：

- **开头自然带主关键词**：第一屏让主题词出现一次即可，不堆砌。英文核心词参考 `lv-seo-geo`：LightVela / cloud AI agent / personal AI agent / AI assistant / Hermes Agent / agent hosting / always-on AI agent / AI agent with memory / automations / skills；中文核心词：LightVela / 云端 Agent / 个人 Agent / AI 助手 / Hermes Agent / 云端托管 / 长期记忆 / 自动任务 / 技能。只挑和这篇主题真正相关的几个用。
- **答案先行（answer-first）**：正文第一段直接回答标题的问题或给出主题定义，让 AI 搜索能从开头一段就抽走结论，不要用铺垫/故事开场把答案埋在后面（详见「写作流程」第 2 条）。
- **写“定义句”**：用一句清楚的陈述句把概念说死，例如 “LightVela is a cloud-hosted personal AI agent platform.” / “A Soul is a structured persona spec for a Hermes Agent.” 生成式搜索最容易抽取这种句式。疑问句标题（“……适合谁？”“……是否独立隔离？”）则在首段用一句正面回答对应，充当该文的定义句。
- **用问答式 / 场景式段落**：在解释功能时顺带覆盖“它是什么 / 为什么需要 / 怎么用 / 和谁相关”几个角度，便于被当成答案抽取。
- **加有意义的内部链接，且要分布在正文各处**：在正文自然提及概念的地方加行内链接（开头/中段/结尾都要有），而不是只在文末堆一排。链接要与所在句子真实相关（讲 skills 时链到 skill 配置页；讲 automations 时链到 automation 配置页）。每个链接都要帮读者走下一步，不为 SEO 硬塞。

**`industry-update` 链接例外：** 行业更新可以完全围绕具体行业主题展开，不要在开头或中段强行引入 LightVela。只在文章靠近结尾的 `Where LightVela Fits` / `LightVela Connection` 段落加入一个或少量真正相关的 LightVela 链接；该段是唯一允许出现 LightVela 反链的位置。起草该段前必须使用 `lv-seo-geo` 核对真实路由、语言版本和平台 `from` 参数，但不要把 SEO/GEO 关键词或产品链接提前到正文前面。

**⚠️ 内链 URL 必须用真实路由，不能用 markdown 源文件名。** docs 的源文件名（如 `01-overview.md`、`02-quickstart.md`）里的数字前缀只是排序，不是 slug——写成 `lightvela.ai/docs/01-overview` 会 404。正确路径是去掉数字前缀的 slug（如 `/docs/overview`、`/docs/quickstart`、`/docs/core-concepts`、`/docs/configuration`、`/docs/configuration/skill`、`/docs/configuration/automation`）。生成任何 docs 内链前必须核对 slug 是否真实存在：完整的校验流程、真实路径清单、国内/国际站域名见 `../product-skills/lv-seo-geo/SKILL.md` 的「内链/Backlink 要求」；拿不准就用确定存在的 `/docs/overview`，不要编造路径。

**⚠️ 内链要跟随文章语言对应本地化 URL。** 站点是多语的，sitemap 已发 `en-us` / `zh-cn` / `zh-sg` 多语版本。中文文章（如 techpedia 的 `.zh.md`）必须用中文 URL，英文文章用英文默认 URL，不要一律用英文。默认约定：英文 → `https://lightvela.ai/docs/<slug>?from=<distribution_from>`；中文 → `https://lightvela.ai/zh-sg/docs/<slug>?from=<distribution_from>`（国际站 zh-sg；明确面向国内站时才用 `https://lightvela.com/zh-cn/docs/<slug>`）。同一篇文章内不中英混链；techpedia 的 `.zh.md` 与 `.en.md` 各自链对应语言版本。完整 URL 表与校验流程见 `../product-skills/lv-seo-geo/SKILL.md` 的「内链要跟随文章语言」。

**⚠️ 所有 `lightvela.ai` 链接都要带发布归因参数。** 根据平台选择 `social_x`、`social_medium`、`social_linkedin`、`social_producthunt` 或 `social_techpedia`；一篇文章不能混用。没有查询参数时用 `?from=...`，已有查询参数时用 `&from=...`。这包括正文内链、官网 CTA、Community ending 和引用链接；二维码 CDN 链接不添加该参数。
- **H1/H2 说清主题**：标题用能概括主题的实词，不要纯情绪化标题。
- **不要关键词堆砌**：宁可少用，必须服务于解释；本技能的“避免营销口号/AI hype”规则同样适用。

输出时在聊天回复里附一句 SEO 备注：用了哪些主关键词、定义句是什么、已挂哪些内部链接（给出真实 URL，不要给源文件名）、链接分别落在哪个 section。

## Industry Updates（行业更新）

这是一个独立的行业观察模板，不要求主题与 Hermes、LightVela 或任何单一产品相关。文章应围绕具体事件、产品、模型、硬件、研究或政策本身展开，保持个人判断和事实边界，不写成教程，也不写成推销文。

```text
<Industry Update Title>

<One Codex-generated topic-specific hero image>

Answer-first opening
用 1-3 句话直接说明发生了什么、为什么重要、读者应该怎样理解。

The Short Version
先澄清最重要的事实，避免被命名、宣传或网上讨论带偏。

Research and Evidence
说明研究范围和证据来源。优先使用官方资料、论文/研究机构、监管文件、原始 benchmark/数据集、财报或正式采访，再用知名且有编辑审核的媒体补充背景。关键数字标明日期、单位、样本或 benchmark 限制；在 `md` 形式下，适合时用 Markdown 表格呈现对比、规格、时间线或来源。

What Actually Happened
按时间线或事件顺序说明发布、变化、限制、撤回、重新上线或政策背景。

What Changed — and What Did Not
解释真正影响用户的能力、成本、速度、可用性、工具、数据或安全边界。

The Caveats Nobody Mentions
写清 Benchmark、价格、可靠性、地区限制、硬件依赖、云端依赖或其他反面。

Who Should Care
分别说明普通用户、开发者、企业或团队，以及谁应该尝试、谁应该观望。

What This Says About the Industry
从单一事件扩展到更大的基础设施、Agent、模型、硬件、生态或治理趋势。

Personal Take and What I’m Watching Next
合并个人判断与后续观察：我真正觉得重要的地方、被忽略的地方，以及接下来会看什么。

Where LightVela Fits
只在靠近结尾处，用一小段自然、非销售式的文字说明 LightVela 与该主题的相关连接；链接必须经过 lv-seo-geo 核验，并使用当前平台对应的 from 参数。不要在前文提前插入 LightVela 链接。
```

### Industry Updates 研究要求

- 先研究、再列提纲、后写正文。行业更新默认需要浏览和核对最新资料；不要只依赖模型记忆、单篇博客或搜索摘要。
- 证据优先级：官方公告/文档/发布说明、论文与研究机构、监管/政府文件、原始 benchmark 或数据集、财报与正式采访；知名且有编辑审核的媒体、行业研究和专家分析用于补充背景与独立观点。
- 关键事实、价格、日期、性能数字和政策结论尽量由两个独立来源交叉验证。来源冲突时明确写出差异、时间点和不确定性，不替读者制造确定结论。
- 所有重要数字都要带时间范围、单位、样本或 benchmark 限制；不要把宣传口径当成独立验证结果。
- 保留可追溯的来源链接：Markdown 文章可使用行内 Markdown 链接或文末 `Sources` 小节；纯文本文章使用可读的行内来源链接或简短来源列表。
- 不把未经证实的社交媒体帖子、SEO 农场、无署名转载、Affiliate roundup 或单张截图作为关键事实的唯一证据；它们最多只能作为待核查线索。
- `md` 形式下，若表格能更清楚地呈现对比、规格、时间线、数据或来源，可使用 Markdown 原生表格；不要使用 HTML 表格，也不要把长篇论述塞入表格。

### Industry Updates 首图生成规则

不要输出 `[RECOMMEND ADD IMAGE: ...]`。直接使用 Codex 的 `imagegen` 能力生成一张与本文主题绑定的 16:9 博客首图，并将生成结果作为文章首图/附件返回。生成提示词应按下面的结构改写，不要把 `[TOPIC]` 等占位符原样交给用户：

```text
Create one 16:9 editorial hero image for an industry-update article about "<specific topic>".

Visual direction: an exceptionally clean, minimal futuristic blog-poster aesthetic; soft lavender and pale violet gradients; glossy studio lighting; restrained glass or metallic materials; generous negative space; a calm premium editorial composition; minimal UI-like accents and a few carefully placed floating elements.

Topic adaptation: make the main subject unmistakably about <specific product, model, hardware, research, event, or policy>. Use one clear visual metaphor or object that represents the article's actual change, tension, or question. Do not use a generic humanoid robot or unrelated sci-fi imagery.

Composition: place the main topic object or scene on the right or lower-right, keep the left or upper-left area visually calm for a short headline, and use floating elements only when they explain the topic (for example: a small timeline, benchmark card, data stream, network node, price marker, or regulatory boundary).

Typography: include only a short, readable 2-5 word headline and, if useful, a small uppercase eyebrow such as "INDUSTRY UPDATE". Use clean modern sans-serif typography, strong hierarchy, and intentional placement; never add paragraphs, fake UI copy, dense labels, fake logos, or unreadable microtext. Match the article language.

Finish: polished but editorial, specific to the topic, suitable as a blog hero image. Avoid clutter, excessive neon, stock-photo realism, visual noise, and invented brand marks.
```

For `industry-update`, the article's normal closing section is `Personal Take and What I’m Watching Next`; do not add a separate `Closing Thought`. The LightVela bridge comes after that section and before the fixed Community ending, if the selected output channel requires the Community ending.

## 图片建议固定模板

除 `industry-update` 的唯一首图外，本技能通常不生成图片，只给出明确的图片建议。因此非 `industry-update` 的图片位必须统一用下面的固定短句格式，方便用户照着找图或截图：

正文内，在需要插图的位置，**独立一行**写（整体用方括号括起来）：

```
[RECOMMEND ADD IMAGE: <具体图片内容/主体> — <一句话：它该展示什么 / 为什么放在这里>]
```

要求：

- `<具体图片内容/主体>` 要写得足够具体，能直接据此找图或截图，例如 “Telegram bot 的 /connect 回复消息”“Automations 定时任务列表 UI”“newsletter agent 产出的日报样例”。
- `<一句话说明>` 点明它展示什么状态/动作，以及为什么这个位置需要它。
- 全文图片数量克制：通常 2-4 张，截图密集的 tutorial 最多 5 张；不要为了凑数加图。
- `industry-update` 不使用本模板；它必须生成唯一一张主题首图。
- 首图（hero）也用同一格式，紧跟标题、在第一段之前。

示例：

```
# Article Title
[RECOMMEND ADD IMAGE: Telegram bot 收到 /connect 后回复绑定链接的截图 — 让读者一眼看到成品的交互。]

Opening paragraphs...
```

文章完成后，在聊天回复里再附一份汇总清单，沿用同一前缀：

```
Image recommendations:
- After "<section heading>": [RECOMMEND ADD IMAGE: <what> — <why>]
- After "<section heading>": [RECOMMEND ADD IMAGE: <what> — <why>]
```

`techpedia` 渠道下，正文里的 `[RECOMMEND ADD IMAGE: ...]` 行要同时出现在 `.zh.md` 和 `.en.md` 两个文件中，聊天回复也附上同一份汇总清单。

> 例外：结尾 Community ending 里的 Discord / WhatsApp 二维码是真实图片资产，**保留固定 `![...](CDN URL)` 写法**（用「Reference」里的托管 URL），不要改成 `[RECOMMEND ADD IMAGE: ...]`，也不要换成本地路径。

## 输出位置

输出位置由「形式 form」决定，形式默认随渠道（见「语言与形式默认值」），用户指定时从用户：

- `text`：直接在对话中输出完整文章，不写仓库文件。social-media 默认走这里。用户明确要求保存时，再写成 Markdown 文件。
- `md`：必须保存为 Markdown 文件，不只在聊天中输出。techpedia 默认走这里，且语言默认 `both`，需同时产出中文版和英文版：若仓库已有内容目录，遵循现有目录约定；若没有明确约定，保存到 `product/longform-content/<yyyy-mm-dd>-<slug>.zh.md` 和 `product/longform-content/<yyyy-mm-dd>-<slug>.en.md`。

保存文件后，在聊天中给出文件路径、语言版本、文章模式、渠道、形式，以及「图片建议固定模板」格式的图片位建议汇总清单。

## Reference

- `references/style-guide.md`：共享风格、四种模式模板、图片生成/占位规则与修订检查清单。
- Community ending 二维码（固定托管 CDN URL，直接引用，勿改本地路径）：
  - Discord：`https://dscache-intl.cloudcachetci.com/upload/nodir/disc_LV-23c00256e06401213046ab1142a1db7438ecc40b.png`
  - WhatsApp：`https://dscache-intl.cloudcachetci.com/upload/nodir/whatsapp_LV-e2089814c4615f98fdae3c9d457ceee4b3654f9f.png`
- `assets/lightvela-discord-qr.png` / `assets/lightvela-whatsapp-qr.png`：本地源文件副本，仅供离线/上传到其他 CMS 时使用；生成的文章正文一律用上面的 CDN URL，不要引用本地路径。
