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

原生 App 是现有 OIDC 的第一方 public client，不是登录渠道。App 使用现有
GET `/oauth2/authorize`，统一 `/auth/federation/authorize` 页面复用 LoginModal
及其地区可用渠道；渠道成功返回该 HTTPS 页面后，经用户确认再由公共 OIDC
POST `/oauth2/authorize` 签发 code。不新增登录页、Google 专属启动入口或 provider 回调分支。

在 `LIGHTCLAW_OIDC_CLIENTS_JSON` 中显式注册：
`{"id":"opencraft-native-v1","display_name":"Vela","redirect_uris":["opencraft://auth/lightvela"]}`。
保留 site-gateway 原有两个精确 HTTPS callback。只有该 native client 的这个精确
自定义协议地址被允许；通用 Web return_to 不变，不支持通配、查询、fragment 或路径变体。
OIDC 未启用、无 MySQL 或客户端未注册时不降级到其他认证实现。

App 持有随机 state/verifier，使用 S256、nonce、response_type=code、scope=openid profile。
OIDC 服务校验客户端/地址/参数，MySQL 存储授权码及绑定关系并原子消费。原生 code 为
256-bit base64url，120 秒过期；site-gateway 保留原有 5 秒寿命。
原生回调仅 code/state 或 error/state。App 在 TLS POST `/auth/native/token` 携 verifier
兑换正常 session（契约 `user/auth/api/native-login.openapi.yaml`）；这是受限的第一方
会话适配器，不是第二个发码器。它固定 native client 并使用同一 OIDC Provider 消费。
该客户端在标准 `/oauth2/token` 被拒绝，不能另取 JWT；其他 OIDC client 不能兑换普通
App session。消费时重新核验 registry，不把 OIDC JWT 冒充现有 API session_token。

Workbench Web 不注册为 native OIDC client，也不消费 OIDC JWT。它可以把 provider
选择委托给现有 `/auth/sign-in` 页面；该页面复用 OIDC 授权页同一个 LoginModal，并只向
OAuth start 转发精确的第一方 Workbench origin。渠道回调仍由 UserAuth 的 Web
`return_to` 白名单最终校验并交付普通 Web session。跨 origin handoff 只展示能由 OAuth
回调交付凭据的渠道，不展示无法单独完成跨站交接的手机号或游客入口。这样复用同一套
地区登录渠道与界面，同时不混淆 Web session 和 native code。

SecureStore 待完成事务寿命 10 分钟。进程共享存储串行化写入及 compare/delete，
旧 owner 仅可删除自己创建的记录；过期/伪造 callback 不得阻断已有 session 恢复。
授权页与登录弹窗共用受 visualViewport 约束的可滚动容器，支持小屏、键盘和长账号。
取消返回已经由服务端校验的 callback/state，不绕过移动浏览器的微信渠道限制。

部署需单独授权：启用现有 OIDC 配置和 MySQL code table，增加 native client 注册，
确保既有 /oauth2 路由可达，并仅增加 POST /auth/native/token 的公开兑换规则。
不要公开整个 /auth，不再增加 GET /auth/native/start。服务端、授权页面及 App
须一起验证；源码测试不等于生产发布或真实 IdP 登录成功。

API 真源是 `user/auth/api/openapi.yaml`，Shadow 的实现/架构在 `shadow/internal/` 和 `shadow/ARCHITECTURE.md`。身份变更至少覆盖成功、过期、缺失、越权、回调伪造和跨站点路径。

相关 Journey：[账号到 Agent](../journeys/account-to-agent.md)。Agent 摘要：[identity-access Context](../../context/domains/identity-access.md)。
