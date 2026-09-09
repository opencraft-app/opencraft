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
- `service-gateway` 必须先完成会话、实名门禁和 Bot 所有权校验，再启动后台 Worker Action；认证完成后的 TAT 执行超时、重试和清理策略属于运行控制，不得改变或绕过身份判定。

## 机器契约与验证

### 原生 App 登录

原生登录的 HTTP 契约在 `user/auth/api/native-login.openapi.yaml`。注册回调固定为
`opencraft://auth/lightvela`，不扩展通用 Web `return_to` 白名单。App 生成随机 state
和 PKCE verifier，只把 S256 challenge 交给认证服务。Google 身份验证仍复用现有流程。
原生回调只携带 code/state（失败时 error/state），不能携带 session_token。
App 校验地址与 state 后，通过 TLS POST `/auth/native/token` 携 verifier 兑换正常会话。

授权码属于认证服务，用现有 MySQL `oidc_authorization_codes` 存储和事务消费能力，
固定独立 client/scope，120 秒过期且只能兑换一次。生产无进程内存降级，未配置共享
存储时返回 503；不改变 OIDC registry、OIDC access token 或 TAT 设备绑定权限。
App 的待完成事务保存在 SecureStore，10 分钟后过期；取消、完成和失败清理 verifier。

发布时需同步网关 `/auth` 路由的 `public_allow`：GET `/auth/native/start`、POST
`/auth/native/token`。这两条公开入口分别由 OAuth state 和 PKCE 授权，不绕过其他
业务 API 的会话门禁。当前源码实现不代表已更新生产网关或认证服务；需另行授权发布。

API 真源是 `user/auth/api/openapi.yaml`，Shadow 的实现/架构在 `shadow/internal/` 和 `shadow/ARCHITECTURE.md`。身份变更至少覆盖成功、过期、缺失、越权、回调伪造和跨站点路径。

相关 Journey：[账号到 Agent](../journeys/account-to-agent.md)。Agent 摘要：[identity-access Context](../../context/domains/identity-access.md)。
