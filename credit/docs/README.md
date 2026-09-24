# Credit 服务说明

Credit 是付费积分包的业务真源。它持有积分商品、live/history package、LLMGateway 订阅快照和
每日用量 outbox；Trade 持有订单、外部计费商品定义、询价下单协议与资源回调适配。

## 权威入口

- `credit/AGENTS.md`：API、数据表、状态机、用量与生命周期不变量。
- `credit/internal/httpapi/` 和 `credit/internal/service/`：用户及内部 API 的运行时行为。
- `credit/internal/lifecycle/` 和 `credit/internal/usage/`：自然到期与每日推量 worker。
- `credit/migrations/`：商品、package、history、usage 和 ID 分配 schema。
- `trade/internal/logic/credit*`：订单、计费回调、用量上报协议。

## 方案文档

- [国内站 Pass 续费接入点石方案](domestic-pass-renewal-dianshi-plan.md)：记录控制台单次续费活动、
  Trade 内部无限次续费入口、点石适配及安全边界。该方案存放在计费域文档中，运行时实现仍
  归属 CTL 和 Trade，Credit 不提供 Pass 续费能力。

## 关键边界

- 积分包是一次性资源包，不提供续费。自然到期由 Credit 删除精确 LLMGateway 订阅并直接归档；
  计费退款后的 `isolateResource` 使用相同的同步销毁语义。
- 积分使用 `DECIMAL(24,4)` 和 Go 定点值计算。每日推量以 `next_retry_time` 调度并用 CAS lease
  防并发，普通零用量也上报，已到期或已归档资源不再推量。
- Credit 不拼外部计费协议。询价、订单、`checkCreate`、资源查询、`getUsedAmount` 和
  `sendResource` 均由 Trade 适配，跨服务调用必须保持幂等。
- `sandbox-bj-7` 用于回归验证；`beijing-sandbox` 已接线独立 Secret、DB、worker、Trade、
  Service Gateway 和 Credit 专用计费回调，并随 `master` 自动构建/auto-pin。上海和新加坡使用
  各自地域的 LLMGateway 管理面、internal token 和 plan；商品及 active package 的 plan/订阅
  必须与用户模型流量位于同一地域，不能复用北京共享控制面的 plan ID。

## 验证

在 `credit/` 运行 `go test ./...` 和 `go vet ./...`。涉及 Trade 时同时运行 Trade 全量 test/vet、
Credit 回调与 flow 幂等测试。交付变更还要运行 CI runtime contract、Credit/Trade/Service Gateway
Kustomize render、YAML/SOPS 扫描和 docs-impact。真实环境需分别验证购买、重复购买、查询、每日
零/非零用量、退款隔离、自然到期，以及 package、history、usage 与 LLMGateway 订阅的联合终态。
