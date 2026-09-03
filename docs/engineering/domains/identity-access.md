# 身份与访问领域

本领域覆盖登录、会话、OIDC/OAuth、实名、影子账号和网关授权。核心 Owner 是 `user/auth`；`shadow` 负责腾讯云影子身份流程；`service-gateway` 消费身份状态执行公共路由门禁。

## 服务与责任

| 服务 | 责任 |
|---|---|
| `user/auth` | 登录、会话、实名与身份 API 真源 |
| `shadow` | 影子账号注册、临时凭据与平台回调编排 |
| `service-gateway` | 在公共入口消费身份/实名状态 |
| `frontend` / `admin-gateway` | 表达登录状态和引导，不独占授权逻辑 |

## 稳定不变量

- 会话、实名和权限结果来自服务 API/权威存储，不从 UI 状态或用户名推断。
- 一次性 `auth_code`、临时凭据和回调 token 必须保持最小暴露与明确过期语义。
- 公共行为至少验证网关路径；直连 `user/auth` 只证明内部 API。
- 外部 IdP、腾讯云账号/CAM/STS 的实时契约通过登记来源校验，不把凭据或完整响应复制进文档。

## 机器契约与验证

API 真源是 `user/auth/api/openapi.yaml`，Shadow 的实现/架构在 `shadow/internal/` 和 `shadow/ARCHITECTURE.md`。身份变更至少覆盖成功、过期、缺失、越权、回调伪造和跨站点路径。

相关 Journey：[账号到 Agent](../journeys/account-to-agent.md)。Agent 摘要：[identity-access Context](../../context/domains/identity-access.md)。
