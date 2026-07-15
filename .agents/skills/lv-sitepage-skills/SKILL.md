---
name: lv-sitepage-skills
description: 维护 LightVela 国内站和国际站 Agent Skills 页面时使用，包括 Skills/Discover、Experts、Featured 精选、搜索结果、来源筛选、Installed、Create Skill、技能安装/卸载、分页滑轨、Featured 横幅和中英文 i18n。用户提出任何关于任一站点 Skills 页面或技能列表的新增、删除、编辑、重排、搜索逻辑、视觉调整或运营配置需求时，必须先调用此 Skill。
---

# LightVela Skills 页面维护

## 总则

先读取当前实现，再修改 `frontend/src/pages/marketing/skills-demo/SkillsDemoPanel.tsx` 及必要的 i18n 和资源文件。国内站和国际站共用页面布局、卡片、弹窗、分页和 Create Skill 逻辑，但数据源和安装命令不同：国际站使用 ClawHub/skills.sh，国内站使用 `https://api.skillhub.cn/api/skills` 和 `acli skills`。不要把国际站 registry 命令发到国内实例，也不要把国内 SkillHub 数据契约套到国际站。页面的 Featured 运营数据是前端手工配置，不要臆造不存在的技能 ID 或安装数。

维护完成后运行 `cd frontend && pnpm i18n:check && pnpm check`，涉及 registry 命令时运行对应的技能测试。新增中文界面文案后先运行 `pnpm i18n:extract`，补齐 `en-US.json`，再运行 i18n 校验。

## 触发后的需求收集

每次因用户提出 Skills 页面新增或编辑需求而触发本 Skill 时，先确认目标站点，再收集维护类型；不要在站点范围不明确时直接改代码。

### 站点范围确认（必须先做）

如果用户没有明确提到“国内站 / `lightvela.com`”或“国际站 / `lightvela.ai`”，先只询问：

> 你要修改哪个 Skills 页面？
> 1. 国内站（`lightvela.com`）
> 2. 国际站（`lightvela.ai`）
> 3. 两个站点都修改

用户明确选择后，后续所有技能来源、接口、安装命令、文案和 i18n 都按该站点处理。若用户选择两个站点，分别核对两套数据源和语言要求；不要默认把一个站点的技能 ID、接口或安装命令复制到另一个站点。

站点已由用户明确说明时，不重复询问，直接进入下面的维护类型选择：

1. **Category / 分类**（新增或编辑名称、中文名、布局、主题）
2. **Edit Category Skills / 编辑分类技能**（新增、删除、移动排序）
3. **New Featured Skills / 新增精选技能**
4. **Edit Featured Skills / 编辑精选技能**（新增、删除、移动排序）
5. **Other Skills Page Change / 其他 Skills 页面改动**（搜索、My Skills、Create Skill、安装、弹窗或视觉）

只根据用户选择追问对应信息。国际站具体技能必须要求完整 skills.sh 页面链接；国内站具体技能必须要求 SkillHub 搜索结果中的完整 slug 或 SkillHub 页面链接，不能只凭展示名称猜测。若用户给的是链接，解析并保存对应的完整技能身份。

### Category / 分类

- 操作类型：新增或编辑。
- 新增时提供英文分类名和中文分类名；编辑时提供要修改的现有分类名。
- 国际站每张卡片要求 skills.sh 页面链接；国内站每张卡片要求 SkillHub 搜索结果中的完整 slug 或 SkillHub 页面链接。
- 可选：显示名称、用途、布局数量、顺序、颜色主题或详情说明；未提供时由 AI 根据 skills.sh 页面/README 和当前样式补齐。
- 默认保持每类 6 张、桌面端 2 列 × 3 行；如需调整，确认目标数量和展示顺序。

国际站分类仍由前端手工配置；国内站 Discover 分类也由前端手工配置，唯一真源为 `frontend/src/pages/marketing/skills-demo/domestic-skill-catalog.ts`。国内站当前固定为 `理财分析`、`内容创建`、`常用工具` 三类，每类 6 张 SkillHub 技能，顺序不按热门接口运行时重排。不能仅根据展示名称猜 slug，也不能把国际站 skills.sh ID 复制到国内安装命令。

分类名称、布局或主题修改不等于修改分类内技能；如果要增删或移动具体技能，使用 **Edit Category Skills / 编辑分类技能**。

### Edit Category Skills / 编辑分类技能

- 要编辑的分类名称。
- 操作类型：新增、删除或移动排序；可以一次组合多种操作。
- 每个新增或替换技能的完整 skills.sh 或 SkillHub 页面链接；删除或移动现有技能也要提供技能链接或现有完整 ID，避免同名技能误操作。
- 可选：新增技能的显示名称和用途；未提供时由 AI 根据该技能页面/README 补齐。
- 修改后的完整展示顺序；默认保持每类 6 张、桌面端 2 列 × 3 行。

固定分类技能不能只根据搜索词自动补位；新增或替换后，重新读取该技能自己的页面/README，生成或更新完整详情模板，并更新单元测试。

### New Featured Skills / 新增精选技能

- 推荐一次新增 3 张以保持当前每页 3 张的视觉节奏，但必须支持用户一次新增 1–2 张或其他数量；不要为了凑满 3 张而虚构技能或占位卡。
- 每张技能的完整 skills.sh 或 SkillHub 页面链接；可先在对应站点 Skills 页面搜索该技能，再复制完整链接或完整 slug，不能只凭展示名称猜测 ID。
- 每张卡的标题、副标题和简短描述可由 AI 参考当前 Featured 卡片格式自动生成，也支持用户手动提供或覆盖。
- 展示顺序可由用户指定；默认将新增卡片追加到 Featured 列表末尾。
- 可选的主题色或视觉方向；未提供时由 AI 根据技能用途自动设计。当前 Featured 横幅由 AI 单独生成，每张卡使用独立的主题图。
- 可选：名称、标题、副标题、描述、顺序、主题色或背景图；未提供时由 AI 根据技能页面/README 和当前卡片风格生成。

执行新增时，拿到完整 ID 后实际完成以下工作：读取当前 Featured 卡片的文案和视觉格式，为每张卡生成匹配技能用途的标题、副标题、简短描述和独立横幅；用户已提供的文案或视觉方向优先，未提供的部分由 AI 补齐。新增前确认国际站 ID 能通过 skills.sh 搜索、国内站 slug 能通过 SkillHub 数据找到；每张卡单独生成背景图，不能复用同一张图换颜色。

### Edit Featured Skills / 编辑精选技能

- 操作类型：新增、删除或移动排序；可以一次组合多种操作。
- 要修改的现有技能名称或完整 skills.sh / SkillHub 页面链接；同名技能必须使用完整链接或完整 slug 区分。
- 若新增或替换技能，提供新的完整 skills.sh 或 SkillHub 页面链接；若更换背景图，提供新的视觉方向。
- 可选修改：技能链接、名称、标题、副标题、描述、顺序、主题色或背景图；未提及时保持不变，未提供的新内容由 AI 根据技能页面/README 生成。

每张新增或替换的 Featured 技能都要读取自己的 skills.sh 页面/README，生成或更新完整详情模板和独立横幅。单张 Featured 卡可以单独修改，不要求凑够 3 张；新增或删除也不要求按 3 张为一组，只有在用户重视视觉节奏时才推荐按 3 张调整。分页组件必须正确处理最后一页只有 1–2 张卡的情况。

### Other Skills Page Change / 其他 Skills 页面改动

- 明确目标区域：搜索、My Skills、Create Skill、安装/卸载、详情弹窗、分页动效或视觉样式。
- 描述期望行为、影响范围，以及是否只作用于国际站。
- 涉及具体技能时仍必须提供完整 skills.sh 页面链接；涉及界面文案时提供英文和中文要求。

## Discover 分类规范

国际站当前分类是固定人工运营配置，唯一真源为 `frontend/src/pages/marketing/skills-demo/curated-skill-categories.ts`；不能从用户搜索词、安装量或关键词自动创建、更新或排序。现有四类均固定展示 6 张 skills.sh 技能，桌面端为 2 列 × 3 行（移动端自然变为单列），没有左右翻页按钮：

| 页面分类 | 当前中文/英文显示 | 固定 skills.sh ID |
| --- | --- | --- |
| Market Analysis | 市场分析 / Market Analysis | `gracefullight/stock-checker/stock-analysis`、`molezzz/openclaw-stock-skill/akshare-stock`、`anthropics/financial-services-plugins/earnings-analysis`、`okx/agent-skills/okx-sentiment-tracker`、`phuryn/pm-skills/sentiment-analysis`、`personamanagmentlayer/pcl/finance-expert` |
| Content Creation | 内容创作 / Content Creation | `coreyhaines31/marketingskills/content-strategy`、`coreyhaines31/marketingskills/social-content`、`composiohq/awesome-claude-skills/content-research-writer`、`googleworkspace/cli/persona-content-creator`、`resciencelab/opc-skills/seo-geo`、`mattpocock/skills/edit-article` |
| Research | 研究 / Research | `karpathy/nanochat/read-arxiv-paper`、`googleworkspace/cli/persona-researcher`、`nexscope-ai/amazon-skills/amazon-product-research`、`coreyhaines31/marketingskills/customer-research`、`firecrawl/firecrawl-workflows/firecrawl-market-research`、`firecrawl/firecrawl-workflows/firecrawl-deep-research` |
| DevTools | 开发工具 / DevTools | `anthropics/skills/pdf`、`coreyhaines31/marketingskills/image`、`github/awesome-copilot/prd`、`google-labs-code/stitch-skills/enhance-prompt`、`github/awesome-copilot/documentation-writer`、`wshobson/agents/data-storytelling` |

每张固定分类卡可点击打开详情弹窗并安装。详情文案唯一真源为 `frontend/src/pages/marketing/skills-demo/curated-skill-overviews.ts`，每个完整 skills.sh ID 必须有一份独立的推荐页内容；不要复用“同类技能”的泛化文案，也不要只保留一句话简介。先浏览该技能自己的 skills.sh 页面、README 或可信来源，再按以下固定英文结构维护并在页面中原样呈现这些英文标题：

国内站 Discover 不使用这份固定 skills.sh 分类配置：精选和分类均来自 `domestic-skill-catalog.ts` 的人工配置。精选固定为 6 张、每页 3 张；分类固定为 `理财分析`、`内容创建`、`常用工具`，每类 6 张。搜索仍通过 SkillHub API 动态查询，但搜索结果不会改写精选或分类。新增或调整国内分类时，要求用户提供 SkillHub 页面链接或完整 slug、分类归属和展示顺序。

国内站当前固定清单：

- 精选：`find-skill-skillhub`、`image-prompt-skill`、`poster`、`ecommerce-product-selector`、`tencent-news`、`weather`
- 理财分析：`valuation-analysis`、`financial-report-analysis`、`stock-selecter`、`xiaohongshu-content-tools`、`quant-backtest-strategy`、`topnews`
- 内容创建：`unclecheng-reduce-ai-perception-v2`、`douyin-copy-extract`、`g113593`、`weixin-article-writer`、`lingyi-wx-viral-script-generator`、`govwriter-pro`
- 常用工具：`tencent-docs`、`pdf-image-text-extractor`、`pptx-generator`、`gongwenformat-pro`、`meeting-notes-assistant`、`bid-tender-master`

```md
# What Is This?

## Overview
[1 个简短段落说明技能做什么。]

[1 个简短段落说明输入是什么、会帮助产出什么。]

# Who Should Use This

- **[User Type 1]:** [Why this user should use it.]
- **[User Type 2]:** [Why this user should use it.]
- **[User Type 3]:** [Why this user should use it.]

# Why Use It?

## Problems It Solves

- **[Problem 1]:** [Short explanation.]
- **[Problem 2]:** [Short explanation.]
- **[Problem 3]:** [Short explanation.]

## Key Capabilities

- **[Capability 1]:** [What it helps the agent do.]
- **[Capability 2]:** [What it helps the agent do.]
- **[Capability 3]:** [What it helps the agent do.]
- **[Capability 4]:** [What it helps the agent do.]

# How to Use It?

## Basic Usage
[Explain the simplest way to use this skill.]

```plaintext
[Example user prompt]
```
```

### 当前详情模板覆盖状态

- 当前国际站 24 个固定分类技能和 6 个 Featured 技能都已在 `frontend/src/pages/marketing/skills-demo/curated-skill-overviews.ts` 中使用同一套完整模板，并在 `curated-skill-overviews.zh.ts` 中维护中文版本。
- 当前国内站 3 个 Featured 技能和 18 个分类技能使用 SkillHub slug，并在 `curated-skill-overviews.zh.ts` 中维护中文完整模板；国内站页面使用中文详情。未来若同一条配置需要在中英文页面复用，必须同时维护英文和中文详情，不能只补其中一种语言。
- 模板包含 `What Is This?`、`Overview`、`Who Should Use This`、`Problems It Solves`、`Key Capabilities`、`How to Use It?`、`Basic Usage` 和示例提示词；中文版本保持相同结构和信息完整度。
- Featured 和 Category 点击后复用同一个详情弹窗；新增、替换或移动技能时，国内站先按 SkillHub 页面/接口描述核对技能，国际站按 skills.sh 链接核对技能，再维护对应语言的完整模板内容和测试。

写作规则：面向用户、简洁、实用，英文和中文都使用自然、清晰的用户文案；每节保持 2–4 个要点；不能夸大或编造 skills.sh/README 未支持的能力。新增或修改固定分类技能时，必须同步新增或更新中英文完整结构、示例提示词和单元测试；旧的 `Skill Name / One-line Value / Best For / Recommended Input / Output / Why Install` 六行摘要不是当前详情格式，不能恢复。分类标题不显示总数；卡片显示来源徽标和可选火焰热度，不显示具体安装量。

下载量仅用于搜索结果排序和热度展示，不影响固定分类的顺序。国际站使用 `installs > 20,000`，国内站使用 SkillHub 的 `downloads > 10,000`；达到对应阈值时显示一个橙色火焰图标和 `Popular / 热门` 文案，其余不显示。排序仍使用原始 `installs` 数值。国内站搜索结果直接使用 SkillHub 返回的 `downloads`，固定精选/分类卡使用 `domestic-skill-catalog.ts` 中的下载量快照；没有匹配到真实 SkillHub 数据的卡片不显示热门，不能用 `installs` 快照冒充 `downloads`。国际站固定分类技能使用开发时从 skills.sh 拉取的一次性安装量快照，运行时不再通过 ACLI 搜索刷新。

分类推荐不受顶部搜索关键词、来源筛选或 Popular/Name 排序影响。新增或编辑分类技能时，要求用户提供具体技能的完整 skills.sh 页面链接、操作类型和展示顺序；默认维持每类 6 张的 2×3 格式，但用户可明确要求其他数量。

## Featured 精选规范

Featured 是 Discover 顶部的人工运营区域，位于搜索结果之后、分类推荐之前。当前布局推荐每页 3 张卡，使用与分类相同的左右滑轨和切页动效；现有 6 张卡因此分为 2 页。新增 3 张有利于保持页面节奏，但只是推荐，不是硬性要求；用户可以一次新增或删除 1–2 张或其他数量，最后一页允许不满 3 张，不要用占位卡强行补齐。

当前 Featured 基线：

| 名称 | 完整 skills.sh ID | 背景图 | 主题色 fallback |
| --- | --- | --- | --- |
| Self-Improving Agent | `charon-fan/agent-playbook/self-improving-agent` | `featured-self-improving-agent.jpg` | 绿色 |
| Find Skills | `vercel-labs/skills/find-skills` | `featured-find-skills.jpg` | 蓝色 |
| Weather | `steipete/clawdis/weather` | `featured-weather.jpg` | 金色 |
| Caveman | `juliusbrussee/caveman/caveman` | `featured-caveman.jpg` | 炭灰色 |
| To Issues | `mattpocock/skills/to-issues` | `featured-to-issues.jpg` | 靛紫色 |
| Simple | `roin-orca/skills/simple` | `featured-simple.jpg` | 青绿色 |

国内站 Featured 基线位于 `domestic-skill-catalog.ts`，每张卡必须使用唯一背景图：

| 名称 | SkillHub slug | 背景图 |
| --- | --- | --- |
| find skill | `find-skill-skillhub` | `featured-domestic-find-skill.jpg` |
| 提示词生成大师 | `image-prompt-skill` | `featured-domestic-image-prompt.jpg` |
| 海报设计skill | `poster` | `featured-domestic-poster.jpg` |
| 电商选品 | `ecommerce-product-selector` | `featured-domestic-ecommerce.jpg` |
| 腾讯新闻 | `tencent-news` | `featured-domestic-news.jpg` |
| Weather | `weather` | `featured-domestic-weather.jpg` |

新增 Featured 前，必须要求用户提供：

1. 用户想展示的技能名称。
2. 从技能搜索结果复制的完整 skills.sh ID，格式必须是 `组织/仓库/技能名`，不要只给短 slug，也不要自行猜测 ID。
3. 若用户要删除，明确要删除的技能名称或完整 ID；不要求一次删除 3 个。

每张新增 Featured 卡都要独立生成横幅，不能把同一张图换颜色后复用。先使用 `view_image` 读取本 Skill 的 [featured-banner-reference.png](references/featured-banner-reference.png)，它是用户提供的 `1783061357690_蓝色搜索主题banner.png` 的项目内副本，仅作为构图和质感参考。然后使用内置 imagegen 为每个技能单独生成：宽幅约 2:1、左侧保留标题留白、右侧放与技能主题相关的 3D 主体、无图片内文字/Logo/水印，并根据主题分配独立且可读的颜色。不要覆盖原参考图。Featured 卡片主体可点击，必须复用分类技能的完整结构化详情弹窗和同一套安装状态；不要为 Featured 新建另一套详情格式。

将最终资源保存为 `frontend/public/assets/skills/featured-<slug>.jpg`，建议统一为 1200×576 并压缩；在 `FEATURED_SKILLS` 中同时更新 `rawId`、显示名称、`heroImageSrc` 和 `heroClassName`。底部图标、名称、描述和安装 `+ / ✓` 直接复用现有 `FeaturedSkillCard`，不要为单个 Featured 新建另一套卡片组件。

## 整个页面当前逻辑

### Discover 页面定位

Discover 页面用三层方式帮助用户找到技能：**搜索**用于精确查找，**Featured** 用于人工推荐重点技能，**Categories** 用于按使用场景浏览热门技能。三者的数据和状态彼此独立：搜索词、来源筛选和排序不会改变 Featured 或分类内容。

- **顶部搜索栏**：同时查询 skills.sh 和 ClawHub，支持来源筛选及 Popular/Name 排序；默认展示前 12 个结果，超过 12 个可展开全部。搜索结果来自 registry 返回数据，前端不凭名称手工猜测技能 ID。
- **Featured 精选**：人工运营的重点推荐区，用于突出希望用户优先看到的技能。当前为 3 张一页的横向卡片，包含主题横幅、标题/副标题、技能信息和安装按钮；新增、删除、排序和文案都需要人工指定。
- **Categories 分类**：人工定义的固定运营入口。国际站按 Market Analysis、Content Creation、Research、DevTools 组织；国内站按理财分析、内容创建、常用工具组织。两站每类固定 6 张卡，不按运行时热门结果重排；用户点击卡片可查看该技能的结构化说明并安装。

维护时需要人工提供运营意图和配置：搜索逻辑通常不改；新增或编辑分类要提供中英文名称、具体技能的完整 skills.sh 页面链接、操作类型、显示顺序和用途；新增或编辑 Featured 要提供具体技能的完整 skills.sh 页面链接，标题、描述、完整中英文详情和独立主题横幅默认由 AI 生成，也支持人工覆盖；所有改动保持当前卡片样式、安装状态和国际站中英文 i18n，最后一页可自然少于 3 张。

### 页面标签和范围

国内站和国际站 Skills 页面都保留四个横向标签：`Skills`、`Experts`、`Installed`、`Create Skill`；原来的 Discover 页面显示为 `Skills`，原来的 My Skills 页面显示为 `Installed`。`Experts` 展示 SkillHub 专家包，独立 `Search` 标签已移除，搜索控件位于 `Skills` 顶部。`Create Skill` 是独立的创建技能工作流，Quick Learn 和场景工作流在其中维护，不要把它误改成搜索或 Featured。国内站界面使用中文，国际站按当前语言提供英文/中文 i18n。

### Discover 顶部搜索

国际站搜索输入防抖约 300ms，同时查询 ClawHub 和 skills.sh；国内站搜索只查询 SkillHub API。来源下拉在国内站默认 SkillHub，在国际站默认所有来源。Popular/Name 只影响搜索结果，不改变两站的精选或固定分类。搜索结果按安装数降序或名称排序，但卡片不显示具体安装量；超过 20,000 installs 时显示一个橙色火焰和 `Popular / 热门`。标题显示完整结果数；默认只渲染前 12 条（2 列 × 6 条），超过 12 条时标题右侧显示 `View all / Hide all`，展开后显示全部结果。更改搜索词、来源或排序后重新收起到前 12 条。

搜索结果、Featured 和分类推荐的搜索/数据状态彼此独立：搜索控件不改变 Featured 或分类推荐。无关键词时不展示搜索结果区，直接显示 Featured 和分类；有关键词时搜索结果位于 Featured 上方。

### 数据来源、安装和卸载

国际站支持两个 registry：`ClawHub` 和 `skills.sh`；国内站搜索使用 `https://api.skillhub.cn/api/skills`，实例操作使用 `acli skills`。真实联调通过 `execDebugCommand` 在 Agent 实例执行 ACLI 命令；演示模式才使用本地样例数据。当前命令约定为：

- ClawHub 搜索：`acli clawhub search '<keyword>' --sort-by installs`
- skills.sh 搜索：`acli skills-sh search '<keyword>' --sort-by installs`
- ClawHub 安装/卸载：`acli clawhub install '<slug>'` / `acli clawhub uninstall '<slug>'`
- skills.sh 安装/卸载：在登录 Shell 中执行 `bash -lc 'cd "$HOME" && acli skills-sh install <组织/仓库/技能名>'`，卸载保持同样的登录 Shell 结构。
- 已安装列表：分别调用 `acli clawhub list` 和 `acli skills-sh list`，按 `registry + rawId` 合并完全相同的技能。
- 国内站搜索：`GET https://api.skillhub.cn/api/skills?page=1&pageSize=24&sortBy=score&order=desc&keyword=<keyword>`；国内精选和分类不依赖无关键词热门结果，而是读取 `domestic-skill-catalog.ts` 的固定配置。
- 国内站已安装/安装/卸载：`acli skills list`、`acli skills install '<slug>'`、`acli skills uninstall '<slug>'`。

技能身份必须使用 `registry + rawId`；`name` 和短 `slug` 只能用于展示，不能用于 React key、安装中状态、已安装状态或卸载状态。skills.sh 的搜索结果优先使用完整 `id`；解析已安装列表时优先读取 `id/rawId`，只有旧版 ACLI 只返回短 slug 时才使用降级值，并保留本次会话点击的完整 ID，避免同名或同 slug 的不同技能同时变成已安装。

安装按钮使用无边框 `+`，安装成功后变为 `✓`；卸载按钮使用红色垃圾桶图标。安装、卸载后刷新已安装列表，不要在 Featured 中维护另一份安装状态。

### My Skills

My Skills 从两个 registry 的 list 结果合并已安装技能，按 slug 归并来源，使用与 Discover/Search 相同的两列技能卡；右侧是现有卸载逻辑的红色垃圾桶按钮。不要新增第二套卡片样式。

## 维护工作流

1. 先读取本 Skill、`frontend/AGENTS.md`、`frontend/openspec/plan.md` 和当前 `SkillsDemoPanel.tsx`，确认需求属于 Discover、Featured、Search、My Skills 还是 Create Skill。
2. 若是分类变更，先区分 **Category** 与 **Edit Category Skills**；前者询问新增或编辑分类设置，后者询问技能卡的增删移动，涉及具体技能时逐个要求完整 skills.sh 页面链接。
3. 若是 Featured 变更，先区分 **New Featured Skills** 与 **Edit Featured Skills**；涉及具体技能时逐个要求完整 skills.sh 页面链接，新增或替换图片先读取参考图，再每张独立 imagegen，保存并接入静态配置。
4. 国内站和国际站共用布局、卡片、弹窗、分页和 Create Skill；修改时保留两站各自的数据源和命令，并同步需要的中文/英文 i18n。
5. 新增或编辑具体技能后，确认它在对应语言的 `curated-skill-overviews.ts` / `curated-skill-overviews.zh.ts` 中有完整推荐模板；国内站优先补中文，若配置会在英文页面复用则同时补英文。若没有，先读取 SkillHub/skills.sh 页面或 README，再补齐模板和测试。
6. 运行 `pnpm i18n:check`、`pnpm check` 和受影响的 `vitest` 测试；检查 `git diff --check`，并确认资源路径没有断链。

## 参考资源

- [Featured banner reference](references/featured-banner-reference.png)：用户提供的 `1783061357690_蓝色搜索主题banner.png` 的项目内副本，用于未来生成同构 Featured 横幅。
