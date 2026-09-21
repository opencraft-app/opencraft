---
id: feedback-audit-self-scoring
type: feedback
scope: 保留仓库 context 审计在无行为消费证据时授予结构分的失败案例。
triggers: ["audit self scoring", "false context score", "behavioral evidence"]
owner: mingyuxiao
authority: derived
source_of_truth:
  - .agents/skills/context-audit/scripts/audit_context.py
  - .agents/skills/context-audit/tests/test_observation_assessment.py
status: active
reviewed_at: 2026-08-25
review_due: 2026-11-23
revision: 2.0.0
precedence: project
derived: true
---

# 反馈：审计自评分

- Task 和日期：context-engineering V2 重构，2026-08-25。
- 预期输出：由真实 route 案例、完整 Catalog 覆盖、有效指令链度量和至少一个 Task Pack 消费 receipt 支撑的评分。
- 实际输出：旧审计报告 95/100，但 Validator 存在缺失 route 文档、无效 metadata、32,001-byte 指令链和陈旧 Catalog；没有 `behavioral_evidence` 对象。
- 证据：`test_audit_reaches_completion_gate` 失败，`test_audit_uses_behavioral_evidence` 抛出 `KeyError: behavioral_evidence`。
- 原因：`tool`；审计从文件存在性授予整项维度分，且未与全部正式 context 文档比较便将五行 Catalog 视为足够。
- 修复：从 Validator 派生 route 案例/失败，按正式文档计算 Catalog 覆盖率，检查真实 Task Pack receipt，并为未实现的运行时机制保留扣分。
- 验证目标：审计评分至少 85 且低于 100，无 P0 发现，零 route 失败，Catalog 覆盖至少 95%，且至少一个真实 Task Pack receipt。
