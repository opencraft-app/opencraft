---
id: adr-0001-context-engineering-v2
type: decision
scope: 采用分层、路由、可审计的仓库 context，替代全量 context 注入。
triggers: ["context architecture", "ADR", "routing decision"]
owner: mingyuxiao
authority: primary
source_of_truth:
  - docs/context/decisions/ADR-0001-context-engineering-v2.md
status: active
reviewed_at: 2026-08-25
review_due: 2026-11-23
revision: 2.0.0
precedence: project
derived: false
---

# ADR 0001：Context Engineering v2

## 决策

仓库 context 分为 Team、Project 和 Task 指令层。根入口是路由 contract；Domain Pack 保存持久、无法从代码推导的事实；Task Pack 保存临时执行状态。运行时路由必须确定且经静态验证。

## 后果

Agent 在通用指令上消耗更少 Token，并获得具体服务边界、外部 contract 和验证门禁。内容 owner 必须审阅 active Pack。未验证的模型路由和 compaction 功能只能是 pilot 设计，不能宣称为运行时能力。

Task Pack 的元数据进入 `docs/context/.context/catalog.jsonl`；新增或更新 Pack 后必须通过 Context Validator 重建 catalog，catalog 只提供可定位索引，不替代 Task Pack 正文。

新增一级服务必须原子登记服务本地 catalog、中央 Service Catalog、派生 service Context Pack 和
`service-<id>` 路由，并同步校验器的一级服务集合。服务数量由该集合派生，错误和报告不得再写死
固定数量；这样新增 Credit 等服务时，入口覆盖检查会明确指出缺失项，而不是要求维护孤立的计数。
