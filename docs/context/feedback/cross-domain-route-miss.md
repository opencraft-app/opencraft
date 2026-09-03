---
id: feedback-cross-domain-route-miss
type: feedback
scope: 保留包含 payment 的发布 query 未加载订阅与权益边界的失败案例。
triggers: ["route miss", "cross-domain payment release", "retrieval regression"]
owner: mingyuxiao
authority: derived
source_of_truth:
  - .agents/context/route-smoke-cases.json
  - .agents/context/context-routing.yaml
status: active
reviewed_at: 2026-08-25
review_due: 2026-11-23
revision: 2.0.0
precedence: project
derived: true
---

# 反馈：跨 Domain Route Miss

- Task 和日期：context-engineering V2 重构，2026-08-25。
- 精确 query：`修复 payment 发布 bundle 边界`。
- 预期 route：`subscription-entitlements` 和 `release-gitops`。
- 实际 route：仅有 `release-gitops`；订阅 route 有中文 payment 术语和 `payment/` 路径前缀，但缺少独立英文 `payment` trigger。
- 证据：Validator 报告 `route case payment-release missing ['subscription-entitlements']`。
- 原因：`route`；常见业务名词缺失于 keyword channel，且自然语言 query 未包含明确仓库路径。
- 修复：向 `subscription-entitlements` 添加 `payment` 和 `trade` trigger，并在 route smoke suite 保留 `payment-release`。
- 验证：`validate_context.py` 现对全部 16 个案例报告零 route smoke 失败。
