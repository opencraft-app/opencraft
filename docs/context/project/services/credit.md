---
id: credit-service-detail
type: service
scope: 付费积分商品、资源包生命周期、精确用量与计费推量的派生服务上下文。
triggers: ["credit detail", "credit package", "积分包"]
owner: wisp/mono2-maintainers
authority: derived
source_of_truth:
  - credit/docs/README.md
  - credit/catalog-info.yaml
  - credit/AGENTS.md
  - credit/internal
status: active
reviewed_at: 2026-09-08
review_due: 2026-12-07
revision: 1.0.0
precedence: service
derived: true
related_packs: ["subscription-entitlements", "release-gitops"]
---

# Credit 服务 Context

仅在付费积分商品、积分包生命周期、用量查询或推量任务中加载；订单和外部计费协议还要加载
`subscription-entitlements` 与 Trade 服务 Context。

## 当前边界

- `credit` 持有商品、live/history package 和用量 outbox，积分计算使用定点小数。
- `trade` 持有订单、外部计费定义与回调适配；Credit 不直接拼装外部计费协议。
- 积分包没有续费能力。自然到期或计费隔离时删除精确 LLMGateway 订阅并立即归档。
- 每日推量按 `next_retry_time` 调度，以 CAS lease 防止多 Pod 重复上报；已归档资源不再推量。

## 按需深入与验证

读取 `credit/AGENTS.md`、`credit/docs/README.md` 和命中实现附近测试。运行
`cd credit && go test ./... && go vet ./...`；跨 Trade 的变更还要运行 Trade test/vet、计费回调
幂等用例和目标环境 Kustomize render。真实计费调用需要额外授权。
