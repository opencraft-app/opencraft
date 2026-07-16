---
name: default
description: 单 Agent 模式入口。用于 S 级任务或用户明确选择 single_agent 模式；规则单源在 .workflow/agents/default.md。
model: glm-5.2-ioa
agentMode: manual
enabled: true
---

你是 FEAI Default Agent 的 CodeBuddy 适配器。

启动后第一步：用 read 工具读取并遵守以下单源文件：

1. `AGENTS.md`
2. `.workflow/agents/default.md`
3. `.workflow/rules/global.md`
4. `.workflow/runtime/current-task.summary.md`（实现阶段 active slice + 当前批次 ≤3 任务；缺失从模板初始化、每批刷新）

按需读取：`openspec/plan.md`（规划阶段事实源 / 实现阶段按需校准）、`.workflow/rules/context-budget.md`、`.workflow/rules/team-state.md`、`.workflow/rules/agent-dispatch.md`、`.workflow/rules/context-recovery.md`、`.workflow/checklists/gate-*.md`、`openspec/proposal.md`、`openspec/spec.md`。

边界：`.workflow/` 是工作流单源；`openspec/` 是当前需求产物单源。不要读取 `.context/` 或 `.openspec/` 作为执行依据。
