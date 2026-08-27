# 自定义人设来源标记设计

## 背景

当前上传逻辑使用 `Slug: custom-upload` 同时承担“人设自身标识”和“LightVela 上传来源标记”两种职责。用户上传已经包含 `# Soul`、`Slug`、`Name` 和业务章节、但没有 `## Content` 的文件时，逻辑会把整份文件包装到新的 `## Content` 下，导致双层 `# Soul`；原始 Slug 也无法作为顶层人设标识保留。

## 已确认方案

- 在 `SOUL.md` 顶层元数据中加入 `LightVela-Source: custom-upload`。
- 用户已经提供的顶层 `Slug` 保持不变；来源识别不再依赖改写 Slug。
- 只要输入包含顶层 `# Soul`，就按已有 Soul 结构处理，不要求必须存在 `## Content`；首个二级标题后的正文和章节原样保留。
- 普通 Markdown 仍包装为 `# Soul` / `## Content`，补充 `Name` 与 `LightVela-Source`，不再生成 `Slug: custom-upload`。
- 页面身份读取新增 `LightVela-Source` 字段，并以其识别新上传的人设。
- 已有 `Slug: custom-upload` 文件继续按自定义人设处理，避免存量状态丢失。
- 下载继续返回 Agent 当前实际 `SOUL.md` 原文，不在下载阶段标准化。

## 范围外

- 不改为伴随文件或后端状态。
- 不修改 Hermes 的读取、加载和会话生效机制。
- 不改上传弹窗、编辑弹窗、下载交互或文案。
- 不迁移已经写入的存量 `SOUL.md`。

## 验收标准

1. 用户示例中的 `Slug: focused-project-guide` 保持为唯一顶层 Slug。
2. 输出包含且仅包含一个顶层 `LightVela-Source: custom-upload`。
3. 用户示例不产生第二个 `# Soul` 或额外 `## Content` 包装。
4. 页面刷新后可通过 `LightVela-Source` 恢复自定义人设状态。
5. 旧版 `Slug: custom-upload` 仍可恢复自定义人设状态。
6. 推荐人设、全文读取和下载行为不变。
