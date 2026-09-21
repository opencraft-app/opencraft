---
id: change-delivery-flow
type: flow
scope: 从需求路由到归档知识的 Context 辅助交付。
triggers: ["requirement delivery", "context flow", "task lifecycle"]
owner: mingyuxiao
authority: derived
source_of_truth:
  - docs/context/tasks/TASK-TEMPLATE.md
  - docs/context/feedback/README.md
  - docs/engineering/decisions/ADR-0002-design-history-and-docs-impact.md
status: active
reviewed_at: 2026-09-01
review_due: 2026-11-30
revision: 2.1.0
precedence: project
derived: true
---

# 变更交付流程

1. 将需求路由到每一个必要的 Domain 和补充 Project/Runbook Pack。
2. 创建一个 Task Pack，包含一个主要目标、明确 non-goals、需求/接口/数据入口、当前设计、必要历史和 context receipt。
3. 根据所有 `must_read` Pack 和最近服务入口规划；仅在任务跨越该边界时加载 deferred facts。
4. 从受影响路径和需求标识命中的功能族恢复历史：先读当前设计，再对 Git、MR、TAPD/Issue 做有界查询；事实、推断、未知分开记录。
5. 命中 `change-impact.json` 时，同步更新至少一份映射的正式设计文档，并运行 docs-impact 与服务特定门禁。
6. 在 Task Pack 更新证据、风险、决策和交接。
7. 仅提升持久、可复用的知识；一次性失败写入 feedback。
