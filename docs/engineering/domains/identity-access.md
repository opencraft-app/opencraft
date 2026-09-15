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
- 邀请返利上下文不是访问邀请码或登录凭据。浏览器只能先通过公开接口校验返利码，再由 Auth 写入
  30 分钟 HttpOnly Cookie；OAuth/手机号/密码注册仅在新用户事务中消费它并写 outbox。已有用户登录、
  自行构造 `X-User-Id` 或直接提交任意 owner ID 都不能建立归因。成功或退出后清除上下文。

## 机器契约与验证

### OpenCraft 第一方客户端登录

原生 App 与 Workbench Web 都是现有 OIDC 的第一方 public client，不是登录渠道。客户端使用现有
GET `/oauth2/authorize`，统一 `/auth/federation/authorize` 页面复用 LoginModal
及其地区可用渠道；渠道成功返回该 HTTPS 页面后，经用户确认再由公共 OIDC
POST `/oauth2/authorize` 签发 code。不新增登录页、Google 专属启动入口或 provider 回调分支。

在 `LIGHTCLAW_OIDC_CLIENTS_JSON` 中显式注册：
`{"id":"opencraft-native-v1","display_name":"Vela","redirect_uris":["opencraft://auth/lightvela"]}`。
以及 `opencraft-web-v1` 的两个精确 HTTPS callback：
`https://chat.lightvela.com/auth/lightvela/callback`、
`https://chat.lightvela.ai/auth/lightvela/callback`。保留 site-gateway 原有两个精确 HTTPS callback。只有 native client 的精确
自定义协议地址被允许；通用 Web return_to 不变，不支持通配、查询、fragment 或路径变体。
OIDC 未启用、无 MySQL 或客户端未注册时不降级到其他认证实现。

App 持有随机 state/verifier，使用 S256、nonce、response_type=code、scope=openid profile。
OIDC 服务校验客户端/地址/参数，MySQL 存储授权码及绑定关系并原子消费。第一方客户端 code 为
256-bit base64url，120 秒过期；site-gateway 保留原有 5 秒寿命。回调仅含 code/state 或
error/state。客户端在 TLS POST `/auth/session/exchange` 携 client_id、verifier 与固定 callback
兑换正常 session（契约 `user/auth/api/native-login.openapi.yaml`）；这是受限的第一方会话适配器，
不是第二个发码器。`/auth/native/token` 只作为已发布原生版本的兼容别名。第一方 session
客户端在标准 `/oauth2/token` 被拒绝，不能另取 JWT；其他 OIDC client 不能兑换普通 App
session。消费时重新核验 registry，不把 OIDC JWT 冒充现有 API session_token。

Workbench Web 不消费 OIDC JWT，也不把任意线程地址注册成 callback。浏览器以
sessionStorage 持有 state/verifier、发起路径和地域，授权只回到固定 callback；兑换成功后
再在同源内恢复发起路径。已有 `lightvela.com` / `lightvela.ai` 会话由统一授权页识别并进入
当前账号确认；未登录时才显示完整 LoginModal，因此手机号、微信、QQ 等地区渠道不需要在
Workbench 内重建。不得用父域 Cookie 共享扩大长期凭据的信任域，也不得恢复 `/auth/sign-in`
加任意 `return_to` 的并行交接协议。

SecureStore 待完成事务寿命 10 分钟。进程共享存储串行化写入及 compare/delete，
旧 owner 仅可删除自己创建的记录；过期/伪造 callback 不得阻断已有 session 恢复。
授权页与登录弹窗共用受 visualViewport 约束的可滚动容器，支持小屏、键盘和长账号。
取消返回已经由服务端校验的 callback/state，不绕过移动浏览器的微信渠道限制。

部署需单独授权：启用现有 OIDC 配置和 MySQL code table，增加第一方客户端注册，
确保既有 /oauth2 路由可达，并仅增加 POST /auth/session/exchange 的公开兑换规则。
不要公开整个 /auth，不再增加 GET /auth/native/start。服务端、授权页面及 App
须一起验证；源码测试不等于生产发布或真实 IdP 登录成功。

API 真源是 `user/auth/api/openapi.yaml`，Shadow 的实现/架构在 `shadow/internal/` 和 `shadow/ARCHITECTURE.md`。身份变更至少覆盖成功、过期、缺失、越权、回调伪造和跨站点路径。

相关 Journey：[账号到 Agent](../journeys/account-to-agent.md)。Agent 摘要：[identity-access Context](../../context/domains/identity-access.md)。
