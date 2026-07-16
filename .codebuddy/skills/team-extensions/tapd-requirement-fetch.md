---
name: tapd-requirement-fetch
description: '团队扩展 Skill - 从 TAPD 自动获取需求详情，支持 TAPD 链接、Story ID、Bug ID 等多种输入方式'
extends: brainstorming
---

# TAPD 需求获取

## 概述

此 Skill 是对 Superpowers `brainstorming` 的团队扩展，自动从 TAPD 获取需求详情。

## 适用场景

- **TAPD 链接**：`https://tapd.woa.com/tapd_fe/{workspace_id}/story/detail/{story_id}`
- **Story/Bug ID**：短 ID（8-9 位）或完整 ID（19 位）

## ID 转换规则

| 格式    | 位数 | 转换公式                                      |
| ------- | :--: | --------------------------------------------- |
| 完整 ID |  19  | `"10" + workspace_id + 短ID`                  |
| 短 ID   | 8-9  | 从完整 ID 中提取：去掉前缀"10"后 8 位+后 9 位 |

示例：`10{workspace_id}{shortID}` → 如 `1010132091128613253` → workspace: `10132091`, 短 ID: `128613253`

## MCP 调用

```javascript
// Story（注意：workspace_id 为字符串，参数名为 id 而非 story_id）
stories_get({ workspace_id: '{workspace_id}', id: '{完整ID}' });

// Bug（同理，参数名为 id 而非 bug_id）
bugs_get({ workspace_id: '{workspace_id}', id: '{完整ID}' });

// Task
tasks_get({ workspace_id: '{workspace_id}', id: '{完整ID}' });
```

> ⚠️ **注意**：TAPD MCP 的查询 API 参数名统一为 `id`（完整 19 位 ID），不是 `story_id` / `bug_id`。`workspace_id` 为**字符串**类型。

## 提取字段

`name`, `description`, `priority`, `status`, `owner`, `developer`, `begin`, `due`

## 处理流程

1. 解析输入 → 识别 ID 类型，短 ID 转完整 ID
2. 调用 TAPD MCP → `stories_get` / `bugs_get`
3. 提取关键字段 → 传递给 `brainstorming` Skill
