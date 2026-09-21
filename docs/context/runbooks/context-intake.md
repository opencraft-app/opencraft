---
id: context-intake-runbook
type: runbook
scope: 将重复任务知识或失败证据提升为受治理的 context。
triggers: ["context intake", "knowledge promotion", "feedback"]
owner: mingyuxiao
authority: derived
source_of_truth:
  - .agents/context/lifecycle.yaml
  - docs/context/candidates/README.md
status: active
reviewed_at: 2026-08-25
review_due: 2026-11-23
revision: 2.0.0
precedence: project
derived: true
---

# Context 接入 Runbook

1. 将新条目连同来源证据和 owner candidate 保存到 `candidates/`。
2. 写明 trigger、scope、non-goals 和验证命令。
3. 添加三个需要该条目的真实路由案例。
4. 确认运行时不需要 evaluation 数据。
5. 请求 owner 审阅。
6. 先移至 `pilot` 用于路由，只有验证通过后才移至 `active`。
