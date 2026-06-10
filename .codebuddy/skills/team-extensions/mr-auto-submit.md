---
name: mr-auto-submit
description: '团队扩展 Skill - 通过 Gongfeng MCP 创建 Merge Request 并关联 TAPD（commit/MR 文案规范以 global.md G14 + quality.md 5.2 为准）'
extends: finishing-a-development-branch
---

# 自动创建 Merge Request

## 概述

本 Skill 仅负责"读配置 → 调 MCP 创建 MR"这一硬动作。**Conventional Commits 格式、commit 中文化要求等通用规范以 `global.md` G14 与 `quality.md` 5.2 为准**，本文件不再罗列。

> 🔴 **强制规则**：创建 MR 是**不可逆操作**，无论是否开启信任模式（`--yes`），都**必须先展示 MR 配置信息，征得用户确认后才能执行**。禁止自动创建 MR。

## 触发条件

开发完成、commit 已推到远端，用户在普通对话中说「提 MR / 创建 MR / 合并请求」时触发。

## 项目配置获取

按以下优先级解析 `git_project_id` 与 `default_branch`：

1. 读取 `.codebuddy/project.local.json` 的 `git.projectId` / `git.defaultBranch`
2. 缺失时通过 `git remote get-url origin` 探测 `projectId`，`defaultBranch` 兜底 `master`
3. 都无法获取 → 提示运行 `feai init` 或由用户手动提供

## 关键硬知识

### 1. TAPD 关联格式（`tapd_info` 字段）

| 单据类型 | 格式                | 多个单据用空格分隔     |
| -------- | ------------------- | ---------------------- |
| Story    | `--story=128613253` | `--story=123 --bug=456` |
| Bug      | `--bug=987654321`   |                        |
| Task     | `--task=123456789`  |                        |

### 2. ⚠️ TAPD label 是 replace 不是 append

参考 [`ai-usage-tracking.md`](./ai-usage-tracking.md)。直接传 `labels: 'FE-AI'` 会**清除已有标签**，必须先查询再拼接，逻辑由 `ai-usage-tracking` skill 提供。

### 3. FE-AI 标记位置

| 位置        | 内容                                  |
| ----------- | ------------------------------------- |
| MR 标题前缀 | `[FE-AI]`                             |
| MR 标签     | `FE-AI`（与已有标签拼接，不是覆盖）   |
| MR 描述章节 | `## FE-AI 辅助开发`（一段简要说明）   |

## MCP 调用

```javascript
create_merge_request({
  project_id: '{git_project_id}',
  title: '[FE-AI] feat: {简短描述} (#{story_id})',
  source_branch: 'feat/{currentuser}-{MMDD}-{slug}',
  target_branch: '{default_branch}',
  description: `## 需求描述
- TAPD: https://tapd.woa.com/...

## 改动说明
- ...

## FE-AI 辅助开发
- ✅ 本 MR 由前端 AI 编程工具辅助完成
- 工具：FE-AI`,
  tapd_info: '--story={story_id}',
  reviewers: 'reviewer1,reviewer2',
  necessary_reviewers: 'leader1',
  labels: 'FE-AI', // ⚠️ 实际写入前需调 ai-usage-tracking 拼接已有标签
});
```

## 交互流程

1. 解析配置（projectId / defaultBranch）
2. 自检（参考 `requesting-code-review`：lint / test / 自测过）
3. 展示 MR 配置卡片 → 等待用户确认（即使 `--yes` 也不可跳过）
4. 调用 `create_merge_request` MCP
5. 返回 MR 链接 + 下一步指引（建议执行 `/feai-archive`）

### 确认模板

```markdown
## 🚀 准备创建 MR

| 配置     | 值                               |
| -------- | -------------------------------- |
| 源分支   | `feat/{currentuser}-{MMDD}-{slug}` |
| 目标分支 | `{default_branch}`               |
| 标题     | `[FE-AI] feat: xxx (#128613253)` |
| TAPD     | `--story=128613253`              |
| 评审人   | reviewer1, reviewer2             |
| FE-AI    | ✅ 标签 + 描述章节               |

确认创建？ ✅ 确认 / ⚠️ 修改 / ❌ 取消
```

## 与其他 Skills 的协作

```
git commit (按 global.md G14 / quality.md 5.2 中文规范) →
requesting-code-review → mr-auto-submit
```

## 相关 Skills

- [`ai-usage-tracking.md`](./ai-usage-tracking.md) — FE-AI 标签覆盖陷阱与拼接逻辑
