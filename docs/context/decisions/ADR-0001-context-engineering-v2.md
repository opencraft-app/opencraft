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
