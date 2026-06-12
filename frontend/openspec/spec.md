---
title: 支持调整 Hermes 记忆字符上限
issue: wisp/mono2#69
status: active
---

# 技术规格

## 交互规格

「记忆」面板继续保留两张统计卡：

- `MEMORY.md`：展示 Agent 记忆占用与上限。
- `USER.md`：展示用户画像占用与上限。

每张卡增加轻量编辑入口。点击后在卡片内部展开数字输入、保存、取消：

- 输入为空、非整数、小于 500 或超过对应最大值时，保存按钮不可用并展示错误提示。
- 保存中禁用输入、保存、取消和重复提交，按钮展示 Loading。
- 保存成功写入配置后继续执行 Hermes gateway restart。
- 网关重启成功后退出编辑态、刷新记忆快照并提示修改成功。
- 保存失败时保留编辑态，展示失败摘要。

## 命令规格

通过 `BotRepository.execDebugCommand(botId, command)` 执行：

- `memory` 类型：`hermes config set memory.memory_char_limit <value>`
- `user` 类型：`hermes config set memory.user_char_limit <value>`
- 配置写入成功后执行 `hermesScripts.gateway.getRestartCommand()` 返回的重启命令。

前端仅允许已通过范围校验的整数进入命令构造。

## 实现规格

- `openclaw-memory.ts` 承担常量、范围校验、命令构造和读取快照解析。
- `openclaw-settings-page.tsx` 的 `MemoryPanel` 承担编辑 UI 与保存状态。
- 保存失败复用现有 `isExecCommandSucceeded` / `truncateExecOutput` 处理路径。

## 验证规格

- `openclaw-memory.test.ts` 覆盖范围校验和命令构造。
- 定向运行记忆工具函数测试。
- 运行 TypeScript 与 i18n 门禁。
