---
id: trade-service-detail
type: service
scope: 商业计费集成、订单、支付回调和开通的派生服务上下文。
triggers: ["trade detail", "jifei", "billing integration"]
owner: wisp/mono2-maintainers
authority: derived
source_of_truth:
  - trade/docs/README.md
  - trade/catalog-info.yaml
  - trade/AGENTS.md
  - trade/internal
status: active
reviewed_at: 2026-09-01
review_due: 2026-11-30
revision: 2.1.0
precedence: service
derived: true
related_packs: ["subscription-entitlements", "identity-access"]
---

# Trade 服务 Context

仅在交易、外部计费、支付回调或开通任务中加载；订阅、Pass、配额和支付语义还要加载 `subscription-entitlements`。

## 当前边界

- `trade` 编排订单、外部 provider、回调和开通，不重新定义订阅权益，也不拥有外部计费规则。
- 回调和开通必须幂等；只有 provider 成功创建 contract 后才能调用 CTL。
- 保留既有外部用户/订单标识，不建立平行身份映射；外部计费规则始终回到受控 external source。

## 按需深入与验证

读取 `trade/AGENTS.md`、`trade/docs/README.md` 和命中实现附近的测试。运行 `go test ./...` 与 `go vet ./...` 的最小有效集合；覆盖重复回调、provider 失败、开通补偿和已有订单兼容。真实 provider 调用需要额外授权。
