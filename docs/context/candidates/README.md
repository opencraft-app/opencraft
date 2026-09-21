---
id: context-candidates-index
type: candidate
scope: 可复用 context candidate 的 owner 审阅队列。
triggers: ["candidate context", "knowledge promotion", "review queue"]
owner: mingyuxiao
authority: derived
source_of_truth:
  - .agents/context/lifecycle.yaml
status: candidate
reviewed_at: 2026-08-25
review_due: 2026-11-23
revision: 2.0.0
precedence: project
derived: true
---

# Context Candidate 候选队列

每个 candidate 必须包含 trigger、scope、来源证据、owner、non-goals、验证和三个路由案例。未经 owner 审阅和静态验证通过，任何 candidate 都不得进入运行时路由。
