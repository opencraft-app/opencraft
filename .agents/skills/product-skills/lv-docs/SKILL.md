---
name: lv-docs
description: 维护 LightVela 产品文档站的专用技能，覆盖国内站（lightvela.com/docs）与国际站（lightvela.ai/docs）双区域。用户要求编辑、新增、翻译或审查文档站页面时使用，尤其是涉及 frontend/src/content/docs 根目录、frontend/src/content/docs/global、frontend/src/content/docs/en、frontend/src/content/docs/id、文档图片、文档侧边栏、slug 映射、fumadocs 注册、路由 metadata，或提示中出现“文档站”、“国内站文档”、“国际站文档”、lightvela.com/docs、lightvela.ai/docs、English docs、zh-sg docs、id-id docs、docs screenshots/images、双站同步等信息时使用。
---

# LightVela 文档站文档

## 定位

这个技能服务 LightVela 产品文档站的两个区域：

- 国内站：`lightvela.com/docs`（`zh-cn`）
- 国际站：`lightvela.ai/docs`（`en-us` / `zh-sg` / `zh-hant` / `id-id`）

两个区域在代码里**严格隔离、不跨区域 fallback**，因此每次任务都必须先确定区域，再动文件。

如果用户要写 LightVela 长篇营销/产品文章，而不是维护 docs 页面，应改用 `lv-longform-content`。长篇内容正文默认必须严格输出英文，除非用户明确要求中文或双语。

## 第一步：必须先确认区域

**新增文档或新增分类前，必须先向用户提问本次要改哪个区域，不要自行假设。** 提问要给出三个明确选项：

```text
region: cn      # 仅国内站 lightvela.com/docs
region: global  # 仅国际站 lightvela.ai/docs（含 en-us、zh-sg、zh-hant 与页面级 id-id）
region: both    # 双站同步上线
```

免问的例外情况（可直接推断，但要在最终回复里说明推断依据）：

- 用户明确提到 `lightvela.ai`、国际站、英文文档、印尼语文档、`en-us`、`zh-sg`、`zh-hant`、`id-id` → `global`。
- 用户明确提到 `lightvela.com`、国内站、中国站、实名认证等国内专属语境 → `cn`。
- 用户明确说“双站”、“两个站”、“国内外都要” → `both`。
- 仅修改一个已存在文件的局部内容，且该文件路径已能唯一确定区域 → 按该文件所属区域处理。

只说 `/docs` 且无其他线索时，必须提问，不要默认国际站，也不要默认国内站。

## 第二步：区域能力差异检查（国内站重点）

两站功能覆盖范围不同。**为某区域写文档前，必须先确认该功能在该区域是否真实存在。**

核对方法（以代码为准，不要凭记忆）。三个注册源范围互不一致，**必须全查**：

1. `frontend/src/config/docs-sidebar.ts` 的 `CN_SIDEBAR` / `GLOBAL_SIDEBAR`（决定用户是否可见）。
2. 同文件的 `CN_SLUG_TO_FILE` / `GLOBAL_SLUG_TO_FILE`（决定 slug 能否解析到文件）。
3. `frontend/scripts/sync-fumadocs-content.mjs` 的 `cnDocs` / `globalDocs`（决定标题、描述、分组是否生效）。

国际站还要检查同一脚本的 `ID_DOC_METADATA` 与 `globalDocsForIndonesian`：印尼语是 `frontend/src/content/docs/id/<file>` 的页面级显式源，只有存在该文件的页面才生成 `id-id` 路由；它不是从英文或中文自动翻译出的全量镜像。

只查一处会误判。例如 `hermes-agent` 前 5 篇不在 `CN_SLUG_TO_FILE` 里，但在 `cnDocs` 里注册了，国内站其实是有的。

处理规则：

- 如果功能**国内站没有**，而用户要求写国内站文档：**必须先提醒用户并等待确认**，不要直接落盘。提醒时要区分两种情况：
  - **功能缺失**（国内站产品不支持，如 Telegram / WhatsApp / Discord 及依赖它们的场景）：说明写该文档没有意义，建议不写。
  - **文档待补**（纯内容页面，或功能可能已有但没写文档）：说明可以写，但需先确认国内站产品是否已支持。
- 无法从配置判断国内站产品是否支持某功能时，明确告知“无法从文档配置判断该功能在国内站是否已上线”，请用户确认，不要擅自断言。
- 如果功能**国际站没有**，而用户要求写国际站文档：同样先提醒，规则对称。
- `region: both` 时，如果某功能只有单侧存在，必须明确告知“只能单侧上线”，并让用户选择：只上有该功能的一侧，或等另一侧功能上线后再补。
- 国内专属内容（实名认证、国内支付、国内专属入口）不要进入国际站文档。
- 国际站专属渠道（Telegram / WhatsApp / Discord 等）不要进入国内站文档，除非国内站确实已支持。

当前双站覆盖差异快照与核对清单见 `references/docs-rules.md`。快照仅供参考，冲突时以代码为准。

## 写作标准

以下标准适用于两个区域的所有文档页面。

### 开篇摘要（强制）

每篇文档正文的第一个板块必须是摘要，供搜索引擎与生成式引擎直接抽取：

- 使用固定标题：`## 摘要`（中文）或 `## Summary`（英文）。不使用 `TL;DR`、`一句话回答`、`概述` 等非正式或替代标签。
- 位置在正文最前面，先于任何引子、背景、痛点、故事。
- 若有推荐图或 hero 图片，必须放在完整摘要段落之后、下一个二级标题之前；不要把图片放到摘要标题之前，也不要插进摘要段落之间。
- 写 1–2 段自成一体的加粗段落（答案确实可枚举时可用简短加粗列表），直接回答标题提出的问题。
- 必须能在脱离页面其他部分被单独引用时依然成立。
- 必须点名正文将要支撑的具体对象、数字、文件名和结论。不写“继续阅读即可了解”这类吊胃口表述，也不只是把标题换句话重复。
- 与页面 `description` / meta 摘要保持区分：`description` 是一行 SEO 简介，摘要板块是可抽取的完整答案。

### 内容体裁分档（按 sidebar 分类决定）

文档站有两类内容，写法与验收标准不同。**动笔前先按目标页面所属 sidebar 分类确定档位。**

#### A 档：工具型（客观、精简、可执行）

适用分类：`开始使用` / `Getting Started`、`套餐与开通` / `Plans & Activation`、`功能与配置` / `Features & Configuration`、`问题排查`、`联系与支持`。

- 全程客观第三方视角，不用营销口吻。标题与分组用中性表述，例如「开始使用」「配置模型」「如何开通第一个实例」，不用「超强」「最佳」「一键搞定」这类夸张说法。
- 只陈述功能事实、前置条件、操作步骤、限制与失败处理，不写主观赞美、竞品贬低、未经证实的效果承诺。
- 不写第一人称推销（例如「我们强烈推荐」）。需要给建议时用条件式客观表述（例如「若需长期在线，建议开启自动任务」）。
- 涉及收费、配额、可用区域、平台限制时如实写明，不隐藏约束。
- 不设字数门槛，**以精简可执行为准**，不要为凑字数加背景故事或行业铺垫。
- 必须覆盖四部分：前置条件、完整步骤、结果校验、常见失败处理。

#### B 档：可读型（丰富、有深度、兼顾可读性）

适用分类：`场景方案` / `Use Cases`、`对比与选型` / `Compare & Choose`、`Hermes Agent 解读`。

- 目标是让读者读完真的理解，可读性与信息量都要够，允许并鼓励适当扩展内容。
- 国内站现有 B 档页面正文不少于 3000 字（约 6 KB）。低于门槛不算完成，必须补足或合并进已有页面。
- 国际站使用下方三类模板时，以搜索意图、模板完整性、事实密度与可读性为完成标准，不套固定字数门槛，也不为凑长度重复解释。
- 国际站三类模板的完成稿必须包含模板要求的至少 1 张表格，并在至少 2 个正文板块中合计提供不少于 3 项可核查细节；可核查细节包括机制、字段或文件名、命令、数字、状态、能力边界或可追溯来源。
- 国内站 B 档结构要有推进层次：摘要 → 引子（说明这个问题为什么值得讲）→ 分维度展开 → 结论。
- 国际站 B 档按对应模板推进，不套用统一的引子位置：Use Cases 由 `Who this is for and expected outcome` 承担引子职能；Hermes Agent Deep Dive 由 `Why this question matters` 承担引子职能；Compare & Choose 不设独立引子，按摘要 → 推荐图 → 主对比表 → 分维度展开 → 结论组织。
- 避免平铺直叙的定义罗列。
- 事实密度硬要求：必须包含可核查的机制细节、具体字段名/文件名/数字，或可追溯来源。**禁止通篇只有概念定义与同义反复**（例如只反复解释「模型负责理解与生成，Agent 层负责调度」而无任何具体机制、字段或流程）。
- 鼓励使用对比表格、清单、示例片段、边界条件说明来承载信息，而不是只用短句堆叠。
- 允许提出自有分析框架或分类维度来组织内容，但框架必须由正文事实支撑。
- 仍属产品文档而非营销文：不写传播导语、不写社媒 CTA、不写 Community Ending。

两档共同遵守下面的开篇摘要、立场声明与禁止事项。

### 国际站 B 档模板（强制）

国际站的 `Use Cases`、`Compare & Choose` 与 `Hermes Agent Deep Dive` 使用同一套语言无关模板。

模板只规定信息结构，不规定先写英文还是中文：

- `Use Cases`：使用 `assets/templates/international-use-case.md`。
- `Compare & Choose`：使用 `assets/templates/international-comparison.md`。
- `Hermes Agent Deep Dive`：使用 `assets/templates/international-agent-deep-dive.md`。
- 用户明确要求哪种语言，就先用该语言完成内容底稿；未明确时，按用户要求的输出语言或提示词主语言起草。
- 内容底稿完成后，由执行本技能的 Agent 在同一任务中补齐国际站基础源语言：英文写入 `en/<file>`，简体中文写入 `global/<file>`。
- `zh-hant` 没有独立正文源文件，由 `pnpm docs:sync` 从 `global/<file>` 自动转换生成；同步后必须检查对应 `.fumadocs-content/docs/zh-hant/` 产物。
- `id-id` 使用独立的 `frontend/src/content/docs/id/<file>`。如果目标页面已有印尼语源，事实或结构改动必须同步更新并检查 `.fumadocs-content/docs/id-id/`；新页面只有在用户要求印尼语交付时才新增该源，未提供时该页面不会进入 `globalDocsForIndonesian`，不得宣称已交付印尼语版本。
- 本地化不是逐字翻译。不同语言必须保持相同标题层级、表格、图片位置、事实、示例意图、链接目标、警告与能力边界，同时使用自然的本地表达。
- 用户只要求生成一种语言时，也要自动补齐另一种国际站源语言，不再等待第二次提示。
- 缺少 `en/<file>`、`global/<file>` 或同步后的 `zh-hant` 产物，都视为国际站基础页面未完成；已有或明确要求的 `id/<file>` 缺失、过期或没有 `id-id` 产物，也视为对应印尼语交付未完成。

三个模板都强制执行以下顺序和质量要求：

- 摘要必须独立回答标题，推荐图紧跟完整摘要段落。
- Use Cases 的实用表格必须位于完整步骤之后、FAQ 之前。
- Compare & Choose 的主对比表必须位于摘要推荐图之后。
- Hermes Agent Deep Dive 至少包含一个机制、架构、层级或状态表格。
- Hermes Agent Deep Dive 遇到不同维度、操作、状态或配置模式时，使用多个职责单一的表格，不把所有信息塞进一张大表。
- Hermes Agent Deep Dive 遇到官方来源中的具体记录、响应、配置或操作时，加入对应的 Markdown、JSON、YAML、`/command`、Bash、预期输出或错误信息代码块。
- 技术块按主题选择，不要求每篇文章集齐全部类型；没有官方依据的命令、字段、配置和输出不得编造。
- 每个 fenced code block 必须标注正确语言，并在代码块前后说明读者需要观察的字段、结果或失败状态。
- 需要增加深度时优先补充可核查机制、例子、边界或失败模式，不增加空泛背景段落。

**REQUIRED SUB-SKILL:** 国际站这三类页面必须使用 `lv-seo-geo` 做搜索意图、实体表达与内链检查。

内链检查需要形成小型双向链接图：

- 新页面正文分散放置 2-5 个真实相关的出站内链。
- 在 1-3 个最相关的既有国际站页面中加入指向新页面的上下文反链，前提是该链接确实帮助读者理解或继续操作。
- 英文新页面与反链写入 `en/`，简体中文对应内容写入 `global/`，两种基础源保持相同链接关系并本地化锚文本；目标页已有或明确要求 `id/<file>` 时，印尼语源也保持同一链接图并本地化锚文本。
- 链接必须内联在相关段落，不新增 `Related reading`、`延伸阅读` 或类似集中链接板块。
- 修改前按 `lv-seo-geo` 核对真实 slug、路由、注册与 sitemap，不把 Markdown 文件名当 URL。

### 立场声明

- 描述第三方产品机制时，以该产品官方文档为准，不凭印象推断。
- 做产品对比时，只聚焦公开可见的能力与定位差异，不做优劣评价、不贬低竞品。
- 涉及 LightVela 自家视角的延伸讨论，必须明确标注为「LightVela 的做法」或「LightVela 的方向」，与第三方机制描述区分开。

### LightVela 功能不得过度承诺（强制核实）

写「LightVela 的做法」这类段落时，**每一条能力都必须先在产品文档里找到依据**，不能凭产品愿景或行业惯例推断。核实方法：

- 到对应区域的文档里查证，**核实范围必须同时覆盖** `configuration/`（功能说明页）与 `use-cases/`（场景方案页）；有些能力只在 `use-cases/` 里有描述，只查 `configuration/` 会误判为「功能不存在」。找不到依据的能力**一律不写**。
- 功能标注为「即将推出」「敬请期待」时，必须原样保留这个限定词，不可写成已具备。
- 区分**谁提供该能力**：Hermes 的命令或机制（如 `/learn`、`/skills pending`）不能写成 LightVela 的产品功能，反之亦然。
- 区分**能力边界**：例如记忆在管理台是「可查看 + 可调容量」，增删则通过对话完成——不能笼统写成「可查看、可修正、可删除」。
- 已知易错点，写之前逐条对照：
  - 技能来自 Skills.sh 与 ClawHub 公开市场，**不是**用户自建的「个人 Skill 库」，也不支持编辑或分享自己的工作流。
  - 管理台面板安装技能**尚未上线**（即将推出），当前通过对话安装与删除。
  - **没有团队维度**的记忆、人格、技能复用能力，不要写「团队级沉淀」「新人自动继承团队记忆」。
  - LightVela 采用云端托管模式，**不提供面向用户的文件系统操作**，不要写成可直接编辑 `MEMORY.md` 等文件。
  - 人格**确实有**「人设」能力（管理台 Agent 设置页 →「人设」，支持「随机抽取人设」与「答题测试人设」，选中后「注入人设」），它生成并注入 Soul；但它不是可编辑任意云端文件的通用编辑器，也不要描述成「可视化效果预览」。
  - Telegram 通道支持群消息。
  - 涉及群助手场景时必须写明接入前置条件：在 BotFather 中发送 `/mybots` 并选择机器人，进入「Bot Settings」→「Group Privacy」关闭隐私模式，将机器人加入群组后通过 `@机器人用户名` 发起对话。
  - 不要把自动入群欢迎、未提及机器人的被动回复、成员加入事件或其他未验证的群组行为写成已支持能力。
- 措辞要贴合文档原文：例如通道状态的准确表述是「显示为已接入」，不要改写成产品里不存在的说法。
- 最终回复中必须说明这些能力的核实依据来源。

### 国内站适配走查（强制，写国内站文档或从国际站搬运时必做）

国内站与国际站的产品能力、可用平台、可访问服务都不同。**只要 `region` 涉及 `cn`（含从国际站搬运内容），落盘前必须逐项走查以下清单，不能直接照搬国际站文案。**

1. **通道与 IM 工具**：国内站当前支持微信、飞书、QQ。文中出现 Telegram、WhatsApp、Discord、Slack、Line、Messenger 等国内站未支持的平台时，必须替换为国内站对应通道或删除该示例。举例场景（「你在 A 上问、在 B 上追问」）要整段改写成国内站通道组合，不能只替换平台名而留下不成立的语境。**例外**：当句子主语明确是第三方产品、在客观陈述该产品自身支持的平台时（如「OpenClaw 的 Gateway 可接入 WhatsApp、Telegram」），应保留原文，替换反而造成事实错误——判断标准是读者是否会误以为那是 LightVela 国内站的能力。注意 `configuration/channel-telegram.md` 等文件在国内站目录下存在，但未注册进 `CN_SIDEBAR`，不代表国内站支持，不要据此改判。
2. **链接**：不得出现 `lightvela.ai`、`/zh-sg/`、`/en-us/` 等国际站硬编码链接。国内站文档一律使用相对 `.md` 路径，并确认目标文件在国内站真实存在（国际站有的页面国内站可能没有，例如 `configuration/automation.md` 只有国际站有）。**存在性必须脚本化逐条校验**：遍历所有 `](../xxx.md)` 与图片引用，对每条 `fs.existsSync` 判断并打印总数与死链数。禁止用带去重的命令（如 `sort -u`）做这项检查——同一个死链目标出现在多篇文章时会被折叠，导致只修了一处就误判为完成。除文件存在外，还要确认该 slug 已注册进 `CN_SLUG_TO_FILE`，否则页面仍打不开。
3. **区域叙述**：不要在国内站文档里写「国际站与国内站支持范围不同」「要先确认自己所在区域」这类跨区域对照说明。国内站读者只需知道国内站的能力边界，直接陈述「当前支持的通道是……」即可。
4. **示例与截图语境**：示例里的项目、页面、场景不要用「国际站首页」「海外用户」这类国际站语境；截图必须来自 `lightvela.com`，不能用 `lightvela.ai` 的界面。
5. **第三方服务可达性**：涉及外部服务时，确认其在国内网络环境下可正常访问；不可达的服务不要作为推荐步骤，必要时说明限制。
6. **术语**：国内站用「飞书」「企业微信」等中文原名，不要用国际站的 Lark、WeCom 写法。
7. **搬运后必须回读全文**：不要只依赖关键词替换。替换后通读一遍，确认没有残留「改了词但语境不成立」的句子（例如链接文字仍是国外平台名、列表顺序仍按国际站排序）。

走查完成后，在最终回复中列出实际修改了哪些不适配内容；若确认无需修改，也要说明已走查。

### 禁止事项

- 禁止连载导航：不写「下一篇预告」「上一篇」「本系列」「in the next post」「this series」。docs 页面从搜索或侧边栏直接进入，交叉引用必须指名目标文章标题，并在任意阅读顺序下都成立。
- 禁止独立的「延伸阅读」板块：不设 `## 延伸阅读`、`## Related reading`、`## 相关阅读` 这类集中罗列其他文章的章节。侧边栏已承担导航职责，底部再列一遍属于重复，且任一文章改标题或下线时会产生批量死链。交叉引用一律**内联在正文相关段落**——在读者正好需要该背景的位置指名目标文章标题，这比集中列表更有效。
- 禁止暴露内部信息：示例中不得出现真实内部仓库名、服务名、主机名、端口、分支名。统一使用中性占位名，例如 `agent-demo`。
- 禁止用 Markdown 源文件名当作 docs URL。

## 先读代码事实

执行任务前，按需读取：

- `frontend/src/lib/docs/docs-loader.ts`
- `frontend/src/config/docs-sidebar.ts`
- `frontend/scripts/sync-fumadocs-content.mjs`
- `frontend/next-site/docs-route-manifest.ts`
- `frontend/src/app/(site)/docs/[[...slug]]/page.next.tsx`
- `frontend/src/app/(site)/[lang]/docs/[[...slug]]/page.next.tsx`
- 目标 markdown 在对应区域的文件

详细目录、加载、注册、图片规则见 `references/docs-rules.md`。

## 工作流

1. 确认区域：按「第一步」确定 `cn` / `global` / `both`，必要时提问。

2. 检查区域能力差异：按「第二步」确认该功能在目标区域是否存在；缺失时先提醒用户并等待确认。

3. 定位 slug 与文件：
   - 国内站从 `CN_SIDEBAR` / `CN_SLUG_TO_FILE` 查，文件在 `frontend/src/content/docs/<file>`。
   - 国际站从 `GLOBAL_SIDEBAR` / `GLOBAL_SLUG_TO_FILE` 查，简中在 `global/<file>`，英文在 `en/<file>`，页面级印尼语在 `frontend/src/content/docs/id/<file>`；再从 `globalDocsForIndonesian` 确认是否生成 `id-id` 路由。
   - 新增页面时，同步在 `sync-fumadocs-content.mjs` 的 `cnDocs` / `globalDocs` 注册标题、描述与分组。

4. 检查是否共享或缺文件：
   - 国际站英文缺 `en/<file>` 时会 fallback 到 `global/<file>`；正式英文文档不应依赖 fallback。
   - 国际站要与国内站内容不同时，必须补齐 `global/` / `en/` 独立文件，不要改根目录文件来间接影响国际站。
   - `id-id` 只对存在 `id/<file>` 的页面开放；已有印尼语源不得因本次英文或中文更新而留下过期事实。
   - `region: cn` 时不要顺手改 `global/` / `en/` / `id/`；`region: global` 时不要顺手改根目录文件。

5. 同步内容分类状态：
   - 写作前从 `wiki/growth-state/lightvela-docs-content-categories.md` 找到对应内容项。
   - 完成并通过验证后，按该文件头部的状态标记规范更新对应区域状态。
   - 草稿、聊天内文案、未完成工作不得改变内容项状态。
   - 清单中没有对应项时，先让用户确认应归属的现有一级分类，完成后再新增。

6. 内容编辑顺序：
   - `region: cn`：直接写 `frontend/src/content/docs/<file>`（中文）。
   - `region: global`：按用户指定语言或提示词主语言完成内容底稿，再在同一任务中写入并本地化 `en/<file>` 与 `global/<file>`；若已有或明确要求印尼语，再同步 `id/<file>`。
   - `region: both`：国内站中文稿独立适配；国际站部分仍按用户指定语言或提示词主语言起草，再补齐 `en/<file>` 与 `global/<file>`，并按上一条处理印尼语。
   - 国际站各源稿不做逐字硬翻，要面向各自用户自然本地化；保持标题层级、步骤顺序、表格、图片位置、链接结构、事实与注意事项语义一致。
   - `Use Cases`、`Compare & Choose`、`Hermes Agent Deep Dive` 必须按「国际站 B 档模板」选择对应资产。

7. 图片检查：
   - 扫描目标 markdown 的 `![](...)` 与 `<img src="...">`。
   - 英文或印尼语文档若引用中文 UI 图片，检查 `frontend/src/content/docs/images/` 是否有同 basename 的 `-en` 版本；同步脚本对 `en-us` 与 `id-id` 都优先使用 `-en` 图片，缺失时在最终回复中列出。
   - 用户要求检查/更新/替换截图，或表达「图片不对 / 图片过期 / 与页面不一致」时，必须用 Browser 打开对应区域的真实页面做视觉核对：国内站用 `lightvela.com`，国际站用 `lightvela.ai`。
   - 只覆盖 markdown 当前引用的既有图片文件，不新增旁路文件、不只返回 markdown。
   - 只替换确属 LightVela 站内 UI 且能在真实站点复现的图；第三方平台与手机 App 截图（BotFather、Discord Developer Portal、WhatsApp、QQ/WeCom/Lark 管理后台等）不替换。
   - 截图前必须等 `loading...`、`Loading...`、`加载中...`、骨架屏或空白占位消失，确认真实内容已加载。
   - 截图只含网页内容，不含浏览器标签栏、地址栏、书签栏或系统窗口边框。
   - 出现二维码、Token、AppID/AppSecret、验证码等敏感内容时，落盘前用灰色矩形覆盖敏感主体区域。

8. 渠道列表检查：
   - 扫描目标 markdown 中的渠道/社媒/集成列表，尤其 `Telegram / WhatsApp / ...`、`Telegram、WhatsApp、...` 这类写法。
   - 以目标区域实际支持范围为准，先确认该区域完整渠道数与名称，再决定补齐或重排。
   - 国际站固定优先顺序：`Telegram / WhatsApp / Discord / WeChat / <其他国际站已支持渠道>`。任何以其他平台开头、或把 Discord、WeChat 排在 WhatsApp 前面的列表都要重排。
   - 国内站按国内站实际渠道列举，不要写入国内站未支持的渠道。

9. 同步内容到渲染产物（**改完 markdown 必须做，否则页面看不到改动**）：
   - 页面实际渲染的是 `frontend/.fumadocs-content/` 下的 `.mdx` 生成产物，**不是** `src/content/docs/` 里的 `.md` 源文件。
   - 只改源文件不跑同步，dev server 与构建都会继续使用旧内容，很容易误判为“改动没生效”或“改了没用”。
   - 改完任何 markdown 后运行：`cd frontend && pnpm docs:sync`
   - 同步后核对生成产物体量或内容确实变化，例如对比 `src/content/docs/global/<path>.md` 与 `.fumadocs-content/docs/zh-sg/<slug>.mdx`。
   - dev server 已在运行时，同步后需重启或触发重新编译才能看到新内容。
   - `pnpm check`、`pnpm build` 等命令内部已包含同步步骤，单独改文档时用 `pnpm docs:sync` 即可。

10. 验证：
   - 小改动至少检查链接、图片路径、slug 是否存在。
   - 检查开篇摘要板块是否就位；确认体裁档位（A 工具型 / B 可读型）判断正确，并按该档标准校验字数门槛、事实密度、四段完整性与禁止事项。
   - `region` 涉及 `cn` 时，必须完成「国内站适配走查」全部 7 项，并确认无国际站残留（可用关键词自查：`Telegram`、`WhatsApp`、`Discord`、`lightvela.ai`、`zh-sg`、`en-us`、`Lark`、`WeCom`、`国际站`）。
   - 内部信息自查：搜 `5174`、`5175`、`localhost:`、`.woa.com`、`mono2` 等真实端口、主机名、仓库名。示例统一用中性值（如端口写 `3000`、项目名写 `agent-demo`）。走查范围不限于本次新增文件，同分类下的既有文章也要一并扫（老文章常有历史残留）。
   - 自查必须同时在 `src/content/docs/` 源文件和 `.fumadocs-content/docs/<locale>/` 产物上各跑一遍：产物侧能暴露源文件漏改和同步未生效两类问题。
   - 确认已执行第 9 步同步，并已核对生成产物内容确实更新。
   - `region: global` 或 `both` 时，确认 `en/<file>` 与 `global/<file>` 都存在、结构一致，并检查同步生成的 `en-us`、`zh-sg`、`zh-hant` 三份基础产物；若已有或明确要求 `id/<file>`，再检查 `id-id` 产物、结构和事实一致性。
   - 国际站 B 档页面确认模板顺序、推荐图位置、必需表格、2-5 个出站内链与 1-3 个有效上下文反链均已落实。
   - 国际站 B 档页面确认至少 2 个正文板块中合计包含不少于 3 项可核查细节。
   - 涉及 sidebar、注册表、route 或 metadata 时，建议运行 `cd frontend && pnpm check`，或相关 parity 测试。
   - 若只改 markdown 且未运行测试，最终说明未运行。

## 输出位置

```text
frontend/src/content/docs/<file>.md          # 国内站（zh-cn）
frontend/src/content/docs/global/<file>.md   # 国际站中文（zh-sg）
frontend/src/content/docs/en/<file>.md       # 国际站英文（en-us）
frontend/src/content/docs/id/<file>          # 国际站印尼语（id-id，页面级显式开放）
frontend/src/content/docs/images/*           # 文档图片资源
frontend/src/config/docs-sidebar.ts          # sidebar / slug 变化时修改
frontend/scripts/sync-fumadocs-content.mjs   # 新增页面注册标题、描述、分组
```

只改单侧区域时，不要触碰另一侧的目录。

## 最终回复

最终回复用中文，说明：

- 本次区域是 `cn` / `global` / `both`，以及区域是用户指定还是推断（推断要给依据）。
- 国际站任务说明内容底稿使用的语言、自动补齐了哪些基础源文件与生成产物，以及目标页是否已有或明确要求 `id-id`、对应 `id/<file>` 是否同步。
- 改了哪些文件，是否创建或补齐了区域独立文件。
- 是否存在目标区域缺失该功能的情况，以及提醒与用户确认结果。
- 开篇摘要板块是否就位；本次判定的体裁档位（A 工具型 / B 可读型）及依据；该档的字数门槛与事实密度是否达标。
- `region` 涉及 `cn` 时，是否完成国内站适配走查，以及具体改掉了哪些不适配内容（通道、链接、区域叙述、术语等）；无需修改时也要说明已走查。
- 英文图片是否齐备；若缺，列出缺的图片名。
- 是否触碰了非目标区域的文件；正常应为“未触碰”。
- 是否同步了 `lightvela-docs-content-categories.md`，以及对应内容项各区域的最终状态。
- 是否已执行 `pnpm docs:sync` 同步到渲染产物；未执行时必须说明（否则页面仍是旧内容）。
- 是否运行了检查或测试；未运行时说明原因。

## Reference

- `references/docs-rules.md`：双站目录映射、加载与注册机制、区域能力差异清单、图片与渠道规则。
- `assets/templates/international-use-case.md`：国际站 Use Cases 结构模板。
- `assets/templates/international-comparison.md`：国际站 Compare & Choose 结构模板。
- `assets/templates/international-agent-deep-dive.md`：国际站 Hermes Agent Deep Dive 结构模板。
