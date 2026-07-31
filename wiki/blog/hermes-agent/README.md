# Hermes Agent 机制拆解科普系列（中文）

围绕 Nous Research 的 [Hermes Agent](https://hermes-agent.nousresearch.com/docs) 官方文档，从"能否记住你"这一根本命题出发，拆解其长期记忆系统与技能系统的工作原理，并顺带聊聊 LightVela 在这条方向上的产品化思考。

| 序号 | 标题 | 文件 |
| --- | --- | --- |
| 1 | Hermes Agent 与 OpenClaw 有什么不同？ | [`01-hermes-vs-openclaw.zh.md`](./01-hermes-vs-openclaw.zh.md) |
| 2 | Hermes Agent 为什么能"记住你"？拆解长期记忆系统的工作原理 | [`02-why-hermes-remembers-you.zh.md`](./02-why-hermes-remembers-you.zh.md) |
| 3 | 为什么 Hermes Agent 要把记忆分成两类？USER.md 与 MEMORY.md 的职责 | [`03-user-md-vs-memory-md.zh.md`](./03-user-md-vs-memory-md.zh.md) |
| 4 | 记忆不是越多越好：Hermes Agent 如何筛选、整理和更新长期记忆 | [`04-hermes-memory-curation.zh.md`](./04-hermes-memory-curation.zh.md) |
| 5 | Memory 不是 Skill：Hermes Agent 的事实记忆与程序性记忆有何不同？ | [`05-memory-vs-skill.zh.md`](./05-memory-vs-skill.zh.md) |

## 阅读建议

- 想快速对比 Hermes 与 OpenClaw、判断该用哪个？→ 从第 1 篇开始。
- 想搞清楚 Hermes 长期记忆的"底层原理"？→ 从第 2 篇开始，往后连读。
- 想直接理解"Memory / Skill / USER.md / MEMORY.md 到底怎么分"？→ 直接看第 3 篇和第 5 篇。

## 立场声明

- 关于 Hermes Agent 的机制描述以其官方文档为准。
- 对比 OpenClaw 时，聚焦公开可见的能力定位差异，不做具体产品优劣评价。
- LightVela 的相关段落属于自家产品视角的延伸讨论，会明确标注为"LightVela 的做法/方向"。
