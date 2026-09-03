---
id: identity-access
type: domain
scope: 登录、会话、实名核验和路由级授权。
triggers: ["auth", "login", "realname", "session", "authorization"]
owner: mingyuxiao
authority: derived
source_of_truth:
  - docs/engineering/domains/identity-access.md
  - user/auth/api/openapi.yaml
  - user/auth/internal
  - service-gateway/internal/gateway
status: active
reviewed_at: 2026-08-25
review_due: 2026-11-23
revision: 2.0.0
precedence: domain
derived: true
---

# 身份与访问

> 派生摘要：正式领域知识见 `docs/engineering/domains/identity-access.md`；本页只保留影响 Agent 路由和实现决策的最小事实。

## 适用场景

任务变更登录、OIDC、会话结构、实名核验、FaceID 回调处理或网关路由的授权策略时使用。

## 影响决策的事实

- `user/auth` 拥有身份、会话和实名核验 API；公共 contract 是 `user/auth/api/openapi.yaml`。
- `service-gateway` 执行路由策略。具有 `require_realname: true` 的写路由必须在调用上游前拒绝未核验会话。
- 网关拒绝响应 contract 是 `403` 和 `error: realname_required`；不得发明仅前端门禁作为执行边界。
- 实名 key 按环境隔离并由 SSM/SOPS 提供。`REALNAME_ENCRYPTION_KEY` 必须解码为恰好 32 bytes，且不得跨环境复制。
- `realnameVerified` 是会话级决策字段。`realnameLevel`、`realnameAssuranceMode` 和 `realnameSyncStatus` 用于解释状态，但不能替代网关决策。

## 代码锚点

- `user/auth/internal/httpapi/handler_test.go`
- `user/auth/internal/realname/`
- `service-gateway/internal/gateway/server.go`
- `service-gateway/internal/gateway/config.go`
- `frontend/src/domain/types.ts`

## 验证

身份变更运行 `cd user/auth && go test ./...`，路由执行变更运行 `cd service-gateway && go test ./...`。跨服务变更要求两个服务都有测试，不能只有前端状态变更。

## 不得推断

腾讯 FaceID 回调规则、账户边界和 DetectAuth 约束属于外部 authority。变更 provider 流程前查阅已登记的腾讯云来源；本文件只记录 LightVela 的消费 contract。
