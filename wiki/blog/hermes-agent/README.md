# Hermes Agent 解读（中文底稿）

围绕 Nous Research 的 [Hermes Agent](https://hermes-agent.nousresearch.com/docs) 官方文档，从"能否记住你"这一根本命题出发，拆解其长期记忆系统与技能系统的工作原理，并顺带聊聊 LightVela 在这条方向上的产品化思考。

## 发布位置

这 5 篇已作为**产品文档**发布在 docs 站的「Hermes Agent 解读」分类下，不再作为独立 blog 页面：

- 国内站：`lightvela.com/docs/hermes-agent/<slug>`
- 国际站：`/en-us`、`/zh-sg`、`/zh-hant` 三个 locale

正文源文件位置（**改动请以这些为准**，本目录仅作归档底稿）：

- 国内站：`frontend/src/content/docs/hermes-agent/*.md`
- 国际站中文源：`frontend/src/content/docs/global/hermes-agent/*.md`
- 国际站英文稿：`frontend/src/content/docs/en/hermes-agent/*.md`

页面标题、描述、分组与侧边栏顺序在 `frontend/scripts/sync-fumadocs-content.mjs` 的 `cnDocs` / `globalDocs` 里注册。

## 篇目

| 序号 | 标题 | docs slug | 底稿 |
| --- | --- | --- | --- |
| 1 | Hermes Agent vs OpenClaw：两个开源 Agent 的根本差别 | `hermes-agent/hermes-vs-openclaw` | [`01-hermes-vs-openclaw.zh.md`](./01-hermes-vs-openclaw.zh.md) |
| 2 | Hermes Agent 是怎么"记住你"的？ | `hermes-agent/why-hermes-remembers-you` | [`02-why-hermes-remembers-you.zh.md`](./02-why-hermes-remembers-you.zh.md) |
| 3 | USER.md 与 MEMORY.md 为什么不能合并？ | `hermes-agent/user-md-vs-memory-md` | [`03-user-md-vs-memory-md.zh.md`](./03-user-md-vs-memory-md.zh.md) |
| 4 | Hermes Agent 的长期记忆治理：少而准的四条铁律 | `hermes-agent/hermes-memory-curation` | [`04-hermes-memory-curation.zh.md`](./04-hermes-memory-curation.zh.md) |
| 5 | Memory vs Skill：陈述性记忆与程序性记忆 | `hermes-agent/memory-vs-skill` | [`05-memory-vs-skill.zh.md`](./05-memory-vs-skill.zh.md) |

## 阅读建议

- 想快速对比 Hermes 与 OpenClaw、判断该用哪个？→ 从第 1 篇开始。
- 想搞清楚 Hermes 长期记忆的"底层原理"？→ 从第 2 篇开始，往后连读。
- 想直接理解"Memory / Skill / USER.md / MEMORY.md 到底怎么分"？→ 直接看第 3 篇和第 5 篇。

## 写作约定

- 每篇开头必须是 `## 摘要` 段，自成一体地回答标题问题（GEO 抽取用），不使用 `TL;DR` 等非正式标签。
- 不写"下一篇预告"等连载导航：docs 页面从搜索或侧边栏直接进入，交叉引用需指名文章、任意阅读顺序都成立。
- 举例不得使用真实内部项目名/端口，统一用 `agent-demo` 等占位名。

## 立场声明

- 关于 Hermes Agent 的机制描述以其官方文档为准。
- 对比 OpenClaw 时，聚焦公开可见的能力定位差异，不做具体产品优劣评价。
- LightVela 的相关段落属于自家产品视角的延伸讨论，会明确标注为"LightVela 的做法/方向"。
