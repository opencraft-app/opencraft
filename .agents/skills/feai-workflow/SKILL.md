---
name: feai-workflow
description: 在包含 FE-AI 工作流、OpenSpec、commands/feai-*.md 或用户提到 feai-start、feai-review、feai-archive、feai-init、规划、review、验收、归档、提交时使用。按项目门禁、上下文预算和用户确认点执行。
---

# FE-AI Workflow for Codex

本仓库使用 FE-AI 作为项目工作流层。Codex 在处理需求规划、实现、验证、归档、提交、MR/PR 等任务时，必须把以下文件视为稳定事实源：

- `AGENTS.md`：薄入口与硬规则。
- `.workflow/rules/global.md`：全局工作流铁律。
- `.workflow/rules/workflow-strict.md`：严格流程细则，仅在命中严格流程时读取。
- `.workflow/checklists/gate-*.md`：阶段门禁。
- `.workflow/agents/*.md`：多 Agent / 角色职责定义。
- `commands/feai-*.md`：FE-AI 命令入口文档。
- `openspec/plan.md`：规划与实现阶段的当前计划事实源。
- `.workflow/runtime/current-task.summary.md`：实现阶段 active slice，仅保留当前批次任务。

## 必须遵守

1. 规划或实现前，先读取 `AGENTS.md` 与 `.workflow/rules/global.md`。
2. 用户触发 `/feai-start`、`/feai-review`、`/feai-archive`、`/feai-init`，或用自然语言表达同等意图时，读取对应的 `commands/feai-*.md`。
3. 规划阶段以 `openspec/plan.md` 为事实源；实现阶段优先读取 `.workflow/runtime/current-task.summary.md`，仅在需要校准时再打开完整 plan。
4. 阶段推进前必须对照对应的 `.workflow/checklists/gate-*.md`。
5. 实现与验证完成后，必须停在用户验收确认点。用户明确确认前，不得自动归档、commit、push 或创建 MR/PR。
6. 不要把 Codex deprecated custom prompts 当作主工作流来源。本 skill 是 Codex 原生入口；`commands/feai-*.md` 是跨工具共享的命令参考。

## Codex 适配说明

- Codex 会从 `.agents/skills/feai-workflow/SKILL.md` 发现本技能。
- repo-scoped skills 应随项目入库，供团队共享。
- Codex 内置 `/review` 只能作为代码审查辅助，不能替代 `/feai-review` 的门禁语义。
