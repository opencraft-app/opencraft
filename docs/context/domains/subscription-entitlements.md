---
id: subscription-entitlements
type: domain
scope: 订阅套餐、pass、续费、支付回调和权益限额。
triggers: ["subscription", "renewal", "quota", "payment", "pass"]
owner: mingyuxiao
authority: derived
source_of_truth:
  - docs/engineering/domains/subscription-entitlements.md
  - subscription/api/openapi.yaml
  - subscription/internal
  - payment/api/openapi.yaml
  - frontend/src/domain/types.ts
status: active
reviewed_at: 2026-08-25
review_due: 2026-11-23
revision: 2.0.0
precedence: domain
derived: true
---

# 订阅与权益

> 派生摘要：正式领域知识见 `docs/engineering/domains/subscription-entitlements.md`；本页只保留影响 Agent 路由和实现决策的最小事实。

## 适用场景

任务变更套餐定义、checkout、续费、配额展示、支付回调或 pass 到期行为时使用。

## 影响决策的事实

- `subscription` 拥有当前订阅状态和 admin 操作；其生成的 API contract 是集成边界。
- `payment` 拥有支付订单状态，并通过内部 apply-payment contract 通知 subscription。
- 前端 pass 和 quota 类型映射后端 contract；不得在仅 UI helper 中重定义状态或续费语义。
- `auto_renew_flag` 有三个值：`auto_renew`、`notify_and_manual_renew` 和 `no_notify_and_manual_renew`。把它当作 contract 值，而非 boolean。
- 配额变更必须区分展示可用性和权威的剩余配额；后端响应为准。
- 地域与实名门禁可影响续费入口。变更入口可见性时，同时验证 `isRenewalAvailableForRegion` 和 `isRenewalRealnameVerified` 路径。

## 代码锚点

- `subscription/internal/httpapi/admin.go`
- `subscription/internal/store/mysql.go`
- `subscription/migrations/`
- `payment/api/openapi.yaml`
- `frontend/src/lib/billing-flow.ts`
- `frontend/src/lib/pass-renewal.ts`

## 验证

运行 `cd subscription && go test ./...`。Payment-to-subscription 变更还需要 `cd payment && go test ./...` 和一个回调幂等性用例。前端变更必须保留生成的类型 contract。

## 不得推断

定价、退款、结算和腾讯云计费规则属于外部 authority。本 Pack 只记录本地权益消费。
