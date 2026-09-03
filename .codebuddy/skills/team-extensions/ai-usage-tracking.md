---
name: ai-usage-tracking
description: '团队扩展 Skill - AI 辅助开发数据采集与标记规范，用于统计 AI 编程工具提效数据'
---

# AI 辅助开发数据采集

## 概述

此 Skill 定义了团队 AI 辅助开发的数据采集机制，用于追踪和统计 AI 编程工具的使用情况，为提效分析提供数据支撑。

## 目标

- 证明需求是通过 AI 编程工具开发的
- 统计 AI 辅助开发的需求数量和比例
- 分析 AI 工具对开发效率的影响

---

## 统一标记名称

所有标记统一使用 **`FE-AI`**：

| 标记位置    | 统一名称                | 说明                    |
| ----------- | ----------------------- | ----------------------- |
| TAPD 标签   | `FE-AI`                 | 需求/缺陷/任务标签      |
| MR 标签     | `FE-AI`                 | Gongfeng MR 标签        |
| Commit 前缀 | `[FE-AI]`               | Git 提交信息前缀        |
| Commit 脚注 | `AI-Assisted-By: FE-AI` | Git 提交脚注            |

---

## 自动标记时机

当前端 AI 工具辅助用户进行开发时，**必须自动**在以下阶段添加标记：

| 阶段            | 触发时机       | 标记内容                    | 对应 Skill            |
| --------------- | -------------- | --------------------------- | --------------------- |
| **需求阶段**    | 开始开发需求时 | TAPD 添加 `FE-AI` 标签      | tapd-requirement-fetch |
| **Commit 阶段** | 提交代码时     | 添加 `[FE-AI]` 前缀 + 脚注  | 本 skill（下文「FE-AI Commit 标记规范」） |
| **MR 阶段**     | 创建 MR 时     | 添加 `FE-AI` 标签和描述章节 | mr-auto-submit        |

---

## TAPD 标签操作注意事项

> ⚠️ **关键踩坑点**：TAPD MCP 的 `label` 参数是**覆盖（replace）**而非追加（append）。
> 直接设置 `label: 'FE-AI'` 会**清除已有标签**！必须先查询再拼接。

### 正确操作流程

```
1. 先查询当前对象，获取已有标签
2. 判断是否已包含 FE-AI（避免重复添加）
3. 拼接已有标签 + FE-AI（用 | 分隔）
4. 更新标签（保留已有标签）
```

### 示例代码

```javascript
// 步骤 1：查询已有标签
const story = stories_get({ workspace_id, id: full_story_id });
const existingLabel = story.data?.Story?.label || '';

// 步骤 2：拼接（避免覆盖）
const newLabel = existingLabel
  ? (existingLabel.includes('FE-AI') ? existingLabel : `${existingLabel}|FE-AI`)
  : 'FE-AI';

// 步骤 3：更新
stories_update({ workspace_id, id: full_story_id, label: newLabel });
// 缺陷用 bugs_update，任务用 tasks_update，参数相同
```

---

## 数据采集链路

```
┌─────────────────────────────────────────────────────┐
│                    数据采集链路                      │
├─────────────────────────────────────────────────────┤
│  1. 需求阶段：TAPD 需求添加 "FE-AI" 标签             │
│         ↓                                           │
│  2. 开发阶段：Commit message 添加 [FE-AI] 前缀      │
│         ↓                                           │
│  3. 提交阶段：MR 添加 FE-AI 标签                    │
│         ↓                                           │
│  4. 统计阶段：通过 Git/Gongfeng/TAPD API 统计数据   │
└─────────────────────────────────────────────────────┘
```

---

## 可采集的数据维度

| 数据维度       | 数据来源     | 标记名称  |
| -------------- | ------------ | --------- |
| FE-AI 辅助提交 | Git Log      | `[FE-AI]` |
| FE-AI 辅助 MR  | Gongfeng API | `FE-AI`   |
| FE-AI 辅助需求 | TAPD API     | `FE-AI`   |
| FE-AI 辅助缺陷 | TAPD API     | `FE-AI`   |

> 💡 具体的统计脚本与报告生成，本仓库不再以 skill 形式提供。详见 `docs/cross-project-stats.md`（如该文件存在）或由团队统一脚本仓库维护。

---

## FE-AI Commit 标记规范

> Conventional Commits 完整格式、commit 语言与项目规范优先等通用规范以 `../feai-native/references/team-conventions.md` 的「commit 规范」一节为准。本节只规定**因 AI 辅助开发额外注入**的 FE-AI 标记，三行可以记完：

1. **subject 前缀**：`[FE-AI] <type>(<scope>): <中文描述>`
2. **footer 脚注**：在 commit body 末尾追加 `AI-Assisted-By: FE-AI`
3. **何时打**：当本次 commit 中存在 AI 辅助产出的代码（生成、补全、重构）时必须打；纯人工修改可以不打

### 示例

```bash
git commit -m "[FE-AI] feat(batch-import): 新增域名批量导入功能

- 支持 CSV 和 Excel 格式
- 最多支持导入 1000 条

TAPD: #128613253
AI-Assisted-By: FE-AI"
```

> 🔴 **强制规则**：`git commit` / `git push` 是不可逆操作，无论是否开启 `--yes` 信任模式，都必须先展示完整 commit message 征得用户确认后才能执行。

---

## 与其他 Skills 的协作

```
tapd-requirement-fetch → branch-auto-create → build 实现 → git commit (本 skill 注入 FE-AI 前缀) → mr-auto-submit
         ↓                                                                   ↓                                  ↓
  [TAPD 标签: FE-AI]                                                  [Commit: [FE-AI]]                 [MR: FE-AI]
```
