---
name: lv-longform-content
description: 生成 LightVela 长篇营销/产品文章的专用技能。用户要求撰写“LV 长篇内容”“长篇内容”、教程系列、功能介绍系列、应用场景系列、博客/文章草稿，或围绕 LightVela 功能、Channels、Skills、Automations、Hermes Agent、SkillHub/ClawHub、Souls、模型配置、真实用户场景创作英文长文时使用。正文默认严格输出英文，除非用户明确要求中文或双语。
---

# LightVela 长篇内容

## 定位

这个技能用于按 LightVela 品牌语气撰写完整长篇内容。支持三种文章模式：

- `tutorial`: LV 长篇内容（教程系列）
- `feature-intro`: LV 长篇内容（功能介绍系列）
- `use-case`: LV 长篇内容（应用场景系列）

正文默认严格输出英文。只有用户明确要求中文或双语时，才输出中文或双语。

## 写作前

起草前先读取 `references/style-guide.md`。只读取与当前模式相关的章节，以及 shared rules。

如果用户输入已经足够，直接写完整文章。只有缺失信息会改变文章类型或核心故事时，最多问一个简短澄清问题。

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
3. 在适合放截图或产品图的位置加入 `[Image]` 占位符。除非用户要求，不要写很长的图片说明。
4. 语气保持亲近、直接、有轻微叙事感。多写具体产品动作，少写抽象宣传。
5. 默认产出完整文章，不要只给大纲，除非用户明确要求大纲。

## 输出规则

- 文章正文默认严格输出英文。
- 开头先写纯文本标题行，然后写 `[Image]`，再进入开头段落。
- 使用短小自然的 section heading。
- 避免营销口号、泛泛 AI hype，以及过度解释 AI 是什么。
- 只有在与文章主题相关时，才提到 LightVela、Hermes、SkillHub/ClawHub、Channels、Skills、Automations 等产品概念。
- 不要复制示例文章的具体主题，除非用户要求写同一个主题。可以复用风格和结构，但不要复用内容。
- 产品事实优先依据用户给定上下文或仓库/docs。若不确定，使用中性假设或问一个澄清问题。

## 输出位置

默认直接在对话中输出完整文章，不自动写入仓库文件。

如果用户明确要求保存到文件，优先保存为 Markdown。若仓库已有博客/内容目录，遵循现有目录约定；若没有明确约定，先在对话中说明建议文件名和保存位置。

## Reference

- `references/style-guide.md`：共享风格、三种模式模板、图片占位规则与修订检查清单。
