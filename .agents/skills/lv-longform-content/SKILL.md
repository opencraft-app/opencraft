---
name: lv-longform-content
description: 生成 LightVela 长篇营销/产品文章的专用技能。用户要求撰写“LV 长篇内容”“长篇内容”、教程系列、功能介绍系列、应用场景系列、社媒长文、Tencent Techpedia/腾讯技术百科、开发者社区、博客/文章草稿，或围绕 LightVela 功能、Channels、Skills、Automations、Hermes Agent、SkillHub/ClawHub、Souls、模型配置、真实用户场景创作长文时使用。必须先区分输出渠道：social media 社媒长文，或 Tencent Techpedia/开发者社区 Markdown 文件；若用户未说明渠道，先询问。
---

# LightVela 长篇内容

## 定位

这个技能用于按 LightVela 品牌语气撰写完整长篇内容。支持三种文章模式：

- `tutorial`: LV 长篇内容（教程系列）
- `feature-intro`: LV 长篇内容（功能介绍系列）
- `use-case`: LV 长篇内容（应用场景系列）

社媒长文默认严格输出英文，除非用户明确要求中文或双语。Tencent Techpedia/开发者社区必须输出 Markdown 文件，且同时产出中文和英文两个版本。

## 写作前

起草前先读取 `references/style-guide.md`。只读取与当前模式相关的章节，以及 shared rules。

如果用户没有明确说明输出渠道，先问一句：这篇是用于 social media 社媒长文，还是用于 Tencent Techpedia/开发者社区 Markdown 发布？渠道会影响语言、输出位置和文件要求。

如果渠道已明确且用户输入足够，直接写完整文章。只有缺失信息会改变文章类型、核心故事或输出渠道时，最多问一个简短澄清问题。

## 输出渠道选择

先判断输出渠道：

- `social-media`: 用户提到 social media、社媒、Twitter/X、LinkedIn、公众号长文草稿、短传播长文、营销长文，或只要求在聊天里生成可发布内容。
- `techpedia`: 用户提到 Tencent Techpedia、腾讯技术百科、开发者社区、技术百科、开发者文章、技术社区发布，或明确要求输出 `.md` 文件。

如果用户没有出现这些明确线索，不要猜；先询问渠道。

## 模式选择

根据用户提示选择一种模式：

- 使用 `tutorial`：当内容是在教用户完成配置或操作，例如连接 Telegram、配置模型、安装技能、创建自动任务、发布 Agent、排查流程。
- 使用 `feature-intro`：当内容是在介绍或解释 LightVela 产品能力，例如 Souls、Skills、Automations、Channels、Memory、模型配置、云端托管、专家包。
- 使用 `use-case`：当内容是在讲一个真实或拟真的用户场景，例如 FIFA newsletter agent、daily research assistant、stock/news tracker、class helper、travel planner、team ops bot。

如果用户明确说了三种中文系列之一，优先遵循该模式，即使主题也能落到其他模式。

## 写作流程

1. 识别目标读者、文章模式、功能/场景、目标渠道，以及用户读完后应该完成的结果。
2. 写作前先建立文章弧线：
   - `tutorial`: promise -> prerequisites -> steps -> verification -> troubleshooting -> done.
   - `feature-intro`: product context -> why it matters -> what it is -> how it works -> what changes for users -> what's next.
   - `use-case`: relatable pain -> LightVela setup -> skills/configuration -> live usage -> automation or repeatability -> lesson/transferable pattern.
3. 评估是否需要图片。推荐少量、高价值图片，通常 2-4 张；教程最多 5 张。每个图片位置都写成 `[Image: <具体建议图片>]`，不要只写裸 `[Image]`。
4. 语气保持亲近、直接、有轻微叙事感。多写具体产品动作，少写抽象宣传。
5. 默认产出完整文章，不要只给大纲，除非用户明确要求大纲。
6. 每篇完整文章末尾都追加固定 Community ending，包含 Discord 和 WhatsApp 邀请文案与真实二维码图片。图片资产存放在 `assets/lightvela-discord-qr.png` 和 `assets/lightvela-whatsapp-qr.png`。

## 输出规则

- `social-media` 正文默认严格输出英文。
- `techpedia` 必须输出两个 Markdown 文件：一个中文版本、一个英文版本。
- 开头先写纯文本标题行，然后写 `[Image: <推荐首图>]`，再进入开头段落。
- 使用短小自然的 section heading。
- 避免营销口号、泛泛 AI hype，以及过度解释 AI 是什么。
- 只有在与文章主题相关时，才提到 LightVela、Hermes、SkillHub/ClawHub、Channels、Skills、Automations 等产品概念。
- 不要复制示例文章的具体主题，除非用户要求写同一个主题。可以复用风格和结构，但不要复用内容。
- 产品事实优先依据用户给定上下文或仓库/docs。若不确定，使用中性假设或问一个澄清问题。
- 每篇文章都必须以 `references/style-guide.md` 中的 Community ending 作为最后一段。不要把二维码替换成 `[Image]` 占位符。
- 完成后必须在聊天回复中列出图片位建议：位置、推荐图片内容、为什么需要。图片数量要克制，不要为了填充而放图。

## 输出位置

- `social-media`: 默认直接在对话中输出完整文章，不自动写入仓库文件；如果用户要求保存，再保存为 Markdown。
- `techpedia`: 必须保存为 Markdown 文件，不只在聊天中输出。若仓库已有内容目录，遵循现有目录约定；若没有明确约定，保存到 `product/longform-content/<yyyy-mm-dd>-<slug>.zh.md` 和 `product/longform-content/<yyyy-mm-dd>-<slug>.en.md`。

保存文件后，在聊天中给出文件路径、语言版本、文章模式、渠道和图片位建议清单。

## Reference

- `references/style-guide.md`：共享风格、三种模式模板、图片占位规则与修订检查清单。
- `assets/lightvela-discord-qr.png`：Discord 社区二维码。
- `assets/lightvela-whatsapp-qr.png`：WhatsApp 社群二维码。
