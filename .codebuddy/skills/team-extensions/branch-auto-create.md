---
name: branch-auto-create
description: '团队扩展 Skill - 通过 Gongfeng MCP 创建开发分支（仅负责 MCP 调用，命名规范以 global.md G8 为准）'
extends: finishing-a-development-branch
---

# 自动创建开发分支

## 概述

本 Skill 仅负责"读配置 → 调 MCP 创建分支"这一硬动作，**不**重复定义分支命名规则。

> 🔴 **分支命名以 `.workflow/rules/global.md` G8 为唯一标准**：
> `feat/{currentuser}-{MMDD}-{需求英文简称}`，其中 `currentuser` 取自 `git config user.name`（兜底 `whoami`），并做 slug 化（小写、空格转 `-`、保留 `[a-z0-9-]`）。
>
> 本文件不再列出额外的分支命名表，避免与 G8 冲突。

## 触发条件

- `/feai-start` 流程 STEP 4 调用，或
- 用户在普通对话中说「切分支 / 新建分支 / 创建开发分支」。

## 项目配置获取

按以下优先级解析 `git_project_id` 与 `default_branch`：

1. 读取 `.codebuddy/project.local.json` 中的 `git.projectId` 与 `git.defaultBranch`
2. 缺失时从 `git remote get-url origin` 自动探测 `projectId`，`defaultBranch` 兜底 `master`
3. 仍无法获取 → 提示用户运行 `feai init` 或手动提供

## 前置约束（强制）

参考 G8：创建分支前必须执行 `git status --porcelain` 检查工作区，**有任何未提交内容时禁止**自动 stash / 自动 commit / 强制切换分支，必须先让用户决定如何处理。

## MCP 调用

```javascript
create_branch({
  project_id: '{git_project_id}',         // 来自 project.local.json 或 git remote
  branch_name: 'feat/{currentuser}-{MMDD}-{slug}', // 命名以 G8 为准
  ref: '{default_branch}',                // master / main
});
```

## 交互流程

1. 检查工作区干净（不干净 → 停下让用户处理，禁止替用户决定）
2. 解析 `currentuser` / `MMDD` / 需求英文简称（slug）→ 拼接分支名
3. 展示 `项目 / 源分支 / 新分支名` → 等待用户确认
4. 调 `create_branch` MCP
5. 输出本地切换命令：
   ```bash
   git fetch origin
   git checkout feat/{currentuser}-{MMDD}-{slug}
   ```

下一步：进入 `writing-plans` 阶段。

## 与其他 Skills 的协作

```
tapd-requirement-fetch → prd-creator → [用户确认] → branch-auto-create → writing-plans
```
