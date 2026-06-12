---
title: 支持调整 Hermes 记忆字符上限
issue: wisp/mono2#69
status: active
---

# 支持调整 Hermes 记忆字符上限

## 背景

当前 OpenClaw 设置页的「记忆」面板已经能读取 Hermes 实例中的 `.hermes/config.yaml`
以及 `MEMORY.md` / `USER.md` 内容，并展示两类文件的字符占用与上限。但用户无法在控制台
内调整上限，只能进入实例手动执行命令。

## 目标

- 在「记忆」面板内分别支持调整 `MEMORY.md` 与 `USER.md` 的字符上限。
- 通过现有 `debug/exec` 通道注入 Hermes CLI 命令，不新增后端接口。
- 前端提供清晰的范围校验和保存反馈，成功写入配置并重启 Hermes 网关后刷新当前记忆快照。

## 非目标

- 不编辑 `MEMORY.md` / `USER.md` 内容本身。
- 不新增后端 API。
- 不改 Hermes CLI 行为。

## 验收

- Agent 记忆上限范围为 500-4000。
- 用户画像上限范围为 500-3000。
- 实际可填下限还必须不低于当前文件已有字符数。
- 保存命令分别为：
  - `hermes config set memory.memory_char_limit <value>`
  - `hermes config set memory.user_char_limit <value>`
- 配置命令或网关重启命令失败时展示摘要错误，成功后自动刷新并提示修改成功。
